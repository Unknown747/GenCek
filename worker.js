const fs = require('fs')
const https = require('https')
const http = require('http')
const { randomBytes } = require('crypto')
const { secp256k1 } = require('ethereum-cryptography/secp256k1')
const { keccak256 } = require('ethereum-cryptography/keccak')

const BATCH_SIZE = 200
const FUNDED_FILE = 'funded.txt'
const REQUEST_TIMEOUT_MS = 8000

const RPC_URLS = [
    'http://202.61.239.89:8545',
    'https://eth.drpc.org',
    'https://1rpc.io/eth',
    'https://ethereum.publicnode.com',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
]

// ─── RPC pool with latency tracking ──────────────────────────────────
const rpcPool = RPC_URLS.map(url => ({ url, latency: 999, errors: 0, alive: true }))

function getBestRpc() {
    const alive = rpcPool.filter(r => r.alive)
    if (alive.length === 0) { rpcPool.forEach(r => { r.alive = true; r.errors = 0 }); return rpcPool[0] }
    return alive.reduce((a, b) => (a.latency + a.errors * 300 < b.latency + b.errors * 300 ? a : b))
}

// ─── Raw HTTP ─────────────────────────────────────────────────────────
function rawRequest(url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url)
        const isHttps = u.protocol === 'https:'
        const opts = {
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: u.pathname + u.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: REQUEST_TIMEOUT_MS,
        }
        const req = (isHttps ? https : http).request(opts, res => {
            let data = ''
            res.on('data', c => { data += c })
            res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
        })
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}
        jsonrpc: '2.0', method: 'eth_getBalance',
        params: [w.address, 'latest'], id: i,
    }))
    const body = JSON.stringify(requests)

    // Try best RPC first, fallback to next best on error
    const sorted = [...rpcPool].filter(r => r.alive).sort((a, b) =>
        (a.latency + a.errors * 300) - (b.latency + b.errors * 300)
    )

    for (const rpc of sorted) {
        const t = Date.now()
        try {
            const responses = await rawRequest(rpc.url, body)
            const elapsed = Date.now() - t
            rpc.latency = Math.round(rpc.latency * 0.7 + elapsed * 0.3)
            rpc.errors = Math.max(0, rpc.errors - 1)
            rpc.alive = true

            if (!Array.isArray(responses)) continue

            const funded = []
            for (const res of responses) {
                if (res.result && BigInt(res.result) > 0n) {
                    funded.push({ wallet: wallets[res.id], balance: BigInt(res.result) })
                }
            }
            return { checked: wallets.length, funded }
        } catch (e) {
            rpc.errors++
            if (rpc.errors >= 4) rpc.alive = false
        }
    }
    return { checked: wallets.length, funded: [] }
}

// ─── Telegram ─────────────────────────────────────────────────────────
function sendTelegram(address, privateKey, ethStr) {
    const token = process.env.TELEGRAM_BOT_TOKEN
    const chat = process.env.TELEGRAM_CHAT_ID
    if (!token || !chat) return
    const msg = `🚨 <b>FUNDED WALLET</b>\nAddress: <code>${address}</code>\nKey: <code>${privateKey}</code>\nETH: ${ethStr}`
    const body = JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML' })
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    })
    req.on('error', () => {})
    req.write(body)
    req.end()
}
}

// ─── Main loop ────────────────────────────────────────────────────────
async function run() {
    while (true) {
        const wallets = Array.from({ length: BATCH_SIZE }, generateWallet)
        const { checked, funded } = await batchCheckBalances(wallets)
        for (const { wallet, balance } of funded) saveFunded(wallet, balance)
        process.send({ type: 'stats', checked, funded: funded.length })
    }
}

run().catch(e => {
    process.send({ type: 'error', msg: e.message })
    process.exit(1)
})
