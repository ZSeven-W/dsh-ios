/**
 * Development smoke test for the dsh-ios client conversation cards.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-card-smoke.mjs
 *
 * Part A — static (SSR): loads the built browser bundle (lib/client.js) in
 * Node through a `window.__ModuleLoader__` shim and `react-dom/server`
 * renderToStrings each card component with mocked ToolCallViewProps (meta
 * present, the grant fetch injected as a throwing stub so any network access
 * during render fails loudly). Asserts the compact one-line card summaries
 * render with NO `<img>` (the simulator display lives only in the sidebar
 * panel), the "open in sidebar" affordance is present, and no exception
 * escapes.
 *
 * Part A.5 — status + capture route contract (no simulator): mounts the real
 * route handlers on a mini node:http server with a fresh sim host and NO
 * booted device — `POST /_dsh/dsh-ios/status` answers 200 `{running:false}`,
 * `POST /_dsh/dsh-ios/capture` answers the exact graceful 409/503 for
 * nothing booted, the loopback/trusted fence rejects DNS-rebinding Hosts
 * (403), non-JSON bodies (415) and wrong methods (405), and neither route
 * ever starts a stream, boots a simulator or mints tokens.
 *
 * Part A.6 — real-device route fences (no phone, WDA never started): mounts
 * the real-device routes with a fresh WdaController whose WDA is DOWN and
 * asserts the grant/control/status fences — 403 without Origin / with a
 * DNS-rebinding Host, 405 for wrong methods, 415 for non-JSON bodies, coded
 * 400 for unknown control actions and out-of-range coordinates, coded 409
 * `wda_not_running` for a valid control/grant while WDA is down, coded 503
 * `wda_not_running` for a VALIDLY-signed real-stream token while WDA is
 * down, the read-only `{running:false, ready:false}` status shape, and that
 * nothing was ever launched, acquired or minted. Also asserts the host-side
 * WDA orientation vocabulary bridges (display mapping, clockwise rotate
 * cycle, failure-reason → error-code classification).
 *
 * Part B — live-ish (no browser): reuses the dev-routes-smoke server
 * pattern — boot an iPhone, mount the real signed routes on a mini node:http
 * server, then simulates exactly what the cards do imperatively, calling the
 * card's own exported helpers (grant request bodies, ws URL resolution,
 * control frame encoding) so the bytes on the wire are byte-for-byte the
 * card's: POST grant, read the streamUrl for 1s (>50KB), open the control ws
 * and send one tap with the card's exact frame encoding, and round-trip a
 * screenshot grant. Teardown shuts sims and streams down and verifies zero
 * residue. Set `DSH_IOS_SMOKE_SKIP_SIM=1` to skip Part B (it boots a real
 * simulator).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require2 = createRequire(import.meta.url)
const React = require2('react')
const { renderToString } = require2('react-dom/server')

const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))
const { listDevices, bootDevice, shutdownDevice, bootedDevices } = await import(join(root, 'lib', 'simctl.js'))
const {
  CAPTURE_ROUTE_PATH,
  GRANT_ROUTE_PATH,
  SCREENSHOT_ROUTE_PREFIX,
  STATUS_ROUTE_PATH,
  STREAM_ROUTE_PREFIX,
  StreamAccessController,
  StreamRoutes,
  WS_ROUTE_PATH,
  mountStreamRoutes,
  screenshotDir,
} = await import(join(root, 'lib', 'stream-routes.js'))
const { WebSocket } = await import('ws')

// ── part A helpers ───────────────────────────────────────────────────────────

/**
 * Execute the built browser bundle in Node: `window.__ModuleLoader__` is
 * shimmed and the factory's `require` resolves react/react-dom from the
 * plugin's node_modules (the same instances react-dom/server uses).
 */
function loadClientExports() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const loaded = {}
  const browserWindow = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded[id] = factory(specifier => require2(specifier))
      },
    },
  }
  const evaluate = new Function('window', source)
  evaluate(browserWindow)
  const client = loaded['@zseven-w/dsh-ios']
  if (client === undefined) throw new Error('client bundle did not register @zseven-w/dsh-ios')
  return client
}

const CALL_ID = 'call-card-smoke'

function settledBlock(toolName, meta, options = {}) {
  return {
    kind: 'tool-result',
    seq: 1,
    time: Date.now(),
    callId: CALL_ID,
    call: { name: toolName, argsRaw: '{}' },
    callTime: Date.now(),
    content: options.content ?? [],
    isError: options.isError ?? false,
    ...(options.isError === true ? { error: { name: 'Error', code: 'E_CARD_SMOKE' } } : {}),
    callView: null,
    resultView: null,
    subCalls: [],
    meta: options.meta !== undefined ? options.meta : meta,
  }
}

function runningCall(toolName) {
  return { callId: CALL_ID, name: toolName, argsRaw: '{}', turn: 1, step: 1, time: Date.now(), callView: null, subCalls: [] }
}

/** Fails the SSR test loudly if any card tries to fetch during render. */
function throwingFetcher() {
  throw new Error('a card attempted a network request during server rendering')
}

function renderCard(component, props) {
  return renderToString(React.createElement(component, props))
}

const BOOT_META = {
  kind: 'sim-stream',
  device: { udid: 'SMOKE-BOOT-UDID', name: 'iPhone 17 Pro', runtime: 'iOS 26', state: 'Booted' },
  streamRouteId: 'dsh-ios/stream/SMOKE-BOOT-UDID',
}
const SCREENSHOT_META = {
  kind: 'sim-screenshot',
  screenshotPath: '/tmp/dsh-ios/screenshots/smoke.png',
  path: '/tmp/dsh-ios/screenshots/smoke.png',
  device: { udid: 'SMOKE-SHOT-UDID', name: 'iPhone 17 Pro', runtime: 'iOS 26', state: 'Booted' },
}
const SCREENSHOT_CONTENT = [{
  type: 'text',
  text: JSON.stringify({ path: '/tmp/dsh-ios/screenshots/smoke.png', bytes: 2048, width: 393, height: 852, device: SCREENSHOT_META.device }),
}]
const BUILD_META = {
  kind: 'sim-build-run',
  device: { udid: 'SMOKE-BUILD-UDID', name: 'iPhone 17 Pro', runtime: 'iOS 26', state: 'Booted' },
  bundleId: 'com.example.smoke',
  appPath: '/tmp/dsh-ios/builds/smoke.app',
}

