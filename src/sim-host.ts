/**
 * Host-side lifecycle manager for a `serve-sim` iOS Simulator stream.
 *
 * `serve-sim` is a CLI that streams a booted simulator (MJPEG/H.264 over
 * HTTP plus a WebSocket control channel). This module resolves the binary,
 * owns one foreground child per stream, shares launches between concurrent
 * callers, keeps the stream alive across crashes, and applies an idle
 * timeout when no consumer (web-route proxy) is holding it open.
 *
 * CAUTION: `serve-sim --detach` may kill whatever already listens on its
 * port ("Port 3100 busy, killing listener pid(s): …"). We therefore always
 * run in NON-detached (foreground) mode so the child is ours to reap, and
 * on a dedicated port range (starting at 3181) so a user's own serve-sim
 * instance on 3100 is never touched.
 *
 * Orphan recovery: if a previous DSH host was killed ungracefully, the
 * serve-sim helper it spawned survives and keeps serving the device. A new
 * host that requests the same device gets a handshake reporting the *old*
 * port; that handshake is adopted as authoritative (see `#launchStream`).
 * A handshake reporting a *different* device means a stale helper is
 * squatting on the slot: it is reclaimed via `serve-sim -k` and the launch
 * is retried once.
 * @module @zseven-w/dsh-ios/sim-host
 */

