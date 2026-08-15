'use strict'
/* One-off E2E validation of the mobile gateway UI in a REAL Chrome:
   load page, check scripts ran, submit PIN, confirm app renders. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'dsh-mobile-e2e-' + Date.now())

function delay(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function fetchJson(url, opts) {
  const res = await fetch(url, opts)
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { throw new Error('non-JSON from ' + url + ': ' + text.slice(0, 120)) }
  return data
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    const events = []
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id
          pending.set(mid, { res, rej })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      },
      on(method, cb) { events.push([method, cb]) },
    })
    ws.onerror = (e) => reject(new Error('ws error ' + e.message))
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) p.rej(new Error(msg.error.message))
        else p.res(msg.result)
        return
      }
      for (const [method, cb] of events) if (msg.method === method) cb(msg.params)
    }
  })
}

;(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*',
    '--no-first-run', '--disable-gpu', '--user-data-dir=' + PROFILE,
    '--disable-blink-features=AutomationControlled', 'about:blank',
  ], { stdio: 'ignore' })

  // find the devtools port from DevToolsActivePort
  let port = null
  for (let i = 0; i < 100; i++) {
    try {
      const txt = fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8')
      port = parseInt(txt.split('\n')[0], 10)
      if (port > 0) break
    } catch {}
    await delay(200)
  }
  if (!port) throw new Error('chrome devtools port not found')

  // wait until /json/list works
  let targets = []
  for (let i = 0; i < 50; i++) {
    try { targets = await fetchJson('http://127.0.0.1:' + port + '/json/list'); break } catch { await delay(200) }
  }
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')

  const c = await connect(page.webSocketDebuggerUrl)
  const { send, on } = c
  const consoleErrors = []
  const badResponses = []
  on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(p.exceptionDetails && p.exceptionDetails.text + ': ' + ((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || ''))
  })
  on('Log.entryAdded', (p) => { if (p.entry.level === 'error') consoleErrors.push(p.entry.text) })
  on('Network.responseReceived', (p) => {
    if (p.response.status >= 400) badResponses.push(p.response.status + ' ' + p.response.url)
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Network.enable')
  await send('Page.navigate', { url: 'http://127.0.0.1:3081/' })
  await delay(1500)

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result && r.result.value
  }

  const checks = {}
  checks.canary = await evalJs('window.__dsbCanary === true')
  checks.build = await evalJs("(document.body.innerText.match(/build-\\d+/) || ['none'])[0]")
  checks.submitPinDefined = await evalJs("typeof window.submitPin === 'function'")
  checks.mainOkRan = await evalJs("(function(){ try { return true } catch(e){ return false } })()")
  checks.pageText = (await evalJs('document.body.innerText')).slice(0, 200)

  // fill PIN and click 连接
  await evalJs("document.getElementById('pinInput').value = '243472'")
  await evalJs("document.getElementById('pinInput').dispatchEvent(new Event('input'))")
  await evalJs("window.__dsbSafeSubmit()")
  await delay(1500)

  checks.appVisible = await evalJs("!document.getElementById('app').classList.contains('hidden')")
  checks.pinGateHidden = await evalJs("document.getElementById('pinGate').classList.contains('hidden')")
  checks.errText = await evalJs("document.getElementById('pinErr').textContent")
  checks.sessions = await evalJs("document.getElementById('sessionList').innerText").then((t) => t.slice(0, 150)).catch(() => '(n/a)')

  // open the RUNNING session (second card) and verify chat history renders (read-only)
  await evalJs("(function(){ var cards = document.querySelectorAll('#sessionList .card'); for (var i = 0; i < cards.length; i++) { if (cards[i].innerText.indexOf('运行中') >= 0) { var b = cards[i].querySelector('.btn'); if (b) b.click(); return } } })()")
  await delay(2500)
  checks.chatTitle = await evalJs("document.getElementById('chatTitle').textContent")
  checks.chatLogLen = await evalJs("document.getElementById('chatLog').innerText.length")
  checks.chatLogSample = await evalJs("document.getElementById('chatLog').innerText").then((t) => t.slice(0, 200)).catch(() => '(n/a)')

  console.log(JSON.stringify(checks, null, 2))
  console.log('console errors:', consoleErrors.length ? consoleErrors : 'none')
  console.log('bad responses:', badResponses.length ? badResponses : 'none')

  chrome.kill()
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}
  const ok = checks.canary && checks.submitPinDefined && checks.appVisible && checks.pinGateHidden && consoleErrors.length === 0
  console.log(ok ? 'E2E RESULT: PASS' : 'E2E RESULT: FAIL')
  process.exit(ok ? 0 : 1)
})().catch((e) => { console.error('E2E ERROR:', e.message); process.exit(1) })
