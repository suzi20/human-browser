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

const BUILD = 'build-20'
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
  if (typeof header === 'string' && tokens.has(header)) return true
  const cookie = req.headers.cookie || ''
  const m = cookie.match(/(?:^|;\s*)dsh_pin=([^;]+)/)
  return !!m && tokens.has(m[1])
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
<meta name="theme-color" content="#dce6f5">
<title>DeepSeek Harness</title>
<script>
/* js-canary (ES5): reports page/script health to the gateway log. */
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
})();
</script>
<style>
/* Palette extracted from the real DeepSeek Harness GUI (light theme). */
:root{--bg:#dce6f5;--surface:#f8f3e8;--surface2:#fff8e8;--surface3:#d7def0;--ink:#172347;--ink2:#0d1a3e;--muted:#405a99;--gold:#f3e3c0;--gold2:#e3c78d;--gold3:#a77c36;--line:#e2d3b4;--line2:#c3cfe8;--err:#a94a3f;--ok:#3f7d54}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
button{appearance:none;-webkit-appearance:none;border:0;background:none;cursor:pointer;font:inherit;color:inherit}
input,textarea{font:inherit;color:var(--ink);border:0;outline:none;background:transparent;width:100%}
.hidden{display:none !important}

#app{display:flex;flex-direction:column;height:100vh;padding-bottom:calc(62px + env(safe-area-inset-bottom,0px))}
.topbar{display:flex;align-items:center;gap:8px;padding:12px 14px 8px;background:linear-gradient(180deg,rgba(248,243,232,.95),rgba(248,243,232,0));position:sticky;top:0;z-index:5}
.topbar .logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--gold),var(--gold2));color:var(--ink);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;box-shadow:0 2px 8px rgba(167,124,54,.25)}
.topbar .ttl{flex:1;font-size:16px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar .act{padding:6px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--line);font-size:12.5px;font-weight:600;color:var(--muted)}
.topbar .act:active{background:var(--gold)}
main{flex:1;overflow:hidden;display:flex;flex-direction:column}
.view{flex:1;overflow-y:auto;padding:6px 14px 16px;-webkit-overflow-scrolling:touch}

