'use strict'
/* Swap the old mobile UI template for the GUI-styled one. */
const fs = require('node:fs')
const file = 'E:/work/plug/human-browser/dsh-mobile-gateway.js'
const templateFile = 'E:/work/plug/human-browser/ui-app-template.txt'

const src = fs.readFileSync(file, 'utf8')
const raw = fs.readFileSync(templateFile, 'utf8')

const start = src.indexOf('const UI = `')
if (start < 0) { console.log('no old template start'); process.exit(1) }
const end = src.indexOf('`\n\n// ---', start)
if (end < 0) { console.log('no old template end'); process.exit(1) }

if (raw.includes('`')) { console.log('ERROR: new template contains backticks'); process.exit(1) }
if (raw.includes('${')) { console.log('ERROR: new template contains ${'); process.exit(1) }

const replacement = 'const UI = `' + raw + '`'
const out = src.slice(0, start) + replacement + src.slice(end + 1)
fs.writeFileSync(file, out)
console.log('swapped: old template', start, '->', end, '; new length', raw.length)
