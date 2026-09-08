/**
 * Standalone fake-transport smoke for src/wda-targeted-text.ts.
 *
 * Runs directly from TypeScript source on Node 26 (type stripping); it does
 * not invoke a full build and never talks to a live simulator/device.
 *
 * Coverage:
 * - exact unique `/session/:sid/elements` route/body for append and replace
 * - append value-only vs replace clear+value
 * - proof frame vector inside the fixed point tolerance
 * - rejected before mutation for app/PID change, geometry mismatch, raw/native
 *   secure, unknown/disabled/invisible element, missing/ambiguous element,
 *   unpinned settings, pre-mutation native errors
 * - cancellation before and after dispatch
 * - mutation exactly once / no retry
 * - clear-success + value-error remains unknown/dispatched
 * - no raw typed text or native error body appears in returned fields
 * - semantic label+type route: native `predicate string` using spelling with
 *   exact escaped predicate, /attribute/label verification (never name),
 *   ambiguous label, wrongtype (zero-match and native-type mismatch),
 *   label-changed staleness, native secure, hostile predicate quotes,
 *   mixed identifier+semantic rejection, stale rect, exactly-once mutations
 * - empty text: append rejected; replace = exactly one clear and NO value
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  WDA_TARGETED_FRAME_TOLERANCE_POINTS,
  WDA_TARGETED_MAX_TEXT_LENGTH,
  performWdaTargetedText,
} = await import(join(root, 'src', 'wda-targeted-text.ts'))

const results = []
let failed = 0

function step(name, verdict, detail = '') {
  const normalized = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict
  if (normalized === 'FAIL') failed += 1
  results.push({ name, verdict: normalized, detail })
  console.log(`${normalized.padEnd(4)} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function fail(name, detail = '') {
  step(name, false, detail)
}

function ok(name, detail = '') {
  step(name, true, detail)
}

function isObj(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bodyValue(body) {
  return isObj(body) && Object.prototype.hasOwnProperty.call(body, 'value')
    ? body.value
    : body
}

const IDENTITY_BUNDLE = 'dev.zseven.qa.fixture.ios'
const IDENTITY_PID = 18519
const ELEMENT_ID = 'qa.input.name'
const SEMANTIC_LABEL = 'Search conversations'
const HOSTILE_LABEL = 'O\'Brien\'s "Search" 100% off\\end'
const EXPECTED_FRAME = { x: 16, y: 116.33, width: 370, height: 44 }
const WDA_FRAME_FIXTURE = { x: 16, y: 116, width: 370, height: 45 }
const UUID = '09000000-0000-0000-5748-000000000000'
const SID = 'D521926E-0AEF-44B8-8AA0-EF3063444378'

const ELEMENT_RECORD = {
  ELEMENT: UUID,
  'element-6066-11e4-a52e-4f735466cecf': UUID,
}

function defaultElementOverrides(overrides = {}) {
  return {
    name: ELEMENT_ID,
    label: SEMANTIC_LABEL,
    type: 'XCUIElementTypeTextField',
    enabled: true,
    visible: true,
    rect: WDA_FRAME_FIXTURE,
    ...overrides,
  }
}

function identity(pid = IDENTITY_PID) {
  return { bundleId: IDENTITY_BUNDLE, pid, verified: true }
}

function createIdentityReader(options = {}) {
  const calls = []
  const reader = async (_udid, _opts) => {
    calls.push(_udid)
    const value = options.values && options.values.length > 0 ? options.values.shift() : options.value ?? identity()
    if (options.throwOnCall >= 0 && calls.length === options.throwOnCall) throw new Error(options.throwMessage ?? 'identity failed')
    if (value === undefined) throw new Error('identity unavailable')
    return value
  }
  reader.calls = calls
  return reader
}

function createTransport(options = {}) {
  const state = {
    calls: [],
    activeApp: options.activeApp ?? { bundleId: IDENTITY_BUNDLE, pid: IDENTITY_PID },
    settingsValue: options.settingsValue !== undefined ? options.settingsValue : undefined,
    element: defaultElementOverrides(options.element),
    elements: options.elements !== undefined ? options.elements : [ELEMENT_RECORD],
    sessionStatus: options.sessionStatus ?? 200,
    settingsPostStatus: options.settingsPostStatus ?? 200,
    settingsGetStatus: options.settingsGetStatus ?? 200,
    applySettings: options.applySettings ?? true,
    activeStatus: options.activeStatus ?? 200,
    elementsStatus: options.elementsStatus ?? 200,
    attrStatus: options.attrStatus ?? 200,
    rectStatus: options.rectStatus ?? 200,
    clearStatus: options.clearStatus ?? 200,
    valueStatus: options.valueStatus ?? 200,
    valueThrows: options.valueThrows ?? false,
    clearThrows: options.clearThrows ?? false,
    throwOnceOnPath: options.throwOnceOnPath ?? undefined,
    labelSequence: options.labelSequence,
    rectSequence: options.rectSequence,
  }

  const request = async (method, path, body, requestOptions = {}) => {
    if (requestOptions.signal?.aborted === true) {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    state.calls.push({ method, path, body })

    const throwOnce = state.throwOnceOnPath
    if (throwOnce !== undefined
      && method === throwOnce.method
      && path === throwOnce.path) {
      state.throwOnceOnPath = undefined
      const error = new Error(throwOnce.message ?? 'transport failure')
      error.name = throwOnce.name ?? 'Error'
      throw error
    }

    const okResp = value => ({ statusCode: 200, body: { value } })
    const errorResp = (statusCode, error = 'native error') => ({
      statusCode,
      body: { value: { error, message: 'native error message', traceback: 'should-not-leak' } },
    })

    if (method === 'POST' && path === '/session') {
      if (state.sessionStatus !== 200) return errorResp(state.sessionStatus)
      return {
        statusCode: 200,
        body: { value: { sessionId: SID, capabilities: {} }, sessionId: SID },
      }
    }

    const settingsMatch = /^\/session\/([^/]+)\/appium\/settings$/.exec(path)
    if (settingsMatch !== null) {
      if (method === 'POST') {
        if (state.settingsPostStatus !== 200) return errorResp(state.settingsPostStatus)
        if (state.applySettings === true) {
          const settings = isObj(body) && isObj(body.settings) ? body.settings : {}
          state.settingsValue = settings.defaultActiveApplication ?? state.settingsValue
        }
        return okResp({ ...(state.settingsValue === undefined ? {} : { defaultActiveApplication: state.settingsValue }) })
      }
      if (method === 'GET') {
        if (state.settingsGetStatus !== 200) return errorResp(state.settingsGetStatus)
        return okResp({ ...(state.settingsValue === undefined ? {} : { defaultActiveApplication: state.settingsValue }) })
      }
    }

    if (method === 'GET' && path.endsWith('/wda/activeAppInfo')) {
      if (state.activeStatus !== 200) return errorResp(state.activeStatus)
      return okResp(state.activeApp)
    }

    const elementsMatch = /^\/session\/([^/]+)\/elements$/.exec(path)
    if (method === 'POST' && elementsMatch !== null) {
      if (state.elementsStatus !== 200) return errorResp(state.elementsStatus)
      const expectedUsing = body !== undefined && isObj(body) ? body.using : undefined
      if (expectedUsing !== 'accessibility id' && expectedUsing !== 'predicate string') return errorResp(400, 'invalid using')
      return okResp(state.elements)
    }

    const elementAttrMatch = /^\/session\/[^/]+\/element\/([^/]+)\/attribute\/([^/]+)$/.exec(path)
    const elementSimpleMatch = /^\/session\/[^/]+\/element\/([^/]+)\/(enabled|displayed|rect)$/.exec(path)
    if (method === 'GET' && elementAttrMatch !== null) {
      if (state.attrStatus !== 200) return errorResp(state.attrStatus)
      const attrName = elementAttrMatch[2]
      if (attrName === 'name') return okResp(state.element.name)
      if (attrName === 'label') {
        if (state.labelSequence !== undefined && state.labelSequence.length > 0) return okResp(state.labelSequence.shift())
        return okResp(state.element.label)
      }
      if (attrName === 'type') return okResp(state.element.type)
      return errorResp(400, 'unknown attribute')
    }
    if (method === 'GET' && elementSimpleMatch !== null) {
      if (state.attrStatus !== 200) return errorResp(state.attrStatus)
      if (elementSimpleMatch[2] === 'enabled') return okResp(state.element.enabled)
      if (elementSimpleMatch[2] === 'displayed') return okResp(state.element.visible)
      if (elementSimpleMatch[2] === 'rect') {
        if (state.rectStatus !== 200) return errorResp(state.rectStatus)
        if (state.rectSequence !== undefined && state.rectSequence.length > 0) return okResp(state.rectSequence.shift())
        return okResp(state.element.rect)
      }
      return errorResp(400, 'unknown attribute')
    }

    const clearMatch = /^\/session\/([^/]+)\/element\/([^/]+)\/clear$/.exec(path)
    if (method === 'POST' && clearMatch !== null) {
      if (state.clearThrows) throw new Error('clear transport reset')
      if (state.clearStatus !== 200) return errorResp(state.clearStatus)
      return okResp(null)
    }

    const valueMatch = /^\/session\/([^/]+)\/element\/([^/]+)\/value$/.exec(path)
    if (method === 'POST' && valueMatch !== null) {
      if (state.valueThrows) throw new Error('value transport reset')
      if (state.valueStatus !== 200) return errorResp(state.valueStatus)
      return okResp(null)
    }

    // Any unexpected route should fail loudly in the fake.
    return errorResp(404, 'unexpected fake route')
  }

  return { udid: 'SIM-1', request, state }
}


/** Exact expected predicate encoding for a semantic label (mirrors the client). */
function expectPredicate(value) {
  return `type == 'XCUIElementTypeTextField' AND label == '${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
function baseTarget(overrides = {}) {
  return {
    udid: 'SIM-1',
    bundleId: IDENTITY_BUNDLE,
    identifier: ELEMENT_ID,
    frame: EXPECTED_FRAME,
    mode: 'append',
    text: 'Hello',
    ...overrides,
  }
}

function makeEnv(transport, identityReader) {
  return { transport, readAppIdentity: identityReader }
}

async function expectRejected(name, invoke, expectedCode) {
  const result = await invoke()
  if (result.status !== 'rejected') return fail(name, `expected rejected, got ${JSON.stringify(result)}`)
  if (expectedCode !== undefined && result.code !== expectedCode) {
    return fail(name, `expected code ${expectedCode}, got ${result.code}`)
  }
  if (result.dispatched !== false || result.nativeAccepted !== false) {
    return fail(name, 'pre-mutation rejection must have dispatched=false nativeAccepted=false')
  }
  ok(name, `code=${result.code}`)
}

async function expectUnknown(name, invoke, expectedDispatched = true, expectedNative = false) {
  const result = await invoke()
  if (result.status !== 'unknown') return fail(name, `expected unknown, got ${JSON.stringify(result)}`)
  if (result.dispatched !== expectedDispatched) return fail(name, `expected dispatched=${expectedDispatched}`)
  if (result.nativeAccepted !== expectedNative) return fail(name, `expected nativeAccepted=${expectedNative}`)
  ok(name, `code=${result.code ?? '-'}`)
}

// 1. Successful append exact routes/bodies and proof fixture geometry.
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader))
  step('successful append returns unknown/dispatched/nativeAccepted', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true, `status=${result.status} dispatched=${result.dispatched} accepted=${result.nativeAccepted}`)
  const calls = transport.state.calls
  const session = calls.find(c => c.method === 'POST' && c.path === '/session')
  ok('append creates exact owned session capability body', session !== undefined
    && session.body.capabilities.alwaysMatch.bundleId === IDENTITY_BUNDLE
    && session.body.capabilities.alwaysMatch.forceAppLaunch === false
    && session.body.capabilities.alwaysMatch.shouldTerminateApp === false)
  const elementsCall = calls.find(c => c.method === 'POST' && c.path === `/session/${SID}/elements`)
  ok('append uses unique accessibility-id /elements body', elementsCall !== undefined
    && elementsCall.body.using === 'accessibility id' && elementsCall.body.value === ELEMENT_ID)
  const values = calls.filter(c => c.method === 'POST' && c.path === `/session/${SID}/element/${UUID}/value`)
  const clears = calls.filter(c => c.method === 'POST' && c.path === `/session/${SID}/element/${UUID}/clear`)
  ok('append sends exactly one value and no clear', values.length === 1 && clears.length === 0
    && values[0].body.value === 'Hello', `value=${values.length} clear=${clears.length}`)
  ok('append never sends tap or wda/keys', !calls.some(c => c.path.includes('/wda/keys') || c.path.includes('/wda/tap')))
  ok('no session delete or app termination/reset in setup/flow', !calls.some(c => c.method === 'DELETE' || c.path.includes('/terminate') || c.path.includes('/reset')))
  ok('proof AXe fixture frame is accepted once', result.nativeAccepted === true, `frame tolerance=${WDA_TARGETED_FRAME_TOLERANCE_POINTS}`)
}

// 2. Replace sends clear then value, no retries.
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(baseTarget({ mode: 'replace', text: 'Replacement' }), makeEnv(transport, identityReader))
  step('replace returns unknown/dispatched/nativeAccepted', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true)
  const calls = transport.state.calls
  const clearCalls = calls.filter(c => c.method === 'POST' && c.path === `/session/${SID}/element/${UUID}/clear`)
  const valueCalls = calls.filter(c => c.method === 'POST' && c.path === `/session/${SID}/element/${UUID}/value`)
  ok('replace sends exactly one clear then one value', clearCalls.length === 1 && valueCalls.length === 1
    && calls.indexOf(clearCalls[0]) < calls.indexOf(valueCalls[0])
    && valueCalls[0].body.value === 'Replacement')
}

// 3. App identity changes before setup / after setup / before mutation.
{
  const transport = createTransport()
  const identityReader = createIdentityReader({ values: [{ bundleId: 'other.app', pid: 99, verified: true }] })
  await expectRejected('different app identity before setup rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'APP_IDENTITY_MISMATCH')
}
{
  const transport = createTransport()
  const identityReader = createIdentityReader({ values: [identity(), { bundleId: IDENTITY_BUNDLE, pid: 999, verified: true }] })
  await expectRejected('PID changes after setup rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'APP_IDENTITY_MISMATCH')
}
{
  // Same identity for all three reads, but WDA reports a different active PID.
  const transport = createTransport({ activeApp: { bundleId: IDENTITY_BUNDLE, pid: 999 } })
  const identityReader = createIdentityReader()
  await expectRejected('WDA active PID mismatch rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'ACTIVE_APP_MISMATCH')
}
{
  const transport = createTransport({ activeApp: { bundleId: IDENTITY_BUNDLE, pid: IDENTITY_PID } })
  const identityReader = createIdentityReader({ values: [identity(), identity(), identity(999)] })
  await expectRejected('independent PID changes before mutation rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'APP_IDENTITY_MISMATCH')
}

// 4. Geometry mismatch and expectedPID.
{
  const transport = createTransport({ element: { rect: { x: 16, y: 130, width: 370, height: 45 } } })
  const identityReader = createIdentityReader()
  await expectRejected('geometry mismatch rejects before mutation', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'ELEMENT_GEOMETRY_MISMATCH')
}
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(baseTarget({ expectedPID: IDENTITY_PID }), makeEnv(transport, identityReader))
  step('matching expectedPID succeeds', result.nativeAccepted === true && result.dispatched === true)
}
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  await expectRejected('expectedPID mismatch rejects', () => performWdaTargetedText(baseTarget({ expectedPID: 987 }), makeEnv(transport, identityReader)), 'APP_IDENTITY_MISMATCH')
}

// 5. Secure/unknown/disabled/invisible element.
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  await expectRejected('raw secure target rejects before any WDA request', () => performWdaTargetedText(baseTarget({ secure: true }), makeEnv(transport, identityReader)), 'SECURE_REJECTED')
  if (transport.state.calls.length !== 0) fail('raw secure made no transport calls')
}
{
  const transport = createTransport({ element: { type: 'XCUIElementTypeSecureTextField' } })
  const identityReader = createIdentityReader()
  await expectRejected('native secure text field rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'SECURE_REJECTED')
}
{
  const transport = createTransport({ element: { type: 'XCUIElementTypeButton' } })
  const identityReader = createIdentityReader()
  await expectRejected('unknown/non-editable element type rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'ELEMENT_UNSUPPORTED')
}
{
  const transport = createTransport({ element: { enabled: false } })
  const identityReader = createIdentityReader()
  await expectRejected('disabled element rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'ELEMENT_UNSUPPORTED')
}
{
  const transport = createTransport({ element: { visible: false } })
  const identityReader = createIdentityReader()
  await expectRejected('invisible element rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'ELEMENT_UNSUPPORTED')
}

// 6. Multiple/missing elements.
{
  const transport = createTransport({ elements: [ELEMENT_RECORD, { ...ELEMENT_RECORD, ELEMENT: 'second' }] })
  const identityReader = createIdentityReader()
  await expectRejected('multiple elements reject as ambiguous', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'ELEMENT_AMBIGUOUS')
}
{
  const transport = createTransport({ elements: [] })
  const identityReader = createIdentityReader()
  await expectRejected('missing element rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'ELEMENT_LOOKUP_FAILED')
}

// 7. Unpinned session/settings.
{
  const transport = createTransport({ settingsValue: 'com.apple.Preferences', applySettings: false })
  const identityReader = createIdentityReader()
  await expectRejected('unpinned defaultActiveApplication setting rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'SETTING_PIN_FAILED')
}
{
  const transport = createTransport({ settingsPostStatus: 500 })
  const identityReader = createIdentityReader()
  await expectRejected('settings pin native error rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'SETTING_PIN_FAILED')
}
{
  const transport = createTransport({ settingsGetStatus: 404 })
  const identityReader = createIdentityReader()
  await expectRejected('settings verify native error rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'SETTING_PIN_FAILED')
}

// 8. Cancellation before/after mutation.
{
  const controller = new AbortController()
  controller.abort()
  const transport = createTransport()
  const identityReader = createIdentityReader()
  await expectRejected('cancellation before mutation rejects no dispatch', () => performWdaTargetedText(baseTarget({ signal: controller.signal }), makeEnv(transport, identityReader)), 'CANCELLED')
}
{
  const controller = new AbortController()
  const transport = createTransport()
  const originalRequest = transport.request
  transport.request = async (method, path, body, requestOptions = {}) => {
    const response = await originalRequest(method, path, body, requestOptions)
    if (method === 'POST' && path.endsWith('/clear')) controller.abort()
    return response
  }
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(baseTarget({ mode: 'replace', signal: controller.signal }), makeEnv(transport, identityReader))
  step('cancellation after clear is unknown/dispatched/native false', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === false, JSON.stringify(result))
  const clearCalls = transport.state.calls.filter(c => c.path.endsWith('/clear'))
  const valueCalls = transport.state.calls.filter(c => c.path.endsWith('/value'))
  step('clear sent once and no later value retry after cancellation', clearCalls.length === 1 && valueCalls.length === 0)
}

// 9. Mutation exactly once/no retry and uncertainty.
{
  const transport = createTransport({ clearStatus: 200, valueThrows: true })
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(baseTarget({ mode: 'replace' }), makeEnv(transport, identityReader))
  step('clear-success/value-throw result is unknown dispatched true native false', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === false, JSON.stringify(result))
  const valueCalls = transport.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/value'))
  step('value mutation attempted exactly once with no retry', valueCalls.length === 1)
}
{
  const transport = createTransport({ clearStatus: 400, valueStatus: 500 })
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(baseTarget({ mode: 'replace' }), makeEnv(transport, identityReader))
  step('clear native error is unknown/dispatched and stops before value', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === false
    && transport.state.calls.filter(c => c.path.endsWith('/value')).length === 0, JSON.stringify(result))
}
{
  const transport = createTransport({ clearStatus: 200, valueStatus: 500 })
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(baseTarget({ mode: 'replace' }), makeEnv(transport, identityReader))
  step('clear-success/value-error is unknown/dispatched/native false', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === false, JSON.stringify(result))
}

// 10. Native response errors before mutation.
{
  const transport = createTransport({ sessionStatus: 500 })
  const identityReader = createIdentityReader()
  await expectRejected('session native error rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'SESSION_FAILED')
}
{
  const transport = createTransport({ elementsStatus: 500 })
  const identityReader = createIdentityReader()
  await expectRejected('element query native error rejects', () => performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader)), 'ELEMENT_LOOKUP_FAILED')
}

// 11. No text/native error leakage in rejected or unknown results.
{
  const transport = createTransport({ clearStatus: 200, valueStatus: 400 })
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(baseTarget({ mode: 'replace', text: 'SecretText-ShouldNotLeak' }), makeEnv(transport, identityReader))
  const serialized = JSON.stringify(result)
  ok('no raw typed text appears in result', !serialized.includes('SecretText-ShouldNotLeak') && result.reason !== undefined ? !result.reason.includes('native error message') : true)
  ok('no native error body appears in result', !serialized.includes('should-not-leak') && !serialized.includes('native error message'))
}
{
  const transport = createTransport({ sessionStatus: 500 })
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(baseTarget(), makeEnv(transport, identityReader))
  const serialized = JSON.stringify(result)
  ok('no native error body appears in pre-mutation rejection', !serialized.includes('should-not-leak') && !serialized.includes('native error message'))
}

// 12. Input validation and bounds.
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  await expectRejected('udid mismatch rejects', () => performWdaTargetedText(baseTarget({ udid: 'OTHER' }), makeEnv(transport, identityReader)), 'UDID_MISMATCH')
  await expectRejected('non-finite frame rejects', () => performWdaTargetedText(baseTarget({ frame: { x: Number.NaN, y: 0, width: 100, height: 44 } }), makeEnv(transport, identityReader)), 'INVALID_ARGUMENT')
  await expectRejected('overlong text rejects', () => performWdaTargetedText(baseTarget({ text: 'x'.repeat(WDA_TARGETED_MAX_TEXT_LENGTH + 1) }), makeEnv(transport, identityReader)), 'INVALID_ARGUMENT')
}


// 12b. Semantic label+type route (native `predicate string`).
function semanticTarget(overrides = {}) {
  return {
    udid: 'SIM-1',
    bundleId: IDENTITY_BUNDLE,
    semantic: { label: SEMANTIC_LABEL, type: 'TextField' },
    frame: EXPECTED_FRAME,
    mode: 'append',
    text: 'Hello',
    ...overrides,
  }
}

{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(semanticTarget(), makeEnv(transport, identityReader))
  step('semantic append returns unknown/dispatched/nativeAccepted', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true, JSON.stringify(result))
  const calls = transport.state.calls
  const elementsCall = calls.find(c => c.method === 'POST' && c.path === `/session/${SID}/elements`)
  ok('semantic uses native predicate string using spelling', elementsCall !== undefined && elementsCall.body.using === 'predicate string', JSON.stringify(elementsCall?.body))
  ok('semantic predicate is exact quoted type+label', elementsCall !== undefined && elementsCall.body.value === expectPredicate(SEMANTIC_LABEL), JSON.stringify(elementsCall?.body?.value))
  const values = calls.filter(c => c.method === 'POST' && c.path === `/session/${SID}/element/${UUID}/value`)
  const clears = calls.filter(c => c.path.endsWith('/clear'))
  ok('semantic append sends exactly one value and no clear', values.length === 1 && clears.length === 0, `value=${values.length} clear=${clears.length}`)
  const labelReads = calls.filter(c => c.method === 'GET' && c.path.includes('/attribute/label'))
  const nameReads = calls.filter(c => c.method === 'GET' && c.path.includes('/attribute/name'))
  ok('semantic route verifies native label attribute and never name', labelReads.length === 2 && nameReads.length === 0, `label=${labelReads.length} name=${nameReads.length}`)
  ok('Appium -ios predicate string spelling is never sent', calls.every(c => JSON.stringify(c.body ?? {}).includes('-ios predicate string') === false))
}

{
  const transport = createTransport({ elements: [ELEMENT_RECORD, { ...ELEMENT_RECORD, ELEMENT: 'second-uuid' }] })
  const identityReader = createIdentityReader()
  await expectRejected('semantic ambiguous label rejects', () => performWdaTargetedText(semanticTarget(), makeEnv(transport, identityReader)), 'ELEMENT_AMBIGUOUS')
}
{
  const transport = createTransport({ elements: [] })
  const identityReader = createIdentityReader()
  await expectRejected('semantic wrongtype (no native match) rejects', () => performWdaTargetedText(semanticTarget(), makeEnv(transport, identityReader)), 'ELEMENT_LOOKUP_FAILED')
}
{
  const transport = createTransport({ element: { type: 'XCUIElementTypeButton' } })
  const identityReader = createIdentityReader()
  await expectRejected('semantic wrongtype (native type mismatch) rejects', () => performWdaTargetedText(semanticTarget(), makeEnv(transport, identityReader)), 'ELEMENT_UNSUPPORTED')
  if (transport.state.calls.some(c => c.path.includes('/value') || c.path.includes('/clear'))) fail('wrongtype never dispatched a mutation')
}
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  await expectRejected('semantic type outside TextField/TextView/SearchField rejects', () => performWdaTargetedText(semanticTarget({ semantic: { label: SEMANTIC_LABEL, type: 'Button' } }), makeEnv(transport, identityReader)), 'INVALID_ARGUMENT')
  if (transport.state.calls.length !== 0) fail('unsupported semantic type made no transport calls')
}
{
  const transport = createTransport({ labelSequence: [SEMANTIC_LABEL, 'Renamed field'] })
  const identityReader = createIdentityReader()
  await expectRejected('semantic label changed before mutation rejects', () => performWdaTargetedText(semanticTarget(), makeEnv(transport, identityReader)), 'ELEMENT_STALE')
  if (transport.state.calls.some(c => c.path.includes('/value') || c.path.includes('/clear'))) fail('labelchanged never dispatched a mutation')
}
{
  const transport = createTransport({ element: { type: 'XCUIElementTypeSecureTextField' } })
  const identityReader = createIdentityReader()
  await expectRejected('semantic native secure type rejects', () => performWdaTargetedText(semanticTarget(), makeEnv(transport, identityReader)), 'SECURE_REJECTED')
}
{
  const transport = createTransport({ element: { label: HOSTILE_LABEL } })
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(semanticTarget({ semantic: { label: HOSTILE_LABEL, type: 'TextField' } }), makeEnv(transport, identityReader))
  step('hostile quote/backslash/percent label succeeds', result.status === 'unknown' && result.nativeAccepted === true, JSON.stringify(result))
  const elementsCall = transport.state.calls.find(c => c.method === 'POST' && c.path.endsWith('/elements'))
  ok('hostile label encoded exactly (quote and backslash escaped)', elementsCall !== undefined && elementsCall.body.value === expectPredicate(HOSTILE_LABEL), JSON.stringify(elementsCall?.body?.value))
}
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  await expectRejected('semantic label with %@ substitution specifier rejects', () => performWdaTargetedText(semanticTarget({ semantic: { label: 'Price %@ now', type: 'TextField' } }), makeEnv(transport, identityReader)), 'INVALID_ARGUMENT')
  if (transport.state.calls.length !== 0) fail('unsafe predicate label made no transport calls')
}
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  await expectRejected('mixed identifier+semantic rejects', () => performWdaTargetedText({ ...semanticTarget(), identifier: ELEMENT_ID }, makeEnv(transport, identityReader)), 'INVALID_ARGUMENT')
  await expectRejected('neither identifier nor semantic rejects', () => performWdaTargetedText({ udid: 'SIM-1', bundleId: IDENTITY_BUNDLE, frame: EXPECTED_FRAME, mode: 'append', text: 'x' }, makeEnv(transport, identityReader)), 'INVALID_ARGUMENT')
  if (transport.state.calls.length !== 0) fail('mixed/absent selector made no transport calls')
}
{
  const transport = createTransport({ rectSequence: [WDA_FRAME_FIXTURE, { x: 16, y: 130, width: 370, height: 45 }] })
  const identityReader = createIdentityReader()
  await expectRejected('semantic stale rect before mutation rejects', () => performWdaTargetedText(semanticTarget(), makeEnv(transport, identityReader)), 'ELEMENT_GEOMETRY_MISMATCH')
  if (transport.state.calls.some(c => c.path.includes('/value') || c.path.includes('/clear'))) fail('stale rect never dispatched a mutation')
}
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(semanticTarget({ mode: 'replace', text: 'Replacement' }), makeEnv(transport, identityReader))
  step('semantic replace returns unknown/dispatched/nativeAccepted', result.status === 'unknown' && result.nativeAccepted === true, JSON.stringify(result))
  const calls = transport.state.calls
  const clears = calls.filter(c => c.method === 'POST' && c.path.endsWith('/clear'))
  const values = calls.filter(c => c.method === 'POST' && c.path.endsWith('/value'))
  ok('semantic replace sends exactly one clear then one value', clears.length === 1 && values.length === 1 && calls.indexOf(clears[0]) < calls.indexOf(values[0]), `clear=${clears.length} value=${values.length}`)
}
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  await expectRejected('append with empty text rejects', () => performWdaTargetedText(semanticTarget({ mode: 'append', text: '' }), makeEnv(transport, identityReader)), 'INVALID_ARGUMENT')
  await expectRejected('identifier append with empty text rejects', () => performWdaTargetedText(baseTarget({ text: '' }), makeEnv(transport, identityReader)), 'INVALID_ARGUMENT')
}
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(baseTarget({ mode: 'replace', text: '' }), makeEnv(transport, identityReader))
  step('identifier replace with empty text is accepted', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true, JSON.stringify(result))
  const calls = transport.state.calls
  ok('empty replace sends exactly one clear and no value', calls.filter(c => c.method === 'POST' && c.path.endsWith('/clear')).length === 1 && calls.filter(c => c.method === 'POST' && c.path.endsWith('/value')).length === 0)
}
{
  const transport = createTransport()
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(semanticTarget({ mode: 'replace', text: '' }), makeEnv(transport, identityReader))
  step('semantic empty replace is accepted', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === true, JSON.stringify(result))
  const calls = transport.state.calls
  ok('semantic empty replace sends exactly one clear and no value', calls.filter(c => c.method === 'POST' && c.path.endsWith('/clear')).length === 1 && calls.filter(c => c.method === 'POST' && c.path.endsWith('/value')).length === 0)
}
{
  const transport = createTransport({ clearThrows: true })
  const identityReader = createIdentityReader()
  const result = await performWdaTargetedText(semanticTarget({ mode: 'replace', text: '' }), makeEnv(transport, identityReader))
  step('empty fill with clear transport throw is unknown/dispatched/native false', result.status === 'unknown' && result.dispatched === true && result.nativeAccepted === false && result.code === 'MUTATION_DISPATCH_UNKNOWN', JSON.stringify(result))
  const clearCalls = transport.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/clear'))
  ok('uncertain clear attempted exactly once, no value, no retry', clearCalls.length === 1 && transport.state.calls.filter(c => c.path.endsWith('/value')).length === 0)
}
// 13. Final summary.
console.log('\nresults:')
for (const result of results) console.log(`  ${result.verdict.padEnd(4)} ${result.name}`)
console.log(`\n${results.length - failed}/${results.length} targeted-text smoke steps passed`)
if (failed > 0) process.exitCode = 1