/* chat */
#chatLog{display:flex;flex-direction:column;min-height:100%}
.msg{max-width:84%;padding:10px 14px;border-radius:16px;margin:5px 0;white-space:pre-wrap;word-break:break-word;font-size:14.5px;line-height:1.55;animation:rise .22s ease}
@keyframes rise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.msg.user{align-self:flex-end;background:linear-gradient(135deg,var(--gold),var(--gold2));color:var(--ink);border-bottom-right-radius:5px;box-shadow:0 2px 8px rgba(167,124,54,.18)}
.msg.assistant{align-self:flex-start;background:var(--surface);border:1px solid var(--line2);border-bottom-left-radius:5px}
.msg.tool{align-self:flex-start;background:transparent;border:1px dashed var(--line2);color:var(--muted);font-size:12px;font-family:ui-monospace,Consolas,monospace;border-radius:10px;max-width:92%}
.msg.error{align-self:flex-start;background:#f6e3df;border:1px solid #e0b4aa;color:var(--err);border-radius:10px;font-size:13px}
.composer{position:fixed;left:12px;right:12px;bottom:calc(70px + env(safe-area-inset-bottom,0px));display:flex;align-items:flex-end;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:6px 6px 6px 16px;box-shadow:0 4px 20px rgba(23,35,71,.10);z-index:6}
.composer textarea{flex:1;min-height:38px;max-height:110px;padding:9px 0;font-size:15px;line-height:1.4;resize:none}
.send-btn{width:38px;height:38px;border-radius:99px;background:linear-gradient(135deg,var(--gold),var(--gold2));color:var(--ink);font-size:15px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(167,124,54,.28);transition:transform .12s ease}
.send-btn:active{transform:scale(.92)}
.empty{text-align:center;color:var(--muted);padding:44px 10px;font-size:13.5px}
.empty .em{font-size:38px;display:block;margin-bottom:10px}

/* sessions / subagents */
.btn-pill{display:inline-block;padding:9px 14px;border-radius:12px;background:var(--surface);border:1px solid var(--line);font-size:13px;font-weight:600;color:var(--ink);text-align:center;transition:transform .12s ease}
.btn-pill:active{transform:scale(.97);background:var(--gold)}
.btn-pill.primary{background:linear-gradient(135deg,var(--gold),var(--gold2));border:0;color:var(--ink);box-shadow:0 3px 10px rgba(167,124,54,.25)}
.btn-pill.danger{color:var(--err);border-color:#e0b4aa;background:#fdf6f4}
.card{background:var(--surface);border:1px solid var(--line2);border-radius:16px;padding:13px 14px;margin-bottom:10px;box-shadow:0 1px 4px rgba(23,35,71,.05);animation:rise .25s ease}
.card .row{display:flex;align-items:center;gap:10px}
.avatar{width:38px;height:38px;border-radius:12px;flex:0 0 38px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff}
.card .body{flex:1;min-width:0}
.card .line1{display:flex;align-items:center;justify-content:space-between;gap:6px}
.card .name{font-size:14.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700;flex:0 0 auto}
.chip.run{background:var(--gold);color:var(--ink)}
.chip.run::before{content:'';width:6px;height:6px;border-radius:99px;background:var(--gold3);animation:pulse 1.6s infinite}
.chip.idle{background:var(--surface3);color:var(--muted)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.sid{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--muted);word-break:break-all;margin-top:3px}
.card .btns{display:flex;gap:8px;margin-top:11px}
.card .btns .btn-pill{flex:1}

/* bottom tab bar */
.tabbar{position:fixed;left:0;right:0;bottom:0;display:flex;background:rgba(248,243,232,.96);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--line);padding:6px 10px calc(6px + env(safe-area-inset-bottom,0px));z-index:7}
.tab{flex:1;text-align:center;padding:6px 4px;border-radius:12px;font-size:11.5px;color:var(--muted);transition:all .16s ease;user-select:none;-webkit-user-select:none}
.tab .ic{display:block;font-size:19px;margin-bottom:2px}
.tab.on{color:var(--ink);font-weight:700;background:linear-gradient(135deg,var(--gold),var(--gold2))}
.toast{position:fixed;left:50%;bottom:calc(86px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--ink);color:var(--surface2);font-size:13px;padding:9px 16px;border-radius:99px;z-index:20;max-width:86%;text-align:center;box-shadow:0 6px 20px rgba(23,35,71,.25);animation:rise .2s ease}
</style>
</head>
<body>
<div id="app" class="hidden">
  <div class="topbar">
    <div class="logo">D</div>
    <span class="ttl" id="pageTitle">聊天</span>
    <button class="act" id="actStop" onclick="cancelRun()">停止</button>
    <button class="act" onclick="logout()">退出</button>
  </div>
  <main>
    <div id="viewChat" class="view">
      <div id="chatLog"></div>
      <div class="composer">
        <textarea id="chatInput" placeholder="给 agent 发消息…" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}"></textarea>
        <button class="send-btn" onclick="sendMessage()">➤</button>
      </div>
    </div>
    <div id="viewSessions" class="view hidden">
      <button class="btn-pill primary" style="width:100%;margin-bottom:12px" onclick="createSession()">＋ 新建会话</button>
      <div id="sessionList"></div>
    </div>
    <div id="viewTasks" class="view hidden">
      <button class="btn-pill" style="width:100%;margin-bottom:12px" onclick="loadJobs()">⟳ 刷新列表</button>
      <div id="jobList"></div>
    </div>
  </main>
  <nav class="tabbar">
    <div class="tab on" id="tabChat" onclick="showTab('chat')"><span class="ic">💬</span>聊天</div>
    <div class="tab" id="tabSessions" onclick="showTab('sessions')"><span class="ic">🗂</span>会话</div>
    <div class="tab" id="tabTasks" onclick="showTab('tasks')"><span class="ic">🤖</span>子代理</div>
  </nav>
