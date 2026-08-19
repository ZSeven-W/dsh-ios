/**
 * Browser-side wire contract for the dsh-ios simulator cards.
 *
 * Pure helpers only — nothing touches the DOM at module scope, and every
 * function exported here is safe to call from Node. The dev-card-smoke script
 * loads the built client bundle and reuses these exact functions, so the
 * bytes the smoke test sends over the WebSocket are byte-for-byte the bytes
 * the cards send in a browser.
 *
 * Contract summary (host side, see src/tools.ts + src/stream-routes.ts):
 * - `output.presentationMeta` rides into `ToolResultNode.meta` verbatim with
 *   kinds `sim-stream` | `sim-screenshot` | `sim-build-run`.
 * - `POST /_dsh/dsh-ios/grant` re-mints origin-relative capability URLs at
 *   render time; tokens expire within 10 minutes.
 * - `POST /_dsh/dsh-ios/capture` captures a fresh PNG of the current
 *   streamed/booted device and mints its relative screenshot URL.
 * - `POST /_dsh/dsh-ios/switch-device` switches which simulator the panel
 *   streams (may boot the picked device — an explicit user gesture) and
 *   mints fresh capability URLs for it.
 * - `POST /_dsh/dsh-ios/devices` lists the pickable simulators
 *   (`{ devices: [{ udid, name, runtime, state }] }`), booted first.
 * - `POST /_dsh/dsh-ios/real-start` starts (or adopts) WebDriverAgent on a
 *   physical device — the one route allowed to build/launch WDA. Answers
 *   202 immediately (a cold build takes minutes) and the panel polls
 *   `/real-device-status` until ready or a terminal coded failure.
 * - The WebSocket relay passes serve-sim HID frames through unchanged:
 *   `[tag byte][utf-8 JSON]`, tag 3 = touch `{type,x,y}` (0..1 normalized),
 *   tag 4 = hardware button `{button}`, tag 7 = rotate `{orientation}`
 *   (portrait | landscape_left | portrait_upside_down | landscape_right);
 *   serve-sim answers with screen config frames `{width,height,orientation}`
 *   on tag 130.
 * @module @zseven-w/dsh-ios/client/protocol
 */

/** Wire tool names the client registers conversation cards for. */
export const IOS_SIM_CARD_TOOLS = {
  boot: 'ios_sim_boot',
  screenshot: 'ios_sim_screenshot',
  interact: 'ios_sim_interact',
  buildRun: 'ios_sim_build_run',
  /** The explicit physical-device WDA starter (no presentationMeta; hydrated). */
  realStart: 'ios_real_start_wda',
} as const

/** The grant endpoint the cards POST to at render time. */
export const GRANT_ROUTE_PATH = '/_dsh/dsh-ios/grant'

/** The read-only stream-status endpoint the input-dock capsule polls. */
export const STATUS_ROUTE_PATH = '/_dsh/dsh-ios/status'

/** The fresh-screenshot endpoint the panel toolbar's 截图 button POSTs to. */
export const CAPTURE_ROUTE_PATH = '/_dsh/dsh-ios/capture'

/** The device-switch endpoint the panel header's device picker POSTs to. */
export const SWITCH_DEVICE_ROUTE_PATH = '/_dsh/dsh-ios/switch-device'

/** The pickable-device listing endpoint the picker refreshes on open. */
export const DEVICES_ROUTE_PATH = '/_dsh/dsh-ios/devices'

/** The real-device MJPEG proxy prefix (signed stream capabilities). */
export const REAL_STREAM_ROUTE_PREFIX = '/_dsh/dsh-ios/real-stream'

/** The real-device control endpoint (tap/drag/button/type/rotate). */
export const REAL_CONTROL_ROUTE_PATH = '/_dsh/dsh-ios/real-control'

/** The read-only WDA status endpoint the real-device panel consults. */
export const REAL_DEVICE_STATUS_ROUTE_PATH = '/_dsh/dsh-ios/real-device-status'

/** The explicit WDA start endpoint — the ONE route allowed to build/launch. */
export const REAL_START_ROUTE_PATH = '/_dsh/dsh-ios/real-start'

/** serve-sim control frame tags (observed in scripts/dev-routes-smoke.mjs). */
export const SIM_TOUCH_TAG = 3
export const SIM_BUTTON_TAG = 4
/** serve-sim rotation frame (tag 7, `{orientation}` — serve-sim 0.1.45). */
export const SIM_ROTATE_TAG = 7
/** serve-sim screen config frame (tag 130, `{width,height,orientation}`). */
export const SIM_CONFIG_TAG = 130

/** `WebSocket.OPEN` value (same for the browser API and the node `ws` client). */
export const WEB_SOCKET_OPEN = 1

