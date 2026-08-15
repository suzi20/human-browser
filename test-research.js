'use strict'
/** Research + structured read smoke test. node test-research.js */
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
    const call = (method, params = {}, timeoutMs = 240000) => new Promise((resolve, reject) => {
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
  await step('open (fast, headless)', () => call('open', { speed: 'fast', headless: true }))
  await step('research bing "deepseek 多智能体" x2', async () => {
    const r = await call('research', { query: 'deepseek 多智能体', engine: 'bing', results: 2, perSiteLimit: 1500, speed: 'fast' })
    if (r.results.length !== 2) throw new Error('expected 2 results, got ' + r.results.length)
    for (const res of r.results) {
      if (res.error) throw new Error('result error: ' + res.error)
      if (!res.text || res.text.length < 100) throw new Error('result text too short: ' + (res.text || '').length)
    }
    return { count: r.results.length, titles: r.results.map((x) => x.title.slice(0, 30)) }
  })
  await step('structured read elements', async () => {
    const r = await call('read', { limit: 500, speed: 'fast', elements: true, maxElements: 40 })
    if (!Array.isArray(r.elements) || r.elements.length === 0) throw new Error('no interactive elements returned')
    const el = r.elements.find((e) => e.selector)
    if (!el) throw new Error('elements missing selectors')
    return { elementCount: r.elements.length, sample: { text: el.text, selector: el.selector, x: el.x, y: el.y } }
  })
  await step('click using returned selector', async () => {
    const r = await call('read', { limit: 100, speed: 'fast', maxElements: 20 })
    const link = r.elements.find((e) => e.tag === 'a')
    if (!link) throw new Error('no link element found to click')
    await call('click', { selector: link.selector, speed: 'fast' })
    return { clickedSelector: link.selector }
  })
  await step('close', () => call('close', {}))
  console.log('\nALL ' + steps.length + ' RESEARCH STEPS PASSED')
  process.exit(0)
}).catch((err) => {
  console.error('\nRESEARCH TEST ABORTED:', err.message)
  process.exit(1)
})
