const fs = require('fs')
const https = require('https')
const ethers = require('ethers')
require('colors')
const { rpcPool, rawRequest, getSortedPool, markSuccess, markError, benchmarkPool, discoverNewRpcs } = require('./rpc-manager')

const HITS_FILE = 'hits.txt'
const FUNDED_FILE = 'funded.txt'
const CHECKER_STATS_FILE = 'checker_stats.json'
const FLUSH_EVERY = 1000
const BENCHMARK_INTERVAL_MS = 30000

const args = process.argv.slice(2)
const concurrencyArg = args.indexOf('-c')
const BATCH_SIZE = concurrencyArg !== -1 ? parseInt(args[concurrencyArg + 1]) || 200 : 200

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || ''

function sendTelegram(message) {
    if (!TG_TOKEN || !TG_CHAT) return
    const body = JSON.stringify({ chat_id: TG_CHAT, text: message, parse_mode: 'HTML' })
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    })
    req.on('error', () => {})
    req.write(body)
    req.end()
}

function loadStats() {
    try { return JSON.parse(fs.readFileSync(CHECKER_STATS_FILE, 'utf8')) }
    catch (e) { return { total_checked_all_time: 0, total_funded_all_time: 0 } }
}
function saveStats(data) {
    fs.writeFileSync(CHECKER_STATS_FILE, JSON.stringify(data, null, 2))
}

let rpcRoundIdx = 0

async function batchGetBalances(entries) {
    const requests = entries.map((entry, i) => ({
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: [entry.address, 'latest'],
        id: i,
    }))
    const body = JSON.stringify(requests)
    const sorted = getSortedPool()
    if (sorted.length === 0) return new Map()

    const rpc = sorted[rpcRoundIdx % sorted.length]
    rpcRoundIdx++

    async function tryRpc(r) {
        const t = Date.now()
        const raw = await rawRequest(r.url, body)
        const responses = JSON.parse(raw)
        markSuccess(r, Date.now() - t)
        return responses
    }

    let responses
    try {
        responses = await tryRpc(rpc)
    } catch (e) {
        markError(rpc)
        const fallback = sorted.find(s => s !== rpc && s.alive)
        if (!fallback) return new Map()
        try {
            responses = await tryRpc(fallback)
        } catch (e2) {
            markError(fallback)
            return new Map()
        }
    }

    const resultMap = new Map()
    if (!Array.isArray(responses)) return resultMap
    for (const res of responses) {
        const entry = entries[res.id]
        if (!entry) continue
        resultMap.set(entry.address, res.result ? BigInt(res.result) : null)
    }
    return resultMap
}

