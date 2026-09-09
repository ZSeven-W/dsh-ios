// Physical element-bound targeted-text contract smoke.
//
// Run after build (pnpm run build or node scripts/run-tool.mjs tsc -p tsconfig.json):
//   node scripts/dev-qa-physical-targeted-smoke.mjs
//
// All seams are fake: this smoke NEVER touches a device, usbmux socket, or
// real WDA. Covers:
// - readPhysicalAppIdentity: single match, not-running, pid pin/absent/
//   mismatch, ambiguity, reader failure; the reader surface never claims
//   frontmost anywhere.
// - createPhysicalTargetedTransport: 127.0.0.1-only forward args, fresh-port
//   pick (no adoption), raw HTTP passthrough, non-JSON body, abort,
//   idempotent dispose closing only the owned forward.
// - createIosQaBackend physical typeTarget/fillTarget: happy append/replace,
//   wrong app, wrong PID, missing reader, ambiguous, stale target,
//   raw/native secure, WDA activeApp mismatch, uncertain dispatch exactly
//   once, no WDA server, transport-factory failure, cleanup failure, udid
//   mismatch, and that the shared WdaController backend is never touched.

import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
let failed = 0

function step(name, verdict, detail = '') {
  const normalized = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict
  if (normalized === 'FAIL') failed += 1
  results.push({ name, verdict: normalized, detail })
  console.log(normalized.padEnd(4) + ' ' + name + (detail === '' ? '' : ' — ' + detail))
}

function ok(name, detail = '') { step(name, true, detail) }
function fail(name, detail = '') { step(name, false, detail) }

