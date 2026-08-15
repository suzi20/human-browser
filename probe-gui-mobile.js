'use strict'
/* Probe the real GUI at a phone viewport: overflow, sidebar state, sizes. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'dsh-mobile-probe-' + Date.now())
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
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await send('Page.navigate', { url: 'http://127.0.0.1:3080/' })
  await delay(7000)

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result && r.result.value
  }

  const report = await evalJs(`(function () {
    const out = {}
    out.innerWidth = window.innerWidth
    out.docScrollWidth = document.documentElement.scrollWidth
    out.bodyScrollWidth = document.body.scrollWidth
    out.hOverflow = document.documentElement.scrollWidth > window.innerWidth
    out.viewportMeta = (document.querySelector('meta[name="viewport"]') || {}).content || null
    out.dark = document.body.hasAttribute('data-ds-dark-theme')
    // find the frame + panels by looking for grid containers
    const grids = []
    for (const el of document.querySelectorAll('div')) {
      const s = getComputedStyle(el)
      if (s.display === 'grid' && s.gridTemplateColumns && s.gridTemplateColumns.split(' ').length > 1) {
        grids.push({ cls: (el.className || '').toString().slice(0, 60), cols: s.gridTemplateColumns })
      }
      if (grids.length >= 6) break
    }
    out.grids = grids
    // fixed/sticky elements that may cover the screen
    const fixed = []
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el)
      if (s.position === 'fixed' || s.position === 'sticky') {
        const r = el.getBoundingClientRect()
        fixed.push({ cls: (el.className || '').toString().slice(0, 50), pos: s.position, w: Math.round(r.width), h: Math.round(r.height), z: s.zIndex })
      }
      if (fixed.length >= 10) break
    }
    out.fixed = fixed
    out.fontSizes = {}
    const bodyFont = getComputedStyle(document.body).fontSize
    out.bodyFont = bodyFont
    out.sidebarVisible = (function () {
      // crude: any element >= 200px wide fixed at left?
      return null
    })()
    out.textSample = document.body.innerText.slice(0, 200)
    return out
  })()`)

  console.log(JSON.stringify(report, null, 2))
  chrome.kill()
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1) })
