/**
 * Development smoke test for the dsh-ios web-route layer.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-routes-smoke.mjs
 *
 * Stands up a minimal node:http server that mounts the route handlers from
 * `./lib` the same way the DSH webserver service would (exact/prefix HTTP
 * dispatch plus an exact-path upgrade dispatch), then against a booted
 * iPhone + a real serve-sim stream:
 *   1. resolve serve-sim + pick/boot an iPhone simulator
 *   2. mount the signed routes on a loopback http server
 *   3. POST /grant (sim-stream) → relative streamUrl/wsUrl, no serve-sim port
 *   4. fetch the stream URL for 2s → multipart MJPEG, >100KB, no CORS *
 *   5. grant + fetch a screenshot PNG from the plugin cache → byte-identical
 *   6. ws relay: connect with the minted token, receive serve-sim's screen
 *      config frame, send a tap, and observe it in serve-sim's event log
 *      (proves bytes flow both ways); close releases the consumer refcount
 *   7. expired token → 403, garbage token → 403
 *   8. path outside the screenshot cache dir → 403 (grant-time and signed)
 *   9. dispose routes → all relays closed; no consumers left
 *  10. teardown: dispose the sim host, shut the simulator down, verify no
 *      serve-sim processes are left behind
 */

import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))
const { listDevices, bootDevice, shutdownDevice, bootedDevices } = await import(join(root, 'lib', 'simctl.js'))
const {
  GRANT_ROUTE_PATH,
  SCREENSHOT_ROUTE_PREFIX,
  STREAM_ROUTE_PREFIX,
  StreamAccessController,
  StreamRoutes,
  WS_ROUTE_PATH,
  mountStreamRoutes,
  prepareStreamAccessKey,
  screenshotDir,
} = await import(join(root, 'lib', 'stream-routes.js'))
const { WebSocket } = await import('ws')

/** Minimal webserver facsimile: same (kind, path) registries and dispatch. */
function createMiniWebServer() {
  const exact = new Map()
  const prefixes = new Map()
  const upgrades = new Map()
  const server = http.createServer((req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    let route = exact.get(pathname)
    if (route === undefined) {
      for (const [prefix, candidate] of prefixes) {
        if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
          route = candidate
          break
        }
      }
    }
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).catch(error => {
      console.error('route handler failed:', error)
      if (res.headersSent) res.destroy()
      else {
        res.writeHead(500)
        res.end()
      }
    })
  })
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      socket.destroy()
      return
    }
    const route = upgrades.get(pathname)
    if (route === undefined) {
      socket.destroy()
      return
    }
    Promise.resolve(route.handler(req, socket, head)).catch(error => {
      console.error('upgrade handler failed:', error)
      socket.destroy()
    })
  })
  return {
    server,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
    registerUpgrade(route) {
      if (upgrades.has(route.path)) throw new Error(`duplicate upgrade route ${route.path}`)
      upgrades.set(route.path, route)
      return () => upgrades.delete(route.path)
    },
  }
}

function signToken(key, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', key).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** Fetch `url` for `durationMs`, counting body bytes (aborts at the end). */
async function fetchBytes(url, durationMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), durationMs)
  let received = 0
  let contentType = ''
  let headers = {}
  let status = 0
  try {
    const response = await fetch(url, { signal: controller.signal })
    status = response.status
    headers = Object.fromEntries(response.headers.entries())
    contentType = response.headers.get('content-type') ?? ''
    const reader = response.body?.getReader()
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError') throw error
  } finally {
    clearTimeout(timer)
  }
  return { status, contentType, headers, received }
}

function sendHidFrame(ws, tag, payload) {
  const json = Buffer.from(JSON.stringify(payload))
  const frame = Buffer.alloc(1 + json.length)
  frame[0] = tag
  json.copy(frame, 1)
  ws.send(frame)
}

/** Poll serve-sim's event log until a tap with the wanted coordinates appears. */
async function waitForTapEvent(port, udid, x, y, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastEvents = []
  while (Date.now() < deadline) {
    try {
      const url = new URL('http://127.0.0.1/api/event-log')
      url.port = String(port)
      url.searchParams.set('device', udid)
      url.searchParams.set('limit', '20')
      const response = await fetch(url)
      if (response.ok) {
        const value = await response.json()
        lastEvents = value.events ?? []
        for (const event of lastEvents) {
          const start = event?.details?.start
          const timestamp = typeof event?.timestamp === 'number'
            ? event.timestamp
            : Date.parse(String(event?.timestamp ?? ''))
          if (
            event?.kind === 'tap'
            && typeof start?.x === 'number'
            && typeof start?.y === 'number'
            && Math.abs(start.x - x) < 0.01
            && Math.abs(start.y - y) < 0.01
            && Number.isFinite(timestamp)
            && Date.now() - timestamp < 15_000
          ) return true
        }
      }
    } catch {
      // keep polling
    }
    await delay(250)
  }
  return { observed: false, lastEvents }
}