async function tryStep(name, fn) {
  try {
    await fn()
  } catch (error) {
    step(name, false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
}

const { readPhysicalAppIdentity, createPhysicalTargetedTransport, PHYSICAL_WDA_CONTROL_PORT } = await import(join(root, 'lib', 'wda-physical-target.js'))
const { createIosQaBackend } = await import(join(root, 'lib', 'qa-driver.js'))

// ── Part A: independent CoreDevice identity reader ───────────────────────────
const READ_BUNDLE = 'com.example.qa.fixture'
const READ_PID = 51230

function proc(pid, bundleId) {
  const executable = bundleId === undefined ? '/usr/libexec/something' : '/var/containers/Bundle/Application/x/' + bundleId.split('.').pop() + '.app/app'
  return { pid, executable, name: 'app', ...(bundleId === undefined ? {} : { bundleId }) }
}

await tryStep('reader: single enriched process verifies bundle+pid (running identity, never frontmost)', async () => {
  const sample = await readPhysicalAppIdentity('REAL', { bundleId: READ_BUNDLE }, {
    listProcesses: async () => [proc(100, 'com.apple.other'), proc(READ_PID, READ_BUNDLE)],
  })
  ok('reader verifies the exact single match', sample.verified === true && sample.bundleId === READ_BUNDLE && sample.pid === READ_PID, JSON.stringify(sample))
  ok('verified sample carries no frontmost/foreground claim', JSON.stringify(sample).includes('frontmost') === false && JSON.stringify(sample).includes('foreground') === false)
})

await tryStep('reader: bundle not running fails closed as not-running', async () => {
  const sample = await readPhysicalAppIdentity('REAL', { bundleId: READ_BUNDLE }, {
    listProcesses: async () => [proc(100, 'com.apple.other')],
  })
  ok('no match is unverified not-running', sample.verified === false && sample.capability === 'physical.targeted.identity.not-running', JSON.stringify(sample))
})

await tryStep('reader: expectedPID pin verifies only the pinned process', async () => {
  const pinned = await readPhysicalAppIdentity('REAL', { bundleId: READ_BUNDLE, expectedPID: READ_PID }, {
    listProcesses: async () => [proc(READ_PID - 1, READ_BUNDLE), proc(READ_PID, READ_BUNDLE)],
  })
  ok('pin resolves ambiguity to the exact pid', pinned.verified === true && pinned.pid === READ_PID, JSON.stringify(pinned))
})

await tryStep('reader: expectedPID absent on device fails closed', async () => {
  const sample = await readPhysicalAppIdentity('REAL', { bundleId: READ_BUNDLE, expectedPID: 999 }, {
    listProcesses: async () => [proc(READ_PID, READ_BUNDLE)],
  })
  ok('missing pinned pid is unverified pid-absent', sample.verified === false && sample.capability === 'physical.targeted.identity.pid-absent', JSON.stringify(sample))
})

await tryStep('reader: expectedPID running another bundle fails closed', async () => {
  const sample = await readPhysicalAppIdentity('REAL', { bundleId: READ_BUNDLE, expectedPID: 100 }, {
    listProcesses: async () => [proc(100, 'com.apple.other')],
  })
  ok('wrong-bundle pid is unverified pid-mismatch', sample.verified === false && sample.capability === 'physical.targeted.identity.pid-mismatch', JSON.stringify(sample))
})

await tryStep('reader: several matches without a pin are ambiguous (fail closed)', async () => {
  const sample = await readPhysicalAppIdentity('REAL', { bundleId: READ_BUNDLE }, {
    listProcesses: async () => [proc(READ_PID - 1, READ_BUNDLE), proc(READ_PID, READ_BUNDLE)],
  })
  ok('ambiguity is unverified with a stable capability', sample.verified === false && sample.capability === 'physical.targeted.identity.ambiguous', JSON.stringify(sample))
})

await tryStep('reader: a failing process listing is unverified unavailable, no raw error leak', async () => {
  const sample = await readPhysicalAppIdentity('REAL', { bundleId: READ_BUNDLE }, {
    listProcesses: async () => { throw new Error('xcrun devicectl exploded with secret-internal-detail') },
  })
  ok('reader failure is unverified unavailable', sample.verified === false && sample.capability === 'physical.targeted.identity.unavailable', JSON.stringify(sample))
  ok('reader failure reason never embeds raw tool output', JSON.stringify(sample).includes('secret-internal-detail') === false, JSON.stringify(sample.reason))
})

// ── Part B: one-shot owned transport ─────────────────────────────────────────
await tryStep('transport: forward args are 127.0.0.1-only with the default device port', async () => {
  const seen = []
  const forward = { localPort: 0, connections: 0, closed: 0, close: async () => { forward.closed += 1 } }
  const transport = await createPhysicalTargetedTransport({
    udid: 'REAL',
    createForward: async options => { seen.push(options); return forward },
  })
  ok('forward created with fixed loopback host and WDA control port', seen.length === 1 && seen[0].host === '127.0.0.1' && seen[0].devicePort === PHYSICAL_WDA_CONTROL_PORT && seen[0].udid === 'REAL', JSON.stringify(seen[0]))
  ok('transport exposes its owned local port', Number.isSafeInteger(transport.localPort) && transport.localPort >= 18200)
  await transport.dispose()
  await transport.dispose()
  ok('dispose closes only the owned forward and is idempotent', forward.closed === 1, 'closed=' + forward.closed)
})

await tryStep('transport: busy ports are skipped, never adopted', async () => {
  const blocker = createNetServer()
  await new Promise(resolveListen => blocker.listen({ host: '127.0.0.1', port: 18200 }, resolveListen))
  try {
    const forward = { localPort: 0, connections: 0, close: async () => {} }
    const transport = await createPhysicalTargetedTransport({
      udid: 'REAL',
      portStart: 18200,
      createForward: async options => { forward.localPort = options.localPort; return forward },
    })
    ok('picker skips the occupied port instead of adopting it', transport.localPort !== 18200, 'localPort=' + transport.localPort)
    await transport.dispose()
  } finally {
    await new Promise(resolveClose => blocker.close(resolveClose))
  }
})

await tryStep('transport: raw HTTP passthrough, non-JSON body, abort, and error status', async () => {
  const forward = { localPort: 0, connections: 0, close: async () => {} }
  const transport = await createPhysicalTargetedTransport({
    udid: 'REAL',
    createForward: async options => { forward.localPort = options.localPort; return forward },
  })
  const server = createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ value: { ready: true } }))
      return
    }
    if (req.url === '/plain') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('not-json-at-all')
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ value: { error: 'no such route' } }))
  })
  await new Promise(resolveListen => server.listen({ host: '127.0.0.1', port: transport.localPort }, resolveListen))
  try {
    const status = await transport.request('GET', '/status')
    ok('2xx JSON response resolves with parsed body', status.statusCode === 200 && status.body.value.ready === true, JSON.stringify(status))
    const plain = await transport.request('GET', '/plain')
    ok('non-JSON body stays text', plain.statusCode === 200 && plain.body === 'not-json-at-all', JSON.stringify(plain))
    const missing = await transport.request('GET', '/nope')
    ok('HTTP error resolves with its status for client classification', missing.statusCode === 404 && missing.body.value.error === 'no such route', JSON.stringify(missing))
    const controller = new AbortController()
    controller.abort()
    let aborted = false
    try {
      await transport.request('GET', '/status', undefined, { signal: controller.signal })
    } catch {
      aborted = true
    }
    ok('aborted request rejects instead of resolving', aborted === true)
  } finally {
    await new Promise(resolveClose => server.close(resolveClose))
    await transport.dispose()
  }
})

// ── Part C: driver integration (physical typeTarget/fillTarget) ───────────────
const REAL_UDID = '00000000-0000-4000-8000-000000000001'
const TT_BUNDLE = 'com.example.qa.fixture'
const TT_PID = 51230
const TT_ELEMENT = 'qa.input.name'
const TT_SEMANTIC_LABEL = 'Search conversations'
const TT_FRAME = { x: 16, y: 116.33, width: 370, height: 44 }
const TT_RECT = { x: 16, y: 116, width: 370, height: 45 }
const TT_UUID = '09000000-0000-0000-5748-000000000000'
const TT_SID = 'TARGET-SESSION-1'
const TT_ELEMENT_RECORD = { ELEMENT: TT_UUID, 'element-6066-11e4-a52e-4f735466cecf': TT_UUID }