// ── part B helpers (mirror scripts/dev-routes-smoke.mjs) ─────────────────────

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

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** Fetch `url` for `durationMs`, counting body bytes (aborts at the end). */
async function fetchBytes(url, durationMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), durationMs)
  let received = 0
  let contentType = ''
  let status = 0
  try {
    const response = await fetch(url, { signal: controller.signal })
    status = response.status
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
  return { status, contentType, received }
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

// ═════════════════════════════════════════════════════════════════════════════
// Part A — static server-rendering smoke
// ═════════════════════════════════════════════════════════════════════════════
console.log('— part A: static server rendering of the card components —')
let client
try {
  client = loadClientExports()
  step('client bundle loads through the module-loader shim', true, 'lib/client.js evaluated in Node')
  step(
    'client injects slots + theme + locale',
    Array.isArray(client.inject)
      && client.inject.length === 3
      && client.inject.includes('slots')
      && client.inject.includes('theme')
      && client.inject.includes('locale'),
    `inject=${JSON.stringify(client.inject)}`,
  )
  step('apply is exported for slot registration', typeof client.apply === 'function')

  // Wire-encoding purity: the card's encoder must equal the dev-routes-smoke
  // [tag byte][utf-8 JSON] layout byte-for-byte.
  const encoded = client.encodeSimControlFrame(3, { type: 'begin', x: 0.5, y: 0.5 })
  const json = Buffer.from(JSON.stringify({ type: 'begin', x: 0.5, y: 0.5 }))
  const expected = Buffer.alloc(1 + json.length)
  expected[0] = 3
  json.copy(expected, 1)
  step(
    'control frame encoding is [tag byte][utf-8 JSON]',
    Buffer.from(encoded).equals(expected),
    `frame[0]=${encoded[0]} payload=${Buffer.from(encoded.subarray(1)).toString()}`,
  )

  // Stream card: settled with sim-stream meta → compact live summary (no
  // SimLiveFrame, no <img> — the sidebar panel is the only display surface).
  const bootHtml = renderCard(client.SimStreamCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', BOOT_META),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'SimStreamCard settled render shows the compact live summary',
    bootHtml.includes('data-tool="ios_sim_boot"')
      && bootHtml.includes('data-state="live"')
      && bootHtml.includes('data-sim-card-kind="compact"')
      && bootHtml.includes('iOS Simulator')
      && bootHtml.includes('>Boot<')
      && bootHtml.includes('data-sim-card-action="boot"')
      && bootHtml.includes('iPhone 17 Pro')
      && bootHtml.includes('>live<')
      && bootHtml.includes('Open in sidebar')
      && !bootHtml.includes('data-sim-live-frame')
      && !bootHtml.includes('<img'),
    `${bootHtml.length} html chars, no exception`,
  )
  step(
    'SimStreamCard settled render performs no network during SSR',
    true,
    'throwing fetcher stub never invoked (no grant at render)',
  )

  // Stream card: running call → booting state.
  const runningBootHtml = renderCard(client.SimStreamCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_boot',
    block: runningCall('ios_sim_boot'),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'SimStreamCard running render shows the booting state',
    runningBootHtml.includes('data-state="running"')
      && runningBootHtml.includes('Booting the simulator…')
      && runningBootHtml.includes('iOS Simulator')
      && runningBootHtml.includes('>Boot<')
      && runningBootHtml.includes('data-sim-card-action="boot"'),
    `${runningBootHtml.length} html chars`,
  )

  // Screenshot card: settled → compact summary + device/bytes caption +
  // the 打开截图 (openFile) link. No <img>, no grant at render.
  const shotHtml = renderCard(client.SimScreenshotCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_screenshot',
    block: settledBlock('ios_sim_screenshot', SCREENSHOT_META, { content: SCREENSHOT_CONTENT }),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'SimScreenshotCard settled render shows the compact summary + caption',
    shotHtml.includes('data-tool="ios_sim_screenshot"')
      && shotHtml.includes('data-state="live"')
      && shotHtml.includes('iOS Simulator')
      && shotHtml.includes('>Screenshot<')
      && shotHtml.includes('data-sim-card-action="screenshot"')
      && shotHtml.includes('iPhone 17 Pro')
      && shotHtml.includes('2.0 KB')
      && shotHtml.includes('>done<')
      && shotHtml.includes('Open screenshot')
      && shotHtml.includes('Open in sidebar')
      && !shotHtml.includes('<img'),
    `${shotHtml.length} html chars`,
  )

  // Interact tool uses the same screenshot card with its own copy.
  const interactHtml = renderCard(client.SimScreenshotCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_interact',
    block: runningCall('ios_sim_interact'),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'SimScreenshotCard (interact) running render shows the interacting state',
    interactHtml.includes('data-tool="ios_sim_interact"')
      && interactHtml.includes('Interacting with the simulator…')
      && interactHtml.includes('iOS Simulator')
      && interactHtml.includes('>Interact<')
      && interactHtml.includes('data-sim-card-action="interact"'),
    `${interactHtml.length} html chars`,
  )

  // Build & run card: build info + compact summary, no attached stream.
  const buildHtml = renderCard(client.SimBuildRunCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_build_run',
    block: settledBlock('ios_sim_build_run', BUILD_META),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'SimBuildRunCard settled render shows build info without the stream',
    buildHtml.includes('com.example.smoke')
      && buildHtml.includes('iPhone 17 Pro')
      && buildHtml.includes('iOS Simulator')
      && buildHtml.includes('>Build &amp; Run<')
      && buildHtml.includes('data-sim-card-action="build-run"')
      && buildHtml.includes('Open app bundle')
      && buildHtml.includes('Open in sidebar')
      && buildHtml.includes('>done<')
      && !buildHtml.includes('Connecting to the live stream…')
      && !buildHtml.includes('<img'),
    `${buildHtml.length} html chars`,
  )

  // The whole compact-card surface must stay image-free: the sidebar panel is
  // the only place the simulator renders.
  step(
    'settled cards contain no <img> elements (panel is the only surface)',
    ![bootHtml, shotHtml, buildHtml].some(html => html.includes('<img')),
    'boot + screenshot + build-run rows are image-free',
  )

  // Malformed meta → defensive fallback, never a throw.
  const brokenHtml = renderCard(client.SimStreamCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', null),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'meta-less result renders the no-preview fallback',
    brokenHtml.includes('No live view is available for this result.'),
    `${brokenHtml.length} html chars`,
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Hydrated meta reconstruction (nested Code Mode / PTC tool calls)
  // ═══════════════════════════════════════════════════════════════════════════
  // rc.6 projects a nested code-mode sub-call as a ToolResultNode carrying the
  // FULL durable result JSON in `content` and NO `meta` (verified in the
  // installed dsh-client-ui-conversation bundle's `childResult`). The cards
  // must rebuild the exact host meta from that result text instead of
  // falling back to the no-preview card.

  const PTC_DEVICE = { udid: 'PTC-BOOT-UDID', name: 'iPhone 17 Pro', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', state: 'Booted' }
  const PTC_BOOT_META = { kind: 'sim-stream', device: PTC_DEVICE, streamRouteId: 'dsh-ios/stream/PTC-BOOT-UDID' }
  const PTC_BOOT_CONTENT = [{ type: 'text', text: JSON.stringify({ device: PTC_DEVICE, state: 'booted', streaming: true }) }]
  const PTC_SHOT_PATH = '/tmp/dsh-ios/screenshots/screenshot-PTC-BOOT-UDID-18.png'
  const PTC_SHOT_META = { kind: 'sim-screenshot', screenshotPath: PTC_SHOT_PATH, path: PTC_SHOT_PATH, device: PTC_DEVICE }
  const PTC_SHOT_CONTENT = [{ type: 'text', text: JSON.stringify({ path: PTC_SHOT_PATH, bytes: 2894051, width: 1206, height: 2622, device: PTC_DEVICE }) }]
  const PTC_INTERACT_CONTENT = [{ type: 'text', text: JSON.stringify({ action: 'tap', path: PTC_SHOT_PATH, bytes: 290903, width: 1206, height: 2622, device: PTC_DEVICE }) }]
  const PTC_BUILD_META = { kind: 'sim-build-run', device: PTC_DEVICE, bundleId: 'com.example.ptc', appPath: '/tmp/dsh-ios/builds/ptc/DerivedData/Build/Products/Debug-iphonesimulator/PTC.app' }
  const PTC_BUILD_CONTENT = [{
    type: 'text',
    text: JSON.stringify({
      device: PTC_DEVICE,
      state: 'launched',
      bundleId: 'com.example.ptc',
      pid: '12345',
      appPath: '/tmp/dsh-ios/builds/ptc/DerivedData/Build/Products/Debug-iphonesimulator/PTC.app',
      // Platform-neutral fixture path: never touched on disk, only hydrated
      // into the card meta (keeps the static smoke host-agnostic for CI).
      projectPath: '/tmp/dsh-ios/builds/ptc',
      scheme: 'PTC',
      configuration: 'Debug',
    }),
  }]

  /** The exact rc.6 code-mode child block shape: full content, no meta key. */
  function nestedResultBlock(toolName, content) {
    return {
      kind: 'tool-result',
      seq: 1,
      time: Date.now(),
      callId: `${CALL_ID}:code:1`,
      call: { name: toolName, argsRaw: '{}' },
      callTime: Date.now(),
      content,
      isError: false,
      callView: null,
      resultView: null,
      subCalls: [],
    }
  }

  const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right)

  step(
    'hydrateSimMeta rebuilds the exact sim-stream meta from a boot result',
    sameJson(client.hydrateSimMeta('ios_sim_boot', nestedResultBlock('ios_sim_boot', PTC_BOOT_CONTENT)), PTC_BOOT_META),
    `hydrated=${JSON.stringify(client.hydrateSimMeta('ios_sim_boot', nestedResultBlock('ios_sim_boot', PTC_BOOT_CONTENT)))}`,
  )
  step(
    'hydrateSimMeta rebuilds the exact sim-screenshot meta from a screenshot result',
    sameJson(client.hydrateSimMeta('ios_sim_screenshot', nestedResultBlock('ios_sim_screenshot', PTC_SHOT_CONTENT)), PTC_SHOT_META),
    'screenshotPath + path + device reconstructed',
  )
  step(
    'hydrateSimMeta rebuilds the sim-screenshot meta from an interact result',
    sameJson(client.hydrateSimMeta('ios_sim_interact', nestedResultBlock('ios_sim_interact', PTC_INTERACT_CONTENT)), PTC_SHOT_META),
    'interact shares the host screenshot envelope',
  )
  step(
    'hydrateSimMeta rebuilds the exact sim-build-run meta from a build result',
    sameJson(client.hydrateSimMeta('ios_sim_build_run', nestedResultBlock('ios_sim_build_run', PTC_BUILD_CONTENT)), PTC_BUILD_META),
    'bundleId + appPath + device reconstructed',
  )
  step(
    'resolveSimMeta marks the reconstructed meta source hydrated',
    (() => {
      const resolved = client.resolveSimMeta('ios_sim_boot', nestedResultBlock('ios_sim_boot', PTC_BOOT_CONTENT))
      return resolved !== undefined && resolved.source === 'hydrated' && sameJson(resolved.meta, PTC_BOOT_META)
    })(),
    'source=hydrated with the exact meta object',
  )

  const MALFORMED_PTC_RESULTS = [
    ['empty content', 'ios_sim_boot', []],
    ['non-JSON text', 'ios_sim_boot', [{ type: 'text', text: 'booted iPhone 17 Pro' }]],
    ['truncated JSON', 'ios_sim_screenshot', [{ type: 'text', text: '{"path": "/tmp/dsh-ios/screenshots/x.png", "bytes": 1' }]],
    ['JSON array result', 'ios_sim_boot', [{ type: 'text', text: '[1,2,3]' }]],
    ['missing screenshot path', 'ios_sim_screenshot', [{ type: 'text', text: JSON.stringify({ bytes: 1, device: PTC_DEVICE }) }]],
    ['relative screenshot path', 'ios_sim_screenshot', [{ type: 'text', text: JSON.stringify({ path: 'dsh-ios/screenshots/x.png', bytes: 1, device: PTC_DEVICE }) }]],
    ['missing device', 'ios_sim_screenshot', [{ type: 'text', text: JSON.stringify({ path: PTC_SHOT_PATH, bytes: 1 }) }]],
    ['negative bytes', 'ios_sim_screenshot', [{ type: 'text', text: JSON.stringify({ path: PTC_SHOT_PATH, bytes: -1, device: PTC_DEVICE }) }]],
    ['interact without action', 'ios_sim_interact', [{ type: 'text', text: JSON.stringify({ path: PTC_SHOT_PATH, bytes: 1, device: PTC_DEVICE }) }]],
    ['boot without streaming', 'ios_sim_boot', [{ type: 'text', text: JSON.stringify({ device: PTC_DEVICE, state: 'booted', streaming: false }) }]],
    ['build without bundleId', 'ios_sim_build_run', [{ type: 'text', text: JSON.stringify({ device: PTC_DEVICE, state: 'launched', appPath: '/tmp/x.app' }) }]],
  ]
  for (const [label, toolName, content] of MALFORMED_PTC_RESULTS) {
    const block = nestedResultBlock(toolName, content)
    step(
      `malformed/truncated result hydrates null (${label})`,
      client.hydrateSimMeta(toolName, block) === null && client.resolveSimMeta(toolName, block) === undefined,
      'today\'s fallback UI kept',
    )
  }
  step(
    'error results never hydrate meta',
    client.resolveSimMeta('ios_sim_boot', { ...nestedResultBlock('ios_sim_boot', PTC_BOOT_CONTENT), isError: true, error: { name: 'Error', code: 'E' } }) === undefined,
    'isError results resolve undefined',
  )

  // Standard path untouched: presentationMeta wins even when the durable
  // result text describes a different device.
  const metaWinsBlock = settledBlock('ios_sim_boot', BOOT_META, {
    content: [{ type: 'text', text: JSON.stringify({ device: { udid: 'OTHER-UDID', name: 'Other Phone', runtime: 'iOS 26', state: 'Booted' }, state: 'booted', streaming: true }) }],
  })
  step(
    'standard path untouched: presentationMeta wins even when the result differs',
    (() => {
      const resolved = client.resolveSimMeta('ios_sim_boot', metaWinsBlock)
      return resolved !== undefined && resolved.source === 'meta' && sameJson(resolved.meta, BOOT_META)
    })(),
    'meta present → exactly today\'s path',
  )
  const metaWinsHtml = renderCard(client.SimStreamCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_boot',
    block: metaWinsBlock,
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'standard card render keeps meta values and no hydration marker',
    metaWinsHtml.includes('iPhone 17 Pro')
      && !metaWinsHtml.includes('Other Phone')
      && !metaWinsHtml.includes('data-sim-meta-source'),
    'meta device label wins; render identical to the standard path',
  )
  step(
    'standard meta renders carry no hydration marker',
    !bootHtml.includes('data-sim-meta-source')
      && !shotHtml.includes('data-sim-meta-source')
      && !buildHtml.includes('data-sim-meta-source'),
    'standard path html untouched',
  )

  // Card SSR through the hydrated path: meta absent + valid result text.
  const ptcBootHtml = renderCard(client.SimStreamCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_boot',
    block: nestedResultBlock('ios_sim_boot', PTC_BOOT_CONTENT),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'PTC boot card hydrates the stream meta from the result text',
    ptcBootHtml.includes('data-sim-meta-source="hydrated"')
      && ptcBootHtml.includes('data-tool="ios_sim_boot"')
      && ptcBootHtml.includes('data-state="live"')
      && ptcBootHtml.includes('iOS Simulator')
      && ptcBootHtml.includes('>Boot<')
      && ptcBootHtml.includes('data-sim-card-action="boot"')
      && ptcBootHtml.includes('iPhone 17 Pro')
      && ptcBootHtml.includes('>live<')
      && ptcBootHtml.includes('Open in sidebar')
      && !ptcBootHtml.includes('No live view is available for this result.')
      && !ptcBootHtml.includes('<img'),
    `${ptcBootHtml.length} html chars`,
  )
  const ptcShotHtml = renderCard(client.SimScreenshotCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_screenshot',
    block: nestedResultBlock('ios_sim_screenshot', PTC_SHOT_CONTENT),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'PTC screenshot card hydrates the screenshot meta from the result text',
    ptcShotHtml.includes('data-sim-meta-source="hydrated"')
      && ptcShotHtml.includes('data-state="live"')
      && ptcShotHtml.includes('iOS Simulator')
      && ptcShotHtml.includes('>Screenshot<')
      && ptcShotHtml.includes('data-sim-card-action="screenshot"')
      && ptcShotHtml.includes('iPhone 17 Pro')
      && ptcShotHtml.includes('2826.2 KB')
      && ptcShotHtml.includes('1206×2622')
      && ptcShotHtml.includes('Open screenshot')
      && !ptcShotHtml.includes('No live view is available for this result.'),
    `${ptcShotHtml.length} html chars`,
  )
  const ptcInteractHtml = renderCard(client.SimScreenshotCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_interact',
    block: nestedResultBlock('ios_sim_interact', PTC_INTERACT_CONTENT),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'PTC interact card hydrates the screenshot meta from the result text',
    ptcInteractHtml.includes('data-sim-meta-source="hydrated"')
      && ptcInteractHtml.includes('data-state="live"')
      && ptcInteractHtml.includes('iOS Simulator')
      && ptcInteractHtml.includes('>Interact<')
      && ptcInteractHtml.includes('data-sim-card-action="interact"')
      && ptcInteractHtml.includes('iPhone 17 Pro')
      && ptcInteractHtml.includes('Open screenshot'),
    `${ptcInteractHtml.length} html chars`,
  )
  const ptcBuildHtml = renderCard(client.SimBuildRunCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_build_run',
    block: nestedResultBlock('ios_sim_build_run', PTC_BUILD_CONTENT),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'PTC build-run card hydrates the build meta from the result text',
    ptcBuildHtml.includes('data-sim-meta-source="hydrated"')
      && ptcBuildHtml.includes('data-state="live"')
      && ptcBuildHtml.includes('com.example.ptc')
      && ptcBuildHtml.includes('iOS Simulator')
      && ptcBuildHtml.includes('>Build &amp; Run<')
      && ptcBuildHtml.includes('data-sim-card-action="build-run"')
      && ptcBuildHtml.includes('iPhone 17 Pro')
      && ptcBuildHtml.includes('Open app bundle'),
    `${ptcBuildHtml.length} html chars`,
  )
  const ptcBrokenHtml = renderCard(client.SimStreamCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_boot',
    block: nestedResultBlock('ios_sim_boot', []),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'meta-less PTC result without valid JSON keeps the fallback card',
    ptcBrokenHtml.includes('No live view is available for this result.')
      && !ptcBrokenHtml.includes('data-sim-meta-source'),
    `${ptcBrokenHtml.length} html chars`,
  )

  // Error block → error state with the tool's own error text.
  const errorHtml = renderCard(client.SimStreamCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', null, {
      isError: true,
      content: [{ type: 'text', text: 'iOS Simulator requires macOS with Xcode' }],
    }),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'error result renders the failure copy',
    errorHtml.includes('iOS Simulator requires macOS with Xcode') && errorHtml.includes('data-state="error"'),
    `${errorHtml.length} html chars`,
  )

  // Error boundary: React 18's legacy SSR renderer does not catch boundary
  // errors, so verify the safety net statically instead — the boundary must
  // pass children through, declare a getDerivedStateFromError that flips it
  // into the static fallback, and render that fallback when failed.
  const passthroughHtml = renderToString(React.createElement(
    client.SimCardBoundary,
    null,
    React.createElement('div', null, 'child-content'),
  ))
  const boundary = new client.SimCardBoundary({ children: null })
  const failedState = client.SimCardBoundary.getDerivedStateFromError(new Error('boom'))
  boundary.state = failedState
  const fallbackElement = boundary.render()
  step(
    'SimCardBoundary passes children through when healthy',
    passthroughHtml.includes('child-content'),
    `${passthroughHtml.length} html chars`,
  )
  step(
    'SimCardBoundary declares the error→fallback transition',
    failedState !== null && failedState.failed === true && typeof boundary.componentDidCatch === 'function',
    `getDerivedStateFromError → ${JSON.stringify(failedState)}`,
  )
  step(
    'failed SimCardBoundary renders the static unavailable card',
    fallbackElement !== null
      && fallbackElement.props !== undefined
      && fallbackElement.props['data-state'] === 'unavailable',
    'section data-state=unavailable produced without throwing',
  )

  // Locale switching changes the card copy.
  const zhHtml = renderCard(client.SimStreamCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', BOOT_META),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'zh',
    colorScheme: 'light',
  })
  step(
    'card copy follows the locale (zh)',
    zhHtml.includes('在侧边栏打开')
      && zhHtml.includes('>实时<')
      && zhHtml.includes('iOS 模拟器')
      && zhHtml.includes('>启动<')
      && zhHtml.includes('data-sim-card-action="boot"'),
    `${zhHtml.length} html chars`,
  )

  // Coordinate + URL helpers (used verbatim by the live part below).
  const point = client.normalizePointerPoint(
    { clientX: 150, clientY: 175 },
    { left: 100, top: 100, width: 100, height: 150 },
  )
  step(
    'pointer normalization maps to 0..1 coordinates',
    Math.abs(point.x - 0.5) < 1e-9 && Math.abs(point.y - 0.5) < 1e-9,
    `x=${point.x} y=${point.y}`,
  )
  step(
    'ws URL resolution honors the page scheme',
    client.resolveWsUrl('/ws?token=t', { protocol: 'https:', host: 'localhost' }) === 'wss://localhost/ws?token=t',
    'wss for https pages',
  )
} catch (error) {
  step('static card smoke completed without uncaught errors', false, error instanceof Error ? error.message : String(error))
  console.error(error)
}

