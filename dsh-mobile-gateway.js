'use strict'
/**
 * dsh-mobile-gateway — zero-dependency LAN gateway that lets a phone operate
 * DeepSeek Harness through the existing Web GUI API.
 *
 *   node dsh-mobile-gateway.js [--port 3081] [--target http://127.0.0.1:3080]
 *
 * Responsibilities:
 *  - Serve the mobile UI at / (single-page, PWA-style).
 *  - PIN-based first-access auth (token in localStorage + server side map).
 *  - Reverse-proxy POST /api/* and GET /api/events.* to the local GUI, so the
 *    phone speaks the exact same JSON-RPC + SSE protocol as the browser.
 *  - Broadcast SSE frames to all connected phones (live messages/notifications).
 *
 * Zero npm dependencies: node:http, node:https, node:fs only.
 */

const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const BUILD = 'build-9'
const LOG_FILE = path.join(__dirname, 'gateway.log')

// Durable log: every line also lands in gateway.log so the agent can read what
// the phone actually sent even when the plugin's collected stdout is gone.
function logf(prefix, text) {
  const line = '[' + new Date().toISOString() + '] ' + prefix + ' ' + text
  console.log(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
}

const PORT = parseInt(process.argv[process.argv.indexOf('--port') + 1] || process.env.DSH_MOBILE_PORT || '3081', 10)
const TARGET = process.env.DSH_MOBILE_TARGET || 'http://127.0.0.1:3080'
const PIN_FILE = process.env.DSH_MOBILE_PIN_FILE || (require('node:path').join(__dirname, '.mobile-pin'))

// ---------------------------------------------------------------------------
// PIN auth. The PIN is persisted so a gateway respawn keeps the same code
// (the phone is never locked out by a restart). Override with DSH_MOBILE_PIN.
// Tokens are random and kept in memory only.
// ---------------------------------------------------------------------------
function loadPin() {
  if (process.env.DSH_MOBILE_PIN) return process.env.DSH_MOBILE_PIN
  try {
    const existing = fs.readFileSync(PIN_FILE, 'utf8').trim()
    if (/^\d{6}$/.test(existing)) return existing
  } catch {}
  const fresh = String(Math.floor(100000 + Math.random() * 900000))
  try { fs.writeFileSync(PIN_FILE, fresh, { encoding: 'utf8' }) } catch {}
  return fresh
}
const PIN = loadPin()
const tokens = new Set()

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex')
  tokens.add(token)
  return token
}

function authorized(req) {
  const header = req.headers['x-dsh-token']
  return typeof header === 'string' && tokens.has(header)
}

// ---------------------------------------------------------------------------
// Tiny JSON body reader
// ---------------------------------------------------------------------------
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Reverse proxy to the local DSH GUI (same-origin /api protocol).
// ---------------------------------------------------------------------------
function proxy(req, res, pathname, search) {
  const url = new URL(pathname + search, TARGET)
  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    accept: req.headers.accept || 'application/json',
  }
  const targetReq = http.request(
    url,
    { method: req.method, headers },
    (targetRes) => {
      res.writeHead(targetRes.statusCode || 500, {
        'content-type': targetRes.headers['content-type'] || 'application/json',
      })
      targetRes.pipe(res)
    },
  )
  targetReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'gateway cannot reach DSH GUI: ' + err.message }))
  })
  req.pipe(targetReq)
}

// ---------------------------------------------------------------------------
// SSE fan-out: phones subscribe to live host frames; every frame is broadcast.
// ---------------------------------------------------------------------------
const phones = new Set() // { res }

function broadcastSSE(frame) {
  const data = typeof frame === 'string' ? frame : JSON.stringify(frame)
  for (const phone of phones) {
    try { phone.res.write('data: ' + data + '\n\n') } catch { phones.delete(phone) }
  }
}

function subscribeSSE(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write(': connected\n\n')
  const phone = { res }
  phones.add(phone)
  res.on('close', () => phones.delete(phone))
}

// ---------------------------------------------------------------------------
// The mobile UI — single page, self-contained.
// ---------------------------------------------------------------------------
const UI = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<title>DSH Mobile</title>
<script>
/* js-canary (ES5): runs before the main script so we can see, from the
   gateway log, whether the phone browser executes ANY JavaScript at all. */