function ttOk(value) { return { statusCode: 200, body: { value } } }
function ttErr(statusCode) {
  return { statusCode, body: { value: { error: 'native error', message: 'native error message', traceback: 'should-not-leak' } } }
}

function makeFakeTransport(options = {}) {
  const state = {
    calls: [],
    disposed: 0,
    disposeError: options.disposeError,
    requestError: options.requestError,
    activeApp: options.activeApp ?? { bundleId: TT_BUNDLE, pid: TT_PID },
    settings: options.settings ?? TT_BUNDLE,
    element: {
      name: options.elementName ?? TT_ELEMENT,
      label: options.elementLabel ?? TT_SEMANTIC_LABEL,
      type: options.elementType ?? 'XCUIElementTypeTextField',
      enabled: options.elementEnabled !== undefined ? options.elementEnabled : true,
      visible: options.elementVisible !== undefined ? options.elementVisible : true,
      rect: options.elementRect ?? TT_RECT,
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
    labelSequence: options.labelSequence,
    rectSequence: options.rectSequence,
  }
  const request = async (method, path, body, requestOptions = {}) => {
    if (requestOptions.signal?.aborted === true) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    if (state.requestError !== undefined) throw state.requestError
    state.calls.push({ method, path, body })
    if (method === 'POST' && path === '/session') {
      if (state.sessionStatus !== 200) return ttErr(state.sessionStatus)
      return { statusCode: 200, body: { value: { sessionId: TT_SID, capabilities: {} }, sessionId: TT_SID } }
    }
    const settingsMatch = /^\/session\/([^/]+)\/appium\/settings$/.exec(path)
    if (settingsMatch !== null) {
      if (method === 'POST') {
        if (state.settingsPostStatus !== 200) return ttErr(state.settingsPostStatus)
        const record = body !== undefined && typeof body === 'object' && body !== null ? body : {}
        const nested = record.settings !== undefined && typeof record.settings === 'object' && record.settings !== null ? record.settings : {}
        if (typeof nested.defaultActiveApplication === 'string') state.settings = nested.defaultActiveApplication
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
      const using = body !== undefined && typeof body === 'object' && body !== null ? body.using : undefined
      if (using !== 'accessibility id' && using !== 'predicate string') return ttErr(400)
      return ttOk(state.elements)
    }
    const attr = /^\/session\/[^/]+\/element\/([^/]+)\/attribute\/([^/]+)$/.exec(path)
    if (method === 'GET' && attr !== null) {
      if (state.attrStatus !== 200) return ttErr(state.attrStatus)
      if (attr[2] === 'name') return ttOk(state.element.name)
      if (attr[2] === 'label') {
        if (state.labelSequence !== undefined && state.labelSequence.length > 0) return ttOk(state.labelSequence.shift())
        return ttOk(state.element.label)
      }
      if (attr[2] === 'type') return ttOk(state.element.type)
      return ttErr(400)
    }
    const simple = /^\/session\/[^/]+\/element\/([^/]+)\/(enabled|displayed|rect)$/.exec(path)
    if (method === 'GET' && simple !== null) {
      if (state.attrStatus !== 200) return ttErr(state.attrStatus)
      if (simple[2] === 'enabled') return ttOk(state.element.enabled)
      if (simple[2] === 'displayed') return ttOk(state.element.visible)
      if (simple[2] === 'rect') {
        if (state.rectSequence !== undefined && state.rectSequence.length > 0) return ttOk(state.rectSequence.shift())
        return ttOk(state.element.rect)
      }
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
  return { udid: REAL_UDID, localPort: 18240, request, dispose: async () => { state.disposed += 1; if (state.disposeError) throw state.disposeError }, state }
}

function makeReader(sequenceOrValue) {
  const values = Array.isArray(sequenceOrValue) ? [...sequenceOrValue] : [sequenceOrValue]
  const calls = []
  const reader = async (_udid, target, _options = {}) => {
    calls.push(target)
    const next = values.length > 1 ? values.shift() : values[0]
    if (next === undefined) throw new Error('reader unavailable')
    if (typeof next === 'function') return next()
    if (next.throws === true) throw new Error('reader exploded with internal detail')
    return { bundleId: next.bundleId ?? TT_BUNDLE, pid: next.pid ?? TT_PID, verified: next.verified === false ? false : true, ...(next.capability === undefined ? {} : { capability: next.capability }) }
  }
  reader.calls = calls
  return reader
}

function makePhysicalBackend(overrides = {}) {
  const transport = overrides.transport ?? makeFakeTransport()
  const reader = overrides.reader ?? makeReader({ pid: TT_PID })
  let wdaEnsure = 0
  const wdaRecorder = {
    async ensureRunning() { wdaEnsure += 1; return { udid: REAL_UDID, hardwareUdid: REAL_UDID, controlUrl: 'http://127.0.0.1:8100', mjpegUrl: 'http://127.0.0.1:9100', sessionId: 'sid' } },
    status() { return { available: true, running: false, consumers: 0 } },
    async stop() {},
    acquire() { return () => {} },
    release() {},
    mjpegUrl: undefined,
    control: {
      async tap() { throw new Error('tap must never run') },
      async typeText() { throw new Error('typeText must never run') },
    },
  }
  let created = 0
  const countingFactory = async (udid, options) => {
    created += 1
    if (overrides.factoryThrows) throw new Error('factory exploded')
    if (overrides.transportFactory !== undefined) return overrides.transportFactory(udid, options)
    return transport
  }
  const backend = createIosQaBackend({
    simDevices: { list: async () => [], matches: async () => false },
    realDevices: { list: async () => [{ udid: REAL_UDID, name: 'iPhone Physical', osVersion: '26.6', model: 'iPhone 17 Pro', state: 'available (paired)', pairingState: 'paired' }], matches: async ref => ref === REAL_UDID },
    wda: wdaRecorder,
    physicalTargeted: {
      readAppIdentity: reader,
      transportFactory: countingFactory,
    },
  })
  return { backend, transport, reader, get wdaEnsure() { return wdaEnsure }, get created() { return created } }
}

await tryStep('CoreDevice logical id maps to hardware UDID before default transport', async () => {
  let mapped
  const bundle = makePhysicalBackend({
    transportFactory: async (udid, options) => {
      mapped = { udid, hardwareUdid: options?.hardwareUdid }
      return makeFakeTransport()
    },
  })
  // The production source resolves through realDevices.resolve; this seam
  // makes the CoreDevice→hardware mapping explicit without opening usbmuxd.
  bundle.backend = createIosQaBackend({
    simDevices: { list: async () => [], matches: async () => false },
    realDevices: { list: async () => [], matches: async ref => ref === REAL_UDID, resolve: async () => ({ udid: 'CORE-LOGICAL', hardwareUdid: REAL_UDID, name: 'Phone', state: 'available', pairingState: 'paired' }) },
    wda: bundle.backend,
    physicalTargeted: { readAppIdentity: makeReader({ pid: TT_PID }), resolveHardwareUdid: async () => REAL_UDID, transportFactory: async (udid, options) => { mapped = { udid, hardwareUdid: options?.hardwareUdid }; return makeFakeTransport() } },
  })
  await bundle.backend.typeTarget(physicalTarget())
  step('logical transport identity is preserved', mapped?.udid === REAL_UDID)
  step('hardware UDID is passed to the transport seam', mapped?.hardwareUdid === REAL_UDID, JSON.stringify(mapped))
})

await tryStep('missing hardware UDID rejects before transport creation', async () => {
  let created = 0
  const backend = createIosQaBackend({
    simDevices: { list: async () => [], matches: async () => false },
    realDevices: { list: async () => [], matches: async ref => ref === REAL_UDID },
    wda: makePhysicalBackend().backend,
    physicalTargeted: {
      readAppIdentity: makeReader({ pid: TT_PID }),
      resolveHardwareUdid: async () => undefined,
      transportFactory: async () => { created += 1; return makeFakeTransport() },
    },
  })
  const result = await backend.typeTarget(physicalTarget())
  step('missing hardware maps to fail-closed identity rejection', result.code === 'APP_IDENTITY_MISMATCH' && result.dispatched === false, JSON.stringify(result))
  step('missing hardware never creates transport', created === 0)
})

await tryStep('hardware input is accepted only when CoreDevice resolution agrees', async () => {
  let created = 0
  const backend = createIosQaBackend({
    simDevices: { list: async () => [], matches: async () => false },
    realDevices: { list: async () => [], matches: async ref => ref === REAL_UDID, resolve: async () => ({ udid: 'CORE-LOGICAL', hardwareUdid: REAL_UDID, name: 'Phone', state: 'available', pairingState: 'paired' }) },
    wda: makePhysicalBackend().backend,
    physicalTargeted: { readAppIdentity: makeReader({ pid: TT_PID }), transportFactory: async () => { created += 1; return makeFakeTransport() } },
  })
  const result = await backend.typeTarget(physicalTarget())
  step('resolved hardware input reaches transport', result.dispatched === true && created === 1, JSON.stringify(result))
})

function physicalTarget(overrides = {}) {
  return { udid: REAL_UDID, bundleId: TT_BUNDLE, identifier: TT_ELEMENT, frame: { ...TT_FRAME }, text: 'QAProbeText', ...overrides }
}


// ── Part D: semantic label+type route and empty-fill semantics ───────────────

function physicalSemanticTarget(overrides = {}) {
  return { udid: REAL_UDID, bundleId: TT_BUNDLE, semantic: { label: TT_SEMANTIC_LABEL, type: 'TextField' }, frame: { ...TT_FRAME }, text: 'QAProbeText', ...overrides }
}

await tryStep('physical semantic typeTarget happy append through native predicate string', async () => {
  const bundle = makePhysicalBackend()
  const { backend, transport, reader } = bundle
  const result = await backend.typeTarget(physicalSemanticTarget())
  const calls = transport.state.calls
  const elementsCall = calls.find(c => c.method === 'POST' && c.path === '/session/' + TT_SID + '/elements')
  step('semantic append returns honest unknown/dispatched/nativeAccepted', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true && result.backend === 'physical', JSON.stringify(result))
  step('semantic lookup uses native predicate string spelling', elementsCall !== undefined && elementsCall.body.using === 'predicate string', JSON.stringify(elementsCall?.body))
  step('semantic predicate is exact quoted type+label', elementsCall !== undefined && elementsCall.body.value === "type == 'XCUIElementTypeTextField' AND label == 'Search conversations'", JSON.stringify(elementsCall?.body?.value))
  const values = calls.filter(c => c.method === 'POST' && c.path.endsWith('/value'))
  const clears = calls.filter(c => c.path.endsWith('/clear'))
  step('semantic append one value no clear', values.length === 1 && clears.length === 0 && values[0].body.value === 'QAProbeText', 'value=' + values.length + ' clear=' + clears.length)
  const labelReads = calls.filter(c => c.method === 'GET' && c.path.includes('/attribute/label'))
  const nameReads = calls.filter(c => c.method === 'GET' && c.path.includes('/attribute/name'))
  step('semantic verifies label attribute and never name', labelReads.length === 2 && nameReads.length === 0, 'label=' + labelReads.length + ' name=' + nameReads.length)
  step('Appium -ios predicate string spelling is never sent', calls.every(c => JSON.stringify(c.body ?? {}).includes('-ios predicate string') === false))
  step('owned transport disposed exactly once', transport.state.disposed === 1, 'disposed=' + transport.state.disposed)
  step('shared WdaController never touched', bundle.wdaEnsure === 0 && bundle.created === 1, 'created=' + bundle.created + ' wdaEnsure=' + bundle.wdaEnsure)
})
await tryStep('physical typeTarget happy append through the pinned contract', async () => {
  const bundle = makePhysicalBackend()
  const { backend, transport, reader } = bundle
  const result = await backend.typeTarget(physicalTarget())
  const calls = transport.state.calls
  const values = calls.filter(c => c.method === 'POST' && c.path === '/session/' + TT_SID + '/element/' + TT_UUID + '/value')
  const clears = calls.filter(c => c.path.endsWith('/clear'))
  step('append returns honest unknown/dispatched/nativeAccepted on physical', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true && result.backend === 'physical' && result.mode === 'append', JSON.stringify(result))
  step('append sends exactly one value and no clear', values.length === 1 && clears.length === 0 && values[0].body.value === 'QAProbeText', 'value=' + values.length + ' clear=' + clears.length)
  step('physical flow never sends /wda/keys or /wda/tap', calls.some(c => c.path.includes('/wda/keys') || c.path.includes('/wda/tap')) === false, 'calls=' + calls.length)
  step('owned one-shot transport disposed exactly once', transport.state.disposed === 1, 'disposed=' + transport.state.disposed)
  step('pre-sample used no expectedPID; later samples pinned the verified pid', reader.calls.length >= 3 && reader.calls[0].expectedPID === undefined && reader.calls.slice(1).every(call => call.expectedPID === TT_PID), JSON.stringify(reader.calls))
  step('the shared WdaController backend is never touched', bundle.created === 1 && bundle.wdaEnsure === 0, 'created=' + bundle.created + ' wdaEnsure=' + bundle.wdaEnsure)
})

await tryStep('physical fillTarget replace sends one clear then one value', async () => {
  const { backend, transport } = makePhysicalBackend()
  const result = await backend.fillTarget(physicalTarget({ text: 'Replacement' }))
  const calls = transport.state.calls
  const clears = calls.filter(c => c.method === 'POST' && c.path === '/session/' + TT_SID + '/element/' + TT_UUID + '/clear')
  const values = calls.filter(c => c.method === 'POST' && c.path === '/session/' + TT_SID + '/element/' + TT_UUID + '/value')
  step('replace reports honest unknown result on physical', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true && result.action === 'fillTarget' && result.mode === 'replace', JSON.stringify(result))
  step('replace one clear before one value with no retry', clears.length === 1 && values.length === 1 && calls.indexOf(clears[0]) < calls.indexOf(values[0]) && values[0].body.value === 'Replacement', 'clear=' + clears.length + ' value=' + values.length)
})

await tryStep('wrong app identity rejects before any transport is built', async () => {
  const { backend, transport, created } = makePhysicalBackend({ reader: makeReader({ bundleId: 'com.other.app', pid: 99 }) })
  const result = await backend.typeTarget(physicalTarget())
  step('wrong bundle maps to rejected APP_IDENTITY_MISMATCH', result.status === 'rejected' && result.dispatched === false && result.nativeAccepted === false && result.code === 'APP_IDENTITY_MISMATCH', JSON.stringify(result))
  step('no transport built and nothing dispatched', created === 0 && transport.state.calls.length === 0, 'created=' + created + ' calls=' + transport.state.calls.length)
})

await tryStep('wrong expectedPID precondition rejects before any transport', async () => {
  const { backend, transport, created } = makePhysicalBackend({ reader: makeReader({ pid: TT_PID }) })
  const result = await backend.typeTarget(physicalTarget({ expectedPID: 987 }))
  step('pid precondition mismatch maps to rejected APP_IDENTITY_MISMATCH', result.status === 'rejected' && result.dispatched === false && result.code === 'APP_IDENTITY_MISMATCH', JSON.stringify(result))
  step('no transport built for a failed precondition', created === 0 && transport.state.calls.length === 0, 'created=' + created)
})

await tryStep('missing independent reader rejects as APP_IDENTITY_UNAVAILABLE', async () => {
  const { backend, transport, created } = makePhysicalBackend({ reader: makeReader({ throws: true }) })
  const result = await backend.typeTarget(physicalTarget())
  step('reader failure maps to rejected unavailable with the physical capability', result.status === 'rejected' && result.dispatched === false && result.code === 'APP_IDENTITY_UNAVAILABLE' && result.unsupported?.capability === 'physical.targeted.identity.unavailable', JSON.stringify(result))
  step('no transport built when the reader is missing', created === 0 && transport.state.calls.length === 0)
  step('reader failure never leaks raw tool output', JSON.stringify(result).includes('internal detail') === false, JSON.stringify(result.reason))
})

await tryStep('ambiguous CoreDevice identity rejects as APP_IDENTITY_AMBIGUOUS', async () => {
  const { backend, transport, created } = makePhysicalBackend({ reader: makeReader({ verified: false, capability: 'physical.targeted.identity.ambiguous' }) })
  const result = await backend.typeTarget(physicalTarget())
  step('ambiguity maps to rejected APP_IDENTITY_AMBIGUOUS with no dispatch', result.status === 'rejected' && result.dispatched === false && result.code === 'APP_IDENTITY_AMBIGUOUS' && result.unsupported?.capability === 'physical.targeted.identity.ambiguous', JSON.stringify(result))
  step('no transport built for an ambiguous identity', created === 0 && transport.state.calls.length === 0)
})

await tryStep('stale target (pid drift after setup) rejects before any mutation', async () => {
  const { backend, transport } = makePhysicalBackend({ reader: makeReader([{ pid: TT_PID }, { pid: TT_PID + 1 }]) })
  const result = await backend.typeTarget(physicalTarget())
  const mutations = transport.state.calls.filter(c => c.path.includes('/clear') || c.path.includes('/value'))
  step('pid drift maps to rejected APP_IDENTITY_MISMATCH (client pin enforcement)', result.status === 'rejected' && result.dispatched === false && (result.code === 'APP_IDENTITY_MISMATCH' || result.code === 'APP_IDENTITY_UNAVAILABLE'), JSON.stringify(result))
  step('stale target never reached a mutation', mutations.length === 0, 'mutations=' + mutations.length)
  step('one-shot transport still disposed after the stale rejection', transport.state.disposed === 1, 'disposed=' + transport.state.disposed)
})

await tryStep('raw secure target rejects before reader or transport', async () => {
  const { backend, reader, transport, created } = makePhysicalBackend()
  const result = await backend.typeTarget(physicalTarget({ secure: true, text: 'SecretPwd' }))
  step('secure true maps to rejected SECURE_REJECTED', result.status === 'rejected' && result.dispatched === false && result.code === 'SECURE_REJECTED', JSON.stringify(result))
  step('secure refusal touches neither reader nor transport', reader.calls.length === 0 && created === 0 && transport.state.calls.length === 0, 'reader=' + reader.calls.length + ' created=' + created)
})

await tryStep('native secure element rejects with no mutation', async () => {
  const { backend, transport } = makePhysicalBackend({ transport: makeFakeTransport({ elementType: 'XCUIElementTypeSecureTextField' }) })
  const result = await backend.typeTarget(physicalTarget())
  const mutations = transport.state.calls.filter(c => c.path.includes('/clear') || c.path.includes('/value'))
  step('native secure field maps to rejected SECURE_REJECTED', result.status === 'rejected' && result.dispatched === false && result.code === 'SECURE_REJECTED', JSON.stringify(result))
  step('secure refusal no clear/value', mutations.length === 0)
})

await tryStep('WDA active-app corroboration mismatch rejects with no mutation', async () => {
  const { backend, transport } = makePhysicalBackend({ transport: makeFakeTransport({ activeApp: { bundleId: TT_BUNDLE, pid: 999 } }) })
  const result = await backend.typeTarget(physicalTarget())
  const mutations = transport.state.calls.filter(c => c.path.includes('/clear') || c.path.includes('/value'))
  step('activeApp pid mismatch maps to rejected ACTIVE_APP_MISMATCH', result.status === 'rejected' && result.dispatched === false && result.code === 'ACTIVE_APP_MISMATCH', JSON.stringify(result))
  step('corroboration failure never dispatched a mutation', mutations.length === 0)
})

await tryStep('uncertain dispatch stays unknown/dispatched with exactly one attempt', async () => {
  const { backend, transport } = makePhysicalBackend({ transport: makeFakeTransport({ valueThrows: true }) })
  const result = await backend.typeTarget(physicalTarget({ text: 'Uncertain' }))
  const values = transport.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/value'))
  step('value transport throw maps to unknown/dispatched MUTATION_DISPATCH_UNKNOWN', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === false && result.code === 'MUTATION_DISPATCH_UNKNOWN', JSON.stringify(result))
  step('uncertain value attempted exactly once with no retry', values.length === 1, 'values=' + values.length)
  step('transport still disposed after uncertainty', transport.state.disposed === 1, 'disposed=' + transport.state.disposed)
})

await tryStep('no WDA on the device fails closed as SESSION_FAILED', async () => {
  const refused = new Error('connect ECONNREFUSED 127.0.0.1')
  const { backend, transport } = makePhysicalBackend({ transport: makeFakeTransport({ requestError: refused }) })
  const result = await backend.typeTarget(physicalTarget())
  step('unreachable WDA maps to rejected SESSION_FAILED with no dispatch', result.status === 'rejected' && result.dispatched === false && result.code === 'SESSION_FAILED', JSON.stringify(result))
  step('transport disposed after the refused session', transport.state.disposed === 1)
})

await tryStep('transport factory failure maps to rejected TRANSPORT_UNAVAILABLE', async () => {
  const { backend } = makePhysicalBackend({ factoryThrows: true })
  const result = await backend.typeTarget(physicalTarget())
  step('factory failure maps to rejected transport-unavailable with capability', result.status === 'rejected' && result.dispatched === false && result.code === 'TRANSPORT_UNAVAILABLE' && result.unsupported?.capability === 'physical.targeted.transport.unavailable', JSON.stringify(result))
})

await tryStep('transport cleanup failure is surfaced without altering the result', async () => {
  const disposeError = new Error('close failed with internal path')
  const { backend, transport } = makePhysicalBackend({ transport: makeFakeTransport({ disposeError }) })
  const result = await backend.typeTarget(physicalTarget())
  step('result stays unknown/dispatched/nativeAccepted despite cleanup failure', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true, JSON.stringify(result))
  step('cleanup failure is surfaced as transportCleanup.ok=false', result.transportCleanup !== undefined && result.transportCleanup.ok === false, JSON.stringify(result.transportCleanup))
  step('cleanup reason never embeds the raw error', JSON.stringify(result).includes('internal path') === false, JSON.stringify(result.transportCleanup))
  step('dispose was attempted exactly once', transport.state.disposed === 1, 'disposed=' + transport.state.disposed)
})

await tryStep('udid mismatch between target and transport rejects', async () => {
  const { backend } = makePhysicalBackend({ transportFactory: async () => ({ ...makeFakeTransport(), udid: 'OTHER-UDID' }) })
  const result = await backend.typeTarget(physicalTarget())
  step('udid mismatch maps to rejected UDID_MISMATCH', result.status === 'rejected' && result.dispatched === false && result.code === 'UDID_MISMATCH', JSON.stringify(result))
})


await tryStep('physical fillTarget with empty text sends exactly one clear and no value', async () => {
  const { backend, transport } = makePhysicalBackend()
  const result = await backend.fillTarget(physicalTarget({ text: '' }))
  const calls = transport.state.calls
  const clears = calls.filter(c => c.method === 'POST' && c.path.endsWith('/clear'))
  const values = calls.filter(c => c.method === 'POST' && c.path.endsWith('/value'))
  step('empty fill returns honest unknown/dispatched/nativeAccepted', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true && result.mode === 'replace', JSON.stringify(result))
  step('empty fill is exactly one clear and no value call', clears.length === 1 && values.length === 0, 'clear=' + clears.length + ' value=' + values.length)
})

await tryStep('physical semantic empty fill sends exactly one clear and no value', async () => {
  const { backend, transport } = makePhysicalBackend()
  const result = await backend.fillTarget(physicalSemanticTarget({ text: '' }))
  const calls = transport.state.calls
  step('semantic empty fill accepted', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true, JSON.stringify(result))
  step('semantic empty fill one clear no value', calls.filter(c => c.path.endsWith('/clear')).length === 1 && calls.filter(c => c.path.endsWith('/value')).length === 0)
})

await tryStep('mixed identifier+semantic target rejects before reader or transport', async () => {
  const { backend, reader, created } = makePhysicalBackend()
  const result = await backend.typeTarget({ ...physicalTarget(), semantic: { label: TT_SEMANTIC_LABEL, type: 'TextField' } })
  step('mixed selector maps to rejected INVALID_ARGUMENT', result.status === 'rejected' && result.dispatched === false && result.code === 'INVALID_ARGUMENT', JSON.stringify(result))
  step('mixed selector touches neither reader nor transport', reader.calls.length === 0 && created === 0, 'reader=' + reader.calls.length + ' created=' + created)
})

await tryStep('semantic wrongtype native mismatch rejects without mutation', async () => {
  const { backend, transport } = makePhysicalBackend({ transport: makeFakeTransport({ elementType: 'XCUIElementTypeButton' }) })
  const result = await backend.typeTarget(physicalSemanticTarget())
  const mutations = transport.state.calls.filter(c => c.path.includes('/clear') || c.path.includes('/value'))
  step('semantic wrongtype maps to rejected ELEMENT_UNSUPPORTED', result.status === 'rejected' && result.dispatched === false && result.code === 'ELEMENT_UNSUPPORTED', JSON.stringify(result))
  step('wrongtype never dispatched', mutations.length === 0, 'mutations=' + mutations.length)
})

await tryStep('semantic label changed before mutation rejects', async () => {
  const { backend, transport } = makePhysicalBackend({ transport: makeFakeTransport({ labelSequence: [TT_SEMANTIC_LABEL, 'Renamed field'] }) })
  const result = await backend.typeTarget(physicalSemanticTarget())
  const mutations = transport.state.calls.filter(c => c.path.includes('/clear') || c.path.includes('/value'))
  step('label change maps to rejected ELEMENT_STALE', result.status === 'rejected' && result.dispatched === false && result.code === 'ELEMENT_STALE', JSON.stringify(result))
  step('label change never dispatched', mutations.length === 0)
})

await tryStep('semantic native secure field rejects', async () => {
  const { backend, transport } = makePhysicalBackend({ transport: makeFakeTransport({ elementType: 'XCUIElementTypeSecureTextField' }) })
  const result = await backend.typeTarget(physicalSemanticTarget())
  const mutations = transport.state.calls.filter(c => c.path.includes('/clear') || c.path.includes('/value'))
  step('semantic secure maps to rejected SECURE_REJECTED', result.status === 'rejected' && result.dispatched === false && result.code === 'SECURE_REJECTED', JSON.stringify(result))
  step('semantic secure never dispatched', mutations.length === 0)
})

await tryStep('semantic uncertain clear on empty fill attempted exactly once', async () => {
  const { backend, transport } = makePhysicalBackend({ transport: makeFakeTransport({ clearThrows: true }) })
  const result = await backend.fillTarget(physicalSemanticTarget({ text: '' }))
  const clears = transport.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/clear'))
  const values = transport.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/value'))
  step('uncertain clear maps to unknown/dispatched MUTATION_DISPATCH_UNKNOWN', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === false && result.code === 'MUTATION_DISPATCH_UNKNOWN', JSON.stringify(result))
  step('uncertain clear exactly once, no value, no retry', clears.length === 1 && values.length === 0, 'clear=' + clears.length + ' value=' + values.length)
})

await tryStep('semantic hostile label travels as an escaped native predicate', async () => {
  const hostile = String.raw`O'Brien's "Search" 100% off\end`
  const { backend, transport } = makePhysicalBackend({ transport: makeFakeTransport({ elementLabel: hostile }) })
  const result = await backend.typeTarget(physicalSemanticTarget({ semantic: { label: hostile, type: 'TextField' } }))
  const elementsCall = transport.state.calls.find(c => c.method === 'POST' && c.path.endsWith('/elements'))
  const expected = String.raw`type == 'XCUIElementTypeTextField' AND label == 'O\'Brien\'s "Search" 100% off\\end'`
  step('hostile label accepted through the semantic route', result.status === 'unknown' && result.nativeAccepted === true, JSON.stringify(result))
  step('hostile predicate is the exact escaped encoding', elementsCall !== undefined && elementsCall.body.value === expected, JSON.stringify(elementsCall?.body?.value))
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\nresults:')
for (const result of results) console.log('  ' + result.verdict.padEnd(4) + ' ' + result.name)
console.log('\n' + (results.length - failed) + '/' + results.length + ' physical targeted-text smoke steps passed')
if (failed > 0) process.exitCode = 1
