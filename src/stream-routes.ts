/**
 * Signed web-route layer for the dsh-ios live simulator stream.
 *
 * The browser never talks to serve-sim's own 127.0.0.1 port. Everything
 * crosses the DSH webserver origin through plugin-owned routes under
 * `/_dsh/dsh-ios/`:
 *
 * - `GET  /stream/<token>`    — proxies serve-sim's `multipart/x-mixed-replace`
 *   stream body unchanged for as long as the client keeps the response open.
 * - `GET  /screenshot/<token>` — serves one PNG from the plugin's screenshot
 *   cache directory (absolute paths outside it are refused).
 * - WS    `/ws?token=…`       — relays binary HID frames bidirectionally to
 *   serve-sim's control channel (`[tag, json]` frames, tags 3/4/6/7/…).
 * - `POST /grant`             — loopback/trusted-only JSON endpoint that the
 *   client card calls at render time to re-mint fresh capabilities from its
 *   stable presentationMeta. Never boots a simulator; it only starts a
 *   stream for a device that is already booted.
 * - `POST /switch-device`     — loopback/trusted-only JSON endpoint the panel
 *   header's device picker calls to switch which simulator the panel
 *   streams. DELIBERATE EXCEPTION to grant's never-boot rule: picking a
 *   device is an explicit user gesture, which authorizes booting it here
 *   (`bootDevice` when the device is not booted) before `ensureRunning`
 *   takes over the stream slot (its existing device-switch logic retires
 *   the old stream; its launch queue serializes launches). The device must
 *   exist and be available or the route answers 409. Returns grant's
 *   sim-stream shape plus `{ device, deviceName }`.
 * - `POST /devices`           — read-only loopback/trusted-only JSON endpoint
 *   listing the pickable simulators for the picker (`{ devices: [{ udid,
 *   name, runtime, state }] }`, booted first then runtime descending,
 *   capped). Never boots, never starts a stream, never mints tokens.
 * - `POST /capture`           — loopback/trusted-only JSON endpoint the panel
 *   toolbar's 截图 button calls: captures a FRESH PNG of the current
 *   streamed (or explicitly booted) device into the tools' screenshot cache
 *   via `simctl io … screenshot` and mints a signed relative screenshot URL.
 *   Never boots a simulator.
 * - `POST /status`            — read-only loopback/trusted-only JSON endpoint
 *   that reports whether the sim host is streaming (`{ running, device?,
 *   deviceName? }`). It NEVER calls `ensureRunning`, never boots a simulator
 *   and never mints capability tokens — the input-dock capsule polls it.
 * - `GET  /real-stream/<token>` — proxies the WDA MJPEG stream of a physical
 *   device (the `mjpegUrl` behind the iproxy USB tunnel) exactly like the
 *   simulator stream proxy: same fence, same teardown tracking, upstream
 *   CORS never forwarded. The WDA port is never exposed to the browser. A
 *   `sim-real-stream` capability only proxies a device whose WDA is ALREADY
 *   running — this route never spawns xcodebuild (start WDA via /real-start
 *   first).
 * - `POST /real-control`      — loopback/trusted-only JSON endpoint carrying
 *   `{ device, action }` where action is tap/drag (NORMALIZED 0..1 panel
 *   coordinates — passed straight to `StreamSource.control`), button, type
 *   or rotate (advances the WDA orientation cycle). Unknown actions answer
 *   a coded 400.
 * - `POST /real-device-status` — read-only `{ running, ready, device,
 *   code?, reason?, detail?, orientation? }` from `WdaController.status()`
 *   so the panel can show WHY WDA is down (locked / untrusted / expired /
 *   unplugged) instead of a dead player. `code` is the machine-readable
 *   `wdaReasonErrorCodeOf` mapping of `reason`. Never starts anything.
 * - `POST /real-start`         — loopback/trusted-only JSON endpoint carrying
 *   `{ device }`: starts (or adopts) WebDriverAgent on one physical device
 *   via `WdaController.ensureRunning({udid})`. DELIBERATE EXCEPTION to
 *   grant's never-build rule — the real-device twin of /switch-device's
 *   never-boot exception: pressing the panel's Start button (or running the
 *   `ios_real_start_wda` tool) is an explicit user gesture, which authorizes
 *   the `xcodebuild … test` launch here, and this is the ONLY route that
 *   may do so. A cold build can take minutes, so the route answers 202
 *   (accepted) immediately and the panel polls /real-device-status until
 *   ready or a terminal coded failure; a second start for the same device
 *   while one is in flight reports `alreadyStarting` and never spawns a
 *   second build (the controller's launch queue is shared, and the route
 *   keeps its own per-device in-flight fence).
 *
 * Real-device capability minting lives on the SAME `/grant` endpoint (kind
 * `real-stream`): one capability surface, one fence, one client call shape.
 * The real-device kind NEVER boots/builds — it only mints for a device whose
 * WDA is already running; when WDA is down it answers a coded 409 the panel
 * maps to an actionable message (the panel's own Start button POSTs
 * /real-start — or the ios_real_start_wda tool runs — to bring WDA up).
 * `/capture` likewise gains a WDA branch:
 * when the target udid is the WDA host's device, the PNG comes from WDA's
 * own screenshot API instead of simctl (never boots anything either way).
 *
 * Tokens are HMAC-SHA256 capabilities: `base64url(payload).base64url(mac)`.
 * The key is a 32-byte per-DSH-home file (`<DSH_HOME>/cache/dsh-ios/
 * stream-access.key`, 0600, created atomically) — the same scheme as
 * dsh-openpencil's render capabilities. Tokens expire after at most 10
 * minutes. Host/Origin headers are caller-controlled data: every route also
 * applies the loopback/trusted transport fence (peer address, Host hostname,
 * Fetch-Metadata/Origin) before any capability is consulted, so a LAN client
 * cannot spoof localhost and a DNS-rebinding Host is rejected. serve-sim's
 * real port never appears in anything sent to the browser.
 *
 * Routes are registered once, inside `ctx.inject(['webServer'], …)` +
 * `ctx.effect`, so headless profiles (no webServer) still load and disposal
 * unregisters the routes and tears down every open stream/relay.
 * @module @zseven-w/dsh-ios/stream-routes
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SimHostController, SimStreamInfo } from './sim-host.js'
import {
  bootDevice,
  bootedDevices,
  compareRuntimesDesc,
  listDevices,
  takeScreenshot,
  type SimulatorDevice,
} from './simctl.js'
import { listRealDevices } from './devicectl.js'
import { DEVICE_ACTIONS, deviceActionSpec, isDeviceAction } from './device-actions.js'
import { SimStreamSource, WdaStreamSource, type WdaControllerLike } from './stream-source.js'
import { CONTROL_PORT_START as DEFAULT_CONTROL_PORT, probeWdaControlTunnel } from './wda-host.js'

/** HTTP prefix owned by the dsh-ios web routes. */
export const PLUGIN_ROUTE_PREFIX = '/_dsh/dsh-ios'
export const STREAM_ROUTE_PREFIX = `${PLUGIN_ROUTE_PREFIX}/stream`
export const SCREENSHOT_ROUTE_PREFIX = `${PLUGIN_ROUTE_PREFIX}/screenshot`
export const WS_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/ws`
/** `POST` — run one device-level action (App Switcher, lock, Siri, …). */
export const DEVICE_ACTION_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/device-action`
export const GRANT_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/grant`
export const SWITCH_DEVICE_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/switch-device`
export const DEVICES_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/devices`
export const CAPTURE_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/capture`
export const STATUS_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/status`
export const REAL_STREAM_ROUTE_PREFIX = `${PLUGIN_ROUTE_PREFIX}/real-stream`
export const REAL_CONTROL_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/real-control`
export const REAL_DEVICE_STATUS_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/real-device-status`
export const REAL_START_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/real-start`

/** Hard capability lifetime (spec: tokens expire within 10 minutes). */
export const TOKEN_TTL_MS = 10 * 60 * 1000

const KEY_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const MAX_TOKEN_LENGTH = 16 * 1024
const UDID_PATTERN = /^[0-9A-Za-z-]{8,128}$/
/** Signing may run ahead of verification by this much before the TTL cap trips. */
const CLOCK_SKEW_MS = 60 * 1000
const MAX_GRANT_BODY_BYTES = 16 * 1024
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024
const MAX_PENDING_WS_FRAMES = 256
/** Cap on the pickable-device listing (~40, per the picker spec). */
const MAX_PICKABLE_DEVICES = 40

interface StreamTokenPayload {
  v: 1
  kind: 'sim-stream'
  udid: string
  exp: number
}

interface RealStreamTokenPayload {
  v: 1
  kind: 'sim-real-stream'
  udid: string
  exp: number
}

interface ScreenshotTokenPayload {
  v: 1
  kind: 'sim-screenshot'
  path: string
  exp: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStreamPayload(value: unknown): StreamTokenPayload | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.v !== 1
    || value.kind !== 'sim-stream'
    || typeof value.udid !== 'string'
    || !UDID_PATTERN.test(value.udid)
    || typeof value.exp !== 'number'
    || !Number.isSafeInteger(value.exp)
  ) return undefined
  return { v: 1, kind: 'sim-stream', udid: value.udid, exp: value.exp }
}

function parseRealStreamPayload(value: unknown): RealStreamTokenPayload | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.v !== 1
    || value.kind !== 'sim-real-stream'
    || typeof value.udid !== 'string'
    || !UDID_PATTERN.test(value.udid)
    || typeof value.exp !== 'number'
    || !Number.isSafeInteger(value.exp)
  ) return undefined
  return { v: 1, kind: 'sim-real-stream', udid: value.udid, exp: value.exp }
}