window.__dsbCanary = true;
(function () {
  function report(msg, extra) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/log', true);
      x.setRequestHeader('content-type', 'application/json');
      x.send(JSON.stringify({ msg: msg, at: new Date().toISOString(), ua: (navigator.userAgent || '').slice(0, 120), extra: extra || null }));
    } catch (e) {}
  }
  report('js-canary');
  window.addEventListener('error', function (e) {
    report('js-error', { error: String((e && e.message) || e), line: (e && e.lineno) || 0 });
  });
  window.__dsbSafeSubmit = function () {
    if (typeof window.submitPin === 'function') { window.submitPin(); return }
    report('submit-missing')
    var err = document.getElementById('pinErr')
    if (err) err.textContent = '页面脚本未运行（浏览器可能拦截了脚本）'
    try { alert('页面脚本未运行，请检查浏览器是否拦截脚本') } catch (e2) {}
  }
})();
</script>
<style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#2f81f7;--ok:#3fb950;--warn:#d29922;--err:#f85149}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:12px;padding-bottom:80px}
h1{font-size:18px;margin:4px 0 12px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer}
.btn.ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn.danger{background:var(--err)}
input,select,textarea{background:#0d1117;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px;font-size:14px;width:100%}
textarea{min-height:70px;resize:vertical}
.msg{padding:8px 10px;border-radius:8px;margin:6px 0;background:#0d1117;border:1px solid var(--border);white-space:pre-wrap;word-break:break-word}
.msg.user{border-left:3px solid var(--accent)}
.msg.assistant{border-left:3px solid var(--ok)}
.msg.tool{border-left:3px solid var(--warn);font-size:12px;color:var(--muted)}
.msg.error{border-left:3px solid var(--err)}
.meta{font-size:11px;color:var(--muted);margin-top:2px}
.tabs{display:flex;gap:8px;margin-bottom:12px;position:sticky;top:0;background:var(--bg);padding:6px 0;z-index:5}
.tab{flex:1;text-align:center;padding:8px;border-radius:8px;border:1px solid var(--border);cursor:pointer;background:var(--panel)}
.tab.on{background:var(--accent);border-color:var(--accent);color:#fff}
.badge{display:inline-block;background:var(--err);color:#fff;border-radius:99px;font-size:11px;padding:1px 7px;margin-left:6px}
.hidden{display:none}
#pinGate{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:99;padding:24px}
#pinGate .card{width:100%;max-width:340px}
.notice{background:#1f2937;border:1px solid var(--border);border-radius:8px;padding:8px;font-size:12px;color:var(--muted);margin-bottom:8px}
</style>
</head>
<body>
<div id="pinGate"><div class="card">
  <h1>DSH Mobile 连接</h1>
  <p class="notice">输入电脑上显示的 6 位 PIN 码以连接 DeepSeek Harness。</p>
  <input id="pinInput" inputmode="numeric" maxlength="6" placeholder="PIN 码">
  <br><br>
  <button class="btn" style="width:100%" onclick="__dsbSafeSubmit()">连接</button>
  <p class="meta" id="pinErr" style="color:var(--err);margin-top:8px"></p>
  <p class="meta" style="margin-top:10px;text-align:center">build-9</p>
</div></div>

<div id="app" class="hidden">
  <div class="row" style="justify-content:space-between">
    <h1>DSH Mobile</h1>
    <button class="btn ghost" style="padding:4px 10px;font-size:12px" onclick="logout()">退出</button>
  </div>
  <div class="tabs">
    <div class="tab on" id="tabSessions" onclick="showTab('sessions')">会话</div>
    <div class="tab" id="tabChat" onclick="showTab('chat')">聊天</div>
    <div class="tab" id="tabTasks" onclick="showTab('tasks')">任务</div>
  </div>

  <div id="viewSessions">
    <button class="btn" style="width:100%;margin-bottom:10px" onclick="createSession()">＋ 新建会话</button>
    <div id="sessionList"></div>
  </div>

  <div id="viewChat" class="hidden">
    <div class="row" style="justify-content:space-between;margin-bottom:8px">
      <span id="chatTitle" style="font-weight:600">选择会话</span>
      <button class="btn ghost" style="padding:4px 10px;font-size:12px" onclick="cancelRun()">停止</button>
    </div>
    <div id="chatLog" style="max-height:52vh;overflow-y:auto"></div>
    <div class="row" style="margin-top:8px">
      <textarea id="chatInput" placeholder="给 agent 发消息…" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}"></textarea>
      <button class="btn" onclick="sendMessage()">发送</button>
    </div>
  </div>

  <div id="viewTasks" class="hidden">
    <button class="btn ghost" style="width:100%;margin-bottom:10px" onclick="loadJobs()">刷新任务</button>
    <div id="jobList"></div>
  </div>
</div>

<script>
// Storage that never throws (privacy modes block localStorage entirely).
const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
  del(k) { try { localStorage.removeItem(k) } catch {} },
}
// Phone-side diagnostics: report to the gateway log so the agent can see what
// the phone did (page loaded? click reached? fetch failed?).
function selfLog(msg, extra) {
  try {
    fetch('/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ msg, at: new Date().toISOString(), ua: navigator.userAgent.slice(0, 80) }, extra || {})),
    }).catch(() => {})
  } catch {}
}
selfLog('page-loaded', { href: location.href, build: 'build-9' })

let token = store.get('dshMobileToken') || ''
let sessions = []
let currentSession = null

// ---- API client: same JSON-RPC protocol the Web GUI uses ----
async function rpc(method, payload = {}) {
  const res = await fetch('/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify({ type: 'client-request', rpcId: cryptoRandomUUID(), method, payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (data.error ? JSON.stringify(data.error) : res.statusText))
  if (!data.result || data.result.ok !== true) throw new Error(JSON.stringify((data.result && data.result.error) || data))
  return data.result.value
}
function cryptoRandomUUID() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ---- PIN gate ----
async function submitPin() {
  selfLog('submit-clicked')
  const btn = document.querySelector('#pinGate .btn')
  const err = document.getElementById('pinErr')
  const pin = document.getElementById('pinInput').value.trim()
  err.textContent = ''
  if (!pin) { err.textContent = '请输入 PIN 码'; return }
  btn.disabled = true
  btn.textContent = '连接中…'
  try {
    const res = await fetch('/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
    selfLog('auth-response', { status: res.status })
    if (res.ok) {
      const data = await res.json()
      token = data.token
      store.set('dshMobileToken', token)
      enterApp()
    } else {
      err.textContent = 'PIN 错误，请重新输入'
    }
  } catch (e) {
    selfLog('auth-error', { error: String(e && e.message ? e.message : e) })
    err.textContent = '连接失败: ' + (e && e.message ? e.message : String(e))
  } finally {
    btn.disabled = false
    btn.textContent = '连接'
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.getElementById('pinGate') && !document.getElementById('pinGate').classList.contains('hidden')) submitPin()
})
// Surface any unexpected script error on the PIN gate so a dead page is visible.
window.addEventListener('error', (e) => {
  selfLog('page-error', { error: String(e && e.message ? e.message : e) })
  const err = document.getElementById('pinErr')
  if (err) err.textContent = '页面脚本错误: ' + (e && e.message ? e.message : 'unknown')
})
function logout() { store.del('dshMobileToken'); location.reload() }

// ---- tabs ----
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'))
  document.getElementById('tab' + name[0].toUpperCase() + name.slice(1)).classList.add('on')
  document.getElementById('viewSessions').classList.toggle('hidden', name !== 'sessions')
  document.getElementById('viewChat').classList.toggle('hidden', name !== 'chat')
  document.getElementById('viewTasks').classList.toggle('hidden', name !== 'tasks')
  if (name === 'sessions') loadSessions()
  if (name === 'tasks') loadJobs()
}

// ---- sessions ----
async function loadSessions() {
  try {
    const data = await rpc('session.list', {})
    sessions = (data && data.items) || []
    const list = document.getElementById('sessionList')
    list.innerHTML = ''
    if (!sessions.length) { list.innerHTML = '<div class="meta">暂无会话</div>'; return }
    for (const s of sessions) {
      const card = document.createElement('div')
      card.className = 'card'
      card.innerHTML = '<div class="row" style="justify-content:space-between">' +
        '<b>' + esc(s.agentPreset || 'cordis') + '</b>' +
        '<span class="meta">' + (s.running ? '● 运行中' : '○ 空闲') + '</span></div>' +
        '<div class="meta">' + esc(s.sessionId) + '</div>' +
        '<div class="row" style="margin-top:8px">' +
        '<button class="btn ghost" style="flex:1" onclick="openChat(\\'' + esc(s.sessionId) + '\\')">打开</button>' +
        '<button class="btn ghost" style="flex:1" onclick="renameSession(\\'' + esc(s.sessionId) + '\\')">重命名</button>' +
        '</div>'
      list.appendChild(card)
    }
  } catch (err) { toast('加载会话失败: ' + err.message) }
}

async function createSession() {
  try {
    const created = await rpc('session.create', {})
    await loadSessions()
    if (created && created.sessionId) openChat(created.sessionId)
    else toast('已创建')
  } catch (err) { toast('创建失败: ' + err.message) }
}

async function renameSession(id) {
  const name = prompt('新标题')
  if (!name) return
  try { await rpc('session.rename', { sessionId: id, title: name }); loadSessions() } catch (err) { toast(err.message) }
}

// ---- chat ----
async function openChat(id) {
  currentSession = id
  document.getElementById('chatTitle').textContent = '会话 ' + id.slice(0, 8)
  document.getElementById('chatLog').innerHTML = ''
  showTab('chat')
  try {
    const hist = await rpc('session.history', { sessionId: id, maxMessages: 40 })
    const events = (hist && hist.events) || []
    if (!events.length) { appendBlock('tool', '暂无消息'); return }
    for (const e of events) {
      const ev = e && e.event
      if (!ev || !ev.data) continue
      const t = ev.type
      const d = ev.data
      if (t === 'assistant/chunk' || t === 'request/header' || t === 'step/start' || t === 'step/end') continue
      if (d.message && (d.message.role === 'user' || d.message.role === 'assistant')) {
        appendMessage({ role: d.message.role, content: d.message.content })
      } else if (t === 'tool/call') {
        appendBlock('tool', '🔧 ' + (d.name || 'tool') + ' ' + String(d.arguments || '').slice(0, 160))
      } else if (d.message && d.message.source) {
        appendBlock('tool', '📦 ' + summarizeBlocks(d.message.content))
      }
    }
    if (hist.hasMore) appendBlock('tool', '…… 更早的消息未加载')
  } catch (err) { appendBlock('error', '加载历史失败: ' + err.message) }
}

function summarizeBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (b.type === 'text') parts.push(String(b.text).replace(/\s+/g, ' ').slice(0, 160))
    else parts.push('[' + b.type + ']')
  }
  return parts.join(' ').slice(0, 200)
}

