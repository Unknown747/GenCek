const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

const REQUEST_TIMEOUT_MS = 8000
const PERMANENT_DEATH_THRESHOLD = 8
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000
const RETRY_DEAD_INTERVAL_MS = 2 * 60 * 60 * 1000
const SAVE_STATE_INTERVAL_MS = 60 * 1000

const DEAD_FILE = path.join(__dirname, 'dead_rpcs.json')
const STATE_FILE = path.join(__dirname, 'rpc_state.json')

const SEED_URLS = [
    'http://202.61.239.89:8545',
    'https://eth.drpc.org',
    'https://1rpc.io/eth',
    'https://ethereum.publicnode.com',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
]

const CANDIDATE_URLS = [
    'https://eth.drpc.org',
    'https://1rpc.io/eth',
    'https://ethereum.publicnode.com',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
    'https://eth-mainnet.public.blastapi.io',
    'https://ethereum.blockpi.network/v1/rpc/public',
    'https://eth.api.onfinality.io/public',
    'https://rpc.payload.de',
    'https://virginia.rpc.blxrbdn.com',
    'https://uk.rpc.blxrbdn.com',
    'https://singapore.rpc.blxrbdn.com',
    'https://api.securerpc.com/v1',
    'https://mainnet.eth.cloud.ava.do',
    'https://api.zmok.io/mainnet/oaen6dy8ff6hju9k',
    'https://rpc.builder0x69.io',
    'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
    'https://rpc.flashbots.net',
    'https://eth.meowrpc.com',
]

// ─── Persistence helpers ───────────────────────────────────────────────

function loadDeadUrls() {
    try {
        const data = JSON.parse(fs.readFileSync(DEAD_FILE, 'utf8'))
        if (Array.isArray(data)) data.forEach(u => deadUrls.add(u))
    } catch (_) {}
}

function saveDeadUrls() {
    try { fs.writeFileSync(DEAD_FILE, JSON.stringify([...deadUrls], null, 2)) } catch (_) {}
}

function loadPoolState() {
    try {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
        if (!Array.isArray(data)) return
        for (const saved of data) {
            const rpc = rpcPool.find(r => r.url === saved.url)
            if (rpc && saved.latency > 0) rpc.latency = saved.latency
        }
    } catch (_) {}
}

function savePoolState() {
    try {
        const state = rpcPool.map(r => ({ url: r.url, latency: r.latency, successes: r.successes }))
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
    } catch (_) {}
}

// ─── Pool state ────────────────────────────────────────────────────────

const deadUrls = new Set()

const rpcPool = SEED_URLS.map(url => ({
    url,
    latency: 999,
    errors: 0,
    successes: 0,
    alive: true,
}))

// Load persisted state immediately on module load
loadDeadUrls()
// Remove any SEED_URLS that were previously marked dead
for (let i = rpcPool.length - 1; i >= 0; i--) {
    if (deadUrls.has(rpcPool[i].url)) rpcPool.splice(i, 1)
}
loadPoolState()

// ─── Core functions ────────────────────────────────────────────────────

function rawRequest(url, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const u = new URL(url)
        const isHttps = u.protocol === 'https:'
        const opts = {
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: timeoutMs,
        }
        const req = (isHttps ? https : http).request(opts, res => {
            let data = ''
            res.on('data', c => { data += c })
            res.on('end', () => resolve(data))
        })
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}

function getSortedPool() {
    return rpcPool
        .filter(r => r.alive)
        .sort((a, b) => (a.latency + a.errors * 300) - (b.latency + b.errors * 300))
}

function getPoolStats() {
    const alive = rpcPool.filter(r => r.alive).length
    const inactive = rpcPool.filter(r => !r.alive).length
    return {
        alive,
        inactive,
        total: rpcPool.length,
        dead: deadUrls.size,
    }
}

function markSuccess(rpc, elapsed) {
    rpc.latency = Math.round(rpc.latency * 0.7 + elapsed * 0.3)
    rpc.errors = Math.max(0, rpc.errors - 1)
    rpc.alive = true
    rpc.successes++
}

