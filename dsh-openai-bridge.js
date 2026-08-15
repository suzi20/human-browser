'use strict'
/**
 * dsh-openai-bridge — zero-dependency OpenAI-compatible bridge to DeepSeek
 * Harness. Lets mature chat frontends (LobeChat, NextChat, ...) talk to a DSH
 * agent through the standard /v1 API.
 *
 *   node dsh-openai-bridge.js [--port 3082]
 *   env: DSH_TARGET (default http://127.0.0.1:3080), DSH_OPENAI_KEY (default dsh-mobile)
 *
 * Endpoints:
 *   GET  /v1/models             -> model list
 *   POST /v1/chat/completions   -> JSON or SSE stream
 *
 * Each request creates a fresh DSH session, replays the full message
 * transcript as one prompt (stateless OpenAI semantics; the frontend owns
 * conversation history), then streams the assistant's text deltas back.
 */

const http = require('node:http')

const PORT = parseInt(process.argv[process.argv.indexOf('--port') + 1] || process.env.DSH_OPENAI_PORT || '3082', 10)
const TARGET = process.env.DSH_TARGET || 'http://127.0.0.1:3080'
const API_KEY = process.env.DSH_OPENAI_KEY || 'dsh-mobile'

const STREAM_POLL_MS = 350
const STREAM_IDLE_MS = 25000
const STREAM_HARD_MS = 600000
const STATIC_MODELS = [
  { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
  { id: 'deepseek-v4', object: 'model', owned_by: 'deepseek' },
  { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
  { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
]

function logf(text) { console.log('[' + new Date().toISOString() + '] [bridge] ' + text) }

// ---- DSH JSON-RPC client -------------------------------------------------
let rpcSeq = 0
async function rpc(method, payload = {}) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'bridge-' + (++rpcSeq), method, payload })
  const res = await fetch(TARGET + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { throw new Error(method + ': non-JSON response (' + res.status + '): ' + text.slice(0, 160)) }
  if (!res.ok || !data.result || data.result.ok !== true) {
    const err = data.result && data.result.error
    throw new Error(method + ': ' + (err && err.message ? err.message : JSON.stringify(err || data).slice(0, 200)))
  }
  return data.result.value
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ---- message conversion --------------------------------------------------
function partText(part) {
  if (typeof part === 'string') return part
  if (part && typeof part.text === 'string') return part.text
  if (part && Array.isArray(part.content)) return part.content.map(partText).join('\n')
  return ''
}

function buildPrompt(messages) {
  const lines = []
  for (const m of messages || []) {
    const role = m.role || 'user'
    const text = partText(m.content)
    if (!text) continue
    if (role === 'system') lines.push('【系统指令】\n' + text)
    else lines.push((role === 'assistant' ? '助手：' : '用户：') + text)
  }
  if (!lines.length) return ''
  return lines.join('\n\n') + '\n\n请直接回复最新一条用户消息。'
}

// ---- one completion ------------------------------------------------------
async function runCompletion(req, res, body, stream) {
  const messages = body.messages || []
  const prompt = buildPrompt(messages)
  if (!prompt) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'empty prompt' } })); return }

  const created = await rpc('session.create', {})
  const sessionId = created && created.sessionId
  if (!sessionId) throw new Error('session.create returned no sessionId')

  // Name the session after the first user line so the DSH sessions tab stays readable.
  const firstUser = messages.find((m) => m.role === 'user')
  const title = partText(firstUser && firstUser.content).replace(/\s+/g, ' ').slice(0, 16)
  if (title) { try { await rpc('session.rename', { sessionId, title }) } catch {} }

  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] })

  // Poll the fresh session's event log from the beginning; all events belong
  // to this turn. Emit reasoning + text deltas; finish at turn/end (or the
  // assembled assistant message as a fallback).
  let lastSeq = 0
  let emitted = ''
  let finalText = null
  let finished = false
  let lastActivity = Date.now()
  const started = Date.now()

  const sse = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n')
  const chunk = (delta, reasoning) => sse({
    id: 'chatcmpl-' + sessionId.slice(0, 8),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'dsh',
    choices: [{
      index: 0,
      delta: reasoning ? { reasoning_content: delta } : { content: delta },
      finish_reason: null,
    }],
  })

  while (!finished) {
    let events = []
    try {
      // beforeSeq pages BACKWARD (seq < beforeSeq), so always fetch the tail
      // and filter out already-seen seqs client-side.
      const hist = await rpc('session.history', { sessionId, maxMessages: 500 })
      events = ((hist && hist.events) || []).filter((e) => !(e.event && typeof e.event.seq === 'number' && e.event.seq <= lastSeq))
    } catch (err) {
      logf('history poll error: ' + err.message)
    }
    let sawFinal = false
    for (const e of events) {
      const ev = e && e.event
      if (!ev || !ev.data) continue
      if (typeof ev.seq === 'number' && ev.seq > lastSeq) lastSeq = ev.seq
      lastActivity = Date.now()
      const t = ev.type
      const d = ev.data
      if (t === 'assistant/chunk' && d.chunk) {
        const ct = d.chunk.type
        if (ct === 'text-delta' && typeof d.chunk.text === 'string') {
          if (d.chunk.text) {
            emitted += d.chunk.text
            if (stream) chunk(d.chunk.text, false)
          }
        } else if (ct === 'reasoning-delta' && stream && typeof d.chunk.text === 'string') {
          chunk(d.chunk.text, true)
        }
      } else if (t === 'assistant/message' && d.message) {
        sawFinal = true
        const blocks = (d.message.content || [])
        finalText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
      } else if (t === 'turn/end' || t === 'finish') {
        sawFinal = true
      }
    }
    if (sawFinal) {
      // Flush any tail the deltas missed.
      if (stream && finalText && finalText.length > emitted.length && finalText.startsWith(emitted)) {
        const tail = finalText.slice(emitted.length)
        if (tail) chunk(tail, false)
      }
      finished = true
      break
    }
    if (Date.now() - lastActivity > STREAM_IDLE_MS) { logf('idle timeout for ' + sessionId); finished = true }
    if (Date.now() - started > STREAM_HARD_MS) { logf('hard timeout for ' + sessionId); finished = true }
    if (!finished) await delay(STREAM_POLL_MS)
  }

  // Non-stream: prefer the assembled final message (authoritative), else the
  // accumulated deltas. Streaming already flushed deltas to the client.
  const text = finalText !== null && finalText.length >= emitted.length ? finalText : emitted
  return { sessionId, text }
}

