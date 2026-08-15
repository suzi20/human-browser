'use strict'
/**
 * human-browser driver — a from-scratch Chrome DevTools Protocol engine.
 *
 * Zero npm dependencies: launches the REAL Chrome installed on this machine,
 * controls it over raw CDP (WebSocket, built into Node >= 22), and makes every
 * input feel human: bezier mouse curves, variable-speed typing with typos that
 * get corrected, eased scrolling, reading pauses — all at real-person speed.
 *
 * A dedicated persistent user-data-dir means cookies, logins, history and
 * storage survive across sessions, exactly like a real person's browser.
 *
 * Protocol (line-delimited JSON over stdio):
 *   in:  { id, method, params }
 *   out: { id, ok, result } | { id, ok: false, error: { message } }
 *        { event: 'ready' }  { event: 'log', text }
 *
 * Also embeddable in-process: require('browser-driver').createDriver(write)
 * returns { handle(line), session }.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

const ROOT = __dirname
const PROFILE_DIR = path.join(ROOT, 'profile')
const SHOTS_DIR = path.join(ROOT, 'shots')
const DOWNLOADS_DIR = path.join(ROOT, 'downloads')
const CRAWLS_DIR = path.join(ROOT, 'crawls')

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
].filter(Boolean)

/** Injected before every page script runs: hides automation fingerprints. */
const STEALTH = `(() => {
  'use strict'
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true }) } catch (e) {}
  try {
    if (!window.chrome) window.chrome = {}
    if (!window.chrome.runtime) window.chrome.runtime = {}
    window.chrome.loadTimes = window.chrome.loadTimes || function () { return {} }
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true })
    Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true })
  } catch (e) {}
  try {
    const make = () => {
      const arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ]
      arr.item = (i) => arr[i] || null
      arr.namedItem = (n) => arr.find((p) => p.name === n) || null
      arr.refresh = () => {}
      return arr
    }
    Object.defineProperty(navigator, 'plugins', { get: make, configurable: true })
  } catch (e) {}
  try {
    const gp = WebGLRenderingContext.prototype.getParameter
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Google Inc. (NVIDIA)'
      if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
      return gp.call(this, p)
    }
    const gp2 = WebGL2RenderingContext.prototype.getParameter
    WebGL2RenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Google Inc. (NVIDIA)'
      if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
      return gp2.call(this, p)
    }
  } catch (e) {}
  try {
    const oq = window.navigator.permissions.query.bind(window.navigator.permissions)
    window.navigator.permissions.query = (d) => (d && d.name === 'notifications')
      ? Promise.resolve({ state: Notification.permission, onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } })
      : oq(d)
  } catch (e) {}
  // Remove the CDP-added cdc_ automation globals Chrome injects.
  try {
    for (const k of Object.getOwnPropertyNames(window)) {
      if (/^cdc_/.test(k)) { try { delete window[k] } catch (e) {} }
    }
  } catch (e) {}
  // Canvas fingerprint noise: perturb a tiny random subset of pixels (±1 per
  // channel) whenever a canvas is read out — cheap, invisible, spoofs hashes.
  try {
    const perturb = (canvas) => {
      try {
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const w = canvas.width, h = canvas.height
        if (w < 1 || h < 1) return
        const img = ctx.getImageData(0, 0, w, h)
        const data = img.data
        const samples = Math.min(600, Math.max(20, Math.floor(w * h / 2000)))
        for (let i = 0; i < samples; i++) {
          const p = 4 * (Math.floor(Math.random() * w * h))
          const d = Math.random() < 0.5 ? -1 : 1
          data[p] = Math.min(255, Math.max(0, data[p] + d))
          data[p + 1] = Math.min(255, Math.max(0, data[p + 1] + d))
          data[p + 2] = Math.min(255, Math.max(0, data[p + 2] + d))
        }
        ctx.putImageData(img, 0, 0)
      } catch (e) {}
    }
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      perturb(this)
      return origToDataURL.apply(this, args)
    }
    const origToBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
      perturb(this)
      return origToBlob.call(this, cb, ...rest)
    }
  } catch (e) {}
  // Battery API parity: real Chrome exposes getBattery on secure contexts;
  // provide a stable, natural-looking answer where it is missing.
  try {
    if (!navigator.getBattery) {
      navigator.getBattery = () => Promise.resolve({
        charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1,
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
      })
    }
  } catch (e) {}
})()`

/** QWERTY neighbours for typo simulation. */
const NEIGHBOR = {
  a: 'sq', b: 'vn', c: 'xv', d: 'sf', e: 'wr', f: 'dg', g: 'fh', h: 'gj', i: 'uo',
  j: 'hk', k: 'jl', l: 'k', m: 'nj', n: 'bm', o: 'ip', p: 'o', q: 'wa', r: 'et',
  s: 'ad', t: 'ry', u: 'yi', v: 'cb', w: 'qe', x: 'zc', y: 'tu', z: 'ax',
}
const SHIFTED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()_+{}|:"<>?~'
const KEY_CODES = {
  ' ': 'Space', '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5',
  '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', '-': 'Minus',
  '_': 'Minus', '=': 'Equal', '+': 'Equal', '[': 'BracketLeft', '{': 'BracketLeft',
  ']': 'BracketRight', '}': 'BracketRight', '\\': 'Backslash', '|': 'Backslash',
  ';': 'Semicolon', ':': 'Semicolon', "'": 'Quote', '"': 'Quote', ',': 'Comma',
  '<': 'Comma', '.': 'Period', '>': 'Period', '/': 'Slash', '?': 'Slash', '`': 'Backquote', '~': 'Backquote',
}
const SPECIAL_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Space: { key: ' ', code: 'Space', vk: 32 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  F5: { key: 'F5', code: 'F5', vk: 116 },
}

/** Search engines the agent can route a query through. */
const SEARCH_ENGINES = {
  baidu: (q) => 'https://www.baidu.com/s?wd=' + encodeURIComponent(q),
  bing: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
  google: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q),
}

/**
 * Bot-check / login-wall detection patterns. `captcha` = the site is asking a
 * human to prove they are one; `login` = content is behind a login. Both are
 * "human-in-the-loop" barriers: the right move is to pause and let a person
 * pass, then continue.
 */
const CAPTCHA_RE = /安全验证|人机验证|滑动验证|拖动滑块|请完成验证|请解决以下难题|验证码中间页|安全限制|访问过于频繁|操作过于频繁|Access Denied|Checking your browser|challenge-platform|hcaptcha|recaptcha|turnstile|verify you are human|robot|captcha/i
const LOGIN_RE = /登录后查看|扫码登录|请先登录|登录后才能|登录\/注册|立即登录/i

