const { fork } = require('child_process')
const { program } = require('commander')
const colors = require('colors')
const fs = require('fs')

let sessionChecked = 0
let sessionFunded = 0
const startTime = Date.now()
const children = []

program.option('-c, --count <number>', 'number of worker processes', '2')
const options = program.parse().opts()
const count = parseInt(options.count) || 2

console.log(`\nEthereum Key Generator + Balance Checker`.cyan.bold)
console.log(`Starting ${count} workers (generate + check inline)...`.yellow)

function spawnWorker(i) {
    const child = fork('worker.js', [], { detached: false })

    child.on('message', (msg) => {
        if (msg.type === 'stats') {
            sessionChecked += msg.checked
            sessionFunded += msg.funded
        } else if (msg.type === 'funded') {
            // Print funded alert above the dashboard
            console.log('\n' + '='.repeat(60).green)
            console.log('  *** FUNDED WALLET FOUND ***'.bgGreen.black)
            console.log(`  Address : ${msg.address}`.green)
            console.log(`  ETH     : ${msg.eth}`.green)
            console.log('='.repeat(60).green)
        }
    })

    child.on('exit', (code) => {
        console.log(`\n[!] Worker ${i} exited (code ${code}), restarting...`.yellow)
        children[i] = spawnWorker(i)
    })

    child.stderr && child.stderr.on('data', () => {})
    return child
}

for (let i = 0; i < count; i++) {
    children[i] = spawnWorker(i)
}

process.on('SIGTERM', () => { children.forEach(c => c.kill('SIGTERM')); process.exit(0) })
process.on('SIGINT', () => { children.forEach(c => c.kill('SIGINT')); process.exit(0) })

let cachedFunded = 0
setInterval(() => {
    try {
        cachedFunded = fs.readFileSync('funded.txt', 'utf8')
            .split('\n').filter(l => l.trim()).length
    } catch (e) { cachedFunded = 0 }
}, 3000)

console.log(`All ${count} workers running. Press Ctrl+C to stop.\n`.green)

import('log-update').then(mod => {
    const frames = ['-', '\\', '|', '/']
    let idx = 0
    let lastChecked = 0
    let lastTime = Date.now()

    setInterval(() => {
        const frame = frames[idx = ++idx % frames.length]
        const elapsed = Math.floor((Date.now() - startTime) / 1000)
        const hh = String(Math.floor(elapsed / 3600)).padStart(2, '0')
        const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')
        const ss = String(elapsed % 60).padStart(2, '0')

        // Instantaneous rate (last 1s window)
        const now = Date.now()
        const delta = (now - lastTime) / 1000
        const instantRate = delta > 0 ? Math.floor((sessionChecked - lastChecked) / delta) : 0
        lastChecked = sessionChecked
        lastTime = now

        const totalRate = elapsed > 0 ? Math.floor(sessionChecked / elapsed) : 0
        const fundedStr = cachedFunded > 0 ? ` ${cachedFunded} `.bgGreen.black : '0'

        mod.default(
            `${frame} Uptime: ${hh}:${mm}:${ss}  Workers: ${count}  ${frame}\n` +
            `  Checked   : ${sessionChecked.toLocaleString()} addresses\n` +
            `  Rate      : ${instantRate.toLocaleString()}/s  (avg ${totalRate.toLocaleString()}/s)\n` +
            `  Funded    : ${fundedStr}`
        )
    }, 1000)
})

