'use strict'
/**
 * Full-function verification: exercises every driver method against a local
 * multi-page site + a fake barrier page, plus a live Bing search.
 *   node test-verify.js
 */
const http = require('node:http')
const fs = require('node:fs')
const { createDriver } = require('./browser-driver.js')

const pages = {
  '/': '<html><head><title>Verify Home</title></head><body><h1>Home Page</h1><p class="item">item-one</p><p class="item">item-two</p><a href="/page2">Go to page 2</a><a href="https://example.com/x">external</a><input id="box"><button id="btn">Push me</button></body></html>',
  '/page2': '<html><head><title>Page Two</title></head><body><h1>Second Page</h1><p>hello verify world</p><a href="/page3">Page 3</a><pre>code block here</pre></body></html>',
  '/page3': '<html><head><title>Page Three</title></head><body><h1>Third Page</h1><p>deep content</p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>',
  '/blocked': '<html><head><title>安全验证</title></head><body><p>请完成验证</p><p>拖动滑块</p></body></html>',
}
const server = http.createServer((req, res) => {
  const body = pages[req.url] || '<html><body><h1>404</h1></body></html>'
  res.writeHead(pages[req.url] ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
})

function withDriver(fn) {
  return new Promise((resolve, reject) => {
    let seq = 0
    const pending = new Map()
    const driver = createDriver((line) => {
      let m
      try { m = JSON.parse(line) } catch { return }
      if (m.event === 'log') return
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
    fn(call).then(resolve, reject)
  })
}

const passed = []
async function step(name, fn) {
  process.stdout.write('== ' + name + ' ... ')
  const t0 = Date.now()
  try {
    const r = await fn()
    passed.push(name)
    console.log('PASS (' + (Date.now() - t0) + 'ms) ' + JSON.stringify(r).slice(0, 160))
    return r
  } catch (e) {
    console.log('FAIL: ' + e.message)
    throw e
  }
}

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    await withDriver(async (call) => {
      // 1. open
      await step('open (headful fast)', () => call('open', { speed: 'fast', headless: false }))
      // 2. status
      await step('status', async () => { const r = await call('status', {}); if (!r.open) throw new Error('not open'); return r })
      // 3. goto
      await step('goto /', () => call('goto', { url: base + '/', speed: 'fast' }))
      // 4. read + elements
      await step('read with elements', async () => {
        const r = await call('read', { limit: 2000, speed: 'fast' })
        if (!/Home Page/.test(r.text)) throw new Error('missing heading')
        if (!r.elements.some((e) => e.selector === '#box')) throw new Error('missing #box element')
        return { textLength: r.textLength, elements: r.elements.length }
      })
      // 5. markdown + main-content filter
      await step('markdown structured', async () => {
        const r = await call('markdown', { limit: 4000 })
        if (!/Home Page/.test(r.markdown)) throw new Error('missing heading')
        if (!/item-one/.test(r.markdown)) throw new Error('missing item')
        return { mdLength: r.markdownLength }
      })
      // 6. extract selectors
      await step('extract selectors', async () => {
        const r = await call('extract', { selectors: { items: '.item' }, links: true, text: false })
        if (r.selectors.items.length !== 2) throw new Error('expected 2 items')
        if (r.links.length !== 2) throw new Error('expected 2 links')
        return { items: r.selectors.items.length }
      })
      // 7. click by text (follows new tab? no — same page)
      await step('click button by text', () => call('click', { text: 'Push me', speed: 'fast' }))
      // 8. click link to page2
      await step('click link -> page2', async () => {
        const r = await call('click', { text: 'Go to page 2', speed: 'fast' })
        if (!r.clicked) throw new Error('no click result')
        return r
      })
      await step('verify page2', async () => {
        const r = await call('read', { limit: 500, speed: 'instant' })
        if (!/Second Page/.test(r.text)) throw new Error('not on page2')
        return { url: r.url }
      })
      // 9. type + eval
      await step('type + eval roundtrip', async () => {
        await call('goto', { url: base + '/', speed: 'fast' })
        await call('click', { selector: '#box', speed: 'fast' })
        await call('type', { text: 'hello verify', speed: 'fast' })
        const r = await call('eval', { expression: 'document.getElementById("box").value' })
        if (r.result !== 'hello verify') throw new Error('typed value mismatch: ' + r.result)
        return { value: r.result }
      })
      // 10. scroll + key
      await step('scroll', () => call('scroll', { distance: 200, speed: 'fast' }))
      await step('key Enter', () => call('key', { key: 'Enter' }))
      // 11. back/forward/reload
      await step('back', async () => { const r = await call('back', {}); if (r.ok !== true) throw new Error('back failed'); return r })
      await step('forward', async () => { const r = await call('forward', {}); if (r.ok !== true) throw new Error('forward failed'); return r })
      await step('reload', async () => { const r = await call('reload', {}); if (r.ok !== true) throw new Error('reload failed'); return r })
      // 12. screenshot
      await step('screenshot', async () => { const r = await call('screenshot', { name: 'verify' }); if (!fs.existsSync(r.path)) throw new Error('no file'); return { bytes: r.bytes } })
      // 13. wait
      await step('wait', () => call('wait', { ms: 300 }))
      // 14. crawl 3 pages
      await step('crawl maxPages 3', async () => {
        const r = await call('crawl', { url: base + '/', maxPages: 3, perPageLimit: 800 })
        if (r.pages !== 3) throw new Error('expected 3 pages, got ' + r.pages)
        const doc = JSON.parse(fs.readFileSync(r.file, 'utf8'))
        if (!doc.pages.some((p) => p.url.endsWith('/page3'))) throw new Error('page3 not crawled')
        return { pages: r.pages, bytes: r.bytes }
      })
      // 15. barrier detection + waitForHuman timeout
      await step('goto blocked page', async () => {
        const r = await call('goto', { url: base + '/blocked', speed: 'fast' })
        if (!r.blocked || r.blockKind !== 'captcha') throw new Error('barrier not detected: ' + JSON.stringify(r))
        return { blockKind: r.blockKind }
      })
      await step('waitForHuman times out', async () => {
        const r = await call('waitForHuman', { timeoutMs: 4000 })
        if (r.cleared !== false) throw new Error('expected timeout')
        return { reason: r.reason }
      })
      // 16. clear barrier → waitForHuman returns
      await step('clear + waitForHuman', async () => {
        await call('goto', { url: base + '/page2', speed: 'fast' })
        const r = await call('waitForHuman', { timeoutMs: 10000 })
        if (r.cleared !== true) throw new Error('not cleared')
        return r
      })
      // 17. search (live) — baidu proves the happy path; bing may legitimately
      // serve a captcha, in which case the barrier detection is the feature.
      await step('search baidu', async () => {
        const r = await call('search', { query: 'deepseek', engine: 'baidu', speed: 'fast' })
        if (r.blocked) throw new Error('baidu blocked: ' + r.blockKind)
        if (r.textLength < 100) throw new Error('empty results')
        return { title: r.title, len: r.textLength }
      })
      await step('search bing barrier-aware', async () => {
        const r = await call('search', { query: 'deepseek', engine: 'bing', speed: 'fast' })
        if (r.blocked) {
          // Legitimate: Bing serves a captcha to fresh sessions. Detection works.
          return { blocked: r.blockKind }
        }
        if (r.textLength < 100) throw new Error('empty results without barrier')
        return { title: r.title }
      })
      // 18. close
      await step('close', () => call('close', {}))
      console.log('\nALL ' + passed.length + ' STEPS PASSED')
      process.exit(0)
    })
  } catch (e) {
    console.error('\nVERIFY ABORTED:', e.message)
    process.exit(1)
  } finally {
    server.close()
  }
})