/** The device summary embedded in every presentationMeta envelope. */
export interface SimDeviceInfo {
  udid?: string
  name?: string
  runtime?: string
  state?: string
}

/** One pickable simulator from the host `/devices` listing (simctl shape). */
export interface SimDeviceEntry {
  udid: string
  name: string
  runtime: string
  state: string
}

/**
 * A physical iPhone/iPad reported by `devicectl`. These are listed so the
 * picker can show what is actually plugged in, but they are NOT streamable:
 * a real device has no simctl framebuffer, so its live view needs
 * WebDriverAgent (phase B). The picker shows their state and the agent tools
 * accept their udid; the panel never tries to stream one.
 */
export interface SimRealDeviceEntry {
  udid: string
  name: string
  osVersion?: string
  model?: string
  /** devicectl's State column, e.g. `available (paired)`. */
  state: string
  connection: string
  developerMode: string
}

/** Both halves of the device listing. */
export interface SimDeviceListing {
  devices: SimDeviceEntry[]
  realDevices: SimRealDeviceEntry[]
}

/** A real device is usable by the agent tools only when it is available. */
export function simRealDeviceReady(device: SimRealDeviceEntry): boolean {
  return device.state.startsWith('available') && device.developerMode !== 'disabled'
}

export interface SimStreamMeta {
  kind: 'sim-stream'
  device: SimDeviceInfo
  streamRouteId?: string
}

export interface SimScreenshotMeta {
  kind: 'sim-screenshot'
  /** Primary path (also exposed as `path` by the host for symmetry). */
  path: string
  screenshotPath?: string
  device: SimDeviceInfo
}

export interface SimBuildRunMeta {
  kind: 'sim-build-run'
  device: SimDeviceInfo
  bundleId?: string
  appPath?: string
}

/**
 * A real device the agent explicitly started WDA on. Not streamable via the
 * simctl framebuffer: the panel's adoption path classifies this device's udid
 * against the host listing and hands it to the real-device session, which
 * then shows the not-ready/progress surface until WDA answers.
 */
export interface SimRealStartMeta {
  kind: 'sim-real-start'
  device: SimDeviceInfo
}

export type SimMeta = SimStreamMeta | SimScreenshotMeta | SimBuildRunMeta | SimRealStartMeta

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseDevice(value: unknown): SimDeviceInfo {
  if (!isRecord(value)) return {}
  return {
    ...(typeof value.udid === 'string' ? { udid: value.udid } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.runtime === 'string' ? { runtime: value.runtime } : {}),
    ...(typeof value.state === 'string' ? { state: value.state } : {}),
  }
}

/**
 * Defensively parse the presentationMeta the host projected into
 * `ToolResultNode.meta`. Unknown or malformed shapes return `undefined` and
 * the card falls back to its plain fallback UI — never a throw.
 */
export function parseSimMeta(meta: unknown): SimMeta | undefined {
  if (!isRecord(meta)) return undefined
  const device = parseDevice(meta.device)
  if (meta.kind === 'sim-stream') {
    const streamRouteId = optionalString(meta, 'streamRouteId')
    return { kind: 'sim-stream', device, ...(streamRouteId === undefined ? {} : { streamRouteId }) }
  }
  if (meta.kind === 'sim-screenshot') {
    const path = optionalString(meta, 'path') ?? optionalString(meta, 'screenshotPath')
    if (path === undefined) return undefined
    const screenshotPath = optionalString(meta, 'screenshotPath')
    return { kind: 'sim-screenshot', path, ...(screenshotPath === undefined ? {} : { screenshotPath }), device }
  }
  if (meta.kind === 'sim-build-run') {
    const bundleId = optionalString(meta, 'bundleId')
    const appPath = optionalString(meta, 'appPath')
    return {
      kind: 'sim-build-run',
      device,
      ...(bundleId === undefined ? {} : { bundleId }),
      ...(appPath === undefined ? {} : { appPath }),
    }
  }
  if (meta.kind === 'sim-real-start') {
    return { kind: 'sim-real-start', device }
  }
  return undefined
}

/** Fetch surface the cards use; injectable for tests and headless hosts. */
export type SimFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface StreamGrantResponse {
  streamUrl: string
  wsUrl: string
  expiresAt?: number
}

export interface ScreenshotGrantResponse {
  screenshotUrl: string
  expiresAt?: number
}

export type GrantFailure = { ok: false; status?: number; error: string; code?: SimRouteErrorCode }

/**
 * Stable failure reasons the routes report alongside their English `error`
 * detail. The host cannot know which language the browser shows, so the UI
 * localizes off the CODE and keeps the English text as the fallback for
 * anything unrecognized (an older host, an unmapped case).
 */
