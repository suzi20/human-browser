'use strict'
/* Probe the REAL DSH GUI in headless Chrome and dump its rendered design
   tokens: body inline CSS variables, computed colors, fonts, radii. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'dsh-theme-probe-' + Date.now())
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url) {
  const res = await fetch(url)
  const text = await res.text()
  try { return JSON.parse(text) } catch { throw new Error('non-JSON: ' + text.slice(0, 100)) }
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
  if (!port) throw new Error('no devtools port')
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
  await delay(6000)

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result && r.result.value
  }

  const tokens = await evalJs(`(function () {
    const out = {}
    for (const prop of document.body.style) {
      if (prop.startsWith('--')) out[prop] = document.body.style.getPropertyValue(prop).trim()
    }
    return out
  })()`)

  const meta = await evalJs(`(function () {
    const cs = getComputedStyle(document.body)
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, color: s.color, border: s.borderColor, radius: s.borderRadius, font: s.fontFamily.slice(0, 80) }
    }
    return {
      body: { bg: cs.backgroundColor, color: cs.color, font: cs.fontFamily.slice(0, 80) },
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      html: document.documentElement.style.colorScheme,
      anyButton: pick('button'),
      anyInput: pick('input'),
      anyLink: pick('a'),
      text: document.body.innerText.slice(0, 300),
    }
  })()`)

  console.log(JSON.stringify({ tokens, meta }, null, 2))
  chrome.kill()
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1) })
