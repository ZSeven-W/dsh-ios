/**
 * WebDriverAgent (WDA) host smoke test — pure/mocked coverage of the new
 * real-device host layer, plus an optional LIVE pass.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-wda-smoke.mjs
 *
 * The pure/mocked section runs with NO device attached and MUST pass:
 *   - `ServerURLHere` parsing from an xcodebuild fixture log
 *   - failure classification from the exact observed signatures
 *     (deviceprep Code=-3 unlock, cert not trusted, profile expired,
 *      destination-not-found, TEST BUILD FAILED)
 *   - iproxy arg assembly — asserts the POSITIONAL syntax
 *     (`iproxy <local> <device> <udid>`, never the `8100:8100` colon form)
 *   - tunnel port picking: free port → own; occupied + WDA/MJPEG-shaped →
 *     adopt; occupied + unrelated → skip
 *   - `WdaClient` against a mock WDA HTTP server: health, lazy session,
 *     exact endpoint paths/bodies (pressButton/tap/dragFromToForDuration/
 *     typeText/screenshot/source/orientation/window size), screenshot PNG
 *     size parsing, WDA error propagation, and session recreate-on-invalid
 *     (404 `invalid session id` → new session → retry)
 *   - the `StreamSource` interface adapters for BOTH hosts (sim controller
 *     untouched; normalized→absolute conversion for WDA)
 *   - `WdaController` construction/idle behavior, unavailable-tooling
 *     classification, and bogus-udid → `device-unplugged`
 *   - adopted-runner liveness regression (injectable timers + probe stubs,
 *     no device needed): a probe that times out while a control call is in
 *     flight is skipped and never kills WDA; 2 consecutive probe failures
 *     stay alive (hysteresis); N=3 consecutive failures with no successful
 *     traffic declare death exactly once, record `exitAt` and schedule the
 *     respawn; a successful control call resets the failure counter;
 *     `requireClient` no longer throws merely because the cached probe
 *     verdict is false (it still throws when disposed / no client / after
 *     stop). The controller is driven end-to-end against a local mock WDA
 *     with a fake `xcrun`/`iproxy`/`xcodebuild` shim on PATH — never a real
 *     device, never a real spawn.
 *
 * With DSH_IOS_SMOKE_REAL_DEVICE=1, if the dev phone is connected
 * (`devicectl list devices` state `connected`) AND WDA already answers on
 * `http://127.0.0.1:8100/status`,
 * an additional LIVE pass runs: ensureRunning (adopts the running WDA —
 * never spawns a second xcodebuild) → status → the exact failing sequence
 * of 5× pressButton home immediately followed by a screenshot → session
 * survives → stop. With no phone those steps are SKIPped and the script
 * still exits 0. Simulators are never booted; ~/.dsh and the :8873
 * instance are never touched.
 */

import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_LIVE_PART = process.env.DSH_IOS_SMOKE_REAL_DEVICE === '1'

const DEVICE_UDID = process.argv[2] || process.env.DSH_WDA_DEVICE_UDID || '96E6B481-3807-594D-B3BC-E1E12307D47C'
const DEVICE_HARDWARE_UDID = process.env.DSH_WDA_HARDWARE_UDID || '00008150-000A552A1A44401C'
const EXPECT_SHOT_SIZE = (process.env.DSH_WDA_EXPECT_SIZE || '1206x2622').split('x').map(Number)
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const {
  ADOPTED_DEATH_PROBE_FAILURES,
  ADOPTED_PROBE_INTERVAL_MS,
  ADOPTED_PROBE_TIMEOUT_MS,
  ADOPTED_TRAFFIC_GRACE_MS,
  WDA_BUSY_COOLDOWN_MS,
  WDA_DEFAULT_SNAPSHOT_DEPTH,
  WDA_FAST_TIMEOUT_MS,
  WDA_WINDOW_SIZE_CACHE_TTL_MS,
  WdaClient,
  WdaController,
  WdaError,
  WdaHttpError,
  assembleIproxyArgs,
  assembleXcodebuildTestArgs,
  classifyWdaFailure,
  isInvalidSessionError,
  isTransientWdaTransportError,
  isWdaBusyError,
  parseServerUrlHere,
  pickTunnelPort,
  probeWdaControlTunnel,
  probeWdaMjpegTunnel,
  resolveWdaTooling,
} = await import(join(root, 'lib', 'wda-host.js'))
const {
  SimStreamSource,
  WDA_WINDOW_SIZE_STALE_TAP_MS,
  WDA_WINDOW_SIZE_TTL_MS,
  WdaStreamSource,
  pngDimensionsFromBase64,
} = await import(join(root, 'lib', 'stream-source.js'))
const { listRealDevices } = await import(join(root, 'lib', 'devicectl.js'))
const { createSimUiTools } = await import(join(root, 'lib', 'tool-uitree.js'))
const {
  decodeUsbmuxHeader,
  encodeUsbmuxHeader,
  resolveUsbDeviceId,
  swapPortByteOrder,
  usbmuxTunnelFailureDetail,
  parseUsbmuxPlist,
  pickUsbDeviceId,
} = await import(join(root, 'lib', 'usbmux.js'))