export type SimRouteErrorCode =
  | 'forbidden'
  | 'bad_method'
  | 'bad_content_type'
  | 'bad_request'
  | 'device_unknown'
  | 'device_not_booted'
  | 'device_busy'
  | 'stream_not_running'
  | 'stream_failed'
  | 'token_invalid'
  | 'screenshot_missing'
  | 'unavailable'
  | 'wda_not_running'
  | 'wda_device_locked'
  | 'wda_cert_untrusted'
  | 'wda_profile_expired'
  | 'wda_device_unplugged'
  | 'wda_build_failed'
  | 'wda_launch_timeout'
  | 'wda_tunnel_failed'
  | 'wda_not_ready'
  | 'wda_unavailable'

const ROUTE_ERROR_COPY_KEYS: Record<SimRouteErrorCode, string> = {
  forbidden: 'errForbidden',
  bad_method: 'errBadMethod',
  bad_content_type: 'errBadContentType',
  bad_request: 'errBadRequest',
  device_unknown: 'errDeviceUnknown',
  device_not_booted: 'errDeviceNotBooted',
  device_busy: 'errDeviceBusy',
  stream_not_running: 'errStreamNotRunning',
  stream_failed: 'errStreamFailed',
  token_invalid: 'errTokenInvalid',
  screenshot_missing: 'errScreenshotMissing',
  unavailable: 'errUnavailable',
  wda_not_running: 'errWdaNotRunning',
  wda_device_locked: 'errWdaDeviceLocked',
  wda_cert_untrusted: 'errWdaCertUntrusted',
  wda_profile_expired: 'errWdaProfileExpired',
  wda_device_unplugged: 'errWdaDeviceUnplugged',
  wda_build_failed: 'errWdaBuildFailed',
  wda_launch_timeout: 'errWdaLaunchTimeout',
  wda_tunnel_failed: 'errWdaTunnelFailed',
  wda_not_ready: 'errWdaNotReady',
  wda_unavailable: 'errWdaUnavailable',
}

/**
 * Localized text for a route failure: the code wins, the host's English
 * detail is the fallback. `copy` is the locale table (simCopy(locale)) —
 * passed in rather than imported so this module stays copy-agnostic.
 */
export function simRouteErrorTextOf(
  failure: { error: string; code?: string },
  copy: Record<string, string>,
): string {
  const key = failure.code === undefined ? undefined : ROUTE_ERROR_COPY_KEYS[failure.code as SimRouteErrorCode]
  const localized = key === undefined ? undefined : copy[key]
  return localized ?? failure.error
}

