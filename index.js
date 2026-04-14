const { fork } = require('child_process')
const { program } = require('commander')
const colors = require('colors')
const fs = require('fs')

let sessionChecked = 0
const startTime = Date.now()
const children = []

program.option('-c, --count <number>', 'number of worker processes', '2')
const options = program.parse().opts()
const count = parseInt(options.count) || 2

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
    } catch (e) { return 0 }
}

function spawnWorker(i) {
    const child = fork('worker.js', [], { detached: false })

    child.on('message', (msg) => {
        if (msg.type === 'stats') {
            sessionChecked += msg.checked
        } else if (msg.type === 'funded') {
            console.log('')
            console.log('='.repeat(60).green)
            console.log('  *** FUNDED WALLET FOUND ***'.bgGreen.black)
            console.log(`  Address : ${msg.address}`.green)
            console.log(`  ETH     : ${msg.eth}`.green)
            console.log('='.repeat(60).green)
        } else if (msg.type === 'error') {
            console.log(`[Worker ${i} error] ${msg.msg}`.red)
        }
    })

    child.on('exit', (code) => {
        console.log(`[!] Worker ${i} exited (code ${code}), restarting...`.yellow)
        children[i] = spawnWorker(i)
    })

    child.stderr && child.stderr.on('data', (d) => {
        const line = d.toString().trim()
        if (line) console.log(`[Worker ${i}] ${line}`.gray)
    })

    return child
}

console.log('')
console.log('╔══════════════════════════════════════════════╗'.cyan)
console.log('║   Ethereum Key Generator + Balance Checker  ║'.cyan.bold)
console.log('╚══════════════════════════════════════════════╝'.cyan)
console.log(`  Workers   : ${count}`)
console.log(`  Started   : ${new Date().toISOString()}`)
console.log('')

for (let i = 0; i < count; i++) {
    children[i] = spawnWorker(i)
    console.log(`  [✓] Worker ${i + 1} started`.green)
}

console.log('')

process.on('SIGTERM', () => { children.forEach(c => c.kill('SIGTERM')); process.exit(0) })
process.on('SIGINT',  () => { children.forEach(c => c.kill('SIGINT'));  process.exit(0) })

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

    const line =
        `[${uptime}]` +
        `  Checked: ${sessionChecked.toLocaleString().cyan}` +
        `  Rate: ${String(instantRate.toLocaleString() + '/s').yellow}` +
        `  Avg: ${avgRate.toLocaleString()}/s` +
        `  Funded: ${fundedStr}`

    console.log(line)

    if (tick % 10 === 0) {
        console.log('─'.repeat(62).gray)
    }
}, 5000)
