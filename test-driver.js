'use strict'
/**
 * Standalone smoke test for browser-driver.js — runs the engine in-process
 * (no stdio pipes), drives the real Chrome, and prints a PASS/FAIL report.
 *
 *   node test-driver.js [headful]
 *
 * Defaults to headless for an unobtrusive run; pass `headful` to watch the
 * visible window behave like a person.
 */
const fs = require('node:fs')
const { createDriver } = require('./browser-driver.js')

const headful = process.argv.includes('headful')

function withDriver(fn) {
  return new Promise((resolve, reject) => {
    let seq = 0
    const pending = new Map()
    const driver = createDriver((line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.event === 'log') { console.log('[driver]', message.text); return }
      if (typeof message.id === 'number' && pending.has(message.id)) {
        const p = pending.get(message.id)
        pending.delete(message.id)
        if (message.ok) p.resolve(message.result)
        else p.reject(new Error((message.error && message.error.message) || 'driver error'))
      }
    })
    const call = (method, params = {}, timeoutMs = 120000) => new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error('timeout: ' + method))
      }, timeoutMs)
      driver.handle(JSON.stringify({ id, method, params }))
    })
    fn(call).then(resolve, reject)
  })
}

const steps = []
async function step(name, fn) {
  process.stdout.write('== ' + name + ' ... ')
  const started = Date.now()
  try {
    const result = await fn()
    steps.push(name)
    console.log('PASS (' + (Date.now() - started) + 'ms) ' + JSON.stringify(result).slice(0, 220))
    return result
  } catch (err) {
    console.log('FAIL: ' + err.message)
    throw err
  }
}

withDriver(async (call) => {
  await step('open (speed=fast)', () => call('open', { speed: 'fast', headless: !headful }))
  await step('goto data:text input page', () => call('goto', {
    url: 'data:text/html,<html><body><h1>Hello Human</h1><input id="box"><button id="btn">Push me</button><p>done</p></body></html>',
    speed: 'fast',
  }))
  await step('read page text', async () => {
    const r = await call('read', { limit: 2000, speed: 'fast' })
    if (!/Hello Human/.test(r.text)) throw new Error('expected heading missing')
    return { title: r.title, textLength: r.textLength }
  })
  await step('click input by selector', () => call('click', { selector: '#box', speed: 'fast' }))
  await step('type human text', () => call('type', { text: 'hello world', speed: 'fast' }))
  await step('verify typed value via eval', async () => {
    const r = await call('eval', { expression: 'document.getElementById("box").value' })
    if (r.result !== 'hello world') throw new Error('got: ' + JSON.stringify(r.result))
    return { value: r.result }
  })
  await step('click button by text', () => call('click', { text: 'Push me', speed: 'fast' }))
  await step('scroll', () => call('scroll', { distance: 300, speed: 'fast' }))
  await step('key Enter', () => call('key', { key: 'Enter' }))
  await step('screenshot', async () => {
    const r = await call('screenshot', { name: 'smoke' })
    if (!fs.existsSync(r.path)) throw new Error('screenshot file missing: ' + r.path)
    return { path: r.path, bytes: r.bytes }
  })
  await step('goto example.com', () => call('goto', { url: 'https://example.com/', speed: 'fast' }))
  await step('goto example.org', () => call('goto', { url: 'https://example.org/', speed: 'fast' }))
  await step('back + status', async () => {
    const back = await call('back', {})
    if (back.ok !== true) throw new Error('back failed: ' + JSON.stringify(back))
    const r = await call('status', {})
    if (!r.open) throw new Error('browser reported closed')
    if (!/example\.com/.test(r.url || '')) throw new Error('expected example.com after back, got ' + r.url)
    return { url: r.url, speed: r.speed }
  })
  await step('close', () => call('close', {}))

  console.log('\nALL ' + steps.length + ' STEPS PASSED')
  process.exit(0)
}).catch((err) => {
  console.error('\nTEST ABORTED:', err.message)
  process.exit(1)
})
