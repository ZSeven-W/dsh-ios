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
 *   9. device switch: switch-device fence (403 without Origin / 415 / 405 /
 *      400), unknown device → 409, the devices listing shape (booted first,
 *      runtime descending, capped), the read-only status shape, then the
 *      happy path — switch to a SECOND, shutdown simulator: the route boots
 *      it, the stream follows (old device's token stops streaming, the old
 *      stream is retired, refcounts stay sane) and the minted URLs proxy
 *      MJPEG for the new device
 *  10. dispose routes → all relays closed; no consumers left
 *  11. teardown: dispose the sim host, shut BOTH simulators down, verify no
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
  DEVICES_ROUTE_PATH,
  GRANT_ROUTE_PATH,
  SCREENSHOT_ROUTE_PREFIX,
  STATUS_ROUTE_PATH,
  STREAM_ROUTE_PREFIX,
  SWITCH_DEVICE_ROUTE_PATH,
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

/** POST `path` against `originBase` with an abort timeout (booting a second
 * simulator inside switch-device can take a while). */
async function postRoute(originBase, path, body, { contentType = 'application/json', timeoutMs = 420_000, headers = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(`${originBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType, ...headers },
      body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
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
let secondUdid
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
  // Prefer a SHUTDOWN iPhone: a live DSH instance may already have one
  // booted (this smoke must never shut down or fight a device another host
  // streams). The pre-existing booted set also scopes the final
  // "no simulators left" check to what this smoke booted.
  const initialBootedUdidSet = new Set((await bootedDevices()).map(d => d.udid))
  const iphones = devices.filter(d => d.name.startsWith('iPhone'))
  if (iphones.length === 0) throw new Error('no available iPhone simulators')
  const byRuntime = (a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true })
  const ios26 = iphones.filter(d => d.runtime.includes('iOS-26')).sort(byRuntime)
  const fallback = iphones.sort(byRuntime)
  const candidates = ios26.length > 0 ? ios26 : fallback
  const picked = candidates.find(d => d.state !== 'Booted') ?? candidates[0]
  udid = picked.udid
  deviceName = picked.name
  step('pick a SHUTDOWN iPhone simulator', picked.state !== 'Booted', `${deviceName} (${picked.runtime}, ${udid})`)

  controller.startKeepAlive()
  await bootDevice(udid)
  // `bootstatus -b` can resolve just before `simctl list devices` flips the
  // entry to Booted; poll briefly so the very next grant sees it booted.
  const bootDeadline = Date.now() + 30_000
  while (Date.now() < bootDeadline) {
    if ((await bootedDevices()).some(device => device.udid === udid)) break
    await delay(500)
  }
  step('boot simulator', (await bootedDevices()).some(device => device.udid === udid), `${deviceName} booted`)

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

  // ── 6b. device switch: fence, listing shape, 409, happy path ──────────────

  // fence: the switch-device route shares /grant's loopback/trusted fence.
  const noOriginSwitch = await postRoute(origin, SWITCH_DEVICE_ROUTE_PATH, JSON.stringify({ device: udid }))
  step('switch-device rejects a request without Origin → 403', noOriginSwitch.status === 403, `HTTP ${noOriginSwitch.status}`)

  const wrongTypeSwitch = await postRoute(
    origin,
    SWITCH_DEVICE_ROUTE_PATH,
    JSON.stringify({ device: udid }),
    { contentType: 'text/plain', headers: { origin } },
  )
  step('switch-device requires application/json → 415', wrongTypeSwitch.status === 415, `HTTP ${wrongTypeSwitch.status}`)

  const getSwitch = await fetch(`${origin}${SWITCH_DEVICE_ROUTE_PATH}`, { method: 'GET', headers: { origin } })
  step('switch-device rejects GET → 405', getSwitch.status === 405, `HTTP ${getSwitch.status}`)

  const badJsonSwitch = await postRoute(origin, SWITCH_DEVICE_ROUTE_PATH, '{"device":', { headers: { origin } })
  step('switch-device rejects malformed JSON → 400', badJsonSwitch.status === 400, `HTTP ${badJsonSwitch.status}`)

  const badBodySwitch = await postRoute(origin, SWITCH_DEVICE_ROUTE_PATH, JSON.stringify({ device: 123 }), { headers: { origin } })
  step('switch-device rejects a non-udid device body → 400', badBodySwitch.status === 400, `HTTP ${badBodySwitch.status}`)

  const unknownSwitch = await postRoute(
    origin,
    SWITCH_DEVICE_ROUTE_PATH,
    JSON.stringify({ device: '00000000-0000-0000-0000-000000000000' }),
    { headers: { origin } },
  )
  step('switch-device unknown device → 409', unknownSwitch.status === 409, `HTTP ${unknownSwitch.status}`)

  // devices listing: shape + booted-first + runtime descending + cap.
  const noOriginDevices = await postRoute(origin, DEVICES_ROUTE_PATH, JSON.stringify({}))
  step('devices listing shares the trusted fence → 403 without Origin', noOriginDevices.status === 403, `HTTP ${noOriginDevices.status}`)

  const devicesResponse = await postRoute(origin, DEVICES_ROUTE_PATH, JSON.stringify({}), { headers: { origin } })
  const devicesBody = await devicesResponse.json().catch(() => ({}))
  const devicesList = Array.isArray(devicesBody.devices) ? devicesBody.devices : []
  const listingShapeOk = devicesResponse.status === 200
    && devicesBody.ok === true
    && devicesList.length > 0
    && devicesList.every(device => typeof device.udid === 'string' && typeof device.name === 'string' && typeof device.runtime === 'string' && typeof device.state === 'string')
  step(
    'devices endpoint lists pickable simulators as [{udid,name,runtime,state}]',
    listingShapeOk,
    `HTTP ${devicesResponse.status} entries=${devicesList.length}`,
  )
  step('devices list is capped at 40', devicesList.length <= 40, `entries=${devicesList.length}`)
  const devicesBootedFirst = devicesList.every((device, index) => {
    if (device.state !== 'Booted') return true
    return devicesList.slice(0, index).every(previous => previous.state === 'Booted')
  })
  step('devices list sorts booted first', devicesBootedFirst && devicesList.some(device => device.state === 'Booted'), devicesList.map(d => `${d.name}:${d.state}`).slice(0, 6).join(', '))
  const devicesRuntimeDesc = devicesList.every((device, index) => {
    const previous = devicesList[index - 1]
    if (previous === undefined || previous.state !== device.state) return true
    return previous.runtime.localeCompare(device.runtime, undefined, { numeric: true }) >= 0
  })
  step('devices list sorts each state segment by runtime descending', devicesRuntimeDesc, 'newest runtime first within booted/shutdown segments')

  // status route still reports the pre-switch stream shape.
  const statusResponse = await postRoute(origin, STATUS_ROUTE_PATH, JSON.stringify({}), { headers: { origin } })
  const statusBody = await statusResponse.json().catch(() => ({}))
  step(
    'status endpoint reports the running stream for the first device',
    statusResponse.status === 200
      && statusBody.ok === true
      && statusBody.running === true
      && statusBody.device === udid
      && statusBody.deviceName === deviceName,
    `HTTP ${statusResponse.status} device=${statusBody.device}`,
  )

  // happy path: switch to a SECOND, shutdown simulator — the route itself
  // must boot it (the documented exception to grant's never-boot rule).
  const second = devices.find(d => d.name.startsWith('iPhone') && d.udid !== udid && d.state !== 'Booted')
    ?? devices.find(d => d.udid !== udid && d.state !== 'Booted')
  if (second === undefined) throw new Error('no second (shutdown) simulator to switch to')
  secondUdid = second.udid
  step('pick a second, SHUTDOWN simulator for the switch', second.state !== 'Booted', `${second.name} (${second.runtime}, ${second.udid})`)

  const switchResponse = await postRoute(origin, SWITCH_DEVICE_ROUTE_PATH, JSON.stringify({ device: second.udid }), { headers: { origin } })
  const switched = await switchResponse.json().catch(() => ({}))
  step(
    'switch-device boots + streams the second simulator',
    switchResponse.status === 200
      && switched.ok === true
      && switched.device === second.udid
      && switched.deviceName === second.name,
    `HTTP ${switchResponse.status}`,
  )
  step(
    'switch-device mints fresh relative capability URLs (grant shape + device)',
    typeof switched.streamUrl === 'string'
      && switched.streamUrl.startsWith(`${STREAM_ROUTE_PREFIX}/`)
      && typeof switched.wsUrl === 'string'
      && switched.wsUrl.startsWith(`${WS_ROUTE_PATH}?token=`)
      && !switched.streamUrl.includes('127.0.0.1')
      && !switched.wsUrl.includes(':')
      && typeof switched.expiresAt === 'number'
      && switched.expiresAt > Date.now()
      && switched.expiresAt - Date.now() <= 10 * 60 * 1000,
    `streamUrl=${switched.streamUrl} expiresAt=${switched.expiresAt}`,
  )
  const switchedStatus = controller.status()
  step(
    'the stream follows the switch (old stream retired, refcounts sane)',
    switchedStatus.running === true
      && switchedStatus.device === second.udid
      && switchedStatus.consumers === 0
      && switchedStatus.restarts === 0,
    `device=${switchedStatus.device} consumers=${switchedStatus.consumers} restarts=${switchedStatus.restarts}`,
  )
  const bootedAfterSwitch = await bootedDevices()
  step('the second simulator is booted', bootedAfterSwitch.some(device => device.udid === second.udid), second.name)
  step('the first simulator stays booted (only the stream switched)', bootedAfterSwitch.some(device => device.udid === udid), deviceName)

  // The first device's token is still cryptographically valid but names the
  // retired device: the stream route must refuse it.
  const oldStreamResponse = await fetch(origin + grant.streamUrl)
  step('the old device token no longer streams (stream follows the switch)', oldStreamResponse.status === 503, `HTTP ${oldStreamResponse.status}`)

  // REGRESSION (the silent-rollback bug): granting for the PREVIOUS device
  // while another one streams must be refused, not obeyed. /grant used to
  // call ensureRunning here, so any stale-udid re-grant (a panel that missed
  // a switch, a queued retry) yanked the stream back to the old device while
  // the picker still showed the new one — the UI then lied about the server.
  const staleGrant = await postRoute(origin, GRANT_ROUTE_PATH, JSON.stringify({ kind: 'sim-stream', device: udid }), { headers: { origin } })
  const staleGrantBody = await staleGrant.json().catch(() => ({}))
  const statusAfterStale = await postRoute(origin, STATUS_ROUTE_PATH, JSON.stringify({}), { headers: { origin } })
  const statusAfterStaleBody = await statusAfterStale.json().catch(() => ({}))
  step(
    'a grant for the previous device is refused, never a silent takeover',
    staleGrant.status === 409
      && typeof staleGrantBody.error === 'string'
      && staleGrantBody.error.includes('another simulator is streaming')
      && statusAfterStaleBody.device === second.udid,
    `HTTP ${staleGrant.status}; still streaming ${statusAfterStaleBody.deviceName ?? statusAfterStaleBody.device}`,
  )

  const switchedStreamResult = await fetchBytes(origin + switched.streamUrl, 2500)
  step(
    'the switched stream proxies MJPEG for the new device',
    switchedStreamResult.status === 200
      && switchedStreamResult.contentType.startsWith('multipart/x-mixed-replace')
      && switchedStreamResult.received > 1024,
    `content-type=${switchedStreamResult.contentType} ${(switchedStreamResult.received / 1024).toFixed(1)} KB`,
  )
  await delay(300)
  step('the switch leaves the consumer refcount clean', controller.status().consumers === 0, `consumers=${controller.status().consumers}`)

  const statusAfterSwitch = await postRoute(origin, STATUS_ROUTE_PATH, JSON.stringify({}), { headers: { origin } })
  const statusAfterBody = await statusAfterSwitch.json().catch(() => ({}))
  step(
    'status endpoint follows the switch (second device, first name)',
    statusAfterSwitch.status === 200
      && statusAfterBody.ok === true
      && statusAfterBody.running === true
      && statusAfterBody.device === second.udid
      && statusAfterBody.deviceName === second.name,
    `HTTP ${statusAfterSwitch.status} device=${statusAfterBody.device}`,
  )

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
  if (secondUdid !== undefined) await shutdownDevice(secondUdid)
  step('both smoke-booted simulators shut down', true)
  // Only what THIS smoke booted must be shut down again: a live DSH
  // instance's booted device (and any user device) is deliberately left
  // alone.
  const leftDevices = (await bootedDevices())
    .filter(d => !initialBootedUdidSet.has(d.udid))
    .map(d => `${d.name} ${d.udid}`)
  step('no smoke-booted simulators left', leftDevices.length === 0, leftDevices.join(', ') || 'none')
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
    if (secondUdid !== undefined && secondUdid !== udid) await shutdownDevice(secondUdid)
  } catch { /* already shut down */ }
  // Reap only serve-sim stragglers for the devices THIS smoke streamed —
  // never a blanket pkill, which could kill a live DSH instance's helper.
  for (const stragglerUdid of [...new Set([udid, secondUdid].filter(value => value !== undefined))]) {
    try {
      execFileSync('pkill', ['-f', `serve-sim .*${stragglerUdid}`], { stdio: 'ignore', timeout: 10_000 })
    } catch { /* pkill exit 1 = nothing to kill */ }
  }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
