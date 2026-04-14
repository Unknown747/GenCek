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
