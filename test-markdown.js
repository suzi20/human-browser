'use strict'
/** Test the new markdown reading mode. */
const { createDriver } = require('./browser-driver.js')

;(async () => {
  let seq = 0
  const pending = new Map()
  const driver = createDriver((line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.ok ? p.resolve(m.result) : p.reject(new Error((m.error && m.error.message) || 'driver error'))
    }
  })
  const call = (method, params = {}, timeoutMs = 120000) => new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { resolve: res, reject: rej })
    setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout ' + method)) }, timeoutMs)
    driver.handle(JSON.stringify({ id, method, params }))
  })
  try {
    await call('open', { speed: 'fast', headless: true })
    await call('goto', { url: 'https://cn.bing.com/search?q=deepseek+harness', speed: 'fast' })
    const md = await call('markdown', { limit: 4000 })
    console.log('URL:', md.url)
    console.log('TITLE:', md.title)
    console.log('MD LENGTH:', md.markdownLength)
    console.log('---MD---')
    console.log(md.markdown.slice(0, 1800))
    console.log('---END---')
    // verify main-content filter dropped nav-ish elements: links with parens ok,
    // but "跳至内容" (bing skip-link) should be gone from main body markdown
    const hasSkip = /跳至内容/.test(md.markdown)
    console.log('skip-link present in main markdown:', hasSkip)
  } catch (err) {
    console.log('ERR:', err.message)
  } finally {
    await call('close', {}).catch(() => {})
  }
  process.exit(0)
})()
