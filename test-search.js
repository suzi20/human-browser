'use strict'
/** Search-flow smoke test: search → read → click a result. node test-search.js */
const { createDriver } = require('./browser-driver.js')

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
    console.log('PASS (' + (Date.now() - started) + 'ms) ' + JSON.stringify(result).slice(0, 200))
    return result
  } catch (err) {
    console.log('FAIL: ' + err.message)
    throw err
  }
}

withDriver(async (call) => {
  await step('open (fast, headful)', () => call('open', { speed: 'fast', headless: false }))
  await step('search baidu "deepseek"', () => call('search', { query: 'deepseek', engine: 'baidu', speed: 'fast' }))
  await step('check for captcha, fall back to bing', async () => {
    const r = await call('read', { limit: 3000, speed: 'fast' })
    if (r.textLength < 50 || /安全验证|captcha/i.test(r.text + ' ' + r.title)) {
      console.log('  baidu served a captcha — falling back to bing')
      const b = await call('search', { query: 'deepseek', engine: 'bing', speed: 'fast' })
      return { engine: 'bing', url: b.url, title: b.title }
    }
    return { engine: 'baidu', url: r.url, title: r.title }
  })
  await step('read results', async () => {
    const r = await call('read', { limit: 3000, speed: 'fast' })
    if (r.textLength < 50) throw new Error('results page looks empty')
    return { title: r.title, textLength: r.textLength, url: r.url }
  })
  await step('click first result link', async () => {
    const r = await call('eval', {
      expression: `(function(){
        const links = Array.from(document.querySelectorAll('h3 a, a[class*="result"], .result a, a.c-title')).slice(0, 1)
        if (links.length === 0) return 'no-link-found'
        const box = links[0].getBoundingClientRect()
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), text: (links[0].innerText || '').slice(0, 60) }
      })()`,
    })
    if (r.result === 'no-link-found') throw new Error('no result links found on page')
    return r.result
  })
  await step('screenshot', () => call('screenshot', { name: 'search' }))
  await step('close', () => call('close', {}))
  console.log('\nALL ' + steps.length + ' SEARCH STEPS PASSED')
  process.exit(0)
}).catch((err) => {
  console.error('\nSEARCH TEST ABORTED:', err.message)
  process.exit(1)
})