const results = []
function step(name, ok, detail = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  results.push({ name, ok })
  console.log(`${verdict} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

let controller
let udid
let deviceName
let mini
let disposeRoutes
let routes
let streamPort

try {
  // ── 1. serve-sim + device selection + boot ────────────────────────────────
  controller = new SimHostController()
  const status0 = controller.status()
  step(
    'serve-sim binary resolves',
    status0.available,
    `source=${status0.serveSimSource} command=${status0.serveSimCommand ?? '(none)'}`,
  )
  if (!status0.available) throw new Error('serve-sim unavailable; cannot continue')

  const devices = await listDevices()
  const iphones = devices.filter(d => d.name.startsWith('iPhone'))
  if (iphones.length === 0) throw new Error('no available iPhone simulators')
  const byRuntime = (a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true })
  const ios26 = iphones.filter(d => d.runtime.includes('iOS-26')).sort(byRuntime)
  const fallback = iphones.sort(byRuntime)
  const picked = (ios26.length > 0 ? ios26 : fallback)[0]
  udid = picked.udid
  deviceName = picked.name
  step('pick iPhone simulator', true, `${deviceName} (${picked.runtime}, ${udid})`)

  controller.startKeepAlive()
  await bootDevice(udid)
  step('boot simulator', true, `${deviceName} booted`)

  // ── 2. mount the route handlers on a loopback http server ─────────────────
  routes = new StreamRoutes(controller, new StreamAccessController())
  mini = createMiniWebServer()
  disposeRoutes = mountStreamRoutes(mini, routes)
  await new Promise(resolveListen => mini.server.listen(0, '127.0.0.1', resolveListen))
  const port = mini.server.address().port
  const origin = `http://127.0.0.1:${port}`
  step('mount signed routes on a node http server', true, `127.0.0.1:${port}`)

  // ── 3. grant a stream capability ──────────────────────────────────────────
  const grantResponse = await fetch(`${origin}${GRANT_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ kind: 'sim-stream', device: udid }),
  })
  const grant = await grantResponse.json().catch(() => ({}))
  step(
    'grant mints a stream capability',
    grantResponse.status === 200 && grant.ok === true,
    `HTTP ${grantResponse.status}`,
  )
  step(
    'grant URLs are origin-relative (never serve-sim\u2019s port)',
    typeof grant.streamUrl === 'string'
      && grant.streamUrl.startsWith(`${STREAM_ROUTE_PREFIX}/`)
      && typeof grant.wsUrl === 'string'
      && grant.wsUrl.startsWith(`${WS_ROUTE_PATH}?token=`)
      && !grant.streamUrl.includes('127.0.0.1')
      && !grant.wsUrl.includes('127.0.0.1')
      && !grant.wsUrl.includes(':')
      && typeof grant.expiresAt === 'number'
      && grant.expiresAt > Date.now()
      && grant.expiresAt - Date.now() <= 10 * 60 * 1000,
    `streamUrl=${grant.streamUrl} expiresAt=${grant.expiresAt}`,
  )
  const runningStatus = controller.status()
  streamPort = runningStatus.port
  step('grant started the stream (device was already booted)', runningStatus.running && runningStatus.device === udid, `port=${streamPort}`)

  // ── 4. proxy the MJPEG stream for 2s ──────────────────────────────────────
  const streamResult = await fetchBytes(origin + grant.streamUrl, 2000)
  step(
    'proxied stream is multipart MJPEG',
    streamResult.status === 200 && streamResult.contentType.startsWith('multipart/x-mixed-replace'),
    `content-type=${streamResult.contentType}`,
  )
  step(
    'proxied stream hides serve-sim\u2019s CORS wildcard',
    streamResult.headers['access-control-allow-origin'] === undefined,
    'no access-control-allow-origin on the proxied response',
  )
  step(
    'stream delivers >100KB in 2s',
    streamResult.received > 100 * 1024,
    `${(streamResult.received / 1024).toFixed(1)} KB received`,
  )
  step('consumer refcount held while streaming', controller.status().consumers >= 1, `consumers=${controller.status().consumers}`)

  // ── 5. screenshot grant + fetch round-trip ────────────────────────────────
  mkdirSync(screenshotDir(), { recursive: true })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const pngPath = join(screenshotDir(), 'smoke.png')
  writeFileSync(pngPath, png)
  const shotGrantResponse = await fetch(`${origin}${GRANT_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ kind: 'sim-screenshot', path: pngPath }),
  })
  const shotGrant = await shotGrantResponse.json().catch(() => ({}))
  step(
    'screenshot grant accepts a cache-internal path',
    shotGrantResponse.status === 200 && typeof shotGrant.screenshotUrl === 'string',
    `HTTP ${shotGrantResponse.status} screenshotUrl=${shotGrant.screenshotUrl}`,
  )
  const shotResponse = await fetch(origin + shotGrant.screenshotUrl)
  const shotBytes = Buffer.from(await shotResponse.arrayBuffer())
  step(
    'screenshot route serves the PNG byte-for-byte',
    shotResponse.status === 200
      && shotResponse.headers.get('content-type') === 'image/png'
      && shotBytes.equals(png),
    `${shotBytes.length} bytes`,
  )

  // ── 6. ws relay: bytes flow both ways through the control channel ─────────
  const wsResult = await new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${grant.wsUrl}`)
    ws.binaryType = 'nodebuffer'
    let gotConfigFrame = false
    const timeout = setTimeout(() => {
      try {
        ws.close()
      } catch { /* already closed */ }
      rejectWs(new Error(`ws smoke timed out (gotConfigFrame=${gotConfigFrame})`))
    }, 15_000)
    ws.on('message', data => {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!gotConfigFrame && frame.length > 0 && frame[0] === 130) {
        gotConfigFrame = true
        sendHidFrame(ws, 3, { type: 'begin', x: 0.5, y: 0.5 })
        setTimeout(() => {
          try {
            sendHidFrame(ws, 3, { type: 'end', x: 0.5, y: 0.5 })
          } catch { /* socket closing */ }
        }, 40)
        void waitForTapEvent(streamPort, udid, 0.5, 0.5, 8000).then(tapResult => {
          const tapObserved = tapResult === true
          clearTimeout(timeout)
          try {
            ws.close()
          } catch { /* already closed */ }
          resolveWs({
            gotConfigFrame,
            tapObserved,
            lastEvents: tapObserved ? [] : tapResult?.lastEvents ?? [],
          })
        })
      }
    })
    ws.on('error', error => {
      clearTimeout(timeout)
      rejectWs(error)
    })
  })
  step('ws relay delivers serve-sim frames to the client', wsResult.gotConfigFrame, 'tag-130 screen config received')
  step(
    'ws relay delivers client frames to serve-sim',
    wsResult.tapObserved,
    wsResult.tapObserved
      ? 'tap event observed in serve-sim event log'
      : `no tap in event log; last events: ${JSON.stringify(wsResult.lastEvents.slice(0, 3))}`,
  )
  await delay(400)
  step('ws close releases the consumer refcount', controller.status().consumers === 0, `consumers=${controller.status().consumers}`)

  // ── 7. expired / garbage tokens are rejected ──────────────────────────────
  const garbageResponse = await fetch(origin + `${STREAM_ROUTE_PREFIX}/garbage.token`)
  step('garbage token → 403', garbageResponse.status === 403, `HTTP ${garbageResponse.status}`)
  const key = await prepareStreamAccessKey()
  const expiredToken = signToken(key, { v: 1, kind: 'sim-stream', udid, exp: Date.now() - 1000 })
  const expiredResponse = await fetch(origin + `${STREAM_ROUTE_PREFIX}/${expiredToken}`)
  step('expired token → 403', expiredResponse.status === 403, `HTTP ${expiredResponse.status}`)

  // ── 8. paths outside the screenshot cache dir are rejected ────────────────
  const outsideGrantResponse = await fetch(`${origin}${GRANT_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ kind: 'sim-screenshot', path: '/etc/hosts' }),
  })
  step('grant rejects a path outside the cache dir', outsideGrantResponse.status === 403, `HTTP ${outsideGrantResponse.status}`)
  const outsideToken = signToken(key, { v: 1, kind: 'sim-screenshot', path: '/etc/hosts', exp: Date.now() + 60_000 })
  const outsideResponse = await fetch(origin + `${SCREENSHOT_ROUTE_PREFIX}/${outsideToken}`)
  step('signed token for a path outside the cache dir → 403', outsideResponse.status === 403, `HTTP ${outsideResponse.status}`)

  // ── 9. disposal tears down routes and relays ──────────────────────────────
  disposeRoutes()
  const afterUnregister = await fetch(origin + grant.streamUrl)
  step('route unregistration stops serving', afterUnregister.status === 404, `HTTP ${afterUnregister.status}`)
  step('route disposal settles (no open relays left)', controller.status().consumers === 0, `consumers=${controller.status().consumers}`)
  const afterDisposal = controller.status()
  step(
    'sim host is still running after route disposal',
    afterDisposal.running === true,
    `running=${afterDisposal.running} restarts=${afterDisposal.restarts} stderr=${JSON.stringify(afterDisposal.stderr.slice(-3))}`,
  )

  // ── 10. teardown ──────────────────────────────────────────────────────────
  await controller.dispose()
  step('sim host dispose settles', true)
  await shutdownDevice(udid)
  step('simulator shut down', true)
  const leftDevices = (await bootedDevices()).map(d => `${d.name} ${d.udid}`)
  step('no booted simulators left', leftDevices.length === 0, leftDevices.join(', ') || 'none')
} catch (error) {
  step('smoke completed without uncaught errors', false, error instanceof Error ? error.message : String(error))
  console.error(error)
} finally {
  try {
    disposeRoutes?.()
  } catch { /* already disposed */ }
  try {
    await new Promise(resolveClose => mini?.server?.close(resolveClose))
  } catch { /* server already closed */ }
  try {
    await controller?.dispose()
  } catch { /* already disposed or best-effort */ }
  try {
    if (udid !== undefined) await shutdownDevice(udid)
  } catch { /* already shut down */ }
  try {
    execFileSync('pkill', ['-f', 'serve-sim'], { stdio: 'ignore', timeout: 10_000 })
  } catch { /* pkill exit 1 = nothing to kill */ }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