async function sendMessage() {
  const input = document.getElementById('chatInput')
  const text = input.value.trim()
  if (!text || !currentSession) return
  input.value = ''
  appendBlock('user', text)
  try {
    await rpc('session.prompt', { sessionId: currentSession, mode: 'queue', content: [{ type: 'text', text }] })
  } catch (err) { appendBlock('error', '发送失败: ' + err.message) }
}

async function cancelRun() {
  if (!currentSession) return
  try { await rpc('session.cancel', { sessionId: currentSession }); appendBlock('tool', '已请求停止') }
  catch (err) { appendBlock('error', '取消失败: ' + err.message) }
}

function appendMessage(m) {
  const role = m.role || 'assistant'
  const content = m.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') appendBlock(role, block.text)
      else if (block.type === 'tool-call') appendBlock('tool', '🔧 ' + (block.name || 'tool') + ' ' + JSON.stringify(block.arguments || '').slice(0, 200))
      else if (block.type === 'tool-result') appendBlock('tool', '📦 ' + JSON.stringify(block).slice(0, 200))
      else appendBlock('tool', block.type + ' ' + JSON.stringify(block).slice(0, 200))
    }
  } else if (content) {
    appendBlock(role, typeof content === 'string' ? content : JSON.stringify(content))
  }
}

