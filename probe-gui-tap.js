'use strict'
/* Measure tap targets and inputs of the real GUI at phone viewport. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'dsh-tap-probe-' + Date.now())
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url) {
  const res = await fetch(url)
  return JSON.parse(await res.text())
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id
          pending.set(mid, { res, rej })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      },
    })
    ws.onerror = () => reject(new Error('ws error'))
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) p.rej(new Error(msg.error.message))
        else p.res(msg.result)
      }
    }
  })
}

;(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*',
    '--no-first-run', '--disable-gpu', '--user-data-dir=' + PROFILE, 'about:blank',
  ], { stdio: 'ignore' })

  let port = null
  for (let i = 0; i < 100; i++) {
    try {
      const txt = fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8')
      port = parseInt(txt.split('\n')[0], 10)
      if (port > 0) break
    } catch {}
    await delay(200)
  }
  let targets = []
  for (let i = 0; i < 50; i++) {
    try { targets = await fetchJson('http://127.0.0.1:' + port + '/json/list'); break } catch { await delay(200) }
  }
  const page = targets.find((t) => t.type === 'page')
  const c = await connect(page.webSocketDebuggerUrl)
  const { send } = c
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  // Auth through the gateway (cookie) when targeting the gateway port.
  const targetPort = process.argv[2] === 'gateway' ? 3081 : 3080
  if (targetPort === 3081) {
    const authRes = await fetch('http://127.0.0.1:3081/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '243472' }),
    })
    const setCookie = authRes.headers.get('set-cookie') || ''
    const m = setCookie.match(/dsh_pin=([^;]+)/)
    if (m) {
      await send('Network.setCookie', { name: 'dsh_pin', value: m[1], domain: '127.0.0.1', path: '/', url: 'http://127.0.0.1:3081/' })
    }
  }
  await send('Page.navigate', { url: 'http://127.0.0.1:' + targetPort + '/' })
  await delay(7000)

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result && r.result.value
  }

  const report = await evalJs(`(function () {
    const out = { small: [], inputs: [], smallText: [], tweaks: null, tweakChecks: {} }
    const tweakStyle = document.getElementById('dsh-mobile-tweaks')
    out.tweaks = tweakStyle ? 'injected' : 'MISSING'
    const seen = new Set()
    const all = document.querySelectorAll('button, a[href], [role="button"], input, textarea, select, [tabindex]:not([tabindex="-1"])')
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const tag = el.tagName.toLowerCase()
      const cls = ((typeof el.className === 'string' ? el.className : el.className && el.className.baseVal) || '').slice(0, 50)
      const s = getComputedStyle(el)
      const rec = { tag, cls, w: Math.round(r.width), h: Math.round(r.height), fs: s.fontSize, pad: s.padding }
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        out.inputs.push(rec)
        if (parseFloat(s.fontSize) < 16) out.smallText.push(rec)
      } else {
        if (r.width < 40 || r.height < 36) out.small.push(rec)
      }
    }
    // verify the invisible hit-area expansion actually applies
    const btn = document.querySelector('.V-ZVia_iconButton') || document.querySelector('.okXF1G_iconButton') || document.querySelector('[class*="iconButton"]')
    if (btn) {
      const after = getComputedStyle(btn, '::after')
      out.tweakChecks.iconAfter = { content: after.content, pos: after.position, inset: after.inset, touch: getComputedStyle(btn).touchAction }
    }
    const ta = document.querySelector('textarea, input')
    if (ta) out.tweakChecks.inputFont = getComputedStyle(ta).fontSize
    return out
  })()`)

  console.log(JSON.stringify(report, null, 2))
  chrome.kill()
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1) })
