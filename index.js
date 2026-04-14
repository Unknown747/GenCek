const { fork } = require('child_process')
const { program } = require('commander')
const colors = require('colors')
const fs = require('fs')

const STATS_FILE = 'checker_stats.json'
const LOG_FILE = 'session.log'

let sessionChecked = 0
const startTime = Date.now()
const children = []

// RPC stats aggregated from workers (keep latest report per worker)
const workerRpcStats = {}

program.option('-c, --count <number>', 'number of worker processes', '2')
const options = program.parse().opts()
const count = parseInt(options.count) || 2

// ─── All-time stats ────────────────────────────────────────────────────

function loadStats() {
    try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) }
    catch (_) { return { total_checked_all_time: 0, sessions: 0 } }
}

function saveStats() {
    try {
        const prev = loadStats()
        fs.writeFileSync(STATS_FILE, JSON.stringify({
            total_checked_all_time: prev.total_checked_all_time + sessionChecked,
            sessions: (prev.sessions || 0) + 1,
            last_session_checked: sessionChecked,
            last_updated: new Date().toISOString(),
        }, null, 2))
    } catch (_) {}
}

const allTimeStats = loadStats()
let allTimeBase = allTimeStats.total_checked_all_time

// ─── Log to file ───────────────────────────────────────────────────────

function writeLog(line) {
    try {
        // Strip ANSI color codes before writing to file
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
    const s = Math.floor(ms / 1000)
    const hh = String(Math.floor(s / 3600)).padStart(2, '0')
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
    const ss = String(s % 60).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
}

function getFundedCount() {
    try {
        return fs.readFileSync('funded.txt', 'utf8').split('\n').filter(l => l.trim()).length
    } catch (_) { return 0 }
}

function getRpcSummary() {
    const reports = Object.values(workerRpcStats)
    if (reports.length === 0) return null
    // Use the best alive count reported across workers
    const alive = Math.max(...reports.map(r => r.alive || 0))
    const dead = Math.max(...reports.map(r => r.dead || 0))
    return { alive, dead }
}

// ─── Workers ───────────────────────────────────────────────────────────

function spawnWorker(i) {
    const child = fork('worker.js', [], { detached: false })

    child.on('message', (msg) => {
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
        } else if (msg.type === 'rpc_stats') {
            workerRpcStats[i] = msg
        } else if (msg.type === 'error') {
            log(`[Worker ${i + 1} error] ${msg.msg}`.red)
        }
    })

    child.on('exit', (code) => {
        log(`[!] Worker ${i + 1} exited (code ${code}), restarting...`.yellow)
        children[i] = spawnWorker(i)
    })

    child.stderr && child.stderr.on('data', (d) => {
        const line = d.toString().trim()
        if (line) log(`[Worker ${i + 1}] ${line}`.gray)
    })

    return child
}

// ─── Startup banner ────────────────────────────────────────────────────

const startedAt = new Date().toISOString()
log('')
log('╔══════════════════════════════════════════════╗'.cyan)
log('║   Ethereum Key Generator + Balance Checker  ║'.cyan.bold)
log('╚══════════════════════════════════════════════╝'.cyan)
log(`  Workers     : ${count}`)
log(`  Started     : ${startedAt}`)
log(`  All-time    : ${allTimeBase.toLocaleString()} addresses checked across ${allTimeStats.sessions || 0} session(s)`)
log(`  Stats file  : ${STATS_FILE}`)
log(`  Log file    : ${LOG_FILE}`)
log('')

for (let i = 0; i < count; i++) {
    children[i] = spawnWorker(i)
    log(`  [✓] Worker ${i + 1} started`.green)
}

log('')

// ─── Graceful shutdown ─────────────────────────────────────────────────

function shutdown(signal) {
    log(`\n[${signal}] Shutting down — saving stats...`.yellow)
    saveStats()
    children.forEach(c => { try { c.kill(signal) } catch (_) {} })
    process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ─── Periodic stats save ───────────────────────────────────────────────

setInterval(saveStats, 60 * 1000)

// ─── Dashboard ─────────────────────────────────────────────────────────

let lastChecked = 0
let lastTime = Date.now()
let tick = 0

setInterval(() => {
    tick++
    const now = Date.now()
    const elapsed = now - startTime
    const delta = (now - lastTime) / 1000
    const instantRate = delta > 0 ? Math.floor((sessionChecked - lastChecked) / delta) : 0
    const avgRate = elapsed > 0 ? Math.floor(sessionChecked / (elapsed / 1000)) : 0
    lastChecked = sessionChecked
    lastTime = now

    const funded = getFundedCount()
    const uptime = formatUptime(elapsed)
    const fundedStr = funded > 0 ? ` ${funded} `.bgGreen.black : '0'.gray
    const allTimeTotal = allTimeBase + sessionChecked

    const rpc = getRpcSummary()
    const rpcStr = rpc
        ? `  RPC: ${String(rpc.alive).green}↑ ${String(rpc.dead).red}✗`
        : ''

    const line =
        `[${uptime}]` +
        `  Checked: ${sessionChecked.toLocaleString().cyan}` +
        `  Rate: ${String(instantRate.toLocaleString() + '/s').yellow}` +
        `  Avg: ${avgRate.toLocaleString()}/s` +
        rpcStr +
        `  Funded: ${fundedStr}`

    log(line)

    // Every 10 ticks: print extended summary
    if (tick % 10 === 0) {
        log('─'.repeat(62).gray)
        log(
            `  All-time total : ${allTimeTotal.toLocaleString()} addresses` +
            `  |  Session: ${sessionChecked.toLocaleString()}`
        )
        log('─'.repeat(62).gray)
    }
}, 5000)