function appendBlock(role, text) {
  const log = document.getElementById('chatLog')
  const div = document.createElement('div')
  div.className = 'msg ' + (role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : role === 'error' ? 'error' : 'tool')
  div.textContent = String(text).slice(0, 6000)
  log.appendChild(div)
  log.scrollTop = log.scrollHeight
  notify(String(text).slice(0, 80))
}

// ---- jobs / tasks: the GUI exposes no jobs RPC, so this tab lists the
// subagents of the current session (subagent.list) with interrupt controls.
async function loadJobs() {
  const list = document.getElementById('jobList')
  const parent = currentSession || (sessions.length ? sessions[0].sessionId : '')
  list.innerHTML = '<div class="meta">加载中…</div>'
  if (!parent) { list.innerHTML = '<div class="meta">先打开一个会话，这里显示它的子代理</div>'; return }
  try {
    const data = await rpc('subagent.list', { parentSessionId: parent })
    const arr = (data && data.entries) || []
    list.innerHTML = ''
    if (!arr.length) { list.innerHTML = '<div class="meta">暂无子代理</div>'; return }
    for (const a of arr) {
      if (a.kind === 'diagnostic') {
        list.appendChild(card('子代理(异常)', '<div class="meta">' + esc(a.reason || '') + '</div>', ''))
        continue
      }
      const running = a.activity === 'running'
      const label = a.label || a.id.slice(0, 8)
      const canStop = a.mode === 'continuable' && running
      const stopBtn = canStop
        ? '<button class="btn danger" style="margin-top:6px" onclick="stopSubagent(\\'' + esc(a.id) + '\\')">终止</button>'
        : ''
      list.appendChild(card(esc(label), '<div class="meta">' + (running ? '● 运行中' : '○ 空闲') + ' · ' + esc(a.id) + '</div>', stopBtn))
    }
  } catch (err) { list.innerHTML = '<div class="meta" style="color:var(--err)">加载子代理失败: ' + esc(err.message) + '</div>' }
}