type GrantPostResult = { ok: true; body: Record<string, unknown> } | GrantFailure

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function postJson(
  fetcher: SimFetcher,
  path: string,
  body: unknown,
  routeLabel: string,
): Promise<GrantPostResult> {
  let response: Response
  try {
    response = await fetcher(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    return { ok: false, error: `${routeLabel} request failed: ${errorMessage(error)}` }
  }
  let value: unknown
  try {
    value = await response.json()
  } catch {
    value = undefined
  }
  if (!response.ok || !isRecord(value)) {
    const message = isRecord(value) && typeof value.error === 'string'
      ? value.error
      : `${routeLabel} endpoint returned HTTP ${response.status}`
    const code = isRecord(value) && typeof value.code === 'string' ? value.code as SimRouteErrorCode : undefined
    return { ok: false, status: response.status, error: message, ...(code === undefined ? {} : { code }) }
  }
  return { ok: true, body: value }
}

function postGrant(fetcher: SimFetcher, body: unknown): Promise<GrantPostResult> {
  return postJson(fetcher, GRANT_ROUTE_PATH, body, 'grant')
}

/**
 * The exact grant request body the stream card sends. With a udid the route
 * starts (or reuses) the stream for that device; without one it falls back to
 * the device the session is already streaming.
 */
export function streamGrantBodyOf(input: { device?: { udid?: string } }): { kind: 'sim-stream'; device?: string } {
  const udid = input.device?.udid
  return typeof udid === 'string' && udid.trim() !== ''
    ? { kind: 'sim-stream', device: udid }
    : { kind: 'sim-stream' }
}

/** POST the grant endpoint and read back the minted capability URLs. */
export async function requestStreamGrant(
  fetcher: SimFetcher,
  input: { device?: { udid?: string } },
): Promise<{ ok: true; grant: StreamGrantResponse } | GrantFailure> {
  const result = await postGrant(fetcher, streamGrantBodyOf(input))
  if (!result.ok) return result
  const streamUrl = optionalString(result.body, 'streamUrl')
  const wsUrl = optionalString(result.body, 'wsUrl')
  if (streamUrl === undefined || wsUrl === undefined) {
    return { ok: false, error: 'grant response is missing streamUrl or wsUrl' }
  }
  const expiresAt = optionalFiniteNumber(result.body, 'expiresAt')
  return { ok: true, grant: { streamUrl, wsUrl, ...(expiresAt === undefined ? {} : { expiresAt }) } }
}

/** The exact grant request body the screenshot card sends. */
export function screenshotGrantBodyOf(path: string): { kind: 'sim-screenshot'; path: string } {
  return { kind: 'sim-screenshot', path }
}/** POST the grant endpoint for one screenshot path in the plugin cache. */
export async function requestScreenshotGrant(
  fetcher: SimFetcher,
  path: string,
): Promise<{ ok: true; grant: ScreenshotGrantResponse } | GrantFailure> {
  const result = await postGrant(fetcher, screenshotGrantBodyOf(path))
  if (!result.ok) return result
  const screenshotUrl = optionalString(result.body, 'screenshotUrl')
  if (screenshotUrl === undefined) {
    return { ok: false, error: 'grant response is missing screenshotUrl' }
  }
  const expiresAt = optionalFiniteNumber(result.body, 'expiresAt')
  return { ok: true, grant: { screenshotUrl, ...(expiresAt === undefined ? {} : { expiresAt }) } }
}

/**
 * Host-side read-only stream status the input-dock capsule polls while the
 * simulator panel is closed (POST `/_dsh/dsh-ios/status`).
 */
export interface SimStreamStatus {
  running: boolean
  device?: string
  deviceName?: string
}

/**
 * POST the read-only status endpoint and defensively parse the snapshot.
 * The endpoint never boots a simulator and never mints capability tokens.
 */
export async function requestSimStatus(
  fetcher: SimFetcher,
  input: { device?: string } = {},
): Promise<SimStreamStatus> {
  const body = typeof input.device === 'string' && input.device !== ''
    ? { device: input.device }
    : {}
  const result = await postJson(fetcher, STATUS_ROUTE_PATH, body, 'status')
  if (!result.ok) return { running: false }
  return {
    running: result.body.running === true,
    ...(typeof result.body.device === 'string' && result.body.device !== '' ? { device: result.body.device } : {}),
    ...(typeof result.body.deviceName === 'string' && result.body.deviceName !== '' ? { deviceName: result.body.deviceName } : {}),
  }
}

/** A fresh capture minted by the host route. */
export interface SimCaptureResponse {
  screenshotUrl: string
  path: string
  bytes: number
  expiresAt?: number
}

/** The exact capture request body the toolbar sends (device optional). */
export function captureBodyOf(input: { device?: string }): { device?: string } {
  return typeof input.device === 'string' && input.device.trim() !== ''
    ? { device: input.device }
    : {}
}

/**
 * POST the capture endpoint and read back a freshly minted screenshot URL.
 * The route captures a NEW PNG of the current streamed (or booted) device —
 * unlike the screenshot card's grant flow, no prior presentationMeta path is
 * involved.
 */
export async function requestSimCapture(
  fetcher: SimFetcher,
  input: { device?: string } = {},
): Promise<{ ok: true; capture: SimCaptureResponse } | GrantFailure> {
  const result = await postJson(fetcher, CAPTURE_ROUTE_PATH, captureBodyOf(input), 'capture')
  if (!result.ok) return result
  const screenshotUrl = optionalString(result.body, 'screenshotUrl')
  const path = optionalString(result.body, 'path')
  const bytes = optionalFiniteNumber(result.body, 'bytes')
  if (screenshotUrl === undefined || path === undefined || bytes === undefined) {
    return { ok: false, error: 'capture response is missing screenshotUrl, path or bytes' }
  }
  const expiresAt = optionalFiniteNumber(result.body, 'expiresAt')
  return { ok: true, capture: { screenshotUrl, path, bytes, ...(expiresAt === undefined ? {} : { expiresAt }) } }
}

/**
 * Fresh capability minted by the switch-device route: grant's sim-stream
 * shape plus the switched device identity.
 */
export interface SimSwitchResponse {
  streamUrl: string
  wsUrl: string
  expiresAt?: number
  device: string
  deviceName?: string
}

/** The exact switch-device request body the panel picker sends. */
export function switchDeviceBodyOf(udid: string): { device: string } {
  return { device: udid }
}

/**
 * POST the switch-device endpoint: the host resolves the device, MAY boot it
 * (explicit pick = user gesture — the deliberate exception to grant's
 * never-boot rule), takes over the stream slot and mints fresh relative
 * capability URLs for it.
 */
export async function requestSwitchDevice(
  fetcher: SimFetcher,
  udid: string,
): Promise<{ ok: true; switched: SimSwitchResponse } | GrantFailure> {
  const result = await postJson(fetcher, SWITCH_DEVICE_ROUTE_PATH, switchDeviceBodyOf(udid), 'switch-device')
  if (!result.ok) return result
  const streamUrl = optionalString(result.body, 'streamUrl')
  const wsUrl = optionalString(result.body, 'wsUrl')
  const device = optionalString(result.body, 'device')
  if (streamUrl === undefined || wsUrl === undefined || device === undefined) {
    return { ok: false, error: 'switch-device response is missing streamUrl, wsUrl or device' }
  }
  const expiresAt = optionalFiniteNumber(result.body, 'expiresAt')
  const deviceName = optionalString(result.body, 'deviceName')
  return {
    ok: true,
    switched: {
      streamUrl,
      wsUrl,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      device,
      ...(deviceName === undefined ? {} : { deviceName }),
    },
  }
}

/**
 * POST the pickable-device listing endpoint and defensively parse the
 * `{ devices: [{ udid, name, runtime, state }] }` snapshot. Always resolves
 * to an array (empty on failure) — the picker degrades to the current device
 * and the fetch is retried on the next open. Host-side ordering (booted
 * first, then runtime descending) is preserved as-is.
 */
export async function requestSimDevices(fetcher: SimFetcher): Promise<SimDeviceListing> {
  const result = await postJson(fetcher, DEVICES_ROUTE_PATH, {}, 'devices')
  if (!result.ok || !Array.isArray(result.body.devices)) return { devices: [], realDevices: [] }
  const devices: SimDeviceEntry[] = []
  for (const entry of result.body.devices) {
    if (!isRecord(entry)) continue
    const udid = optionalString(entry, 'udid')
    const name = optionalString(entry, 'name')
    const runtime = optionalString(entry, 'runtime')
    const state = optionalString(entry, 'state')
    if (udid === undefined || name === undefined || runtime === undefined || state === undefined) continue
    devices.push({ udid, name, runtime, state })
  }
  const realDevices: SimRealDeviceEntry[] = []
  if (Array.isArray(result.body.realDevices)) {
    for (const entry of result.body.realDevices) {
      if (!isRecord(entry)) continue
      const udid = optionalString(entry, 'udid')
      const name = optionalString(entry, 'name')
      if (udid === undefined || name === undefined) continue
      realDevices.push({
        udid,
        name,
        ...(optionalString(entry, 'osVersion') === undefined ? {} : { osVersion: optionalString(entry, 'osVersion')! }),
        ...(optionalString(entry, 'model') === undefined ? {} : { model: optionalString(entry, 'model')! }),
        state: optionalString(entry, 'state') ?? 'unknown',
        connection: optionalString(entry, 'connection') ?? 'unknown',
        developerMode: optionalString(entry, 'developerMode') ?? 'unknown',
      })
    }
  }
  return { devices, realDevices }
}

// ── real-device (WDA) wire surface ──────────────────────────────────────────

/** Host-side read-only WDA status for the real-device panel. */
export interface SimRealDeviceStatus {
  running: boolean
  ready: boolean
  device?: string
  /** Machine-readable code for `reason` (SimRouteErrorCode vocabulary). */
  code?: string
  /** Classified WDA failure (device-locked / cert-untrusted / …). */
  reason?: string
  /** Human-actionable host detail for `reason`. */
  detail?: string
  /** The device's current orientation in the panel display vocabulary. */
  orientation?: string
}

/**
 * POST the read-only real-device-status endpoint and parse the snapshot.
 * Never starts anything; the panel calls it on demand (open/retry) and on
 * the bounded ~3 s cadence while a /real-start launch is in flight.
 */
export async function requestRealDeviceStatus(
  fetcher: SimFetcher,
  input: { device?: string } = {},
): Promise<SimRealDeviceStatus> {
  const body = typeof input.device === 'string' && input.device !== ''
    ? { device: input.device }
    : {}
  const result = await postJson(fetcher, REAL_DEVICE_STATUS_ROUTE_PATH, body, 'real-device-status')
  if (!result.ok) return { running: false, ready: false }
  return {
    running: result.body.running === true,
    ready: result.body.ready === true,
    ...(typeof result.body.device === 'string' && result.body.device !== '' ? { device: result.body.device } : {}),
    ...(typeof result.body.code === 'string' && result.body.code !== '' ? { code: result.body.code } : {}),
    ...(typeof result.body.reason === 'string' && result.body.reason !== '' ? { reason: result.body.reason } : {}),
    ...(typeof result.body.detail === 'string' && result.body.detail !== '' ? { detail: result.body.detail } : {}),
    ...(typeof result.body.orientation === 'string' && result.body.orientation !== '' ? { orientation: result.body.orientation } : {}),
  }
}

/** Parsed `/real-start` acknowledgement (202 accepted / 200 already up). */
export interface SimRealStartResult {
  state: 'starting' | 'running'
  device: string
  /** True when a launch for this device was ALREADY in flight (no second build). */
  alreadyStarting?: boolean
  /** True when the running state was adopted pre-existing WDA. */
  adopted?: boolean
  startedAt?: number
}

/** The exact real-start request body the panel's Start button sends. */
export function realStartBodyOf(udid: string): { device: string } {
  return { device: udid }
}

/**
 * POST the real-start endpoint: the explicit user gesture that builds or
 * adopts WebDriverAgent for one physical device. The route never hangs on
 * the build — it answers 202 accepted immediately (or 200 when WDA is
 * already running / 202 `alreadyStarting` for a launch already in flight)
 * and the caller polls requestRealDeviceStatus until ready or a terminal
 * coded failure.
 */
export async function requestRealStart(
  fetcher: SimFetcher,
  udid: string,
): Promise<{ ok: true; start: SimRealStartResult } | GrantFailure> {
  const result = await postJson(fetcher, REAL_START_ROUTE_PATH, realStartBodyOf(udid), 'real-start')
  if (!result.ok) return result
  const state = result.body.state
  if (state !== 'starting' && state !== 'running') {
    return { ok: false, error: 'real-start response is missing a state' }
  }
  const device = optionalString(result.body, 'device') ?? udid
  const startedAt = optionalFiniteNumber(result.body, 'startedAt')
  return {
    ok: true,
    start: {
      state,
      device,
      ...(result.body.alreadyStarting === true ? { alreadyStarting: true } : {}),
      ...(result.body.adopted === true ? { adopted: true } : {}),
      ...(startedAt === undefined ? {} : { startedAt }),
    },
  }
}

/** The exact real-device grant request body (shares POST /grant). */
export function realStreamGrantBodyOf(udid: string): { kind: 'real-stream'; device: string } {
  return { kind: 'real-stream', device: udid }
}

/** Fresh real-device capability: a stream URL, no ws (WDA has no control ws). */
export interface SimRealStreamGrant {
  streamUrl: string
  expiresAt?: number
  device?: string
  /** The device orientation reported at mint time (display vocabulary). */
  orientation?: string
}

/**
 * POST the grant endpoint with kind `real-stream`. The route never
 * boots/builds: it mints only when WDA is already running for the device,
 * otherwise it answers a coded 409 this parses like every other failure.
 */
export async function requestRealStreamGrant(
  fetcher: SimFetcher,
  udid: string,
): Promise<{ ok: true; grant: SimRealStreamGrant } | GrantFailure> {
  const result = await postGrant(fetcher, realStreamGrantBodyOf(udid))
  if (!result.ok) return result
  const streamUrl = optionalString(result.body, 'streamUrl')
  if (streamUrl === undefined) {
    return { ok: false, error: 'real-device grant response is missing streamUrl' }
  }
  const expiresAt = optionalFiniteNumber(result.body, 'expiresAt')
  const device = optionalString(result.body, 'device')
  const orientation = optionalString(result.body, 'orientation')
  return {
    ok: true,
    grant: {
      streamUrl,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(device === undefined ? {} : { device }),
      ...(orientation === undefined ? {} : { orientation }),
    },
  }
}

/**
 * One real-device control action. tap/drag coordinates are NORMALIZED 0..1
 * of the streamed frame (the panel's canvas space) — the host passes them
 * straight to `StreamSource.control` (the WDA adapter converts via
 * `GET /window/size`).
 */
export type SimRealControlAction =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'drag'; fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }
  | { kind: 'button'; name: string }
  | { kind: 'type'; text: string }
  | { kind: 'rotate' }