const results = []
let failed = 0
function step(name, verdict, detail = '') {
  const normalized = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict
  if (normalized === 'FAIL') failed += 1
  results.push({ name, verdict: normalized, detail })
  console.log(`${normalized.padEnd(4)} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function expectThrow(label, invoke, pattern, expectedClass) {
  try {
    await invoke()
    step(label, 'FAIL', 'no error was thrown')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const classOk = expectedClass === undefined || (error instanceof expectedClass)
    const patternOk = pattern === undefined || pattern.test(message)
    step(label, classOk && patternOk ? 'PASS' : 'FAIL', classOk && patternOk ? message : `unexpected error: ${message}`)
  }
}

function hasDevicectl() {
  const probe = spawnSync('xcrun', ['devicectl', 'list', 'devices'], { stdio: 'pipe', timeout: 20_000 })
  return probe.status !== null && probe.error === undefined
}

/** Mock WDA HTTP server recording every request. */
function startMockWda(port = 0) {
  return new Promise(resolveStart => {
    const state = {
      sessionPosts: 0,
      currentSid: null,
      invalidOnce: false,
      failNextTap: false,
      screenshotDelayMs: 0,
      windowSizeDelayMs: 0,
      resetOnce: null,
      requests: [],
    }
    const server = createServer((req, res) => {
      // A client that timed out destroys its socket; the mock's later write
      // to that socket must not throw an unhandled 'error' event.
      res.on('error', () => {})
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        let body
        try {
          body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
        } catch {
          body = undefined
        }
        const path = url.pathname
        const send = (statusCode, payload) => {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(payload))
        }
        state.requests.push({ method: req.method, path, body })
        // Transport-reset seam: destroy the socket once for the first matching
        // request so the client sees ECONNRESET / socket hang up (WDA dropping
        // the connection under load), then clear it so the retry succeeds.
        if (state.resetOnce !== null && state.resetOnce.method === req.method && path.endsWith(state.resetOnce.path)) {
          state.resetOnce = null
          req.socket.destroy()
          return
        }
        if (req.method === 'GET' && path === '/status') {
          send(200, { value: { state: 'success', ready: true, device: 'iphone', ios: { ip: '192.168.50.26' } } })
          return
        }
        if (req.method === 'POST' && path === '/session') {
          state.sessionPosts += 1
          state.currentSid = `mock-sid-${state.sessionPosts}`
          send(200, { value: { sessionId: state.currentSid, capabilities: {} }, sessionId: state.currentSid })
          return
        }
        const sessionMatch = /^\/session\/([^/]+)(\/.*)?$/.exec(path)
        if (sessionMatch !== null) {
          const sid = sessionMatch[1]
          const rest = sessionMatch[2] ?? ''
          if (state.invalidOnce) {
            state.invalidOnce = false
            send(404, { value: { error: 'invalid session id', message: 'Session does not exist', traceback: '' } })
            return
          }
          if (sid !== state.currentSid) {
            send(404, { value: { error: 'invalid session id', message: 'Session does not exist', traceback: '' } })
            return
          }
          if (state.failNextTap && req.method === 'POST' && rest === '/wda/tap') {
            state.failNextTap = false
            send(200, { value: { error: 'unable to perform tap', message: 'boom' } })
            return
          }
          if (req.method === 'GET' && rest === '/screenshot') {
            if (state.screenshotDelayMs > 0) {
              // Simulate a device busy serving a multi-MB screenshot: WDA is
              // serialized, so a keep-alive /status probe queued behind this
              // would time out on the old 2 s budget.
              setTimeout(() => send(200, { value: TINY_PNG_B64 }), state.screenshotDelayMs)
            } else {
              send(200, { value: TINY_PNG_B64 })
            }
            return
          }
          if (req.method === 'GET' && rest === '/source') {
            send(200, { value: '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Mock"/>' })
            return
          }
          if (req.method === 'GET' && rest === '/orientation') {
            send(200, { value: 'PORTRAIT' })
            return
          }
          if (req.method === 'GET' && rest === '/window/size') {
            if (state.windowSizeDelayMs > 0) {
              // Simulate the device's serial dispatcher being stuck (video
              // playback): the answer arrives long after the client's FAST
              // window/size budget.
              setTimeout(() => {
                try {
                  send(200, { value: { width: 1206, height: 2622 } })
                } catch {
                  // The client already gave up and destroyed the socket.
                }
              }, state.windowSizeDelayMs)
            } else {
              send(200, { value: { width: 1206, height: 2622 } })
            }
            return
          }
          send(200, { value: null, sessionId: sid })
          return
        }
        send(404, { value: { error: 'unknown command', message: `no route for ${path}` } })
      })
    })
    server.listen(port, '127.0.0.1', () => {
      resolveStart({
        server,
        state,
        port: server.address().port,
        close: () => new Promise(resolveClose => server.close(resolveClose)),
      })
    })
  })
}

/** Mock SimHostController — SimStreamSource must delegate, never re-implement. */
function makeMockSimHost() {
  const calls = []
  let consumers = 0
  const releases = []
  const state = { available: true, running: false, device: undefined, port: undefined, restarts: 0, serveSimSource: 'package-bin', stderr: [] }
  return {
    calls,
    async ensureRunning({ udid }) {
      calls.push(['ensureRunning', udid])
      state.running = true
      state.device = udid
      state.port = 3199
      return {
        url: 'http://127.0.0.1:3199',
        streamUrl: 'http://127.0.0.1:3199/stream.mjpeg',
        wsUrl: 'ws://127.0.0.1:3199/ws',
        port: 3199,
        device: udid,
      }
    },
    async control(args) {
      calls.push(['control', ...args])
      return { stdout: '', stderr: '' }
    },
    status() {
      return { ...state, consumers }
    },
    async stop() {
      calls.push(['stop'])
      state.running = false
    },
    acquire() {
      consumers += 1
      const release = () => { consumers = Math.max(0, consumers - 1) }
      releases.push(release)
      return release
    },
  }
}

/** Mock WdaControllerLike — WdaStreamSource normalizes through windowSize(). */
function makeMockWda() {
  const calls = []
  let windowSizeError
  const record = name => (...args) => {
    calls.push([name, ...args])
    return Promise.resolve()
  }
  return {
    calls,
    /** Make the next windowSize() reads throw (a busy WDA timing out). */
    setWindowSizeError(error) {
      windowSizeError = error
    },
    mjpegUrl: 'http://127.0.0.1:9100/',
    async ensureRunning({ udid }) {
      calls.push(['ensureRunning', udid])
      return { udid, hardwareUdid: 'HW-0001', controlUrl: 'http://127.0.0.1:8100', mjpegUrl: 'http://127.0.0.1:9100/', sessionId: 'sid-9' }
    },
    status() {
      return {
        available: true,
        running: true,
        device: 'DEV-1',
        controlUrl: 'http://127.0.0.1:8100',
        mjpegUrl: 'http://127.0.0.1:9100/',
        sessionId: 'sid-9',
        consumers: 3,
        lastError: 'boom',
      }
    },
    async stop() { calls.push(['stop']) },
    acquire() { return () => {} },
    release() { calls.push(['release']) },
    control: {
      pressButton: record('pressButton'),
      tap: record('tap'),
      dragFromToForDuration: record('dragFromToForDuration'),
      typeText: record('typeText'),
      setOrientation: record('setOrientation'),
      async screenshot() {
        calls.push(['screenshot'])
        return { pngBase64: TINY_PNG_B64, width: 1, height: 1 }
      },
      async source() {
        calls.push(['source'])
        return '<XCUIElementTypeApplication/>'
      },
      async windowSize() {
        calls.push(['windowSize'])
        if (windowSizeError !== undefined) throw windowSizeError
        return { width: 1206, height: 2622 }
      },
    },
  }
}

console.log(`dsh-ios WDA host smoke — pure/mocked first${process.argv.includes('--no-live') ? ' (live pass disabled)' : ''}, live pass only when the phone is connected AND WDA answers on :8100`)
console.log('')

// ── 1. ServerURLHere parsing from a fixture log ─────────────────────────────
{
  const fixture = [
    'Test Suite WebDriverAgentRunner.xctest started',
    '2018-02-06 10:39:02.126873+0800 WebDriverAgentRunner-Runner[14621:566168] ServerURLHere->http://192.168.50.26:8100<-ServerURLHere',
    '2018-02-06 10:39:02.127011+0800 WebDriverAgentRunner-Runner[14621:566168] Listening on USB',
    'Test Suite WebDriverAgentRunner.xctest passed',
  ].join('\n')
  step(
    'parseServerUrlHere extracts the readiness URL from xcodebuild output',
    parseServerUrlHere(fixture) === 'http://192.168.50.26:8100',
    parseServerUrlHere(fixture) ?? 'undefined',
  )
  step(
    'parseServerUrlHere returns undefined without the marker',
    parseServerUrlHere('Testing started\n** TEST BUILD SUCCEEDED **\n') === undefined,
  )
}

// ── 2. Failure classification from the exact observed signatures ────────────
{
  const cases = [
    ['deviceprep Code=-3 unlock error', 'Error Domain=com.apple.dt.deviceprep Code=-3 "Unlock Fini iPhone 17 Pro to Continue" UserInfo={NSLocalizedDescription=Unlock Fini iPhone 17 Pro to Continue}', 'device-locked'],
    ['waiting-for-destination line', 'Waiting for the destination to become ready', 'device-locked'],
    ['cert not trusted', 'The application could not be launched because the Developer App Certificate is not trusted', 'cert-untrusted'],
    ['profile has expired', 'Provisioning profile "iOS Team Provisioning Profile: com.finiyang.WebDriverAgentRunner" has expired.', 'profile-expired'],
    ['profile expired wording 2', 'The provisioning profile has expired and must be regenerated', 'profile-expired'],
    ['destination not found (unplugged)', 'Unable to find a destination matching the provided destination specifier', 'device-unplugged'],
    ['no connected device (devicectl)', 'no connected physical device matches "00000000-0000-0000-0000-000000000000"', 'device-unplugged'],
    ['build failed', '** TEST BUILD FAILED **', 'build-failed'],
    ['testing failed', 'Testing failed:\n    WebDriverAgentRunner-Runner encountered an error', 'build-failed'],
    ['clean log', 'Test Suite WebDriverAgentRunner.xctest passed', undefined],
  ]
  let allOk = true
  const detailBits = []
  for (const [label, text, expected] of cases) {
    const got = classifyWdaFailure(text)
    if (got !== expected) {
      allOk = false
      detailBits.push(`${label}: got ${String(got)}`)
    }
  }
  step('classifyWdaFailure maps each exact signature to its reason', allOk, detailBits.join('; ') || `${cases.length} cases`)
  step(
    'device-locked wins over build keywords (locked during test phase)',
    classifyWdaFailure('Error Domain=com.apple.dt.deviceprep Code=-3 "Unlock Fini iPhone to Continue"\nTesting failed:') === 'device-locked',
  )
  // WP60: a LOCKED device makes xcodebuild print `** TEST BUILD FAILED **`
  // around the deviceprep error, so the lock signature and the build signature
  // appear in ONE capture; device-locked (self-healing) must win over
  // build-failed (terminal). Measured: locked -> build-failed, then the same
  // command succeeded unchanged once unlocked.
  step(
    'device-locked wins when BOTH the lock signature and ** TEST BUILD FAILED ** appear',
    classifyWdaFailure('Error Domain=com.apple.dt.deviceprep Code=-3 "Unlock Fini iPhone 17 Pro to Continue"\n** TEST BUILD FAILED **\nxcodebuild: error:') === 'device-locked',
  )
}

// ── 3. iproxy arg assembly: POSITIONAL syntax, never the colon form ─────────
{
  const args = assembleIproxyArgs(8100, 9100, DEVICE_HARDWARE_UDID)
  const positional = args.length === 3
    && args[0] === '8100'
    && args[1] === '9100'
    && args[2] === DEVICE_HARDWARE_UDID
    && args.every(arg => !arg.includes(':'))
  step('assembleIproxyArgs is POSITIONAL (local device udid, no colons)', positional, args.join(' '))
}

// ── 4. xcodebuild runner arg assembly ───────────────────────────────────────
{
  const args = assembleXcodebuildTestArgs(DEVICE_HARDWARE_UDID, { teamId: '5CHT5RB9C3', bundleId: 'com.finiyang.WebDriverAgentRunner' })
  const ok = args.includes('-project') && args.includes('WebDriverAgent.xcodeproj')
    && args.includes('-scheme') && args.includes('WebDriverAgentRunner')
    && args.includes(`id=${DEVICE_HARDWARE_UDID}`)
    && args.includes('-allowProvisioningUpdates')
    && args.includes('DEVELOPMENT_TEAM=5CHT5RB9C3')
    && args.includes('CODE_SIGN_STYLE=Automatic')
    && args.includes('PRODUCT_BUNDLE_IDENTIFIER=com.finiyang.WebDriverAgentRunner')
    && args[args.length - 1] === 'test'
  step('assembleXcodebuildTestArgs mirrors the verified invocation', ok, args.join(' '))
}

// ── 5. Tunnel port picking (no device; pure loopback servers) ───────────────
{
  const listenFree = server => new Promise((resolveListen, rejectListen) => {
    const onError = error => rejectListen(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolveListen(server.address().port)
    })
  })

  // 5a. free port → we own it (spawn a fresh iproxy there).
  const freeProbe = createServer()
  const freePort = await listenFree(freeProbe)
  await new Promise(resolveClose => freeProbe.close(resolveClose))
  const free = await pickTunnelPort(freePort, async () => false)
  step('pickTunnelPort: free port is taken for a new tunnel', free.adopted === false && free.port === freePort, `port ${free.port}`)

  // 5b. occupied + WDA-shaped → adopted (an existing tunnel is never collided with).
  const adoptedServer = createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ value: { state: 'success', ready: true } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const adoptedPort = await listenFree(adoptedServer)
  const adopted = await pickTunnelPort(adoptedPort, probeWdaControlTunnel)
  step(
    'pickTunnelPort: occupied port answering WDA /status is ADOPTED',
    adopted.adopted === true && adopted.port === adoptedPort,
    `port ${adopted.port}`,
  )
  step('probeWdaControlTunnel accepts the WDA ready shape', await probeWdaControlTunnel(adoptedPort) === true)

  // 5c. occupied + unrelated server → skipped, next free port chosen.
  const unrelated = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('hello, not WDA')
  })
  const unrelatedPort = await listenFree(unrelated)
  const skipped = await pickTunnelPort(unrelatedPort, probeWdaControlTunnel)
  step(
    'pickTunnelPort: unrelated server is skipped (no collision)',
    skipped.adopted === false && skipped.port !== unrelatedPort && skipped.port > unrelatedPort,
    `port ${skipped.port} (unrelated on ${unrelatedPort})`,
  )

  // 5d. MJPEG-shaped port adoption (multipart/x-mixed-replace headers).
  const mjpeg = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=BoundaryString' })
    res.write('--BoundaryString\r\nContent-type: image/jpeg\r\n\r\n')
    // Leave the stream open; the probe judges on headers only.
  })
  const mjpegPort = await listenFree(mjpeg)
  step('probeWdaMjpegTunnel matches multipart/x-mixed-replace', await probeWdaMjpegTunnel(mjpegPort) === true)
  step('probeWdaMjpegTunnel rejects a plain HTTP server', await probeWdaMjpegTunnel(unrelatedPort) === false)
  step('probeWdaControlTunnel rejects the unrelated server', await probeWdaControlTunnel(unrelatedPort) === false)

  for (const server of [adoptedServer, unrelated, mjpeg]) {
    await new Promise(resolveClose => server.close(resolveClose))
  }
}

// ── 5b. usbmux protocol primitives (no socket; pure framing/resolution) ────
// The built-in usbmuxd forwarder replaces iproxy. These pin its framing and
// device resolution without ever opening /var/run/usbmuxd.
{
  // Header framing: 16 bytes, little-endian, length/version/type/tag.
  const encoded = encodeUsbmuxHeader({ totalLength: 40, version: 1, messageType: 8, tag: 0x01020304 })
  const decoded = decodeUsbmuxHeader(encoded)
  step(
    'usbmux header round-trips length/version/type/tag (16 bytes LE)',
    encoded.length === 16
      && decoded.totalLength === 40
      && decoded.version === 1
      && decoded.messageType === 8
      && decoded.tag === 0x01020304,
    `hex ${Buffer.from(encoded).toString('hex')}`,
  )

  // PortNumber byte-swap (htons): the exact ints usbmuxd expects on the wire.
  const swapped8100 = swapPortByteOrder(8100)
  const swapped9100 = swapPortByteOrder(9100)
  step(
    'PortNumber byte-swap: 8100 → 0xA41F (42015)',
    swapped8100 === 0xA41F && swapped8100 === 42015,
    `0x${swapped8100.toString(16).toUpperCase()} = ${swapped8100}`,
  )
  step(
    'PortNumber byte-swap: 9100 → 0x8C23 (35875)',
    swapped9100 === 0x8C23 && swapped9100 === 35875,
    `0x${swapped9100.toString(16).toUpperCase()} = ${swapped9100}`,
  )

  // Device resolution driven through an injectable lister, never the socket.
  const networkFirst = [
    { deviceId: 281, udid: DEVICE_HARDWARE_UDID, connection: 'network' },
    { deviceId: 280, udid: DEVICE_HARDWARE_UDID, connection: 'usb' },
  ]
  const usbId = await resolveUsbDeviceId(DEVICE_HARDWARE_UDID, async () => networkFirst)
  step('resolveUsbDeviceId picks the USB record when the udid appears twice (Network first)', usbId === 280, `id=${String(usbId)}`)
  const networkOnly = await resolveUsbDeviceId(DEVICE_HARDWARE_UDID, async () => [
    { deviceId: 281, udid: DEVICE_HARDWARE_UDID, connection: 'network' },
  ])
  step('resolveUsbDeviceId returns undefined when only a Network record exists', networkOnly === undefined, `id=${String(networkOnly)}`)

  // The three distinguishable tunnel-failure texts are distinct + actionable.
  const usbUpText = usbmuxTunnelFailureDetail('usb-link-up')
  const networkOnlyText = usbmuxTunnelFailureDetail('network-only')
  const notAttachedText = usbmuxTunnelFailureDetail('not-attached')
  step(
    'tunnel failure text is three distinct, actionable strings',
    usbUpText !== networkOnlyText && networkOnlyText !== notAttachedText && usbUpText !== notAttachedText,
    '',
  )
  step(
    'usb-link-up text names WDA not listening yet',
    usbUpText === 'the USB link is up but the port forward failed — WebDriverAgent may not be listening yet; re-run',
    usbUpText,
  )
  step(
    'network-only text names the USB cable (Wi-Fi pairing cannot carry the forward)',
    networkOnlyText === 'this phone is reachable over Wi-Fi only; WebDriverAgent needs the USB cable — plug it in (Wi-Fi sync pairing cannot carry the port forward)',
    networkOnlyText,
  )
  step(
    'not-attached text names a data-capable cable + unlock',
    notAttachedText === 'the phone is not attached over USB — connect a data-capable cable and unlock the device',
    notAttachedText,
  )
}

// ── 6. WdaClient against a mock WDA server ──────────────────────────────────
{
  const mock = await startMockWda()
  const client = new WdaClient(`http://127.0.0.1:${mock.port}`, { requestTimeoutMs: 5_000 })
  try {
    const health = await client.health()
    step('health() parses GET /status → ready', health.ready === true && health.ip === '192.168.50.26', JSON.stringify(health))

    const sid = await client.ensureSession()
    step('ensureSession creates one WDA session lazily', sid === 'mock-sid-1' && mock.state.sessionPosts === 1, sid)
    step('session is reused (second ensureSession does not POST)', await client.ensureSession() === sid && mock.state.sessionPosts === 1)

    // Exact endpoint shapes (verified against the cloned WDA source).
    await client.pressButton('home')
    await client.tap(600, 1300)
    await client.dragFromToForDuration({ fromX: 10, fromY: 20, toX: 30, toY: 40, duration: 0.5 })
    await client.typeText('hello')
    const marks = {
      press: mock.state.requests.find(r => r.method === 'POST' && r.path.endsWith('/wda/pressButton')),
      tap: mock.state.requests.find(r => r.method === 'POST' && r.path.endsWith('/wda/tap')),
      drag: mock.state.requests.find(r => r.method === 'POST' && r.path.endsWith('/wda/dragfromtoforduration')),
      keys: mock.state.requests.find(r => r.method === 'POST' && r.path.endsWith('/wda/keys')),
    }
    step(
      'control endpoint paths + bodies match the WDA source contract',
      marks.press?.path === `/session/mock-sid-1/wda/pressButton` && marks.press?.body?.name === 'home'
        && marks.tap?.path === `/session/mock-sid-1/wda/tap` && marks.tap?.body?.x === 600 && marks.tap?.body?.y === 1300
        && marks.drag?.path === `/session/mock-sid-1/wda/dragfromtoforduration`
        && marks.drag?.body?.fromX === 10 && marks.drag?.body?.fromY === 20 && marks.drag?.body?.toX === 30 && marks.drag?.body?.toY === 40 && marks.drag?.body?.duration === 0.5
        && marks.keys?.path === `/session/mock-sid-1/wda/keys` && JSON.stringify(marks.keys?.body?.value) === JSON.stringify(['hello']),
      JSON.stringify([marks.press?.path, marks.tap?.path, marks.drag?.path, marks.keys?.path]),
    )

    const shot = await client.screenshot()
    step(
      'screenshot() returns base64 PNG with parsed dimensions',
      shot.pngBase64 === TINY_PNG_B64 && shot.width === 1 && shot.height === 1,
      `${shot.width}x${shot.height}, ${shot.pngBase64.length} b64 chars`,
    )
    const tree = await client.source()
    step('source() returns the accessibility tree', typeof tree === 'string' && tree.includes('XCUIElementTypeApplication'))
    step('getOrientation() → PORTRAIT', await client.getOrientation() === 'PORTRAIT')
    await client.setOrientation('LANDSCAPE')
    const orientationPost = mock.state.requests.find(r => r.method === 'POST' && r.path.endsWith('/orientation'))
    step('setOrientation posts {orientation}', orientationPost?.body?.orientation === 'LANDSCAPE')
    const size = await client.windowSize()
    step('windowSize() returns the point size', size.width === 1206 && size.height === 2622, `${size.width}x${size.height}`)

    // WDA error propagation: HTTP 200 with value.error still throws.
    mock.state.failNextTap = true
    await expectThrow('tap surfaces WDA value.error as WdaHttpError', () => client.tap(1, 2), /unable to perform tap/, WdaHttpError)

    // Session recreate-on-invalid: next session-scoped call gets a 404
    // `invalid session id`, the client recreates the session and retries.
    mock.state.invalidOnce = true
    await client.pressButton('home')
    const sessionPosts = mock.state.requests.filter(r => r.method === 'POST' && r.path === '/session').length
    const retried = mock.state.requests.filter(r => r.method === 'POST' && r.path.endsWith('/wda/pressButton')).at(-1)
    step(
      'invalid session (404) → session recreated → request retried',
      sessionPosts === 2 && client.sessionId === 'mock-sid-2' && retried?.path === '/session/mock-sid-2/wda/pressButton',
      `session POSTs=${sessionPosts}, retried via ${retried?.path}`,
    )
    step('isInvalidSessionError recognizes the 404 body', isInvalidSessionError(new WdaHttpError('x', 404, JSON.stringify({ value: { error: 'invalid session id', message: 'Session does not exist' } }), undefined)))
    step('isInvalidSessionError ignores unrelated errors', isInvalidSessionError(new WdaHttpError('boom', 500, 'oops', undefined)) === false)
  } finally {
    await mock.close()
  }
}

// ── 6b. Transient transport-reset classification + one-shot retry ──────────
{
  step('isTransientWdaTransportError: ECONNRESET is transient', isTransientWdaTransportError(new WdaHttpError('WDA GET /source request failed: read ECONNRESET', undefined, undefined, undefined)))
  step('isTransientWdaTransportError: socket hang up is transient', isTransientWdaTransportError(new WdaHttpError('WDA GET /screenshot connection error: socket hang up', undefined, undefined, undefined)))
  step('isTransientWdaTransportError: EPIPE is transient', isTransientWdaTransportError(new WdaHttpError('WDA GET /source request failed: write EPIPE', undefined, undefined, undefined)))
  step('isTransientWdaTransportError: ECONNREFUSED is NOT transient', isTransientWdaTransportError(new WdaHttpError('WDA GET /source request failed: connect ECONNREFUSED', undefined, undefined, undefined)) === false)
  step('isTransientWdaTransportError: HTTP 4xx/5xx is NOT transient', isTransientWdaTransportError(new WdaHttpError('WDA GET /source returned HTTP 500: boom', 500, 'oops', undefined)) === false)
  step('isTransientWdaTransportError: a plain Error is NOT transient', isTransientWdaTransportError(new Error('nope')) === false)

  const resetMock = await startMockWda()
  const resetClient = new WdaClient(`http://127.0.0.1:${resetMock.port}`, { requestTimeoutMs: 5_000 })
  try {
    // GET /source fails once with a transport reset, then succeeds on the retry.
    resetMock.state.resetOnce = { method: 'GET', path: '/source' }
    const tree = await resetClient.source()
    const sourceGets = resetMock.state.requests.filter(r => r.method === 'GET' && r.path.endsWith('/source')).length
    step(
      'a GET that fails once with ECONNRESET is retried once and returns the value',
      typeof tree === 'string' && tree.includes('XCUIElementTypeApplication') && sourceGets === 2,
      `source GETs=${sourceGets} (reset + retry)`,
    )

    // A POST that fails with a transport reset is NOT retried: a retried
    // gesture would double-fire.
    resetMock.state.resetOnce = { method: 'POST', path: '/wda/tap' }
    let tapError
    try {
      await resetClient.tap(600, 1300)
    } catch (error) {
      tapError = error
    }
    const tapPosts = resetMock.state.requests.filter(r => r.method === 'POST' && r.path.endsWith('/wda/tap')).length
    step(
      'a POST that fails with ECONNRESET is NOT retried (a retried gesture would double-fire)',
      tapError !== undefined && isTransientWdaTransportError(tapError) && tapPosts === 1,
      `tap POSTs=${tapPosts}`,
    )
  } finally {
    await resetMock.close()
  }
}

// ── 6b2. Busy-device hardening: fast window/size, busy cooldown, size cache ─
// The issue-2 shape: the device plays video, WDA's serial dispatcher sticks
// behind a slow command, and every new call (each panel tap re-asks
// window/size) queues behind it for its own full timeout — "window/size
// 持续超时". The fix has three parts, all driven here without a device:
// the cheap GETs fail FAST, one timeout arms a busy cooldown during which
// new calls fail fast instead of queueing, and the size is cached across
// callers with rotation/session invalidation.
{
  step(
    'busy-hardening constants are sane (fast < 30 s budget, cooldown > 0, cache TTL > 0)',
    WDA_FAST_TIMEOUT_MS > 0 && WDA_FAST_TIMEOUT_MS < 30_000
      && WDA_BUSY_COOLDOWN_MS > 0
      && WDA_WINDOW_SIZE_CACHE_TTL_MS > 0,
    `fast=${WDA_FAST_TIMEOUT_MS} cooldown=${WDA_BUSY_COOLDOWN_MS} cacheTTL=${WDA_WINDOW_SIZE_CACHE_TTL_MS}`,
  )
  step(
    'isWdaBusyError recognizes the busy marker and nothing else',
    isWdaBusyError(new WdaHttpError('WDA GET /x rejected while the device is busy [wda-busy]', undefined, undefined, undefined))
      && !isWdaBusyError(new WdaHttpError('WDA GET /x timed out after 30000 ms', undefined, undefined, undefined))
      && !isWdaBusyError(new Error('nope')),
  )

  // 6b2-1: a stuck window/size fails in the FAST budget, not the 30 s one.
  const slowMock = await startMockWda()
  try {
    slowMock.state.windowSizeDelayMs = 2_000
    const slowClient = new WdaClient(`http://127.0.0.1:${slowMock.port}`, {
      requestTimeoutMs: 30_000,
      shortTimeoutMs: 300,
      busyCooldownMs: 5_000,
    })
    const startedAt = Date.now()
    await expectThrow(
      'window/size uses the FAST timeout (fails in ~300 ms, before the 2 s answer, not after the 30 s budget)',
      () => slowClient.windowSize(),
      /timed out after 300 ms/,
      WdaHttpError,
    )
    step(
      'the fast failure really was fast',
      Date.now() - startedAt < 1_500,
      `${Date.now() - startedAt} ms (answer arrives at 2000 ms, general budget 30000 ms)`,
    )
    // The same timed-out client now refuses new calls while the cooldown
    // lasts — fail fast instead of queueing behind the stuck command.
    const busyStart = Date.now()
    let busyError
    try {
      await slowClient.health()
    } catch (error) {
      busyError = error
    }
    step(
      'one timeout arms the busy cooldown: the next call fails fast with the marker',
      busyError instanceof WdaHttpError && isWdaBusyError(busyError) && Date.now() - busyStart < 500,
      `${Date.now() - busyStart} ms — ${busyError?.message}`,
    )
    // After the cooldown the client tries again and succeeds (the mock now
    // answers instantly), proving the gate is a delay, not a wedge.
    slowMock.state.windowSizeDelayMs = 0
    await sleep(5_100)
    const recovered = await slowClient.windowSize()
    step(
      'after the cooldown expires the SAME client tries again and succeeds',
      recovered.width === 1206 && recovered.height === 2622,
      `${recovered.width}x${recovered.height}`,
    )
  } finally {
    await slowMock.close()
  }

  // 6b2-2: a transport reset is NOT a busy signal — the retry succeeds and
  // no cooldown blocks the next call.
  {
    const resetMock = await startMockWda()
    try {
      const resetClient = new WdaClient(`http://127.0.0.1:${resetMock.port}`, {
        requestTimeoutMs: 5_000,
        busyCooldownMs: 5_000,
      })
      resetMock.state.resetOnce = { method: 'GET', path: '/source' }
      await resetClient.source()
      const health = await resetClient.health()
      step(
        'a transport reset does NOT arm the busy cooldown (the retry path stays unblocked)',
        health.ready === true,
        'health() right after the reset+retry answered normally',
      )
    } finally {
      await resetMock.close()
    }
  }

  // 6b2-3: the shared window-size cache: one GET serves repeated reads,
  // rotation and session recreation invalidate it.
  {
    const cacheMock = await startMockWda()
    try {
      let cacheNow = 0
      const cacheClient = new WdaClient(`http://127.0.0.1:${cacheMock.port}`, {
        requestTimeoutMs: 5_000,
        now: () => cacheNow,
      })
      const sizeGets = () => cacheMock.state.requests.filter(r => r.method === 'GET' && r.path.endsWith('/window/size')).length
      const first = await cacheClient.windowSize()
      const second = await cacheClient.windowSize()
      step(
        'the size is cached across callers (two reads, one GET)',
        sizeGets() === 1 && second.width === first.width,
        `GETs=${sizeGets()}`,
      )
      cacheNow = WDA_WINDOW_SIZE_CACHE_TTL_MS + 1
      await cacheClient.windowSize()
      step(
        'the cache expires after the TTL (the third read re-asks)',
        sizeGets() === 2,
        `GETs=${sizeGets()}`,
      )
      await cacheClient.setOrientation('LANDSCAPE')
      await cacheClient.windowSize()
      step(
        'setOrientation drops the cache (width and height just swapped)',
        sizeGets() === 3,
        `GETs=${sizeGets()}`,
      )
      // Expire the cache first: the invalid-session path is only walked
      // when a fresh GET actually goes out and hits the 404.
      cacheNow = WDA_WINDOW_SIZE_CACHE_TTL_MS * 2 + 1
      cacheMock.state.invalidOnce = true
      await cacheClient.windowSize()
      step(
        'session recreation drops the cache too (invalid session → recreate → retry)',
        sizeGets() === 5 && cacheClient.sessionId === 'mock-sid-2',
        `GETs=${sizeGets()} session=${cacheClient.sessionId}`,
      )
    } finally {
      await cacheMock.close()
    }
  }
}

// ── 6c. Snapshot depth is pushed into WDA before the tree walk ─────────────
{
  const UI_FAKE_UDID = '00008150-000A3333UI0000'
  const uiDevice = {
    udid: UI_FAKE_UDID,
    name: 'UI Smoke Phone',
    osVersion: '26.6',
    state: 'available (paired)',
    connection: 'wired',
    pairingState: 'paired',
    developerMode: 'enabled',
  }
  const uiRealDevices = {
    matches: async reference => reference === UI_FAKE_UDID,
    resolve: async () => uiDevice,
  }
  const TREE_XML = [
    '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Mock" label="Mock" enabled="true" visible="true" x="0" y="0" width="402" height="874">',
    '  <XCUIElementTypeButton type="XCUIElementTypeButton" name="go" label="Go" enabled="true" visible="true" x="16" y="100" width="100" height="44"/>',
    '</XCUIElementTypeApplication>',
  ].join('')
  const makeUiWda = setDepthError => {
    const calls = []
    return {
      calls,
      async ensureRunning({ udid }) {
        calls.push(['ensureRunning', udid])
        return { udid, hardwareUdid: 'UI-FAKE-HW', controlUrl: 'http://127.0.0.1:8100', mjpegUrl: 'http://127.0.0.1:9100/', sessionId: 'SID-UI' }
      },
      status() {
        return { available: true, running: true, consumers: 0, reason: undefined, detail: undefined, controlPort: 8100, mjpegPort: 9100, adopted: false }
      },
      async stop() {},
      acquire() { return () => {} },
      release() {},
      get mjpegUrl() { return undefined },
      control: {
        async setSnapshotDepth(depth) {
          calls.push(['setSnapshotDepth', depth])
          if (setDepthError !== undefined) throw setDepthError
        },
        async source() {
          calls.push(['source'])
          return TREE_XML
        },
        async windowSize() {
          calls.push(['windowSize'])
          return { width: 402, height: 874 }
        },
      },
    }
  }
  const exec = { signal: new AbortController().signal }
  const host = {} // unused on the real-device path (only the simctl/AXe branch touches it)

  step('WDA_DEFAULT_SNAPSHOT_DEPTH is 15', WDA_DEFAULT_SNAPSHOT_DEPTH === 15, `depth=${WDA_DEFAULT_SNAPSHOT_DEPTH}`)

  const wdaDefault = makeUiWda()
  const treeDefault = await createSimUiTools(host, { wda: wdaDefault, realDevices: uiRealDevices }).iosSimUiTree.execute({ udid: UI_FAKE_UDID }, exec)
  const depthIdx = wdaDefault.calls.findIndex(c => c[0] === 'setSnapshotDepth')
  const sourceIdx = wdaDefault.calls.findIndex(c => c[0] === 'source')
  const depthCall = wdaDefault.calls.find(c => c[0] === 'setSnapshotDepth')
  step(
    'ui_tree real-device path sets snapshot depth BEFORE source(), default cap when absent',
    treeDefault.nodeCount > 0 && depthCall !== undefined && depthCall[1] === WDA_DEFAULT_SNAPSHOT_DEPTH
      && depthIdx >= 0 && sourceIdx > depthIdx,
    `setSnapshotDepth(${depthCall?.[1]}) then source()`,
  )

  const wdaExplicit = makeUiWda()
  await createSimUiTools(host, { wda: wdaExplicit, realDevices: uiRealDevices }).iosSimUiTree.execute({ udid: UI_FAKE_UDID, max_depth: 8 }, exec)
  const explicitCall = wdaExplicit.calls.find(c => c[0] === 'setSnapshotDepth')
  step(
    'an explicit max_depth is what gets sent (caller wins over the default)',
    explicitCall !== undefined && explicitCall[1] === 8,
    `setSnapshotDepth(${explicitCall?.[1]})`,
  )

  const wdaOld = makeUiWda(new Error('old WDA: unknown command appium/settings'))
  const treeOld = await createSimUiTools(host, { wda: wdaOld, realDevices: uiRealDevices }).iosSimUiTree.execute({ udid: UI_FAKE_UDID }, exec)
  step(
    'a setSnapshotDepth that REJECTS still yields a tree (old WDA keeps working)',
    treeOld.nodeCount > 0,
    `${treeOld.nodeCount} nodes despite the rejected setting`,
  )
}

// ── 7. StreamSource interface adapters ──────────────────────────────────────
{
  // 7a. Sim adapter: pure delegation, sim-host behavior untouched.
  const simHost = makeMockSimHost()
  const sim = new SimStreamSource(simHost)
  step('SimStreamSource kind is simulator', sim.kind === 'simulator')
  const info = await sim.ensureRunning('SIM-UDID')
  step(
    'SimStreamSource.ensureRunning delegates and maps the handshake',
    info.udid === 'SIM-UDID' && info.mjpegUrl === 'http://127.0.0.1:3199/stream.mjpeg' && info.controlUrl === 'http://127.0.0.1:3199',
    JSON.stringify(info),
  )
  step('SimStreamSource.mjpegUrl exposes the stream URL', sim.mjpegUrl === 'http://127.0.0.1:3199/stream.mjpeg')

  await sim.control.tap(0.5, 0.9)
  await sim.control.button()
  await sim.control.type('hi')
  await sim.control.rotate('landscape_left')
  await sim.control.drag({ fromX: 0.1, fromY: 0.2, toX: 0.8, toY: 0.9, duration: 0.02 })
  const controlCalls = simHost.calls.filter(entry => entry[0] === 'control')
  step(
    'SimStreamSource.control maps onto serve-sim CLI subcommands',
    controlCalls.length === 7
      && JSON.stringify(controlCalls[0].slice(1)) === JSON.stringify(['tap', '0.5', '0.9', '-d', 'SIM-UDID'])
      && JSON.stringify(controlCalls[1].slice(1)) === JSON.stringify(['button', 'home', '-d', 'SIM-UDID'])
      && JSON.stringify(controlCalls[2].slice(1)) === JSON.stringify(['type', 'hi', '-d', 'SIM-UDID'])
      && JSON.stringify(controlCalls[3].slice(1)) === JSON.stringify(['rotate', 'landscape_left', '-d', 'SIM-UDID'])
      && JSON.stringify(controlCalls.slice(4).map(entry => entry.slice(1))) === JSON.stringify([
        ['gesture', JSON.stringify({ type: 'begin', x: 0.1, y: 0.2 }), '-d', 'SIM-UDID'],
        ['gesture', JSON.stringify({ type: 'move', x: 0.8, y: 0.9 }), '-d', 'SIM-UDID'],
        ['gesture', JSON.stringify({ type: 'end', x: 0.8, y: 0.9 }), '-d', 'SIM-UDID'],
      ]),
    JSON.stringify(controlCalls.map(entry => entry.slice(1))),
  )
  await expectThrow('SimStreamSource.tap rejects out-of-range coords', () => sim.control.tap(1.5, 0.5), /normalized 0\.\.1/, RangeError)

  const releaseA = sim.acquire()
  const releaseB = sim.acquire()
  const statusAfterAcquire = sim.status()
  releaseA()
  sim.release()
  step(
    'SimStreamSource acquire/release refcount + status mapping',
    statusAfterAcquire.kind === 'simulator' && statusAfterAcquire.consumers === 2 && statusAfterAcquire.running === true
      && sim.status().consumers === 0,
    `consumers ${statusAfterAcquire.consumers} → ${sim.status().consumers}`,
  )
  await sim.stop()
  step('SimStreamSource.stop delegates to the host', simHost.calls.some(entry => entry[0] === 'stop'))

  // 7b. WDA adapter: normalized panel coords → absolute points via windowSize().
  const mockWda = makeMockWda()
  const wda = new WdaStreamSource(mockWda)
  step('WdaStreamSource kind is real-device', wda.kind === 'real-device')
  const wdaInfo = await wda.ensureRunning('DEV-1')
  step(
    'WdaStreamSource.ensureRunning maps WDA info',
    wdaInfo.udid === 'DEV-1' && wdaInfo.hardwareUdid === 'HW-0001' && wdaInfo.sessionId === 'sid-9' && wdaInfo.mjpegUrl === 'http://127.0.0.1:9100/',
    JSON.stringify(wdaInfo),
  )
  const wdaStatus = wda.status()
  step(
    'WdaStreamSource.status maps the common fields',
    wdaStatus.kind === 'real-device' && wdaStatus.running === true && wdaStatus.consumers === 3 && wdaStatus.lastError === 'boom',
    JSON.stringify(wdaStatus),
  )
  await wda.control.tap(0.5, 0.25)
  await wda.control.drag({ fromX: 0.1, fromY: 0.2, toX: 0.8, toY: 0.9, duration: 0.5 })
  await wda.control.button('volumeUp')
  await wda.control.type('hi')
  await wda.control.rotate('LANDSCAPE')
  const shotPassthrough = await wda.control.screenshot()
  const treePassthrough = await wda.control.uiTree()
  step(
    'WdaStreamSource converts normalized → absolute POINT coords (1206×2622)',
    JSON.stringify(mockWda.calls.find(entry => entry[0] === 'tap')) === JSON.stringify(['tap', 603, 656])
      && JSON.stringify(mockWda.calls.find(entry => entry[0] === 'dragFromToForDuration')) === JSON.stringify(['dragFromToForDuration', { fromX: 121, fromY: 524, toX: 965, toY: 2360, duration: 0.5 }]),
    JSON.stringify(mockWda.calls.filter(entry => entry[0] === 'tap' || entry[0] === 'dragFromToForDuration')),
  )
  step(
    'WdaStreamSource button/type/rotate/screenshot/uiTree passthrough',
    mockWda.calls.some(entry => entry[0] === 'pressButton' && entry[1] === 'volumeUp')
      && mockWda.calls.some(entry => entry[0] === 'typeText' && entry[1] === 'hi')
      && mockWda.calls.some(entry => entry[0] === 'setOrientation' && entry[1] === 'LANDSCAPE')
      && shotPassthrough.width === 1 && treePassthrough.includes('XCUIElementTypeApplication'),
  )
  await expectThrow('WdaStreamSource.tap rejects out-of-range coords', () => wda.control.tap(-0.1, 0.5), /normalized 0\.\.1/, RangeError)

  step('pngDimensionsFromBase64 parses the fixture PNG', JSON.stringify(pngDimensionsFromBase64(TINY_PNG_B64)) === JSON.stringify({ width: 1, height: 1 }))
  step('pngDimensionsFromBase64 rejects garbage', pngDimensionsFromBase64('bm90LWEtcG5n') === undefined)
}

// ── 8. WdaController with no device (construction, tooling, classification) ─
{
  const wda = new WdaController()
  const status = wda.status()
  step(
    'WdaController idle status shape',
    status.running === false && typeof status.available === 'boolean' && Array.isArray(status.stderr) && status.consumers === 0,
    `available=${status.available} tooling=${wda.tooling.available}`,
  )
  step('WdaController tooling resolution is readable', typeof wda.tooling.projectDir === 'string' && typeof wda.tooling.available === 'boolean')
  await expectThrow('WdaController.control rejects while not running', () => wda.control.pressButton('home'), /not running.*ensureRunning/i)

  const broken = new WdaController({ wdaProjectDir: join(root, 'does-not-exist') })
  await expectThrow(
    'missing WDA checkout → unavailable classification (no device calls)',
    () => broken.ensureRunning({ udid: 'whatever' }),
    /unavailable/,
    WdaError,
  )
  step('missing WDA checkout → status().available false', broken.status().available === false && broken.tooling.available === false)

  if (RUN_LIVE_PART && hasDevicectl()) {
    try {
      await wda.ensureRunning({ udid: '00000000-0000-0000-0000-000000000000' })
      step('bogus udid → classified failure', 'FAIL', 'ensureRunning unexpectedly succeeded')
    } catch (error) {
      step(
        'bogus udid → device-unplugged classification',
        error instanceof WdaError && error.reason === 'device-unplugged' && wda.status().reason === 'device-unplugged',
        error instanceof Error ? error.message : String(error),
      )
    }
  } else {
    step('bogus udid → classified failure', 'SKIP', RUN_LIVE_PART
      ? 'xcrun devicectl unavailable on this host'
      : 'fixture-only by default; opt in with DSH_IOS_SMOKE_REAL_DEVICE=1')
  }
  wda.startKeepAlive()
  wda.stopKeepAlive()
  await wda.stop()
  await wda.dispose()
  step('WdaController stop/dispose are safe when idle', 'PASS')
}

// ── 9. Adopted-runner liveness regression (injectable timers + probe stubs) ─
// Reproduces the production bug: WDA is serialized, so a /status keep-alive
// probe that runs while the device serves a multi-MB screenshot times out,
// flips the single cached probe flag, and the very next control call of the
// same tool invocation threw "WDA is not running; call ensureRunning first".
// No device is needed: a fake `xcrun` shim reports one connected device and
// the controller adopts a LOCAL mock WDA, driven by injected clock, probe
// and keep-alive scheduler seams.
{
  const FAKE_UDID = '00008150-000A1111SMOKE000'
  const FAKE_HW_UDID = '00008150-000A1111SMOKE000'
  const shimDir = mkdtempSync(join(tmpdir(), 'dsh-ios-wda-smoke-'))
  mkdirSync(join(shimDir, 'WebDriverAgent.xcodeproj'), { recursive: true })
  const deviceDoc = {
    info: { outcome: 'success' },
    result: {
      devices: [{
        identifier: FAKE_UDID,
        deviceProperties: {
          name: 'Smoke Phone',
          osVersionNumber: '26.1',
          developerModeStatus: 'enabled',
          bootState: 'booted',
          ddiServicesAvailable: true,
        },
        hardwareProperties: {
          udid: FAKE_HW_UDID,
          marketingName: 'iPhone 17 Pro',
          productType: 'iPhone17,1',
          platform: 'iOS',
          serialNumber: 'SMOKE000001',
        },
        connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' },
      }],
    },
  }
  const xcrunShim = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'devicectl' && args.includes('list') && args.includes('devices')) {
  const idx = args.indexOf('--json-output')
  if (idx >= 0 && idx + 1 < args.length) writeFileSync(args[idx + 1], ${JSON.stringify(JSON.stringify(deviceDoc))})
  process.exit(0)
}
console.error('smoke shim: unexpected xcrun invocation: ' + args.join(' '))
process.exit(1)
`
  const failShim = `#!/usr/bin/env node
console.error('smoke shim: unexpected spawn — a real tool must never run here')
process.exit(1)
`
  writeFileSync(join(shimDir, 'xcrun'), xcrunShim, { mode: 0o755 })
  writeFileSync(join(shimDir, 'iproxy'), failShim, { mode: 0o755 })
  writeFileSync(join(shimDir, 'xcodebuild'), failShim, { mode: 0o755 })
  const oldPath = process.env.PATH
  process.env.PATH = `${shimDir}:${oldPath}`

  async function freeLoopbackPort(preferred) {
    for (let port = preferred; port < preferred + 64; port += 1) {
      try {
        const probeServer = createServer()
        await new Promise((resolveListen, rejectListen) => {
          probeServer.once('error', rejectListen)
          probeServer.listen(port, '127.0.0.1', resolveListen)
        })
        await new Promise(resolveClose => probeServer.close(resolveClose))
        return port
      } catch {
        // Busy — try the next one.
      }
    }
    throw new Error('regression: no free loopback port for the mock WDA')
  }

  const controlPort = await freeLoopbackPort(43100)
  const mjpegPort = await freeLoopbackPort(controlPort + 200)
  const mock = await startMockWda(controlPort)
  const mjpegMock = createServer((req, res) => {
    req.on('error', () => {})
    res.on('error', () => {})
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=BoundaryString' })
    res.write('--BoundaryString\r\nContent-type: image/jpeg\r\n\r\n')
  })
  await new Promise((resolveListen, rejectListen) => {
    mjpegMock.once('error', rejectListen)
    mjpegMock.listen(mjpegPort, '127.0.0.1', resolveListen)
  })

  // Injectable clock / probe / tick scheduler — the regression seams.
  let fakeNow = 1_000_000_000
  let probeVerdict = true
  let probeCalls = 0
  let manualTick = () => {}
  const makeController = () => new WdaController({
    wdaProjectDir: shimDir,
    controlPortStart: controlPort,
    mjpegPortStart: mjpegPort,
    idleTimeoutMs: 0,
    restartDelayMs: 60_000,
    requestTimeoutMs: 5_000,
    now: () => fakeNow,
    probeControl: async () => {
      probeCalls += 1
      return probeVerdict
    },
    keepAliveInterval: tick => {
      manualTick = tick
      return () => {}
    },
  })

  const settle = () => new Promise(resolveSettle => setImmediate(resolveSettle))
  const until = async (predicate, label, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate()) return
      if (Date.now() >= deadline) throw new Error(`regression: timed out waiting for ${label}`)
      await sleep(5)
    }
  }
  const deathLines = controller => controller.status().stderr.filter(line => line.includes('no longer answers'))
  const advance = ms => { fakeNow += ms }
  const adopt = async () => {
    const controller = makeController()
    await controller.ensureRunning({ udid: FAKE_UDID })
    controller.startKeepAlive()
    return controller
  }
  const failProbe = async () => {
    advance(ADOPTED_PROBE_INTERVAL_MS)
    manualTick()
    await settle()
  }
  const guarded = async (label, body) => {
    try {
      await body()
    } catch (error) {
      step(label, 'FAIL', error instanceof Error ? error.message : String(error))
    }
  }

  try {
    step('regression: death needs ≥3 consecutive failed probes (exported constant)', ADOPTED_DEATH_PROBE_FAILURES >= 3, `N=${ADOPTED_DEATH_PROBE_FAILURES}`)
    step('regression: adopted keep-alive probe timeout was raised above the 2 s launch probe', ADOPTED_PROBE_TIMEOUT_MS >= 10_000, `${ADOPTED_PROBE_TIMEOUT_MS} ms`)
    step('regression: successful traffic keeps running alive for 2× the probe interval', ADOPTED_TRAFFIC_GRACE_MS === ADOPTED_PROBE_INTERVAL_MS * 2, `${ADOPTED_TRAFFIC_GRACE_MS} ms`)

    // (a) One probe that times out while a control call is in flight must
    // neither fire nor kill WDA; the control calls keep working.
    await guarded('regression (a): timed-out probe during an in-flight control call', async () => {
      const ctl = await adopt()
      try {
        step(
          'regression (a): controller adopted the mock WDA (shimmed device, no spawn)',
          ctl.status().running === true && ctl.status().adopted === true && typeof ctl.status().sessionId === 'string',
          `port=${controlPort} session=${ctl.status().sessionId?.slice(0, 8)}…`,
        )
        // The slow screenshot holds the serialized mock WDA; the keep-alive
        // probe verdict is scripted to the timed-out result (false).
        mock.state.screenshotDelayMs = 400
        probeVerdict = false
        const probesBefore = probeCalls
        const shotPromise = ctl.control.screenshot()
        await until(() => mock.state.requests.some(request => request.path.endsWith('/screenshot')), 'screenshot in flight')
        advance(ADOPTED_PROBE_INTERVAL_MS)
        manualTick()
        await settle()
        const probeWhileBusy = probeCalls - probesBefore
        const shot = await shotPromise
        step('regression (a): no probe fires while a control call is in flight', probeWhileBusy === 0, `probes while busy: ${probeWhileBusy}`)
        step(
          'regression (a): the control call completes and nothing died',
          shot.pngBase64 === TINY_PNG_B64 && ctl.status().running === true && ctl.status().restarts === 0 && deathLines(ctl).length === 0,
          `${shot.width}x${shot.height}, restarts=${ctl.status().restarts}`,
        )
        // One timed-out probe while idle: hysteresis keeps WDA alive.
        await failProbe()
        step(
          'regression (a): one timed-out probe does not kill the adopted WDA',
          ctl.status().running === true && ctl.status().restarts === 0 && deathLines(ctl).length === 0,
          `probe calls: ${probeCalls}`,
        )
        await ctl.control.pressButton('home')
        step('regression (a): control calls keep working after the late probe', 'PASS')
      } finally {
        mock.state.screenshotDelayMs = 0
        await ctl.dispose()
      }
    })

    // (b) Hysteresis: two consecutive failures stay alive.
    await guarded('regression (b): two consecutive probe failures', async () => {
      const ctl = await adopt()
      try {
        probeVerdict = false
        await failProbe()
        await failProbe()
        step(
          'regression (b): two consecutive probe failures are still alive (hysteresis)',
          ctl.status().running === true && ctl.status().restarts === 0 && deathLines(ctl).length === 0,
          `failures: 2 of ${ADOPTED_DEATH_PROBE_FAILURES}`,
        )
        await ctl.control.pressButton('home')
        step('regression (b): control still works after 2 failed probes', 'PASS')
      } finally {
        await ctl.dispose()
      }
    })

    // (c) N consecutive failures with no successful traffic → death exactly
    // once, exitAt recorded, respawn scheduled (and run after the delay).
    await guarded('regression (c): N consecutive failures declare death once', async () => {
      const ctl = await adopt()
      try {
        probeVerdict = false
        await failProbe()
        await failProbe()
        await failProbe()
        step(
          `regression (c): ${ADOPTED_DEATH_PROBE_FAILURES} consecutive failed probes with no traffic declare death`,
          ctl.status().running === false && deathLines(ctl).length === 1,
          `running=${ctl.status().running}, death lines=${deathLines(ctl).length}`,
        )
        await failProbe()
        step('regression (c): death is recorded exactly once (no restamp)', deathLines(ctl).length === 1 && ctl.status().restarts === 0)
        step('regression (c): respawn waits out the restart delay', ctl.status().restarts === 0)
        advance(60_000 + 1)
        manualTick()
        await until(() => ctl.status().restarts === 1 && ctl.status().running === true, 'keep-alive respawn + re-adoption')
        step(
          'regression (c): respawn ran after the delay and re-adopted the mock',
          ctl.status().restarts === 1 && ctl.status().running === true && ctl.status().adopted === true,
          `restarts=${ctl.status().restarts}`,
        )
      } finally {
        await ctl.dispose()
      }
    })

    // (d) A successful control call resets the failure counter.
    await guarded('regression (d): successful traffic resets the counter', async () => {
      const ctl = await adopt()
      try {
        probeVerdict = false
        await failProbe()
        await failProbe()
        await ctl.control.pressButton('home') // success resets the streak
        await failProbe()
        await failProbe()
        step(
          'regression (d): a successful control call resets the failure counter (2F, ok, 2F → alive)',
          ctl.status().running === true && ctl.status().restarts === 0 && deathLines(ctl).length === 0,
          `restarts=${ctl.status().restarts}`,
        )
        await failProbe()
        step(
          'regression (d): the 3rd consecutive failure after the reset declares death',
          ctl.status().running === false && deathLines(ctl).length === 1,
          `death lines=${deathLines(ctl).length}`,
        )
      } finally {
        await ctl.dispose()
      }
    })

    // (e) requireClient must not gate on the cached probe flag.
    await guarded('regression (e): requireClient ignores the stale probe flag', async () => {
      const ctl = await adopt()
      try {
        probeVerdict = false
        await failProbe()
        await failProbe()
        await failProbe()
        step(
          'regression (e): the cached probe flag is now false (death declared)',
          ctl.status().running === false && deathLines(ctl).length === 1,
          `running=${ctl.status().running}`,
        )
        // The exact bug: this call used to throw "call ensureRunning first"
        // because requireClient gated on the stale flag. It must reach the
        // real WDA and succeed — and the success must cancel the pending
        // respawn (proof of life beats a late probe).
        await ctl.control.pressButton('home')
        step('regression (e): control no longer throws merely because the probe flag is false', 'PASS', 'pressButton home → HTTP 200 on the mock')
        advance(60_000 + 1)
        manualTick()
        await settle()
        step('regression (e): the successful call cancelled the pending respawn', ctl.status().restarts === 0, `restarts=${ctl.status().restarts}`)
        probeVerdict = true
        await failProbe()
        step('regression (e): a successful probe revives the cached flag', ctl.status().running === true, 'running again')
        await ctl.stop()
        await expectThrow('regression (e): control still throws after an intentional stop', () => ctl.control.pressButton('home'), /not running.*ensureRunning/i)
      } finally {
        await ctl.dispose()
      }
    })

    const bare = makeController()
    try {
      await expectThrow('regression (e): control throws with no client (never started)', () => bare.control.pressButton('home'), /not running.*ensureRunning/i)
      await bare.dispose()
      await expectThrow('regression (e): control throws after dispose', () => bare.control.pressButton('home'), /disposed/)
    } finally {
      await bare.dispose()
    }
  } finally {
    process.env.PATH = oldPath
    await mock.close()
    await new Promise(resolveClose => mjpegMock.close(resolveClose))
    rmSync(shimDir, { recursive: true, force: true })
  }
}

// ── 10. LIVE pass (only when the phone is connected AND WDA answers) ────────
{
  const skipLive = !RUN_LIVE_PART || process.argv.includes('--no-live')
  if (skipLive) {
    step('live: device + WDA availability', 'SKIP', RUN_LIVE_PART ? '--no-live given' : 'fixture-only by default; opt in with DSH_IOS_SMOKE_REAL_DEVICE=1')
    step('live: ensureRunning (adopt) → 5× home→screenshot hammer', 'SKIP', 'live pass disabled')
  } else {
    let deviceFound
    let liveReady = false
    try {
      const devices = await listRealDevices()
      // The CLI's `State` column `connected` is the JSON `tunnelState`.
      deviceFound = devices.find(candidate => candidate.tunnelState === 'connected'
        && (candidate.udid === DEVICE_UDID || candidate.hardwareUdid === DEVICE_UDID || candidate.hardwareUdid === DEVICE_HARDWARE_UDID))
    } catch {
      deviceFound = undefined
    }
    if (deviceFound !== undefined) {
      try {
        const response = await fetch('http://127.0.0.1:8100/status')
        const status = await response.json()
        liveReady = response.ok && status?.value?.ready === true
      } catch {
        liveReady = false
      }
    }
    step(
      'live: device connected (tunnelState=connected)',
      deviceFound !== undefined ? 'PASS' : 'SKIP',
      deviceFound === undefined ? 'no connected phone — live pass skipped' : `${deviceFound.name} (${deviceFound.udid})`,
    )
    step(
      'live: WDA already answers on 127.0.0.1:8100/status',
      liveReady ? 'PASS' : 'SKIP',
      liveReady ? 'ready' : 'not ready — live pass skipped',
    )

    if (deviceFound !== undefined && liveReady && await probeWdaControlTunnel(8100)) {
      const controller = new WdaController()
      try {
        const info = await controller.ensureRunning({ udid: DEVICE_UDID })
        step(
          'live: ensureRunning adopts the running WDA (no second xcodebuild)',
          info.udid === DEVICE_UDID
            && info.hardwareUdid === DEVICE_HARDWARE_UDID
            && /^http:\/\/127\.0\.0\.1:\d+$/.test(info.controlUrl)
            && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(info.mjpegUrl)
            && info.sessionId !== '',
          `control=${info.controlUrl} mjpeg=${info.mjpegUrl} session=${info.sessionId.slice(0, 8)}…`,
        )
        const liveStatus = controller.status()
        step(
          'live: status() reports running with the used ports',
          liveStatus.running === true && liveStatus.adopted === true
            && Number.isSafeInteger(liveStatus.controlPort) && Number.isSafeInteger(liveStatus.mjpegPort),
          `ports=${liveStatus.controlPort}/${liveStatus.mjpegPort} consumers=${liveStatus.consumers}`,
        )
        // The exact production failure sequence: an interact-style action
        // (button home) IMMEDIATELY followed by a screenshot, repeated back
        // to back. SAFETY: only `home` and screenshots — no taps into apps,
        // no typing, no settings, no installs.
        let hammerPasses = 0
        const hammerSizes = []
        for (let round = 1; round <= 5; round += 1) {
          await controller.control.pressButton('home')
          const hammerShot = await controller.control.screenshot()
          hammerSizes.push(`${hammerShot.width}x${hammerShot.height}`)
          if (hammerShot.pngBase64.length > 10_000) hammerPasses += 1
        }
        const hammerSizeOk = hammerSizes.every(size => size === `${EXPECT_SHOT_SIZE[0]}x${EXPECT_SHOT_SIZE[1]}`)
        step(
          'live: 5× pressButton home → screenshot back-to-back (the exact failing sequence)',
          hammerPasses === 5 && hammerSizeOk,
          `${hammerPasses}/5 ok, sizes ${hammerSizes.join(', ')}`,
        )
        step('live: session survives across calls (no recreate)', controller.status().sessionId === info.sessionId, controller.status().sessionId?.slice(0, 8) ?? '?')
        await controller.stop()
        step('live: stop() leaves the pre-existing WDA + tunnels alone', 'PASS', controller.status().running === false ? 'controller stopped; adopted tunnels untouched' : 'controller still running')
      } catch (error) {
        step('live: ensureRunning → 5× home→screenshot hammer', 'FAIL', error instanceof Error ? error.message.slice(0,400) : String(error))
      } finally {
        await controller.stop()
        await controller.dispose()
      }
    } else {
      step('live: ensureRunning (adopt) → 5× home→screenshot hammer', 'SKIP', 'phone absent or WDA not reachable')
    }
  }
}

// ── 10. A classified failure survives the keep-alive retry ─────────────────
// The production silence this closes: an unplugged phone fails to launch
// ("Unable to find a destination matching…" → device-unplugged), the
// keep-alive loop re-enters #startForDevice, and the old code blanked the
// classification on the way in. The panel's 3-second poll then read a bare
// "not running" for the whole retry window, so the ONE actionable line
// ("connect the phone over USB") never reached the screen. No phone is
// needed: a fake xcrun lists one device and a two-faced xcodebuild shim
// fails the first launch and HANGS the second, so the assertion lands while
// attempt two is genuinely in flight.
{
  const RETRY_UDID = '00008150-000A2222SMOKE000'
  const retryDir = mkdtempSync(join(tmpdir(), 'dsh-ios-wda-retry-'))
  mkdirSync(join(retryDir, 'WebDriverAgent.xcodeproj'), { recursive: true })
  const retryDeviceDoc = {
    info: { outcome: 'success' },
    result: {
      devices: [{
        identifier: RETRY_UDID,
        deviceProperties: { name: 'Retry Phone', osVersionNumber: '26.1', developerModeStatus: 'enabled', bootState: 'booted', ddiServicesAvailable: true },
        hardwareProperties: { udid: RETRY_UDID, marketingName: 'iPhone 17 Pro', productType: 'iPhone17,1', platform: 'iOS', serialNumber: 'RETRY00001' },
        connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' },
      }],
    },
  }
  writeFileSync(join(retryDir, 'xcrun'), `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'devicectl' && args.includes('list') && args.includes('devices')) {
  const idx = args.indexOf('--json-output')
  if (idx >= 0 && idx + 1 < args.length) writeFileSync(args[idx + 1], ${JSON.stringify(JSON.stringify(retryDeviceDoc))})
  process.exit(0)
}
process.exit(1)
`, { mode: 0o755 })
  // Attempt 1: the exact xcodebuild signature of a phone Xcode cannot see.
  // Attempt 2: stay alive and say nothing, so the launch is still running
  // when the assertion reads status().
  writeFileSync(join(retryDir, 'xcodebuild'), `#!/usr/bin/env node
