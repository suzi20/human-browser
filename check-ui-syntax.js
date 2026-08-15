'use strict'
/** Rigorous UI extraction + syntax check + template-literal hazard scan.
 *
 * IMPORTANT: the UI lives inside a JS template literal, so backslash escapes
 * (e.g. \') are processed when the template is evaluated. The code the BROWSER
 * receives is the EVALUATED string, not the raw file text. We therefore:
 *   1. evaluate the template literal to get the real served HTML,
 *   2. extract every <script> block from THAT,
 *   3. parse each block in SCRIPT context (vm.Script) like a browser would.
 */
const fs = require('node:fs')
const vm = require('node:vm')

const src = fs.readFileSync('E:/work/plug/human-browser/dsh-mobile-gateway.js', 'utf8')

const marker = 'const UI = `'
const start = src.indexOf(marker)
console.log('UI marker at:', start)
if (start < 0) process.exit(1)

const closeIdx = src.indexOf('`\n\n// ---', start)
console.log('closing backtick at:', closeIdx)
if (closeIdx < 0) { console.log('no closing backtick found'); process.exit(1) }

const uiRaw = src.slice(start + marker.length, closeIdx)
console.log('raw template length:', uiRaw.length)

// 1. Evaluate the template exactly like Node/the gateway would.
let ui
try {
  ui = eval('`' + uiRaw + '`') // eslint-disable-line no-eval
} catch (e) {
  console.log('TEMPLATE EVAL ERROR:', e.message)
  process.exit(1)
}
console.log('evaluated UI length:', ui.length)

// 2. Scan the EVALUATED html for leftover backslash escapes that would mean
//    the author's escape intent was silently altered. Whitelist \' (escaped
//    quote inside the served JS string literals — intentional).
const allEsc = ui.match(/\\./g) || []
const badEsc = allEsc.filter((s) => s !== "\\'")
console.log('backslash escapes in EVALUATED UI:', allEsc.length, allEsc.slice(0, 10))
if (badEsc.length) {
  console.log('ERROR: unexpected backslash sequences in served HTML:', badEsc.slice(0, 10))
  process.exit(1)
}

// 3. Extract and parse every script block from the EVALUATED html.
const blocks = []
{
  let rest = ui
  let n = 0
  while (true) {
    const sStart = rest.indexOf('<script>')
    if (sStart < 0) break
    const after = rest.slice(sStart + '<script>'.length)
    const sEnd = after.indexOf('</script>')
    if (sEnd < 0) { console.log('BAD script block: no closing tag'); process.exit(1) }
    const js = after.slice(0, sEnd)
    blocks.push(js)
    n++
    console.log('script block', n + ':', 'len', js.length, '| contains </script>:', js.includes('</script>'))
    rest = after.slice(sEnd + '</script>'.length)
  }
}
console.log('script blocks total:', blocks.length)
if (blocks.length === 0) { console.log('NO script block found'); process.exit(1) }

for (let i = 0; i < blocks.length; i++) {
  try {
    new vm.Script(blocks[i], { filename: 'ui-block-' + (i + 1) + '.js' })
    console.log('SCRIPT-CONTEXT PARSE block ' + (i + 1) + ': OK')
  } catch (e) {
    console.log('SCRIPT-CONTEXT PARSE ERROR block ' + (i + 1) + ':', e.message)
    const m = e.stack.match(/ui-block-\d\.js:(\d+)/)
    if (m) {
      const line = Number(m[1])
      const lines = blocks[i].split('\n')
      for (let k = Math.max(1, line - 3); k <= Math.min(lines.length, line + 3); k++) {
        console.log(k + ': ' + lines[k - 1])
      }
    }
    process.exit(1)
  }
}
console.log('ALL UI SCRIPT BLOCKS PARSE OK (as served)')
