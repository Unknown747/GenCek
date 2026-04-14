const fs = require('fs')
const https = require('https')
const { randomBytes } = require('crypto')
const { secp256k1 } = require('ethereum-cryptography/secp256k1')
const { keccak256 } = require('ethereum-cryptography/keccak')
const { rawRequest, getSortedPool, getPoolStats, markSuccess, markError } = require('./rpc-manager')

// ─── Config ────────────────────────────────────────────────────────────

const BASE_BATCH_SIZE = Math.max(1, parseInt(process.env.WORKER_BATCH_SIZE) || 200)
const FUNDED_FILE     = 'funded.txt'

// ─── Dynamic batch size ────────────────────────────────────────────────
// Adjust per RPC latency: faster RPC → bigger batch → more throughput

function getDynamicBatchSize() {
    const pool = getSortedPool()
    if (pool.length === 0) return BASE_BATCH_SIZE
    const best = pool[0].latency
    if (best < 200) return Math.max(BASE_BATCH_SIZE, 600)
    if (best < 350) return Math.max(BASE_BATCH_SIZE, 400)
    if (best < 600) return Math.max(BASE_BATCH_SIZE, 300)
    return BASE_BATCH_SIZE
}

// ─── Ethereum address validation ───────────────────────────────────────

function isValidEthAddress(addr) {
    return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)
}

// ─── Wallet generation ─────────────────────────────────────────────────

function generateWallet() {
    const privBytes = randomBytes(32)
    const pubKey    = secp256k1.getPublicKey(privBytes, false).slice(1)
    const hash      = keccak256(pubKey)
    return {
        address:    '0x' + Buffer.from(hash.slice(12)).toString('hex'),
        privateKey: '0x' + Buffer.from(privBytes).toString('hex'),
    }
}

// ─── Balance check ─────────────────────────────────────────────────────

async function batchCheckBalances(wallets) {
    const requests = wallets.map((w, i) => ({
        jsonrpc: '2.0', method: 'eth_getBalance',
        params: [w.address, 'latest'], id: i,
    }))
    const body = JSON.stringify(requests)

    const sorted = getSortedPool()
    if (sorted.length === 0) {
        // No alive RPC — brief pause before next batch
        await new Promise(r => setTimeout(r, 2000))
        return { checked: wallets.length, funded: [] }
    }

    for (const rpc of sorted) {
        const t = Date.now()
        try {
            const raw       = await rawRequest(rpc.url, body)
            const responses = JSON.parse(raw)
            markSuccess(rpc, Date.now() - t)

            if (!Array.isArray(responses)) continue

            const funded = []
            for (const res of responses) {
                if (res.result && BigInt(res.result) > 0n) {
                    funded.push({ wallet: wallets[res.id], balance: BigInt(res.result) })
                }
            }
            return { checked: wallets.length, funded }
        } catch (e) {
            markError(rpc)
        }
    }
    return { checked: wallets.length, funded: [] }
}

// ─── Telegram ─────────────────────────────────────────────────────────

function sendTelegram(address, privateKey, ethStr) {
    const token = process.env.TELEGRAM_BOT_TOKEN
    const chat  = process.env.TELEGRAM_CHAT_ID
    if (!token || !chat) return
    const msg  = `🚨 <b>FUNDED WALLET</b>\nAddress: <code>${address}</code>\nKey: <code>${privateKey}</code>\nETH: ${ethStr}`
    const body = JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML' })
    const req  = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    })
    req.on('error', () => {})
    req.write(body)
    req.end()
}

// ─── Save funded wallet ────────────────────────────────────────────────

function saveFunded(wallet, balanceWei) {
    if (!isValidEthAddress(wallet.address)) {
        process.send({ type: 'error', msg: `Skipped invalid address: ${wallet.address}` })
        return
    }
    const eth    = Number(balanceWei) / 1e18
    const ethStr = eth.toFixed(6)
    fs.appendFileSync(FUNDED_FILE, `${wallet.address},${wallet.privateKey},${ethStr} ETH\n`)
    sendTelegram(wallet.address, wallet.privateKey, ethStr)
    process.send({ type: 'funded', address: wallet.address, eth: ethStr })
}

// ─── Report RPC pool health every 60s ─────────────────────────────────

setInterval(() => {
    try {
        const stats = getPoolStats()
        process.send({ type: 'rpc_stats', ...stats })
    } catch (_) {}
}, 60000)

// ─── Main loop ─────────────────────────────────────────────────────────

async function run() {
    while (true) {
        const batchSize = getDynamicBatchSize()
        const wallets   = Array.from({ length: batchSize }, generateWallet)
        const { checked, funded } = await batchCheckBalances(wallets)
        for (const { wallet, balance } of funded) saveFunded(wallet, balance)
        process.send({ type: 'stats', checked, funded: funded.length })
    }
}

run().catch(e => {
    process.send({ type: 'error', msg: e.message })
    process.exit(1)
})