function parseScreenshotPayload(value: unknown): ScreenshotTokenPayload | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.v !== 1
    || value.kind !== 'sim-screenshot'
    || typeof value.path !== 'string'
    || !isAbsolute(value.path)
    || typeof value.exp !== 'number'
    || !Number.isSafeInteger(value.exp)
  ) return undefined
  return { v: 1, kind: 'sim-screenshot', path: value.path, exp: value.exp }
}

function dshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  return env === undefined || env.length === 0 ? join(homedir(), '.dsh') : resolve(env)
}

/** Plugin-managed state root (mirrors the dsh-openpencil convention). */
export function stateRoot(): string {
  return join(dshHome(), 'cache', 'dsh-ios')
}

/**
 * Screenshot cache: the only directory the screenshot route will serve.
 * Mirrors the sim tools' default capture root (`<tmp>/dsh-ios/screenshots`,
 * see tools.ts ScreenshotStore) so every `ios_sim_screenshot` output can be
 * granted a capability without further configuration. The signing key lives
 * under the DSH home regardless.
 */
export function screenshotDir(): string {
  return join(tmpdir(), 'dsh-ios', 'screenshots')
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readKeyFile(path: string): Promise<Buffer> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('dsh-ios stream access key is not a regular file')
  const key = await readFile(path)
  if (key.length !== KEY_BYTES) throw new Error('dsh-ios stream access key has an invalid length')
  return key
}

/** Load or atomically create the per-DSH-home signing key (0600). */
export async function prepareStreamAccessKey(): Promise<Buffer> {
  await mkdir(stateRoot(), { recursive: true, mode: 0o700 })
  const path = join(stateRoot(), 'stream-access.key')
  try {
    return await readKeyFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const candidate = randomBytes(KEY_BYTES)
  try {
    await writeFile(path, candidate, { flag: 'wx', mode: 0o600 })
    return candidate
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return readKeyFile(path)
  }
}

/** HMAC capability encoder/verifier for stream, control and screenshot URLs. */
export class StreamAccessController {
  #routeCount = 0
  #keyPromise: Promise<Buffer> | undefined

  constructor(private readonly resolveKey: () => Promise<Buffer> = prepareStreamAccessKey) {}

  /** Whether at least one HTTP carrier currently owns the routes. */
  get routeAvailable(): boolean {
    return this.#routeCount > 0
  }

  /** Mark one route attachment; the returned disposer removes that attachment. */
  attachRoute(): () => void {
    this.#routeCount += 1
    let active = true
    return () => {
      if (!active) return
      active = false
      this.#routeCount -= 1
    }
  }

  /** Mint a stream/control capability for one simulator device. */
  async signStreamToken(udid: string, options: { ttlMs?: number } = {}): Promise<{ token: string; expiresAt: number }> {
    if (!UDID_PATTERN.test(udid)) throw new TypeError('dsh-ios: signStreamToken requires a simulator udid')
    return this.#sign({ v: 1, kind: 'sim-stream', udid, exp: Date.now() + this.#ttl(options.ttlMs) })
  }

  /** Mint a real-device MJPEG capability for one physical device. */
  async signRealStreamToken(udid: string, options: { ttlMs?: number } = {}): Promise<{ token: string; expiresAt: number }> {
    if (!UDID_PATTERN.test(udid)) throw new TypeError('dsh-ios: signRealStreamToken requires a real-device udid')
    return this.#sign({ v: 1, kind: 'sim-real-stream', udid, exp: Date.now() + this.#ttl(options.ttlMs) })
  }

  /** Mint a screenshot capability for one absolute path in the cache dir. */
  async signScreenshotToken(path: string, options: { ttlMs?: number } = {}): Promise<{ token: string; expiresAt: number }> {
    if (!isAbsolute(path)) throw new TypeError('dsh-ios: signScreenshotToken requires an absolute path')
    return this.#sign({ v: 1, kind: 'sim-screenshot', path, exp: Date.now() + this.#ttl(options.ttlMs) })
  }

  /** Verify and decode one stream capability without touching the filesystem. */
  verifyStreamToken(token: string): Promise<StreamTokenPayload | undefined> {
    return this.#verify(token, parseStreamPayload)
  }

  /** Verify and decode one real-device stream capability (no filesystem). */
  verifyRealStreamToken(token: string): Promise<RealStreamTokenPayload | undefined> {
    return this.#verify(token, parseRealStreamPayload)
  }

  /** Verify and decode one screenshot capability without touching the filesystem. */
  verifyScreenshotToken(token: string): Promise<ScreenshotTokenPayload | undefined> {
    return this.#verify(token, parseScreenshotPayload)
  }

  #ttl(ttlMs: number | undefined): number {
    if (ttlMs === undefined) return TOKEN_TTL_MS
    if (!Number.isFinite(ttlMs)) return TOKEN_TTL_MS
    return Math.min(TOKEN_TTL_MS, Math.max(1, Math.floor(ttlMs)))
  }

  #key(): Promise<Buffer> {
    this.#keyPromise ??= this.resolveKey()
    return this.#keyPromise
  }

  async #sign(payload: StreamTokenPayload | RealStreamTokenPayload | ScreenshotTokenPayload): Promise<{ token: string; expiresAt: number }> {
    const key = await this.#key()
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return { token: `${encoded}.${mac(key, encoded).toString('base64url')}`, expiresAt: payload.exp }
  }

  async #verify<Payload>(token: string, parse: (value: unknown) => Payload | undefined): Promise<Payload | undefined> {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) return undefined
    const [encoded, signature] = token.split('.')
    if (encoded === undefined || signature === undefined) return undefined
    const key = await this.#key().catch(() => undefined)
    if (key === undefined) return undefined
    let supplied: Buffer
    try {
      supplied = Buffer.from(signature, 'base64url')
    } catch {
      return undefined
    }
    if (!safeEqual(mac(key, encoded), supplied)) return undefined
    try {
      const payload = parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
      if (payload === undefined) return undefined
      const now = Date.now()
      const expiresAt = (payload as { exp?: unknown }).exp
      if (typeof expiresAt !== 'number' || expiresAt <= now) return undefined
      if (expiresAt - now > TOKEN_TTL_MS + CLOCK_SKEW_MS) return undefined
      return payload
    } catch {
      return undefined
    }
  }
}

// ── loopback / trusted-browser transport fence ───────────────────────────────

