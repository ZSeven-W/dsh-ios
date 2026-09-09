/**
 * Targeted smoke test for the public host-independent iOS QA driver.
 *
 * Run after `pnpm run build` (or `tsc -p tsconfig.json`):
 *   node scripts/dev-qa-driver-smoke.mjs
 *
 * Covers the backend-level surface requested for the QA integration:
 * - host-free subpath import (no @deepseek-ai runtime import in driver)
 * - discover/route simulator vs physical with explicit udids
 * - no silent cross-device routing
 * - observation security/value suppression, bounds/truncation, depth
 * - screenshot pixel dimensions from actual PNG/WDA metadata
 * - coordinate mapping through actual point sizes (not Retina constants)
 * - simulator foreground verification (fresh PID -> exact launchctl join via
 *   injected seam) and disposal semantics for injected backends
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []

function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

async function tryStep(name, fn) {
  try {
    await fn()
  } catch (error) {
    step(name, false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
}

const driverPath = join(root, 'lib', 'qa-driver.js')
const {
  createIosQaBackend,
  IosQaError,
} = await import(driverPath)
const { sanitizeAxeNode } = await import(join(root, 'lib', 'uitree-backend.js'))

step('driver subpath compiled and exports factory/error', typeof createIosQaBackend === 'function' && typeof IosQaError === 'function', driverPath)
const driverSource = readFileSync(join(root, 'src', 'qa-driver.ts'), 'utf8')
step('driver source has no eager @deepseek-ai imports', !/from\s+['"]@deepseek-ai|require\(['"]@deepseek-ai|import\(['"]@deepseek-ai/u.test(driverSource))

// Synthetic AXe roots in the sanitized shape produced by describeUi().
const secureRaw = sanitizeAxeNode({
  type: 'TextField',
  AXLabel: 'Secret input',
  AXUniqueId: 'qa.input.secret',
  AXValue: 'Secret value',
  role: 'AXTextField',
  subrole: 'AXSecureTextField',
  pid: 53004,
  enabled: true,
  frame: { x: 16, y: 172, width: 370, height: 44 },
  children: [],
})
const plainRaw = sanitizeAxeNode({
  type: 'TextField',
  AXLabel: 'Name input',
  AXUniqueId: 'qa.input.name',
  AXValue: 'QAProbe',
  role: 'AXTextField',
  subrole: null,
  frame: { x: 16, y: 116, width: 370, height: 44 },
  children: [],
})
const appRoot = sanitizeAxeNode({
  type: 'Application',
  AXLabel: 'QA Fixture',
  pid: 53004,
  frame: { x: 0, y: 0, width: 402, height: 874 },
  children: [plainRaw, secureRaw],
})
const simDevice = { udid: 'SIM', name: 'iPhone Sim', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', state: 'Booted' }
const realDevice = { udid: 'REAL', name: 'iPhone Physical', osVersion: '26.6', model: 'iPhone 17 Pro', state: 'available (paired)', pairingState: 'paired' }

const simControls = []
const simHost = {
  async control(args) {
    simControls.push(args)
    return { stdout: '', stderr: '' }
  },
  status() {
    return { available: true, running: true, restarts: 0, consumers: 0, serveSimSource: 'package-bin' }
  },
  async ensureRunning() {
    return { url: 'http://127.0.0.1:3181', streamUrl: 'http://127.0.0.1:3181/stream.mjpeg', wsUrl: 'ws://127.0.0.1:3181/ws', port: 3181, device: simDevice.udid }
  },
  async stop() {},
  async dispose() {},
  streamInfo: undefined,
}

const wdaControls = []
const wdaBackend = {
  async ensureRunning() {
    return { udid: realDevice.udid, hardwareUdid: realDevice.udid, controlUrl: 'http://127.0.0.1:8100', mjpegUrl: 'http://127.0.0.1:9100', sessionId: 'sid-1' }
  },
  status() {
    return { available: true, running: true, device: realDevice.udid, controlUrl: 'http://127.0.0.1:8100', sessionId: 'sid-1', consumers: 0 }
  },
  async stop() {},
  acquire() { return () => {} },
  release() {},
  mjpegUrl: 'http://127.0.0.1:9100',
  control: {
    async tap(x, y) { wdaControls.push(['tap', x, y]) },
    async dragFromToForDuration(drag) { wdaControls.push(['drag', drag]) },
    async typeText(text) { wdaControls.push(['typeText', text]) },
    async pressButton(name) { wdaControls.push(['pressButton', name]) },
    async lock() { wdaControls.push(['lock']) },
    async unlock() { wdaControls.push(['unlock']) },
    async activateSiri() { wdaControls.push(['activateSiri']) },
    async activeAppInfo() { return { pid: 111, bundleId: 'dev.zseven.qa.fixture.ios', name: 'QA Fixture' } },
    async screenshot() { return { pngBase64: Buffer.from('fake', 'utf8').toString('base64'), width: 1206, height: 2622 } },
    async source() { return '<XCUIElementTypeApplication name="QA Fixture"><XCUIElementTypeSecureTextField name="pwd" label="Secret input" identifier="qa.input.secret" value="Secret value" enabled="true" visible="true" x="16" y="172" width="370" height="44"/></XCUIElementTypeApplication>' },
    async setSnapshotDepth() {},
    async windowSize() { return { width: 402, height: 874 } },
    async getOrientation() { return 'PORTRAIT' },
    async setOrientation() {},
  },
}

async function makeBackend(overrides = {}) {
  return createIosQaBackend({
    simDevices: { list: async () => [simDevice], matches: async reference => reference === simDevice.udid },
    realDevices: { list: async () => [realDevice], matches: async reference => reference === realDevice.udid },
    sim: simHost,
    wda: wdaBackend,
    axe: async () => [appRoot],
    ...overrides,
  })
}

await tryStep('discover classifies simulator and physical explicitly', async () => {
  const backend = await makeBackend()
  const devices = await backend.discover()
  const sim = devices.find(device => device.udid === simDevice.udid)
  const real = devices.find(device => device.udid === realDevice.udid)
  step('discover classifies simulator and physical explicitly', sim?.kind === 'simulator' && real?.kind === 'physical', JSON.stringify(devices))
})

await tryStep('simulator launch routes to simulator launcher with explicit udid', async () => {
  const launches = []
  const backend = await makeBackend({ simLaunch: async (udid, bundleId) => { launches.push([udid, bundleId]); return '123' } })
  const result = await backend.launchApp(simDevice.udid, 'dev.zseven.qa.fixture.ios')
  step('simulator launch routes to simulator launcher with explicit udid', result.ok === true && result.backend === 'simulator' && launches.length === 1 && launches[0][0] === simDevice.udid, JSON.stringify(result))
})

await tryStep('physical launch routes to physical launcher', async () => {
  const launches = []
  const backend = await makeBackend({ realLaunch: async (udid, bundleId) => { launches.push([udid, bundleId]); return { pid: 42 } } })
  const result = await backend.launchApp(realDevice.udid, 'dev.zseven.qa.fixture.ios')
  step('physical launch routes to physical launcher', result.ok === true && result.backend === 'physical' && launches.length === 1 && launches[0][0] === realDevice.udid, JSON.stringify(result))
})

await tryStep('unknown udid throws unknown-device, never cross-routes', async () => {
  const before = simControls.length + wdaControls.length
  const backend = await makeBackend()
  let threw = false
  try {
    await backend.tap('NO-SUCH-DEVICE', 10, 10)
  } catch (error) {
    threw = error instanceof IosQaError && error.code === 'unknown-device'
  }
  const after = simControls.length + wdaControls.length
  step('unknown udid throws unknown-device, never cross-routes', threw && before === after, `simControls=${simControls.length} wdaControls=${wdaControls.length}`)
})

await tryStep('simulator observe suppresses secure values and keeps native identifiers', async () => {
  const backend = await makeBackend()
  const observation = await backend.observe(simDevice.udid, { maxNodes: 20 })
  const plain = observation.nodes.find(node => node.identifier === 'qa.input.name')
  const secure = observation.nodes.find(node => node.identifier === 'qa.input.secret')
  const hasSynthetic = observation.nodes.some(node => node.identifier !== undefined && node.identifier.startsWith('path:'))
  step(
    'simulator observe suppresses secure values and keeps native identifiers',
    plain?.value === 'QAProbe'
      && secure?.value === undefined
      && secure?.secure === true
      && secure?.name === 'Secret input'
      && !hasSynthetic,
    JSON.stringify(observation.nodes),
  )
  step('simulator observe reports actual app and screen point size', observation.app.name === 'QA Fixture' && observation.screen.width === 402 && observation.screen.height === 874, JSON.stringify(observation.app))
})

await tryStep('physical observe maps WDA SecureTextField without emitting value', async () => {
  const backend = await makeBackend()
  const observation = await backend.observe(realDevice.udid, { maxNodes: 20 })
  const secure = observation.nodes.find(node => node.type === 'SecureTextField')
  step(
    'physical observe maps WDA SecureTextField without emitting value',
    secure?.secure === true && secure?.value === undefined && observation.app.verified === true && observation.screen.width === 402,
    JSON.stringify(observation.nodes),
  )
})

await tryStep('owned physical WDA stops only its exact device on releaseDevice', async () => {
  let ensures = 0; let stops = 0
  let ensuredUdid
  const owned = { async ensureRunning({ udid }) { ensuredUdid = udid; ensures += 1; return { udid, hardwareUdid: udid, controlUrl: 'http://127.0.0.1:8100', mjpegUrl: 'http://127.0.0.1:9100', sessionId: 'owned' } }, async stop() { stops += 1 }, status() { return { available: true, running: true, device: realDevice.udid, consumers: 0 } }, acquire() { return () => {} }, release() {}, mjpegUrl: undefined, control: { async source() { return '<XCUIElementTypeApplication name="QA Fixture"><XCUIElementTypeStaticText name="Ready" label="Ready" value="Ready" x="0" y="0" width="40" height="20"/></XCUIElementTypeApplication>' }, async setSnapshotDepth() {}, async windowSize() { return { width: 402, height: 874 } }, async activeAppInfo() { return { pid: 111, bundleId: TT_BUNDLE } }, async screenshot() { return { pngBase64: 'Zg==', width: 402, height: 874 } }, async tap() {}, async dragFromToForDuration() {}, async typeText() {}, async pressButton() {}, async lock() {}, async unlock() {}, async activateSiri() {}, async setOrientation() {} } }
  const backend = createIosQaBackend({ simDevices: { list: async () => [] }, realDevices: { list: async () => [realDevice], matches: async ref => ref === realDevice.udid }, resolveSigningTeam: async () => ({ teamId: 'TEAM', source: 'option', detail: 'smoke' }), stagePhysicalWda: async () => ({ stageDir: '/tmp/wda' }), wdaFactory: () => owned })
  await backend.observe(realDevice.udid); await backend.releaseDevice(realDevice.udid)
  step('owned WDA ensured then stopped once', ensures === 1 && stops === 1, `ensures=${ensures} stops=${stops} ensuredUdid=${ensuredUdid} releaseUdid=${realDevice.udid}`)
  await backend.dispose()
})

await tryStep('releaseDevice does not stop another device or an injected WDA', async () => {
  let stops = 0
  const fake = { async ensureRunning({ udid }) { return { udid, hardwareUdid: udid, controlUrl: '', mjpegUrl: '', sessionId: 'injected' } }, async stop() { stops += 1 }, status() { return { available: true, running: true, consumers: 0 } }, acquire() { return () => {} }, release() {}, mjpegUrl: undefined, control: { async source() { return '<XCUIElementTypeApplication name="QA Fixture"/>' }, async setSnapshotDepth() {}, async windowSize() { return { width: 402, height: 874 } }, async activeAppInfo() { return { pid: 111, bundleId: TT_BUNDLE } }, async screenshot() { return { pngBase64: 'Zg==', width: 402, height: 874 } }, async tap() {}, async dragFromToForDuration() {}, async typeText() {}, async pressButton() {}, async lock() {}, async unlock() {}, async activateSiri() {}, async setOrientation() {} } }
  const backend = createIosQaBackend({ simDevices: { list: async () => [] }, realDevices: { list: async () => [realDevice], matches: async ref => ref === realDevice.udid }, wda: fake })
  await backend.releaseDevice('OTHER-DEVICE'); step('injected WDA is never stopped', stops === 0)
  await backend.dispose()
})

await tryStep('a later owned ensure supersedes an older device binding', async () => {
  const devices = [{ ...realDevice, udid: 'A' }, { ...realDevice, udid: 'B' }]
  let current = ''; let stops = 0
  const owned = { async ensureRunning({ udid }) { current = udid; return { udid, hardwareUdid: udid, controlUrl: '', mjpegUrl: '', sessionId: udid } }, async stop() { stops += 1 }, status() { return { available: true, running: true, device: current, consumers: 0 } }, acquire() { return () => {} }, release() {}, mjpegUrl: undefined, control: { async source() { return '<XCUIElementTypeApplication name="QA Fixture"><XCUIElementTypeStaticText name="Ready" label="Ready" value="Ready" x="0" y="0" width="40" height="20"/></XCUIElementTypeApplication>' }, async setSnapshotDepth() {}, async windowSize() { return { width: 402, height: 874 } }, async activeAppInfo() { return { pid: 111, bundleId: TT_BUNDLE } }, async screenshot() { return { pngBase64: 'Zg==', width: 402, height: 874 } }, async tap() {}, async dragFromToForDuration() {}, async typeText() {}, async pressButton() {}, async lock() {}, async unlock() {}, async activateSiri() {}, async setOrientation() {} } }
  const backend = createIosQaBackend({ simDevices: { list: async () => [] }, realDevices: { list: async () => devices, matches: async ref => ref === 'A' || ref === 'B' }, resolveSigningTeam: async () => ({ teamId: 'TEAM', source: 'option', detail: 'smoke' }), stagePhysicalWda: async () => ({ stageDir: '/tmp/wda' }), wdaFactory: () => owned })
  await backend.observe('A'); await backend.observe('B'); await backend.releaseDevice('A'); step('older device does not stop newer WDA', stops === 0); await backend.releaseDevice('B'); step('current device stops owned WDA', stops === 1); await backend.dispose()
})

await tryStep('owned WDA stop failure propagates as typed cleanup error', async () => {
  const owned = { async ensureRunning({ udid }) { return { udid, hardwareUdid: udid, controlUrl: '', mjpegUrl: '', sessionId: 'failure' } }, async stop() { throw new Error('stop failed') }, status() { return { available: true, running: true, device: realDevice.udid, consumers: 0 } }, acquire() { return () => {} }, release() {}, mjpegUrl: undefined, control: { async source() { return '<XCUIElementTypeApplication name="QA Fixture"><XCUIElementTypeStaticText name="Ready" label="Ready" value="Ready" x="0" y="0" width="40" height="20"/></XCUIElementTypeApplication>' }, async setSnapshotDepth() {}, async windowSize() { return { width: 402, height: 874 } }, async activeAppInfo() { return { pid: 111, bundleId: TT_BUNDLE } }, async screenshot() { return { pngBase64: 'Zg==', width: 402, height: 874 } }, async tap() {}, async dragFromToForDuration() {}, async typeText() {}, async pressButton() {}, async lock() {}, async unlock() {}, async activateSiri() {}, async setOrientation() {} } }
  const backend = createIosQaBackend({ simDevices: { list: async () => [] }, realDevices: { list: async () => [realDevice], matches: async ref => ref === realDevice.udid }, resolveSigningTeam: async () => ({ teamId: 'TEAM', source: 'option', detail: 'smoke' }), stagePhysicalWda: async () => ({ stageDir: '/tmp/wda' }), wdaFactory: () => owned })
  await backend.observe(realDevice.udid); let thrown
  try { await backend.releaseDevice(realDevice.udid) } catch (error) { thrown = error }
  step('stop failure is typed and not treated as success', thrown?.code === 'wda.release-failed', thrown?.message)
  await backend.dispose().catch(() => {})
})

await tryStep('observe maxNodes truncates honestly and reports depth', async () => {
  const deepRoot = sanitizeAxeNode({
    type: 'Application',
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      sanitizeAxeNode({ type: 'Group', frame: { x: 0, y: 0, width: 402, height: 874 }, children: [
        sanitizeAxeNode({ type: 'StaticText', AXLabel: 'leaf', frame: { x: 10, y: 10, width: 50, height: 20 } }),
      ] }),
    ],
  })
  const backend = await makeBackend({ axe: async () => [deepRoot] })
  const observation = await backend.observe(simDevice.udid, { maxNodes: 2 })
  step('observe maxNodes truncates honestly and reports depth', observation.truncated === true && observation.nodes.length === 2 && observation.depth === 1, JSON.stringify({ length: observation.nodes.length, depth: observation.depth, truncated: observation.truncated }))
})

await tryStep('simulator tap maps points through actual AXe point size', async () => {
  simControls.length = 0
  const backend = await makeBackend()
  const result = await backend.tap(simDevice.udid, 201, 437)
  const tapCall = simControls.find(args => args[0] === 'tap')
  step(
    'simulator tap maps points through actual AXe point size',
    result.ok === true
      && tapCall !== undefined
      && Math.abs(Number(tapCall[1]) - 0.5) < 0.0001
      && Math.abs(Number(tapCall[2]) - 0.5) < 0.0001,
    JSON.stringify(tapCall),
  )
})

await tryStep('physical scroll maps normalized gesture through actual WDA window size', async () => {
  wdaControls.length = 0
  const backend = await makeBackend()
  const result = await backend.scroll(realDevice.udid, 'down', 0.5)
  const drag = wdaControls.find(call => call[0] === 'drag')
  step(
    'physical scroll maps normalized gesture through actual WDA window size',
    result.ok === true
      && drag !== undefined
      && drag[1].fromX === 201
      && drag[1].fromY === 437
      && drag[1].toY < drag[1].fromY,
    JSON.stringify(drag),
  )
})

await tryStep('simulator screenshot uses actual pixel dimensions', async () => {
  const backend = await makeBackend({ simScreenshot: async () => ({ pngBase64: Buffer.from('fake-png', 'utf8').toString('base64'), width: 1206, height: 2622 }) })
  const shot = await backend.screenshot(simDevice.udid)
  step('simulator screenshot uses actual pixel dimensions', shot.backend === 'simulator' && shot.width === 1206 && shot.height === 2622 && shot.pngBase64.length > 0, JSON.stringify({ width: shot.width, height: shot.height }))
})

await tryStep('physical screenshot uses actual pixel dimensions', async () => {
  const backend = await makeBackend()
  const shot = await backend.screenshot(realDevice.udid)
  step('physical screenshot uses actual pixel dimensions', shot.backend === 'physical' && shot.width === 1206 && shot.height === 2622, JSON.stringify({ width: shot.width, height: shot.height }))
})

await tryStep('simulator foreground joins fresh AXe pid to exact launchctl bundle', async () => {
  const backend = await makeBackend({
    simForegroundApp: async (udid, pid) => ({
      pid,
      bundleId: 'dev.zseven.qa.fixture.ios',
      name: 'QA Fixture',
      verified: true,
    }),
  })
  const foreground = await backend.foregroundApp(simDevice.udid)
  step('simulator foreground joins fresh AXe pid to exact launchctl bundle', foreground.app.verified === true && foreground.app.bundleId === 'dev.zseven.qa.fixture.ios' && foreground.app.pid === 53004, JSON.stringify(foreground))
})

await tryStep('foreground reports unverified capability instead of pretending', async () => {
  const backend = await makeBackend({
    simForegroundApp: async (_udid, pid) => ({
      pid,
      verified: false,
      capability: 'simulator.foreground-app.unavailable',
      reason: 'race/no exact launchctl entry',
    }),
  })
  const foreground = await backend.foregroundApp(simDevice.udid)
  step('foreground reports unverified capability instead of pretending', foreground.app.verified === false && foreground.unsupported?.capability === 'simulator.foreground-app.unavailable', JSON.stringify(foreground))
})

await tryStep('physical keys route by key vocabulary and unsupported volume on simulator is explicit', async () => {
  wdaControls.length = 0
  const backend = await makeBackend()
  const physicalKey = await backend.key(realDevice.udid, 'home')
  const simVolume = await backend.key(simDevice.udid, 'volumeUp')
  const physicalPress = wdaControls.find(call => call[0] === 'pressButton')
  step(
    'physical keys route by key vocabulary and unsupported volume on simulator is explicit',
    physicalKey.ok === true && physicalPress?.[1] === 'home' && simVolume.ok === false && simVolume.unsupported?.capability === 'simulator.volume-keys.unsupported',
    JSON.stringify({ physicalKey, simVolume }),
  )
})

await tryStep('dispose does not dispose injected backends', async () => {
  let simStopped = false
  let wdaStopped = false
  const customSim = { ...simHost, async stop() { simStopped = true }, async dispose() { simStopped = true } }
  const customWda = { ...wdaBackend, async stop() { wdaStopped = true }, async dispose() { wdaStopped = true } }
  const backend = createIosQaBackend({
    simDevices: { list: async () => [simDevice] },
    realDevices: { list: async () => [realDevice] },
    sim: customSim,
    wda: customWda,
    axe: async () => [appRoot],
  })
  await backend.dispose()
  step('dispose does not dispose injected backends', simStopped === false && wdaStopped === false, `sim=${simStopped} wda=${wdaStopped}`)
})


// ── Targeted-text wrapper integration (injected runtime + client) ────────────
const TT_IS_OBJ = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const TT_BUNDLE = 'dev.zseven.qa.fixture.ios'
const TT_PID = 53004
const TT_ELEMENT = 'qa.input.name'
const TT_EXPECTED_FRAME = { x: 16, y: 116.33, width: 370, height: 44 }
const TT_WDA_RECT = { x: 16, y: 116, width: 370, height: 45 }
const TT_UUID = '09000000-0000-0000-5748-000000000000'
const TT_SID = 'TARGET-SESSION-1'
const TT_ELEMENT_RECORD = { ELEMENT: TT_UUID, 'element-6066-11e4-a52e-4f735466cecf': TT_UUID }

function ttOk(value) { return { statusCode: 200, body: { value } } }
function ttErr(statusCode) {
  return { statusCode, body: { value: { error: 'native error', message: 'native error message', traceback: 'should-not-leak' } } }
}

function makeTtTransport(options = {}) {
  const state = {
    calls: [],
    activeApp: options.activeApp ?? { bundleId: TT_BUNDLE, pid: TT_PID },
    settings: options.settings ?? TT_BUNDLE,
    element: {
      name: options.elementName ?? TT_ELEMENT,
      type: options.elementType ?? 'XCUIElementTypeTextField',
      enabled: options.elementEnabled !== undefined ? options.elementEnabled : true,
      visible: options.elementVisible !== undefined ? options.elementVisible : true,
      rect: options.elementRect ?? TT_WDA_RECT,
    },
    elements: options.elements !== undefined ? options.elements : [TT_ELEMENT_RECORD],
    sessionStatus: options.sessionStatus ?? 200,
    settingsPostStatus: options.settingsPostStatus ?? 200,
    settingsGetStatus: options.settingsGetStatus ?? 200,
    activeStatus: options.activeStatus ?? 200,
    elementsStatus: options.elementsStatus ?? 200,
    attrStatus: options.attrStatus ?? 200,
    clearStatus: options.clearStatus ?? 200,
    valueStatus: options.valueStatus ?? 200,
    valueThrows: options.valueThrows ?? false,
    clearThrows: options.clearThrows ?? false,
  }
  const request = async (method, path, body, requestOptions = {}) => {
    if (requestOptions.signal?.aborted === true) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    state.calls.push({ method, path, body })
    if (method === 'POST' && path === '/session') {
      if (state.sessionStatus !== 200) return ttErr(state.sessionStatus)
      return { statusCode: 200, body: { value: { sessionId: TT_SID, capabilities: {} }, sessionId: TT_SID } }
    }
    const settingsMatch = /^\/session\/([^/]+)\/appium\/settings$/.exec(path)
    if (settingsMatch !== null) {
      if (method === 'POST') {
        if (state.settingsPostStatus !== 200) return ttErr(state.settingsPostStatus)
        if (TT_IS_OBJ(body) && TT_IS_OBJ(body.settings) && typeof body.settings.defaultActiveApplication === 'string') {
          state.settings = body.settings.defaultActiveApplication
        }
        return ttOk({ defaultActiveApplication: state.settings })
      }
      if (method === 'GET') {
        if (state.settingsGetStatus !== 200) return ttErr(state.settingsGetStatus)
        return ttOk({ defaultActiveApplication: state.settings })
      }
    }
    if (method === 'GET' && path.endsWith('/wda/activeAppInfo')) {
      if (state.activeStatus !== 200) return ttErr(state.activeStatus)
      return ttOk(state.activeApp)
    }
    const elementsMatch = /^\/session\/([^/]+)\/elements$/.exec(path)
    if (method === 'POST' && elementsMatch !== null) {
      if (state.elementsStatus !== 200) return ttErr(state.elementsStatus)
      return ttOk(state.elements)
    }
    const attr = /^\/session\/[^/]+\/element\/([^/]+)\/attribute\/([^/]+)$/.exec(path)
    if (method === 'GET' && attr !== null) {
      if (state.attrStatus !== 200) return ttErr(state.attrStatus)
      if (attr[2] === 'name') return ttOk(state.element.name)
      if (attr[2] === 'type') return ttOk(state.element.type)
      return ttErr(400)
    }
    const simple = /^\/session\/[^/]+\/element\/([^/]+)\/(enabled|displayed|rect)$/.exec(path)
    if (method === 'GET' && simple !== null) {
      if (state.attrStatus !== 200) return ttErr(state.attrStatus)
      if (simple[2] === 'enabled') return ttOk(state.element.enabled)
      if (simple[2] === 'displayed') return ttOk(state.element.visible)
      if (simple[2] === 'rect') return ttOk(state.element.rect)
      return ttErr(400)
    }
    const clearMatch = /^\/session\/([^/]+)\/element\/([^/]+)\/clear$/.exec(path)
    if (method === 'POST' && clearMatch !== null) {
      if (state.clearThrows) throw new Error('clear transport reset')
      if (state.clearStatus !== 200) return ttErr(state.clearStatus)
      return ttOk(null)
    }
    const valueMatch = /^\/session\/([^/]+)\/element\/([^/]+)\/value$/.exec(path)
    if (method === 'POST' && valueMatch !== null) {
      if (state.valueThrows) throw new Error('value transport reset')
      if (state.valueStatus !== 200) return ttErr(state.valueStatus)
      return ttOk(null)
    }
    return ttErr(404)
  }
  return { udid: simDevice.udid, request, state, calls: state.calls }
}

function makeFakeRuntime(options = {}) {
  const runtime = {
    ensureCalls: [],
    released: [],
    disposed: 0,
    ensureError: options.ensureError,
    releaseError: options.releaseError,
    disposeError: options.disposeError,
    connection: options.connection,
    async ensure(udid, _opts = {}) {
      runtime.ensureCalls.push(udid)
      if (runtime.ensureError) throw runtime.ensureError
      if (runtime.connection === undefined) throw new Error('fake runtime connection missing')
      return runtime.connection
    },
    async release(udid) {
      if (runtime.releaseError) throw runtime.releaseError
      // Model the real runtime: only udids that were ensured have a lease; an
      // absent lease is a no-op (cleanly released) and never recorded.
      if (runtime.ensureCalls.includes(udid)) runtime.released.push(udid)
    },
    async dispose() {
      runtime.disposed += 1
      if (runtime.disposeError) throw runtime.disposeError
    },
  }
  return runtime
}

function makeForegroundSeam(sequenceOrValue) {
  const values = Array.isArray(sequenceOrValue) ? [...sequenceOrValue] : [sequenceOrValue ?? { pid: TT_PID }]
  return async (_udid, pid, _signal) => {
    const next = values.length > 0 ? values.shift() : values.at(-1)
    if (next === undefined) return { pid, bundleId: TT_BUNDLE, name: 'QA Fixture', verified: true }
    return {
      pid: next.pid ?? pid,
      bundleId: next.bundleId ?? TT_BUNDLE,
      name: 'QA Fixture',
      verified: next.verified === false ? false : true,
    }
  }
}

function makeTargetedBackend(overrides = {}) {
  const transport = overrides.transport ?? makeTtTransport()
  const runtime = overrides.runtime ?? makeFakeRuntime({ connection: transport })
  const foreground = overrides.foreground ?? makeForegroundSeam({ pid: TT_PID })
  return createIosQaBackend({
    simDevices: { list: async () => [simDevice], matches: async ref => ref === simDevice.udid },
    realDevices: { list: async () => [realDevice], matches: async ref => ref === realDevice.udid },
    sim: simHost,
    wda: wdaBackend,
    axe: async () => [appRoot],
    simForegroundApp: foreground,
    wdaInputRuntime: runtime,
    ...overrides.backendOverrides,
  })
}

function baseTarget(overrides = {}) {
  return {
    udid: simDevice.udid,
    bundleId: TT_BUNDLE,
    identifier: TT_ELEMENT,
    frame: { ...TT_EXPECTED_FRAME },
    text: 'QAProbeText',
    ...overrides,
  }
}

await tryStep('typeTarget routes a successful append through the wrapper', async () => {
  const transport = makeTtTransport()
  const backend = makeTargetedBackend({ transport })
  const result = await backend.typeTarget(baseTarget())
  const valueCalls = () => transport.state.calls.filter(c => c.method === 'POST' && c.path === `/session/${TT_SID}/element/${TT_UUID}/value`)
  const clearCalls = () => transport.state.calls.filter(c => c.method === 'POST' && c.path === `/session/${TT_SID}/element/${TT_UUID}/clear`)
  step('typeTarget returns honest unknown/dispatched/nativeAccepted and one value', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true && result.action === 'typeTarget' && result.mode === 'append', JSON.stringify(result))
  step('typeTarget (append) sends exactly one value and no clear', valueCalls().length === 1 && clearCalls().length === 0, `value=${valueCalls().length} clear=${clearCalls().length}`)
})

await tryStep('fillTarget (replace) sends exactly one clear then one value', async () => {
  const transport = makeTtTransport()
  const backend = makeTargetedBackend({ transport })
  const result = await backend.fillTarget(baseTarget({ text: 'Replacement' }))
  const calls = transport.state.calls
  const clears = calls.filter(c => c.method === 'POST' && c.path === `/session/${TT_SID}/element/${TT_UUID}/clear`)
  const values = calls.filter(c => c.method === 'POST' && c.path === `/session/${TT_SID}/element/${TT_UUID}/value`)
  step('fillTarget reports replace mapping and honest unknown result', result.action === 'fillTarget' && result.mode === 'replace' && result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true, JSON.stringify(result))
  step('replace one clear before one value with no retry', clears.length === 1 && values.length === 1 && calls.indexOf(clears[0]) < calls.indexOf(values[0]) && values[0].body.value === 'Replacement', `clear=${clears.length} value=${values.length}`)
})

await tryStep('raw secure target rejects before any runtime ensure/transport', async () => {
  let ensured = 0
  const runtime = makeFakeRuntime({ connection: makeTtTransport() })
  const originalEnsure = runtime.ensure
  runtime.ensure = async (udid, opts = {}) => { ensured += 1; return originalEnsure.call(runtime, udid, opts) }
  const backend = makeTargetedBackend({ runtime })
  const result = await backend.typeTarget(baseTarget({ secure: true, text: 'SecretPwd' }))
  step('secure true returns rejected SECURE_REJECTED no dispatch', result.status === 'rejected' && result.dispatched === false && result.nativeAccepted === false && result.code === 'SECURE_REJECTED', JSON.stringify(result))
  step('raw secure never touches runtime ensure', ensured === 0, `ensured=${ensured}`)
})

await tryStep('physical targeted text without usable physical seams rejects before any mutation (no WDA keys fallback)', async () => {
  let readerCalls = 0
  let transportCreated = 0
  const backend = createIosQaBackend({
    simDevices: { list: async () => [] },
    realDevices: { list: async () => [realDevice], matches: async ref => ref === realDevice.udid },
    physicalTargeted: {
      readAppIdentity: async () => {
        readerCalls += 1
        return { verified: false, capability: 'physical.targeted.identity.unavailable', reason: 'no CoreDevice reader configured in this smoke' }
      },
      transportFactory: async () => {
        transportCreated += 1
        throw new Error('transport should never be created for an unverified identity')
      },
    },
  })
  const result = await backend.typeTarget({ ...baseTarget(), udid: realDevice.udid })
  step('physical target without verified identity is rejected, never dispatched', result.status === 'rejected' && result.dispatched === false && result.nativeAccepted === false && result.code === 'APP_IDENTITY_UNAVAILABLE' && result.backend === 'physical', JSON.stringify(result))
  step('no one-shot transport is built for an unverified identity', transportCreated === 0 && readerCalls === 1, `transportCreated=${transportCreated} readerCalls=${readerCalls}`)
  step('physical result carries the physical capability, never a simulator fallback', result.unsupported?.capability === 'physical.targeted.identity.unavailable', JSON.stringify(result.unsupported))
})

await tryStep('missing/unsupported runtime source rejects as no-dispatch', async () => {
  const transport = makeTtTransport()
  const runtime = makeFakeRuntime({ connection: transport, ensureError: Object.assign(new Error('cached source unsupported'), { code: 'UNSUPPORTED' }) })
  const backend = makeTargetedBackend({ runtime, transport })
  const result = await backend.typeTarget(baseTarget())
  step('runtime UNSUPPORTED maps to rejected no dispatch', result.status === 'rejected' && result.dispatched === false && result.nativeAccepted === false && (result.code === 'RUNTIME_UNSUPPORTED' || result.code === 'RUNTIME_UNAVAILABLE'), JSON.stringify(result))
  step('no mutation reached transport on missing source', transport.state.calls.filter(c => c.path.includes('/value') || c.path.includes('/clear')).length === 0, `mutationCalls=${transport.state.calls.length}`)
})

await tryStep('app/PID change before client mutation maps rejected no dispatch', async () => {
  const transport = makeTtTransport()
  const foreground = makeForegroundSeam([
    { pid: TT_PID },
    { pid: TT_PID + 1 },
  ])
  const backend = makeTargetedBackend({ foreground, transport })
  const result = await backend.typeTarget(baseTarget())
  const mutations = transport.state.calls.filter(c => c.path.includes('/clear') || c.path.includes('/value'))
  step('PID changed after startup rejects before mutation (rejected/no-dispatch)', result.status === 'rejected' && result.dispatched === false && (result.code === 'APP_IDENTITY_MISMATCH' || result.code === 'APP_IDENTITY_UNAVAILABLE'), JSON.stringify(result))
  step('identity change prevented any clear/value call', mutations.length === 0, `calls=${transport.state.calls.length}`)
})

await tryStep('native secure refusal propagates rejected without mutation', async () => {
  const transport = makeTtTransport({ elementType: 'XCUIElementTypeSecureTextField' })
  const backend = makeTargetedBackend({ transport })
  const result = await backend.typeTarget(baseTarget())
  step('native secure element maps to rejected SECURE_REJECTED', result.status === 'rejected' && result.dispatched === false && result.code === 'SECURE_REJECTED', JSON.stringify(result))
  step('secure refusal no clear/value', transport.state.calls.filter(c => c.path.includes('/clear') || c.path.includes('/value')).length === 0)
})

await tryStep('mutation uncertainty stays unknown/dispatched with no retry', async () => {
  const transport = makeTtTransport({ valueThrows: true })
  const backend = makeTargetedBackend({ transport })
  const result = await backend.typeTarget(baseTarget({ text: 'Uncertain' }))
  const valueCalls = transport.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/value'))
  step('append transport throw after send maps to unknown/dispatched', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === false && result.code === 'MUTATION_DISPATCH_UNKNOWN', JSON.stringify(result))
  step('uncertain value attempted exactly once no retry', valueCalls.length === 1, `value=${valueCalls.length}`)
})

await tryStep('replace clear success / value error stays unknown dispatched, no value retry', async () => {
  const transport = makeTtTransport({ clearStatus: 200, valueThrows: true })
  const backend = makeTargetedBackend({ transport })
  const result = await backend.fillTarget(baseTarget())
  const clears = transport.state.calls.filter(c => c.path.endsWith('/clear'))
  const values = transport.state.calls.filter(c => c.path.endsWith('/value'))
  step('replace value transport error is unknown/dispatched/native false', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === false, JSON.stringify(result))
  step('exactly one clear and one value, no retry after value failure', clears.length === 1 && values.length === 1, `clear=${clears.length} value=${values.length}`)
})

await tryStep('per-device release isolates a device and never disposes owned runtime wholesale', async () => {
  const transport = makeTtTransport()
  const runtime = makeFakeRuntime({ connection: transport })
  const backend = makeTargetedBackend({ runtime, transport })
  const result = await backend.typeTarget(baseTarget())
  await backend.releaseDevice('OTHER-404')
  step('other-device release leaves SIM lease untouched', runtime.released.length === 0, `released=${JSON.stringify(runtime.released)}`)
  await backend.releaseDevice(simDevice.udid)
  step('releaseDevice releases the owned SIM lease and does not dispose runtime', runtime.released.length === 1 && runtime.released[0] === simDevice.udid && runtime.disposed === 0, `released=${JSON.stringify(runtime.released)} disposed=${runtime.disposed}`)
  step('typeTarget worked before release (sanity)', result.status === 'unknown' && result.dispatched === true)
})

await tryStep('dispose disposes ONLY owned input runtime, not injected backends', async () => {
  const injectedRuntime = makeFakeRuntime({ connection: makeTtTransport() })
  const backend = makeTargetedBackend({ runtime: injectedRuntime })
  await backend.dispose()
  step('injected input runtime is not disposed by backend.dispose', injectedRuntime.disposed === 0, `disposed=${injectedRuntime.disposed}`)
})

await tryStep('releaseDevice propagates sanitized BUSY cleanup error to QA adapter', async () => {
  const runtime = makeFakeRuntime({
    connection: makeTtTransport(),
    releaseError: Object.assign(new Error('lease unproven cleanup remains'), { code: 'BUSY', lockPath: '/internal/private/path.should-not-leak' }),
  })
  const backend = makeTargetedBackend({ runtime })
  let thrown = null
  try {
    await backend.releaseDevice(simDevice.udid)
  } catch (error) {
    thrown = error
  }
  step('releaseDevice throws typed IosQaError with busy code', thrown instanceof IosQaError && thrown.code === 'input-runtime.busy', `${thrown?.name} ${thrown?.code ?? thrown?.message}`)
  step('cleanup error is sanitized (no internal path/body leaked)', String(thrown?.message ?? '').includes('should-not-leak') === false, String(thrown?.message ?? ''))
  step('release was not treated as success/already-released', thrown !== null, `thrown=${thrown === null}`)
})

await tryStep('dispose retains OWNED runtime handle on cleanup failure and propagates', async () => {
  const transport = makeTtTransport()
  let factoryCalls = 0
  const owned = makeFakeRuntime({
    connection: transport,
    disposeError: Object.assign(new Error('dispose could not prove cleanup'), { code: 'BUSY' }),
  })
  const backend = createIosQaBackend({
    simDevices: { list: async () => [simDevice], matches: async ref => ref === simDevice.udid },
    realDevices: { list: async () => [realDevice], matches: async ref => ref === realDevice.udid },
    sim: simHost,
    wda: wdaBackend,
    axe: async () => [appRoot],
    simForegroundApp: makeForegroundSeam({ pid: TT_PID }),
    wdaInputRuntimeFactory: () => { factoryCalls += 1; return owned },
  })
  // Create the owned runtime through a real targeted request first.
  const run = await backend.typeTarget(baseTarget())
  step('owned runtime created lazily via factory and targeted works', run.status === 'unknown' && run.dispatched === true && owned.disposed === 0, `factory=${factoryCalls} disposed=${owned.disposed}`)
  let firstError = null
  try {
    await backend.dispose()
  } catch (error) {
    firstError = error
  }
  step('dispose failure propagates typed sanitized error', firstError instanceof IosQaError && firstError.code === 'input-runtime.dispose-busy' && String(firstError.message ?? '').includes('should-not-leak') === false, `${firstError?.code ?? firstError?.message}`)
  step('owned runtime handle is retained after failed dispose (no fresh orphan-spawning run)', owned.disposed === 1 && factoryCalls === 1, `disposed=${owned.disposed} factory=${factoryCalls}`)
  // A later releaseDevice still targets the SAME retained owned runtime.
  await backend.releaseDevice(simDevice.udid)
  step('releaseDevice still uses retained runtime after failed dispose', owned.released.includes(simDevice.udid) && factoryCalls === 1, `released=${JSON.stringify(owned.released)}`)
})

await tryStep('releaseDevice treats genuinely absent lease as released (no error)', async () => {
  const runtime = makeFakeRuntime({ connection: makeTtTransport() })
  const backend = makeTargetedBackend({ runtime })
  let ok = true
  try {
    // No lease for this udid exists yet (many releases are allowed no-op).
    await backend.releaseDevice('SIM-NO-LEASE')
  } catch {
    ok = false
  }
  step('absent lease releaseDevice resolves cleanly', ok === true && runtime.released.length === 0, `released=${JSON.stringify(runtime.released)}`)
})



const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) {
  process.exitCode = 1
}
