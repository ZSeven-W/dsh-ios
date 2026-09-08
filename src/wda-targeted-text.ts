/**
 * Bounded, element-bound WebDriverAgent (WDA) text client for iOS.
 *
 * This module performs the safe native text mutation proven by the WDA
 * simulator proof:
 *
 * - It never taps, never uses `/wda/keys`, and never asks WDA to find a fuzzy
 *   first match.
 * - It creates a dedicated WDA session with `forceAppLaunch:false` and
 *   `shouldTerminateApp:false` (both are actual WDA capability keys in the
 *   cached source), pins `defaultActiveApplication` to the requested bundle
 *   in that session's settings, and verifies the pin and WDA's active app.
 * - It verifies independent app identity/PID before setup, after setup, and
 *   again immediately before mutation. The reader's evidence kind is defined
 *   by the injected verifier (frontmost on the simulator backend; RUNNING
 *   process identity on the physical backend — never claimed as frontmost),
 *   and the session-scoped WDA activeApp corroboration is always mandatory
 *   and never the sole check.
 * - It resolves the element through exactly one route: a native
 *   `accessibility id` identifier, or an exact native semantic pair
 *   (`label` AND `type`) queried with the NATIVE `predicate string`
 *   using spelling (FBFindElementCommands.m — never the Appium-only
 *   `-ios predicate string` spelling). Both routes require exactly one
 *   match and never fall back to fuzzy/first/index/coordinate lookup.
 * - For a semantic target the label stays a LABEL: it is encoded into the
 *   predicate (backslash/single-quote escaping, substitution-specifier
 *   refusal) and then verified through the native `/attribute/label`
 *   value — never through `name`, because WDA's `name` falls back to the
 *   label when an identifier is absent.
 * - It re-reads the native element guards (label/identifier, known editable
 *   nonsecure type — which is also the native secure signal, enabled,
 *   visible, rect) immediately before mutation.
 * - Mutations are limited to `/element/:uuid/clear` and/or
 *   `/element/:uuid/value`, sent exactly once and never retried.
 *
 * The caller supplies a structural transport (`udid` plus a one-shot
 * `request(method, path, body, {signal?})` function) and an independent app
 * identity reader. This module never imports QA/host packages, never builds a
 * URL/authority, never contains text/body values in errors, and never claims
 * business confirmation from a successful native request.
 *
 * @module @zseven-w/dsh-ios/wda-targeted-text
 */

/** A finite point-space frame, matching the iOS native/WDA coordinate space. */
export interface WdaTargetedTextFrame {
  x: number
  y: number
  width: number
  height: number
}

/** One independent app identity as returned by the injected verifier. */
export interface WdaTargetedTextAppIdentity {
  bundleId: string
  pid: number
  /**
   * Optional verification marker. The injected callback is responsible for
   * verifying identity; when the callback still returns a marker it must not
   * be false.
   */
  verified?: boolean
}

export type WdaTargetedTextMode = 'append' | 'replace'

/** Native semantic route for an element with no accessibility identifier. */
export interface WdaTargetedTextSemantic {
  /**
   * Exact native accessibility label. It is encoded into a native
   * `predicate string` query and verified afterwards through WDA's
   * `/attribute/label` (never assumed from `name`, which WDA falls back
   * to the label when no identifier exists).
   */
  label: string
  /**
   * Native WDA element type: exactly one of `TextField`, `TextView`,
   * `SearchField`. Other types are rejected before any WDA request.
   */
  type: string
}