/** The exact real-control request body the panel sends. */
export function realControlBodyOf(
  device: string,
  action: SimRealControlAction,
): { device: string; action: SimRealControlAction } {
  return { device, action }
}

export interface SimRealControlResult {
  /** The new device orientation after a rotate (display vocabulary). */
  orientation?: string
}

/**
 * POST the real-control endpoint. Fails fast with the route's coded error
 * (409 when WDA is down); the panel treats control errors as non-fatal.
 */
export async function postRealControl(
  fetcher: SimFetcher,
  device: string,
  action: SimRealControlAction,
): Promise<{ ok: true; result: SimRealControlResult } | GrantFailure> {
  const result = await postJson(fetcher, REAL_CONTROL_ROUTE_PATH, realControlBodyOf(device, action), 'real-control')
  if (!result.ok) return result
  const orientation = optionalString(result.body, 'orientation')
  return { ok: true, result: { ...(orientation === undefined ? {} : { orientation }) } }
}

/** `POST /_dsh/dsh-ios/device-action` — the panel's device-menu endpoint. */
export const DEVICE_ACTION_ROUTE_PATH = '/_dsh/dsh-ios/device-action'

/**
 * Run one device-level action. The host decides the backend from `device`
 * (a physical udid goes to WebDriverAgent), so the panel only names WHAT it
 * wants; a coded failure comes back through the shared grant-failure shape
 * and the menu keeps itself open for a retry.
 */