// ---- HTTP server ---------------------------------------------------------
function authorized(req) {
  const header = req.headers.authorization || ''
  const queryKey = new URL(req.url, 'http://localhost').searchParams.get('api_key')
  const got = header.startsWith('Bearer ') ? header.slice(7) : queryKey
  return got === API_KEY
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type, authorization')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    if (pathname === '/health' || pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('dsh-openai-bridge OK on :' + PORT)
      return
    }

    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      return
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      let models = STATIC_MODELS
      try {
        const list = await rpc('session.list', {})
        const first = (list && list.items && list.items[0]) || {}
        const cat = await rpc('llm.models', { sessionId: first.sessionId })
        const groups = (cat && cat.groups) || []
        const ids = []
        for (const g of groups) for (const m of (g.models || [])) if (m && m.id) ids.push(m.id)
        if (ids.length) models = ids.map((id) => ({ id, object: 'model', owned_by: 'dsh' }))
      } catch (err) { logf('llm.models unavailable, using static list: ' + err.message) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: models }))
      return
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = {} }
      const stream = body.stream === true || body.stream === 'true'
      res.writeHead(200, {
        'content-type': stream ? 'text/event-stream' : 'application/json',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (stream) res.write(': connected\n\n')
      const { text } = await runCompletion(req, res, body, stream)
      if (stream) {
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        const usage = { prompt_tokens: Math.ceil(buildPrompt(body.messages || []).length / 4), completion_tokens: Math.ceil(text.length / 4), total_tokens: 0 }
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
        res.end(JSON.stringify({
          id: 'chatcmpl-bridge',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'dsh',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage,
        }))
      }
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  } catch (err) {
    logf('request error: ' + err.message)
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: err.message } }))
      } else {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    } catch {}
  }
})

server.listen(PORT, '0.0.0.0', () => {
  logf('listening on :' + PORT + ' -> ' + TARGET + ' (key: ' + API_KEY + ')')
})
