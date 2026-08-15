'use strict'
/* Verify the DeepSeek-app drawer layout on the gateway-served GUI. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'dsh-drawer-probe-' + Date.now())
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
  const authRes = await fetch('http://127.0.0.1:3081/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '243472' }),
  })
  const setCookie = authRes.headers.get('set-cookie') || ''
  const m = setCookie.match(/dsh_pin=([^;]+)/)
  if (m) await send('Network.setCookie', { name: 'dsh_pin', value: m[1], domain: '127.0.0.1', path: '/', url: 'http://127.0.0.1:3081/' })
  await send('Page.navigate', { url: 'http://127.0.0.1:3081/' })
  await delay(7000)

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 250))
    return r.result && r.result.value
  }

  const state = async () => evalJs(`(function () {
    const frame = document.querySelector('.cr-nOG_frame')
    const sb = document.querySelector('.cr-nOG_sidebarCol')
    const dt = document.querySelector('.cr-nOG_detailsCol')
    const sbR = sb ? sb.getBoundingClientRect() : null
    return {
      frameCols: frame ? getComputedStyle(frame).gridTemplateColumns : null,
      sidebarCollapsed: frame ? frame.hasAttribute('data-sidebar-collapsed') : null,
      detailsCollapsed: frame ? frame.hasAttribute('data-details-collapsed') : null,
      sbRect: sbR ? { left: Math.round(sbR.left), right: Math.round(sbR.right), w: Math.round(sbR.width) } : null,
      sbPos: sb ? getComputedStyle(sb).position : null,
      sbTransform: sb ? getComputedStyle(sb).transform : null,
      dtPos: dt ? getComputedStyle(dt).position : null,
      handleVisible: document.querySelector('.cr-nOG_handle') ? getComputedStyle(document.querySelector('.cr-nOG_handle')).display : 'none-or-missing',
      toggle: !!document.querySelector('.V-ZVia_toggle'),
    }
  })()`)

  const out = {}
  out.collapsed = await state()
  // click the header toggle to open the drawer
  await evalJs(`(function () { var b = document.querySelector('.V-ZVia_toggle'); if (b) b.click(); })()`)
  await delay(800)
  out.open = await state()
  // click again to close
  await evalJs(`(function () { var b = document.querySelector('.V-ZVia_toggle'); if (b) b.click(); })()`)
  await delay(800)
  out.closedAgain = await state()

  console.log(JSON.stringify(out, null, 2))
  chrome.kill()
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1) })
