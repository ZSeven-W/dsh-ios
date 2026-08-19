/**
 * Development smoke test for the `/real-start` route — the ONE route allowed
 * to build/launch WebDriverAgent on a physical device.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-realstart-smoke.mjs
 *
 * Fully STATIC: no phone, no xcodebuild, no simulator is touched — the WDA
 * host is a controllable mock and the handlers run on a plain node:http
 * server (the same mini-webserver facsimile dev-routes-smoke uses):
 *   - the trusted/loopback fence (403 without Origin) and the coded method /
 *     content-type / body refusals (405 / 415 / 400)
 *   - coded failures: wda not mounted → 503 wda_unavailable; tooling
 *     unavailable → 503 wda_unavailable with the host detail
 *   - the already-running shortcut: 200 `{ ok, state:'running', device,
 *     adopted }` with NO ensureRunning call
 *   - the accepted-response shape: 202 `{ ok, state:'starting', device,
 *     startedAt }` while `ensureRunning({udid})` runs in the background
 *     (the HTTP request never hangs on the minutes-long build)
 *   - the "already starting" path: a second POST for the same device while
 *     the first is in flight answers 202 with `alreadyStarting:true` and the
 *     same `startedAt`, and `ensureRunning` is called EXACTLY ONCE (never a
 *     second build); a different device while one is in flight gets its own
 *     launch (the controller's shared launch queue serializes)
 *   - the async coded failure: a rejected launch records
 *     `realStartState(udid) = { state:'failed', error:{ code } }` with the
 *     wda_* code mapped from the classified reason, and the next POST
 *     retries with a fresh start
 *   - a settled success clears the fence; /real-device-status now carries
 *     the machine-readable `code` next to `reason` for the panel's poll
 *   - disposal unregisters the route and clears the start registry
 */

import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { DEVICE_ACTIONS } = await import(join(root, 'lib', 'device-actions.js'))
const { registerIosSkill } = await import(join(root, 'lib', 'skill.js'))
const {
  DEVICE_ACTION_ROUTE_PATH,
  GRANT_ROUTE_PATH,
  REAL_DEVICE_STATUS_ROUTE_PATH,
  REAL_START_ROUTE_PATH,
  StreamAccessController,
  StreamRoutes,
  mountStreamRoutes,
} = await import(join(root, 'lib', 'stream-routes.js'))

const UDID = '96E6B481-3807-594D-B3BC-E1E12307D47C'
const OTHER_UDID = '5B625AA0-BFE5-5FDE-9443-6E1ABD535825'

