'use strict'
/**
 * Comparative experiment: fetch vs firecrawl-cloud vs human-browser
 * (headless) vs human-browser (headful human mode) on the same URL set.
 * Metrics: status, title, extracted text length, bot-block flag, wall time.
 */
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createDriver } = require('./browser-driver.js')

const SITES = [
  { name: 'taobao', url: 'https://www.taobao.com/' },
  { name: 'jd', url: 'https://www.jd.com/' },
  { name: 'weibo', url: 'https://weibo.com/' },
  { name: 'bilibili', url: 'https://www.bilibili.com/' },
  { name: 'xiaohongshu', url: 'https://www.xiaohongshu.com/' },
  { name: 'douyin', url: 'https://www.douyin.com/' },
  { name: 'github', url: 'https://github.com/' },
  { name: 'zh-wikipedia', url: 'https://zh.wikipedia.org/wiki/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD' },
]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
// Two independent barriers: CAPTCHA = bot-check walls; LOGIN = the site serves
// a login wall instead of content. A site can trigger neither, either, or both.
const CAPTCHA_RE = /安全验证|验证码|人机验证|滑动验证|拖动滑块|请完成验证|访问过于频繁|操作过于频繁|Access Denied|Checking your browser|challenge|verify you are human/i
const LOGIN_RE = /登录后查看|扫码登录|立即登录|登录\/注册|请先登录|登录后才能|打开.*App.*查看/i

function analyze(title, text, status) {
  const head = ((title || '') + ' ' + (text || '').slice(0, 800))
  return {
    status,
    title: String(title || '').slice(0, 40),
    textLength: text ? text.length : 0,
    captcha: CAPTCHA_RE.test(head),
    loginWall: LOGIN_RE.test(head),
  }
}

async function fetchBaseline(url) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      redirect: 'follow',
    })
    const html = await res.text()
    const text = html
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || ''
    return { ...analyze(title, text, res.status), ms: Date.now() - t0, finalUrl: res.url }
  } catch (err) {
    return { error: String((err && err.message) || err).slice(0, 100), ms: Date.now() - t0 }
  }
}

function firecrawlScrape(url) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    execFile('firecrawl', ['scrape', url], { shell: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const text = String(stdout || '').trim()
      resolve({
        ...analyze('', text, err ? 0 : 200),
        ms: Date.now() - t0,
        error: err ? String(err.message).split('\n')[0].slice(0, 100) : undefined,
        stdoutBytes: text.length,
      })
    })
  })
}

function hbRun(url, headless) {
  return new Promise((resolve) => {
    let seq = 0
    const pending = new Map()
    const lines = []
    const driver = createDriver((line) => {
      lines.push(line)
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
        await call('open', { speed: 'fast', headless })
        await call('goto', { url, speed: 'fast' })
        const r = await call('read', { limit: 2000, speed: 'instant' })
        result = { ...analyze(r.title, r.text, 200), ms: Date.now() - t0, finalUrl: r.url }
      } catch (err) {
        result = { error: String((err && err.message) || err).slice(0, 100), ms: Date.now() - t0, tail: lines.slice(-6) }
      } finally {
        // Close FULLY (port dead) before resolving, so the next run never
        // adopts the dying instance of this one.
        try { await call('close', {}) } catch {}
      }
      resolve(result)
    })()
  })
}

async function main() {
  const results = {}
  for (const site of SITES) {
    results[site.name] = { url: site.url }
    process.stdout.write('\n### ' + site.name + '  ' + site.url + '\n')
    const row = results[site.name]

    process.stdout.write('  fetch          ... ')
    row.fetch = await fetchBaseline(site.url)
    console.log(JSON.stringify({ status: row.fetch.status, title: row.fetch.title, textLength: row.fetch.textLength, blocked: row.fetch.blocked, ms: row.fetch.ms, error: row.fetch.error }))

    process.stdout.write('  firecrawl      ... ')
    row.firecrawl = await firecrawlScrape(site.url)
    console.log(JSON.stringify({ status: row.firecrawl.status, textLength: row.firecrawl.textLength, blocked: row.firecrawl.blocked, ms: row.firecrawl.ms, error: row.firecrawl.error }))

    process.stdout.write('  hb-headless    ... ')
    row.hbHeadless = await hbRun(site.url, true)
    console.log(JSON.stringify({ status: row.hbHeadless.status, title: row.hbHeadless.title, textLength: row.hbHeadless.textLength, blocked: row.hbHeadless.blocked, ms: row.hbHeadless.ms, error: row.hbHeadless.error }))

    process.stdout.write('  hb-headful     ... ')
    row.hbHeadful = await hbRun(site.url, false)
    console.log(JSON.stringify({ status: row.hbHeadful.status, title: row.hbHeadful.title, textLength: row.hbHeadful.textLength, blocked: row.hbHeadful.blocked, ms: row.hbHeadful.ms, error: row.hbHeadful.error, tail: row.hbHeadful.tail }))
  }

  const out = path.join(__dirname, 'crawls', 'comparison-' + Date.now() + '.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(results, null, 2))

  console.log('\n\n===== SUMMARY =====')
  const methods = ['fetch', 'firecrawl', 'hbHeadless', 'hbHeadful']
  console.log('site             method         status  textLen  captcha  login  wallMs')
  for (const site of SITES) {
    for (const m of methods) {
      const r = results[site.name][m]
      if (!r) continue
      console.log(
        site.name.padEnd(16)
        + m.padEnd(15)
        + String(r.status ?? '-').padEnd(7)
        + String(r.textLength ?? 0).padEnd(9)
        + String(!!r.captcha).padEnd(8)
        + String(!!r.loginWall).padEnd(6)
        + String(r.ms ?? '-'),
      )
    }
  }
  console.log('\nfull results: ' + out)
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('EXPERIMENT FATAL:', err)
  process.exit(1)
})
