const { fork } = require('child_process')
const { program } = require('commander')
const colors = require('colors')
const fs = require('fs')
const https = require('https')

const STATS_FILE  = 'checker_stats.json'
const LOG_FILE    = 'session.log'
const REPORT_FILE = 'session_report.json'

// ─── CLI options ───────────────────────────────────────────────────────

program
    .option('-c, --count <number>',       'initial worker count',                     '2')
    .option('-b, --batch <number>',       'addresses per batch per worker',            '200')
    .option('--max-workers <number>',     'max workers for auto-scale (default: count*2)')
    .option('--min-rate <number>',        'min addr/s per worker before scaling up',  '400')
    .option('--max-rate <number>',        'addr/s per worker before scaling down',    '900')

const options   = program.parse().opts()
const baseCount = Math.max(1, parseInt(options.count)      || 2)
const batchSize = Math.max(1, parseInt(options.batch)      || 200)
const maxWorkers = parseInt(options.maxWorkers)            || baseCount * 2
const minRate   = parseInt(options.minRate)                || 400
const maxRate   = parseInt(options.maxRate)                || 900

// ─── State ─────────────────────────────────────────────────────────────

let sessionChecked   = 0
let currentAvgRate   = 0
let currentInstRate  = 0
let peakRate         = 0
let peakWorkers      = baseCount
const startTime      = Date.now()
const startedAt      = new Date().toISOString()

const workers            = []      // all spawned worker processes
const workerIsExtra      = {}      // idx -> true if auto-scaled (not base)
const workerShuttingDown = new Set()
const lastHeartbeat      = {}
const workerRpcStats     = {}
let   isShuttingDown     = false   // set to true during graceful shutdown

// ─── All-time stats ────────────────────────────────────────────────────

function loadStats() {
    try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) }
    catch (_) { return { total_checked_all_time: 0, sessions: 0 } }
}

const _allTimeStats = loadStats()
const allTimeBase   = _allTimeStats.total_checked_all_time || 0

function saveStats(isFinal = false) {
    try {
        const prev = loadStats()
        fs.writeFileSync(STATS_FILE, JSON.stringify({
            total_checked_all_time: allTimeBase + sessionChecked,
            sessions: isFinal ? (prev.sessions || 0) + 1 : (prev.sessions || 0),
            last_session_checked: sessionChecked,
            last_updated: new Date().toISOString(),
        }, null, 2))
    } catch (_) {}
}

// ─── Session report ────────────────────────────────────────────────────

function saveSessionReport() {
    try {
        const elapsed = Math.floor((Date.now() - startTime) / 1000)
        const rpc = getRpcSummary()
        fs.writeFileSync(REPORT_FILE, JSON.stringify({
            started:              startedAt,
            ended:                new Date().toISOString(),
            duration_seconds:     elapsed,
            session_checked:      sessionChecked,
            all_time_total:       allTimeBase + sessionChecked,
            avg_rate:             currentAvgRate,
            peak_rate:            peakRate,
            workers_base:         baseCount,
            workers_peak:         peakWorkers,
            batch_size:           batchSize,
            funded_this_session:  getFundedCount(),
            rpc_alive:            rpc ? rpc.alive  : 0,
            rpc_dead:             rpc ? rpc.dead   : 0,
        }, null, 2))
    } catch (_) {}
}

// ─── Telegram ─────────────────────────────────────────────────────────