function isIpv4LoopbackAddress(address: string): boolean {
  const parts = address.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Trust the transport peer, never forwarded or caller-controlled host data.
 * Node may expose an IPv4 peer either directly or as an IPv4-mapped IPv6
 * address, including the compact hexadecimal form used by some platforms.
 */
export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().split('%', 1)[0]!
  if (normalized === '::1' || isIpv4LoopbackAddress(normalized)) return true
  if (!normalized.startsWith('::ffff:')) return false
  const mapped = normalized.slice('::ffff:'.length)
  if (isIpv4LoopbackAddress(mapped)) return true
  const hexadecimal = /^([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(mapped)
  return hexadecimal !== null && (Number.parseInt(hexadecimal[1]!, 16) >>> 8) === 127
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  return isIpv4LoopbackAddress(hostname)
}

function requestAuthority(req: IncomingMessage): URL | undefined {
  const host = req.headers.host
  if (typeof host !== 'string') return undefined
  try {
    const parsed = new URL(`http://${host}`)
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

/** Reject remote peers and DNS-rebinding Host headers before serving data. */
function isLoopbackRequest(req: IncomingMessage): boolean {
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) return false
  const authority = requestAuthority(req)
  return authority !== undefined && isLoopbackHostname(authority.hostname)
}

/** Apply Fetch-Metadata/Origin checks; mutations require an Origin. */
function isTrustedBrowserRequest(req: IncomingMessage, requireOrigin: boolean): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return !requireOrigin
  if (typeof origin !== 'string') return false
  const authority = requestAuthority(req)
  if (authority === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host === authority.host
  } catch {
    return false
  }
}

/**
 * The transport fence applied to every dsh-ios route (mirrors dsh-noema's
 * status route: loopback peer + loopback Host, plus Fetch-Metadata/Origin).
 */
function isTrustedRequest(req: IncomingMessage, requireOrigin: boolean): boolean {
  return isLoopbackRequest(req) && isTrustedBrowserRequest(req, requireOrigin)
}

function isJsonRequest(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type']
  return typeof contentType === 'string' && /^application\/json(?:\s*;|$)/i.test(contentType)
}

/**
 * Stable, machine-readable reasons for a refused route call. The English
 * `message` stays the developer-facing detail; the UI localizes off the CODE
 * (host code has no idea which language the browser is showing, so the
 * translation has to happen client-side — see simRouteErrorTextOf).
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

class RouteError extends Error {
  constructor(readonly status: number, message: string, readonly code: SimRouteErrorCode = 'unavailable') {
    super(message)
    this.name = 'RouteError'
  }
}

// ── real-device (WDA) vocabulary bridges ─────────────────────────────────────

/**
 * The clockwise orientation cycle WDA's `/orientation` values follow
 * (`PORTRAIT → LANDSCAPELEFT → PORTRAIT_UPSIDEDOWN → LANDSCAPERIGHT`) —
 * the same cycle serve-sim's rotate frame walks, so the panel's Rotate
 * button behaves identically for both kinds.
 */
export const WDA_ORIENTATION_CYCLE = [
  'PORTRAIT',
  'LANDSCAPELEFT',
  'PORTRAIT_UPSIDEDOWN',
  'LANDSCAPERIGHT',
] as const

/**
 * Map a WDA `/orientation` value onto the panel's display vocabulary
 * (the serve-sim rotation set the counter-rotation path understands).
 * `UIDeviceOrientationLandscapeLeft` (top edge pointing left) is the same
 * physical rotation as serve-sim's `landscape_left`, so the existing
 * ±90°/180° display math in sim-orientation.ts applies unchanged.
 */
export function displayOrientationFromWda(value: string | undefined): string {
  switch ((value ?? '').toUpperCase().replace(/[^A-Z_]/g, '')) {
    case 'LANDSCAPELEFT': return 'landscape_left'
    case 'LANDSCAPERIGHT': return 'landscape_right'
    case 'PORTRAIT_UPSIDEDOWN': return 'portrait_upside_down'
    default: return 'portrait'
  }
}

/** The next orientation in the WDA clockwise cycle (unknown → PORTRAIT first). */
export function nextWdaOrientation(current: string | undefined): string {
  const normalized = (current ?? '').toUpperCase().replace(/[^A-Z_]/g, '')
  const index = WDA_ORIENTATION_CYCLE.findIndex(name => name === normalized)
  if (index < 0) return WDA_ORIENTATION_CYCLE[0]
  return WDA_ORIENTATION_CYCLE[(index + 1) % WDA_ORIENTATION_CYCLE.length]!
}

/**
 * Structural face of `WdaController` the real-device routes use (the
 * controller satisfies it as-is). It is `WdaControllerLike` (the
 * `WdaStreamSource` adapter contract, whose `control.tap/drag` speak
 * NORMALIZED 0..1 coordinates) plus the two WDA-specific reads the routes
 * genuinely need beyond the generic `StreamSource` contract: the classified
 * failure `reason`/`detail` for the status/grant 409s, and
 * `getOrientation` so the `rotate` action can advance the cycle.
 */
export interface WdaRouteHost extends WdaControllerLike {
  status(): {
    available: boolean
    running: boolean
    reason?: string
    detail?: string
    device?: string
    /** The in-flight/just-failed target while no runner is live — the only
     * way a torn-down failure stays addressable by the device that asked. */
    pendingDevice?: string
    hardwareUdid?: string
    controlUrl?: string
    mjpegUrl?: string
    sessionId?: string
    consumers: number
    lastError?: string
    /** True when a pre-existing WDA was adopted instead of spawned. */
    adopted?: boolean
  }
  /** Respawn a dead MJPEG forwarder without rebuilding the runner. */
  repairStreamTunnel?(): Promise<boolean>
  readonly control: WdaControllerLike['control'] & {
    getOrientation(): Promise<string>
  }
}

/** Route-level code for one WDA status snapshot: the classified failure
 * wins; a never-attempted/down host reports `wda_not_running`. */
export function wdaReasonErrorCodeOf(status: {
  running: boolean
  reason?: string
}): SimRouteErrorCode {
  if (status.running) return 'unavailable'
  switch (status.reason) {
    case 'device-locked': return 'wda_device_locked'
    case 'cert-untrusted': return 'wda_cert_untrusted'
    case 'profile-expired': return 'wda_profile_expired'
    case 'device-unplugged': return 'wda_device_unplugged'
    case 'build-failed': return 'wda_build_failed'
    case 'launch-timeout': return 'wda_launch_timeout'
    case 'tunnel-failed': return 'wda_tunnel_failed'
    case 'wda-not-ready': return 'wda_not_ready'
    case 'unavailable': return 'wda_unavailable'
    default: return 'wda_not_running'
  }
}

/**
 * One `/real-start` launch tracked by the route. `starting` while the
 * background `ensureRunning` is in flight (the "already starting" fence);
 * a settled failure stays as `failed` (with its coded error) until the next
 * start for the device overwrites it — a diagnostic view the smoke and the
 * panel can consult, and the terminal coded failure the poll flow reports.
 */
export interface RealStartRecord {
  state: 'starting' | 'failed'
  udid: string
  startedAt: number
  /** Classified failure of the settled launch (code + host detail). */
  error?: { code: SimRouteErrorCode; detail?: string }
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(body)
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const contentLength = req.headers['content-length']
  if (typeof contentLength === 'string') {
    const declared = Number(contentLength)
    if (!Number.isSafeInteger(declared) || declared < 0) throw new RouteError(400, 'invalid content-length', 'bad_request')
    if (declared > maxBytes) throw new RouteError(413, 'request body is too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new RouteError(413, 'request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function prefixToken(rawUrl: string | undefined, prefix: string): string | undefined {
  let pathname: string
  try {
    pathname = new URL(rawUrl ?? '/', 'http://dsh.local').pathname
  } catch {
    return undefined
  }
  const marker = `${prefix}/`
  if (!pathname.startsWith(marker)) return undefined
  const rest = pathname.slice(marker.length)
  if (rest === '' || rest.includes('/')) return undefined
  try {
    return decodeURIComponent(rest)
  } catch {
    return undefined
  }
}

type ScreenshotVerdict = 'ok' | 'outside' | 'missing'

/**
 * Walk `path` from the screenshot cache root with `lstat` (refusing any
 * symbolic link) and finish with a `realpath` containment check. The root
 * directory is created on demand — it is the plugin's own cache.
 */
async function classifyScreenshotPath(path: string): Promise<ScreenshotVerdict> {
  const root = screenshotDir()
  await mkdir(root, { recursive: true, mode: 0o700 }).catch(() => {})
  if (!isAbsolute(path)) return 'outside'
  const rel = relative(root, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'outside'
  let current = root
  const parts = rel.split(sep)
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part === undefined || part.length === 0 || part === '.' || part === '..') return 'outside'
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      return 'missing'
    }
    if (info.isSymbolicLink()) return 'outside'
    const final = index === parts.length - 1
    if (final ? !info.isFile() : !info.isDirectory()) return 'missing'
  }
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)])
  const relReal = relative(realRoot, realFile)
  if (relReal === '..' || relReal.startsWith(`..${sep}`) || isAbsolute(relReal)) return 'outside'
  return 'ok'
}

/**
 * Open the verified screenshot file with `O_NOFOLLOW` and read it, bound to
 * `MAX_SCREENSHOT_BYTES`. Re-validates containment so a file swapped for a
 * symlink (or moved) between minting and fetching is never served.
 */
async function openVerifiedScreenshot(path: string): Promise<{ bytes: Buffer } | undefined> {
  const verdict = await classifyScreenshotPath(path)
  if (verdict !== 'ok') return undefined
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const handle = await open(path, fsConstants.O_RDONLY | noFollow).catch(() => undefined)
  if (handle === undefined) return undefined
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > MAX_SCREENSHOT_BYTES) return undefined
    const bytes = await handle.readFile()
    if (await classifyScreenshotPath(path) !== 'ok') return undefined
    return { bytes }
  } finally {
    await handle.close().catch(() => {})
  }
}

// ── fresh capture paths (share the tools' screenshot cache) ─────────────────

/** Next stable per-device capture index, mirroring the tools' ScreenshotStore
 * naming (`screenshot-<udid>-<n>.png`) so route captures and tool captures
 * share one directory without colliding. */
const captureNextIndex = new Map<string, number>()

/** The next capture path for `udid` inside the tools' screenshot cache dir. */
async function nextCapturePath(udid: string): Promise<string> {
  const root = screenshotDir()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const safe = udid.replace(/[^A-Za-z0-9_-]/g, '_')
  let next = captureNextIndex.get(safe)
  if (next === undefined) {
    next = 0
    const prefix = `screenshot-${safe}-`
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.png')) continue
      const index = Number(entry.slice(prefix.length, -4))
      if (Number.isInteger(index) && index >= next) next = index + 1
    }
  }
  const path = join(root, `screenshot-${safe}-${next}.png`)
  captureNextIndex.set(safe, next + 1)
  return path
}

// ── ws relay (message-level, no compression on either side) ──────────────────

const WEBSOCKET_KEY_PATTERN = /^[+/0-9A-Za-z]{22}==$/

interface WsClientLike {
  readonly readyState: number
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: Buffer | string, isBinary: boolean) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  send(data: Buffer): void
  close(): void
  terminate(): void
}

interface WsServerLike {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (client: WsClientLike) => void): void
}

interface WsModuleLike {
  WebSocket: {
    new (url: string, options?: { perMessageDeflate?: boolean }): WsClientLike
    readonly OPEN: number
  }
  WebSocketServer: new (options: { noServer: boolean; perMessageDeflate?: boolean }) => WsServerLike
}

const requireWs = createRequire(import.meta.url)

/**
 * Load the `ws` package lazily (it resolves from the DSH profile node_modules
 * via the plugin's node_modules symlink — the harness connection package
 * ships it). Lazy so headless profiles without the webserver never touch it.
 */
