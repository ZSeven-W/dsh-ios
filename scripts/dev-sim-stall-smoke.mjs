import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { StreamAccessController, StreamRoutes } from '../lib/stream-routes.js'

const udid = '00000000-0000-4000-8000-000000000001'
let released = 0
const upstream = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' })
  res.flushHeaders()
  // Deliberately keep a 200 response open without producing video bytes.
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const streamUrl = `http://127.0.0.1:${upstream.address().port}/stream`
const host = {
  status: () => ({ running: true, device: udid }),
  acquire: () => () => { released++ },
  ensureRunning: async () => ({ device: udid, streamUrl }),
}
const access = new StreamAccessController(async () => Buffer.alloc(32, 7))
const routes = new StreamRoutes(host, access, undefined, { streamStallTimeoutMs: 80 })
const server = createServer((req, res) => { void routes.handleStream(req, res) })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
try {
  const { token } = await access.signStreamToken(udid)
  const start = Date.now()
  await assert.rejects(fetch(`http://127.0.0.1:${server.address().port}/_dsh/dsh-ios/stream/${token}`,
    { signal: AbortSignal.timeout(2000) }), error => error.name !== 'TimeoutError')
  assert.ok(Date.now() - start < 1500, 'stalled simulator stream must close before client timeout')
  assert.equal(released, 1, 'dead stream releases its consumer exactly once')
  console.log('PASS simulator 200/no-video stream is terminated and consumer released')
} finally {
  routes.dispose()
  for (const s of [server, upstream]) { s.closeAllConnections(); s.close() }
}