function card(title, metaHtml, buttonsHtml) {
  const div = document.createElement('div')
  div.className = 'card'
  div.innerHTML = '<div class="row" style="justify-content:space-between"><b>' + title + '</b></div>' +
    metaHtml + (buttonsHtml ? '<div class="row">' + buttonsHtml + '</div>' : '')
  return div
}

async function stopSubagent(id) {
  const parent = currentSession || (sessions.length ? sessions[0].sessionId : '')
  if (!parent) return
  try { await rpc('subagent.interrupt', { parentSessionId: parent, childSessionId: id, mode: 'continuable' }); toast('已请求终止'); loadJobs() }
  catch (err) { toast(err.message) }
}

// ---- live SSE: realtime messages + notifications ----
function connectEvents() {
  const es = new EventSource('/events?token=' + encodeURIComponent(token))
  es.onmessage = (ev) => {
    try {
      const frame = JSON.parse(ev.data)
      const payload = frame.payload || frame
      const sid = payload.sessionId || (payload.session && payload.session.id)
      if (sid && currentSession && sid === currentSession) {
        if (payload.type === 'message' || payload.message) appendMessage(payload.message || payload)
        else if (payload.text) appendBlock('assistant', payload.text)
      }
      if (payload.type === 'message' || payload.type === 'tool') notify('会话更新')
    } catch {}
  }
  es.onerror = () => { /* EventSource auto-reconnects */ }
}

// ---- misc ----
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function toast(t) { const d = document.createElement('div'); d.className = 'notice'; d.textContent = t; document.body.prepend(d); setTimeout(() => d.remove(), 3000) }
function notify(text) {
  if (document.visibilityState === 'visible') return
  try { if (Notification.permission === 'granted') new Notification('DSH Mobile', { body: text }) } catch {}
}

async function enterApp() {
  document.getElementById('pinGate').classList.add('hidden')
  document.getElementById('app').classList.remove('hidden')
  loadSessions()
  connectEvents()
  try { if (Notification.permission === 'default') Notification.requestPermission() } catch {}
}

