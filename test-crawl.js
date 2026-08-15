'use strict'
/** Crawl + extract smoke test against a local multi-page site. */
const http = require('node:http')
const fs = require('node:fs')
const { createDriver } = require('./browser-driver.js')

// Local 5-page site: /a -> /b,/c -> /d -> /e, plus one external link.
const pages = {
  '/a': '<h1>Page A</h1><a href="/b">B</a> <a href="/c">C</a> <a href="https://example.com/x">external</a><p class="item">item-a1</p><p class="item">item-a2</p>',
  '/b': '<h1>Page B</h1><a href="/d">D</a><p class="item">item-b</p>',
  '/c': '<h1>Page C</h1><a href="/d">D</a>',
  '/d': '<h1>Page D</h1><a href="/e">E</a>',
  '/e': '<h1>Page E</h1>',
}
const server = http.createServer((req, res) => {
  const body = pages[req.url] || '<h1>404</h1>'
  res.writeHead(pages[req.url] ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<html><body>' + body + '</body></html>')
})

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
    const call = (method, params = {}, timeoutMs = 180000) => new Promise((resolve, reject) => {
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

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const base = 'http://127.0.0.1:' + port
  console.log('local site on ' + base)
  try {
    await withDriver(async (call) => {
      console.log('== open (fast, headless) ...')
      await call('open', { speed: 'fast', headless: true })
      console.log('PASS')

      console.log('== extract selectors from /a ...')
      await call('goto', { url: base + '/a', speed: 'instant' })
      const ex = await call('extract', { selectors: { items: '.item' }, links: true, text: false })
      if (ex.selectors.items.length !== 2) throw new Error('expected 2 items, got ' + ex.selectors.items.length)
      if (ex.links.length !== 3) throw new Error('expected 3 links, got ' + ex.links.length)
      console.log('PASS', JSON.stringify({ items: ex.selectors.items, linkCount: ex.links.length }))

      console.log('== crawl maxPages 3 (same-origin) ...')
      const cr = await call('crawl', { url: base + '/a', maxPages: 3, perPageLimit: 800 })
      if (cr.pages !== 3) throw new Error('expected 3 pages, got ' + cr.pages)
      if (!fs.existsSync(cr.file)) throw new Error('crawl file missing: ' + cr.file)
      const doc = JSON.parse(fs.readFileSync(cr.file, 'utf8'))
      const urls = doc.pages.map((p) => p.url)
      if (urls.some((u) => u.includes('example.com'))) throw new Error('external link leaked into crawl')
      if (!urls.some((u) => u.endsWith('/a')) || !urls.some((u) => u.endsWith('/b'))) throw new Error('expected /a and /b in results: ' + urls.join(','))
      console.log('PASS', JSON.stringify({ pages: cr.pages, bytes: cr.bytes, urls }))

      console.log('== close ...')
      await call('close', {})
      console.log('PASS')
      console.log('\nCRAWL TEST OK')
      process.exit(0)
    })
  } catch (err) {
    console.error('FAILED:', err.message)
    process.exit(1)
  } finally {
    server.close()
  }
})
