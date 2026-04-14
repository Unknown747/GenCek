const fs = require('fs')
const https = require('https')
const http = require('http')
const ethers = require('ethers')
require('colors')

// ─── Config ───────────────────────────────────────────────────────────
const RPC_URLS = [
    'http://202.61.239.89:8545',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
    'https://ethereum.publicnode.com',
    'https://eth.drpc.org',
    'https://1rpc.io/eth',
]
const HITS_FILE = 'hits.txt'
const FUNDED_FILE = 'funded.txt'
const CHECKER_STATS_FILE = 'checker_stats.json'
const REQUEST_TIMEOUT_MS = 8000
const FLUSH_EVERY = 1000
const BENCHMARK_INTERVAL_MS = 30000

const args = process.argv.slice(2)
const concurrencyArg = args.indexOf('-c')
const BATCH_SIZE = concurrencyArg !== -1 ? parseInt(args[concurrencyArg + 1]) || 200 : 200

// ─── Telegram ─────────────────────────────────────────────────────────
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

// ─── Stats ────────────────────────────────────────────────────────────
function loadStats() {
    try { return JSON.parse(fs.readFileSync(CHECKER_STATS_FILE, 'utf8')) }
    catch (e) { return { total_checked_all_time: 0, total_funded_all_time: 0 } }
}
function saveStats(data) {
    fs.writeFileSync(CHECKER_STATS_FILE, JSON.stringify(data, null, 2))
}

// ─── Dynamic RPC Pool ─────────────────────────────────────────────────
const rpcStats = RPC_URLS.map(url => ({
    url,
    latency: 9999,   // ms, lower = better
    errors: 0,
    successes: 0,
    alive: true,
}))

// Score: lower is better. Dead RPCs get 99999.
function rpcScore(stat) {
    if (!stat.alive) return 99999
    return stat.latency + stat.errors * 500
}

// Returns sorted list of alive RPCs (fastest first)
function getSortedRpcs() {
    return [...rpcStats].sort((a, b) => rpcScore(a) - rpcScore(b))
}

// Ping one RPC with eth_blockNumber and measure latency
async function pingRpc(stat) {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 })
    const t = Date.now()
    try {
        const res = await rawRequest(stat.url, body, 5000)
        const parsed = JSON.parse(res)
        if (parsed.result) {
            stat.latency = Date.now() - t
            stat.alive = true
        } else {
            stat.latency = 9999
            stat.alive = false
        }
    } catch (e) {
        stat.latency = 9999
        stat.alive = false
    }
}

// Benchmark all RPCs in parallel, then print ranking
async function benchmarkAllRpcs(silent = false) {
    await Promise.all(rpcStats.map(s => pingRpc(s)))
    const sorted = getSortedRpcs()
    if (!silent) {
        console.log('\n  RPC Ranking (fastest → slowest):'.cyan)
        sorted.forEach((s, i) => {
            const label = s.alive
                ? `${s.latency}ms`.green
                : 'dead'.red
            const short = s.url.replace(/^https?:\/\//, '').slice(0, 35)
            console.log(`    ${i + 1}. ${short.padEnd(36)} ${label}`)
        })
        console.log('')
    }
}

// Re-benchmark every 30s silently, keep rankings fresh
setInterval(() => benchmarkAllRpcs(true), BENCHMARK_INTERVAL_MS)

// ─── Raw HTTP request ─────────────────────────────────────────────────
function rawRequest(url, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url)
        const isHttps = parsedUrl.protocol === 'https:'
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Accept': 'application/json',
            },
            timeout: timeoutMs,
        }
        const transport = isHttps ? https : http
        const req = transport.request(options, (res) => {
            let data = ''
            res.on('data', chunk => { data += chunk })
            res.on('end', () => resolve(data))
        })
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}