export async function postDeviceAction(
  fetcher: SimFetcher,
  device: string | undefined,
  action: string,
): Promise<{ ok: true; kind: string } | GrantFailure> {
  const body = { action, ...(device === undefined || device === '' ? {} : { device }) }
  const result = await postJson(fetcher, DEVICE_ACTION_ROUTE_PATH, body, 'device-action')
  if (!result.ok) return result
  return { ok: true, kind: optionalString(result.body, 'kind') ?? 'simulator' }
}

/** Classified WDA failure reason → localized copy key (info surface text). */
const REAL_DEVICE_REASON_COPY_KEYS: Record<string, string> = {
  'device-locked': 'realDeviceLocked',
  'cert-untrusted': 'realDeviceCertUntrusted',
  'profile-expired': 'realDeviceProfileExpired',
  'device-unplugged': 'realDeviceUnplugged',
  'build-failed': 'realDeviceBuildFailed',
  'launch-timeout': 'realDeviceLaunchTimeout',
  'tunnel-failed': 'realDeviceTunnelFailed',
  'wda-not-ready': 'realDeviceWdaNotReady',
  unavailable: 'realDeviceWdaUnavailable',
}

/**
 * Localized, actionable text for one WDA status snapshot: the classified
 * reason wins, anything unrecognized (or a never-started WDA) reads as the
 * generic not-running message. `copy` is simCopy(locale).
 */
