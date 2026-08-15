'use strict'
/* Probe 2: full palette histogram + color tokens from the real DSH GUI. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'dsh-theme-probe2-' + Date.now())
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
    '--no-first-run', '--disable-gpu', '--user-data-dir=' + PROFILE,
    '--window-size=1440,900', 'about:blank',
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
  await send('Page.navigate', { url: 'http://127.0.0.1:3080/' })
  await delay(6500)

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result && r.result.value
  }

  // 1. color tokens only
  const tokens = await evalJs(`(function () {
    const out = {}
    for (const prop of document.body.style) {
      if (!prop.startsWith('--')) continue
      const v = document.body.style.getPropertyValue(prop).trim()
      if (/^(#|rgb|hsl)/i.test(v)) out[prop] = v
    }
    return out
  })()`)

  // 2. DOM palette histogram (visible elements)
  const hist = await evalJs(`(function () {
    const count = {}
    const bump = (v) => { if (!v || v === 'rgba(0, 0, 0, 0)' || v === 'transparent') return; count[v] = (count[v] || 0) + 1 }
    const all = document.querySelectorAll('*')
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width < 20 || r.height < 12) continue
      const s = getComputedStyle(el)
      bump(s.backgroundColor)
      bump(s.color)
      bump(s.borderColor)
    }
    return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 24)
  })()`)

  // 3. structural landmarks
  const landmarks = await evalJs(`(function () {
    const out = {}
    const walk = (el, depth) => {
      if (depth > 3) return
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (r.width >= 100 && r.height >= 40) {
        const key = (el.tagName + '.' + (el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : '')).slice(0, 60)
        if (!out[key]) out[key] = { bg: s.backgroundColor, color: s.color, radius: s.borderRadius, w: Math.round(r.width), h: Math.round(r.height) }
      }
      for (const ch of el.children) walk(ch, depth + 1)
    }
    walk(document.body, 0)
    return out
  })()`)

  console.log(JSON.stringify({ tokens, hist, landmarks }, null, 2))
  chrome.kill()
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1) })
