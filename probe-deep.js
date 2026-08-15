'use strict'
/* Deep probe: remaining artworks, top-bar colors, overlap suspects. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'dsh-deep-probe-' + Date.now())
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

  const report = await evalJs(`(function () {
    const out = { art: [], topStrip: [], imgs: [] }
    // 1. every element with a raster background image (webp/png data url), with rect
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el)
      const bi = s.backgroundImage
      if (bi && bi !== 'none' && bi.indexOf('url') >= 0) {
        const r = el.getBoundingClientRect()
        out.art.push({
          cls: ((typeof el.className === 'string' ? el.className : '') || '').slice(0, 40),
          tag: el.tagName.toLowerCase(),
          x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
          size: s.backgroundSize, pos: s.backgroundPosition, attach: s.backgroundAttachment,
        })
      }
      if (el.tagName === 'IMG') {
        const r = el.getBoundingClientRect()
        out.imgs.push({ src: (el.src || '').slice(0, 60), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display })
      }
    }
    // 2. top 110px strip: backgrounds + z-order of major blocks
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width < 100 || r.height < 8 || r.bottom < 0 || r.top > 110) continue
      const s = getComputedStyle(el)
      const bg = s.backgroundColor
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        out.topStrip.push({
          cls: ((typeof el.className === 'string' ? el.className : '') || '').slice(0, 36),
          tag: el.tagName.toLowerCase(),
          y: Math.round(r.top), h: Math.round(r.height),
          bg: bg, z: s.zIndex, pos: s.position,
        })
      }
    }
    // 3. text elements whose top area may be covered by the fixed bars (y<76)
    return out
  })()`)

  console.log(JSON.stringify(report, null, 2))
  chrome.kill()
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1) })