export function simRealDeviceReasonTextOf(
  reason: string | undefined,
  ready: boolean,
  copy: Record<string, string>,
): string {
  if (ready) return ''
  const key = reason === undefined ? undefined : REAL_DEVICE_REASON_COPY_KEYS[reason]
  if (key !== undefined && copy[key] !== undefined) return copy[key]
  return copy.realDeviceNotRunning ?? ''
}

/**
 * Encode one pointer gesture into a real-control action pair. WDA exposes
 * COMPLETE gestures only (`/wda/tap`, `/wda/dragfromtoforduration`) — there
 * is no touch begin/move/end streaming surface like the simulator's ws — so
 * the panel coalesces each pointer gesture: a still click becomes one tap,
 * a drag becomes ONE drag action whose duration is the gesture's own
 * (clamped), which WDA animates linearly from→to. See sim-real-session.ts.
 */

/** Movement below this fraction of the frame still counts as a tap. */
export const SIM_REAL_TAP_SLOP = 0.02

/** Minimum/maximum drag duration sent to WDA (seconds). */
export const SIM_REAL_DRAG_DURATION_MIN_S = 0.05
export const SIM_REAL_DRAG_DURATION_MAX_S = 2

/**
 * One gesture → one control action: tap when the pointer barely moved,
 * otherwise a single drag from anchor to release point over the (clamped)
 * gesture duration.
 */
export function simRealGestureActionOf(
  start: SimPoint,
  end: SimPoint,
  durationMs: number,
): SimRealControlAction {
  const moved = Math.hypot(end.x - start.x, end.y - start.y)
  if (moved < SIM_REAL_TAP_SLOP) return { kind: 'tap', x: end.x, y: end.y }
  const duration = Math.min(
    SIM_REAL_DRAG_DURATION_MAX_S,
    Math.max(SIM_REAL_DRAG_DURATION_MIN_S, durationMs / 1000),
  )
  return {
    kind: 'drag',
    fromX: start.x,
    fromY: start.y,
    toX: end.x,
    toY: end.y,
    durationMs: Math.round(duration * 1000),
  }
}

/**
 * Encode one serve-sim control frame: `[tag byte][utf-8 JSON]`. This is the
 * exact encoding the relay forwards to serve-sim's HID channel
 * (scripts/dev-routes-smoke.mjs `sendHidFrame`).
 */
export function encodeSimControlFrame(tag: number, payload: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload))
  const frame = new Uint8Array(1 + json.length)
  frame[0] = tag
  frame.set(json, 1)
  return frame
}

