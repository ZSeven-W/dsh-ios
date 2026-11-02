import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { sendSimFold } from '../lib/sim-gesture.js'
const require = createRequire(import.meta.url)
const { WebSocketServer } = require('ws')

async function check(mode) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const messages = []
  server.on('connection', socket => {
    // A screen config is unrelated to fold acknowledgement and must not settle it.
    socket.send(Buffer.from([130, ...Buffer.from('{"width":1398,"height":2034,"orientation":"portrait"}')]))
    socket.on('message', data => {
      messages.push({ tag: data[0], value: JSON.parse(data.subarray(1).toString()) })
      if (mode === 'close') { socket.close(); return }
      if (mode === 'abort') return
      socket.send(Buffer.from([14, ...Buffer.from(JSON.stringify({ ok: mode === 'ok' }))]))
    })
  })
  try {
    const controller = new AbortController()
    const pending = sendSimFold(`ws://127.0.0.1:${server.address().port}`, 90, controller.signal)
    if (mode === 'ok') await pending
    else if (mode === 'abort') {
      const timer = setTimeout(() => controller.abort(), 40)
      try { await assert.rejects(pending, /cancelled/) } finally { clearTimeout(timer) }
    } else await assert.rejects(pending, mode === 'close' ? /closed before/ : /rejected/)
    if (mode !== 'abort') assert.deepEqual(messages, [{ tag: 14, value: { hinge: 90 } }])
    console.log('PASS direct live fold socket:', mode)
  } finally {
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  }
}
for (const mode of ['ok', 'rejected', 'close', 'abort']) await check(mode)
