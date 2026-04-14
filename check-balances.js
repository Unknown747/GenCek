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
