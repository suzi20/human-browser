'use strict'
const net = require('node:net')
const cookie = process.argv[2]
const sock = net.connect(3081, '127.0.0.1', () => {
  sock.write('GET /api/events.mux HTTP/1.1\r\nHost: 127.0.0.1:3081\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: dsh_pin=' + cookie + '\r\nOrigin: https://evil.com\r\n\r\n')
})
let buf = ''
sock.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n\r\n')) { console.log('RESPONSE HEAD:', JSON.stringify(buf.split('\r\n\r\n')[0])); sock.destroy() } })
sock.on('error', (e) => console.log('SOCK ERR:', e.message))
setTimeout(() => { console.log('timeout, got:', JSON.stringify(buf.slice(0, 120))); process.exit(0) }, 4000)