import {
  execFile,
  spawn,
  type ChildProcessByStdio,
} from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { delimiter, dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { bootDevice } from './simctl.js'

/** serve-sim stream child: no stdin, piped stdout/stderr. */
type StreamChild = ChildProcessByStdio<null, Readable, Readable>

/**
 * Classification of one `#launchStream` attempt from the printed handshake:
 * - `own`: the child serves the requested device on the requested port;
 * - `adopted`: same device, different port — the child was a short-lived
 *   CLI that deferred to a pre-existing (orphaned) helper; adopt that one;
 * - `mismatch`: the handshake names a different device — a stale helper is
 *   squatting on the slot and must be reclaimed before a retry.
 */
type StreamLaunchOutcome =
  | { kind: 'own'; info: SimStreamInfo }
  | { kind: 'adopted'; info: SimStreamInfo }
  | { kind: 'mismatch'; info: SimStreamInfo }

/** The JSON handshake printed by `serve-sim --quiet` once a stream is up. */
export interface SimStreamInfo {
  url: string
  streamUrl: string
  wsUrl: string
  port: number
  device: string
}

export interface SimHostOptions {
  /** First port to try for the stream (default 3181). */
  portRangeStart?: number
  /** Minimum delay before a crashed stream is restarted (default 5000 ms). */
  restartDelayMs?: number
  /** Stop the stream after this long with zero consumers (default 5 min, 0 disables). */
  idleTimeoutMs?: number
  /** Timeout for serve-sim's startup handshake (default 120 s). */
  startTimeoutMs?: number
}

export interface SimHostStatus {
  available: boolean
  running: boolean
  device?: string
  port?: number
  startedAt?: number
  restarts: number
  lastError?: string
  /** Which serve-sim launcher is (or would be) used. */
  serveSimSource: 'package-bin' | 'npx' | 'unavailable'
  /** Resolved command path ('npx' when the npx fallback is in use). */
  serveSimCommand?: string
  /** Active consumers holding the stream alive (acquire/release refcount). */
  consumers: number
  /** True when the stream is an adopted pre-existing helper, not our child. */
  adopted?: boolean
  /** Recent child stderr lines (ring buffer) for diagnostics. */
  stderr: string[]
}

export type ServeSimBinarySource = 'package-bin' | 'npx' | 'unavailable'

/** How serve-sim is launched: installed bin, npx fallback, or not at all. */
export interface ServeSimBinary {
  available: boolean
  source: ServeSimBinarySource
  /** Command for execFile: absolute bin path (package-bin) or the npx path. */
  command?: string
  /** Args prefixed to every invocation (e.g. `['-y', 'serve-sim']` for npx). */
  args: string[]
  /** Why the binary is unavailable (non-macOS, missing npx, …). */
  reason?: string
}

const SERVE_SIM_PACKAGE = 'serve-sim'
const STREAM_PORT_RANGE_START = 3181
const STREAM_PORT_RANGE_LENGTH = 64
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_RESTART_DELAY_MS = 5_000
const DEFAULT_START_TIMEOUT_MS = 120_000
const KEEP_ALIVE_TICK_MS = 1_000
const STOP_TIMEOUT_MS = 10_000
const CONTROL_TIMEOUT_MS = 30_000
const MAX_HANDSHAKE_BYTES = 16 * 1024
const STDERR_RING_LINES = 40
const STDERR_LINE_MAX_CHARS = 240
/** How long a port-shifted handshake may watch its child before classifying. */
const ADOPT_GRACE_MS = 1_500
/** Timeout for the HTTP liveness probe against an adopted helper. */
const ADOPTED_PROBE_TIMEOUT_MS = 2_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function isExecutableFile(path: string): boolean {
  try {
    const info = statSync(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, command)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Locate a dependency's `package.json`, bypassing restrictive `exports` maps.
 *
 * `serve-sim` 0.1.45 declares an `exports` map with no `.` or `./package.json`
 * entry, so the standard `require.resolve('serve-sim/package.json')` throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` on a real install and the package would
 * silently degrade to the npx fallback. Try `require.resolve` first (it
 * handles exotic linkers), then walk `node_modules` directories upward from
 * this module — the same lookup Node itself uses — which ignores `exports`
 * entirely and finds hoisted, nested, or symlinked installs.
 */
function resolvePackageManifest(packageName: string): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(`${packageName}/package.json`)
  } catch {
    // `exports`-blocked or not resolvable through the resolver — walk up.
  }
  let current = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(current, 'node_modules', packageName, 'package.json')
    if (isFile(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Resolve `serve-sim`'s `bin` entry from an installed package.json. */
function tryResolvePackageBin(): string | undefined {
  const manifestPath = resolvePackageManifest(SERVE_SIM_PACKAGE)
  if (manifestPath === undefined) return undefined
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const bin = manifest.bin
    let binPath: string | undefined
    if (typeof bin === 'string') binPath = bin
    else if (typeof bin === 'object' && bin !== null && !Array.isArray(bin)) {
      const candidate = (bin as Record<string, unknown>)[SERVE_SIM_PACKAGE]
      if (typeof candidate === 'string') binPath = candidate
    }
    if (binPath === undefined) return undefined
    const resolved = join(dirname(manifestPath), binPath)
    return isExecutableFile(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve how to launch serve-sim:
 * 1. the locally installed package bin (`serve-sim/package.json` → bin);
 * 2. the `npx -y serve-sim` fallback when the package is not installed;
 * 3. an explicit `available === false` result on non-macOS or when nothing
 *    resolves (mirrors openpencil's missing-binary handling).
 */
export function resolveServeSimBinary(): ServeSimBinary {
  if (process.platform !== 'darwin') {
    return { available: false, source: 'unavailable', args: [], reason: 'serve-sim only runs on macOS' }
  }
  const packageBin = tryResolvePackageBin()
  if (packageBin !== undefined) {
    return { available: true, source: 'package-bin', command: packageBin, args: [] }
  }
  const npx = findOnPath('npx')
  if (npx === undefined) {
    return { available: false, source: 'unavailable', args: [], reason: 'serve-sim is not installed and npx is not on PATH' }
  }
  return { available: true, source: 'npx', command: npx, args: ['-y', SERVE_SIM_PACKAGE] }
}

/**
 * Parse the JSON handshake printed by `serve-sim --quiet` once a stream is
 * up. Only structure is validated here; device/port reconciliation against
 * the launch request happens in `#launchStream`, where a same-device port
 * shift is adopted and a device mismatch triggers a stale-helper reclaim.
 */
function parseServeSimHandshake(line: string): SimStreamInfo {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('serve-sim returned a non-JSON handshake')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('serve-sim returned an invalid handshake')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.url !== 'string' || !/^https?:\/\//.test(record.url)
    || typeof record.streamUrl !== 'string' || !/^https?:\/\//.test(record.streamUrl)
    || typeof record.wsUrl !== 'string' || !/^wss?:\/\//.test(record.wsUrl)
    || typeof record.port !== 'number' || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535
    || typeof record.device !== 'string' || record.device === ''
  ) {
    throw new Error('serve-sim returned an incomplete handshake')
  }
  return {
    url: record.url,
    streamUrl: record.streamUrl,
    wsUrl: record.wsUrl,
    port: record.port,
    device: record.device,
  }
}

function waitForStreamHandshake(
  child: StreamChild,
  timeoutMs: number,
  diagnostics: () => string,
): Promise<SimStreamInfo> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    const finish = (error?: Error, info?: SimStreamInfo): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('close', onClose)
      if (error !== undefined) reject(error)
      else resolve(info!)
    }
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_HANDSHAKE_BYTES) {
        finish(new Error('serve-sim handshake exceeded its size limit'))
        return
      }
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      try {
        finish(undefined, parseServeSimHandshake(stdout.slice(0, newline).trim()))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const onError = (error: Error): void => { finish(error) }
    const onClose = (code: number | null): void => {
      const detail = diagnostics()
      finish(new Error(
        `serve-sim exited before streaming (code ${String(code)})${detail === '' ? '' : `: ${detail}`}`,
      ))
    }
    const timer = setTimeout(() => {
      const detail = diagnostics()
      finish(new Error(
        `serve-sim did not print its handshake within ${timeoutMs} ms${detail === '' ? '' : `: ${detail}`}`,
      ))
    }, timeoutMs)
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

function waitForChildClose(child: StreamChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>(resolveClosed => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('close', onClose)
      resolveClosed(value)
    }
    const onClose = (): void => { finish(true) }
    const timer = setTimeout(() => { finish(false) }, timeoutMs)
    child.once('close', onClose)
  })
}

