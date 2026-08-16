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
} as const

/** The grant endpoint the cards POST to at render time. */
export const GRANT_ROUTE_PATH = '/_dsh/dsh-ios/grant'

/** The read-only stream-status endpoint the input-dock capsule polls. */
export const STATUS_ROUTE_PATH = '/_dsh/dsh-ios/status'

/** The fresh-screenshot endpoint the panel toolbar's 截图 button POSTs to. */
export const CAPTURE_ROUTE_PATH = '/_dsh/dsh-ios/capture'

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

export type SimMeta = SimStreamMeta | SimScreenshotMeta | SimBuildRunMeta

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

export type GrantFailure = { ok: false; status?: number; error: string }

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
    return { ok: false, status: response.status, error: message }
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