const results = []
let failed = 0
function step(name, verdict, detail = '') {
  const normalized = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict
  if (normalized === 'FAIL') failed += 1
  results.push({ name, verdict: normalized, detail })
  console.log(`${normalized.padEnd(4)} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

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

/**
 * Controllable WdaRouteHost mock: `ensureRunning` returns a promise the
 * test settles; `status()` reflects the injected state so the route's
 * classification paths are deterministic with no phone involved.
 */
function makeMockWda() {
  const state = {
    available: true,
    running: false,
    device: undefined,
    // The controller's in-flight/just-failed target: set while `device` is
    // undefined (a failed launch tears the live device down).
    pendingDevice: undefined,
    reason: undefined,
    detail: undefined,
    adopted: undefined,
    ensureCalls: [],
    pending: [],
    stopCalls: 0,
  }
  const noop = async () => {}
  return {
    ensureRunning({ udid }) {
      state.ensureCalls.push(udid)
      return new Promise((resolve, reject) => {
        state.pending.push({ udid, resolve, reject })
      })
    },
    status() {
      return {
        available: state.available,
        running: state.running,
        ...(state.device === undefined ? {} : { device: state.device }),
        ...(state.pendingDevice === undefined ? {} : { pendingDevice: state.pendingDevice }),
        ...(state.reason === undefined ? {} : { reason: state.reason }),
        ...(state.detail === undefined ? {} : { detail: state.detail }),
        ...(state.adopted === undefined ? {} : { adopted: state.adopted }),
        // A running controller always advertises its video URL; the mint's
        // tunnel probe is what decides whether it actually forwards.
        ...(state.running ? { mjpegUrl: 'http://127.0.0.1:9100/' } : {}),
        consumers: 0,
      }
    },
    async stop() {
      state.stopCalls += 1
    },
    acquire() {
      return () => {}
    },
    release() {},
    get mjpegUrl() {
      return state.running ? 'http://127.0.0.1:9100/' : undefined
    },
    control: {
      pressButton: noop,
      tap: noop,
      dragFromToForDuration: noop,
      typeText: noop,
      setOrientation: noop,
      screenshot: async () => ({ pngBase64: '' }),
      source: async () => '',
      windowSize: async () => ({ width: 1, height: 1 }),
      getOrientation: async () => 'PORTRAIT',
    },
    __state: state,
  }
}

/** POST `path` against `originBase` (optional Origin / content-type). */
async function postRoute(originBase, path, body, { contentType = 'application/json', origin, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(`${originBase}${path}`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        ...(origin === undefined ? {} : { origin }),
      },
      body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

let mini
let disposeRoutes
let routes
let wda
let origin
const servers = []
function mount(routesToMount) {
  disposeRoutes = mountStreamRoutes(mini, routesToMount)
  servers.push(mini.server)
  return new Promise(resolveListen => mini.server.listen(0, '127.0.0.1', resolveListen))
}

try {
  const simHost = {
    status: () => ({ available: false, running: false, consumers: 0 }),
    acquire: () => () => {},
  }

  // ── 1. real-start without the WDA host mounted → coded 503 ────────────────
  routes = new StreamRoutes(simHost, new StreamAccessController())
  mini = createMiniWebServer()
  await mount(routes)
  origin = `http://127.0.0.1:${mini.server.address().port}`
  step('mount the route handlers on a node http server', true, `127.0.0.1:${mini.server.address().port}`)

  const noWda = await postRoute(origin, REAL_START_ROUTE_PATH, JSON.stringify({ device: UDID }), { origin })
  const noWdaBody = await noWda.json().catch(() => ({}))
  step(
    'real-start without the WDA host → 503 wda_unavailable',
    noWda.status === 503 && noWdaBody.ok === false && noWdaBody.code === 'wda_unavailable',
    `HTTP ${noWda.status} code=${noWdaBody.code}`,
  )
  disposeRoutes()
  routes.dispose()

  // ── 2. remount with the mock WDA host; coded + fence coverage ─────────────
  wda = makeMockWda()
  routes = new StreamRoutes(simHost, new StreamAccessController(), wda)
  mini = createMiniWebServer()
  await mount(routes)
  origin = `http://127.0.0.1:${mini.server.address().port}`

  wda.__state.available = false
  wda.__state.reason = 'unavailable'
  wda.__state.detail = 'xcodebuild is not on PATH'
  const toolingDown = await postRoute(origin, REAL_START_ROUTE_PATH, JSON.stringify({ device: UDID }), { origin })
  const toolingDownBody = await toolingDown.json().catch(() => ({}))
  step(
    'unavailable WDA tooling → 503 wda_unavailable with the host detail',
    toolingDown.status === 503 && toolingDownBody.ok === false && toolingDownBody.code === 'wda_unavailable'
      && String(toolingDownBody.error).includes('xcodebuild is not on PATH'),
    `HTTP ${toolingDown.status}: ${toolingDownBody.error}`,
  )
  wda.__state.available = true
  wda.__state.reason = undefined
  wda.__state.detail = undefined

  const noOrigin = await postRoute(origin, REAL_START_ROUTE_PATH, JSON.stringify({ device: UDID }))
  const noOriginBody = await noOrigin.json().catch(() => ({}))
  step(
    'real-start rejects a request without Origin → 403 forbidden',
    noOrigin.status === 403 && noOriginBody.ok === false && noOriginBody.code === 'forbidden',
    `HTTP ${noOrigin.status} code=${noOriginBody.code}`,
  )

  const wrongMethod = await fetch(`${origin}${REAL_START_ROUTE_PATH}`, { method: 'GET', headers: { origin } })
  step('real-start rejects GET → 405', wrongMethod.status === 405 && wrongMethod.headers.get('allow') === 'POST', `HTTP ${wrongMethod.status}`)

  const wrongType = await postRoute(origin, REAL_START_ROUTE_PATH, JSON.stringify({ device: UDID }), { contentType: 'text/plain', origin })
  const wrongTypeBody = await wrongType.json().catch(() => ({}))
  step('real-start requires application/json → 415', wrongType.status === 415 && wrongTypeBody.code === 'bad_content_type', `HTTP ${wrongType.status}`)

  const badJson = await postRoute(origin, REAL_START_ROUTE_PATH, '{"device":', { origin })
  step('real-start rejects malformed JSON → 400', badJson.status === 400, `HTTP ${badJson.status}`)

  for (const [label, payload] of [
    ['a non-object body', JSON.stringify('nope')],
    ['a missing device', JSON.stringify({})],
    ['a non-string device', JSON.stringify({ device: 123 })],
    ['a malformed udid', JSON.stringify({ device: 'not a udid!' })],
  ]) {
    const refused = await postRoute(origin, REAL_START_ROUTE_PATH, payload, { origin })
    const body = await refused.json().catch(() => ({}))
    step(
      `real-start rejects ${label} → 400 bad_request`,
      refused.status === 400 && body.ok === false && body.code === 'bad_request',
      `HTTP ${refused.status}`,
    )
  }

  // ── 3. already running → immediate 200, no launch ─────────────────────────
  wda.__state.running = true
  wda.__state.device = UDID
  wda.__state.adopted = true
  const alreadyUp = await postRoute(origin, REAL_START_ROUTE_PATH, JSON.stringify({ device: UDID }), { origin })
  const alreadyUpBody = await alreadyUp.json().catch(() => ({}))
  step(
    'already-running WDA → 200 { state:"running", device, adopted } with NO ensureRunning call',
    alreadyUp.status === 200 && alreadyUpBody.ok === true && alreadyUpBody.state === 'running'
      && alreadyUpBody.device === UDID && alreadyUpBody.adopted === true
      && wda.__state.ensureCalls.length === 0,
    `HTTP ${alreadyUp.status} ensureCalls=${wda.__state.ensureCalls.length}`,
  )
  wda.__state.running = false
  wda.__state.device = undefined
  wda.__state.adopted = undefined

  // ── 4. accepted-response shape: 202 + background launch ───────────────────
  const accepted = await postRoute(origin, REAL_START_ROUTE_PATH, JSON.stringify({ device: UDID }), { origin })
  const acceptedBody = await accepted.json().catch(() => ({}))
  step(
    'a cold start answers 202 accepted immediately (the request never hangs)',
    accepted.status === 202 && acceptedBody.ok === true && acceptedBody.state === 'starting'
      && acceptedBody.device === UDID
      && typeof acceptedBody.startedAt === 'number' && Number.isFinite(acceptedBody.startedAt)
      && acceptedBody.alreadyStarting !== true,
    `HTTP ${accepted.status} ${JSON.stringify(acceptedBody)}`,
  )
  step(
    'the background launch calls ensureRunning({udid}) exactly once',
    wda.__state.ensureCalls.length === 1 && wda.__state.ensureCalls[0] === UDID,
    `ensureCalls=${JSON.stringify(wda.__state.ensureCalls)}`,
  )
  step(
    'realStartState reports the in-flight launch',
    routes.realStartState(UDID)?.state === 'starting' && routes.realStartState(UDID)?.udid === UDID,
    JSON.stringify(routes.realStartState(UDID)),
  )

  // ── 5. already starting: second POST must never spawn a second build ──────
  const again = await postRoute(origin, REAL_START_ROUTE_PATH, JSON.stringify({ device: UDID }), { origin })
  const againBody = await again.json().catch(() => ({}))
  step(
    'a second start for the same device while one is in flight reports alreadyStarting',
    again.status === 202 && againBody.ok === true && againBody.state === 'starting'
      && againBody.alreadyStarting === true && againBody.startedAt === acceptedBody.startedAt,
    `HTTP ${again.status} ${JSON.stringify(againBody)}`,
  )
  step(
    'the already-starting path NEVER spawns a second build',
    wda.__state.ensureCalls.length === 1,
    `ensureCalls=${wda.__state.ensureCalls.length} (must stay 1)`,
  )

  // A DIFFERENT device while the first is in flight gets its own launch —
  // the controller's shared launch queue serializes builds, the fence is
  // per-device only.
  const otherStart = await postRoute(origin, REAL_START_ROUTE_PATH, JSON.stringify({ device: OTHER_UDID }), { origin })
  const otherStartBody = await otherStart.json().catch(() => ({}))
  step(
    'a start for a DIFFERENT device is accepted in parallel (controller serializes)',
    otherStart.status === 202 && otherStartBody.state === 'starting'
      && otherStartBody.alreadyStarting !== true
      && wda.__state.ensureCalls.length === 2 && wda.__state.ensureCalls[1] === OTHER_UDID,
    `HTTP ${otherStart.status} ensureCalls=${JSON.stringify(wda.__state.ensureCalls)}`,
  )

  // ── 6. async coded failure: classified reason → wda_* code ────────────────
  wda.__state.reason = 'build-failed'
  wda.__state.detail = 'the WebDriverAgentRunner build failed — fix the error and re-run'
  const firstLaunch = wda.__state.pending.shift()
  firstLaunch.reject(new Error('TEST BUILD FAILED'))
  await tick()
  const failedRecord = routes.realStartState(UDID)
  step(
    'a rejected launch records the coded failure (wda_build_failed)',
    failedRecord?.state === 'failed' && failedRecord?.error?.code === 'wda_build_failed'
      && failedRecord?.error?.detail?.includes('build failed'),
    JSON.stringify(failedRecord),
  )

  // The next POST retries with a fresh start (overwriting the failed record).
  const retried = await postRoute(origin, REAL_START_ROUTE_PATH, JSON.stringify({ device: UDID }), { origin })
  const retriedBody = await retried.json().catch(() => ({}))
  step(
    'a failed launch can be retried with a fresh start',
    retried.status === 202 && retriedBody.state === 'starting' && retriedBody.alreadyStarting !== true
      && routes.realStartState(UDID)?.state === 'starting'
      && wda.__state.ensureCalls.length === 3,
    `HTTP ${retried.status} ensureCalls=${wda.__state.ensureCalls.length}`,
  )

  // Settle the retried launch successfully → the fence clears, status wins.
  wda.__state.reason = undefined
  wda.__state.detail = undefined
  wda.__state.running = true
  wda.__state.device = UDID
  wda.__state.adopted = false
  const retriedLaunch = wda.__state.pending.find(pending => pending.udid === UDID)
  retriedLaunch.resolve({
    udid: UDID,
    hardwareUdid: 'HW-1',
    controlUrl: 'http://127.0.0.1:8100',
    mjpegUrl: 'http://127.0.0.1:9100/',
    sessionId: 'sid-1',
  })
  await tick()
  step(
    'a settled success clears the start fence (the status route reports running)',
    routes.realStartState(UDID) === undefined && wda.status().running === true,
    `realStartState=${JSON.stringify(routes.realStartState(UDID))}`,
  )

  // Settle the other device's launch too (cleanup).
  const otherLaunch = wda.__state.pending.find(pending => pending.udid === OTHER_UDID)
  wda.__state.running = false
  wda.__state.device = undefined
  otherLaunch.resolve({ udid: OTHER_UDID, hardwareUdid: 'HW-2', controlUrl: 'http://127.0.0.1:8101', mjpegUrl: 'http://127.0.0.1:9101/', sessionId: 'sid-2' })
  await tick()

  // ── 7. /real-device-status carries the machine-readable code ──────────────
  wda.__state.device = UDID
  wda.__state.reason = 'cert-untrusted'
  wda.__state.detail = 'trust the Developer App certificate once, then re-run'
  const statusResponse = await postRoute(origin, REAL_DEVICE_STATUS_ROUTE_PATH, JSON.stringify({ device: UDID }), { origin })
  const statusBody = await statusResponse.json().catch(() => ({}))
  step(
    'real-device-status reports code + reason + detail for the poll flow',
    statusResponse.status === 200 && statusBody.ok === true
      && statusBody.running === false && statusBody.ready === false
      && statusBody.reason === 'cert-untrusted'
      && statusBody.code === 'wda_cert_untrusted'
      && statusBody.detail === 'trust the Developer App certificate once, then re-run',
    `HTTP ${statusResponse.status} code=${statusBody.code}`,
  )

  // ── 7b. a torn-down launch still explains itself to its own asker ─────────
  // The real trap this closes: a phone that locks mid-launch fails, the
  // controller reaps `device`, and the panel's device-FILTERED poll used to
  // fall through to a bare "not running" — the one actionable line ("unlock
  // the device") never reached the screen. `pendingDevice` keeps the failure
  // addressable without ever claiming something is up.
  wda.__state.device = undefined
  wda.__state.pendingDevice = UDID
  wda.__state.reason = 'device-locked'
  wda.__state.detail = 'unlock the device — WDA keeps waiting and recovers by itself'
  const lockedResponse = await postRoute(origin, REAL_DEVICE_STATUS_ROUTE_PATH, JSON.stringify({ device: UDID }), { origin })
  const lockedBody = await lockedResponse.json().catch(() => ({}))
  step(
    'a pending (torn-down) launch still reports its reason to the device-filtered poll',
    lockedResponse.status === 200 && lockedBody.ok === true
      && lockedBody.running === false && lockedBody.ready === false
      && lockedBody.reason === 'device-locked'
      && lockedBody.code === 'wda_device_locked'
      && typeof lockedBody.detail === 'string' && lockedBody.detail.includes('unlock'),
    `HTTP ${lockedResponse.status} code=${lockedBody.code} reason=${lockedBody.reason}`,
  )
  const otherPollResponse = await postRoute(origin, REAL_DEVICE_STATUS_ROUTE_PATH, JSON.stringify({ device: OTHER_UDID }), { origin })
  const otherPollBody = await otherPollResponse.json().catch(() => ({}))
  step(
    'another device never inherits that failure (pendingDevice matches ONE asker)',
    otherPollResponse.status === 200 && otherPollBody.ok === true
      && otherPollBody.running === false && otherPollBody.reason === undefined && otherPollBody.code === undefined,
    `code=${String(otherPollBody.code)} reason=${String(otherPollBody.reason)}`,
  )
  wda.__state.pendingDevice = undefined
  wda.__state.reason = undefined
  wda.__state.detail = undefined

  // ── 7c. a stream capability is never minted for a dead video tunnel ───────
  // Observed on a replugged phone: iproxy 8100 alive, 9100 gone. The
  // controller reported running+ready off the CONTROL port alone, /grant
  // minted a capability anyway, and the panel painted nothing with no error
  // anywhere. The mint now probes-and-repairs first; repair respawns the
  // forwarder ONLY — rebuilding the runner would cost minutes.
  wda.__state.device = UDID
  wda.__state.running = true
  wda.__state.reason = undefined
  wda.__state.detail = undefined
  const ensureCallsBefore = wda.__state.ensureCalls.length
  let repairs = 0
  let tunnelAlive = false
  wda.repairStreamTunnel = async () => { repairs += 1; return tunnelAlive }
  const deadTunnel = await postRoute(origin, GRANT_ROUTE_PATH, JSON.stringify({ kind: 'real-stream', device: UDID }), { origin })
  const deadBody = await deadTunnel.json().catch(() => ({}))
  step(
    'a dead video tunnel refuses the mint with a coded, actionable error',
    deadTunnel.status === 409 && deadBody.ok === false && deadBody.code === 'wda_tunnel_failed' && repairs === 1,
    `HTTP ${deadTunnel.status} code=${String(deadBody.code)} repairs=${repairs}`,
  )
  tunnelAlive = true
  const healed = await postRoute(origin, GRANT_ROUTE_PATH, JSON.stringify({ kind: 'real-stream', device: UDID }), { origin })
  const healedBody = await healed.json().catch(() => ({}))
  step(
    'a repaired tunnel mints normally, without rebuilding the runner',
    healed.status === 200 && healedBody.ok === true && typeof healedBody.streamUrl === 'string'
      && repairs === 2 && wda.__state.ensureCalls.length === ensureCallsBefore,
    `HTTP ${healed.status} repairs=${repairs} ensureRunning delta=${wda.__state.ensureCalls.length - ensureCallsBefore}`,
  )
  wda.repairStreamTunnel = undefined
  wda.__state.running = false
  wda.__state.device = undefined

  // ── 7d. the device-action route: allowlist + per-backend availability ──────
  // The table lives host-side so the panel cannot invent an action, and so a
  // sim-only action asked of a phone fails as a coded 400 instead of a
  // confusing 502 from a backend that was never going to serve it.
  const badAction = await postRoute(origin, DEVICE_ACTION_ROUTE_PATH, JSON.stringify({ action: 'self-destruct' }), { origin })
  const badBody = await badAction.json().catch(() => ({}))
  step(
    'an unknown device action is refused by the allowlist, listing the real ones',
    badAction.status === 400 && badBody.ok === false && String(badBody.error).includes('app-switcher'),
    `HTTP ${badAction.status} ${String(badBody.error).slice(0, 80)}`,
  )
  step(
    'the destructive Simulator menu items are not in the allowlist at all',
    !DEVICE_ACTIONS.includes('restart') && !DEVICE_ACTIONS.includes('erase'),
    DEVICE_ACTIONS.join(', '),
  )
  wda.__state.running = true
  wda.__state.device = UDID
  const simOnlyOnPhone = await postRoute(origin, DEVICE_ACTION_ROUTE_PATH, JSON.stringify({ device: UDID, action: 'shake' }), { origin })
  const simOnlyBody = await simOnlyOnPhone.json().catch(() => ({}))
  step(
    'a simulator-only action asked of a PHONE is a coded 400, not a backend error',
    simOnlyOnPhone.status === 400 && simOnlyBody.ok === false
      && String(simOnlyBody.error).includes('physical-device'),
    `HTTP ${simOnlyOnPhone.status} ${String(simOnlyBody.error).slice(0, 70)}`,
  )
  const actionNoOrigin = await fetch(`${origin}${DEVICE_ACTION_ROUTE_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'lock' }),
  })
  step('the device-action route keeps the trusted-origin fence', actionNoOrigin.status === 403, `HTTP ${actionNoOrigin.status}`)
  const actionWrongMethod = await fetch(`${origin}${DEVICE_ACTION_ROUTE_PATH}`, { method: 'GET', headers: { origin } })
  step('the device-action route only accepts POST', actionWrongMethod.status === 405, `HTTP ${actionWrongMethod.status}`)
  wda.__state.running = false
  wda.__state.device = undefined

  // ── 8. disposal unregisters the route and clears the registry ─────────────
  disposeRoutes()
  routes.dispose()
  const afterDispose = await fetch(`${origin}${REAL_START_ROUTE_PATH}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })
  step('route unregistration stops serving real-start', afterDispose.status === 404, `HTTP ${afterDispose.status}`)
  step('disposal clears the real-start registry', routes.realStartState(UDID) === undefined && routes.realStartState(OTHER_UDID) === undefined)
  step('real-start never called stop()/acquire() on the host', wda.__state.stopCalls === 0, 'the route only builds; lifecycle stays with the controller')
} catch (error) {
  step('real-start smoke completed without uncaught errors', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  try {
    disposeRoutes?.()
  } catch { /* already disposed */ }
  for (const server of servers) {
    try {
      await new Promise(resolveClose => server.close(resolveClose))
    } catch { /* server already closed */ }
  }
}

// ── the bundled playbook ──────────────────────────────────────────────────
// The knowledge agents re-derive every session (which observer is cheap, how
// to confirm a tap, why a Chinese label reads at 0.4) belongs somewhere the
// model reads BEFORE its first call. The registration path matters as much as
// the text: cordis refuses a bare `ctx.skills` property access on an
// undeclared service and the throw takes the WHOLE plugin down — that exact
// mistake broke the running host once, so the scoped-inject shape is pinned
// here too.
{
  const makeCtx = ({ withSkills }) => {
    const state = { registered: undefined, disposed: false, injected: undefined }
    const skillCtx = {
      // The factory's return value is the registration's DISPOSER; the skill
      // itself lands in state via `skills.register` below.
      effect(factory) { state.disposeSkill = factory(); return () => {} },
      skills: { register(skill) { state.registered = skill; return () => { state.registered = undefined } } },
    }
    return {
      state,
      logger: { warn() {} },
      inject(deps, callback) {
        state.injected = [...deps]
        if (withSkills) callback(skillCtx)
        return { dispose: async () => { state.disposed = true } }
      },
    }
  }
  const withSkills = makeCtx({ withSkills: true })
  const disposer = registerIosSkill(withSkills)
  step(
    'the skill is contributed through a SCOPED inject, never a bare property read',
    withSkills.state.injected?.join(',') === 'skills',
    `inject(${withSkills.state.injected?.join(',') ?? 'never called'}) — a bare ctx.skills access throws "without inject" and fails plugin load`,
  )
  const registered = withSkills.state.registered
  step(
    'it registers a model-invocable skill with routing metadata',
    registered?.name === 'ios-ui-automation'
      && typeof registered.description === 'string' && registered.description.length > 40
      && typeof registered.whenToUse === 'string' && registered.source === 'bundled',
    `name=${registered?.name} source=${registered?.source}`,
  )
  const body = registered?.content ?? ''
  step(
    'the playbook teaches the cheap observer first, with real costs',
    /ios_sim_find_text/.test(body) && /ios_sim_ui_tree/.test(body) && /32\.6 s/.test(body),
    'find_text before ui_tree, and why an uncapped real-device tree is unaffordable',
  )
  step(
    'it kills the two workarounds seen in the wild (raw curl, pixel diffing)',
    /never hand-build a gesture/i.test(body) && /curl/i.test(body)
      && /never compare screenshots or count pixels/i.test(body),
    'scroll is a verb; expect_text/wait_for is how you confirm',
  )
  step(
    'it carries the CJK confidence rule that silently breaks tap_text',
    /0\.3.{0,3}0\.6/.test(body) && /do NOT raise it/i.test(body),
    'raising min_confidence filters out exactly the CJK buttons being aimed at',
  )
  step(
    'it names the real-device failure reasons instead of "check the connection"',
    ['device-locked', 'device-unplugged', 'tunnel-failed', 'cert-untrusted', 'profile-expired']
      .every(reason => body.includes(reason)),
    'each coded reason maps to one user action',
  )
  disposer()
  step('the returned disposer tears the scoped fiber down', withSkills.state.disposed === true)
  const withoutSkills = makeCtx({ withSkills: false })
  const noopDisposer = registerIosSkill(withoutSkills)
  step(
    'a profile WITHOUT the skill service still loads (the callback never runs)',
    withoutSkills.state.registered === undefined && typeof noopDisposer === 'function',
    'the tools must not depend on the playbook being advertisable',
  )
  noopDisposer()
}

console.log('')
console.log(`${results.length} steps: ${results.filter(r => r.verdict === 'PASS').length} passed, ${results.filter(r => r.verdict === 'SKIP').length} skipped, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