function markError(rpc) {
    rpc.errors++
    if (rpc.errors >= 4) rpc.alive = false
    if (rpc.errors >= PERMANENT_DEATH_THRESHOLD) {
        deadUrls.add(rpc.url)
        saveDeadUrls()
        const idx = rpcPool.indexOf(rpc)
        if (idx !== -1) rpcPool.splice(idx, 1)
    }
}

// ─── Ping & benchmark ─────────────────────────────────────────────────

async function pingRpc(url, timeoutMs = 5000) {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 })
    const t = Date.now()
    try {
        const raw = await rawRequest(url, body, timeoutMs)
        const parsed = JSON.parse(raw)
        if (parsed && parsed.result) {
            return { ok: true, latency: Date.now() - t }
        }
        return { ok: false, latency: null }
    } catch (e) {
        return { ok: false, latency: null }
    }
}

let _benchmarking = false
async function benchmarkPool(silent = false) {
    if (_benchmarking) return
    _benchmarking = true
    try {
        const snapshot = [...rpcPool]
        await Promise.all(snapshot.map(async rpc => {
            const { ok, latency } = await pingRpc(rpc.url)
            if (ok) {
                rpc.latency = latency
                rpc.alive = true
            } else {
                rpc.latency = 9999
                markError(rpc)
            }
        }))
        savePoolState()
    } finally {
        _benchmarking = false
    }

    if (!silent) {
        const sorted = getSortedPool()
        const stats = getPoolStats()
        console.log(`\n  RPC Pool — ${stats.alive} alive | ${stats.inactive} inactive | ${stats.dead} permanently removed`)
        sorted.forEach((r, i) => {
            const short = r.url.replace(/^https?:\/\//, '').slice(0, 38)
            console.log(`    ${i + 1}. ${short.padEnd(39)} ${r.latency}ms`)
        })
        if (deadUrls.size > 0) {
            console.log('  Permanently dead:')
            deadUrls.forEach(u => console.log(`    ✗ ${u.replace(/^https?:\/\//, '').slice(0, 38)}`))
        }
        console.log('')
    }
}

// ─── Discovery ────────────────────────────────────────────────────────

async function discoverNewRpcs(silent = true) {
    const currentUrls = new Set(rpcPool.map(r => r.url))
    const candidates = CANDIDATE_URLS.filter(u => !currentUrls.has(u) && !deadUrls.has(u))
    if (candidates.length === 0) return 0

    const results = await Promise.all(candidates.map(async url => {
        const { ok, latency } = await pingRpc(url, 5000)
        return { url, ok, latency }
    }))

    let added = 0
    for (const { url, ok, latency } of results) {
        if (ok) {
            rpcPool.push({ url, latency, errors: 0, successes: 0, alive: true })
            added++
        }
    }

    if (added > 0) {
        savePoolState()
        if (!silent) console.log(`  [RPC Discovery] Added ${added} new endpoint(s) to pool.`)
    }
    return added
}

// ─── Retry dead RPCs ──────────────────────────────────────────────────

async function retryDeadRpcs() {
    const toRetry = [...deadUrls]
    if (toRetry.length === 0) return 0

    let recovered = 0
    for (const url of toRetry) {
        const { ok, latency } = await pingRpc(url, 5000)
        if (ok) {
            deadUrls.delete(url)
            rpcPool.push({ url, latency, errors: 0, successes: 0, alive: true })
            recovered++
        }
    }

    if (recovered > 0) {
        saveDeadUrls()
        savePoolState()
        console.log(`  [RPC Recovery] ${recovered} previously dead endpoint(s) are back online.`)
    }
    return recovered
}

// ─── Intervals ────────────────────────────────────────────────────────

setInterval(async () => {
    try { await discoverNewRpcs(false) } catch (_) {}
}, DISCOVERY_INTERVAL_MS)

setInterval(() => {
    try { savePoolState() } catch (_) {}
}, SAVE_STATE_INTERVAL_MS)

setInterval(async () => {
    try { await retryDeadRpcs() } catch (_) {}
}, RETRY_DEAD_INTERVAL_MS)

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
    rpcPool,
    deadUrls,
    rawRequest,
    getSortedPool,
    getPoolStats,
    markSuccess,
    markError,
    pingRpc,
    benchmarkPool,
    discoverNewRpcs,
    retryDeadRpcs,
    savePoolState,
}
