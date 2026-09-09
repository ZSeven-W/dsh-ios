/**
 * Physical-device support for the element-bound targeted-text client.
 *
 * This module provides the two physical-only pieces the
 * `performWdaTargetedText` client contract requires, WITHOUT ever
 * starting, adopting, or killing WebDriverAgent:
 *
 * - `readPhysicalAppIdentity` — an independent CoreDevice (`xcrun devicectl`)
 *   reader proving a RUNNING process identity: the requested bundle has an
 *   on-device process at a specific pid. devicectl's process schema carries
 *   only {processIdentifier, executable}; it has NO frontmost/foreground
 *   field, so this reader is NEVER labeled frontmost proof. Ambiguity
 *   (several processes enriched with the same bundle id and no expectedPID
 *   pin) fails closed.
 * - `createPhysicalTargetedTransport` — a one-shot owned transport: a FRESH
 *   127.0.0.1 usbmux forward to the device's already-running WDA control
 *   port plus a raw HTTP request function. `dispose()` closes ONLY the
 *   forward this call created. Existing tunnels, runners, and WDA processes
 *   are never adopted, probed-as-alive, or killed, and xcodebuild is never
 *   spawned by this module.
 *
 * Listener exposure (the enforceable boundary):
 * - HOST side: the forward binds 127.0.0.1 only (no host override exists in
 *   this module's API) and every request targets http://127.0.0.1:<port>,
 *   so no targeted-text traffic leaves the host loopback interface.
 * - DEVICE side: the WDA listener's own interface binding is not under our
 *   control and cannot be proven loopback-only (cached FBWebServer.m applies
 *   bindingIPAddress only when configured; ServerURLHere may advertise the
 *   Wi-Fi IP). This module therefore NEVER claims device-side listener
 *   privacy; the enforceable privacy boundary is the host loopback usbmux
 *   tunnel.
 *
 * If no WDA is listening on the device port, every request fails closed
 * before any mutation can be dispatched (usbmux Connect refuses the
 * per-connection channel and the HTTP request errors).
 *
 * @module @zseven-w/dsh-ios/wda-physical-target
 */

import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import {
  classifyUsbmuxTunnelFailure,
  createUsbmuxForward,
  usbmuxTunnelFailureDetail,
  type UsbmuxForward,
} from './usbmux.js'
import { listProcesses as devicectlListProcesses, type RealProcess } from './devicectl.js'
import type { WdaTargetedTextResponse } from './wda-targeted-text.js'

/** On-device WDA control REST port (the standard WDA port). */
export const PHYSICAL_WDA_CONTROL_PORT = 8100
/**
 * Local loopback port range for the one-shot forward. Deliberately separate
 * from WdaController's 8100/9100 ranges and never probed for adoption: a
 * busy port is skipped, an existing tunnel is never reused.
 */
export const PHYSICAL_TARGETED_PORT_START = 18200
export const PHYSICAL_TARGETED_PORT_RANGE = 64
export const PHYSICAL_TARGETED_REQUEST_TIMEOUT_MS = 30_000
export const PHYSICAL_TARGETED_MAX_BODY_BYTES = 8 * 1024 * 1024

// ── Independent CoreDevice identity reader ────────────────────────────────────

/**
 * One independent CoreDevice identity sample. `verified:true` proves ONLY
 * that the requested bundle has a RUNNING on-device process at `pid` — it
 * never proves frontmost/foreground (devicectl exposes no such signal).
 */
export interface PhysicalAppIdentityResult {
  bundleId?: string
  pid?: number
  verified: boolean
  /** Stable classification of an unverified sample. */
  capability?: string
  /** Safe human reason; never embeds raw tool output. */
  reason?: string
}

export interface PhysicalAppIdentityTarget {
  bundleId: string
  /** When present, the sample pins exactly this pid (disambiguates). */
  expectedPID?: number
}

/** Injectable process lister (tests only; defaults to devicectl). */
export type PhysicalListProcesses = (
  udid: string,
  signal?: AbortSignal,
) => Promise<RealProcess[]>

/**
 * Sample the independent CoreDevice process identity for one bundle.
 *
 * Semantics (fail closed):
 * - no enriched process for the bundle → unverified `not-running`
 * - expectedPID present → the sample is verified ONLY when exactly that pid
 *   runs with the requested bundle; a missing pid is `pid-absent`, a pid
 *   running another bundle is `pid-mismatch`
 * - expectedPID absent → verified only for EXACTLY ONE enriched process;
 *   several matches are `ambiguous` and callers must pin an expectedPID
 * - a failed/absent reader → unverified `unavailable`
 */