/**
 * Kill the whole serve-sim process group (npx wrapper, CLI, stream helper).
 * The child is spawned detached so it leads its own group; signalling the
 * group reaps every layer instead of only the npx wrapper.
 */
function signalProcessGroup(child: StreamChild, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) {
    child.kill(signal)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    child.kill(signal)
  }
}

async function killProcessGroup(child: StreamChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  signalProcessGroup(child, 'SIGTERM')
  const closed = await waitForChildClose(child, timeoutMs)
  if (!closed && child.exitCode === null && child.signalCode === null) {
    signalProcessGroup(child, 'SIGKILL')
    return waitForChildClose(child, timeoutMs)
  }
  return closed
}

function canBindLoopbackPort(port: number): Promise<boolean> {
  return new Promise(resolveBind => {
    const probe = createServer()
    probe.unref()
    probe.once('error', () => resolveBind(false))
    probe.listen({ host: '127.0.0.1', port }, () => {
      probe.close(() => resolveBind(true))
    })
  })
}

/**
 * Cheap liveness probe for an adopted helper: a GET request against the
 * helper host, using the `/helper/<device>/health` route derived from the
 * adopted streamUrl (the MJPEG route itself only answers while frames flow,
 * so it is not a reliable probe). Any HTTP response counts as alive (the
 * helper answered); connection errors or a stalled socket count as dead.
 */
function adoptedProbeUrl(info: SimStreamInfo): string {
  const health = info.streamUrl.replace(/\/stream\.mjpeg$/, '/health')
  if (health !== info.streamUrl) return health
  try {
    return `${new URL(info.streamUrl).origin}/`
  } catch {
    return info.url
  }
}

function probeHttpAlive(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolveProbe => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveProbe(value)
    }
    const req = httpRequest(url, { method: 'GET', timeout: timeoutMs }, res => {
      res.on('error', () => {})
      res.destroy()
      finish(true)
    })
    req.on('error', () => finish(false))
    req.on('timeout', () => {
      req.destroy()
      finish(false)
    })
    const timer = setTimeout(() => {
      req.destroy()
      finish(false)
    }, timeoutMs)
    timer.unref?.()
    req.end()
  })
}