export interface SimPoint {
  x: number
  y: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** One touch frame (tag 3): begin/move/end at normalized 0..1 coordinates. */
export function simTouchFrame(type: 'begin' | 'move' | 'end', x: number, y: number): Uint8Array {
  return encodeSimControlFrame(SIM_TOUCH_TAG, { type, x: clamp01(x), y: clamp01(y) })
}

/** One hardware-button frame (tag 4), e.g. `home`. */
export function simButtonFrame(name: string): Uint8Array {
  return encodeSimControlFrame(SIM_BUTTON_TAG, { button: name })
}

/** Orientations serve-sim accepts for the rotation frame (serve-sim 0.1.45
 * `serve-sim rotate`, clockwise cycle from portrait). */
export const SIM_ROTATE_ORIENTATIONS = [
  'portrait',
  'landscape_left',
  'portrait_upside_down',
  'landscape_right',
] as const

export type SimRotateOrientation = typeof SIM_ROTATE_ORIENTATIONS[number]

/** The next orientation in the clockwise cycle, from the current one
 * (unknown/undefined starts from portrait → landscape_left). */
export function nextSimRotateOrientation(current: string | undefined): SimRotateOrientation {
  const normalized = (SIM_ROTATE_ORIENTATIONS as readonly string[]).includes(current ?? '')
    ? current as SimRotateOrientation
    : 'portrait'
  const index = SIM_ROTATE_ORIENTATIONS.indexOf(normalized)
  return SIM_ROTATE_ORIENTATIONS[(index + 1) % SIM_ROTATE_ORIENTATIONS.length]!
}

/** One rotation frame (tag 7), e.g. `landscape_left`. */
export function simRotateFrame(orientation: string): Uint8Array {
  return encodeSimControlFrame(SIM_ROTATE_TAG, { orientation })
}

/** The screen config serve-sim broadcasts over the control ws (tag 130). */
export interface SimScreenConfig {
  width: number
  height: number
  orientation: string
}

function webSocketMessageBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return new TextEncoder().encode(data)
  return undefined
}

/**
 * Defensively parse a serve-sim config frame (tag 130) into its
 * `{ width, height, orientation }` snapshot; any other frame or malformed
 * payload resolves undefined (never a throw).
 */
export function parseSimConfigFrame(data: unknown): SimScreenConfig | undefined {
  const bytes = webSocketMessageBytes(data)
  if (bytes === undefined || bytes.length < 2 || bytes[0] !== SIM_CONFIG_TAG) return undefined
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(1)))
    if (
      isRecord(value)
      && typeof value.width === 'number'
      && Number.isFinite(value.width)
      && typeof value.height === 'number'
      && Number.isFinite(value.height)
      && typeof value.orientation === 'string'
      && value.orientation !== ''
    ) {
      return { width: value.width, height: value.height, orientation: value.orientation }
    }
  } catch {
    // malformed config JSON
  }
  return undefined
}

/**
 * The exact two frames the stream card sends for a stationary click: a
 * `begin` on pointer-down and an `end` on pointer-up. A drag adds `move`
 * frames between them; serve-sim itself classifies the gesture as a tap.
 */
export function simTapFrames(x: number, y: number): Uint8Array[] {
  return [simTouchFrame('begin', x, y), simTouchFrame('end', x, y)]
}

/** Resolve an origin-relative `wsUrl` from the grant into an absolute one. */
export function resolveWsUrl(relative: string, location: { protocol: string; host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}${relative}`
}

/** Map a pointer event on an element to normalized 0..1 stream coordinates. */
export function normalizePointerPoint(
  event: { clientX: number; clientY: number },
  bounds: { left: number; top: number; width: number; height: number },
): SimPoint {
  const width = bounds.width > 0 ? bounds.width : 1
  const height = bounds.height > 0 ? bounds.height : 1
  return {
    x: clamp01((event.clientX - bounds.left) / width),
    y: clamp01((event.clientY - bounds.top) / height),
  }
}

/** The WebSocket surface the cards need (satisfied by the browser API). */
export interface SimWebSocketLike {
  readonly readyState: number
  /** Binary delivery mode — 'arraybuffer' so config frames arrive as bytes. */
  binaryType: string
  send(data: Uint8Array | ArrayBuffer | string): void
  close(): void
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
}

/** Injectable WebSocket constructor; defaults to the browser `WebSocket`. */
export type SimWsFactory = (url: string) => SimWebSocketLike

/** Default factory — only ever called from a mounted effect in a browser. */
export function openBrowserSimWebSocket(url: string): SimWebSocketLike {
  const ws = new WebSocket(url) as unknown as SimWebSocketLike
  ws.binaryType = 'arraybuffer'
  return ws
}