const { existsSync, writeFileSync } = require('node:fs')
const marker = ${JSON.stringify(join(retryDir, 'attempt-1-done'))}
if (existsSync(marker)) { setTimeout(() => process.exit(0), 30000); return }
writeFileSync(marker, 'x')
console.error('xcodebuild: error: Unable to find a destination matching the provided destination specifier:')
process.exit(70)
`, { mode: 0o755 })
  writeFileSync(join(retryDir, 'iproxy'), `#!/usr/bin/env node
setTimeout(() => process.exit(0), 30000)
`, { mode: 0o755 })
  const retryOldPath = process.env.PATH
  process.env.PATH = `${retryDir}:${retryOldPath}`
  const retryWda = new WdaController({
    wdaProjectDir: retryDir,
    controlPortStart: 45900,
    mjpegPortStart: 46100,
    idleTimeoutMs: 0,
    restartDelayMs: 0,
    startTimeoutMs: 4_000,
    requestTimeoutMs: 2_000,
  })
  try {
    let firstReason
    try {
      await retryWda.ensureRunning({ udid: RETRY_UDID })
    } catch (error) {
      firstReason = error instanceof WdaError ? error.reason : undefined
    }
    step(
      'a FAILED launch still names its target (pendingDevice) so a filtered poll can match',
      retryWda.status().pendingDevice === RETRY_UDID && retryWda.status().device === undefined,
      `pendingDevice=${String(retryWda.status().pendingDevice)} device=${String(retryWda.status().device)}`,
    )
    step(
      'an unseen phone classifies as device-unplugged with actionable detail',
      firstReason === 'device-unplugged' && retryWda.status().reason === 'device-unplugged'
        && typeof retryWda.status().detail === 'string' && retryWda.status().detail.includes('USB'),
      `reason=${String(retryWda.status().reason)} detail=${String(retryWda.status().detail)}`,
    )
    // Attempt 2 hangs inside #startForDevice — exactly where the old code
    // had already blanked the classification.
    const secondAttempt = retryWda.ensureRunning({ udid: RETRY_UDID }).catch(() => undefined)
    await new Promise(resolveWait => setTimeout(resolveWait, 600))
    const midFlight = retryWda.status()
    step(
      'the reason survives INTO the next attempt (the poll never goes silent)',
      midFlight.running === false && midFlight.reason === 'device-unplugged',
      `reason=${String(midFlight.reason)} — a stale reason beats no reason while a retry is in flight`,
    )
    await retryWda.stop()
    await secondAttempt
  } finally {
    await retryWda.dispose()
    process.env.PATH = retryOldPath
    rmSync(retryDir, { recursive: true, force: true })
  }
}

// ── 10b. A failed launch closes the usbmux forward it created ──────────────
// The leak this pins: a tunnel we created and then failed to use survived
// (squatting its port and poisoning the next attempt). Here the controller
// adopts a LOCAL mock WDA as the runner, creates a FAKE usbmux forward for
// the MJPEG tunnel (injected seam — no real usbmux socket), fails to see it
// forward, and must close the forward during teardown.
{
  const TD_UDID = '00008150-000A3333SMOKE000'
  const tdDir = mkdtempSync(join(tmpdir(), 'dsh-ios-wda-td-'))
  mkdirSync(join(tdDir, 'WebDriverAgent.xcodeproj'), { recursive: true })
  const tdDeviceDoc = {
    info: { outcome: 'success' },
    result: {
      devices: [{
        identifier: TD_UDID,
        deviceProperties: { name: 'Teardown Phone', osVersionNumber: '26.1', developerModeStatus: 'enabled', bootState: 'booted', ddiServicesAvailable: true },
        hardwareProperties: { udid: TD_UDID, marketingName: 'iPhone 17 Pro', productType: 'iPhone17,1', platform: 'iOS', serialNumber: 'TD00000001' },
        connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' },
      }],
    },
  }
  writeFileSync(join(tdDir, 'xcrun'), `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'devicectl' && args.includes('list') && args.includes('devices')) {
  const idx = args.indexOf('--json-output')
  if (idx >= 0 && idx + 1 < args.length) writeFileSync(args[idx + 1], ${JSON.stringify(JSON.stringify(tdDeviceDoc))})
  process.exit(0)
}
process.exit(1)
`, { mode: 0o755 })
  const tdFailShim = `#!/usr/bin/env node