/** Run serve-sim with the given args through one resolved binary. */
function execServeSim(
  binary: ServeSimBinary,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary.command!, [...binary.args, ...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim()
        // `error.code` is null whenever the child died from a signal, which is
        // exactly what a timeout looks like — so reporting the code alone turns
        // every timeout into the useless string "failed (null)". Name the cause
        // instead: a killed child is a timeout, a signalled one says which
        // signal, and only a real exit reports its status.
        const killed = (error as { killed?: boolean }).killed === true
        const signal = (error as { signal?: string | null }).signal ?? null
        const cause = killed
          ? `timed out after ${timeoutMs} ms`
          : signal !== null
            ? `killed by ${signal}`
            : `exit ${String(error.code)}`
        reject(new Error(
          `serve-sim ${args.join(' ')} failed (${cause})${detail === '' ? '' : `: ${detail}`}`,
        ))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/** Lifecycle manager for one booted-simulator serve-sim stream. */
export class SimHostController {
  readonly binary: ServeSimBinary
  readonly #options: Required<SimHostOptions>
  #child: StreamChild | undefined
  #info: SimStreamInfo | undefined
  #starting: Promise<SimStreamInfo> | undefined
  #launchQueue: Promise<void> = Promise.resolve()
  #consumers = 0
  #keepAliveRunning = false
  #keepAliveTimer: ReturnType<typeof setInterval> | undefined
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #restarts = 0
  #startedAt: number | undefined
  #exitAt: number | undefined
  #lastError: string | undefined
  #lastDevice: string | undefined
  #intentionalStop = false
  #lastStopAt = 0
  #disposed = false
  #disposePromise: Promise<void> | undefined
  #stderrRing: string[] = []
  #stderrPartial = ''
  /** True while the stream is an adopted helper instead of an owned child. */
  #adopted = false
  /** Guards against overlapping liveness probes of the adopted helper. */
  #probeInFlight = false
  /**
   * Bumped by `stop()`; an in-flight launch whose handshake classification
   * resumes afterwards must not land (e.g. adopt a helper after a stop).
   */
  #launchEpoch = 0

  constructor(options: SimHostOptions = {}) {
    this.binary = resolveServeSimBinary()
    this.#options = {
      portRangeStart: options.portRangeStart ?? STREAM_PORT_RANGE_START,
      restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    }
    if (!Number.isSafeInteger(this.#options.portRangeStart) || this.#options.portRangeStart < 1024 || this.#options.portRangeStart > 65535) {
      throw new RangeError('dsh-ios: portRangeStart must be an integer between 1024 and 65535')
    }
  }

  get available(): boolean {
    return this.binary.available
  }

  /**
   * True while a stream is available: either a live owned child whose
   * handshake is current, or an adopted helper that has not been stopped
   * (its liveness is verified by the keep-alive probe).
   */
  get running(): boolean {
    const child = this.#child
    if (child !== undefined && child.exitCode === null && child.signalCode === null && this.#info !== undefined) {
      return true
    }
    return this.#adopted && this.#info !== undefined
  }

  /**
   * The live stream's handshake (url/streamUrl/wsUrl/port/device), or undefined
   * when nothing is streaming. Read-only and non-starting on purpose: the
   * gesture path (src/sim-gesture.ts) needs `wsUrl` for the control socket but
   * must NOT launch a stream to get it — a tool call can arrive before the
   * stream exists, and then it falls back to the serve-sim CLI.
   */
  get streamInfo(): SimStreamInfo | undefined {
    return this.running ? this.#info : undefined
  }

  /**
   * Boot the simulator if needed and make sure one serve-sim stream child is
   * alive for it. Concurrent callers share a single launch; callers for a
   * different device wait for the current one to be replaced.
   */
  async ensureRunning({ udid }: { udid: string }): Promise<SimStreamInfo> {
    if (this.#disposed) throw new Error('dsh-ios: sim host is disposed')
    if (typeof udid !== 'string' || udid === '') throw new TypeError('dsh-ios: ensureRunning requires a non-empty udid')
    const startFor = async (): Promise<SimStreamInfo> => {
      const current = this.#child
      if (current !== undefined && current.exitCode === null && current.signalCode === null && this.#info?.device === udid) {
        return this.#info
      }
      const adoptedInfo = this.#adopted ? this.#info : undefined
      if (adoptedInfo !== undefined && adoptedInfo.device === udid) {
        // The adopted helper already serves this device; keep the adoption.
        return adoptedInfo
      }
      if (current !== undefined && current.exitCode === null && current.signalCode === null) {
        // Another device is streaming; retire it before taking over its slot.
        await killProcessGroup(current, STOP_TIMEOUT_MS)
        // The retirement is intentional: drop the exit timestamp the close
        // handler recorded so keep-alive cannot resurrect the old device
        // while this switch is still in flight.
        this.#exitAt = undefined
        this.#intentionalStop = true
      }
      if (adoptedInfo !== undefined) {
        // Another device's adopted helper is current; reap it through
        // serve-sim (no child to signal) before taking over its slot.
        this.#adopted = false
        this.#info = undefined
        if (this.binary.available) {
          await execServeSim(this.binary, ['-k', adoptedInfo.device], CONTROL_TIMEOUT_MS).catch(() => {})
        }
      }
      const info = await this.#startFor(udid)
      this.#lastDevice = udid
      return info
    }
    let starting = this.#starting
    if (starting !== undefined) {
      try {
        await starting
      } catch {
        // A failed shared launch is still a settled one; retry below.
      }
      if (this.#info !== undefined && this.#info.device === udid && this.running) {
        this.#armIdle()
        return this.#info
      }
      starting = undefined
    }
    if (starting === undefined) {
      starting = this.#serializeLaunch(startFor)
      this.#starting = starting
    }
    try {
      const info = await starting
      this.#lastError = undefined
      this.#armIdle()
      return info
    } catch (error) {
      this.#lastError = errorMessage(error)
      throw error
    } finally {
      if (this.#starting === starting) this.#starting = undefined
    }
  }

  /**
   * Start the crash keep-alive loop. While enabled, a stream that exited on
   * its own is restarted in the background after `restartDelayMs`; intentional
   * `stop()` calls are never fought.
   */
  startKeepAlive(): void {
    if (this.#keepAliveRunning || this.#disposed) return
    this.#keepAliveRunning = true
    const tick = (): void => {
      if (this.#disposed || !this.#keepAliveRunning) return
      void this.#keepAliveTick().catch(() => {})
    }
    this.#keepAliveTimer = setInterval(tick, KEEP_ALIVE_TICK_MS)
    this.#keepAliveTimer.unref?.()
  }

  /** Stop the keep-alive loop. */
  stopKeepAlive(): void {
    this.#keepAliveRunning = false
    if (this.#keepAliveTimer !== undefined) clearInterval(this.#keepAliveTimer)
    this.#keepAliveTimer = undefined
  }

  /**
   * Stop the stream child. Intentional: the keep-alive loop will not bring it
   * back until the next `ensureRunning` or `restart`.
   */
  async stop(): Promise<void> {
    this.#clearIdle()
    this.#intentionalStop = true
    this.#lastStopAt = Date.now()
    const child = this.#child
    const udid = this.#info?.device ?? this.#lastDevice
    const adopted = this.#adopted
    this.#child = undefined
    this.#info = undefined
    this.#startedAt = undefined
    this.#exitAt = undefined
    this.#adopted = false
    this.#launchEpoch += 1
    if (child === undefined) {
      // An in-flight launch may still land; reap it once it settles.
      await this.#starting?.catch(() => {})
      const landed = this.#child
      if (landed !== undefined) {
        this.#child = undefined
        this.#info = undefined
        this.#startedAt = undefined
        await killProcessGroup(landed, STOP_TIMEOUT_MS)
      }
      if (adopted && udid !== undefined && this.binary.available) {
        // The adopted helper is not our child; reap it through serve-sim.
        await execServeSim(this.binary, ['-k', udid], CONTROL_TIMEOUT_MS).catch(() => {})
      }
      return
    }
    const closed = await killProcessGroup(child, STOP_TIMEOUT_MS)
    if (adopted && udid !== undefined && this.binary.available) {
      // The adopted helper is not our child; reap it through serve-sim.
      await execServeSim(this.binary, ['-k', udid], CONTROL_TIMEOUT_MS).catch(() => {})
    } else if (!closed && udid !== undefined && this.binary.available) {
      // Last-resort: ask serve-sim itself to reap any survivor for this device.
      await execServeSim(this.binary, ['-k', udid], CONTROL_TIMEOUT_MS).catch(() => {})
    }
  }

  /** Stop (if running) and start again, defaulting to the current device. */
  async restart(udid?: string): Promise<SimStreamInfo> {
    const device = udid ?? this.#info?.device ?? this.#lastDevice
    if (device === undefined) {
      throw new Error('dsh-ios: restart requires a device; call ensureRunning first')
    }
    await this.stop()
    // An explicit restart is intentional: don't sit out the crash-quiet period.
    this.#lastStopAt = 0
    return this.ensureRunning({ udid: device })
  }

  /** Snapshot of lifecycle state, launcher, refcount and recent stderr. */
  status(): SimHostStatus {
    return {
      available: this.available,
      running: this.running,
      ...(this.#info === undefined ? {} : { device: this.#info.device, port: this.#info.port }),
      ...(this.#startedAt === undefined ? {} : { startedAt: this.#startedAt }),
      restarts: this.#restarts,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      serveSimSource: this.binary.source,
      ...(this.binary.command === undefined ? {} : { serveSimCommand: this.binary.command }),
      consumers: this.#consumers,
      ...(this.#adopted ? { adopted: true } : {}),
      stderr: [...this.#stderrRing],
    }
  }

  /**
   * Run a serve-sim control subcommand (`tap`, `gesture`, `type`, `button`,
   * `-l`, `-k`, …) through the same binary resolution used for the stream.
   */
  async control(args: readonly string[], options: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    if (!this.binary.available) {
      throw new Error(`dsh-ios: serve-sim is unavailable${this.binary.reason === undefined ? '' : ` (${this.binary.reason})`}`)
    }
    return execServeSim(this.binary, args, options.timeoutMs ?? CONTROL_TIMEOUT_MS)
  }

  /**
   * Hold the stream alive for one consumer (the web-route proxy uses this).
   * Returns a release function; each acquire must be released exactly once.
   */
  acquire(): () => void {
    this.#consumers += 1
    this.#armIdle()
    let released = false
    return () => {
      if (released) return
      released = true
      this.#consumers = Math.max(0, this.#consumers - 1)
      this.#armIdle()
    }
  }

  /** Tear down for plugin disposal: kill the child, refuse new work. */
  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposed = true
    this.stopKeepAlive()
    this.#disposePromise = (async () => {
      // Let an in-flight shared launch settle so its child is visible to
      // stop(); it observes `disposed` and will not start another stream.
      await this.#starting?.catch(() => {})
      await this.stop()
      await this.#launchQueue
    })()
    return this.#disposePromise
  }

  async #keepAliveTick(): Promise<void> {
    const now = Date.now()
    if (this.#disposed) return
    if (this.#adopted) {
      // The adopted helper is not our child; its health is watched over
      // HTTP at the same cadence instead of via child exit events.
      await this.#probeAdoptedHelper()
      return
    }
    const exitAt = this.#exitAt
    const device = this.#lastDevice
    if (exitAt === undefined || this.#intentionalStop || device === undefined) return
    if (now - exitAt < this.#options.restartDelayMs) return
    if (!this.binary.available) return
    this.#exitAt = undefined
    this.#restarts += 1
    try {
      await this.ensureRunning({ udid: device })
    } catch (error) {
      this.#lastError = errorMessage(error)
      // A failed launch exits again and sets a fresh exitAt via the child's
      // close handler; only re-arm here if no child ever recorded an exit.
      if (this.#exitAt === undefined) this.#exitAt = Date.now()
    }
  }

  /**
   * Poll the adopted helper's health route (derived from the stream URL)
   * with a cheap GET request. When it no longer answers, record the death
   * like a child exit so the keep-alive loop respawns a fresh (owned)
   * stream after the usual restart delay.
   */
  async #probeAdoptedHelper(): Promise<void> {
    const info = this.#info
    if (info === undefined || this.#intentionalStop || this.#disposed || this.#probeInFlight) return
    this.#probeInFlight = true
    try {
      const alive = await probeHttpAlive(adoptedProbeUrl(info), ADOPTED_PROBE_TIMEOUT_MS)
      if (alive) return
      if (this.#disposed || this.#intentionalStop || this.#info !== info) return
      this.#noteStderr(`adopted serve-sim helper for ${info.device} no longer answers on ${info.streamUrl}; respawning after the restart delay`)
      this.#info = undefined
      this.#startedAt = undefined
      this.#adopted = false
      this.#exitAt = Date.now()
    } finally {
      this.#probeInFlight = false
    }
  }

  async #startFor(udid: string, reclaim = false): Promise<SimStreamInfo> {
    if (this.#disposed) throw new Error('dsh-ios: sim host is disposed')
    if (!this.binary.available) {
      throw new Error(`dsh-ios: serve-sim is unavailable${this.binary.reason === undefined ? '' : ` (${this.binary.reason})`}`)
    }
    // Sit out the quiet period after an intentional stop so a racing launch
    // cannot immediately undo it (explicit restart() clears this period).
    const sinceStop = Date.now() - this.#lastStopAt
    if (sinceStop < this.#options.restartDelayMs) {
      await sleep(this.#options.restartDelayMs - sinceStop)
    }
    await bootDevice(udid)
    if (this.#disposed) throw new Error('dsh-ios: sim host is disposed')
    const port = await this.#findFreePort()
    const outcome = await this.#launchStream(udid, port)
    if (outcome.kind === 'mismatch') {
      // A stale helper answered for a different device. Reclaim it and
      // respawn exactly once per ensureRunning call; a second mismatch is
      // surfaced as the same error the strict validator used to raise.
      if (reclaim) {
        throw new Error(`serve-sim targeted ${outcome.info.device} instead of ${udid}`)
      }
      this.#noteStderr(`serve-sim reported device ${outcome.info.device} instead of ${udid}; reclaiming the stale helper`)
      await this.#reclaimStaleHelper(outcome.info.device)
      return this.#startFor(udid, true)
    }
    this.#info = outcome.info
    this.#startedAt = Date.now()
    this.#exitAt = undefined
    this.#intentionalStop = false
    this.#adopted = outcome.kind === 'adopted'
    if (outcome.kind === 'adopted') {
      this.#noteStderr(`adopted existing serve-sim helper for ${udid} on port ${outcome.info.port} (requested ${port})`)
    }
    return outcome.info
  }

  /**
   * Ask serve-sim itself to reap a helper we do not own (`-k <udid>`, with
   * a blanket `-k` as the last resort when the targeted kill errors out).
   */
  async #reclaimStaleHelper(udid: string): Promise<void> {
    if (!this.binary.available) return
    try {
      await execServeSim(this.binary, ['-k', udid], CONTROL_TIMEOUT_MS)
    } catch {
      // Last resort: reap every helper serve-sim knows about.
      await execServeSim(this.binary, ['-k'], CONTROL_TIMEOUT_MS).catch(() => {})
    }
  }

  async #findFreePort(): Promise<number> {
    const start = this.#options.portRangeStart
    for (let offset = 0; offset < STREAM_PORT_RANGE_LENGTH; offset += 1) {
      const port = start + offset
      if (port > 65535) break
      if (await canBindLoopbackPort(port)) return port
    }
    throw new Error(`dsh-ios: no free port for serve-sim in range ${start}..${start + STREAM_PORT_RANGE_LENGTH - 1}`)
  }

  #launchStream(udid: string, port: number): Promise<StreamLaunchOutcome> {
    const child = spawn(this.binary.command!, [
      ...this.binary.args,
      '--no-preview',
      '--quiet',
      '--port', String(port),
      udid,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Group leader so stop() can reap npx → CLI → stream helper at once.
      detached: true,
    })
    this.#child = child
    const epoch = this.#launchEpoch
    child.stderr.on('data', (chunk: Buffer) => this.#recordStderr(chunk))
    child.once('close', () => {
      if (this.#child !== child) return
      this.#child = undefined
      this.#info = undefined
      this.#startedAt = undefined
      this.#exitAt = Date.now()
    })
    const launched = waitForStreamHandshake(
      child,
      this.#options.startTimeoutMs,
      () => this.#stderrRing.join('\n'),
    )
    return launched.then(async (info): Promise<StreamLaunchOutcome> => {
      if (this.#launchEpoch !== epoch) {
        // A stop() raced this launch; do not adopt or claim anything.
        throw new Error('dsh-ios: serve-sim launch was superseded by stop()')
      }
      if (info.device !== udid) {
        // A stale helper is serving a different device from the slot we
        // asked for. Kill the launched child (it owns the helper when it is
        // still streaming it) and let the caller reclaim + retry once.
        await killProcessGroup(child, STOP_TIMEOUT_MS)
        return { kind: 'mismatch', info }
      }
      if (info.port !== port) {
        // Same device, different port: the child either deferred to a
        // pre-existing helper (it exits right after printing the handshake)
        // or its helper landed on another port (it keeps running). Watch
        // the child briefly to tell the two apart.
        const childExited = await Promise.race([
          waitForChildClose(child, ADOPT_GRACE_MS),
          sleep(ADOPT_GRACE_MS).then(() => false),
        ])
        if (this.#launchEpoch !== epoch) {
          throw new Error('dsh-ios: serve-sim launch was superseded by stop()')
        }
        return childExited ? { kind: 'adopted', info } : { kind: 'own', info }
      }
      return { kind: 'own', info }
    }, async (error: unknown): Promise<never> => {
      await killProcessGroup(child, STOP_TIMEOUT_MS)
      throw error instanceof Error ? error : new Error(String(error))
    })
  }

  #recordStderr(chunk: Buffer): void {
    const text = this.#stderrPartial + chunk.toString('utf8')
    const lines = text.split('\n')
    this.#stderrPartial = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trimEnd()
      this.#stderrRing.push(trimmed.length > STDERR_LINE_MAX_CHARS ? `${trimmed.slice(0, STDERR_LINE_MAX_CHARS)}…` : trimmed)
      if (this.#stderrRing.length > STDERR_RING_LINES) this.#stderrRing.shift()
    }
  }

  /** Append a controller-authored diagnostic line to the stderr ring. */
  #noteStderr(line: string): void {
    this.#stderrRing.push(line.length > STDERR_LINE_MAX_CHARS ? `${line.slice(0, STDERR_LINE_MAX_CHARS)}…` : line)
    if (this.#stderrRing.length > STDERR_RING_LINES) this.#stderrRing.shift()
  }

  #armIdle(): void {
    this.#clearIdle()
    const idleMs = this.#options.idleTimeoutMs
    if (idleMs <= 0) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      if (this.#consumers > 0) {
        this.#armIdle()
        return
      }
      void this.stop()
    }, idleMs)
    this.#idleTimer.unref?.()
  }

  #clearIdle(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
  }

  #serializeLaunch<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#launchQueue.then(task, task)
    // A failed launch must not poison the lifecycle queue for later requests.
    this.#launchQueue = run.then(() => undefined, () => undefined)
    return run
  }
}