function loadWs(): WsModuleLike {
  return requireWs('ws') as WsModuleLike
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return
  const reason = (
    { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway', 503: 'Service Unavailable' } as Record<number, string>
  )[status] ?? 'Error'
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

// ── route handlers ────────────────────────────────────────────────────────────

/** Minimal structural face of the webserver service (also lets the smoke
 * script mount the same handlers on a plain node:http server). */
export interface StreamRouteMount {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
}

/**
 * Owns the plugin's signed routes: verifies capabilities, proxies the
 * serve-sim stream and control channel, and tracks every open response or
 * relay so disposal can destroy them all.
 */
export class StreamRoutes {
  #disposed = false
  readonly #streamTeardowns = new Set<() => void>()
  readonly #wsTeardowns = new Set<() => void>()
  /** Real-device control surface (normalized 0..1 panel coordinates). */
  readonly #realSource: WdaStreamSource | undefined
  /**
   * In-flight/settled `/real-start` launches per device. A second start for
   * the same device while one is in flight answers "already starting"
   * instead of kicking the controller again — the controller's own shared
   * launch queue already serializes, this fence makes the state observable
   * for a prompt HTTP answer.
   */
  readonly #realStarts = new Map<string, RealStartRecord>()
  /** Background launch promises, held so nothing is garbage-collected early. */
  readonly #realLaunchPromises = new Set<Promise<void>>()

  /** The simulator half of the shared stream-source contract (control only:
   * streaming still goes through simHost's own serve-sim plumbing). */
  readonly #simSource: SimStreamSource

  constructor(
    readonly simHost: SimHostController,
    readonly access: StreamAccessController,
    readonly wda?: WdaRouteHost,
  ) {
    this.#realSource = wda === undefined ? undefined : new WdaStreamSource(wda)
    this.#simSource = new SimStreamSource(simHost)
  }

  get routeAvailable(): boolean {
    return this.access.routeAvailable
  }

  /** `GET /_dsh/dsh-ios/stream/<token>` — proxy the MJPEG stream unchanged. */
  async handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req)
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'the stream route only accepts GET' }, { allow: 'GET' })
        return
      }
      const token = prefixToken(req.url, STREAM_ROUTE_PREFIX)
      if (token === undefined) {
        sendJson(res, 404, { ok: false, error: 'stream route not found' })
        return
      }
      const payload = await this.access.verifyStreamToken(token)
      if (payload === undefined) throw new RouteError(403, 'the stream token is invalid or expired', 'forbidden')
      const status = this.simHost.status()
      if (!status.running || status.device !== payload.udid) {
        throw new RouteError(503, 'the simulator stream is not running; request a fresh grant')
      }
      const release = this.simHost.acquire()
      let info: SimStreamInfo
      try {
        info = await this.simHost.ensureRunning({ udid: payload.udid })
      } catch (error) {
        release()
        throw new RouteError(502, `the simulator stream failed to start: ${errorMessage(error)}`, 'stream_failed')
      }
      if (this.#disposed) {
        release()
        res.destroy()
        return
      }
      this.#proxyStream(info.streamUrl, res, release)
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /** `GET /_dsh/dsh-ios/real-stream/<token>` — proxy the WDA MJPEG stream of
   * a physical device. Same fence and teardown tracking as the simulator
   * proxy; the WDA iproxy port is never exposed to the browser. Deliberately
   * does NOT call `ensureRunning`: a `sim-real-stream` capability is minted
   * only while WDA is already running, and this proxy must never spawn
   * xcodebuild. */
  async handleRealStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req)
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'the real-device stream route only accepts GET' }, { allow: 'GET' })
        return
      }
      const token = prefixToken(req.url, REAL_STREAM_ROUTE_PREFIX)
      if (token === undefined) {
        sendJson(res, 404, { ok: false, error: 'real-device stream route not found' })
        return
      }
      const payload = await this.access.verifyRealStreamToken(token)
      if (payload === undefined) throw new RouteError(403, 'the real-device stream token is invalid or expired', 'forbidden')
      if (this.wda === undefined) {
        throw new RouteError(503, 'real-device streaming is not mounted on this host', 'wda_unavailable')
      }
      const status = this.wda.status()
      if (!status.running || status.device !== payload.udid) {
        throw new RouteError(
          503,
          'the real-device stream is not running; request a fresh grant',
          wdaReasonErrorCodeOf(status),
        )
      }
      const mjpegUrl = status.mjpegUrl
      if (mjpegUrl === undefined) {
        throw new RouteError(503, 'the real-device stream has no MJPEG tunnel', 'wda_not_running')
      }
      const release = this.wda.acquire()
      if (this.#disposed) {
        release()
        res.destroy()
        return
      }
      this.#proxyStream(mjpegUrl, res, release)
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * `POST /_dsh/dsh-ios/device-action` — run one device-level action (App
   * Switcher, lock/unlock, shake, Siri, Action button, re-center) on one
   * device. Same loopback/trusted fence and JSON body as the other control
   * routes; `{ device }` picks the backend (a physical udid goes to
   * WebDriverAgent, anything else to the booted simulator).
   *
   * These live off the touch path on purpose: none of them is a touch. The
   * simulator reaches most of them through Simulator.app's Device menu and
   * the phone through WDA, both behind the stream sources' optional
   * `control.deviceAction` (see device-actions.ts for the table, and for why
   * Restart / Erase are deliberately not in it).
   */
  async handleDeviceAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req, true)
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'the device-action route only accepts POST' }, { allow: 'POST' })
        return
      }
      if (!isJsonRequest(req)) throw new RouteError(415, 'the device-action endpoint requires application/json', 'bad_content_type')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the device-action request is not valid JSON', 'bad_request')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the device-action request must be a JSON object', 'bad_request')
      const device = value.device
      if (device !== undefined && typeof device !== 'string') {
        throw new RouteError(400, 'device must be a device udid', 'bad_request')
      }
      const action = value.action
      if (!isDeviceAction(action)) {
        throw new RouteError(400, `action must be one of ${DEVICE_ACTIONS.join(', ')}`, 'bad_request')
      }
      const wdaStatus = this.wda?.status()
      const isReal = device !== undefined && device !== '' && wdaStatus?.device === device
      if (isReal) {
        if (this.#realSource === undefined) {
          throw new RouteError(503, 'real-device control is not mounted on this host', 'wda_unavailable')
        }
        if (wdaStatus === undefined || !wdaStatus.running) {
          throw new RouteError(409, 'WebDriverAgent is not running for the device', wdaReasonErrorCodeOf(wdaStatus ?? { running: false }))
        }
        if (!deviceActionSpec(action).realDevice) {
          throw new RouteError(400, `the ${action} action has no physical-device equivalent`, 'bad_request')
        }
        const release = this.wda!.acquire()
        try {
          await this.#realSource.control.deviceAction?.(action)
        } catch (error) {
          throw new RouteError(502, `the ${action} action failed: ${errorMessage(error)}`, 'unavailable')
        } finally {
          release()
        }
        sendJson(res, 200, { ok: true, action, kind: 'real-device' })
        return
      }
      try {
        await this.#simSource.control.deviceAction?.(action)
      } catch (error) {
        // The fixable causes (no Simulator app, missing Accessibility
        // permission, an Xcode without that menu item) are already spelled
        // out by the helper's message.
        throw new RouteError(502, errorMessage(error), 'unavailable')
      }
      sendJson(res, 200, { ok: true, action, kind: 'simulator' })
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * `POST /_dsh/dsh-ios/real-control` — one control op against the physical
   * device behind the panel. Body `{ device, action }` with
   * `{kind:'tap'|'drag'|'button'|'type'|'rotate'}`. tap/drag coordinates are
   * NORMALIZED 0..1 of the streamed frame (the panel's canvas space) and are
   * passed straight to `StreamSource.control` (the WDA adapter converts them
   * to absolute points via `GET /window/size`). `rotate` advances the WDA
   * orientation cycle (read via `getOrientation`, write via the adapter's
   * `rotate`) and reports the new orientation in the panel's display
   * vocabulary. Never starts anything: the device's WDA must already be
   * running or the route answers a coded 409.
   */
  async handleRealControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req, true)
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'the real-control route only accepts POST' }, { allow: 'POST' })
        return
      }
      if (!isJsonRequest(req)) throw new RouteError(415, 'the real-control endpoint requires application/json', 'bad_content_type')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the real-control request is not valid JSON', 'bad_request')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the real-control request must be a JSON object', 'bad_request')
      const device = value.device
      if (typeof device !== 'string' || !UDID_PATTERN.test(device)) {
        throw new RouteError(400, 'device must be a real-device udid', 'bad_request')
      }
      const action = value.action
      if (!isRecord(action) || typeof action.kind !== 'string' || action.kind === '') {
        throw new RouteError(400, 'action must be an object with a kind', 'bad_request')
      }
      const normalizedPoint = (x: unknown, y: unknown): { x: number; y: number } => {
        if (
          typeof x !== 'number' || typeof y !== 'number'
          || !Number.isFinite(x) || !Number.isFinite(y)
          || x < 0 || x > 1 || y < 0 || y > 1
        ) {
          throw new RouteError(400, 'tap/drag coordinates must be normalized 0..1 numbers', 'bad_request')
        }
        return { x, y }
      }
      // Validate the FULL action shape before any liveness check: malformed
      // input is a coded 400 regardless of what the backend is doing.
      type ParsedAction =
        | { kind: 'tap'; x: number; y: number }
        | { kind: 'drag'; fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }
        | { kind: 'button'; name: string }
        | { kind: 'type'; text: string }
        | { kind: 'rotate' }
      let parsed: ParsedAction
      switch (action.kind) {
        case 'tap': {
          const point = normalizedPoint(action.x, action.y)
          parsed = { kind: 'tap', x: point.x, y: point.y }
          break
        }
        case 'drag': {
          const from = normalizedPoint(action.fromX, action.fromY)
          const to = normalizedPoint(action.toX, action.toY)
          const durationMs = action.durationMs
          if (durationMs !== undefined && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)) {
            throw new RouteError(400, 'durationMs must be a non-negative number', 'bad_request')
          }
          parsed = { kind: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, ...(durationMs === undefined ? {} : { durationMs }) }
          break
        }
        case 'button': {
          if (typeof action.name !== 'string' || action.name === '') {
            throw new RouteError(400, 'button requires a non-empty name', 'bad_request')
          }
          parsed = { kind: 'button', name: action.name }
          break
        }
        case 'type': {
          if (typeof action.text !== 'string' || action.text === '') {
            throw new RouteError(400, 'type requires a non-empty text', 'bad_request')
          }
          parsed = { kind: 'type', text: action.text }
          break
        }
        case 'rotate':
          parsed = { kind: 'rotate' }
          break
        default:
          throw new RouteError(400, `unknown real-control action ${JSON.stringify(action.kind)}`, 'bad_request')
      }
      if (this.wda === undefined || this.#realSource === undefined) {
        throw new RouteError(503, 'real-device control is not mounted on this host', 'wda_unavailable')
      }
      const status = this.wda.status()
      if (!status.running || status.device !== device) {
        throw new RouteError(
          409,
          'WebDriverAgent is not running for the device; request a fresh status and grant',
          wdaReasonErrorCodeOf(status),
        )
      }
      const release = this.wda.acquire()
      try {
        switch (parsed.kind) {
          case 'tap':
            await this.#realSource.control.tap(parsed.x, parsed.y)
            break
          case 'drag':
            await this.#realSource.control.drag({
              fromX: parsed.fromX,
              fromY: parsed.fromY,
              toX: parsed.toX,
              toY: parsed.toY,
              ...(parsed.durationMs === undefined ? {} : { duration: Math.min(5, parsed.durationMs / 1000) }),
            })
            break
          case 'button':
            await this.#realSource.control.button(parsed.name)
            break
          case 'type':
            await this.#realSource.control.type(parsed.text)
            break
          case 'rotate': {
            const current = await this.wda.control.getOrientation()
            const next = nextWdaOrientation(current)
            await this.#realSource.control.rotate?.(next)
            sendJson(res, 200, { ok: true, orientation: displayOrientationFromWda(next) })
            return
          }
        }
        sendJson(res, 200, { ok: true })
      } catch (error) {
        if (error instanceof RouteError) throw error
        throw new RouteError(502, `the real-device control failed: ${errorMessage(error)}`, 'unavailable')
      } finally {
        release()
      }
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * `POST /_dsh/dsh-ios/real-device-status` — read-only snapshot of the WDA
   * host for the panel: `{ running, ready, device, code?, reason?, detail?,
   * orientation? }`. `ready` additionally requires a live WDA session;
   * `code`/`reason`/`detail` carry the classified failure (locked /
   * untrusted / expired / unplugged / …) so the panel can explain WHY
   * instead of a dead player. NEVER calls `ensureRunning`, never spawns
   * anything, never mints tokens. The optional body `{ device }` filters
   * like `/status`.
   */
  /** Devices whose adoption probe already triggered an ensureRunning. */
  readonly #adopting = new Set<string>()

  async handleRealDeviceStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req, true)
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'the real-device-status route only accepts POST' }, { allow: 'POST' })
        return
      }
      if (!isJsonRequest(req)) throw new RouteError(415, 'the real-device-status endpoint requires application/json', 'bad_content_type')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the real-device-status request is not valid JSON', 'bad_request')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the real-device-status request must be a JSON object', 'bad_request')
      const device = value.device
      if (device !== undefined && typeof device !== 'string') {
        throw new RouteError(400, 'device must be a real-device udid', 'bad_request')
      }
      if (this.wda === undefined) {
        sendJson(res, 200, { ok: true, running: false, ready: false })
        return
      }
      const status = this.wda.status()
      // The controller only knows about a WDA IT started. A host restart (or
      // a WDA the user launched by hand) leaves a perfectly good runner on
      // the control port that `status()` reports as "not running" — the UI
      // would then contradict reality, the same class of bug as a stale
      // stream device. So when the controller believes nothing is running,
      // probe the control tunnel: if a ready WDA answers, adopt it (the
      // controller's ensureRunning adopts rather than spawning a second
      // xcodebuild) and report the adopted state. The probe is a cheap
      // localhost GET and never builds anything.
      if (!status.running && device !== undefined && device !== '' && !this.#adopting.has(device)) {
        const adoptable = await probeWdaControlTunnel(DEFAULT_CONTROL_PORT).catch(() => false)
        if (adoptable) {
          // Fire-and-forget: this route is a 3-second poll and MUST stay
          // fast, while ensureRunning can legitimately take minutes (it
          // shares the launch queue with a cold build). Trigger the
          // adoption, answer with what we know now, and let the next poll
          // report the adopted state. The in-flight set keeps a poll storm
          // from queueing one adoption per tick.
          this.#adopting.add(device)
          void this.wda.ensureRunning({ udid: device })
            .catch(() => undefined)
            .finally(() => { this.#adopting.delete(device) })
        }
      }
      // `pendingDevice` counts as a match for the DIAGNOSTIC fields below: a
      // launch that failed (or is still waiting on a locked phone) tears the
      // live `device` down, so matching on it alone would answer a plain
      // "not running" and swallow the one thing the user needs to read —
      // "unlock the device". `running` still requires a live `device`, so
      // this widens what we can EXPLAIN, never what we claim to be up.
      const matches = device === undefined || device === ''
        || status.device === device || status.pendingDevice === device
      const running = status.running && status.device !== undefined && matches
      const ready = running && typeof status.sessionId === 'string' && status.sessionId !== ''
      let orientation: string | undefined
      if (ready) {
        try {
          orientation = displayOrientationFromWda(await this.wda.control.getOrientation())
        } catch {
          // Orientation is a best-effort read; the grant/rotate responses carry it too.
        }
      }
      sendJson(res, 200, {
        ok: true,
        running,
        ready,
        ...(status.device === undefined ? {} : { device: status.device }),
        ...(matches && !running && status.reason !== undefined
          ? { code: wdaReasonErrorCodeOf(status), reason: status.reason }
          : {}),
        ...(matches && status.detail !== undefined ? { detail: status.detail } : {}),
        ...(orientation === undefined ? {} : { orientation }),
      })
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * `POST /_dsh/dsh-ios/real-start` — start (or adopt) WebDriverAgent on
   * one physical device. Same loopback/trusted fence + application/json
   * body as /grant.
   *
   * DELIBERATE EXCEPTION to grant's never-build rule, documented here: the
   * real-device twin of /switch-device's never-boot exception. Pressing the
   * panel's Start button (or running the ios_real_start_wda tool) is an
   * explicit user gesture, which authorizes the `xcodebuild … test` launch
   * here — this route is the ONLY one allowed to build/launch WDA. /grant
   * and /real-stream themselves still never build anything.
   *
   * A cold build can take minutes, so the request never hangs behind a
   * proxy timeout: the launch runs in the background and the route answers
   * 202 Accepted immediately (`{ ok, state:'starting', device, startedAt }`);
   * the client polls /real-device-status until ready or a terminal coded
   * failure. Already-running WDA answers 200 `{ ok, state:'running',
   * device }` without spawning anything. A second start for the SAME device
   * while one is in flight answers 202 with `alreadyStarting: true` and
   * never spawns a second build (the controller's shared launch queue
   * serializes; the route's own fence makes that observable). Taking over a
   * different device retires the previous WDA — the same semantics
   * ensureRunning already has for device switches.
   */
  async handleRealStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req, true)
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'the real-start route only accepts POST' }, { allow: 'POST' })
        return
      }
      if (!isJsonRequest(req)) throw new RouteError(415, 'the real-start endpoint requires application/json', 'bad_content_type')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the real-start request is not valid JSON', 'bad_request')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the real-start request must be a JSON object', 'bad_request')
      const device = value.device
      if (typeof device !== 'string' || !UDID_PATTERN.test(device)) {
        throw new RouteError(400, 'device must be a real-device udid', 'bad_request')
      }
      if (this.wda === undefined) {
        throw new RouteError(503, 'real-device streaming is not mounted on this host', 'wda_unavailable')
      }
      const status = this.wda.status()
      if (!status.available) {
        const detail = status.reason === 'unavailable' && status.detail !== undefined && status.detail !== ''
          ? ` — ${status.detail}`
          : ''
        throw new RouteError(503, `WebDriverAgent tooling is unavailable on this host${detail}`, 'wda_unavailable')
      }
      if (status.running && status.device === device) {
        sendJson(res, 200, {
          ok: true,
          state: 'running',
          device,
          ...(status.adopted === true ? { adopted: true } : {}),
        })
        return
      }
      const inflight = this.#realStarts.get(device)
      if (inflight !== undefined && inflight.state === 'starting') {
        // Never spawn a second build: the in-flight launch already covers
        // this device; the caller should keep polling the status route.
        sendJson(res, 202, {
          ok: true,
          state: 'starting',
          device,
          alreadyStarting: true,
          startedAt: inflight.startedAt,
        })
        return
      }
      const startedAt = Date.now()
      this.#realStarts.set(device, { state: 'starting', udid: device, startedAt })
      const launch = this.wda.ensureRunning({ udid: device }).then(
        () => {
          // Up and running: the status route reports it; drop the fence.
          this.#realStarts.delete(device)
        },
        () => {
          const current = this.wda!.status()
          const code = wdaReasonErrorCodeOf(current)
          this.#realStarts.set(device, {
            state: 'failed',
            udid: device,
            startedAt,
            error: {
              code,
              ...(current.detail === undefined || current.detail === '' ? {} : { detail: current.detail }),
            },
          })
        },
      )
      this.#realLaunchPromises.add(launch)
      void launch.finally(() => { this.#realLaunchPromises.delete(launch) })
      sendJson(res, 202, { ok: true, state: 'starting', device, startedAt })
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * Diagnostic snapshot of the `/real-start` launch for one device —
   * `undefined` while none is tracked, `starting` while the background
   * build is in flight, `failed` (with the coded error) after it settled
   * badly. Exported so the smoke can assert the async outcome without a
   * phone.
   */
  realStartState(udid: string): RealStartRecord | undefined {
    return this.#realStarts.get(udid)
  }

  /** `GET /_dsh/dsh-ios/screenshot/<token>` — serve one cached PNG. */
  async handleScreenshot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req)
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'the screenshot route only accepts GET' }, { allow: 'GET' })
        return
      }
      const token = prefixToken(req.url, SCREENSHOT_ROUTE_PREFIX)
      if (token === undefined) {
        sendJson(res, 404, { ok: false, error: 'screenshot route not found' })
        return
      }
      const payload = await this.access.verifyScreenshotToken(token)
      if (payload === undefined) throw new RouteError(403, 'the screenshot token is invalid or expired', 'forbidden')
      const verdict = await classifyScreenshotPath(payload.path)
      if (verdict === 'outside') throw new RouteError(403, 'screenshot path escaped the plugin cache directory', 'forbidden')
      const opened = verdict === 'ok' ? await openVerifiedScreenshot(payload.path) : undefined
      if (opened === undefined) throw new RouteError(404, 'screenshot not found')
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(opened.bytes.length),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "sandbox; default-src 'none'",
      })
      res.end(opened.bytes)
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * `POST /_dsh/dsh-ios/grant` — mint fresh relative-URL capabilities from
   * stable presentationMeta. Never boots a device: a stream is only started
   * when the device is already booted (or the stream already runs for it).
   */
  async handleGrant(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req, true)
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'the grant route only accepts POST' }, { allow: 'POST' })
        return
      }
      if (!isJsonRequest(req)) throw new RouteError(415, 'the grant endpoint requires application/json', 'bad_content_type')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the grant request is not valid JSON', 'bad_request')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the grant request must be a JSON object', 'bad_request')
      const kind = value.kind
      if (kind === 'sim-stream') {
        const device = value.device
        if (device !== undefined && typeof device !== 'string') throw new RouteError(400, 'device must be a simulator udid', 'bad_request')
        const status = this.simHost.status()
        let udid = device
        if (udid === undefined || udid === '') {
          if (!status.running || status.device === undefined) {
            throw new RouteError(409, 'no simulator stream is running; include the device udid', 'stream_not_running')
          }
          udid = status.device
        }
        if (!UDID_PATTERN.test(udid)) throw new RouteError(400, 'device must be a simulator udid', 'bad_request')
        if (status.running && status.device !== udid) {
          // NEVER take over: minting a capability must not change which
          // device is streaming. This route used to call ensureRunning here,
          // so a re-grant carrying a stale udid (a panel that missed a device
          // switch, a queued retry) silently yanked the stream back to the
          // old device while the picker still showed the new one — the UI
          // then lied about what the server was doing. Device changes belong
          // exclusively to the explicit user gesture behind /switch-device.
          throw new RouteError(409, `another simulator is streaming (${status.device}); switch devices instead of re-granting`, 'device_busy')
        }
        if (!status.running) {
          // Start a stream only for a device that is already booted —
          // this route never boots a simulator.
          const booted = await bootedDevices()
          if (!booted.some(candidate => candidate.udid === udid)) {
            throw new RouteError(409, 'the simulator is not booted; boot it before requesting a stream grant', 'device_not_booted')
          }
        }
        try {
          await this.simHost.ensureRunning({ udid })
        } catch (error) {
          throw new RouteError(502, `the simulator stream failed to start: ${errorMessage(error)}`, 'stream_failed')
        }
        const signed = await this.access.signStreamToken(udid)
        sendJson(res, 200, {
          ok: true,
          streamUrl: `${STREAM_ROUTE_PREFIX}/${signed.token}`,
          wsUrl: `${WS_ROUTE_PATH}?token=${encodeURIComponent(signed.token)}`,
          expiresAt: signed.expiresAt,
        })
        return
      }
      if (kind === 'real-stream') {
        // Real-device capability minting shares /grant: one fence, one
        // client call shape, one error channel. NEVER boots/builds: WDA
        // must already be running for the device (start it with the panel's
        // Start button — POST /real-start — or the ios_real_start_wda
        // tool); otherwise the route answers a coded 409 the panel turns
        // into an actionable message. No ensureRunning, no acquire —
        // minting a capability changes nothing; the stream proxy holds the
        // refcount once the browser connects.
        if (this.wda === undefined || this.#realSource === undefined) {
          throw new RouteError(503, 'real-device streaming is not mounted on this host', 'wda_unavailable')
        }
        const device = value.device
        if (device !== undefined && typeof device !== 'string') throw new RouteError(400, 'device must be a real-device udid', 'bad_request')
        const status = this.wda.status()
        let udid = device
        if (udid === undefined || udid === '') {
          if (!status.running || status.device === undefined) {
            throw new RouteError(409, 'no real-device WDA is running; include the device udid', 'wda_not_running')
          }
          udid = status.device
        }
        if (!UDID_PATTERN.test(udid)) throw new RouteError(400, 'device must be a real-device udid', 'bad_request')
        if (status.running && status.device !== udid) {
          // NEVER take over: taking over a different physical device means
          // tearing down and rebuilding WDA, which a capability mint must
          // not do.
          throw new RouteError(409, `WebDriverAgent is running for another device (${status.device}); pick that device instead`, 'device_busy')
        }
        if (!status.running || status.device !== udid || status.mjpegUrl === undefined) {
          const detail = status.detail === undefined ? '' : ` — ${status.detail}`
          throw new RouteError(
            409,
            `WebDriverAgent is not running for the device${detail}`,
            wdaReasonErrorCodeOf(status),
          )
        }
        // The control tunnel being up does not mean the VIDEO tunnel is: a
        // phone that re-enumerates over USB can take 9100 down while 8100
        // survives, and minting a capability for a dead forwarder hands the
        // panel a player that never paints. Probe-and-repair here (the runner
        // is untouched — only the missing iproxy is respawned) instead of
        // reporting a lie.
        if (this.wda.repairStreamTunnel !== undefined && !await this.wda.repairStreamTunnel()) {
          throw new RouteError(
            409,
            'the WebDriverAgent video tunnel is down and could not be re-established — reconnect the device over USB',
            'wda_tunnel_failed',
          )
        }
        let orientation: string | undefined
        try {
          orientation = displayOrientationFromWda(await this.wda.control.getOrientation())
        } catch {
          // Orientation is a best-effort read; the rotate action reports it too.
        }
        const signed = await this.access.signRealStreamToken(udid)
        sendJson(res, 200, {
          ok: true,
          streamUrl: `${REAL_STREAM_ROUTE_PREFIX}/${signed.token}`,
          expiresAt: signed.expiresAt,
          device: udid,
          ...(orientation === undefined ? {} : { orientation }),
        })
        return
      }
      if (kind === 'sim-screenshot') {
        const path = value.path
        if (typeof path !== 'string' || !isAbsolute(path)) {
          throw new RouteError(400, 'path must be an absolute screenshot path inside the plugin cache', 'bad_request')
        }
        const verdict = await classifyScreenshotPath(path)
        if (verdict === 'outside') throw new RouteError(403, 'screenshot path escaped the plugin cache directory', 'forbidden')
        if (verdict !== 'ok') throw new RouteError(404, 'screenshot file not found')
        const signed = await this.access.signScreenshotToken(path)
        sendJson(res, 200, {
          ok: true,
          screenshotUrl: `${SCREENSHOT_ROUTE_PREFIX}/${signed.token}`,
          expiresAt: signed.expiresAt,
        })
        return
      }
      throw new RouteError(400, `unknown grant kind ${JSON.stringify(kind)}; expected 'sim-stream', 'real-stream' or 'sim-screenshot'`, 'bad_request')
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * `POST /_dsh/dsh-ios/switch-device` — switch which simulator the panel
   * streams. Same loopback/trusted fence + application/json body as /grant.
   *
   * DELIBERATE EXCEPTION to grant's never-boot rule, documented here: picking
   * a device in the panel is an explicit user gesture, which authorizes
   * booting the simulator. The route therefore MAY boot (`bootDevice` when
   * the target is not booted) before handing the stream slot to
   * `ensureRunning` — grant itself still never boots.
   *
   * The device must exist AND be available (listDevices skips unavailable
   * entries) or the route answers 409. The stream takeover runs through
   * `ensureRunning`, whose existing device-switch logic retires the old
   * stream and whose internal launch queue serializes launches, so
   * concurrent switches cannot interleave their launches (the client also
   * refuses concurrent picks). Success returns the same shape as grant's
   * sim-stream response (fresh relative streamUrl/wsUrl/expiresAt) plus
   * `{ device, deviceName }`.
   */
  async handleSwitchDevice(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req, true)
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'the switch-device route only accepts POST' }, { allow: 'POST' })
        return
      }
      if (!isJsonRequest(req)) throw new RouteError(415, 'the switch-device endpoint requires application/json', 'bad_content_type')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the switch-device request is not valid JSON', 'bad_request')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the switch-device request must be a JSON object', 'bad_request')
      const device = value.device
      if (typeof device !== 'string' || !UDID_PATTERN.test(device)) {
        throw new RouteError(400, 'device must be a simulator udid', 'bad_request')
      }
      let resolved: SimulatorDevice | undefined
      try {
        resolved = (await listDevices()).find(candidate => candidate.udid === device)
      } catch (error) {
        throw new RouteError(503, `the device switch cannot list simulators: ${errorMessage(error)}`)
      }
      if (resolved === undefined) {
        throw new RouteError(409, 'the simulator does not exist or is unavailable', 'device_unknown')
      }
      if (resolved.state !== 'Booted') {
        // The documented exception: an explicit pick may boot the simulator.
        try {
          await bootDevice(device)
        } catch (error) {
          throw new RouteError(502, `the simulator failed to boot: ${errorMessage(error)}`)
        }
      }
      try {
        await this.simHost.ensureRunning({ udid: device })
      } catch (error) {
        throw new RouteError(502, `the simulator stream failed to start: ${errorMessage(error)}`, 'stream_failed')
      }
      const signed = await this.access.signStreamToken(device)
      sendJson(res, 200, {
        ok: true,
        streamUrl: `${STREAM_ROUTE_PREFIX}/${signed.token}`,
        wsUrl: `${WS_ROUTE_PATH}?token=${encodeURIComponent(signed.token)}`,
        expiresAt: signed.expiresAt,
        device,
        deviceName: resolved.name,
      })
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * `POST /_dsh/dsh-ios/devices` — read-only listing of the pickable
   * simulators for the panel header's device picker. Same loopback/trusted
   * fence + application/json body as /grant; the body is validated as a JSON
   * object but otherwise ignored. NEVER boots, NEVER starts a stream and
   * never mints capability tokens. The list comes from the read-only
   * `listDevices()` (unavailable simulators are already filtered out),
   * sorted booted-first then by runtime descending, capped at
   * `MAX_PICKABLE_DEVICES` (~40).
   */
  async handleDevices(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req, true)
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'the devices route only accepts POST' }, { allow: 'POST' })
        return
      }
      if (!isJsonRequest(req)) throw new RouteError(415, 'the devices endpoint requires application/json', 'bad_content_type')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the devices request is not valid JSON', 'bad_request')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the devices request must be a JSON object', 'bad_request')
      let devices: SimulatorDevice[]
      try {
        devices = await listDevices()
      } catch (error) {
        throw new RouteError(503, `the device list cannot be read: ${errorMessage(error)}`)
      }
      devices.sort((left, right) => {
        const leftBooted = left.state === 'Booted' ? 0 : 1
        const rightBooted = right.state === 'Booted' ? 0 : 1
        if (leftBooted !== rightBooted) return leftBooted - rightBooted
        const runtimeOrder = compareRuntimesDesc(left.runtime, right.runtime)
        if (runtimeOrder !== 0) return runtimeOrder
        return left.name.localeCompare(right.name)
      })
      const pickable = devices.slice(0, MAX_PICKABLE_DEVICES).map(({ udid, name, runtime, state }) => ({
        udid,
        name,
        runtime,
        state,
      }))
      // Physical devices are listed too, so the picker can show what is
      // actually plugged in instead of a blind "coming soon" placeholder.
      // They are a SEPARATE array: they cannot be streamed (no simctl
      // framebuffer — a real-device live view needs WebDriverAgent), so the
      // client must never feed them to /switch-device. Listing them is
      // read-only and never touches the phone beyond `devicectl list`.
      let realDevices: Array<{ udid: string; name: string; osVersion?: string; model?: string; state: string; connection: string; developerMode: string }> = []
      try {
        realDevices = (await listRealDevices())
          .slice(0, MAX_PICKABLE_DEVICES)
          .map(device => ({
            udid: device.udid,
            name: device.name,
            ...(device.osVersion === undefined ? {} : { osVersion: device.osVersion }),
            ...(device.model === undefined ? {} : { model: device.model }),
            state: device.state,
            connection: device.connection,
            developerMode: device.developerMode,
          }))
      } catch {
        // devicectl missing, no Xcode, or no phone attached: the picker just
        // shows no real-device entries. Never fail the simulator listing.
      }
      sendJson(res, 200, { ok: true, devices: pickable, realDevices })
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * `POST /_dsh/dsh-ios/status` — read-only stream snapshot for the input
   * dock's capsule. Same loopback/trusted fence + application/json body as
   * /grant, but this route NEVER starts a stream: it only reads
   * `SimHostController.status()` (optionally filtered by the body's
   * `device` udid) and reports `{ running, device?, deviceName? }`.
   * The device name comes from the read-only `bootedDevices()` listing, so
   * a missing name degrades to the udid rather than failing the request.
   */
  async handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req, true)
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'the status route only accepts POST' }, { allow: 'POST' })
        return
      }
      if (!isJsonRequest(req)) throw new RouteError(415, 'the status endpoint requires application/json', 'bad_content_type')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the status request is not valid JSON', 'bad_request')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the status request must be a JSON object', 'bad_request')
      const device = value.device
      if (device !== undefined && typeof device !== 'string') {
        throw new RouteError(400, 'device must be a simulator udid', 'bad_request')
      }
      const status = this.simHost.status()
      const running = status.running
        && status.device !== undefined
        && (device === undefined || device === '' || status.device === device)
      if (!running) {
        sendJson(res, 200, { ok: true, running: false })
        return
      }
      let deviceName: string | undefined
      try {
        deviceName = (await bootedDevices()).find(candidate => candidate.udid === status.device)?.name
      } catch {
        // Read-only listing failed (e.g. no Xcode) — report the udid only.
        deviceName = undefined
      }
      sendJson(res, 200, {
        ok: true,
        running: true,
        ...(status.device === undefined ? {} : { device: status.device }),
        ...(deviceName === undefined ? {} : { deviceName }),
      })
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * `POST /_dsh/dsh-ios/capture` — capture a FRESH PNG of the current
   * streamed (or explicitly booted) device into the tools' screenshot cache
   * and mint a signed relative screenshot URL. Same loopback/trusted fence +
   * application/json as /grant. NEVER boots a simulator: the capture only
   * runs when the device is already streaming or already booted.
   */
  async handleCapture(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#requireTrusted(req, true)
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'the capture route only accepts POST' }, { allow: 'POST' })
        return
      }
      if (!isJsonRequest(req)) throw new RouteError(415, 'the capture endpoint requires application/json', 'bad_content_type')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the capture request is not valid JSON', 'bad_request')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the capture request must be a JSON object', 'bad_request')
      const device = value.device
      if (device !== undefined && typeof device !== 'string') {
        throw new RouteError(400, 'device must be a simulator udid', 'bad_request')
      }
      const status = this.simHost.status()
      let udid = device
      if (udid === undefined || udid === '') {
        if (!status.running || status.device === undefined) {
          throw new RouteError(409, 'no simulator stream is running; include the device udid', 'stream_not_running')
        }
        udid = status.device
      }
      if (!UDID_PATTERN.test(udid)) throw new RouteError(400, 'device must be a simulator udid', 'bad_request')
      // WDA branch: when the target is the WDA host's device, the PNG comes
      // from WDA's own screenshot API (control.screenshot) into the same
      // signed screenshot cache — no simctl, never boots anything.
      const wdaStatus = this.wda?.status()
      if (this.wda !== undefined && this.#realSource !== undefined && wdaStatus !== undefined && wdaStatus.device === udid) {
        if (!wdaStatus.running || wdaStatus.mjpegUrl === undefined) {
          const detail = wdaStatus.detail === undefined ? '' : ` — ${wdaStatus.detail}`
          throw new RouteError(
            409,
            `WebDriverAgent is not running for the device${detail}`,
            wdaReasonErrorCodeOf(wdaStatus),
          )
        }
        const path = await nextCapturePath(udid)
        const release = this.wda.acquire()
        try {
          const shot = await this.#realSource.control.screenshot()
          await writeFile(path, Buffer.from(shot.pngBase64, 'base64'))
        } catch (error) {
          throw new RouteError(502, `the real-device screenshot failed: ${errorMessage(error)}`)
        } finally {
          release()
        }
        const bytes = statSync(path).size
        const signed = await this.access.signScreenshotToken(path)
        sendJson(res, 200, {
          ok: true,
          screenshotUrl: `${SCREENSHOT_ROUTE_PREFIX}/${signed.token}`,
          path,
          bytes,
          expiresAt: signed.expiresAt,
        })
        return
      }
      // Allowed while the device is streaming, or at least already booted —
      // this route NEVER boots a simulator.
      const streaming = status.running && status.device === udid
      if (!streaming) {
        let booted: SimulatorDevice[]
        try {
          booted = await bootedDevices()
        } catch (error) {
          throw new RouteError(503, `the simulator capture cannot list devices: ${errorMessage(error)}`)
        }
        if (!booted.some(candidate => candidate.udid === udid)) {
          throw new RouteError(409, 'the simulator is not booted; boot it before capturing a screenshot')
        }
      }
      const path = await nextCapturePath(udid)
      try {
        await takeScreenshot(udid, path)
      } catch (error) {
        throw new RouteError(502, `the simulator screenshot failed: ${errorMessage(error)}`)
      }
      const bytes = statSync(path).size
      const signed = await this.access.signScreenshotToken(path)
      sendJson(res, 200, {
        ok: true,
        screenshotUrl: `${SCREENSHOT_ROUTE_PREFIX}/${signed.token}`,
        path,
        bytes,
        expiresAt: signed.expiresAt,
      })
    } catch (error) {
      this.#answerError(res, error)
    }
  }

  /**
   * WS `/_dsh/dsh-ios/ws?token=…` — relay HID frames to serve-sim's control
   * channel. Both sides use uncompressed standard WebSocket framing; the
   * binary message payloads (`[tag, json]`) pass through unchanged.
   */
  async handleWsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      if (this.#disposed) {
        rejectUpgrade(socket, 503)
        return
      }
      if (!isTrustedRequest(req, false)) {
        rejectUpgrade(socket, 403)
        return
      }
      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://dsh.local')
      } catch {
        rejectUpgrade(socket, 400)
        return
      }
      if (url.pathname !== WS_ROUTE_PATH) {
        rejectUpgrade(socket, 404)
        return
      }
      if ([...url.searchParams.keys()].some(key => key !== 'token')) {
        rejectUpgrade(socket, 400)
        return
      }
      const token = url.searchParams.get('token') ?? ''
      const payload = await this.access.verifyStreamToken(token)
      if (payload === undefined) {
        rejectUpgrade(socket, 403)
        return
      }
      const status = this.simHost.status()
      if (!status.running || status.device !== payload.udid) {
        rejectUpgrade(socket, 503)
        return
      }
      const key = req.headers['sec-websocket-key']
      if (typeof key !== 'string' || !WEBSOCKET_KEY_PATTERN.test(key)) {
        rejectUpgrade(socket, 400)
        return
      }
      const release = this.simHost.acquire()
      let info: SimStreamInfo
      try {
        info = await this.simHost.ensureRunning({ udid: payload.udid })
      } catch (error) {
        release()
        rejectUpgrade(socket, 502)
        return
      }
      if (this.#disposed) {
        release()
        rejectUpgrade(socket, 503)
        return
      }
      const { WebSocket, WebSocketServer } = loadWs()
      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
      let browser: WsClientLike | undefined
      let upstream: WsClientLike | undefined
      let finished = false
      const teardown = (): void => {
        if (finished) return
        finished = true
        this.#wsTeardowns.delete(teardown)
        browser?.terminate()
        upstream?.terminate()
        socket.destroy()
        release()
      }
      this.#wsTeardowns.add(teardown)
      socket.on('error', teardown)
      socket.on('close', () => {
        if (browser === undefined) teardown()
      })
      wss.handleUpgrade(req, socket, head, client => {
        if (finished) {
          client.terminate()
          return
        }
        browser = client
        upstream = new WebSocket(info.wsUrl, { perMessageDeflate: false })
        const pending: Buffer[] = []
        client.on('error', teardown)
        client.on('close', teardown)
        upstream.on('error', teardown)
        upstream.on('close', teardown)
        upstream.on('open', () => {
          for (const chunk of pending) {
            if (upstream !== undefined && upstream.readyState === WebSocket.OPEN) upstream.send(chunk)
          }
          pending.length = 0
        })
        client.on('message', (data) => {
          if (finished) return
          const chunk = typeof data === 'string' ? Buffer.from(data) : data
          if (upstream !== undefined && upstream.readyState === WebSocket.OPEN) upstream.send(chunk)
          else if (pending.length < MAX_PENDING_WS_FRAMES) pending.push(chunk)
        })
        upstream.on('message', (data) => {
          if (finished || browser === undefined || browser.readyState !== WebSocket.OPEN) return
          browser.send(typeof data === 'string' ? Buffer.from(data) : data)
        })
      })
    } catch (error) {
      rejectUpgrade(socket, 502)
    }
  }

  /** Destroy every open stream response and control relay. */
  dispose(): void {
    this.#disposed = true
    for (const teardown of [...this.#streamTeardowns]) teardown()
    for (const teardown of [...this.#wsTeardowns]) teardown()
    // In-flight launches settle through WdaController.dispose; the route
    // just stops tracking them.
    this.#realStarts.clear()
  }

  #requireTrusted(req: IncomingMessage, requireOrigin = false): void {
    if (!isTrustedRequest(req, requireOrigin)) {
      throw new RouteError(403, 'the dsh-ios route requires a loopback trusted browser request', 'forbidden')
    }
  }

  #answerError(res: ServerResponse, error: unknown): void {
    const status = error instanceof RouteError ? error.status : 500
    const code: SimRouteErrorCode = error instanceof RouteError ? error.code : 'unavailable'
    const message = errorMessage(error)
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, status, { ok: false, code, error: message })
  }

  /**
   * Open an HTTP client request against a stream URL (serve-sim's streamUrl
   * or the WDA MJPEG tunnel) and pipe the multipart body through unchanged.
   * The upstream request is destroyed and the consumer refcount released on
   * client disconnect OR upstream end.
   */
  #proxyStream(streamUrl: string, res: ServerResponse, release: () => void): void {
    const state: {
      upstream?: ReturnType<typeof httpGet>
      closed: boolean
    } = { closed: false }
    const teardown = (): void => {
      if (state.closed) return
      state.closed = true
      this.#streamTeardowns.delete(teardown)
      state.upstream?.destroy()
      if (!res.writableEnded) res.destroy()
      release()
    }
    this.#streamTeardowns.add(teardown)
    res.on('error', teardown)
    res.on('close', () => {
      // 'close' also fires after a normal end; only a premature close is a
      // client disconnect worth killing the upstream request over.
      if (!res.writableEnded) teardown()
    })
    const get = streamUrl.startsWith('https:') ? httpsGet : httpGet
    const upstream = get(streamUrl)
    state.upstream = upstream
    upstream.on('error', teardown)
    upstream.on('response', response => {
      if (state.closed) {
        response.destroy()
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        if (!res.headersSent) {
          sendJson(res, 502, { ok: false, error: `serve-sim stream returned HTTP ${String(response.statusCode)}` })
        } else {
          res.destroy()
        }
        return
      }
      const headers: OutgoingHttpHeaders = {
        'content-type': response.headers['content-type'] ?? 'multipart/x-mixed-replace; boundary=frame',
        'cache-control': response.headers['cache-control'] ?? 'no-cache, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
      }
      // Never forward serve-sim's `Access-Control-Allow-Origin: *` — doing so
      // would let foreign origins read the stream and bypass the trusted-host
      // fence. Everything the browser sees must stay same-origin.
      if (typeof response.headers['content-length'] === 'string') headers['content-length'] = response.headers['content-length']
      res.writeHead(200, headers)
      response.on('error', teardown)
      // Pipe straight through: no buffering, no re-chunking of the multipart body.
      response.pipe(res, { end: true })
    })
  }
}