function sendTelegram(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN
    const chat  = process.env.TELEGRAM_CHAT_ID
    if (!token || !chat) return
    const body = JSON.stringify({ chat_id: chat, text: message, parse_mode: 'HTML' })
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

// ─── Logging ───────────────────────────────────────────────────────────

function writeLog(line) {
    try {
        const clean = line.replace(/\x1B\[[0-9;]*m/g, '')
        fs.appendFileSync(LOG_FILE, clean + '\n')
    } catch (_) {}
}

function log(line) {
    console.log(line)
    writeLog(line)
}

// ─── Helpers ───────────────────────────────────────────────────────────

function formatUptime(ms) {
    const s  = Math.floor(ms / 1000)
    const hh = String(Math.floor(s / 3600)).padStart(2, '0')
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
    const ss = String(s % 60).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
}

function getFundedCount() {
    try { return fs.readFileSync('funded.txt', 'utf8').split('\n').filter(l => l.trim()).length }
    catch (_) { return 0 }
}

function getRpcSummary() {
    const reports = Object.values(workerRpcStats)
    if (reports.length === 0) return null
    return {
        alive: Math.max(...reports.map(r => r.alive || 0)),
        dead:  Math.max(...reports.map(r => r.dead  || 0)),
    }
}

function activeWorkerCount() {
    return workers.filter(Boolean).length
}

// ─── Worker management ─────────────────────────────────────────────────

function spawnWorker(idx) {
    const child = fork('worker.js', [], {
        detached: false,
        env: { ...process.env, WORKER_BATCH_SIZE: String(batchSize) }
    })

    lastHeartbeat[idx] = Date.now()

    child.on('message', msg => {
        lastHeartbeat[idx] = Date.now()

        if (msg.type === 'stats') {
            sessionChecked += msg.checked

        } else if (msg.type === 'funded') {
            const alert = [
                '',
                '='.repeat(60).green,
                '  *** FUNDED WALLET FOUND ***'.bgGreen.black,
                `  Address : ${msg.address}`.green,
                `  ETH     : ${msg.eth}`.green,
                '='.repeat(60).green,
            ].join('\n')
            log(alert)
            sendTelegram(
                `🚨 <b>FUNDED WALLET FOUND!</b>\n` +
                `Address: <code>${msg.address}</code>\nETH: ${msg.eth}`
            )

        } else if (msg.type === 'rpc_stats') {
            workerRpcStats[idx] = msg

        } else if (msg.type === 'error') {
            log(`[Worker ${idx + 1} error] ${msg.msg}`.red)
        }
    })

    child.on('exit', code => {
        if (isShuttingDown) return
        if (workerShuttingDown.has(idx)) {
            workerShuttingDown.delete(idx)
            workers[idx] = null
            return
        }
        log(`[!] Worker ${idx + 1} exited (code ${code}), restarting...`.yellow)
        workers[idx] = spawnWorker(idx)
    })

    child.stderr && child.stderr.on('data', d => {
        const line = d.toString().trim()
        if (line) log(`[Worker ${idx + 1}] ${line}`.gray)
    })

    return child
}

// ─── Startup ───────────────────────────────────────────────────────────

const tgStatus = (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
    ? 'enabled'.green : 'disabled'.gray

log('')
log('╔══════════════════════════════════════════════╗'.cyan)
log('║   Ethereum Key Generator + Balance Checker  ║'.cyan.bold)
log('╚══════════════════════════════════════════════╝'.cyan)
log(`  Workers     : ${baseCount} base | max ${maxWorkers} (auto-scale)`)
log(`  Batch size  : ${batchSize} addresses/batch`)
log(`  Auto-scale  : scale up < ${minRate}/s per worker | scale down > ${maxRate}/s per worker`)
log(`  Telegram    : ${tgStatus}`)
log(`  Started     : ${startedAt}`)
log(`  All-time    : ${allTimeBase.toLocaleString()} addresses in ${_allTimeStats.sessions || 0} session(s)`)
log(`  Log file    : ${LOG_FILE}`)
log('')

for (let i = 0; i < baseCount; i++) {
    workers[i] = spawnWorker(i)
    log(`  [✓] Worker ${i + 1} started`.green)
}
log('')

sendTelegram(
    `🟢 <b>Checker Started</b>\n` +
    `Workers: ${baseCount} | Batch: ${batchSize} | Max: ${maxWorkers}\n` +
    `All-time: ${allTimeBase.toLocaleString()} checked`
)

// ─── Graceful shutdown ─────────────────────────────────────────────────

function shutdown(signal) {
    if (isShuttingDown) return
    isShuttingDown = true

    log(`\n[${signal}] Shutting down — saving data...`.yellow)
    saveStats(true)
    saveSessionReport()
    sendTelegram(
        `🔴 <b>Checker Stopped</b> (${signal})\n` +
        `Session: ${sessionChecked.toLocaleString()} checked | ${formatUptime(Date.now() - startTime)} uptime\n` +
        `Peak rate: ${peakRate.toLocaleString()}/s | Peak workers: ${peakWorkers}\n` +
        `Funded this session: ${getFundedCount()}`
    )
    workers.forEach(w => { try { w && w.kill('SIGTERM') } catch (_) {} })
    setTimeout(() => process.exit(0), 1500)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ─── Heartbeat check ───────────────────────────────────────────────────

setInterval(() => {
    const now = Date.now()
    for (let i = 0; i < workers.length; i++) {
        if (!workers[i] || workerShuttingDown.has(i)) continue
        const last = lastHeartbeat[i] || startTime
        const silentMs = now - last
        if (silentMs > 60000) {
            log(`[!] Worker ${i + 1} unresponsive for ${Math.floor(silentMs / 1000)}s — restarting`.yellow)
            try { workers[i].kill('SIGTERM') } catch (_) {}
        }
    }
}, 30000)

// ─── Auto-scale ────────────────────────────────────────────────────────

let warmupDone    = false
let goodRateTicks = 0

setInterval(() => {
    if (!warmupDone) {
        if ((Date.now() - startTime) < 60000) return
        warmupDone = true
    }

    const active       = activeWorkerCount()
    const ratePerWorker = active > 0 ? currentAvgRate / active : 0

    // Scale UP: rate per worker is too low and we have room
    if (ratePerWorker < minRate && active < maxWorkers && currentAvgRate > 0) {
        const newIdx = workers.length
        workers.push(spawnWorker(newIdx))
        workerIsExtra[newIdx] = true
        peakWorkers = Math.max(peakWorkers, workers.filter(Boolean).length)
        log(
            `[Auto-scale ↑] Worker ${newIdx + 1} added` +
            ` (${currentAvgRate}/s avg, ${ratePerWorker.toFixed(0)}/s per worker)`.cyan
        )
        goodRateTicks = 0
        return
    }

    // Scale DOWN: rate per worker high and we have extra workers
    if (ratePerWorker > maxRate && active > baseCount) {
        goodRateTicks++
        if (goodRateTicks >= 6) {
            // Find last extra worker
            let lastExtraIdx = -1
            for (let i = workers.length - 1; i >= baseCount; i--) {
                if (workers[i] && workerIsExtra[i]) { lastExtraIdx = i; break }
            }
            if (lastExtraIdx >= 0) {
                workerShuttingDown.add(lastExtraIdx)
                try { workers[lastExtraIdx].kill('SIGTERM') } catch (_) {}
                log(
                    `[Auto-scale ↓] Worker ${lastExtraIdx + 1} removed` +
                    ` (rate stable at ${currentAvgRate}/s)`.gray
                )
                goodRateTicks = 0
            }
        }
    } else {
        goodRateTicks = 0
    }
}, 30000)

// ─── Periodic stats save ───────────────────────────────────────────────

setInterval(() => saveStats(false), 60000)

// ─── Dashboard ─────────────────────────────────────────────────────────

let lastChecked = 0
let lastTime    = Date.now()
let tick        = 0

setInterval(() => {
    tick++
    const now      = Date.now()
    const elapsed  = now - startTime
    const delta    = (now - lastTime) / 1000

    currentInstRate = delta > 0 ? Math.floor((sessionChecked - lastChecked) / delta) : 0
    currentAvgRate  = elapsed > 0 ? Math.floor(sessionChecked / (elapsed / 1000)) : 0

    if (currentInstRate > peakRate) peakRate = currentInstRate

    lastChecked = sessionChecked
    lastTime    = now

    const funded      = getFundedCount()
    const uptime      = formatUptime(elapsed)
    const fundedStr   = funded > 0 ? ` ${funded} `.bgGreen.black : '0'.gray
    const allTimeTotal = allTimeBase + sessionChecked
    const active      = activeWorkerCount()

    const rpc    = getRpcSummary()
    const rpcStr = rpc ? `  RPC: ${String(rpc.alive).green}↑ ${String(rpc.dead).red}✗` : ''

    const line =
        `[${uptime}]` +
        `  Chk: ${sessionChecked.toLocaleString().cyan}` +
        `  Rate: ${String(currentInstRate.toLocaleString() + '/s').yellow}` +
        `  Avg: ${currentAvgRate.toLocaleString()}/s` +
        `  Workers: ${String(active).magenta}` +
        rpcStr +
        `  Funded: ${fundedStr}`

    log(line)

    if (tick % 10 === 0) {
        log('─'.repeat(66).gray)
        log(
            `  Peak: ${peakRate.toLocaleString()}/s` +
            `  |  All-time: ${allTimeTotal.toLocaleString()}` +
            `  |  Session: ${sessionChecked.toLocaleString()}` +
            `  |  Workers: ${active}/${maxWorkers}`
        )
        log('─'.repeat(66).gray)
    }
}, 5000)