function readAllEntries() {
    if (!fs.existsSync(HITS_FILE)) return []
    const seen = new Set()
    return fs.readFileSync(HITS_FILE, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .map(l => {
            const p = l.split(',')
            return { address: p[0], key: p[1], raw: l }
        })
        .filter(e => e.address && e.key && !seen.has(e.address) && seen.add(e.address))
}

function flushProcessed(checkedSet) {
    if (!fs.existsSync(HITS_FILE)) return
    const remaining = fs.readFileSync(HITS_FILE, 'utf8')
        .split('\n')
        .filter(l => !checkedSet.has(l.trim()))
    fs.writeFileSync(HITS_FILE, remaining.join('\n'))
}

function getFundedCount() {
    try { return fs.readFileSync(FUNDED_FILE, 'utf8').split('\n').filter(l => l.trim()).length }
    catch (e) { return 0 }
}

function saveFunded(entry, balance) {
    const ethStr = ethers.formatEther(balance)
    fs.appendFileSync(FUNDED_FILE, `${entry.address},${entry.key},${ethStr} ETH\n`)
    sendTelegram(
        `🚨 <b>FUNDED WALLET FOUND</b>\n` +
        `Address: <code>${entry.address}</code>\n` +
        `Key: <code>${entry.key}</code>\n` +
        `ETH: ${ethStr}`
    )
    console.log('\n' + '='.repeat(62).green)
    console.log('  *** FUNDED WALLET ***'.bgGreen.black)
    console.log(`  Address : ${entry.address}`.green)
    console.log(`  Key     : ${entry.key}`.green)
    console.log(`  ETH     : ${ethStr}`.green)
    console.log('='.repeat(62).green + '\n')
}

setInterval(async () => {
    try { await benchmarkPool(true) } catch (_) {}
}, BENCHMARK_INTERVAL_MS)

async function main() {
    const persisted = loadStats()
    let sessionChecked = 0
    const startTime = Date.now()
    const checkedRaws = new Set()

    const tgStatus = TG_TOKEN && TG_CHAT ? 'enabled'.green : 'disabled'.gray

    console.log('\nEthereum Balance Checker (Smart RPC Mode)'.cyan.bold)
    console.log('=========================================='.cyan)
    console.log(`Batch size  : ${BATCH_SIZE} addresses per request`)
    console.log(`Re-rank     : every ${BENCHMARK_INTERVAL_MS / 1000}s automatically`)
    console.log(`Telegram    : ${tgStatus}`)
    console.log(`\nTip: node check-balances.js -c 500  (batch size)\n`.gray)

    process.stdout.write('  Benchmarking RPCs...\n')
    await benchmarkPool(false)

    console.log('  Discovering new public RPCs...')
    const added = await discoverNewRpcs(false)
    if (added === 0) console.log('  No new RPCs found.\n')

    while (true) {
        const entries = readAllEntries()

        if (entries.length === 0) {
            console.log(`  [~] Waiting for entries in hits.txt... | Funded: ${getFundedCount()}`)
            await new Promise(r => setTimeout(r, 5000))
            continue
        }

        const batches = []
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            batches.push(entries.slice(i, i + BATCH_SIZE))
        }

        const aliveCount = rpcPool.filter(r => r.alive).length
        console.log(`\n  Checking ${entries.length.toLocaleString()} wallets | ${batches.length} batches | ${aliveCount}/${rpcPool.length} RPCs alive`.cyan)

        if (aliveCount === 0) {
            console.log('  [!] No alive RPCs — waiting 10s before retry...'.yellow)
            await new Promise(r => setTimeout(r, 10000))
            continue
        }

        const MAX_PARALLEL = Math.min(aliveCount * 2, 12, batches.length)
        let batchIdx = 0

        async function processNextBatch() {
            while (batchIdx < batches.length) {
                const batch = batches[batchIdx++]
                const balances = await batchGetBalances(batch)

                for (const entry of batch) {
                    const bal = balances.get(entry.address)
                    if (bal !== undefined && bal !== null && bal > 0n) {
                        saveFunded(entry, bal)
                    }
                    checkedRaws.add(entry.raw)
                    sessionChecked++
                }

                if (checkedRaws.size % FLUSH_EVERY < BATCH_SIZE) {
                    flushProcessed(checkedRaws)
                }

                const elapsed = Math.floor((Date.now() - startTime) / 1000)
                const rate = elapsed > 0 ? Math.floor(sessionChecked / elapsed) : 0
                const funded = getFundedCount()
                const best = getSortedPool()[0]
                const bestLabel = best ? best.url.replace(/^https?:\/\//, '').slice(0, 20) : 'none'
                const bestMs = best ? best.latency + 'ms' : '-'

                process.stdout.write(
                    `\r  Checked: ${sessionChecked.toLocaleString()} | Remaining: ${(entries.length - sessionChecked).toLocaleString()} | Rate: ${rate.toLocaleString()}/s | Best RPC: ${bestLabel} (${bestMs}) | Funded: ${funded > 0 ? String(funded).bgGreen.black : '0'}   `
                )
            }
        }

        const workers = Array.from({ length: MAX_PARALLEL }, processNextBatch)
        await Promise.all(workers)

        flushProcessed(checkedRaws)

        saveStats({
            total_checked_all_time: persisted.total_checked_all_time + sessionChecked,
            total_funded_all_time: getFundedCount(),
            session_checked: sessionChecked,
            last_updated: new Date().toISOString()
        })
    }
}

main().catch(err => {
    console.error('\n[FATAL]'.red, err.message)
    process.exit(1)
})
