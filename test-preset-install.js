'use strict'
/** Smoke-test the INSTALLED preset copy of the driver + its profile. */
const { createDriver } = require('C:/Users/34941/.dsh/.agent-presets/cordis-browser/plugins/human-browser/driver.js')

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

withDriver(async (call) => {
  console.log('== open (fast, headless) ...')
  const opened = await call('open', { speed: 'fast', headless: true })
  console.log('PASS', JSON.stringify(opened).slice(0, 120))
  console.log('== research bing x1 ...')
  const r = await call('research', { query: 'cordis 插件 开发', engine: 'bing', results: 1, perSiteLimit: 800 })
  if (r.results.length !== 1 || r.results[0].error || !r.results[0].text) throw new Error('research failed: ' + JSON.stringify(r).slice(0, 200))
  console.log('PASS', JSON.stringify({ title: r.results[0].title.slice(0, 40), textLength: r.results[0].textLength }))
  console.log('== close ...')
  await call('close', {})
  console.log('PASS')
  console.log('\nINSTALLED PRESET DRIVER OK')
  process.exit(0)
}).catch((err) => {
  console.error('FAILED:', err.message)
  process.exit(1)
})