export async function readPhysicalAppIdentity(
  udid: string,
  target: PhysicalAppIdentityTarget,
  options: { signal?: AbortSignal; listProcesses?: PhysicalListProcesses } = {},
): Promise<PhysicalAppIdentityResult> {
  const bundleId = target.bundleId
  let processes: RealProcess[]
  try {
    processes = await (options.listProcesses ?? devicectlListProcesses)(udid, options.signal)
  } catch {
    return {
      verified: false,
      capability: 'physical.targeted.identity.unavailable',
      reason: 'the independent CoreDevice process listing is unavailable (devicectl failed or the device is not attached over USB)',
    }
  }
  const expected = target.expectedPID
  if (expected !== undefined) {
    const pinned = processes.find(process => process.pid === expected)
    if (pinned === undefined) {
      return {
        verified: false,
        capability: 'physical.targeted.identity.pid-absent',
        reason: 'no running CoreDevice process has pid ' + String(expected),
      }
    }
    if (pinned.bundleId !== bundleId) {
      return {
        verified: false,
        capability: 'physical.targeted.identity.pid-mismatch',
        reason: 'CoreDevice pid ' + String(expected) + ' is running but is not the requested bundle',
      }
    }
    return { bundleId, pid: expected, verified: true }
  }
  const matches = processes.filter(process => process.bundleId === bundleId)
  if (matches.length === 0) {
    return {
      verified: false,
      capability: 'physical.targeted.identity.not-running',
      reason: 'no running CoreDevice process is enriched with the requested bundle id (the app is not running, or the apps listing could not enrich processes)',
    }
  }
  if (matches.length > 1) {
    return {
      verified: false,
      capability: 'physical.targeted.identity.ambiguous',
      reason: String(matches.length) + ' CoreDevice processes match the bundle id — pin one with expectedPID',
    }
  }
  return { bundleId, pid: matches[0].pid, verified: true }
}

// ── One-shot owned loopback transport ─────────────────────────────────────────

/** Structural one-shot transport for the physical targeted-text client. */
export interface PhysicalTargetedTransport {
  udid: string
  /** Local loopback port of the owned forward. */
  readonly localPort: number
  request(
    method: string,
    path: string,
    body?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<WdaTargetedTextResponse>
  /**
   * Closes ONLY the loopback forward this transport created. Idempotent;
   * never touches WDA processes, runners, or tunnels owned by others.
   */
  dispose(): Promise<void>
}

export interface PhysicalTargetedTransportOptions {
  udid: string
  /** Hardware UDID used only for usbmuxd; `udid` remains the logical identity. */
  hardwareUdid?: string
  /** On-device WDA control port. Defaults to PHYSICAL_WDA_CONTROL_PORT. */
  devicePort?: number
  portStart?: number
  portRangeLength?: number
  requestTimeoutMs?: number
  maxBodyBytes?: number
  signal?: AbortSignal
  /** Test seam: forward factory (defaults to createUsbmuxForward). */
  createForward?: (options: { udid: string; devicePort: number; localPort: number; host: string }) => Promise<UsbmuxForward>
}

/** Typed failure for the one-shot transport with a stable classification. */
export class PhysicalTargetedTransportError extends Error {
  constructor(
    message: string,
    readonly code: 'physical.targeted.transport.unavailable' | 'physical.targeted.transport.cancelled',
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'PhysicalTargetedTransportError'
  }
}

/** Fixed loopback bind host. Deliberately not part of the public options. */
const TRANSPORT_HOST = '127.0.0.1'

/** Fresh abort read (a function call so TS never carries stale narrowing). */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** True when the path contains a control character (never via regex escapes). */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) return true
  }
  return false
}
function assertSafeMethodAndPath(method: string, path: string): void {
  if (!/^[A-Z]+$/.test(method)) {
    throw new TypeError('dsh-ios: targeted transport method must contain only uppercase letters')
  }
  if (typeof path !== 'string' || !path.startsWith('/') || /\s/.test(path) || hasControlCharacters(path)) {
    throw new TypeError('dsh-ios: targeted transport path must be a single encoded URL path')
  }
}

/**
 * Try-bind one free loopback port in the range WITHOUT probing for
 * adoption: an occupied port is skipped, never adopted.
 */