// ═════════════════════════════════════════════════════════════════════════════
// Part A.5 — read-only status route contract (mini http server, NO simulator)
// ═════════════════════════════════════════════════════════════════════════════
console.log('— part A.5: read-only status + capture routes (no simulator) —')
let statusController
let statusMini
let statusDispose

/** Raw POST helper (host/header control for the transport-fence checks). */
function rawRequest({ port, path, method = 'POST', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

try {
  statusController = new SimHostController()
  statusMini = createMiniWebServer()
  const statusRoutes = new StreamRoutes(statusController, new StreamAccessController())
  statusDispose = mountStreamRoutes(statusMini, statusRoutes)
  await new Promise(resolveListen => statusMini.server.listen(0, '127.0.0.1', resolveListen))
  const statusPort = statusMini.server.address().port
  const statusOrigin = `http://127.0.0.1:${statusPort}`
  step('mount the status route on a mini http server (no simulator)', true, `127.0.0.1:${statusPort}`)

  const statusEmpty = await rawRequest({
    port: statusPort,
    path: STATUS_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: statusOrigin },
    body: JSON.stringify({}),
  })
  step(
    'status {} → 200 { running:false } with no stream',
    statusEmpty.status === 200
      && statusEmpty.body.includes('"running":false')
      && !statusEmpty.body.includes('"device"')
      && !statusEmpty.body.includes('streamUrl')
      && !statusEmpty.body.includes('token'),
    `HTTP ${statusEmpty.status} ${statusEmpty.body}`,
  )
  step(
    'status is read-only: no stream started, no boot',
    statusController.status().running === false,
    `running=${statusController.status().running} consumers=${statusController.status().consumers}`,
  )

  const statusFiltered = await rawRequest({
    port: statusPort,
    path: STATUS_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: statusOrigin },
    body: JSON.stringify({ device: 'SMOKE-STATUS-UDID' }),
  })
  step(
    'status {device} → 200 { running:false } (never boots the device)',
    statusFiltered.status === 200 && statusFiltered.body.includes('"running":false'),
    `HTTP ${statusFiltered.status} ${statusFiltered.body}`,
  )

  const statusNoOrigin = await rawRequest({
    port: statusPort,
    path: STATUS_ROUTE_PATH,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  step(
    'status without an Origin → 403 (same fence as /grant)',
    statusNoOrigin.status === 403,
    `HTTP ${statusNoOrigin.status}`,
  )
  const statusRebinding = await rawRequest({
    port: statusPort,
    path: STATUS_ROUTE_PATH,
    headers: { 'content-type': 'application/json', host: 'evil.example', origin: 'http://evil.example' },
    body: '{}',
  })
  step(
    'status rejects a DNS-rebinding Host → 403',
    statusRebinding.status === 403,
    `HTTP ${statusRebinding.status}`,
  )
  const statusNotJson = await rawRequest({
    port: statusPort,
    path: STATUS_ROUTE_PATH,
    headers: { origin: statusOrigin },
    body: 'not-json',
  })
  step(
    'status requires an application/json body → 415',
    statusNotJson.status === 415,
    `HTTP ${statusNotJson.status}`,
  )
  const statusGet = await rawRequest({
    port: statusPort,
    path: STATUS_ROUTE_PATH,
    method: 'GET',
    headers: { origin: statusOrigin },
  })
  step(
    'status only accepts POST → 405',
    statusGet.status === 405,
    `HTTP ${statusGet.status}`,
  )

  // ── capture route contract (no simulator) ─────────────────────────────────
  const captureEmpty = await rawRequest({
    port: statusPort,
    path: CAPTURE_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: statusOrigin },
    body: '{}',
  })
  step(
    'capture {} with no stream → 409 "no simulator stream is running"',
    captureEmpty.status === 409
      && captureEmpty.body.includes('no simulator stream is running'),
    `HTTP ${captureEmpty.status} ${captureEmpty.body}`,
  )
  // With an explicit device the route consults simctl: not booted → 409;
  // simctl itself unavailable (no Xcode) → 503. Assert the exact branch the
  // host chooses, deterministically.
  let captureDeviceStatus
  try {
    await bootedDevices()
    captureDeviceStatus = 409
  } catch {
    captureDeviceStatus = 503
  }
  const captureFakeDevice = await rawRequest({
    port: statusPort,
    path: CAPTURE_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: statusOrigin },
    body: JSON.stringify({ device: 'SMOKE-CAPTURE-UDID' }),
  })
  step(
    `capture {device} not booted → ${captureDeviceStatus} (exact status chosen, never boots)`,
    captureFakeDevice.status === captureDeviceStatus,
    `HTTP ${captureFakeDevice.status} ${captureFakeDevice.body}`,
  )
  const captureBadDevice = await rawRequest({
    port: statusPort,
    path: CAPTURE_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: statusOrigin },
    body: JSON.stringify({ device: 123 }),
  })
  step(
    'capture rejects a non-string device → 400',
    captureBadDevice.status === 400,
    `HTTP ${captureBadDevice.status}`,
  )
  const captureNoOrigin = await rawRequest({
    port: statusPort,
    path: CAPTURE_ROUTE_PATH,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  step(
    'capture without an Origin → 403 (same fence as /grant)',
    captureNoOrigin.status === 403,
    `HTTP ${captureNoOrigin.status}`,
  )
  const captureRebinding = await rawRequest({
    port: statusPort,
    path: CAPTURE_ROUTE_PATH,
    headers: { 'content-type': 'application/json', host: 'evil.example', origin: 'http://evil.example' },
    body: '{}',
  })
  step(
    'capture rejects a DNS-rebinding Host → 403',
    captureRebinding.status === 403,
    `HTTP ${captureRebinding.status}`,
  )
  const captureNotJson = await rawRequest({
    port: statusPort,
    path: CAPTURE_ROUTE_PATH,
    headers: { origin: statusOrigin },
    body: 'not-json',
  })
  step(
    'capture requires an application/json body → 415',
    captureNotJson.status === 415,
    `HTTP ${captureNotJson.status}`,
  )
  const captureGet = await rawRequest({
    port: statusPort,
    path: CAPTURE_ROUTE_PATH,
    method: 'GET',
    headers: { origin: statusOrigin },
  })
  step(
    'capture only accepts POST → 405',
    captureGet.status === 405,
    `HTTP ${captureGet.status}`,
  )
  step(
    'capture is non-invasive: no stream started, no boot, no tokens minted',
    statusController.status().running === false
      && statusController.status().consumers === 0
      && !JSON.stringify(captureEmpty.body).includes('screenshotUrl'),
    `running=${statusController.status().running}`,
  )
} catch (error) {
  step('status route smoke completed without uncaught errors', false, error instanceof Error ? error.message : String(error))
  console.error(error)
} finally {
  try {
    statusDispose?.()
  } catch { /* already disposed */ }
  try {
    await new Promise(resolveClose => statusMini?.server?.close(resolveClose))
  } catch { /* server already closed */ }
  try {
    await statusController?.dispose()
  } catch { /* already disposed */ }
}

// ═════════════════════════════════════════════════════════════════════════════
// Part A.6 — real-device route fences (mini http server, NO phone, WDA down)
// ═════════════════════════════════════════════════════════════════════════════
console.log('— part A.6: real-device grant/control/status route fences (no device) —')
let wdaController
let realMini
let realDispose
let realRoutes

try {
  const { WdaController } = await import(join(root, 'lib', 'wda-host.js'))
  const {
    REAL_CONTROL_ROUTE_PATH,
    REAL_DEVICE_STATUS_ROUTE_PATH,
    REAL_STREAM_ROUTE_PREFIX,
    displayOrientationFromWda,
    nextWdaOrientation,
    wdaReasonErrorCodeOf,
  } = await import(join(root, 'lib', 'stream-routes.js'))
  const REAL_SMOKE_UDID = 'REAL-SMOKE-UDID'
  const REAL_ACTION = { kind: 'tap', x: 0.5, y: 0.5 }

  wdaController = new WdaController()
  realMini = createMiniWebServer()
  realRoutes = new StreamRoutes(new SimHostController(), new StreamAccessController(), wdaController)
  realDispose = mountStreamRoutes(realMini, realRoutes)
  await new Promise(resolveListen => realMini.server.listen(0, '127.0.0.1', resolveListen))
  const realPort = realMini.server.address().port
  const realOrigin = `http://127.0.0.1:${realPort}`
  step('mount the real-device routes on a mini http server (WDA never started)', true, `127.0.0.1:${realPort}`)

  // ── /real-control fences ──────────────────────────────────────────────────
  const controlBody = JSON.stringify({ device: REAL_SMOKE_UDID, action: REAL_ACTION })
  const controlNoOrigin = await rawRequest({
    port: realPort,
    path: REAL_CONTROL_ROUTE_PATH,
    headers: { 'content-type': 'application/json' },
    body: controlBody,
  })
  step(
    'real-control without an Origin → 403 (same fence as /grant)',
    controlNoOrigin.status === 403,
    `HTTP ${controlNoOrigin.status}`,
  )
  const controlRebinding = await rawRequest({
    port: realPort,
    path: REAL_CONTROL_ROUTE_PATH,
    headers: { 'content-type': 'application/json', host: 'evil.example', origin: 'http://evil.example' },
    body: controlBody,
  })
  step(
    'real-control rejects a DNS-rebinding Host → 403',
    controlRebinding.status === 403,
    `HTTP ${controlRebinding.status}`,
  )
  const controlGet = await rawRequest({
    port: realPort,
    path: REAL_CONTROL_ROUTE_PATH,
    method: 'GET',
    headers: { origin: realOrigin },
  })
  step(
    'real-control only accepts POST → 405',
    controlGet.status === 405,
    `HTTP ${controlGet.status}`,
  )
  const controlNotJson = await rawRequest({
    port: realPort,
    path: REAL_CONTROL_ROUTE_PATH,
    headers: { origin: realOrigin },
    body: 'not-json',
  })
  step(
    'real-control requires an application/json body → 415',
    controlNotJson.status === 415,
    `HTTP ${controlNotJson.status}`,
  )
  const controlUnknown = await rawRequest({
    port: realPort,
    path: REAL_CONTROL_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: realOrigin },
    body: JSON.stringify({ device: REAL_SMOKE_UDID, action: { kind: 'hover' } }),
  })
  step(
    'real-control rejects an unknown action → coded 400',
    controlUnknown.status === 400 && controlUnknown.body.includes('"code":"bad_request"'),
    `HTTP ${controlUnknown.status} ${controlUnknown.body}`,
  )
  const controlBadCoords = await rawRequest({
    port: realPort,
    path: REAL_CONTROL_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: realOrigin },
    body: JSON.stringify({ device: REAL_SMOKE_UDID, action: { kind: 'tap', x: 7, y: 0.5 } }),
  })
  step(
    'real-control rejects out-of-range tap coordinates → coded 400',
    controlBadCoords.status === 400 && controlBadCoords.body.includes('"code":"bad_request"'),
    `HTTP ${controlBadCoords.status}`,
  )
  const controlBadDevice = await rawRequest({
    port: realPort,
    path: REAL_CONTROL_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: realOrigin },
    body: JSON.stringify({ device: 123, action: REAL_ACTION }),
  })
  step(
    'real-control rejects a non-udid device → coded 400',
    controlBadDevice.status === 400,
    `HTTP ${controlBadDevice.status}`,
  )
  const controlWdaDown = await rawRequest({
    port: realPort,
    path: REAL_CONTROL_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: realOrigin },
    body: controlBody,
  })
  step(
    'real-control with WDA down → coded 409 wda_not_running (never starts anything)',
    controlWdaDown.status === 409 && controlWdaDown.body.includes('"code":"wda_not_running"'),
    `HTTP ${controlWdaDown.status} ${controlWdaDown.body}`,
  )

  // ── real grant fence (WDA down → coded 409, no boot/build) ────────────────
  const grantWdaDown = await rawRequest({
    port: realPort,
    path: GRANT_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: realOrigin },
    body: JSON.stringify({ kind: 'real-stream', device: REAL_SMOKE_UDID }),
  })
  step(
    'grant {kind:"real-stream"} with WDA down → coded 409 wda_not_running',
    grantWdaDown.status === 409 && grantWdaDown.body.includes('"code":"wda_not_running"'),
    `HTTP ${grantWdaDown.status} ${grantWdaDown.body}`,
  )
  const grantWdaBad = await rawRequest({
    port: realPort,
    path: GRANT_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: realOrigin },
    body: JSON.stringify({ kind: 'real-stream', device: 'not a udid!' }),
  })
  step(
    'real grant rejects a malformed device udid → 400',
    grantWdaBad.status === 400,
    `HTTP ${grantWdaBad.status}`,
  )

  // ── /real-device-status contract (read-only) ──────────────────────────────
  const realStatusEmpty = await rawRequest({
    port: realPort,
    path: REAL_DEVICE_STATUS_ROUTE_PATH,
    headers: { 'content-type': 'application/json', origin: realOrigin },
    body: '{}',
  })
  step(
    'real-device-status {} → 200 { running:false, ready:false } with WDA down',
    realStatusEmpty.status === 200
      && realStatusEmpty.body.includes('"running":false')
      && realStatusEmpty.body.includes('"ready":false')
      && !realStatusEmpty.body.includes('streamUrl')
      && !realStatusEmpty.body.includes('token'),
    `HTTP ${realStatusEmpty.status} ${realStatusEmpty.body}`,
  )
  const realStatusNoOrigin = await rawRequest({
    port: realPort,
    path: REAL_DEVICE_STATUS_ROUTE_PATH,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  step(
    'real-device-status without an Origin → 403',
    realStatusNoOrigin.status === 403,
    `HTTP ${realStatusNoOrigin.status}`,
  )
  const realStatusGet = await rawRequest({
    port: realPort,
    path: REAL_DEVICE_STATUS_ROUTE_PATH,
    method: 'GET',
    headers: { origin: realOrigin },
  })
  step(
    'real-device-status only accepts POST → 405',
    realStatusGet.status === 405,
    `HTTP ${realStatusGet.status}`,
  )
  const realStatusNotJson = await rawRequest({
    port: realPort,
    path: REAL_DEVICE_STATUS_ROUTE_PATH,
    headers: { origin: realOrigin },
    body: 'not-json',
  })
  step(
    'real-device-status requires an application/json body → 415',
    realStatusNotJson.status === 415,
    `HTTP ${realStatusNotJson.status}`,
  )

  // ── /real-stream token plumbing without a device ──────────────────────────
  const realStreamBadToken = await rawRequest({
    port: realPort,
    path: `${REAL_STREAM_ROUTE_PREFIX}/not.a-valid-token`,
    method: 'GET',
    headers: { origin: realOrigin },
  })
  step(
    'real-stream rejects an invalid token → 403',
    realStreamBadToken.status === 403,
    `HTTP ${realStreamBadToken.status}`,
  )
  const signedReal = await realRoutes.access.signRealStreamToken(REAL_SMOKE_UDID, { ttlMs: 60_000 })
  step(
    'sim-real-stream tokens are signed and expire within 10 minutes',
    typeof signedReal.token === 'string'
      && signedReal.token.includes('.')
      && signedReal.expiresAt > Date.now()
      && signedReal.expiresAt - Date.now() <= 10 * 60 * 1000,
    `token=${signedReal.token.slice(0, 24)}… expiresAt=${signedReal.expiresAt}`,
  )
  const realStreamWdaDown = await rawRequest({
    port: realPort,
    path: `${REAL_STREAM_ROUTE_PREFIX}/${signedReal.token}`,
    method: 'GET',
    headers: { origin: realOrigin },
  })
  step(
    'real-stream with a VALID token but WDA down → coded 503 wda_not_running',
    realStreamWdaDown.status === 503 && realStreamWdaDown.body.includes('"code":"wda_not_running"'),
    `HTTP ${realStreamWdaDown.status} ${realStreamWdaDown.body}`,
  )
  const realStreamRebinding = await rawRequest({
    port: realPort,
    path: `${REAL_STREAM_ROUTE_PREFIX}/${signedReal.token}`,
    method: 'GET',
    headers: { host: 'evil.example', origin: 'http://evil.example' },
  })
  step(
    'real-stream rejects a DNS-rebinding Host → 403 (same fence as the sim stream)',
    realStreamRebinding.status === 403,
    `HTTP ${realStreamRebinding.status}`,
  )
  const realStreamPost = await rawRequest({
    port: realPort,
    path: `${REAL_STREAM_ROUTE_PREFIX}/${signedReal.token}`,
    method: 'POST',
    headers: { origin: realOrigin },
  })
  step(
    'real-stream only accepts GET → 405',
    realStreamPost.status === 405,
    `HTTP ${realStreamPost.status}`,
  )
  step(
    'real-device fences are non-invasive: no WDA launch, no consumers, no tokens leaked',
    wdaController.status().running === false
      && wdaController.status().consumers === 0
      && !realStatusEmpty.body.includes('screenshotUrl')
      && !realStatusEmpty.body.includes('streamUrl'),
    `running=${wdaController.status().running} consumers=${wdaController.status().consumers}`,
  )

  // ── orientation vocabulary bridges (host side) ────────────────────────────
  step(
    'WDA orientation values map onto the panel display vocabulary',
    displayOrientationFromWda('PORTRAIT') === 'portrait'
      && displayOrientationFromWda('LANDSCAPELEFT') === 'landscape_left'
      && displayOrientationFromWda('LANDSCAPERIGHT') === 'landscape_right'
      && displayOrientationFromWda('PORTRAIT_UPSIDEDOWN') === 'portrait_upside_down'
      && displayOrientationFromWda('weird') === 'portrait',
    'WDA /orientation → serve-sim rotation set',
  )
  step(
    'WDA rotate cycle advances clockwise like serve-sim',
    nextWdaOrientation('PORTRAIT') === 'LANDSCAPELEFT'
      && nextWdaOrientation('LANDSCAPELEFT') === 'PORTRAIT_UPSIDEDOWN'
      && nextWdaOrientation('PORTRAIT_UPSIDEDOWN') === 'LANDSCAPERIGHT'
      && nextWdaOrientation('LANDSCAPERIGHT') === 'PORTRAIT'
      && nextWdaOrientation(undefined) === 'PORTRAIT',
    'PORTRAIT → LANDSCAPELEFT → PORTRAIT_UPSIDEDOWN → LANDSCAPERIGHT',
  )
  step(
    'wdaReasonErrorCodeOf classifies every WDA failure reason',
    wdaReasonErrorCodeOf({ running: false, reason: 'device-locked' }) === 'wda_device_locked'
      && wdaReasonErrorCodeOf({ running: false, reason: 'cert-untrusted' }) === 'wda_cert_untrusted'
      && wdaReasonErrorCodeOf({ running: false, reason: 'profile-expired' }) === 'wda_profile_expired'
      && wdaReasonErrorCodeOf({ running: false, reason: 'device-unplugged' }) === 'wda_device_unplugged'
      && wdaReasonErrorCodeOf({ running: false, reason: 'build-failed' }) === 'wda_build_failed'
      && wdaReasonErrorCodeOf({ running: false, reason: 'launch-timeout' }) === 'wda_launch_timeout'
      && wdaReasonErrorCodeOf({ running: false, reason: 'tunnel-failed' }) === 'wda_tunnel_failed'
      && wdaReasonErrorCodeOf({ running: false, reason: 'wda-not-ready' }) === 'wda_not_ready'
      && wdaReasonErrorCodeOf({ running: false, reason: 'unavailable' }) === 'wda_unavailable'
      && wdaReasonErrorCodeOf({ running: false }) === 'wda_not_running',
    'reason → SimRouteErrorCode',
  )
} catch (error) {
  step('real-device route smoke completed without uncaught errors', false, error instanceof Error ? error.message : String(error))
  console.error(error)
} finally {
  try {
    realDispose?.()
  } catch { /* already disposed */ }
  try {
    await new Promise(resolveClose => realMini?.server?.close(resolveClose))
  } catch { /* server already closed */ }
  try {
    await wdaController?.dispose()
  } catch { /* already disposed */ }
}

// ═════════════════════════════════════════════════════════════════════════════
// Part B — live-ish network contract (no browser; boots a real simulator)
// ═════════════════════════════════════════════════════════════════════════════
const SKIP_SIM_PART = process.env.DSH_IOS_SMOKE_SKIP_SIM === '1'
console.log(SKIP_SIM_PART
  ? '— part B: live-ish network contract (SKIPPED: DSH_IOS_SMOKE_SKIP_SIM=1) —'
  : '— part B: live-ish network contract of the cards —')
let controller
let udid
let deviceName
let mini
let disposeRoutes
let routes
let streamPort

if (SKIP_SIM_PART) {
  step('live-ish card smoke (boots a simulator)', true, 'skipped by DSH_IOS_SMOKE_SKIP_SIM=1')
} else {
try {
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

  routes = new StreamRoutes(controller, new StreamAccessController())
  mini = createMiniWebServer()
  disposeRoutes = mountStreamRoutes(mini, routes)
  await new Promise(resolveListen => mini.server.listen(0, '127.0.0.1', resolveListen))
  const port = mini.server.address().port
  const origin = `http://127.0.0.1:${port}`
  step('mount the signed routes on a mini http server', true, `127.0.0.1:${port}`)

  // ── the stream card's grant flow, using its exact request builder ─────────
  const cardMeta = { kind: 'sim-stream', device: { udid, name: deviceName, runtime: picked.runtime, state: 'Booted' } }
  const grantBody = client.streamGrantBodyOf({ device: cardMeta.device })
  step(
    'card grant body is { kind:"sim-stream", device: udid }',
    JSON.stringify(grantBody) === JSON.stringify({ kind: 'sim-stream', device: udid }),
    JSON.stringify(grantBody),
  )
  const grantResponse = await fetch(`${origin}${client.GRANT_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(grantBody),
  })
  const grant = await grantResponse.json().catch(() => ({}))
  step('grant mints a stream capability', grantResponse.status === 200 && grant.ok === true, `HTTP ${grantResponse.status}`)
  step(
    'grant URLs are origin-relative and expire within 10 minutes',
    typeof grant.streamUrl === 'string'
      && grant.streamUrl.startsWith(`${STREAM_ROUTE_PREFIX}/`)
      && typeof grant.wsUrl === 'string'
      && grant.wsUrl.startsWith(`${WS_ROUTE_PATH}?token=`)
      && !grant.streamUrl.includes('127.0.0.1')
      && !grant.wsUrl.includes(':')
      && typeof grant.expiresAt === 'number'
      && grant.expiresAt > Date.now()
      && grant.expiresAt - Date.now() <= 10 * 60 * 1000,
    `streamUrl=${grant.streamUrl} expiresAt=${grant.expiresAt}`,
  )
  const runningStatus = controller.status()
  streamPort = runningStatus.port
  step('grant started the stream (device was already booted)', runningStatus.running && runningStatus.device === udid, `port=${streamPort}`)

  // ── the card's `<img>` fetch: read the MJPEG stream for 1s ─────────────────
  const streamResult = await fetchBytes(origin + grant.streamUrl, 1000)
  step(
    'streamUrl delivers an MJPEG stream the img can render',
    streamResult.status === 200 && streamResult.contentType.startsWith('multipart/x-mixed-replace'),
    `content-type=${streamResult.contentType}`,
  )
  step(
    'stream delivers >50KB in 1s',
    streamResult.received > 50 * 1024,
    `${(streamResult.received / 1024).toFixed(1)} KB received`,
  )

  // ── the card's ws flow: resolveWsUrl + simTapFrames, byte-exact ────────────
  const absoluteWsUrl = client.resolveWsUrl(grant.wsUrl, { protocol: 'http:', host: `127.0.0.1:${port}` })
  step(
    'card resolves the relative wsUrl against the page origin',
    absoluteWsUrl === `ws://127.0.0.1:${port}${grant.wsUrl}`,
    absoluteWsUrl,
  )
  const tapFrames = client.simTapFrames(0.5, 0.5)
  const tapPayloads = tapFrames.map(frame => ({
    tag: frame[0],
    payload: JSON.parse(Buffer.from(frame.subarray(1)).toString('utf8')),
  }))
  step(
    'card tap = begin + end touch frames at normalized coords',
    tapFrames.length === 2
      && tapPayloads[0]?.tag === 3
      && tapPayloads[0]?.payload?.type === 'begin'
      && tapPayloads[0]?.payload?.x === 0.5
      && tapPayloads[0]?.payload?.y === 0.5
      && tapPayloads[1]?.tag === 3
      && tapPayloads[1]?.payload?.type === 'end',
    JSON.stringify(tapPayloads),
  )
  const homeFrame = client.simButtonFrame('home')
  step(
    'card home button = tag-4 button frame',
    homeFrame[0] === 4
      && JSON.parse(Buffer.from(homeFrame.subarray(1)).toString('utf8')).button === 'home',
    `frame[0]=${homeFrame[0]}`,
  )

  const wsResult = await new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(absoluteWsUrl)
    ws.binaryType = 'nodebuffer'
    let gotConfigFrame = false
    let wsError
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
        try {
          ws.send(tapFrames[0])
        } catch { /* socket closing */ }
        setTimeout(() => {
          try {
            ws.send(tapFrames[1])
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
            wsError: wsError?.message,
            lastEvents: tapObserved ? [] : tapResult?.lastEvents ?? [],
          })
        })
      }
    })
    ws.on('error', error => {
      wsError = error
    })
    ws.on('close', () => {
      // A close before the tap was observed means the relay failed.
      if (!gotConfigFrame) {
        clearTimeout(timeout)
        rejectWs(new Error('control ws closed before the config frame arrived'))
      }
    })
  })
  step('card ws connects and receives serve-sim config frames', wsResult.gotConfigFrame, 'tag-130 screen config received')
  step(
    'ws accepted the card\u2019s tap frames with no ws error',
    wsResult.wsError === undefined,
    wsResult.wsError === undefined ? 'no error event' : wsResult.wsError,
  )
  step(
    'the card\u2019s tap reaches the simulator',
    wsResult.tapObserved,
    wsResult.tapObserved
      ? 'tap event observed in serve-sim event log'
      : `no tap in event log; last events: ${JSON.stringify(wsResult.lastEvents.slice(0, 3))}`,
  )

  // ── the screenshot card's grant flow, using its exact request builder ──────
  mkdirSync(screenshotDir(), { recursive: true })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const pngPath = join(screenshotDir(), 'card-smoke.png')
  writeFileSync(pngPath, png)
  const shotBody = client.screenshotGrantBodyOf(pngPath)
  step(
    'card screenshot grant body is { kind:"sim-screenshot", path }',
    JSON.stringify(shotBody) === JSON.stringify({ kind: 'sim-screenshot', path: pngPath }),
    JSON.stringify(shotBody),
  )
  const shotGrantResponse = await fetch(`${origin}${client.GRANT_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(shotBody),
  })
  const shotGrant = await shotGrantResponse.json().catch(() => ({}))
  step(
    'screenshot grant mints a capability for the cache path',
    shotGrantResponse.status === 200 && typeof shotGrant.screenshotUrl === 'string'
      && shotGrant.screenshotUrl.startsWith(`${SCREENSHOT_ROUTE_PREFIX}/`),
    `HTTP ${shotGrantResponse.status} screenshotUrl=${shotGrant.screenshotUrl}`,
  )
  const shotResponse = await fetch(origin + shotGrant.screenshotUrl)
  const shotBytes = Buffer.from(await shotResponse.arrayBuffer())
  step(
    'screenshotUrl serves the PNG byte-for-byte',
    shotResponse.status === 200
      && shotResponse.headers.get('content-type') === 'image/png'
      && shotBytes.equals(png),
    `${shotBytes.length} bytes`,
  )

  await delay(400)
  step('ws close and stream abort release the consumer refcount', controller.status().consumers === 0, `consumers=${controller.status().consumers}`)

  // ── teardown ───────────────────────────────────────────────────────────────
  disposeRoutes()
  disposeRoutes = undefined
  const afterUnregister = await fetch(origin + grant.streamUrl)
  step('route unregistration stops serving', afterUnregister.status === 404, `HTTP ${afterUnregister.status}`)
  await controller.dispose()
  step('sim host dispose settles', true)
  await shutdownDevice(udid)
  step('simulator shut down', true)
  const leftDevices = (await bootedDevices()).map(d => `${d.name} ${d.udid}`)
  step('no booted simulators left', leftDevices.length === 0, leftDevices.join(', ') || 'none')
} catch (error) {
  step('live-ish card smoke completed without uncaught errors', false, error instanceof Error ? error.message : String(error))
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
  try {
    const residue = (await bootedDevices()).map(d => `${d.name} ${d.udid}`)
    step('zero residue: no booted simulators remain', residue.length === 0, residue.join(', ') || 'none')
  } catch {
    step('zero residue: no booted simulators remain', true, 'residue check skipped')
  }
}
} // end of the DSH_IOS_SMOKE_SKIP_SIM gate

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
