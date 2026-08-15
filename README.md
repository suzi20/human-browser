# human-browser

A from-scratch, zero-dependency Chrome DevTools Protocol engine that drives the
**real Chrome** on your machine like a human — natural mouse curves,
variable-speed typing (with typos that get corrected), eased scrolling, reading
pauses — at real-person speed. A persistent profile means cookies, logins and
history survive across sessions, exactly like a real person's browser.

Built as a DSH/Cordis agent plugin: it exposes `browser_*` model tools so an
agent can search the web, open websites, read pages, crawl sites and act on
login-walled content on its own.

## Why this exists

Headless automation gets caught. Measured in this repo's comparison
experiments:

| Target | plain fetch | headless Chrome | this engine (headful) |
| --- | --- | --- | --- |
| Baidu search | captcha | captcha | **passes** |
| Douyin | empty page | captcha page | **passes** |
| Xiaohongshu | empty shell | "security limit" | **passes** (login wall) |
| Weibo | visitor-system wall | ok | **passes** |

A visible real Chrome window with a persistent profile and human pacing is the
strongest locally available anti-detection. It is not a captcha solver — when
a site demands a human, the plugin pauses and lets the user pass it in the
visible window, then continues automatically (`browser_wait_for_human`).

## Features

- **Zero dependencies**: Node ≥ 22 built-ins only (global `WebSocket`, `fetch`).
- **Human behavior engine**: bezier mouse paths with sway, per-key typing
  rhythm with typo correction, eased wheel scrolling, content-proportional
  reading pauses. Speed profiles: `human` (default), `fast`, `instant`.
- **Stealth**: `--disable-blink-features=AutomationControlled`, init script
  hiding `navigator.webdriver`, restoring `window.chrome`, natural
  plugins/languages/WebGL fingerprint, canvas noise, `cdc_` global cleanup,
  battery parity.
- **Persistent identity**: dedicated Chrome user-data-dir — log in once,
  stay logged in forever.
- **Resilience**: input stalls auto-retry after tab re-activation; wheel,
  press and text inputs degrade to scripted fallbacks; driver crashes
  auto-respawn and re-adopt the live Chrome; rapid open/close races are
  handled (waits for process exit AND port death).
- **Barrier handling**: captcha/login walls are detected across reading tools
  (`blocked` + `blockKind`), with a human-in-the-loop wait-and-continue flow.
- **Firecrawl-style reading**: `markdown` mode waits for network idle, converts
  the live DOM to structured Markdown and filters chrome/nav/ads — measured
  to beat Firecrawl's extracted content on Bilibili, Baidu, Taobao and Weibo.

## Files

| File | Purpose |
| --- | --- |
| `browser-driver.js` | The engine: CDP client, Chrome lifecycle, human behavior layer, stealth, all page operations. Also embeddable via `require('./browser-driver.js').createDriver(write)`. |
| `test-driver.js` | 14-step smoke test: `node test-driver.js [headful]` |
| `test-search.js` | Search-flow test (engine → read → click). |
| `test-research.js` | One-call research + structured-read test. |
| `test-crawl.js` | Crawl + extract test against a local multi-page site. |
| `test-verify.js` | Full-function verification: all 20 driver methods + barrier flow. |
| `test-preset-install.js` | Smoke test of an installed preset copy of the driver. |
| `test-markdown.js` | Markdown reading-mode test. |
| `experiment-compare.js` | 4-way comparison: fetch vs firecrawl vs headless vs headful on hot sites. |
| `experiment-fair.js` | Fair comparison: firecrawl cloud vs this engine (markdown mode), full text. |

## Protocol (line-delimited JSON over stdio)

```
in:  {"id":1,"method":"goto","params":{"url":"https://example.com","speed":"human"}}
out: {"id":1,"ok":true,"result":{...}}
     {"id":1,"ok":false,"error":{"message":"..."}}
     {"event":"ready"}   {"event":"log","text":"..."}
```

Methods: `open close status search research extract crawl markdown goto read
screenshot click move type scroll key wait back forward reload eval
waitForHuman`

- `search`: Baidu/Bing/Google with barrier detection and Bing retry.
- `research`: search → open top N sites → extract text, one call.
- `extract`: per-CSS-selector structured data from the current page.
- `crawl`: same-origin BFS crawl (≤ 50 pages), JSON written to `crawls/`.
- `markdown`: network-idle wait + DOM→Markdown with main-content filtering.
- `read`: text + interactive-element inventory (tag, text, selector, coords).
- `waitForHuman`: pause until a human clears a captcha/login wall, then
  continue.

## Data directories (git-ignored)

| Dir | Contents |
| --- | --- |
| `profile/` | Persistent Chrome user-data-dir (cookies, logins) — **never commit** |
| `shots/` | PNG screenshots |
| `crawls/` | Crawl and experiment JSON output |
| `downloads/` | Chrome downloads |

## License

MIT — except the comparison experiments' methodology and the engine's own
design, which borrow *ideas* from open-source projects (Firecrawl is AGPL-3.0;
only its concepts — network-idle waits, main-content filtering, structured
Markdown — are used here, implemented from scratch in zero-dependency JS).
