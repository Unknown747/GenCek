const https = require('https')
const http = require('http')

const REQUEST_TIMEOUT_MS = 8000
const PERMANENT_DEATH_THRESHOLD = 8
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000

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

const deadUrls = new Set()

const rpcPool = SEED_URLS.map(url => ({
    url,
    latency: 999,
    errors: 0,
    successes: 0,
    alive: true,
}))

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
        const idx = rpcPool.indexOf(rpc)
        if (idx !== -1) rpcPool.splice(idx, 1)
    }
}

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

async function benchmarkPool(silent = false) {
    await Promise.all(rpcPool.map(async rpc => {
        const { ok, latency } = await pingRpc(rpc.url)
        if (ok) {
            rpc.latency = latency
            rpc.alive = true
        } else {
            rpc.latency = 9999
            markError(rpc)
        }
    }))

    if (!silent) {
        const sorted = getSortedPool()
        console.log('\n  RPC Pool (' + rpcPool.length + ' active, ' + deadUrls.size + ' permanently removed):')
        sorted.forEach((r, i) => {
            const short = r.url.replace(/^https?:\/\//, '').slice(0, 38)
            console.log(`    ${i + 1}. ${short.padEnd(39)} ${r.latency}ms`)
        })
        if (deadUrls.size > 0) {
            console.log('  Permanently removed:')
            deadUrls.forEach(u => console.log(`    ✗ ${u.replace(/^https?:\/\//, '').slice(0, 38)}`))
        }
        console.log('')
    }
}

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
            rpcPool.push({ url, latency, errors: 0, successes: 1, alive: true })
            added++
        }
    }

    if (!silent && added > 0) {
        console.log(`  [RPC Discovery] Added ${added} new endpoint(s) to pool.`)
    }
    return added
}

setInterval(async () => {
    try { await discoverNewRpcs(false) } catch (_) {}
}, DISCOVERY_INTERVAL_MS)

module.exports = {
    rpcPool,
    deadUrls,
    rawRequest,
    getSortedPool,
    markSuccess,
    markError,
    pingRpc,
    benchmarkPool,
    discoverNewRpcs,
}