</div>
<script>
function selfLog(msg, extra) {
  try {
    fetch('/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ msg: msg, at: new Date().toISOString(), ua: navigator.userAgent.slice(0, 80) }, extra || {})),
    }).catch(function () {})
  } catch (e) {}
}
selfLog('page-loaded', { href: location.href })

let sessions = []
let currentSession = null

// ---- API client: same JSON-RPC protocol the Web GUI uses (cookie-authed) ----
async function rpc(method, payload = {}) {
  const res = await fetch('/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

function logout() {
  try { document.cookie = 'dsh_pin=; Max-Age=0; Path=/' } catch (e) {}
  location.reload()
}

// ---- tabs ----
const TAB_TITLES = { chat: '聊天', sessions: '会话', tasks: '子代理' }
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'))
  document.getElementById('tab' + name[0].toUpperCase() + name.slice(1)).classList.add('on')
  document.getElementById('viewSessions').classList.toggle('hidden', name !== 'sessions')
  document.getElementById('viewChat').classList.toggle('hidden', name !== 'chat')
  document.getElementById('viewTasks').classList.toggle('hidden', name !== 'tasks')
  document.getElementById('pageTitle').textContent = TAB_TITLES[name] || 'DeepSeek Harness'
  document.getElementById('actStop').style.display = name === 'chat' ? '' : 'none'
  if (name === 'chat') document.getElementById('pageTitle').textContent = currentSession ? currentSession.slice(0, 8) : TAB_TITLES.chat
  if (name === 'sessions') loadSessions()
  if (name === 'tasks') loadJobs()
}

// ---- sessions ----
const AVATAR_COLORS = ['#172347', '#405a99', '#a77c36', '#3f7d54', '#7a5c9e', '#8c4f4f', '#2f6d8c', '#6b5b3f']
function avatarColor(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
function initialOf(name) { return (name || '?').trim().charAt(0).toUpperCase() }

async function loadSessions() {
  try {
    const data = await rpc('session.list', {})
    sessions = (data && data.items) || []
    const list = document.getElementById('sessionList')
    list.innerHTML = ''
    if (!sessions.length) {
      list.innerHTML = '<div class="empty"><span class="em">📭</span>暂无会话<br>点上方"新建会话"开始</div>'
      return
    }
    for (const s of sessions) {
      const preset = s.agentPreset || 'cordis'
      const card = document.createElement('div')
      card.className = 'card'
      card.innerHTML =
        '<div class="row">' +
        '<div class="avatar" style="background:linear-gradient(135deg,' + avatarColor(preset) + ',' + avatarColor(preset) + 'cc)">' + esc(initialOf(preset)) + '</div>' +
        '<div class="body">' +
        '<div class="line1"><span class="name">' + esc(preset) + '</span>' +
        '<span class="chip ' + (s.running ? 'run' : 'idle') + '">' + (s.running ? '进行中' : '空闲') + '</span></div>' +
        '<div class="sid">' + esc(s.sessionId) + '</div>' +
        '</div>' +
        '</div>' +
        '<div class="btns">' +
        '<button class="btn-pill" onclick="openChat(\\'' + esc(s.sessionId) + '\\')">打开</button>' +
        '<button class="btn-pill" onclick="renameSession(\\'' + esc(s.sessionId) + '\\')">重命名</button>' +
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
  document.getElementById('pageTitle').textContent = id.slice(0, 8)
  document.getElementById('chatLog').innerHTML = ''
  showTab('chat')
  try {
    const hist = await rpc('session.history', { sessionId: id, maxMessages: 40 })
    const events = (hist && hist.events) || []
    if (!events.length) {
      document.getElementById('chatLog').innerHTML = '<div class="empty"><span class="em">💬</span>还没有消息<br>在下方输入框发第一条吧</div>'
      return
    }
    for (const e of events) {
      const ev = e && e.event
      if (!ev || !ev.data) continue
      const t = ev.type
      const d = ev.data
      if (t === 'assistant/chunk' || t === 'request/header' || t === 'request/context' || t === 'step/start' || t === 'step/end' || t === 'turn/end' || t === 'finish' || t === 'usage') continue
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
    if (b.type === 'text') parts.push(String(b.text).replace(/\\s+/g, ' ').slice(0, 160))
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
      else if (block.type === 'reasoning') appendBlock('tool', '🧠 ' + String(block.text || '').slice(0, 400))
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
}

// ---- subagents (the GUI exposes no jobs RPC; list current session's children) ----
async function loadJobs() {
  const list = document.getElementById('jobList')
  const parent = currentSession || (sessions.length ? sessions[0].sessionId : '')
  list.innerHTML = '<div class="empty">加载中…</div>'
  if (!parent) { list.innerHTML = '<div class="empty"><span class="em">🤖</span>先打开一个会话<br>这里显示它的子代理</div>'; return }
  try {
    const data = await rpc('subagent.list', { parentSessionId: parent })
    const arr = (data && data.entries) || []
    list.innerHTML = ''
    if (!arr.length) { list.innerHTML = '<div class="empty"><span class="em">🌱</span>暂无子代理</div>'; return }
    for (const a of arr) {
      if (a.kind === 'diagnostic') {
        const c = document.createElement('div')
        c.className = 'card'
        c.textContent = '子代理(异常): ' + (a.reason || '')
        list.appendChild(c)
        continue
      }
      const running = a.activity === 'running'
      const label = a.label || a.id.slice(0, 8)
      const canStop = a.mode === 'continuable' && running
      const stopBtn = canStop
        ? '<button class="btn-pill danger" style="flex:1" onclick="stopSubagent(\\'' + esc(a.id) + '\\')">终止</button>'
        : ''
      const card = document.createElement('div')
      card.className = 'card'
      card.innerHTML =
        '<div class="row">' +
        '<div class="avatar" style="background:linear-gradient(135deg,' + avatarColor(a.mode || 'sub') + ',' + avatarColor(a.mode || 'sub') + 'cc)">' + esc(initialOf(label)) + '</div>' +
        '<div class="body">' +
        '<div class="line1"><span class="name">' + esc(label) + '</span>' +
        '<span class="chip ' + (running ? 'run' : 'idle') + '">' + (running ? '进行中' : '空闲') + '</span></div>' +
        '<div class="sid">' + esc(a.id) + '</div>' +
        '</div>' +
        '</div>' +
        (stopBtn ? '<div class="btns">' + stopBtn + '</div>' : '')
      list.appendChild(card)
    }
  } catch (err) { list.innerHTML = '<div class="empty" style="color:var(--err)">加载子代理失败: ' + esc(err.message) + '</div>' }
}

async function stopSubagent(id) {
  const parent = currentSession || (sessions.length ? sessions[0].sessionId : '')
  if (!parent) return
  try { await rpc('subagent.interrupt', { parentSessionId: parent, childSessionId: id, mode: 'continuable' }); toast('已请求终止'); loadJobs() }
  catch (err) { toast(err.message) }
}

// ---- misc ----
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 2600) }

// ---- boot: chat-first, land in the most relevant session ----
async function enterApp() {
  document.getElementById('app').classList.remove('hidden')
  try {
    await loadSessions()
    const best = sessions.find((s) => s.running) || sessions[0]
    if (best) openChat(best.sessionId)
    else showTab('sessions')
  } catch { showTab('sessions') }
}
enterApp()
try { selfLog('main-ok') } catch (e) {}
</script>
</body>
</html>
`

// ---------------------------------------------------------------------------
// Verbatim-GUI mode: after PIN auth (cookie), every request is proxied to the
// original DSH GUI with its host/origin guard satisfied.
// ---------------------------------------------------------------------------
function proxyToGui(req, res, pathname, search) {
  const url = new URL(pathname + search, TARGET)
  const headers = {}
  for (const key of Object.keys(req.headers)) {
    const lower = key.toLowerCase()
    // The GUI 403s on foreign Host/Origin; http.request sets Host from the
    // target URL, and stripping Origin makes the GUI see a local request.
    if (lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'cookie' || lower === 'x-dsh-token' || lower === 'connection' || lower === 'upgrade' || lower === 'accept-encoding') continue
    headers[key] = req.headers[key]
  }
  if (!headers.accept) headers.accept = 'application/json'
  const targetReq = http.request(
    url,
    { method: req.method, headers },
    (targetRes) => {
      const out = {
        'content-type': targetRes.headers['content-type'] || 'application/json',
      }
      if (targetRes.headers['cache-control']) out['cache-control'] = targetRes.headers['cache-control']
      if (targetRes.headers.etag) out.etag = targetRes.headers.etag
      res.writeHead(targetRes.statusCode || 500, out)
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
// Minimal PIN page served to unauthenticated visitors in verbatim-GUI mode.
// ---------------------------------------------------------------------------
const PIN_UI = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f5f6f8">
<title>DSH Remote</title>
<script>
/* js-canary (ES5): reports page/script health to the gateway log. */
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
    if (err) err.textContent = '页面脚本未运行'
  }
})();
</script>
<style>
:root{--bg:#dce6f5;--border:#c3cfe8;--text:#172347;--muted:#405a99;--gold:#f3e3c0;--gold2:#e3c78d;--err:#a94a3f}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:28px;-webkit-font-smoothing:antialiased}
.pin-card{width:100%;max-width:340px;text-align:center}
.pin-logo{width:64px;height:64px;border-radius:20px;margin:0 auto 18px;background:linear-gradient(135deg,var(--gold),var(--gold2));display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800;color:var(--text);box-shadow:0 10px 28px rgba(167,124,54,.35)}
h1{font-size:21px;font-weight:700;margin-bottom:6px}
.sub{font-size:13px;color:var(--muted);margin-bottom:26px;line-height:1.5}
.pin-input-wrap{background:#f8f3e8;border:1px solid var(--border);border-radius:14px;padding:4px 14px;margin-bottom:14px;box-shadow:0 2px 8px rgba(23,35,71,.06)}
input{font:inherit;color:var(--text);border:0;outline:none;background:transparent;width:100%;text-align:center;letter-spacing:10px;font-size:24px;font-weight:700;height:52px}
.pin-btn{width:100%;height:50px;border-radius:14px;background:linear-gradient(135deg,var(--gold),var(--gold2));color:var(--text);font-size:16px;font-weight:700;border:0;box-shadow:0 6px 18px rgba(167,124,54,.3);transition:transform .12s ease,filter .12s ease;cursor:pointer}
.pin-btn:active{transform:scale(.97);filter:brightness(1.06)}
.pin-btn:disabled{opacity:.6}
.pin-err{color:var(--err);font-size:13px;margin-top:10px;min-height:18px}
.pin-build{color:#9aa8c8;font-size:11px;margin-top:12px}
</style>
</head>
<body>
<div class="pin-card">
  <div class="pin-logo">D</div>
  <h1>DSH Remote</h1>
  <p class="sub">输入 PIN 码访问 DeepSeek Harness<br>通过后即为电脑上的原版界面（已适配手机）</p>
  <div class="pin-input-wrap"><input id="pinInput" inputmode="numeric" maxlength="6" placeholder="PIN 码" autocomplete="off"></div>
  <button class="pin-btn" onclick="__dsbSafeSubmit()">进入</button>
  <p class="pin-err" id="pinErr"></p>
  <p class="pin-build">build-20</p>
</div>
<script>
function selfLog(msg, extra) {
  try {
    fetch('/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ msg: msg, at: new Date().toISOString(), ua: navigator.userAgent.slice(0, 80) }, extra || {})),
    }).catch(function () {})
  } catch (e) {}
}
selfLog('page-loaded', { href: location.href, build: 'build-20' })
async function submitPin() {
  selfLog('submit-clicked')
  var btn = document.querySelector('.pin-btn')
  var err = document.getElementById('pinErr')
  var pin = document.getElementById('pinInput').value.trim()
  err.textContent = ''
  if (!pin) { err.textContent = '请输入 PIN 码'; return }
  btn.disabled = true
  btn.textContent = '验证中…'
  try {
    var res = await fetch('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: pin }) })
    selfLog('auth-response', { status: res.status })
    if (res.ok) { location.reload() } else { err.textContent = 'PIN 错误，请重新输入' }
  } catch (e) {
    selfLog('auth-error', { error: String(e && e.message ? e.message : e) })
    err.textContent = '连接失败: ' + (e && e.message ? e.message : String(e))
  } finally {
    btn.disabled = false
    btn.textContent = '进入'
  }
}
document.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitPin() })
try { selfLog('main-ok') } catch (e) {}
</script>
</body>
</html>`

// ---------------------------------------------------------------------------
// Phone-only micro tweaks injected into the served original GUI. Nothing here
// affects desktop: every rule is scoped to narrow viewports. The GUI already
// collapses its sidebar to an icon rail on phones; these fix the remaining
// mobile papercuts (iOS focus zoom, tap flash, rail width, text scaling).
// ---------------------------------------------------------------------------
const MOBILE_TWEAK_CSS = `
/* DeepSeek-app layout for phones: full-screen conversation, sidebar and
   details slide in as overlay drawers (toggle via the GUI's own buttons).
   Matches the GUI's narrow-mode threshold (SIDEBAR_AUTO_COLLAPSE = 1024). */
@media (max-width: 1024px) {
  .cr-nOG_frame { grid-template-columns: minmax(0, 1fr) 0px 0px !important; }
  .cr-nOG_sidebarCol, .cr-nOG_detailsCol {
    position: absolute !important;
    top: 0; bottom: 0;
    z-index: 30;
    transition: transform var(--ds-transition-duration-slow, .25s) ease;
  }
  .cr-nOG_sidebarCol {
    left: 0;
    width: min(84vw, 320px) !important;
    transform: translateX(-105%);
    box-shadow: 8px 0 24px rgba(13, 26, 62, .18);
  }
  .cr-nOG_detailsCol {
    right: 0;
    width: min(88vw, 360px) !important;
    transform: translateX(105%);
    box-shadow: -8px 0 24px rgba(13, 26, 62, .18);
  }
  .cr-nOG_frame:not([data-sidebar-collapsed]) .cr-nOG_sidebarCol { transform: none; }
  .cr-nOG_frame:not([data-details-collapsed]) .cr-nOG_detailsCol { transform: none; }
  /* Drag handles are pointless on a touch drawer. */
  .cr-nOG_handle { display: none !important; }
  /* Floating menu button (injected): opens/closes the sidebar drawer. Uses the
     GUI's own design tokens so it follows light/dark themes. */
  #dsh-mobile-menu-btn {
    display: none;
    position: fixed;
    top: calc(8px + env(safe-area-inset-top, 0px));
    left: 10px;
    z-index: 60;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: var(--dsw-alias-button-floating-fill, rgba(248, 243, 232, .92));
    color: inherit;
    border: 1px solid var(--dsw-alias-border-l1, rgba(23, 35, 71, .14));
    box-shadow: 0 4px 14px rgba(13, 26, 62, .18);
    font-size: 19px;
    line-height: 1;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    transition: left var(--ds-transition-duration-slow, .25s) ease;
  }
  @media (max-width: 1024px) {
    #dsh-mobile-menu-btn { display: flex; }
  }
  /* When the drawer is open, slide the button next to its edge. */
  body:has(.cr-nOG_frame:not([data-sidebar-collapsed])) #dsh-mobile-menu-btn {
    left: calc(min(84vw, 320px) + 10px);
  }
}
@media (max-width: 820px) {
  html, body { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  * { -webkit-tap-highlight-color: transparent; }
  /* iOS zooms into inputs smaller than 16px on focus; pin them. */
  input, textarea, select { font-size: 16px !important; }
  /* Kill double-tap zoom near controls and accidental text selection. */
  button, a, [role="button"] { touch-action: manipulation; -webkit-user-select: none; user-select: none; }
  /* Tap-target adaptation: keep the visual size, expand the invisible hit
     area of the GUI's small controls (36x36 icon buttons and 28px pills,
     measured at a 390px viewport). Class names are per-build; see
     probe-gui-tap.js to re-measure after a DSH upgrade. */
  button { position: relative; }
  .V-ZVia_iconButton::after, .V-ZVia_newSession::after,
  .okXF1G_iconButton::after, .okXF1G_searchButton::after,
  .farI7q_badge::after, .AJ4KZa_trigger::after, .sr18yW_close::after,
  .ij-XLW_workspace::after, .xc2WqG_seat::after,
  [class*="iconButton"]::after {
    content: '';
    position: absolute;
    inset: -6px;
    border-radius: inherit;
  }
}
`

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

  // 1. PIN gate: on success, drop a session cookie and reload into the GUI.
  if (pathname === '/auth' && req.method === 'POST') {
    let parsed = {}
    try {
      const raw = (await readBody(req)).toString('utf8')
      parsed = raw ? JSON.parse(raw) : {}
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad request body: ' + (e && e.message ? e.message : String(e)) }))
      return
    }
    if (parsed.pin === PIN) {
      const token = issueToken()
      res.setHeader('set-cookie', 'dsh_pin=' + token + '; Path=/; Max-Age=2592000; SameSite=Lax')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } else {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad pin' }))
    }
    return
  }

  // 2. Cookie check (the GUI is served verbatim; browsers carry the cookie
  //    on every request including assets and EventSource).
  const allowed = authorized(req)
  if (!allowed) {
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PIN_UI)
      return
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  // 3. Root serves the ORIGINAL GUI verbatim, with phone-only micro tweaks
  //    injected. /desktop is raw verbatim (no injection); /mobile is the
  //    hand-built mobile app shell; everything else (assets, api, ws) proxies.
  if (pathname === '/' || pathname === '/index.html') {
    try {
      const guiRes = await fetch(TARGET + '/')
      let html = await guiRes.text()
      if (html.includes('</head>')) {
        html = html.replace('</head>', '<style id="dsh-mobile-tweaks">' + MOBILE_TWEAK_CSS + '</style><script id="dsh-mobile-menu">(function(){function findToggle(){return document.querySelector(".V-ZVia_toggle")||document.querySelector(".AJ4KZa_trigger")}var btn=document.createElement("button");btn.id="dsh-mobile-menu-btn";btn.type="button";btn.textContent="\\u2630";btn.setAttribute("aria-label","\\u4f1a\\u8bdd\\u5217\\u8868");btn.addEventListener("click",function(){var t=findToggle();if(t)t.click()});(function wait(){if(document.body)document.body.appendChild(btn);else setTimeout(wait,50)})()})();</script></head>')
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'gateway cannot reach DSH GUI: ' + (err && err.message ? err.message : String(err)) }))
    }
    return
  }
  if (pathname === '/desktop') {
    proxyToGui(req, res, '/', url.search)
    return
  }
  if (pathname === '/mobile') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(UI)
    return
  }
  proxyToGui(req, res, pathname, url.search)
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('DSH_MOBILE_READY')
  console.log('DSH_MOBILE_URL=http://' + getLanIp() + ':' + PORT)
  console.log('DSH_MOBILE_PIN=' + PIN)
  console.log('DSH_MOBILE_BUILD=' + BUILD)
  logf('[gateway]', 'listening on :' + PORT + ' (build ' + BUILD + ')')
})

// WebSocket upgrade proxy: the GUI's live-update channel (e.g. /api/events.mux)
// is a WebSocket, so tunnel upgrades through with the same cookie auth + header
// rewrite as the HTTP proxy.
server.on('upgrade', (req, socket, head) => {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const targetUrl = new URL(req.url, TARGET)
  const headers = {}
  for (const key of Object.keys(req.headers)) {
    const lower = key.toLowerCase()
    if (lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'cookie' || lower === 'x-dsh-token') continue
    headers[key] = req.headers[key]
  }
  const proxyReq = http.request({
    host: targetUrl.hostname,
    port: targetUrl.port,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers,
  })
  proxyReq.on('upgrade', (proxyRes, proxySocket) => {
    const rawHead = ['HTTP/1.1 101 Switching Protocols']
    for (const key of Object.keys(proxyRes.headers)) rawHead.push(key + ': ' + proxyRes.headers[key])
    socket.write(rawHead.join('\r\n') + '\r\n\r\n')
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
  })
  proxyReq.on('error', () => socket.destroy())
  proxyReq.end()
  if (head && head.length) proxyReq.write(head)
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
