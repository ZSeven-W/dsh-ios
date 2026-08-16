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
 * - `POST /capture`           — loopback/trusted-only JSON endpoint the panel
 *   toolbar's 截图 button calls: captures a FRESH PNG of the current
 *   streamed (or explicitly booted) device into the tools' screenshot cache
 *   via `simctl io … screenshot` and mints a signed relative screenshot URL.
 *   Never boots a simulator.
 * - `POST /status`            — read-only loopback/trusted-only JSON endpoint
 *   that reports whether the sim host is streaming (`{ running, device?,
 *   deviceName? }`). It NEVER calls `ensureRunning`, never boots a simulator
 *   and never mints capability tokens — the input-dock capsule polls it.
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
import { bootedDevices, takeScreenshot, type SimulatorDevice } from './simctl.js'

/** HTTP prefix owned by the dsh-ios web routes. */
export const PLUGIN_ROUTE_PREFIX = '/_dsh/dsh-ios'
export const STREAM_ROUTE_PREFIX = `${PLUGIN_ROUTE_PREFIX}/stream`
export const SCREENSHOT_ROUTE_PREFIX = `${PLUGIN_ROUTE_PREFIX}/screenshot`
export const WS_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/ws`
export const GRANT_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/grant`
export const CAPTURE_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/capture`
export const STATUS_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/status`

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

interface StreamTokenPayload {
  v: 1
  kind: 'sim-stream'
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

  /** Mint a screenshot capability for one absolute path in the cache dir. */
  async signScreenshotToken(path: string, options: { ttlMs?: number } = {}): Promise<{ token: string; expiresAt: number }> {
    if (!isAbsolute(path)) throw new TypeError('dsh-ios: signScreenshotToken requires an absolute path')
    return this.#sign({ v: 1, kind: 'sim-screenshot', path, exp: Date.now() + this.#ttl(options.ttlMs) })
  }

  /** Verify and decode one stream capability without touching the filesystem. */
  verifyStreamToken(token: string): Promise<StreamTokenPayload | undefined> {
    return this.#verify(token, parseStreamPayload)
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

  async #sign(payload: StreamTokenPayload | ScreenshotTokenPayload): Promise<{ token: string; expiresAt: number }> {
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

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'RouteError'
  }
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
    if (!Number.isSafeInteger(declared) || declared < 0) throw new RouteError(400, 'invalid content-length')
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