/** Pacing profiles. `human` is the default: real-person speed. */
const SPEED = {
  human: { typeBase: [110, 260], typeSpace: [120, 380], move: 1.0, read: 0.8, settle: [200, 550] },
  fast: { typeBase: [30, 70], typeSpace: [35, 100], move: 0.3, read: 0.2, settle: [50, 150] },
  instant: { typeBase: [0, 0], typeSpace: [0, 0], move: 0.05, read: 0.05, settle: [0, 0] },
}

/** Page-side helpers injected via eval: selector builder + element inventory. */
const PAGE_HELPERS = `
function __hb_selector(el) {
  if (el.id && /^[A-Za-z_][\\w-]*$/.test(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
    return '#' + CSS.escape(el.id)
  }
  if (typeof el.className === 'string' && el.className.trim()) {
    const classes = el.className.trim().split(/\\s+/).filter((c) => /^[A-Za-z_][\\w-]*$/.test(c)).slice(0, 2)
    if (classes.length) {
      const css = el.tagName.toLowerCase() + classes.map((c) => '.' + CSS.escape(c)).join('')
      if (document.querySelectorAll(css).length === 1) return css
    }
  }
  const path = []
  let node = el
  let depth = 0
  while (node && node !== document.body && node.nodeType === 1 && depth++ < 6) {
    let part = node.tagName.toLowerCase()
    const parent = node.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName)
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
    }
    path.unshift(part)
    node = parent
  }
  return path.join(' > ')
}
function __hb_elements(cap) {
  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll('a,button,input,textarea,select,option,[role="button"],[contenteditable="true"],summary,label')) {
    if (out.length >= cap) break
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    if (r.top < -400 || r.top > window.innerHeight + 600) continue
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none') continue
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 60)
    if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') continue
    const selector = __hb_selector(el)
    if (seen.has(selector)) continue
    seen.add(selector)
    out.push({
      tag: el.tagName.toLowerCase(),
      text,
      selector,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      href: typeof el.href === 'string' ? el.href : undefined,
      type: el.type || undefined,
    })
  }
  return out
}
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rand = (min, max) => min + Math.random() * (max - min)
const jitter = (ms) => ms * (0.75 + Math.random() * 0.5)

async function fetchJson(url, timeoutMs = 10000, method = 'GET') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method, signal: controller.signal })
    const raw = await response.text()
    let data
    try { data = JSON.parse(raw) } catch {
      throw new Error('non-JSON response from ' + url + ': ' + raw.slice(0, 120))
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** Minimal CDP-over-WebSocket client (Node >= 22 global WebSocket). */
class CdpClient {
  constructor(url) {
    this.url = url
    this.seq = 0
    this.pending = new Map()
    this.ws = null
    this.listeners = new Map()
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      const fail = (err) => reject(err instanceof Error ? err : new Error('cdp connect failed: ' + this.url))
      ws.onopen = () => resolve()
      ws.onerror = () => fail(new Error('cdp connect error: ' + this.url))
      ws.onmessage = (event) => this.onMessage(event.data)
      ws.onclose = () => this.rejectAll(new Error('cdp connection closed'))
    })
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(listener)
  }

  send(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('cdp timeout: ' + method))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  onMessage(raw) {
    let message
    try { message = JSON.parse(raw) } catch { return }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const p = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) p.reject(new Error(message.error.message || 'cdp error'))
      else p.resolve(message.result)
      return
    }
    if (message.method && this.listeners.has(message.method)) {
      for (const listener of this.listeners.get(message.method)) {
        try { listener(message.params || {}) } catch {}
      }
    }
  }

  rejectAll(err) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  close() {
    try { this.ws.close() } catch {}
  }
}

/** One live Chrome session: launch, page, and the human-behavior engine. */
class Session {
  constructor(log) {
    this.log = log || (() => {})
    this.page = null
    this.running = false
    this.proc = null
    this.procPid = null
    this.adopted = false
    this.port = null
    this.browserWsUrl = null
    this.mouse = { x: 600, y: 400 }
    this.speed = 'human'
  }

  // ---------- CDP helpers ----------
  cdp(method, params, timeoutMs) {
    if (!this.page) return Promise.reject(new Error('browser not open — call browser_open first'))
    return this.page.send(method, params || {}, timeoutMs)
  }

  async evalJs(expression) {
    const r = await this.cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 20000)
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description
      throw new Error('page error: ' + (d || r.exceptionDetails.text || 'unknown'))
    }
    const value = r.result && r.result.value
    if (value === undefined) return null
    try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
  }

  async waitReadyState(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if ((await this.evalJs('document.readyState')) === 'complete') return true
      } catch {}
      await sleep(200)
    }
    return false
  }

  // ---------- lifecycle ----------
  async ensureChrome({ headless }) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true })
    const portFile = path.join(PROFILE_DIR, 'DevToolsActivePort')

    // Adopt a still-live browser from a previous driver run (crash resilience).
    try {
      if (fs.existsSync(portFile)) {
        const port = parseInt(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0], 10)
        if (port && await this.portAlive(port)) {
          const version = await fetchJson('http://127.0.0.1:' + port + '/json/version', 800).catch(() => null)
          if (version && version.webSocketDebuggerUrl) {
            this.port = port
            this.adopted = true
            this.log('adopted live Chrome on port ' + port)
            return
          }
        }
      }
    } catch {}

    try { fs.rmSync(portFile, { force: true }) } catch {}

    const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p))
    if (!exe) throw new Error('no Chrome/Edge found on this machine')

    const args = [
      '--remote-debugging-port=0',
      '--user-data-dir=' + PROFILE_DIR,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-blink-features=AutomationControlled',
      '--remote-allow-origins=*',
      '--window-size=1366,768',
      '--window-position=60,40',
      '--lang=zh-CN',
      'about:blank',
    ]
    if (headless) args.unshift('--headless=new')

    this.log('launching ' + exe)
    this.proc = spawn(exe, args, { stdio: 'ignore' })
    this.procPid = this.proc.pid
    let exited = false
    this.proc.on('exit', () => { exited = true })

    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (exited) throw new Error('Chrome exited during startup (profile locked by another process?)')
      await sleep(200)
      if (fs.existsSync(portFile)) {
        const port = parseInt(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0], 10)
        if (port && await this.portAlive(port)) {
          const version = await fetchJson('http://127.0.0.1:' + port + '/json/version', 800).catch(() => null)
          if (version && version.webSocketDebuggerUrl) {
            this.port = port
            return
          }
        }
      }
    }
    throw new Error('Chrome debug port did not become live within 20s')
  }

  /** Raw liveness probe: ANY HTTP answer means the browser is alive. */
  async portAlive(port) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 800)
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: controller.signal })
        return true
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return false
    }
  }

  async setupPage() {
    const version = await fetchJson('http://127.0.0.1:' + this.port + '/json/version')
    this.browserWsUrl = version.webSocketDebuggerUrl

    // Newer Chrome only accepts PUT on /json/new; a dying browser answers
    // with plain text, so treat non-JSON as a launch failure, not a fallback.
    const target = await fetchJson('http://127.0.0.1:' + this.port + '/json/new?about:blank', 10000, 'PUT')

    await this.attachTarget(target)
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true })
    await this.page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS_DIR }).catch(() => {})
    this.running = true
  }

  /** (Re)attach the session to one page target: stealth, viewport, foreground. */
  async attachTarget(target) {
    const page = new CdpClient(target.webSocketDebuggerUrl)
    await page.connect()
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Network.enable')
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH })
    // Track in-flight requests so navigation can wait for network idle
    // (borrowed from the mature-playbook: SPA content renders after idle).
    page.inflight = 0
    page.on('Network.requestWillBeSent', () => { page.inflight++ })
    page.on('Network.loadingFinished', () => { page.inflight = Math.max(0, page.inflight - 1) })
    page.on('Network.loadingFailed', () => { page.inflight = Math.max(0, page.inflight - 1) })
    const previous = this.page
    this.page = page
    this.targetId = target.id
    if (previous) previous.close()
    await this.activateTab().catch(() => {})
    const viewport = await this.evalJs('({ w: window.innerWidth, h: window.innerHeight })').catch(() => null)
    this.mouse = { x: viewport ? Math.round(viewport.w / 2) : 600, y: viewport ? Math.round(viewport.h / 2) : 400 }
  }

  /** Wait until no network requests have been in flight for a stable window. */
  async waitForIdle(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    let stable = 0
    while (Date.now() < deadline) {
      const inflight = this.page ? (this.page.inflight || 0) : 0
      if (inflight === 0) {
        stable += 120
        if (stable >= 360) return true
      } else {
        stable = 0
      }
      await sleep(120)
    }
    return false
  }

  /**
   * Detect whether the current page is a bot-check or login barrier.
   * Returns { blocked, kind: 'captcha'|'login', title, url, text } — when
   * blocked, a human should pass it in the visible window, then the agent
   * calls waitForHuman to continue.
   */
  async detectBarrier() {
    if (!this.running || !this.page) return { blocked: false }
    const info = await this.evalJs(`(() => {
      const text = (document.body && document.body.innerText || '')
      const main = document.querySelector('main, article, #main, [role="main"]')
      return { url: location.href, title: document.title, head: text.slice(0, 800), len: text.length, mainLen: main ? main.innerText.length : 0 }
    })()`).catch(() => null)
    if (!info) return { blocked: false }
    const haystack = info.title + ' ' + info.head
    // Captcha barriers: unambiguous phrases — always a real block.
    if (CAPTCHA_RE.test(haystack)) {
      return { blocked: true, kind: 'captcha', title: info.title, url: info.url, text: info.head.slice(0, 300) }
    }
    // Login barriers: only a REAL login wall, not a page that merely contains
    // "登录/注册" in its chrome. Signal = the page has almost no content at
    // all while claiming login is required. Content-rich pages pass through.
    if (LOGIN_RE.test(haystack) && info.len < 400 && info.mainLen < 200) {
      return { blocked: true, kind: 'login', title: info.title, url: info.url, text: info.head.slice(0, 300) }
    }
    return { blocked: false }
  }

  /**
   * Pause until a human clears the current barrier in the visible window.
   * Polls every 2s; returns { cleared: true } once the page is usable again,
   * or { cleared: false, reason: 'timeout' } when the budget runs out.
   */
  async waitForHuman(params = {}) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    const timeoutMs = Math.max(10000, Math.min(600000, params.timeoutMs || 120000))
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const barrier = await this.detectBarrier()
      if (!barrier.blocked) {
        return { cleared: true, waitedMs: Date.now() - deadline + timeoutMs }
      }
      await sleep(2000)
    }
    const still = await this.detectBarrier()
    return {
      cleared: false,
      reason: 'timeout after ' + Math.round(timeoutMs / 1000) + 's',
      kind: still.kind,
      hint: 'a human must pass the ' + still.kind + ' barrier in the visible browser window, then browser_wait_for_human again',
    }
  }

  /**
   * After a click, a link may have opened a NEW tab (target=_blank). Follow it
   * like a human whose gaze moves to the new tab: attach to the newest
   * non-blank page target. Returns true when a switch happened.
   */
  async followNewTab() {
    try {
      const list = await fetchJson('http://127.0.0.1:' + this.port + '/json/list', 3000)
      const pages = list.filter((t) => t.type === 'page')
      const others = pages.filter((t) => t.id !== this.targetId)
      if (others.length === 0) return false
      const pick = others.find((t) => t.url && !/^about:blank/.test(t.url)) || others[others.length - 1]
      if (/^about:blank/.test(pick.url || '')) return false
      this.log('following new tab: ' + pick.url)
      await this.attachTarget(pick)
      await this.waitReadyState(20000)
      return true
    } catch {
      return false
    }
  }

  /** Activate our page target through the browser-level connection. */
  async activateTab() {
    const browser = new CdpClient(this.browserWsUrl)
    try {
      await browser.connect()
      await browser.send('Target.activateTarget', { targetId: this.targetId }, 8000)
    } finally {
      browser.close()
    }
  }

  /**
   * Dispatch one input event, retrying once after re-activating the tab when
   * the first attempt stalls (Chrome defers input while occluded/busy).
   */
  async input(method, params, timeoutMs = 8000) {
    try {
      return await this.cdp(method, params, timeoutMs)
    } catch (err) {
      await this.activateTab().catch(() => {})
      return await this.cdp(method, params, timeoutMs)
    }
  }

  async open(params = {}) {
    if (this.running) {
      if (params.url) await this.goto(params)
      return await this.status()
    }
    this.speed = SPEED[params.speed] ? params.speed : (params.speed || 'human')
    await this.ensureChrome(params)
    await this.setupPage()
    if (params.url) await this.goto(params)
    return await this.status()
  }

  async close() {
    if (!this.running) return { open: false }
    const proc = this.proc
    const port = this.port
    try {
      const browser = new CdpClient(this.browserWsUrl)
      await browser.connect()
      await browser.send('Browser.close', {}, 6000)
      browser.close()
    } catch {
      // Browser.close over CDP failed; fall back to a tree kill.
      if (proc && !this.adopted) {
        try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
      }
    }
    if (this.page) this.page.close()
    this.page = null
    this.running = false
    this.proc = null
    // Wait for the browser to actually quit. Chrome's graceful shutdown closes
    // the debug port FIRST and exits the process later (flushing the profile),
    // so a port probe is not enough: the next open must not adopt a dying
    // instance or race the profile lock. Wait on the process when we own it,
    // otherwise poll the port.
    if (proc) {
      const exitP = new Promise((resolve) => proc.once('exit', resolve))
      await Promise.race([exitP, sleep(8000)])
      if (proc.exitCode === null && !proc.killed) {
        try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
        await sleep(500)
      }
      await this.waitPortDead(port, 6000)
    } else {
      await this.waitPortDead(port, 8000)
    }
    return { open: false, note: 'browser closed; profile (cookies, logins) preserved for the next session' }
  }

  /** Poll until the debug port stops answering (browser fully exited). */
  async waitPortDead(port, timeoutMs) {
    if (!port) return
    const deadline = Date.now() + timeoutMs
    let consecutive = 0
    while (Date.now() < deadline) {
      // Raw fetch, not fetchJson: a closing Chrome may answer the debug
      // endpoint with non-JSON text; ANY HTTP response means the browser is
      // still alive. Only a refused connection counts as dead.
      let alive = true
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 800)
        try {
          const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: controller.signal })
          alive = response.ok || response.status !== 0
        } finally {
          clearTimeout(timer)
        }
      } catch {
        alive = false
      }
      if (!alive) {
        consecutive++
        if (consecutive >= 3) return
      } else {
        consecutive = 0
      }
      await sleep(250)
    }
  }

  // ---------- human behavior engine ----------
  readPause(textLength, speed) {
    const s = SPEED[speed] || SPEED.human
    // Human "reading" pauses scale with content but are capped tight: agents
    // skim, they do not read every byte. 4000ms is already generous.
    const ms = Math.min(4000, Math.max(250, Math.round((textLength || 0) * 12))) * s.read
    return sleep(ms)
  }

  async humanMove(x, y, speed) {
    const s = SPEED[speed] || SPEED.human
    const from = this.mouse
    const distance = Math.hypot(x - from.x, y - from.y)
    const duration = Math.min(1400, Math.max(250, distance * 1.4)) * s.move
    const steps = Math.max(8, Math.round(duration / 16))
    const sway = distance * 0.4
    const cx1 = from.x + (x - from.x) * 0.4 + (Math.random() - 0.5) * sway
    const cy1 = from.y + (y - from.y) * 0.4 + (Math.random() - 0.5) * sway
    const cx2 = from.x + (x - from.x) * 0.6 + (Math.random() - 0.5) * sway
    const cy2 = from.y + (y - from.y) * 0.6 + (Math.random() - 0.5) * sway
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const mt = 1 - t
      const px = mt * mt * mt * from.x + 3 * mt * mt * t * cx1 + 3 * mt * t * t * cx2 + t * t * t * x
      const py = mt * mt * mt * from.y + 3 * mt * mt * t * cy1 + 3 * mt * t * t * cy2 + t * t * t * y
      // Movement micro-steps are cosmetic: a stalled one must not block the
      // task — retry once with the tab re-activated, then move on.
      try {
        await this.cdp('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: Math.round(px), y: Math.round(py), button: 'none', buttons: 0,
        }, 2500)
      } catch (err) {
        await this.activateTab().catch(() => {})
        await this.cdp('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: Math.round(px), y: Math.round(py), button: 'none', buttons: 0,
        }, 2500).catch(() => {})
      }
      await sleep(jitter(14))
    }
    this.mouse = { x, y }
  }

  async keyEvent(spec, type) {
    // CDP wants windowsVirtualKeyCode, not our short `vk` shorthand.
    const params = Object.assign({}, spec)
    if (params.vk !== undefined) {
      params.windowsVirtualKeyCode = params.vk
      params.nativeVirtualKeyCode = params.vk
      delete params.vk
    }
    await this.input('Input.dispatchKeyEvent', Object.assign({ type }, params), 5000)
  }

  async insertText(text) {
    try {
      await this.input('Input.insertText', { text }, 5000)
    } catch (err) {
      // Last resort: set the value through the page (JS fallback).
      await this.evalJs(`(() => { const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(el, el.value + ${JSON.stringify(text)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } })()`)
    }
  }

  /** Press-and-release at a point, with a JS click fallback when CDP input stalls. */
  async pressAt(x, y, dbl = false) {
    const press = async (count) => {
      try {
        await this.input('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: count,
        }, 5000)
        await sleep(rand(50, 120))
        await this.input('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: count,
        }, 5000)
      } catch (err) {
        const hit = await this.evalJs(`(() => {
          const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})
          if (!el) return false
          el.click()
          return true
        })()`)
        if (!hit) throw new Error('click target unreachable (input pipeline stalled)')
      }
    }
    await press(1)
    if (dbl) { await sleep(rand(60, 140)); await press(2) }
  }

  async sendChar(ch) {
    const shifted = SHIFTED.includes(ch)
    const base = shifted && /[A-Z]/.test(ch) ? ch.toLowerCase() : ch
    const code = KEY_CODES[ch]
      || (/^[a-z]$/i.test(ch) ? 'Key' + ch.toUpperCase() : null)
      || (/^[0-9]$/.test(ch) ? 'Digit' + ch : null)
    const vk = ch.charCodeAt(0)
    if (!code) { await this.insertText(ch); return }
    if (shifted) await this.keyEvent({ key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 }, 'keyDown')
    await this.keyEvent({ key: base, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, 'keyDown')
    await this.keyEvent({ key: base, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, 'keyUp')
    if (shifted) await this.keyEvent({ key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 }, 'keyUp')
  }

  typoKey(ch) {
    const lower = ch.toLowerCase()
    if (!NEIGHBOR[lower]) return null
    return NEIGHBOR[lower][Math.floor(Math.random() * NEIGHBOR[lower].length)]
  }

  async typeText(text, speed) {
    const s = SPEED[speed] || SPEED.human
    for (const ch of text) {
      if (Math.random() < 0.02) {
        const wrong = this.typoKey(ch)
        if (wrong) {
          await this.sendChar(wrong)
          await sleep(jitter(s.typeBase[1] + 60))
          await this.keyEvent(SPECIAL_KEYS.Backspace, 'keyDown')
          await this.keyEvent(SPECIAL_KEYS.Backspace, 'keyUp')
          await sleep(jitter(s.typeBase[0]))
        }
      }
      await this.sendChar(ch)
      const base = jitter(rand(s.typeBase[0], s.typeBase[1]))
      const pause = ch === ' ' ? base + jitter(rand(s.typeSpace[0], s.typeSpace[1])) : base
      await sleep(pause)
    }
  }

  // ---------- page operations ----------
  async find(params) {
    const expression = `(() => {
      let el = null
      if (${JSON.stringify(params.selector)}) {
        el = document.querySelector(${JSON.stringify(params.selector)})
        if (!el) return { error: 'selector not found' }
      } else if (${JSON.stringify(params.text)}) {
        const t = ${JSON.stringify(String(params.text).toLowerCase())}
        const clickables = document.querySelectorAll('a,button,input,[role="button"],label,summary,[onclick],select')
        for (const n of clickables) {
          if (String((n.innerText || n.value || '')).trim().toLowerCase().includes(t)) { el = n; break }
        }
        if (!el) {
          for (const n of document.querySelectorAll('span,p,li,td,div,h1,h2,h3,h4')) {
            const txt = (n.innerText || '').trim()
            if (txt && txt.length <= 120 && txt.toLowerCase().includes(t)) { el = n; break }
          }
        }
        if (!el) return { error: 'text not found' }
      }
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return { error: 'element not visible' }
      return {
        x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
        tag: el.tagName, text: String((el.innerText || el.value || '')).trim().slice(0, 80),
      }
    })()`
    const result = await this.evalJs(expression)
    if (result && result.error) throw new Error(result.error)
    return result
  }

  async goto(params) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    this.speed = SPEED[params.speed] ? params.speed : (params.speed || this.speed)
    await this.cdp('Page.navigate', { url: params.url }, 60000)
    await this.waitReadyState(30000)
    const s = SPEED[this.speed] || SPEED.human
    await sleep(jitter(rand(s.settle[0], s.settle[1])))
    const info = await this.evalJs('({ url: location.href, title: document.title, textLength: document.body ? document.body.innerText.length : 0 })')
    // If the destination is a captcha/login barrier, say so explicitly — the
    // agent should ask a human to pass it, then call browser_wait_for_human.
    const barrier = await this.detectBarrier()
    if (barrier.blocked) {
      return {
        url: info.url,
        title: info.title,
        textLength: info.textLength,
        blocked: true,
        blockKind: barrier.kind,
        hint: 'page shows a ' + barrier.kind + ' barrier — ask the user to pass it in the visible window, then call browser_wait_for_human',
      }
    }
    await this.readPause(info.textLength, this.speed)
    return { url: info.url, title: info.title, textLength: info.textLength }
  }

  async search(params) {
    const engine = SEARCH_ENGINES[params.engine || 'baidu']
    if (!engine) throw new Error('unknown engine: ' + params.engine + ' (supported: baidu, bing, google)')
    const query = String(params.query || '').trim()
    if (!query) throw new Error('search query is required')
    let result = await this.goto({ url: engine(query), speed: params.speed })
    // Bing sometimes redirects /search to a JS-rendered home page with no
    // results, or serves a captcha challenge. Detect the barrier first; if the
    // page is just empty, wait for idle, re-read, then retry the explicit
    // search path on cn.bing.com which serves results directly.
    if (!result.blocked && result.textLength < 100) {
      const barrier = await this.detectBarrier()
      if (barrier.blocked) {
        result.blocked = true
        result.blockKind = barrier.kind
        result.hint = 'search engine blocked by a ' + barrier.kind + ' barrier — ask the user to pass it in the visible window, then call browser_wait_for_human'
        return result
      }
      await this.waitForIdle(6000)
      const info = await this.evalJs('({ url: location.href, title: document.title, textLength: document.body ? document.body.innerText.length : 0 })')
      result.textLength = info.textLength
      result.title = info.title
      result.url = info.url
    }
    if (!result.blocked && params.engine === 'bing' && result.textLength < 100) {
      result = await this.goto({ url: 'https://cn.bing.com/search?q=' + encodeURIComponent(query), speed: params.speed })
      if (!result.blocked && result.textLength < 100) {
        const barrier = await this.detectBarrier()
        if (barrier.blocked) {
          result.blocked = true
          result.blockKind = barrier.kind
          result.hint = 'search engine blocked by a ' + barrier.kind + ' barrier — ask the user to pass it in the visible window, then call browser_wait_for_human'
          return result
        }
        await this.waitForIdle(6000)
        const info = await this.evalJs('({ url: location.href, title: document.title, textLength: document.body ? document.body.innerText.length : 0 })')
        result.textLength = info.textLength
        result.title = info.title
        result.url = info.url
      }
    }
    return result
  }
  async extractResultLinks() {
    const expression = `(() => {
      const selectors = ['#b_results h2 a', 'li.b_algo h2 a', '#content_left h3 a', '.result h3 a', '#rso a h3', 'a:has(h3)', '#search h3 a']
      const seen = new Set()
      const out = []
      for (const sel of selectors) {
        let nodes = []
        try { nodes = document.querySelectorAll(sel) } catch {}
        for (const n of nodes) {
          const a = n.tagName === 'A' ? n : n.closest('a')
          if (!a || !a.href) continue
          const href = a.href
          if (/^https?:\\/\\/([^/]*\\.)?(bing|microsoft|baidu|google|msn|so)\\.(com|cn|net|org)/i.test(href)) continue
          if (seen.has(href)) continue
          seen.add(href)
          const title = (n.innerText || a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 120)
          if (!title) continue
          out.push({ title, href })
          if (out.length >= 12) break
        }
        if (out.length >= 12) break
      }
      return out
    })()`
    return await this.evalJs(expression)
  }

  async research(params) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    const engineName = params.engine || 'baidu'
    const engine = SEARCH_ENGINES[engineName]
    if (!engine) throw new Error('unknown engine: ' + engineName + ' (supported: baidu, bing, google)')
    const query = String(params.query || '').trim()
    if (!query) throw new Error('search query is required')
    const count = Math.max(1, Math.min(5, params.results || 3))
    const perSite = Math.max(500, Math.min(20000, params.perSiteLimit || 4000))

    await this.cdp('Page.navigate', { url: engine(query) }, 60000)
    await this.waitReadyState(30000)
    // readyState complete ≠ results rendered: poll until extractable links appear.
    const deadline = Date.now() + 10000
    let links = []
    while (Date.now() < deadline) {
      links = await this.extractResultLinks().catch(() => [])
      if (links.length > 0) break
      await sleep(500)
    }
    if (!links.length) {
      // No links could mean a captcha/login barrier instead of an empty page.
      const barrier = await this.detectBarrier()
      if (barrier.blocked) {
        return {
          query,
          engine: engineName,
          blocked: true,
          blockKind: barrier.kind,
          hint: 'search engine blocked by a ' + barrier.kind + ' barrier — ask the user to pass it in the visible window, then call browser_wait_for_human and retry browser_research',
        }
      }
      throw new Error('search engine returned no extractable result links (blocked or captcha?)')
    }

    const results = []
    for (let i = 0; i < Math.min(count, links.length); i++) {
      const link = links[i]
      try {
        await this.cdp('Page.navigate', { url: link.href }, 30000)
        await this.waitReadyState(20000)
        // Patiently wait for real content: readyState complete ≠ rendered for
        // JS-heavy SPAs. Poll until body text appears or the budget runs out.
        const deadline = Date.now() + 15000
        let info = null
        while (Date.now() < deadline) {
          info = await this.evalJs(`(() => {
            const len = document.body ? document.body.innerText.length : 0
            return {
              url: location.href,
              title: document.title,
              textLength: len,
              text: len > 0 ? (document.body.innerText || '').slice(0, ${perSite}) : '',
            }
          })()`).catch(() => null)
          if (info && info.textLength >= 40) break
          await sleep(400)
        }
        results.push({ title: info.title, url: info.url, textLength: info.textLength, text: info.text })
      } catch (err) {
        results.push({ title: link.title, url: link.href, error: String((err && err.message) || err) })
      }
    }
    return { query, engine: engineName, results }
  }

  async read(params = {}) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    const limit = Math.max(100, Math.min(50000, params.limit || 8000))
    const cap = Math.max(0, Math.min(200, params.elements === false ? 0 : (params.maxElements || 80)))
    let info = await this.evalJs(PAGE_HELPERS + `(() => {
      const text = (document.body && document.body.innerText || '').slice(0, ${limit})
      return {
        url: location.href,
        title: document.title,
        text,
        textLength: document.body ? document.body.innerText.length : 0,
        scrollY: Math.round(window.scrollY),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        elements: ${cap} > 0 ? __hb_elements(${cap}) : [],
      }
    })()`)
    // SPA safety net: a page can be at readyState complete with an empty body
    // (JS frameworks render after network idle). Wait for idle, then re-read.
    if (info.textLength === 0 || info.text.trim().length === 0) {
      await this.waitForIdle(6000)
      info = await this.evalJs(PAGE_HELPERS + `(() => {
        const text = (document.body && document.body.innerText || '').slice(0, ${limit})
        return {
          url: location.href,
          title: document.title,
          text,
          textLength: document.body ? document.body.innerText.length : 0,
          scrollY: Math.round(window.scrollY),
          viewport: { w: window.innerWidth, h: window.innerHeight },
          elements: ${cap} > 0 ? __hb_elements(${cap}) : [],
        }
      })()`)
    }
    const barrier = await this.detectBarrier()
    if (barrier.blocked) {
      return {
        url: info.url,
        title: info.title,
        text: info.text,
        textLength: info.textLength,
        blocked: true,
        blockKind: barrier.kind,
        hint: 'page shows a ' + barrier.kind + ' barrier — ask the user to pass it in the visible window, then call browser_wait_for_human',
      }
    }
    await this.readPause(Math.min(limit, info.textLength), params.speed || this.speed)
    return info
  }

  /**
   * Structured Markdown of the current page — the Firecrawl-style reading mode:
   * wait for network idle, then convert the live DOM to Markdown in-page with
   * optional main-content filtering (drops header/footer/nav/aside/ads).
   */
  async markdown(params = {}) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    if (params.waitIdle !== false) await this.waitForIdle(8000)
    const maxLen = Math.max(500, Math.min(100000, params.limit || 20000))
    const onlyMain = params.onlyMainContent !== false
    const expression = `(() => {
      const out = []
      let budget = ${maxLen}
      const push = (s) => { if (budget <= 0) return; const t = String(s); out.push(t.slice(0, budget)); budget -= t.length }
      const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 500)
      const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'video', 'audio'])
      const MAIN_SKIP = new Set(['header', 'footer', 'nav', 'aside', 'form', '.ad', '.ads', '.advert', '.advertisement', '.banner', '.popup', '.modal', '.cookie', '.share', '.sidebar', '#ad', '#sidebar'])
      const isMainSkip = (el) => {
        if (!el) return false
        if (el.id && MAIN_SKIP.has('#' + el.id.toLowerCase())) return true
        if (typeof el.className === 'string' && el.className.split(/\\s+/).some((c) => MAIN_SKIP.has('.' + c.toLowerCase()))) return true
        return false
      }
      const walk = (node, block) => {
        if (budget <= 0) return
        if (node.nodeType === 3) {
          const t = node.textContent.replace(/\\s+/g, ' ')
          if (block) push(t)
          return
        }
        if (node.nodeType !== 1) return
        const tag = node.tagName.toLowerCase()
        if (SKIP.has(tag)) return
        if (${onlyMain} && isMainSkip(node)) return
        if (${onlyMain} && (tag === 'header' || tag === 'footer' || tag === 'nav' || tag === 'aside')) return
        switch (tag) {
          case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
            const n = Number(tag[1])
            push('\\n' + '#'.repeat(n) + ' ' + text(node) + '\\n\\n')
            return
          }
          case 'p': {
            const t = text(node)
            if (t) push('\\n' + t + '\\n\\n')
            else for (const c of node.childNodes) walk(c, true)
            return
          }
          case 'a': {
            const t = text(node)
            const href = node.href || ''
            if (t && href && !href.startsWith('javascript:')) push('[' + t + '](' + href + ')')
            else push(t)
            return
          }
          case 'strong': case 'b': push('**' + text(node) + '**'); return
          case 'em': case 'i': push('*' + text(node) + '*'); return
          case 'code': push('\`' + text(node) + '\`'); return
          case 'pre': push('\\n\\n\`\`\`\\n' + (node.innerText || '').slice(0, 4000) + '\\n\`\`\`\\n\\n'); return
          case 'blockquote': {
            const t = text(node)
            if (t) push('\\n> ' + t + '\\n\\n')
            return
          }
          case 'li': {
            const t = text(node)
            if (t) push('\\n- ' + t)
            return
          }
          case 'img': {
            const alt = node.alt || ''
            const src = node.currentSrc || node.src || ''
            if (src) push('\\n![' + alt + '](' + src + ')\\n')
            return
          }
          case 'hr': push('\\n---\\n\\n'); return
          case 'br': push('\\n'); return
          case 'table': {
            push('\\n')
            for (const row of node.querySelectorAll('tr')) {
              const cells = Array.from(row.children).map((c) => text(c))
              if (cells.length) push('| ' + cells.join(' | ') + ' |\\n')
            }
            push('\\n')
            return
          }
          case 'div': case 'section': case 'article': case 'main': case 'ul': case 'ol': case 'dl': case 'figure': case 'details': case 'summary': {
            push('\\n')
            for (const c of node.childNodes) walk(c, true)
            return
          }
          default: {
            for (const c of node.childNodes) walk(c, block)
          }
        }
      }
      const root = document.querySelector('main, article, #main, [role="main"]') || document.body
      walk(root, true)
      return { url: location.href, title: document.title, markdown: out.join('').trim(), markdownLength: out.join('').trim().length }
    })()`
    const md = await this.evalJs(expression)
    const barrier = await this.detectBarrier()
    if (barrier.blocked) {
      return {
        url: md.url,
        title: md.title,
        markdown: md.markdown,
        markdownLength: md.markdownLength,
        blocked: true,
        blockKind: barrier.kind,
        hint: 'page shows a ' + barrier.kind + ' barrier — ask the user to pass it in the visible window, then call browser_wait_for_human',
      }
    }
    return md
  }

  /** Run a key→CSS-selector map in-page; return {key: [{text, href?}]}. */
  async extractSelectors(selectors) {
    const defs = JSON.stringify(selectors || {})
    const expression = `(() => {
      const defs = ${defs}
      const out = {}
      for (const key of Object.keys(defs)) {
        let nodes = []
        try { nodes = Array.from(document.querySelectorAll(defs[key])) } catch {}
        out[key] = nodes.slice(0, 200).map((n) => {
          const obj = { text: (n.innerText || n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 300) }
          const a = (n.closest && n.closest('a')) || (n.tagName === 'A' ? n : null)
          if (a && a.href) obj.href = a.href
          return obj
        })
      }
      return out
    })()`
    return await this.evalJs(expression)
  }

  async extract(params = {}) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    const wantText = params.text !== false
    const wantLinks = params.links === true
    const wantImages = params.images === true
    const textLimit = Math.max(100, Math.min(20000, params.textLimit || 4000))
    const expression = `(() => {
      const out = { url: location.href, title: document.title }
      if (${wantText}) out.text = (document.body && document.body.innerText || '').slice(0, ${textLimit})
      if (${wantLinks}) out.links = Array.from(document.querySelectorAll('a[href]')).slice(0, 200).map((a) => ({ text: (a.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80), href: a.href }))
      if (${wantImages}) out.images = Array.from(document.querySelectorAll('img[src]')).slice(0, 100).map((i) => ({ alt: i.alt || '', src: i.src }))
      return out
    })()`
    const info = await this.evalJs(expression)
    if (params.selectors && typeof params.selectors === 'object' && Object.keys(params.selectors).length > 0) {
      info.selectors = await this.extractSelectors(params.selectors)
    }
    return info
  }

  async crawl(params = {}) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    const start = String(params.url || '').trim()
    if (!/^https?:\/\//i.test(start)) throw new Error('crawl url must be http(s)')
    const maxPages = Math.max(1, Math.min(50, params.maxPages || 20))
    const sameOrigin = params.sameOrigin !== false
    const perPage = Math.max(200, Math.min(20000, params.perPageLimit || 3000))
    const selectors = params.selectors && typeof params.selectors === 'object' ? params.selectors : {}
    const startOrigin = new URL(start).origin

    const seen = new Set()
    const queue = [start]
    const pages = []
    while (queue.length > 0 && pages.length < maxPages) {
      const url = queue.shift()
      if (seen.has(url)) continue
      seen.add(url)
      let entry
      try {
        await this.cdp('Page.navigate', { url }, 30000)
        await this.waitReadyState(15000)
        // Patiently wait for real content (JS-heavy pages render after load).
        const deadline = Date.now() + 8000
        let info = null
        while (Date.now() < deadline) {
          info = await this.evalJs(`(() => {
            const len = document.body ? document.body.innerText.length : 0
            return {
              url: location.href,
              title: document.title,
              len,
              text: len > 0 ? (document.body.innerText || '').slice(0, ${perPage}) : '',
              links: Array.from(document.querySelectorAll('a[href]')).slice(0, 300).map((a) => a.href),
            }
          })()`).catch(() => null)
          if (info && info.len >= 20) break
          await sleep(400)
        }
        entry = {
          url: info.url,
          title: info.title,
          textLength: info.len,
          text: info.text,
          links: (info.links || []).filter((href) => /^https?:\/\//i.test(href)),
        }
        if (Object.keys(selectors).length > 0) entry.selectors = await this.extractSelectors(selectors)
      } catch (err) {
        entry = { url, error: String((err && err.message) || err) }
      }
      pages.push(entry)
      // Enqueue same-origin links (queue bounded to stay memory-safe).
      if (entry.links && queue.length < 500) {
        for (const href of entry.links) {
          let u
          try { u = new URL(href) } catch { continue }
          u.hash = ''
          const norm = u.href
          if (sameOrigin && u.origin !== startOrigin) continue
          if (!seen.has(norm) && !queue.includes(norm)) queue.push(norm)
        }
      }
      if (queue.length > 0 && pages.length < maxPages) await sleep(rand(200, 500))
    }

    fs.mkdirSync(CRAWLS_DIR, { recursive: true })
    const slug = (startOrigin.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_') || 'crawl').slice(0, 40)
    const file = path.join(CRAWLS_DIR, 'crawl-' + slug + '-' + Date.now() + '.json')
    const doc = { startedAt: new Date().toISOString(), start, maxPages, sameOrigin, pages }
    fs.writeFileSync(file, JSON.stringify(doc, null, 2))
    return {
      pages: pages.length,
      queuedRemaining: queue.length,
      origin: startOrigin,
      file,
      bytes: fs.statSync(file).size,
    }
  }

  async screenshot(params = {}) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    fs.mkdirSync(SHOTS_DIR, { recursive: true })
    const result = await this.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000)
    const safeName = params.name ? String(params.name).replace(/[^\w.-]/g, '_').slice(0, 40) : ''
    const file = path.join(SHOTS_DIR, 'shot-' + Date.now() + (safeName ? '-' + safeName : '') + '.png')
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
    return { path: file, bytes: fs.statSync(file).size }
  }

  async click(params) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    this.speed = SPEED[params.speed] ? params.speed : (params.speed || this.speed)
    let target
    if (typeof params.x === 'number' && typeof params.y === 'number') {
      target = { x: params.x, y: params.y, text: 'coordinates ' + params.x + ',' + params.y }
    } else {
      target = await this.find(params)
    }
    const s = SPEED[this.speed] || SPEED.human
    await this.humanMove(target.x, target.y, this.speed)
    await sleep(jitter(rand(s.settle[0], s.settle[1])))
    await this.pressAt(target.x, target.y, !!params.dbl)
    await this.followNewTab()
    return { clicked: target.text || target.tag, x: Math.round(target.x), y: Math.round(target.y) }
  }

  async move(params) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    let target
    if (typeof params.x === 'number' && typeof params.y === 'number') {
      target = { x: params.x, y: params.y }
    } else {
      target = await this.find(params)
    }
    await this.humanMove(target.x, target.y, params.speed || this.speed)
    return { x: Math.round(target.x), y: Math.round(target.y) }
  }

  async type(params) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    this.speed = SPEED[params.speed] ? params.speed : (params.speed || this.speed)
    if (params.selector) {
      const target = await this.find({ selector: params.selector })
      await this.humanMove(target.x, target.y, this.speed)
      await this.pressAt(target.x, target.y, false)
      await sleep(jitter(rand(120, 300)))
    } else {
      // Focus safety net: clicking can fail to focus in an unfocused headful
      // window. If no editable element is active, focus the first visible one.
      await this.evalJs(`(() => {
        const el = document.activeElement
        const editable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        if (!editable) {
          const target = document.querySelector('input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [contenteditable=true]')
          if (target) target.focus()
        }
      })()`)
    }
    if (params.clearFirst) {
      await this.evalJs('(() => { const el = document.activeElement; ' +
        'if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { el.focus(); el.select() } })()')
      await this.keyEvent(SPECIAL_KEYS.Backspace, 'keyDown')
      await this.keyEvent(SPECIAL_KEYS.Backspace, 'keyUp')
      await sleep(jitter(rand(120, 300)))
    }
    await this.typeText(String(params.text), this.speed)
    return { typed: String(params.text).length, speed: this.speed }
  }

  async scroll(params = {}) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    const s = SPEED[params.speed] || SPEED.human
    const direction = params.direction === 'up' ? -1 : 1
    const total = (params.distance || 600) * direction
    const steps = Math.max(6, Math.min(16, Math.round(Math.abs(total) / 80)))
    const m = this.mouse
    let wheelStalled = false
    for (let i = 1; i <= steps; i++) {
      const eased = Math.sin((i / steps) * Math.PI * 0.5)
      const delta = Math.round((total / steps) * (0.3 + 1.7 * eased))
      try {
        await this.input('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: m.x, y: m.y, deltaX: 0, deltaY: delta,
        }, 5000)
      } catch (err) {
        // Wheel dispatch is the input most often deferred by Chrome (occluded
        // window / busy compositor). Fall back to scripted scrolling with the
        // same eased pacing — the page still moves like a human scroll.
        wheelStalled = true
        await this.evalJs('window.scrollBy({ top: ' + delta + ', behavior: "auto" })')
      }
      await sleep(jitter(rand(18, 40)))
    }
    await sleep(jitter(rand(200, 500)))
    const pos = await this.evalJs('Math.round(window.scrollY)')
    return { scrolledBy: total, scrollY: pos, fallback: wheelStalled ? 'scripted' : undefined }
  }

  async key(params) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    const spec = SPECIAL_KEYS[params.key]
    if (!spec) throw new Error('unsupported key: ' + params.key + ' — use browser_type for text input')
    await this.keyEvent(spec, 'keyDown')
    await sleep(rand(40, 90))
    await this.keyEvent(spec, 'keyUp')
    return { key: params.key }
  }

  async back() {
    // Newer Chrome removed Page.goBack from CDP; history.back() works everywhere.
    await this.cdp('Runtime.evaluate', { expression: 'history.back()' }, 15000).catch(() => {})
    await this.waitReadyState(30000)
    await sleep(rand(300, 800))
    return { ok: true }
  }

  async forward() {
    await this.cdp('Runtime.evaluate', { expression: 'history.forward()' }, 15000).catch(() => {})
    await this.waitReadyState(30000)
    await sleep(rand(300, 800))
    return { ok: true }
  }

  async reload() {
    await this.cdp('Runtime.evaluate', { expression: 'location.reload()' }, 15000).catch(() => {})
    await this.waitReadyState(30000)
    await sleep(rand(300, 800))
    return { ok: true }
  }

  async wait(params = {}) {
    const ms = Math.min(120000, Math.max(0, params.ms || 1000))
    await sleep(ms)
    return { waitedMs: ms }
  }

  async eval(params) {
    if (!this.running) throw new Error('browser not open — call browser_open first')
    return { result: await this.evalJs(String(params.expression)) }
  }

  async status() {
    if (!this.running) return { open: false, profile: PROFILE_DIR }
    let info = { url: null, title: null }
    try {
      info = await this.evalJs('({ url: location.href, title: document.title })')
    } catch {}
    return {
      open: true,
      pid: this.procPid,
      url: info.url,
      title: info.title,
      speed: this.speed,
      profile: PROFILE_DIR,
    }
  }
}

/** Embeddable line-dispatcher factory. */
function createDriver(write) {
  const log = (text) => write(JSON.stringify({ event: 'log', text: String(text) }))
  const session = new Session(log)
  let chain = Promise.resolve()

  const handle = (line) => {
    let request
    try { request = JSON.parse(line) } catch { return }
    if (!request || typeof request.id !== 'number' || typeof request.method !== 'string') return
    const id = request.id
    const method = request.method
    const params = request.params || {}
    chain = chain.then(async () => {
      let result
      let error
      try {
        if (typeof session[method] !== 'function') throw new Error('unknown method: ' + method)
        result = await session[method](params)
      } catch (err) {
        error = String((err && err.message) || err)
      }
      write(JSON.stringify({ id, ok: !error, result, error: error ? { message: error } : undefined }))
    }).catch((err) => {
      write(JSON.stringify({ id, ok: false, error: { message: String((err && err.message) || err) } }))
    })
  }

  return { handle, session }
}

if (require.main === module) {
  const driver = createDriver((line) => process.stdout.write(line + '\n'))
  process.stdout.write(JSON.stringify({ event: 'ready' }) + '\n')
  const shutdown = () => {
    driver.session.close()
      .catch(() => {})
      .then(() => process.exit(0))
    setTimeout(() => process.exit(0), 6000).unref()
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let request
    try { request = JSON.parse(line) } catch { return }
    driver.handle(line)
    // After a graceful close the driver has nothing left to guard: exit soon
    // so the host-side tree sees real quiescence.
    if (request && request.method === 'close') setTimeout(() => process.exit(0), 2500)
  })
  process.stdin.on('end', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

module.exports = { createDriver, Session }
