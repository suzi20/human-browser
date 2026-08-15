'use strict'
/**
 * FAIR comparison: firecrawl cloud vs human-browser headful on the same sites.
 * Both sides get the FULL page — our read is NOT truncated this time.
 * Metric: raw text length AND "meaningful content" (length of the largest
 * contiguous text block — proxy for actual article/list content vs chrome).
 */
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createDriver } = require('./browser-driver.js')

const SITES = [
  { name: 'taobao', url: 'https://www.taobao.com/' },
  { name: 'weibo', url: 'https://weibo.com/' },
  { name: 'bilibili', url: 'https://www.bilibili.com/' },
  { name: 'douyin', url: 'https://www.douyin.com/' },
  { name: 'github', url: 'https://github.com/' },
  { name: 'baidu-search', url: 'https://www.baidu.com/s?wd=deepseek' },
]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function meaningful(text) {
  // Longest run of non-whitespace-ish text lines — content body vs chrome.
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  let best = 0
  let cur = 0
  for (const l of lines) {
    if (l.length > 8) { cur += l.length } else { cur = 0 }
    if (cur > best) best = cur
  }
  return best
}

function firecrawlScrape(url) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    execFile('firecrawl', ['scrape', url], { shell: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      const text = String(stdout || '').trim()
      resolve({
        status: err ? 0 : 200,
        textLength: text.length,
        meaningful: meaningful(text),
        ms: Date.now() - t0,
        error: err ? String(err.message).split('\n')[0].slice(0, 100) : undefined,
      })
    })
  })
}

function hbRun(url) {
  return new Promise((resolve) => {
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
    const call = (method, params = {}, timeoutMs = 90000) => new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, { resolve: res, reject: rej })
      setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout ' + method)) }, timeoutMs)
      driver.handle(JSON.stringify({ id, method, params }))
    })
    ;(async () => {
      const t0 = Date.now()
      let result
      try {
        await call('open', { speed: 'fast', headless: false })
        await call('goto', { url, speed: 'fast' })
        // Firecrawl-style reading: network-idle wait + structured markdown.
        const r = await call('markdown', { limit: 50000, onlyMainContent: true })
        result = { status: 200, textLength: r.markdownLength, meaningful: meaningful(r.markdown), ms: Date.now() - t0 }
      } catch (err) {
        result = { error: String((err && err.message) || err).slice(0, 100), ms: Date.now() - t0 }
      } finally {
        try { await call('close', {}) } catch {}
      }
      resolve(result)
    })()
  })
}

async function main() {
  const out = { startedAt: new Date().toISOString(), sites: {} }
  console.log('site             firecrawl                       human-browser headful')
  console.log('                 rawLen  meaning  ms      err    rawLen  meaning  ms      err')
  for (const site of SITES) {
    process.stdout.write(site.name.padEnd(16))
    const fc = await firecrawlScrape(site.url)
    const hb = await hbRun(site.url)
    out.sites[site.name] = { url: site.url, firecrawl: fc, humanBrowser: hb }
    console.log(
      String(fc.textLength).padEnd(7) + String(fc.meaningful).padEnd(8) + String(fc.ms).padEnd(7) + String(fc.error || '').slice(0, 8).padEnd(9)
      + String(hb.textLength).padEnd(7) + String(hb.meaningful).padEnd(8) + String(hb.ms).padEnd(7) + String(hb.error || '').slice(0, 30),
    )
  }
  const file = path.join(__dirname, 'crawls', 'fair-comparison-' + Date.now() + '.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log('\nfull results: ' + file)
}

main().then(() => process.exit(0)).catch((err) => { console.error('FATAL', err); process.exit(1) })