/**
 * Register the plugin routes on any webserver-shaped carrier. Each (kind,
 * path) is registered exactly once; the returned disposer unregisters all of
 * them and tears down every open response/relay.
 */
export function mountStreamRoutes(webServer: StreamRouteMount, routes: StreamRoutes): () => void {
  const disposers = [
    webServer.register({
      kind: 'prefix',
      path: STREAM_ROUTE_PREFIX,
      handler: (req, res) => routes.handleStream(req, res),
    }),
    webServer.register({
      kind: 'prefix',
      path: SCREENSHOT_ROUTE_PREFIX,
      handler: (req, res) => routes.handleScreenshot(req, res),
    }),
    webServer.register({
      kind: 'prefix',
      path: REAL_STREAM_ROUTE_PREFIX,
      handler: (req, res) => routes.handleRealStream(req, res),
    }),
    webServer.register({
      kind: 'exact',
      path: GRANT_ROUTE_PATH,
      handler: (req, res) => routes.handleGrant(req, res),
    }),
    webServer.register({
      kind: 'exact',
      path: SWITCH_DEVICE_ROUTE_PATH,
      handler: (req, res) => routes.handleSwitchDevice(req, res),
    }),
    webServer.register({
      kind: 'exact',
      path: DEVICES_ROUTE_PATH,
      handler: (req, res) => routes.handleDevices(req, res),
    }),
    webServer.register({
      kind: 'exact',
      path: CAPTURE_ROUTE_PATH,
      handler: (req, res) => routes.handleCapture(req, res),
    }),
    webServer.register({
      kind: 'exact',
      path: STATUS_ROUTE_PATH,
      handler: (req, res) => routes.handleStatus(req, res),
    }),
    webServer.register({
      kind: 'exact',
      path: REAL_CONTROL_ROUTE_PATH,
      handler: (req, res) => routes.handleRealControl(req, res),
    }),
    webServer.register({
      kind: 'exact',
      path: DEVICE_ACTION_ROUTE_PATH,
      handler: (req, res) => routes.handleDeviceAction(req, res),
    }),
    webServer.register({
      kind: 'exact',
      path: REAL_DEVICE_STATUS_ROUTE_PATH,
      handler: (req, res) => routes.handleRealDeviceStatus(req, res),
    }),
    webServer.register({
      kind: 'exact',
      path: REAL_START_ROUTE_PATH,
      handler: (req, res) => routes.handleRealStart(req, res),
    }),
    webServer.registerUpgrade({
      path: WS_ROUTE_PATH,
      handler: (req, socket, head) => routes.handleWsUpgrade(req, socket, head),
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    routes.dispose()
  }
}

/**
 * Mount the stream routes on the optional `webServer` service. Uses
 * `ctx.inject` + `ctx.effect` so headless profiles (no webServer) still load,
 * the routes are registered exactly once, and disposal unregisters them and
 * destroys every open stream/relay. `wda` enables the real-device routes
 * (stream proxy, control, status, real grant/capture branches).
 */
export function installStreamRoutes(ctx: Context, simHost: SimHostController, wda?: WdaRouteHost): void {
  ctx.inject(['webServer'], webCtx => webCtx.effect(() => {
    const webServer = (webCtx as Context & { webServer: StreamRouteMount }).webServer
    const access = new StreamAccessController()
    const routes = new StreamRoutes(simHost, access, wda)
    const detach = access.attachRoute()
    const dispose = mountStreamRoutes(webServer, routes)
    return () => {
      dispose()
      detach()
    }
  }, 'dsh-ios: stream routes'))
}