/** Bounded target for a WDA element-bound text mutation. */
export interface WdaTargetedTextTarget {
  /** Explicit device identifier. Must equal `transport.udid`. */
  udid: string
  /**
   * Requested bundle identifier of the running app. The injected identity
   * reader defines what evidence it proves: the simulator backend proves
   * FRONTMOST, the physical backend proves RUNNING CoreDevice process
   * identity (never frontmost) corroborated by WDA activeAppInfo.
   */
  bundleId: string
  /**
   * Native stable accessibility identifier (never a tree path/fuzzy label).
   * Exactly one of `identifier` or `semantic` must be provided.
   */
  identifier?: string
  /**
   * Exact native label+type route for elements without an accessibility
   * identifier. Exactly one of `identifier` or `semantic` must be
   * provided.
   */
  semantic?: WdaTargetedTextSemantic
  /** Expected element frame in WDA point space. */
  frame: WdaTargetedTextFrame
  /**
   * `append` sends value only; `replace` sends clear followed by value.
   * For `replace`, empty text means exactly one native clear and NO value.
   */
  mode: WdaTargetedTextMode
  /**
   * Text to append or use as replacement. Non-empty for `append`; may be
   * empty for `replace` (clear-only). Never echoed into result fields.
   */
  text: string
  /** Optional process id that the independent and WDA identities must match. */
  expectedPID?: number
  /** Raw secure flag. `true` always rejects before any WDA request. */
  secure?: boolean
  /** Optional cancellation signal. */
  signal?: AbortSignal
}

/** Transport response returned by the injected one-shot request function. */
export interface WdaTargetedTextResponse {
  statusCode: number
  /** JSON-decoded response body; non-JSON text may also appear here. */
  body: unknown
}

