// macOS launch smoke test: launch the built .app and verify the RENDERER
// actually reaches the app UI — not just that the process started. A broken
// build (e.g. a service that blocks Angular bootstrap) sits forever on the
// splash while the main process + CDP are perfectly alive, so a "process up"
// check (like the Linux/Windows smokes) does NOT catch it. v0.3.0 shipped a
// silent splash-hang exactly because mac had no launch smoke. This probes the
// DOM via CDP and fails if the app never bootstraps.
//
// Usage: node scripts/mac-launch-smoke.mjs <path-to-GlanceTerm.app>
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const appBundle = process.argv[2]
if (!appBundle || !fs.existsSync(appBundle)) {
    console.error(`✗ app bundle not found: ${appBundle}`)
    process.exit(2)
}
const exe = path.join(appBundle, 'Contents', 'MacOS', 'GlanceTerm')
const PORT = 9333
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-smoke-'))
const BASE = `http://127.0.0.1:${PORT}`
const NODES_LOADED = 200 // splash is ~30 nodes; a bootstrapped app is hundreds+

const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-sandbox'], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
})
let done = false
const cleanup = (code) => {
    if (done) return
    done = true
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    process.exit(code)
}
child.on('exit', (c) => { if (!done) { console.error(`✗ app process exited early (code ${c}) — startup crash`); cleanup(1) } })

async function pageTarget () {
    try {
        const list = await (await fetch(`${BASE}/json`)).json()
        return list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch { return null }
}
function evalExpr (ws, expr, id) {
    return new Promise((resolve) => {
        const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); resolve(m.result?.result?.value) } }
        ws.addEventListener('message', onMsg)
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
    })
}

const deadline = Date.now() + 90_000
let target = null
while (Date.now() < deadline && !target) { target = await pageTarget(); if (!target) await new Promise(r => setTimeout(r, 1500)) }
if (!target) { console.error('✗ CDP never exposed a page target within 90s'); cleanup(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
const expr = `JSON.stringify({n: document.querySelectorAll('*').length, app: !!document.querySelector('app-root tab-body, .tab-bar, split-tab, ngb-tabset, .content .tabs')})`
let id = 1
while (Date.now() < deadline) {
    const v = await evalExpr(ws, expr, id++)
    const o = v ? JSON.parse(v) : { n: 0 }
    console.log(`  smoke: dom nodes=${o.n} appUI=${o.app}`)
    if (o.n >= NODES_LOADED || o.app) { console.log('✓ macOS launch smoke PASSED — renderer reached the app UI'); cleanup(0) }
    await new Promise(r => setTimeout(r, 3000))
}
console.error(`✗ macOS launch smoke FAILED — app stuck on splash (never bootstrapped) after 90s`)
cleanup(1)