// boot
(async () => {
  if (!token) return
  try {
    const check = await fetch('/auth/check', { headers: { 'x-dsh-token': token } })
    if (check.ok) { enterApp(); return }
  } catch {}
  store.del('dshMobileToken')
})()
try { selfLog('main-ok') } catch (e) {}
</script>
</body>
</html>`

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // Force no-store on every response so a phone never serves a cached old UI.
  const origWriteHead = res.writeHead.bind(res)
  res.writeHead = (code, headers) => {
    if (headers && !Array.isArray(headers)) {
      headers['cache-control'] = 'no-store, no-cache, must-revalidate, max-age=0'
      headers['pragma'] = 'no-cache'
      headers['expires'] = '0'
    }
    return origWriteHead(code, headers)
  }
  try {
    await handle(req, res)
  } catch (err) {
    // Never let one bad request kill the gateway.
    logf('[gateway]', 'request error: ' + (err && err.message ? err.message : String(err)))
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'gateway error: ' + (err && err.message ? err.message : String(err)) }))
      } else {
        res.end()
      }
    } catch {}
  }
})

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname
  // Request log: every hit lands in gateway.log + plugin stdout so the agent
  // can see what the phone is actually sending.
  logf('[gateway]', req.method + ' ' + pathname + ' from ' + (req.socket.remoteAddress || '?'))

// ---------------------------------------------------------------------------
// Request log + phone-side diagnostics: UI calls POST /log so the agent can
// see from the gateway's collected stdout what the phone actually did.
// ---------------------------------------------------------------------------
if (pathname === '/log' && req.method === 'POST') {
  let parsed = {}
  try {
    const raw = (await readBody(req)).toString('utf8')
    parsed = raw ? JSON.parse(raw) : {}
  } catch {}
  logf('[phone]', JSON.stringify(parsed))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  return
}

// Browsers always request /favicon.ico; answer quietly instead of 401 noise.
if (pathname === '/favicon.ico') {
  res.writeHead(204)
  res.end()
  return
}

  // 1. PIN gate
  if (pathname === '/auth' && req.method === 'POST') {    let parsed = {}
    try {
      const raw = (await readBody(req)).toString('utf8')
      parsed = raw ? JSON.parse(raw) : {}
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad request body: ' + (e && e.message ? e.message : String(e)) }))
      return
    }
    if (parsed.pin === PIN) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token: issueToken() }))
    } else {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad pin' }))
    }
    return
  }

  // 2. token check. /events may carry the token in the query string because
  // EventSource cannot set headers; everything else requires the header.
  const queryToken = url.searchParams.get('token')
  const allowed = authorized(req) || (pathname === '/events' && queryToken && tokens.has(queryToken))
  if (pathname === '/auth/check') {
    res.writeHead(allowed ? 200 : 401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: allowed }))
    return
  }
  if (!allowed) {
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(UI)
      return
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  // 3. SSE event bridge (authorized above).
  if (pathname === '/events') {
    subscribeSSE(res)
    return
  }

  // 4. API reverse proxy
  if (pathname.startsWith('/api/')) {
    proxy(req, res, pathname, url.search)
    return
  }

  // 5. UI root
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(UI)
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('DSH_MOBILE_READY')
  console.log('DSH_MOBILE_URL=http://' + getLanIp() + ':' + PORT)
  console.log('DSH_MOBILE_PIN=' + PIN)
  console.log('DSH_MOBILE_BUILD=' + BUILD)
  logf('[gateway]', 'listening on :' + PORT + ' (build ' + BUILD + ')')
})

function getLanIp() {
  try {
    const os = require('node:os')
    const nets = os.networkInterfaces()
    const candidates = []
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) candidates.push(net.address)
      }
    }
    // Prefer a private-range address (10/8, 172.16/12, 192.168/16) over
    // link-local APIPA (169.254/16) or other networks.
    const privateIp = candidates.find((ip) => /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip))
    return privateIp || candidates[0] || '127.0.0.1'
  } catch {}
  return '127.0.0.1'
}

// Keep the event fan-out alive: SSE responses are held open by design.
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
