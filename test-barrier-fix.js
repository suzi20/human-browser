'use strict'
/** Verify login-wall false-positive fix: content-rich page with 登录/注册 text must NOT be blocked. */
const http = require('node:http')
const { createDriver } = require('./browser-driver.js')

const server = http.createServer((req, res) => {
  const body = req.url === '/rich'
    ? '<html><head><title>完整内容页</title></head><body><h1>文章标题</h1><p>登录/注册 后继续阅读</p><p>' + '正文内容'.repeat(200) + '</p></body></html>'
    : req.url === '/wall'
      ? '<html><head><title>登录墙</title></head><body><p>登录后查看</p><p>扫码登录</p></body></html>'
      : '<html><body>404</body></html>'
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
})

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port
  let seq = 0
  const pending = new Map()
  const d = createDriver((line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.ok ? p.resolve(m.result) : p.reject(new Error((m.error && m.error.message) || 'driver error'))
    }
  })
  const call = (method, params = {}, timeoutMs = 60000) => new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { resolve: res, reject: rej })
    setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout')) }, timeoutMs)
    d.handle(JSON.stringify({ id, method, params }))
  })
  try {
    await call('open', { speed: 'fast', headless: true })
    // 1. rich page with login text in chrome — should NOT be blocked
    const rich = await call('goto', { url: base + '/rich', speed: 'fast' })
    console.log('rich page blocked:', rich.blocked === true, '(expect false)')
    // 2. real login wall with no content — SHOULD be blocked
    const wall = await call('goto', { url: base + '/wall', speed: 'fast' })
    console.log('real wall blocked:', wall.blocked === true, 'kind:', wall.blockKind, '(expect true/login)')
  } catch (e) { console.log('ERR', e.message) }
  try { await call('close', {}) } catch {}
  server.close()
  process.exit(0)
})
