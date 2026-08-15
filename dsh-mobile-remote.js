/**
 * dsh-mobile-remote — persistent Cordis plugin that spawns the DSH Mobile
 * gateway (dsh-mobile-gateway.js) as a self-healing subprocess and registers
 * the `mobile_status` tool.
 *
 * Canonical source lives in the human-browser repo. A copy is installed at
 * <profile>/node_modules/dsh-mobile-remote/ so preset rows can resolve it
 * with a bare specifier; keep the two in sync.
 */
import { defineTool } from "@deepseek-ai/dsh-tools"
import fs from "node:fs"
import os from "node:os"

const GATEWAY_PATH = 'E:/work/plug/human-browser/dsh-mobile-gateway.js'
const GATEWAY_CWD = 'E:/work/plug/human-browser'
const PIN_FILE = GATEWAY_CWD + '/.mobile-pin'
const PORT = 3081
const TARGET = 'http://127.0.0.1:3080'

function getLanIp() {
  try {
    const candidates = []
    for (const name of Object.keys(os.networkInterfaces())) {
      for (const net of os.networkInterfaces()[name] || []) {
        if (net.family === 'IPv4' && !net.internal) candidates.push(net.address)
      }
    }
    const priv = candidates.find((a) => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(a))
    return priv || candidates[0] || '127.0.0.1'
  } catch { return '127.0.0.1' }
}

function readPinFile() {
  try {
    const existing = fs.readFileSync(PIN_FILE, 'utf8').trim()
    if (/^\d{6}$/.test(existing)) return existing
  } catch {}
  return null
}

function apply(ctx) {
  let state = null
  let starting = null
  let respawnTimer = null

  function log(text) { console.log('[dsh-mobile] ' + text) }

  function gatewayDied(s, reason) {
    if (s.dead) return
    s.dead = true
    let tail = ''
    try {
      const reader = s.handle.collected.stderr && s.handle.collected.stderr.readFrom(0)
      if (reader) tail = reader.text
    } catch {}
    log('gateway exited' + (reason ? ': ' + reason : '') + (tail ? ' — stderr: ' + tail.slice(-500) : ''))
    for (const p of s.pending.values()) p.reject(new Error('mobile gateway exited'))
    s.pending.clear()
    if (state === s) state = null
    if (respawnTimer === null) {
      respawnTimer = ctx.timeout(2000).then(() => {
        respawnTimer = null
        if (state === null) {
          log('respawn after crash')
          ensureGateway().catch((err) => log('respawn failed: ' + String((err && err.message) || err)))
        }
      })
    }
  }

  function ensureGateway() {
    if (state && !state.dead) return Promise.resolve(state)
    if (starting) return starting
    starting = (async () => {
      // Another session may already run the gateway (same port). Adopt it
      // instead of spawning a second process that would EADDRINUSE-loop.
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/')
        if (res.ok) {
          const pin = readPinFile()
          state = { adopted: true, dead: false, pin: pin || '??????', url: 'http://' + getLanIp() + ':' + PORT }
          log('adopted existing gateway on :' + PORT + ' (PIN ' + state.pin + ')')
          return state
        }
      } catch {}
      const nodePath = await ctx.subprocess.resolveExecutable('node')
      const handle = ctx.subprocess.spawn({
        argv: [nodePath, GATEWAY_PATH, '--port', String(PORT)],
        cwd: GATEWAY_CWD,
        env: { DSH_MOBILE_TARGET: TARGET },
        stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 131072 } },
        graceMs: 3000,
      })
      if (handle.pid === -1) throw new Error('failed to spawn mobile gateway')
      const s = { handle, seq: 0, pending: new Map(), dead: false, pin: null, url: null, offset: 0 }
      handle.done.then(
        () => gatewayDied(s),
        (err) => gatewayDied(s, String((err && err.message) || err)),
      )
      const deadline = Date.now() + 10000
      while (Date.now() < deadline && !s.url) {
        try {
          const read = handle.collected.stdout && handle.collected.stdout.readFrom(s.offset)
          if (read && read.text) {
            s.offset = read.nextOffset
            for (const line of read.text.split('\n')) {
              const text = line.trim()
              if (text.startsWith('DSH_MOBILE_PIN=')) s.pin = text.slice('DSH_MOBILE_PIN='.length)
              if (text.startsWith('DSH_MOBILE_URL=')) s.url = text.slice('DSH_MOBILE_URL='.length)
              if (text.startsWith('DSH_MOBILE_READY')) log('gateway ready')
            }
          }
        } catch {}
        if (!s.url) await ctx.timeout(200)
      }
      if (!s.url) { handle.terminate(); throw new Error('mobile gateway did not become ready') }
      state = s
      log('running on ' + s.url + ' (PIN ' + s.pin + ')')
      return s
    })().finally(() => { starting = null })
    return starting
  }

  ctx.tools.register(defineTool({
    name: 'mobile_status',
    description: 'Report the phone-remote access URL and PIN for DeepSeek Harness. When a user wants to operate DSH from their phone, call this and relay the URL + PIN to them: they open the URL on their phone browser and enter the PIN. The phone UI lets them view sessions, chat with the agent, see live updates, and manage background jobs. The gateway self-heals on crash and the PIN persists across restarts.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          running: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          pin: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute() {
      return ensureGateway().then((s) => ({ running: true, url: s.url, pin: s.pin, note: 'open the URL on your phone and enter the PIN' }))
    },
  }))

  ctx.on('dispose', () => {
    if (respawnTimer !== null) { try { respawnTimer.then(() => {}) } catch {} }
    const s = state
    state = null
    if (!s || s.dead) return
    s.dead = true
    try { s.handle.terminate() } catch {}
  })
}

export default {
  name: 'dsh-mobile-remote',
  inject: ['tools', 'subprocess', 'timer'],
  apply,
}