/** Structural dedicated WDA transport required by this client. */
export interface WdaTargetedTextTransport {
  udid: string
  /**
   * One-shot request. This client never retries mutation requests. When a
   * mutation call throws, the client conservatively assumes it may have
   * reached WDA.
   */
  request(
    method: string,
    path: string,
    body?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<WdaTargetedTextResponse>
}

/** Reads a verified, independent app identity (AXe/launchctl-style evidence). */
export type WdaTargetedReadAppIdentity = (
  udid: string,
  options?: { signal?: AbortSignal },
) => Promise<WdaTargetedTextAppIdentity>

/** Options binding one call to its dedicated transport and verifier. */
export interface WdaTargetedTextEnvironment {
  transport: WdaTargetedTextTransport
  readAppIdentity: WdaTargetedReadAppIdentity
}

export type WdaTargetedTextStatus = 'unknown' | 'rejected'

export type WdaTargetedTextCode =
  | 'INVALID_ARGUMENT'
  | 'UDID_MISMATCH'
  | 'CANCELLED'
  | 'SECURE_REJECTED'
  | 'APP_IDENTITY_UNAVAILABLE'
  | 'APP_IDENTITY_MISMATCH'
  | 'SESSION_FAILED'
  | 'SETTING_PIN_FAILED'
  | 'ACTIVE_APP_MISMATCH'
  | 'ELEMENT_LOOKUP_FAILED'
  | 'ELEMENT_AMBIGUOUS'
  | 'ELEMENT_UNSUPPORTED'
  | 'ELEMENT_GEOMETRY_MISMATCH'
  | 'ELEMENT_STALE'
  | 'MUTATION_DISPATCH_UNKNOWN'
  | 'NATIVE_REJECTED'

/**
 * Result of a targeted text operation.
 *
 * - `rejected` is used only when no mutation request can have been sent.
 * - `unknown` is used as soon as `/clear` or `/value` may have been sent.
 * - `nativeAccepted` is true only when every required native mutation request
 *   returned a 2xx response; this is never a business-level confirmation.
 */
export interface WdaTargetedTextResult {
  status: WdaTargetedTextStatus
  /** True once a mutation request was sent or may have been sent. */
  dispatched: boolean
  /** True only when all native mutations returned HTTP 2xx. */
  nativeAccepted: boolean
  /** Stable non-sensitive classification for a non-success result. */
  code?: WdaTargetedTextCode
  /** Human-readable safe summary; never contains typed text or native error bodies. */
  reason?: string
}

/** Point tolerance matching WDA's `CGRectIntegral` rounding on the proof. */
export const WDA_TARGETED_FRAME_TOLERANCE_POINTS = 1

/** Maximum accepted text length; values longer than this are rejected. */
export const WDA_TARGETED_MAX_TEXT_LENGTH = 4096

/** Known nonsecure editable WDA types allowed for text value mutation. */
const EDITABLE_NONSECURE_TYPES = new Set([
  'TextField',
  'TextView',
  'SearchField',
])

/** Semantic targets are restricted to the same known editable native types. */
const SEMANTIC_TYPES = EDITABLE_NONSECURE_TYPES

/**
 * Encode a value for a single-quoted NSPredicate string literal.
 *
 * Verified against local Foundation with an NSException-safe probe:
 * `\'` inside single quotes decodes to a literal single quote,
 * `\\` decodes to a literal backslash, and a bare `%` followed by a
 * non-substitution character stays literal. `%%` is NOT an escape and
 * `%K`/`%@` are substitution specifiers that WDA's arg-less
 * `predicateWithFormat:` cannot fill — such labels are rejected up front
 * (validateTarget) instead of being encoded.
 */
function escapePredicateLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** Exact native predicate: type AND label, both quoted string constants. */
function semanticPredicate(semantic: WdaTargetedTextSemantic): string {
  return `type == 'XCUIElementType${semantic.type}' AND label == '${escapePredicateLiteral(semantic.label)}'`
}

/** True when a label cannot be encoded safely into an NSPredicate format string. */
function hasUnsafePredicateSubstitution(value: string): boolean {
  return /%[@A-Za-z]/.test(value)
}

function resultRejected(
  code: WdaTargetedTextCode,
  reason: string,
): WdaTargetedTextResult {
  return {
    status: 'rejected',
    dispatched: false,
    nativeAccepted: false,
    code,
    reason,
  }
}

function resultUnknown(
  code: WdaTargetedTextCode,
  reason: string,
  nativeAccepted: boolean,
): WdaTargetedTextResult {
  return {
    status: 'unknown',
    dispatched: true,
    nativeAccepted,
    code,
    reason,
  }
}

function invalid(reason = 'invalid argument'): WdaTargetedTextResult {
  return resultRejected('INVALID_ARGUMENT', reason)
}

function cancelledBeforeMutation(signal: AbortSignal | undefined): WdaTargetedTextResult | undefined {
  return signal?.aborted === true
    ? resultRejected('CANCELLED', 'operation was cancelled before mutation')
    : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSuccess(response: WdaTargetedTextResponse): boolean {
  return isObject(response) && Number.isInteger(response.statusCode) && response.statusCode >= 200 && response.statusCode < 300
}

/** Unwrap a WDA JSON response envelope's `value`, preserving any other doc. */
function wdaValue(body: unknown): unknown {
  if (isObject(body) && Object.prototype.hasOwnProperty.call(body, 'value')) {
    return body.value
  }
  return body
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function cleanType(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  return raw.startsWith('XCUIElementType') ? raw.slice('XCUIElementType'.length) : raw
}

function sameBundleAndPid(identity: WdaTargetedTextAppIdentity | undefined, bundleId: string, pid: number): boolean {
  return identity !== undefined
    && identity.bundleId === bundleId
    && identity.pid === pid
}

function elementIdFromRecord(record: unknown): string | undefined {
  if (!isObject(record)) return undefined
  const w3c = record['element-6066-11e4-a52e-4f735466cecf']
  const jsonwp = record.ELEMENT
  const raw = typeof w3c === 'string' && w3c !== ''
    ? w3c
    : typeof jsonwp === 'string' && jsonwp !== ''
      ? jsonwp
      : undefined
  return raw
}

function encodeUuid(uuid: string): string {
  // WDA element UUIDs are opaque native tokens; path pieces are always encoded.
  return encodeURIComponent(uuid)
}

function expectedPidMatches(expected: number | undefined, actual: number | undefined): boolean {
  if (expected === undefined) return true
  return expected === actual
}

interface GuardObservation {
  ok: false
  code?: WdaTargetedTextCode
  reason?: string
}

/** Native identity attribute re-read per route ('name' = identifier, 'label' = label). */
type ElementIdentityAttribute = 'name' | 'label'

interface ElementGuards {
  ok: true
  /** Verified native identity value: accessibility identifier for 'name', label for 'label'. */
  identity: string
  type: string
  enabled: true
  visible: true
  frame: WdaTargetedTextFrame
}

/**
 * Re-read one native element guard set. Every returned 2xx body is unwrapped;
 * errors are reported as non-sensitive rejections. The semantic route reads
 * the native `label` attribute — never `name`, which WDA falls back to
 * the label when no accessibility identifier exists.
 */
async function readElementGuards(
  request: WdaTargetedTextTransport['request'],
  sid: string,
  uuid: string,
  identityAttribute: ElementIdentityAttribute,
  signal: AbortSignal | undefined,
): Promise<ElementGuards | GuardObservation> {
  const read = async (path: string): Promise<unknown> => {
    const response = await request('GET', `/session/${encodeURIComponent(sid)}/element/${encodeUuid(uuid)}${path}`, undefined, { signal })
    if (!isSuccess(response)) {
      return undefined
    }
    return wdaValue(response.body)
  }

  const identity = await read(`/attribute/${identityAttribute}`)
  const typeRaw = await read('/attribute/type')
  const enabled = await read('/enabled')
  const visible = await read('/displayed')
  const rect = await read('/rect')
  if (typeof identity !== 'string' || identity === ''
    || typeof typeRaw !== 'string' || typeRaw === ''
    || enabled !== true || visible !== true
    || !isObject(rect)) {
    const identityKind = identityAttribute === 'label' ? 'label' : 'identifier'
    const reason = identity !== undefined && identity !== ''
      ? 'element did not satisfy native text guards'
      : `native element ${identityKind} could not be verified`
    const code = identity !== undefined && identity !== '' ? 'ELEMENT_UNSUPPORTED' : 'ELEMENT_STALE'
    return { ok: false, code, reason }
  }
  const type = cleanType(typeRaw)
  if (!finiteNumber(rect.x) || !finiteNumber(rect.y) || !finiteNumber(rect.width) || !finiteNumber(rect.height)
    || rect.width < 0 || rect.height < 0) {
    return { ok: false, code: 'ELEMENT_STALE', reason: 'element returned an invalid frame' }
  }
  const frame: WdaTargetedTextFrame = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  }
  return { ok: true, identity, type: type ?? typeRaw, enabled, visible, frame }
}

function guardFramesWithinTolerance(actual: WdaTargetedTextFrame, expected: WdaTargetedTextFrame): boolean {
  return Math.abs(actual.x - expected.x) <= WDA_TARGETED_FRAME_TOLERANCE_POINTS
    && Math.abs(actual.y - expected.y) <= WDA_TARGETED_FRAME_TOLERANCE_POINTS
    && Math.abs(actual.width - expected.width) <= WDA_TARGETED_FRAME_TOLERANCE_POINTS
    && Math.abs(actual.height - expected.height) <= WDA_TARGETED_FRAME_TOLERANCE_POINTS
}

function validateTarget(target: WdaTargetedTextTarget | undefined | null, environment: WdaTargetedTextEnvironment | undefined | null): WdaTargetedTextResult | undefined {
  if (target === undefined || target === null || environment === undefined || environment === null
    || !isObject(environment.transport)
    || typeof environment.transport.request !== 'function'
    || typeof environment.readAppIdentity !== 'function') {
    return invalid('target and environment are required')
  }
  if (typeof target.udid !== 'string' || target.udid === '') return invalid('udid must be a non-empty string')
  if (typeof environment.transport.udid !== 'string' || environment.transport.udid === '') return invalid('transport udid must be a non-empty string')
  if (target.udid !== environment.transport.udid) return resultRejected('UDID_MISMATCH', 'target udid does not match the dedicated transport udid')
  if (typeof target.bundleId !== 'string' || target.bundleId === '') return invalid('bundleId must be a non-empty string')
  // Exactly one element route: native identifier XOR native label+type.
  const hasIdentifier = target.identifier !== undefined
  const hasSemantic = target.semantic !== undefined
  if (hasIdentifier === hasSemantic) {
    return invalid('exactly one of identifier or semantic must be provided')
  }
  if (hasIdentifier) {
    if (typeof target.identifier !== 'string' || target.identifier === '') return invalid('identifier must be a non-empty string')
  } else {
    const semantic = target.semantic
    if (!isObject(semantic)
      || typeof semantic.label !== 'string' || semantic.label === ''
      || typeof semantic.type !== 'string' || !SEMANTIC_TYPES.has(semantic.type)) {
      return invalid('semantic must provide a non-empty label and a native type (TextField, TextView, or SearchField)')
    }
    if (semantic.label.length > WDA_TARGETED_MAX_TEXT_LENGTH) return invalid('semantic label is too long')
    if (hasUnsafePredicateSubstitution(semantic.label)) {
      return invalid('semantic label cannot be safely encoded into a native predicate string')
    }
    if (/[\u0000-\u001F\u007F]/.test(semantic.label)) return invalid('semantic label must not contain control characters')
  }
  if (typeof target.frame !== 'object' || target.frame === null) return invalid('frame must be an object')
  const frame = target.frame
  if (![frame.x, frame.y, frame.width, frame.height].every(finiteNumber)) return invalid('frame fields must be finite numbers')
  if (frame.width < 0 || frame.height < 0) return invalid('frame width/height must be non-negative')
  if (target.mode !== 'append' && target.mode !== 'replace') return invalid('mode must be append or replace')
  if (typeof target.text !== 'string') return invalid('text must be a string')
  if (target.text.length > WDA_TARGETED_MAX_TEXT_LENGTH) return invalid('text is too long')
  if (target.mode === 'append' && target.text.length === 0) return invalid('append requires a non-empty text; use replace mode to clear the element')
  if (target.expectedPID !== undefined && (!Number.isSafeInteger(target.expectedPID) || target.expectedPID < 0)) return invalid('expectedPID must be a non-negative safe integer')
  if (target.secure === true) return resultRejected('SECURE_REJECTED', 'secure text targets are not supported')
  if (target.secure !== undefined && typeof target.secure !== 'boolean') return invalid('secure must be a boolean when provided')
  return undefined
}

async function readVerifiedIdentity(
  readAppIdentity: WdaTargetedReadAppIdentity,
  udid: string,
  signal: AbortSignal | undefined,
): Promise<WdaTargetedTextAppIdentity | undefined> {
  try {
    const identity = await readAppIdentity(udid, { signal })
    if (!isObject(identity)
      || typeof identity.bundleId !== 'string' || identity.bundleId === ''
      || !Number.isSafeInteger(identity.pid) || identity.pid < 0) {
      return undefined
    }
    if (identity.verified === false) return undefined
    return identity as WdaTargetedTextAppIdentity
  } catch {
    return undefined
  }
}

/**
 * Perform one bounded, element-bound WDA text mutation.
 *
 * Returns a result object; this function intentionally does not throw for
 * operational/transport failures. Mutation text and native error bodies are
 * never included in the result.
 */
export async function performWdaTargetedText(
  target: WdaTargetedTextTarget,
  environment: WdaTargetedTextEnvironment,
): Promise<WdaTargetedTextResult> {
  const invalidResult = validateTarget(target, environment)
  if (invalidResult !== undefined) return invalidResult

  const signal = target.signal
  if (signal?.aborted === true) return resultRejected('CANCELLED', 'operation was cancelled before mutation')
  const request = environment.transport.request
  const readAppIdentity = environment.readAppIdentity
  const {
    udid,
    bundleId,
    identifier,
    semantic,
    frame: expectedFrame,
    mode,
    text,
    expectedPID,
  } = target
  // Exactly one route was validated above: identifier (accessibility id) or
  // semantic label+type (native predicate string).
  const identityAttribute: ElementIdentityAttribute = semantic !== undefined ? 'label' : 'name'
  const expectedIdentity: string | undefined = semantic !== undefined ? semantic.label : identifier
  const lookupUsing = semantic !== undefined ? 'predicate string' : 'accessibility id'
  const lookupValue = semantic !== undefined ? semanticPredicate(semantic) : identifier
  const lookupSubject = semantic !== undefined ? 'the semantic label and type' : 'the accessibility identifier'

  // Independent verification before any WDA session setup.
  const identityBefore = await readVerifiedIdentity(readAppIdentity, udid, signal)
  if (identityBefore === undefined) {
    return cancelledBeforeMutation(signal) ?? resultRejected('APP_IDENTITY_UNAVAILABLE', 'independent app identity could not be verified before setup')
  }
  if (identityBefore.bundleId !== bundleId || !expectedPidMatches(expectedPID, identityBefore.pid)) {
    return resultRejected('APP_IDENTITY_MISMATCH', 'independent app identity does not match the requested app')
  }

  // Own a dedicated session without launching or terminating the target app.
  let sessionResponse: WdaTargetedTextResponse
  try {
    sessionResponse = await request('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          bundleId,
          forceAppLaunch: false,
          shouldTerminateApp: false,
        },
      },
    }, { signal })
  } catch {
    return cancelledBeforeMutation(signal) ?? resultRejected('SESSION_FAILED', 'could not create a dedicated WDA session')
  }
  if (!isSuccess(sessionResponse)) {
    return cancelledBeforeMutation(signal) ?? resultRejected('SESSION_FAILED', 'could not create a dedicated WDA session')
  }

  const sessionBody = sessionResponse.body
  const sessionValue = isObject(sessionBody) ? sessionBody.value : undefined
  const sidValue = isObject(sessionBody) && typeof sessionBody.sessionId === 'string'
    ? sessionBody.sessionId
    : isObject(sessionValue) && typeof sessionValue.sessionId === 'string'
      ? sessionValue.sessionId
      : undefined
  if (sidValue === undefined || sidValue === '') {
    return resultRejected('SESSION_FAILED', 'WDA session response did not contain a session id')
  }
  const sid = sidValue
  const sessionPrefix = `/session/${encodeURIComponent(sid)}`

  // Pin defaultActiveApplication to the requested bundle and verify the pin.
  try {
    const pinResponse = await request('POST', `${sessionPrefix}/appium/settings`, {
      settings: { defaultActiveApplication: bundleId },
    }, { signal })
    if (!isSuccess(pinResponse)) return resultRejected('SETTING_PIN_FAILED', 'could not pin WDA defaultActiveApplication')
    const verifyResponse = await request('GET', `${sessionPrefix}/appium/settings`, undefined, { signal })
    if (!isSuccess(verifyResponse)) return resultRejected('SETTING_PIN_FAILED', 'could not verify WDA defaultActiveApplication')
    const settings = isObject(wdaValue(verifyResponse.body)) ? wdaValue(verifyResponse.body) as Record<string, unknown> : undefined
    if (settings === undefined || settings.defaultActiveApplication !== bundleId) {
      return resultRejected('SETTING_PIN_FAILED', 'WDA defaultActiveApplication pin did not match the requested bundle')
    }
  } catch {
    return cancelledBeforeMutation(signal) ?? resultRejected('SETTING_PIN_FAILED', 'could not pin WDA defaultActiveApplication')
  }

  // Independent verification after setup.
  const identityAfterSetup = await readVerifiedIdentity(readAppIdentity, udid, signal)
  if (identityAfterSetup === undefined) {
    return cancelledBeforeMutation(signal) ?? resultRejected('APP_IDENTITY_UNAVAILABLE', 'independent app identity could not be verified after setup')
  }
  if (!sameBundleAndPid(identityAfterSetup, bundleId, identityBefore.pid)
    || !expectedPidMatches(expectedPID, identityAfterSetup.pid)) {
    return resultRejected('APP_IDENTITY_MISMATCH', 'independent app identity changed after setup')
  }

  const readActiveApp = async (): Promise<{ bundleId?: string; pid?: number } | undefined> => {
    try {
      const response = await request('GET', `${sessionPrefix}/wda/activeAppInfo`, undefined, { signal })
      if (!isSuccess(response)) return undefined
      const active = wdaValue(response.body)
      if (!isObject(active)) return undefined
      return {
        bundleId: typeof active.bundleId === 'string' ? active.bundleId : undefined,
        pid: typeof active.pid === 'number' ? active.pid : undefined,
      }
    } catch {
      return undefined
    }
  }

  const activeAfterPin = await readActiveApp()
  if (activeAfterPin === undefined) {
    return cancelledBeforeMutation(signal) ?? resultRejected('ACTIVE_APP_MISMATCH', 'WDA active app could not be verified')
  }
  if (activeAfterPin.bundleId !== bundleId || activeAfterPin.pid !== identityAfterSetup.pid) {
    return resultRejected('ACTIVE_APP_MISMATCH', 'WDA active app does not match the requested app')
  }

  // Unique element lookup. The semantic route uses the NATIVE WDA spelling
  // `predicate string` (FBFindElementCommands.m); never the Appium-only
  // `-ios predicate string`. No fuzzy/first/index/coordinate fallback.
  let lookupResponse: WdaTargetedTextResponse
  try {
    lookupResponse = await request('POST', `${sessionPrefix}/elements`, {
      using: lookupUsing,
      value: lookupValue,
    }, { signal })
  } catch {
    return cancelledBeforeMutation(signal) ?? resultRejected('ELEMENT_LOOKUP_FAILED', 'could not query WDA for the element')
  }
  if (!isSuccess(lookupResponse)) {
    return cancelledBeforeMutation(signal) ?? resultRejected('ELEMENT_LOOKUP_FAILED', 'could not query WDA for the element')
  }
  const elementsValue = wdaValue(lookupResponse.body)
  if (!Array.isArray(elementsValue) || elementsValue.length === 0) {
    return resultRejected('ELEMENT_LOOKUP_FAILED', `${lookupSubject} matched no element`)
  }
  if (elementsValue.length !== 1) {
    return resultRejected('ELEMENT_AMBIGUOUS', `${lookupSubject} matched more than one element`)
  }
  const uuid = elementIdFromRecord(elementsValue[0])
  if (uuid === undefined) {
    return resultRejected('ELEMENT_LOOKUP_FAILED', 'the matched element did not include a native element id')
  }
  const elementPrefix = `/session/${encodeURIComponent(sid)}/element/${encodeUuid(uuid)}`

  const validateElementGuards = async (): Promise<WdaTargetedTextResult | undefined> => {
    let guards: ElementGuards | GuardObservation
    try {
      guards = await readElementGuards(request, sid, uuid, identityAttribute, signal)
    } catch {
      return cancelledBeforeMutation(signal) ?? resultRejected('ELEMENT_STALE', 'could not verify native element guards')
    }
    if (!guards.ok) {
      const observation = guards as GuardObservation
      return resultRejected(observation.code ?? 'ELEMENT_STALE', observation.reason ?? 'element did not satisfy native text guards')
    }
    const element = guards as ElementGuards
    // The native identity must still be EXACTLY the requested value at guard
    // time. The semantic route compares the native /attribute/label value;
    // it never treats WDA `name` (identifier-or-label fallback) as the label.
    if (element.identity !== expectedIdentity) {
      return resultRejected('ELEMENT_STALE', identityAttribute === 'label'
        ? 'native element label changed before mutation'
        : 'native element identifier changed before mutation')
    }
    const type = element.type
    // Native secure signal: WDA exposes no separate `secure` attribute in
    // the FBElement protocol, so the secure re-read is the native type.
    if (type === 'SecureTextField' || type === 'XCUIElementTypeSecureTextField') {
      return resultRejected('SECURE_REJECTED', 'secure native element types are not supported')
    }
    if (semantic !== undefined && type !== semantic.type) {
      return resultRejected('ELEMENT_UNSUPPORTED', 'native element type does not match the requested semantic type')
    }
    if (type === undefined || !EDITABLE_NONSECURE_TYPES.has(type)) {
      return resultRejected('ELEMENT_UNSUPPORTED', 'native element is not a known editable nonsecure type')
    }
    if (element.enabled !== true || element.visible !== true) {
      return resultRejected('ELEMENT_UNSUPPORTED', 'native element is not enabled and visible')
    }
    if (element.frame === undefined) {
      return resultRejected('ELEMENT_STALE', 'native element frame could not be read')
    }
    if (!guardFramesWithinTolerance(element.frame, expectedFrame)) {
      return resultRejected('ELEMENT_GEOMETRY_MISMATCH', 'native element frame differs from the expected target frame')
    }
    return undefined
  }

  const guardError = await validateElementGuards()
  if (guardError !== undefined) return guardError

  // Independent + WDA active rechecks immediately before mutation.
  const identityBeforeMutation = await readVerifiedIdentity(readAppIdentity, udid, signal)
  if (identityBeforeMutation === undefined) {
    return cancelledBeforeMutation(signal) ?? resultRejected('APP_IDENTITY_UNAVAILABLE', 'independent app identity could not be verified before mutation')
  }
  if (!sameBundleAndPid(identityBeforeMutation, bundleId, identityAfterSetup.pid)
    || !expectedPidMatches(expectedPID, identityBeforeMutation.pid)) {
    return resultRejected('APP_IDENTITY_MISMATCH', 'independent app identity changed before mutation')
  }
  const activeBeforeMutation = await readActiveApp()
  if (activeBeforeMutation === undefined) {
    return cancelledBeforeMutation(signal) ?? resultRejected('ACTIVE_APP_MISMATCH', 'WDA active app could not be rechecked before mutation')
  }
  if (activeBeforeMutation.bundleId !== bundleId || activeBeforeMutation.pid !== identityBeforeMutation.pid) {
    return resultRejected('ACTIVE_APP_MISMATCH', 'WDA active app changed before mutation')
  }
  const guardBeforeMutationError = await validateElementGuards()
  if (guardBeforeMutationError !== undefined) return guardBeforeMutationError

  // Mutation dispatch helpers.
  const sendMutation = async (
    path: string,
    body: unknown,
  ): Promise<{ sent: boolean; nativeAccepted: boolean; abortedOrUncertain: boolean }> => {
    try {
      const response = await request('POST', path, body, { signal })
      if (!isObject(response) || typeof response.statusCode !== 'number') {
        return { sent: true, nativeAccepted: false, abortedOrUncertain: true }
      }
      return { sent: true, nativeAccepted: isSuccess(response), abortedOrUncertain: false }
    } catch {
      return { sent: true, nativeAccepted: false, abortedOrUncertain: true }
    }
  }

  if (mode === 'replace') {
    const clear = await sendMutation(`${elementPrefix}/clear`, undefined)
    if (!clear.nativeAccepted) {
      return resultUnknown(clear.abortedOrUncertain ? 'MUTATION_DISPATCH_UNKNOWN' : 'NATIVE_REJECTED', 'clear mutation was not accepted', false)
    }
    if (text.length === 0) {
      // Empty replace = exactly one native clear and NO value call.
      return { status: 'unknown', dispatched: true, nativeAccepted: true }
    }
    const value = await sendMutation(`${elementPrefix}/value`, { value: text })
    if (!value.nativeAccepted) {
      return resultUnknown(value.abortedOrUncertain ? 'MUTATION_DISPATCH_UNKNOWN' : 'NATIVE_REJECTED', 'replace mutation could not be fully confirmed', false)
    }
    return { status: 'unknown', dispatched: true, nativeAccepted: true }
  }

  const appendValue = await sendMutation(`${elementPrefix}/value`, { value: text })
  if (!appendValue.nativeAccepted) {
    return resultUnknown(appendValue.abortedOrUncertain ? 'MUTATION_DISPATCH_UNKNOWN' : 'NATIVE_REJECTED', 'append mutation could not be confirmed', false)
  }
  return { status: 'unknown', dispatched: true, nativeAccepted: true }
}