  constructor(
    readonly simHost: SimHostController,
    readonly access: StreamAccessController,
  ) {}

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
      if (payload === undefined) throw new RouteError(403, 'the stream token is invalid or expired')
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
        throw new RouteError(502, `the simulator stream failed to start: ${errorMessage(error)}`)
      }
      if (this.#disposed) {
        release()
        res.destroy()
        return
      }
      this.#proxyStream(info, res, release)
    } catch (error) {
      this.#answerError(res, error)
    }
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
      if (payload === undefined) throw new RouteError(403, 'the screenshot token is invalid or expired')
      const verdict = await classifyScreenshotPath(payload.path)
      if (verdict === 'outside') throw new RouteError(403, 'screenshot path escaped the plugin cache directory')
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
      if (!isJsonRequest(req)) throw new RouteError(415, 'the grant endpoint requires application/json')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the grant request is not valid JSON')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the grant request must be a JSON object')
      const kind = value.kind
      if (kind === 'sim-stream') {
        const device = value.device
        if (device !== undefined && typeof device !== 'string') throw new RouteError(400, 'device must be a simulator udid')
        const status = this.simHost.status()
        let udid = device
        if (udid === undefined || udid === '') {
          if (!status.running || status.device === undefined) {
            throw new RouteError(409, 'no simulator stream is running; include the device udid')
          }
          udid = status.device
        }
        if (!UDID_PATTERN.test(udid)) throw new RouteError(400, 'device must be a simulator udid')
        if (!status.running || status.device !== udid) {
          // Start a stream only for a device that is already booted —
          // this route never boots a simulator.
          const booted = await bootedDevices()
          if (!booted.some(candidate => candidate.udid === udid)) {
            throw new RouteError(409, 'the simulator is not booted; boot it before requesting a stream grant')
          }
        }
        try {
          await this.simHost.ensureRunning({ udid })
        } catch (error) {
          throw new RouteError(502, `the simulator stream failed to start: ${errorMessage(error)}`)
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
      if (kind === 'sim-screenshot') {
        const path = value.path
        if (typeof path !== 'string' || !isAbsolute(path)) {
          throw new RouteError(400, 'path must be an absolute screenshot path inside the plugin cache')
        }
        const verdict = await classifyScreenshotPath(path)
        if (verdict === 'outside') throw new RouteError(403, 'screenshot path escaped the plugin cache directory')
        if (verdict !== 'ok') throw new RouteError(404, 'screenshot file not found')
        const signed = await this.access.signScreenshotToken(path)
        sendJson(res, 200, {
          ok: true,
          screenshotUrl: `${SCREENSHOT_ROUTE_PREFIX}/${signed.token}`,
          expiresAt: signed.expiresAt,
        })
        return
      }
      throw new RouteError(400, `unknown grant kind ${JSON.stringify(kind)}; expected 'sim-stream' or 'sim-screenshot'`)
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
      if (!isJsonRequest(req)) throw new RouteError(415, 'the status endpoint requires application/json')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the status request is not valid JSON')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the status request must be a JSON object')
      const device = value.device
      if (device !== undefined && typeof device !== 'string') {
        throw new RouteError(400, 'device must be a simulator udid')
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
      if (!isJsonRequest(req)) throw new RouteError(415, 'the capture endpoint requires application/json')
      const body = await readBody(req, MAX_GRANT_BODY_BYTES)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new RouteError(400, 'the capture request is not valid JSON')
      }
      if (!isRecord(value)) throw new RouteError(400, 'the capture request must be a JSON object')
      const device = value.device
      if (device !== undefined && typeof device !== 'string') {
        throw new RouteError(400, 'device must be a simulator udid')
      }
      const status = this.simHost.status()
      let udid = device
      if (udid === undefined || udid === '') {
        if (!status.running || status.device === undefined) {
          throw new RouteError(409, 'no simulator stream is running; include the device udid')
        }
        udid = status.device
      }
      if (!UDID_PATTERN.test(udid)) throw new RouteError(400, 'device must be a simulator udid')
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
  }

  #requireTrusted(req: IncomingMessage, requireOrigin = false): void {
    if (!isTrustedRequest(req, requireOrigin)) {
      throw new RouteError(403, 'the dsh-ios route requires a loopback trusted browser request')
    }
  }

  #answerError(res: ServerResponse, error: unknown): void {
    const status = error instanceof RouteError ? error.status : 500
    const message = errorMessage(error)
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, status, { ok: false, error: message })
  }

  /**
   * Open an HTTP client request against serve-sim's streamUrl and pipe the
   * multipart body through unchanged. The upstream request is destroyed and
   * the consumer refcount released on client disconnect OR upstream end.
   */
  #proxyStream(info: SimStreamInfo, res: ServerResponse, release: () => void): void {
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
    const get = info.streamUrl.startsWith('https:') ? httpsGet : httpGet
    const upstream = get(info.streamUrl)
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
 * Register the six plugin routes on any webserver-shaped carrier. Each
 * (kind, path) is registered exactly once; the returned disposer unregisters
 * all of them and tears down every open response/relay.
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
      kind: 'exact',
      path: GRANT_ROUTE_PATH,
      handler: (req, res) => routes.handleGrant(req, res),
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
 * destroys every open stream/relay.
 */
export function installStreamRoutes(ctx: Context, simHost: SimHostController): void {
  ctx.inject(['webServer'], webCtx => webCtx.effect(() => {
    const webServer = (webCtx as Context & { webServer: StreamRouteMount }).webServer
    const access = new StreamAccessController()
    const routes = new StreamRoutes(simHost, access)
    const detach = access.attachRoute()
    const dispose = mountStreamRoutes(webServer, routes)
    return () => {
      dispose()
      detach()
    }
  }, 'dsh-ios: stream routes'))
}