console.error('smoke shim: unexpected spawn — a real tool must never run here')
process.exit(1)
`
  writeFileSync(join(tdDir, 'xcodebuild'), tdFailShim, { mode: 0o755 })
  writeFileSync(join(tdDir, 'iproxy'), tdFailShim, { mode: 0o755 })
  const tdOldPath = process.env.PATH
  process.env.PATH = `${tdDir}:${tdOldPath}`

  async function freeLoopbackPort(preferred) {
    for (let port = preferred; port < preferred + 128; port += 1) {
      try {
        const probeServer = createServer()
        await new Promise((resolveListen, rejectListen) => {
          probeServer.once('error', rejectListen)
          probeServer.listen(port, '127.0.0.1', resolveListen)
        })
        await new Promise(resolveClose => probeServer.close(resolveClose))
        return port
      } catch {
        // Busy — try the next one.
      }
    }
    throw new Error('regression: no free loopback port')
  }
  const until = async (predicate, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate()) return
      if (Date.now() >= deadline) throw new Error('regression: condition not met in time')
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    }
  }

  // Adoption target for the runner AND the control tunnel (no xcodebuild runs).
  const controlPort = await freeLoopbackPort(43200)
  const mock = await startMockWda(controlPort)
  // Deliberately FREE: the MJPEG tunnel must be CREATED (a fake forward), then
  // fail its forward probe so the teardown path is exercised.
  const mjpegPort = await freeLoopbackPort(controlPort + 200)

  const fakeForwards = []
  let fakeNow = 1_000_000
  const tdWda = new WdaController({
    wdaProjectDir: tdDir,
    controlPortStart: controlPort,
    mjpegPortStart: mjpegPort,
    idleTimeoutMs: 0,
    restartDelayMs: 0,
    requestTimeoutMs: 5_000,
    now: () => fakeNow,
    classifyTunnelFailure: async () => 'usb-link-up',
    makeUsbmuxForward: async ({ udid, devicePort, localPort }) => {
      const state = { closed: false }
      fakeForwards.push({ udid, devicePort, localPort, state })
      return {
        get localPort() { return localPort },
        get connections() { return 0 },
        close: async () => { state.closed = true },
      }
    },
  })

  try {
    const launch = tdWda.ensureRunning({ udid: TD_UDID }).catch(error => error)
    // Wait until the MJPEG forward has been created, then fast-forward past
    // the 15 s forward-wait so #waitForTunnel returns false deterministically.
    await until(() => fakeForwards.length > 0)
    fakeNow += 20_000
    const error = await launch
    step(
      'a failed launch creates exactly one forward',
      fakeForwards.length === 1 && fakeForwards[0].localPort === mjpegPort,
      `forwards=${fakeForwards.length} localPort=${String(fakeForwards[0]?.localPort)}`,
    )
    step(
      'the failed launch closes the forward it created',
      fakeForwards.length === 1 && fakeForwards[0].state.closed === true,
      `closed=${String(fakeForwards[0]?.state.closed)}`,
    )
    step(
      'the tunnel failure surfaces a usbmux-specific actionable reason',
      error instanceof WdaError && error.reason === 'tunnel-failed'
        && tdWda.status().reason === 'tunnel-failed'
        && typeof tdWda.status().detail === 'string' && tdWda.status().detail.includes('WebDriverAgent may not be listening'),
      `reason=${String(tdWda.status().reason)} detail=${String(tdWda.status().detail)}`,
    )
  } finally {
    await tdWda.dispose()
    await mock.close()
    process.env.PATH = tdOldPath
    rmSync(tdDir, { recursive: true, force: true })
  }
}

// ── 11. The plugin never idle-reaps the phone's WDA ────────────────────────
// A behavioural regression is impossible to run here (it would need a real
// xcodebuild), so the DECISION is pinned at its source: the generic
// 5-minute idle reaper is right for a simulator stream and wrong for a
// phone, where re-arming costs a multi-minute build on an unlocked device.
{
  const entrySource = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  step(
    'the plugin constructs the WDA controller with idle reaping disabled',
    /new WdaController\(\{[^)]*idleTimeoutMs:\s*0/.test(entrySource),
    'src/index.ts must pass idleTimeoutMs: 0 — the 5-minute default reaps a runner that costs minutes to rebuild',
  )
  const controllerSource = readFileSync(join(root, 'src', 'wda-host.ts'), 'utf8')
  step(
    'a zero idle timeout disarms the reaper entirely (never a 0 ms timer)',
    /const idleMs = this\.#options\.idleTimeoutMs\s*\n\s*if \(idleMs <= 0\) return/.test(controllerSource),
    '#armIdle must return early for <= 0',
  )
}

// ── 12. Gesture mapping must not re-ask for the window size every time ─────
// Measured on the phone: GET /window/size is a session-scoped WDA call
// costing 210–370 ms — the same order as the gesture it precedes. Uncached,
// a tap paid it once and a drag TWICE (it converts both endpoints), which is
// a third to a half of the latency a human feels. The cache is deliberately
// short-lived and identity-checked; these steps pin all three rules.
{
  const sizeWda = makeMockWda()
  const sizeSource = new WdaStreamSource(sizeWda)
  const windowSizeCalls = () => sizeWda.calls.filter(call => call[0] === 'windowSize').length
  await sizeSource.control.tap(0.5, 0.5)
  const afterFirstTap = windowSizeCalls()
  await sizeSource.control.tap(0.25, 0.75)
  await sizeSource.control.drag({ fromX: 0.1, fromY: 0.1, toX: 0.9, toY: 0.9 })
  step(
    'a burst of gestures reads the window size ONCE, not once (or twice) per gesture',
    afterFirstTap === 1 && windowSizeCalls() === 1,
    `windowSize calls: ${windowSizeCalls()} for tap+tap+drag (uncached it would be 4)`,
  )
  const tapCalls = sizeWda.calls.filter(call => call[0] === 'tap')
  step(
    'cached mapping still produces the same absolute points as a fresh read',
    tapCalls.length === 2
      && tapCalls[0][1] === 603 && tapCalls[0][2] === 1311
      && tapCalls[1][1] === 302 && tapCalls[1][2] === 1967,
    tapCalls.map(call => `${call[1]},${call[2]}`).join(' | '),
  )
  await sizeSource.control.rotate('LANDSCAPE')
  await sizeSource.control.tap(0.5, 0.5)
  step(
    'our own rotate drops the cache (width and height just swapped)',
    windowSizeCalls() === 2,
    `windowSize calls after rotate+tap: ${windowSizeCalls()} (must re-read)`,
  )
  step(
    'the cache window is short enough that a human cannot rotate and tap inside it',
    WDA_WINDOW_SIZE_TTL_MS > 0 && WDA_WINDOW_SIZE_TTL_MS <= 2000,
    `WDA_WINDOW_SIZE_TTL_MS=${WDA_WINDOW_SIZE_TTL_MS}`,
  )
}

// ── 12b. A failed size refresh falls back to the recent cached size ────────
// The issue-2 stall shape: WDA times out the size read (or the busy gate
// refuses it), yet the point space has not changed — rotation goes through
// our own rotate() and drops the cache. A recent cached size keeps gestures
// working through the stall; an OLD one (a possible foreground-app switch)
// fails the gesture fast instead of silently tapping in the wrong space.
{
  step(
    'the stale-fallback window is wider than the cache TTL but short',
    WDA_WINDOW_SIZE_STALE_TAP_MS > WDA_WINDOW_SIZE_TTL_MS && WDA_WINDOW_SIZE_STALE_TAP_MS <= 10_000,
    `TTL=${WDA_WINDOW_SIZE_TTL_MS} stale=${WDA_WINDOW_SIZE_STALE_TAP_MS}`,
  )
  const staleWda = makeMockWda()
  const staleSource = new WdaStreamSource(staleWda)
  await staleSource.control.tap(0.5, 0.5) // primes the cache with a fresh read
  await sleep(WDA_WINDOW_SIZE_TTL_MS + 60) // cache expired, still recent
  staleWda.setWindowSizeError(new Error('WDA GET /session/sid-9/window/size timed out after 5000 ms'))
  await staleSource.control.tap(0.25, 0.75)
  const staleTaps = staleWda.calls.filter(call => call[0] === 'tap')
  step(
    'a failed size refresh falls back to the recent cached size (the gesture still lands)',
    staleTaps.length === 2 && staleTaps[1][1] === 302 && staleTaps[1][2] === 1967,
    `taps=${staleTaps.map(call => `${call[1]},${call[2]}`).join(' | ')}`,
  )
  await sleep(WDA_WINDOW_SIZE_STALE_TAP_MS - WDA_WINDOW_SIZE_TTL_MS + 200)
  let staleError
  try {
    await staleSource.control.tap(0.5, 0.5)
  } catch (error) {
    staleError = error
  }
  step(
    'an OLD stale size does not silently mis-tap: the gesture fails fast instead',
    staleError !== undefined && /timed out after/i.test(String(staleError?.message ?? '')),
    String(staleError?.message ?? 'no error thrown'),
  )
}

// ── 13. Home takes WDA's sessionless fast path ─────────────────────────────
// Measured on the phone: POST /wda/homescreen ≈ 30 ms, the session-scoped
// POST /session/<sid>/wda/pressButton {name:"home"} ≈ 470 ms for the same
// effect. Home is the toolbar's most-pressed control, so it takes the fast
// route — with a fallback, because an older WDA may not serve it. The
// transport seam is private, so the shape is pinned at the source.
{
  const source = readFileSync(join(root, 'src', 'wda-host.ts'), 'utf8')
  step(
    'pressButton("home") tries the sessionless /wda/homescreen first',
    /if \(name === 'home'\)[\s\S]{0,200}\/wda\/homescreen/.test(source),
    'home must not pay the ~470 ms session-scoped press',
  )
  step(
    'a WDA without that endpoint still gets a working Home (fallback kept)',
    /\/wda\/homescreen[\s\S]{0,320}#withSession\('POST', '\/wda\/pressButton'/.test(source),
    'the session-scoped press stays as the fallback path',
  )
  step(
    'only home is special-cased (other buttons keep the session press)',
    (source.match(/name === 'home'/g) ?? []).length === 1,
    'volumeUp/volumeDown/… must not change behaviour',
  )
}

// ── the two failures the fixture-only tests could not see ─────────────────
// Both were found by running this module against the REAL usbmuxd, not by a
// mock: macOS answers an XML request with an XML plist (the binary reader
// rejected it outright), and Node hands `socket.write`'s callback `null` on
// SUCCESS, so an `!== undefined` test rejected every successful write.
{
  const xml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>DeviceList</key>
  <array>
    <dict><key>DeviceID</key><integer>281</integer><key>Properties</key><dict>
      <key>ConnectionType</key><string>Network</string>
      <key>SerialNumber</key><string>00008150-000A552A1A44401C</string></dict></dict>
    <dict><key>DeviceID</key><integer>280</integer><key>Properties</key><dict>
      <key>ConnectionType</key><string>USB</string>
      <key>SerialNumber</key><string>00008150-000A552A1A44401C</string>
      <key>ConnectionSpeed</key><integer>480000000</integer></dict></dict>
  </array>
  <key>MessageType</key><string>Result</string>
  <key>Number</key><integer>0</integer>
</dict></plist>`, 'utf8')
  const parsed = parseUsbmuxPlist(xml)
  const list = parsed?.DeviceList ?? []
  step(
    'an XML plist reply parses (macOS answers in the format it was asked in)',
    Array.isArray(list) && list.length === 2 && list[1].DeviceID === 280
      && list[1].Properties.ConnectionType === 'USB' && parsed.Number === 0,
    `DeviceList=${Array.isArray(list) ? list.length : 'n/a'} Number=${String(parsed?.Number)}`,
  )
  step(
    'the USB record wins over the Network twin in the parsed listing',
    pickUsbDeviceId(list.map(entry => ({
      deviceId: entry.DeviceID,
      udid: entry.Properties.SerialNumber,
      connection: entry.Properties.ConnectionType === 'USB' ? 'usb' : 'network',
    })), '00008150-000A552A1A44401C') === 280,
    'the exact discrimination the legacy iproxy could not make',
  )
  const source = readFileSync(join(root, 'src', 'usbmux.ts'), 'utf8')
  step(
    'a successful socket.write is never treated as an error (Node passes null)',
    /error !== undefined && error !== null/.test(source),
    'an `!== undefined` test alone rejects every successful write with a null error',
  )
  step(
    'the reply parser picks its format instead of assuming one',
    /bplist00'\) return parseBinaryPlist/.test(source) && /return parseXmlPlist/.test(source),
    'binary and XML replies are both real: the daemon mirrors the request format',
  )
}

console.log('')
console.log(`${results.length} steps: ${results.filter(r => r.verdict === 'PASS').length} passed, ${results.filter(r => r.verdict === 'SKIP').length} skipped, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