// ─── JSON-RPC batch request ───────────────────────────────────────────
async function jsonRpcBatch(stat, requests) {
    const body = JSON.stringify(requests)
    const t = Date.now()
    try {
        const raw = await rawRequest(stat.url, body)
        const parsed = JSON.parse(raw)
        // Update latency with exponential moving average
        stat.latency = Math.round(stat.latency * 0.7 + (Date.now() - t) * 0.3)
        stat.successes++
        stat.alive = true
        return parsed
    } catch (e) {
        stat.errors++
        // After 3 consecutive errors, mark dead temporarily
        if (stat.errors > 3) stat.alive = false
        throw e
    }
}

// ─── Batch balance check ──────────────────────────────────────────────
let rpcRoundIdx = 0

async function batchGetBalances(entries) {
    const requests = entries.map((entry, i) => ({
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: [entry.address, 'latest'],
        id: i,
    }))

    // Pick fastest alive RPC (round-robin among top alive ones)
    const sorted = getSortedRpcs().filter(s => s.alive)
    if (sorted.length === 0) return new Map()

    const stat = sorted[rpcRoundIdx % sorted.length]
    rpcRoundIdx++

    let responses
    try {
        responses = await jsonRpcBatch(stat, requests)
    } catch (e) {
        // Fallback to next best alive RPC
        const fallback = sorted.find(s => s !== stat && s.alive)
        if (!fallback) return new Map()
        try {
            responses = await jsonRpcBatch(fallback, requests)
        } catch (e2) {
            return new Map()
        }
    }

    const resultMap = new Map()
    if (!Array.isArray(responses)) return resultMap
    for (const res of responses) {
        const entry = entries[res.id]
        if (!entry) continue
        if (res.result) {
            resultMap.set(entry.address, BigInt(res.result))
        } else {
            resultMap.set(entry.address, null)
        }
    }
    return resultMap
}

// ─── File helpers ─────────────────────────────────────────────────────
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
    const ethStr = ethers.utils.formatEther(balance.toString())
    const line = `${entry.address},${entry.key},${ethStr} ETH\n`
    fs.appendFileSync(FUNDED_FILE, line)

    const msg =
        `🚨 <b>FUNDED WALLET FOUND</b>\n` +
        `Address: <code>${entry.address}</code>\n` +
        `Key: <code>${entry.key}</code>\n` +
        `ETH: ${ethStr}`

    sendTelegram(msg)

    console.log('\n' + '='.repeat(62).green)
    console.log('  *** FUNDED WALLET ***'.bgGreen.black)
    console.log(`  Address : ${entry.address}`.green)
    console.log(`  Key     : ${entry.key}`.green)
    console.log(`  ETH     : ${ethStr}`.green)
    console.log('='.repeat(62).green + '\n')
}

// ─── Main ─────────────────────────────────────────────────────────────
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

    // Initial benchmark to rank RPCs before starting
    process.stdout.write('  Benchmarking RPCs...\n')
    await benchmarkAllRpcs(false)

    while (true) {
        const entries = readAllEntries()

        if (entries.length === 0) {
            process.stdout.write(`\r  [~] Waiting for wallets... | Funded: ${getFundedCount()}   `)
            await new Promise(r => setTimeout(r, 2000))
            continue
        }

        const batches = []
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            batches.push(entries.slice(i, i + BATCH_SIZE))
        }

        const aliveCount = rpcStats.filter(s => s.alive).length
        console.log(`\n  Checking ${entries.length.toLocaleString()} wallets | ${batches.length} batches | ${aliveCount}/${RPC_URLS.length} RPCs alive`.cyan)

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
                const fastest = getSortedRpcs()[0]
                const fastestLabel = fastest.url.replace(/^https?:\/\//, '').slice(0, 20)

                process.stdout.write(
                    `\r  Checked: ${sessionChecked.toLocaleString()} | Remaining: ${(entries.length - sessionChecked).toLocaleString()} | Rate: ${rate.toLocaleString()}/s | Best RPC: ${fastestLabel} (${fastest.latency}ms) | Funded: ${funded > 0 ? String(funded).bgGreen.black : '0'}   `
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
