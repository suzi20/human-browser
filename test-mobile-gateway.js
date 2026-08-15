'use strict'
/** Self-test the gateway in isolation: launch, PIN auth, session.list, SSE open. */
const http = require('node:http')
const { spawn } = require('node:child_process')

const gateway = spawn(process.execPath, [require('node:path').join(__dirname, 'dsh-mobile-gateway.js'), '--port', '3099'], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, DSH_MOBILE_TARGET: 'http://127.0.0.1:3080' },
})

let output = ''
gateway.stdout.on('data', (c) => { output += c.toString('utf8') })

function post(pathname, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port: 3099, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-dsh-token': token } : {}) },
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => resolve({ status: res.statusCode, body: buf }))
    })
    req.on('error', reject)
    req.end(data)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  // Wait for ready
  for (let i = 0; i < 50; i++) {
    if (output.includes('DSH_MOBILE_READY')) break
    await sleep(200)
  }
  console.log('--- gateway banner ---')
  console.log(output.trim())

  // 1. wrong pin → 401
  const bad = await post('/auth', { pin: '000000' })
  console.log('wrong pin:', bad.status, '(expect 401)')

  // 2. correct pin → token
  const pin = output.match(/DSH_MOBILE_PIN=(\d+)/)[1]
  const ok = await post('/auth', { pin })
  console.log('right pin:', ok.status, '(expect 200)')
  const token = JSON.parse(ok.body).token

  // 3. unauthorized api call → 401
  const noauth = await post('/api/session.list', { type: 'client-request', rpcId: 'x', method: 'session.list', payload: {} })
  console.log('api without token:', noauth.status, '(expect 401)')

  // 4. authorized session.list → 200 with real data
  const api = await post('/api/session.list', { type: 'client-request', rpcId: 'x', method: 'session.list', payload: {} }, token)
  console.log('session.list via gateway:', api.status, '(expect 200)')
  const parsed = JSON.parse(api.body)
  console.log('rpc ok:', parsed.result && parsed.result.ok, 'items:', parsed.result && parsed.result.value && parsed.result.value.items && parsed.result.value.items.length)

  // 5. SSE opens (GET with token header — fetch-based EventSource will send it)
  const sse = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 3099, path: '/events', headers: { 'x-dsh-token': token, accept: 'text/event-stream' } }, (res) => {
      res.on('data', (c) => {
        resolve({ status: res.statusCode, chunk: c.toString('utf8').slice(0, 80) })
        res.destroy()
      })
    })
    req.on('error', reject)
    req.end()
  })
  console.log('SSE open:', sse.status, 'first chunk:', JSON.stringify(sse.chunk))

  gateway.kill()
  process.exit(0)
})().catch((e) => { console.error('FAILED', e); gateway.kill(); process.exit(1) })