function pickOwnLoopbackPort(start: number, rangeLength: number): Promise<number> {
  if (!Number.isSafeInteger(start) || start < 1024 || start > 65535) {
    return Promise.reject(new RangeError('dsh-ios: portStart must be an integer between 1024 and 65535'))
  }
  if (!Number.isSafeInteger(rangeLength) || rangeLength < 1 || rangeLength > 512) {
    return Promise.reject(new RangeError('dsh-ios: portRangeLength must be an integer between 1 and 512'))
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let offset = 0
    const attempt = (): void => {
      if (offset >= rangeLength || start + offset > 65535) {
        rejectPromise(new Error('dsh-ios: no free loopback port in range ' + start + '..' + Math.min(65535, start + rangeLength - 1)))
        return
      }
      const port = start + offset
      offset += 1
      const probe = createServer()
      probe.unref()
      probe.once('error', () => {
        // EADDRINUSE (or anything else): try the next candidate.
        attempt()
      })
      probe.listen({ host: TRANSPORT_HOST, port }, () => {
        probe.close(() => resolvePromise(port))
      })
    }
    attempt()
  })
}

/** Raw HTTP request to the owned loopback forward. Never retried. */
function rawLoopbackRequest(
  port: number,
  method: string,
  path: string,
  body: unknown,
  requestTimeoutMs: number,
  maxBodyBytes: number,
  signal: AbortSignal | undefined,
): Promise<WdaTargetedTextResponse> {
  assertSafeMethodAndPath(method, path)
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      rejectPromise(error)
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const req = httpRequest(
      {
        hostname: TRANSPORT_HOST,
        port,
        method,
        path,
        headers: payload === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) },
      },
      res => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > maxBodyBytes) {
            res.destroy()
            fail(new Error('dsh-ios: targeted WDA response exceeded the body limit'))
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        res.on('error', error => fail(error))
        res.on('end', () => {
          if (settled) return
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = text
          if (text !== '') {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = text
            }
          }
          settled = true
          // HTTP errors resolve with their status: the client classifies.
          resolvePromise({ statusCode: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.setTimeout(requestTimeoutMs, () => {
      req.destroy(new Error('dsh-ios: targeted WDA request timed out'))
      fail(new Error('dsh-ios: targeted WDA request timed out'))
    })
    signal?.addEventListener('abort', () => {
      req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      fail(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }, { once: true })
    req.on('error', error => fail(error))
    req.end(payload)
  })
}

/**
 * Create the one-shot owned physical transport: a fresh 127.0.0.1 usbmux
 * forward to the device's already-running WDA control port. Never starts
 * WDA, never adopts unrelated tunnels, never kills anything it did not
 * create.
 */
export async function createPhysicalTargetedTransport(
  options: PhysicalTargetedTransportOptions,
): Promise<PhysicalTargetedTransport> {
  const udid = options.udid
  if (typeof udid !== 'string' || udid === '') {
    throw new TypeError('dsh-ios: createPhysicalTargetedTransport requires a non-empty udid')
  }
  if (signalAborted(options.signal)) {
    throw new PhysicalTargetedTransportError('transport creation was cancelled', 'physical.targeted.transport.cancelled')
  }
  const devicePort = options.devicePort ?? PHYSICAL_WDA_CONTROL_PORT
  const hardwareUdid = options.hardwareUdid ?? udid
  if (typeof hardwareUdid !== 'string' || hardwareUdid === '') {
    throw new TypeError('dsh-ios: createPhysicalTargetedTransport requires a non-empty hardwareUdid')
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? PHYSICAL_TARGETED_REQUEST_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? PHYSICAL_TARGETED_MAX_BODY_BYTES
  const localPort = await pickOwnLoopbackPort(
    options.portStart ?? PHYSICAL_TARGETED_PORT_START,
    options.portRangeLength ?? PHYSICAL_TARGETED_PORT_RANGE,
  )
  let forward: UsbmuxForward
  try {
    forward = await (options.createForward ?? createUsbmuxForward)({
      udid: hardwareUdid,
      devicePort,
      localPort,
      host: TRANSPORT_HOST,
    })
  } catch (error) {
    let detail: string | undefined
    try {
      detail = usbmuxTunnelFailureDetail(await classifyUsbmuxTunnelFailure(udid))
    } catch {
      // Classification is best effort; the failure is already fail-closed.
    }
    throw new PhysicalTargetedTransportError(
      'could not create the owned 127.0.0.1 usbmux forward to the device WDA control port',
      'physical.targeted.transport.unavailable',
      detail,
    )
  }
  if (signalAborted(options.signal)) {
    try { await forward.close() } catch { /* the signal wins */ }
    throw new PhysicalTargetedTransportError('transport creation was cancelled', 'physical.targeted.transport.cancelled')
  }
  let disposed = false
  return {
    udid,
    localPort,
    request: (method, path, body, requestOptions) =>
      rawLoopbackRequest(localPort, method, path, body, requestTimeoutMs, maxBodyBytes, requestOptions?.signal),
    dispose: async () => {
      if (disposed) return
      disposed = true
      await forward.close()
    },
  }
}
