/**
 * Model-facing unified-log capture for the iOS Simulator plugin.
 *
 * `ios_sim_logs` wraps `xcrun simctl spawn <udid> log show|stream` in two
 * bounded modes, giving the agent the read-what-the-app-prints ability of
 * XcodeBuildMCP-style log tools:
 *
 * - `snapshot`: recent persisted logs (`log show --last <duration>`);
 * - `follow`: a live capture window (`log stream`) that returns everything
 *   accumulated once `duration_seconds` elapses — a bounded capture, never a
 *   hanging stream: the tool call settles when the window closes.
 *
 * The output is capped *while capturing* (a tail ring of ~300 lines / ~30 KB,
 * with a one-line hint telling the model how to narrow via
 * predicate/bundle_id/grep/duration), so a chatty simulator can never drown
 * the model no matter how much the process emits. The spawned `log` process
 * is reaped on window close, abort, and dispose via a process-group kill —
 * the same pattern sim-host.ts uses for its serve-sim child (xcrun → simctl
 * → log all share the group of the detached group leader).
 *
 * Degradation mirrors tools.ts: the tool always registers, but `execute`
 * throws the shared explanatory error on non-macOS hosts.
 * @module @zseven-w/dsh-ios/tool-logs
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Readable } from 'node:stream'
import type { SimHostController } from './sim-host.js'
import {
  bootedDevices,
  compareRuntimesDesc,
  getDevice,
  type SimulatorDevice,
} from './simctl.js'
import { matchesRealDevice } from './devicectl.js'
import type { SimDeviceInfo } from './tools.js'

/** Error prefix required on non-macOS hosts (same text as tools.ts). */
const SIMULATOR_UNAVAILABLE = 'iOS Simulator requires macOS with Xcode'

/** Output cap: keep the tail of at most ~300 lines / ~30 KB, always. */
const MAX_LOG_LINES = 300
const MAX_LOG_BYTES = 30 * 1024

const DEFAULT_SNAPSHOT_DURATION = '2m'
const DEFAULT_FOLLOW_SECONDS = 10
const MAX_FOLLOW_SECONDS = 60
/** SIGTERM → SIGKILL grace when reaping the log process group. */
const KILL_GRACE_MS = 2_000
/** Hard safety net so a stuck `log show` can never outlive its budget. */
const SNAPSHOT_SAFETY_MS = 8 * 60 * 1000
/** Follow-mode safety net past its own window (kill is idempotent). */
const FOLLOW_SAFETY_GRACE_MS = 30_000
/** stderr diagnostics ring for failure messages. */
const STDERR_RING_LINES = 20
const STDERR_LINE_MAX_CHARS = 240

/** One-line narrowing hint appended to `lines` (uncounted) on truncation. */
const TRUNCATION_HINT = '[dsh-ios: output capped at 300 lines / 30 KB — narrow with the predicate, bundle_id, or grep params, or a smaller duration]'

const SNAPSHOT_DURATION_PATTERN = /^\d{1,4}[smh]$/u
const ANSI_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[A-Za-z]/gu
/** `log show`/`log stream` print these banners, not log lines; drop them. */
const BANNER_PATTERN = /^(?:Filtering the log data using |Timestamp\s+Ty\s+Process\[PID:TID\])/u

export type SimLogsMode = 'snapshot' | 'follow'

export interface SimLogsArgs {
  /** Target simulator udid or device name. Defaults to the streamed/booted device. */
  udid?: string
  /** snapshot = recent persisted logs; follow = bounded live capture. */
  mode?: SimLogsMode
  /** snapshot window for `log show --last` (e.g. "2m", "30s", "1h"). Default "2m". */
  duration?: string
  /** follow window in seconds, 1..60 (values above 60 are clamped). Default 10. */
  duration_seconds?: number
  /** Convenience filter: subsystem == <bundle_id> OR process == <last component>. */
  bundle_id?: string
  /** Raw NSPredicate for --predicate; overrides bundle_id. */
  predicate?: string
  /** Log level threshold: default | info | debug. */
  level?: 'default' | 'info' | 'debug'
  /** Client-side regular expression applied to each captured line. */
  grep?: string
}

export interface SimLogsResult {
  device: SimDeviceInfo
  mode: SimLogsMode
  /** Human-readable capture window, e.g. "last 2m" or "follow 10s". */
  window: string
  /** Number of log lines returned (the truncation hint is not counted). */
  lineCount: number
  /** True when more log lines existed than were returned. */
  truncated: boolean
  /** Tail of captured lines; the final element is the narrowing hint when truncated. */
  lines: string[]
}

/** The tool definitions bound to one sim host controller. */
export interface SimLogTools {
  iosSimLogs: ToolDefinition
}

type LogChild = ChildProcessByStdio<null, Readable, Readable>

interface LogCapture {
  lines: string[]
  truncated: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stripAnsi(text: string): string {
  return ANSI_PATTERN.test(text) ? text.replace(ANSI_PATTERN, '') : text
}

/** Tail ring of cleaned log lines, capped by count AND byte budget while capturing. */
class LogLineRing {
  lines: string[] = []
  bytes = 0
  truncated = false
  #partial = ''

  push(chunk: Buffer): void {
    const text = this.#partial + chunk.toString('utf8')
    const parts = text.split('\n')
    this.#partial = parts.pop() ?? ''
    for (const part of parts) this.#append(part)
    this.#trim()
  }

  /**
   * Flush the trailing unterminated line. A follow window is closed by
   * SIGTERM, so the capture routinely ends mid-line — without this the last
   * (often the most interesting) line was silently dropped.
   */
  flush(): void {
    if (this.#partial === '') return
    this.#append(this.#partial)
    this.#partial = ''
    this.#trim()
  }

  #append(part: string): void {
    const line = stripAnsi(part).trimEnd()
    if (line === '' || BANNER_PATTERN.test(line)) return
    this.lines.push(line)
    this.bytes += Buffer.byteLength(line, 'utf8') + 1
  }

  #trim(): void {
    while (this.lines.length > MAX_LOG_LINES || this.bytes > MAX_LOG_BYTES) {
      const removed = this.lines.shift()
      if (removed === undefined) break
      this.bytes -= Buffer.byteLength(removed, 'utf8') + 1
      this.truncated = true
    }
  }
}

/**
 * Kill the whole log process group (xcrun → simctl → `log`). The child is
 * spawned detached so it leads its own group; signalling the group reaps
 * every layer instead of orphaning the `log` stream (same as sim-host.ts).
 */
function signalProcessGroup(child: LogChild, signal: NodeJS.Signals): void {
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

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(`ios_sim_logs capture aborted${typeof signal.reason === 'string' && signal.reason !== '' ? `: ${signal.reason}` : ''}`)
}

interface RunLogOptions {
  udid: string
  /** 'show' (snapshot) or 'stream' (follow). */
  subcommand: 'show' | 'stream'
  /** Flags after `log <subcommand>`. */
  args: readonly string[]
  /** Follow-mode window: SIGTERM the child after this many ms (normal return). */
  windowMs?: number
  signal: AbortSignal
}

/**
 * Spawn `xcrun simctl spawn <udid> log <subcommand> …` and stream its stdout
 * through the capped ring until the window closes (follow), the child exits
 * (snapshot), or the caller's signal aborts. The child group is always
 * reaped: on window close, on abort, and on the hard safety deadline.
 */
function runLogCapture(options: RunLogOptions): Promise<LogCapture> {
  const { udid, subcommand, args, windowMs, signal } = options
  if (signal.aborted) throw abortError(signal)
  const ring = new LogLineRing()
  const stderrRing: string[] = []
  let stderrPartial = ''
  const child: LogChild = spawn('xcrun', ['simctl', 'spawn', udid, 'log', subcommand, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Group leader so a kill can reap xcrun → simctl → log at once.
    detached: true,
  })
  child.stdout.on('data', (chunk: Buffer) => ring.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => {
    const text = stderrPartial + chunk.toString('utf8')
    const parts = text.split('\n')
    stderrPartial = parts.pop() ?? ''
    for (const raw of parts) {
      const line = stripAnsi(raw).trimEnd()
      if (line === '') continue
      stderrRing.push(line.length > STDERR_LINE_MAX_CHARS ? `${line.slice(0, STDERR_LINE_MAX_CHARS)}…` : line)
      if (stderrRing.length > STDERR_RING_LINES) stderrRing.shift()
    }
  })

  return new Promise<LogCapture>((resolve, reject) => {
    let settled = false
    let killedByUs = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      if (windowTimer !== undefined) clearTimeout(windowTimer)
      clearTimeout(safetyTimer)
      signal.removeEventListener('abort', onAbort)
      finish()
    }
    const killTree = (graceMs: number): void => {
      killedByUs = true
      signalProcessGroup(child, 'SIGTERM')
      if (graceMs > 0) {
        const killer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), graceMs)
        killer.unref?.()
      }
    }
    const onAbort = (): void => killTree(KILL_GRACE_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    const windowTimer = windowMs === undefined
      ? undefined
      : setTimeout(() => killTree(KILL_GRACE_MS), windowMs)
    // Hard safety net: no `log` child may outlive its budget, whatever happens.
    const safetyTimer = setTimeout(
      () => killTree(0),
      windowMs === undefined ? SNAPSHOT_SAFETY_MS : windowMs + FOLLOW_SAFETY_GRACE_MS,
    )
    child.once('error', error => {
      settle(() => reject(new Error(`simctl spawn ${udid} log ${subcommand} failed to start: ${errorMessage(error)}`)))
    })
    child.once('close', code => {
      settle(() => {
        if (signal.aborted) {
          reject(abortError(signal))
          return
        }
        if (!killedByUs && code !== 0 && code !== null) {
          const detail = stderrRing.length === 0 ? '' : `: ${stderrRing.join('\n')}`
          reject(new Error(`simctl spawn ${udid} log ${subcommand} failed (exit ${String(code)})${detail}`))
          return
        }
        ring.flush()
        resolve({ lines: [...ring.lines], truncated: ring.truncated })
      })
    })
  })
}

/** Degradation guard: throws the shared explanatory error on unsupported hosts. */
function assertLogsAvailable(): void {
  if (process.platform !== 'darwin') {
    throw new Error(`${SIMULATOR_UNAVAILABLE} — this host runs ${process.platform}, so no simulator tools can run here`)
  }
}

/**
 * Resolve the device logs are read from: an explicit udid/name wins, then
 * the currently streamed device, then a booted simulator (newest-runtime
 * iPhone first). Unlike tools.ts this never boots anything.
 */
async function resolveLogDevice(host: SimHostController, reference?: string): Promise<SimulatorDevice> {
  if (reference !== undefined && reference.trim() !== '') return getDevice(reference)
  const status = host.status()
  if (status.running && status.device !== undefined) {
    try {
      return await getDevice(status.device)
    } catch {
      // Stream device vanished from simctl; fall through to booted devices.
    }
  }
  const booted = await bootedDevices()
  if (booted.length === 1) return booted[0]
  if (booted.length > 1) {
    const iphones = booted.filter(device => device.name.toLowerCase().startsWith('iphone'))
    const pool = iphones.length > 0 ? iphones : booted
    return pool.sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))[0]
  }
  throw new Error('No booted simulator and no live stream — call ios_sim_boot first, then retry')
}

/** `--last` value for snapshot mode; validates and defaults to 2m. */
function snapshotDuration(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return DEFAULT_SNAPSHOT_DURATION
  const trimmed = value.trim()
  if (!SNAPSHOT_DURATION_PATTERN.test(trimmed)) {
    throw new Error(`ios_sim_logs: duration must look like "2m", "30s", or "1h" (got ${JSON.stringify(value)})`)
  }
  return trimmed
}

/** Follow-mode window in seconds: integer ≥ 1, clamped to the 60 s maximum. */
function followSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FOLLOW_SECONDS
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`ios_sim_logs: duration_seconds must be a number ≥ 1 (got ${JSON.stringify(value)})`)
  }
  return Math.min(Math.round(value), MAX_FOLLOW_SECONDS)
}

/** Escape backslashes and double quotes inside an NSPredicate string literal. */
function escapePredicateString(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

/**
 * Predicate for `--predicate`: an explicit raw predicate wins, else the
 * bundle_id convenience form `subsystem == "<id>" OR process == "<app>"`
 * with the app process name derived from the bundle id's last component
 * (e.g. `com.apple.Preferences` → `Preferences`).
 */
function resolveLogPredicate(args: SimLogsArgs): string | undefined {
  const predicate = args.predicate
  if (predicate !== undefined && predicate.trim() !== '') return predicate.trim()
  const bundleId = args.bundle_id
  if (bundleId !== undefined && bundleId.trim() !== '') {
    const trimmed = bundleId.trim()
    const processName = trimmed.split('.').pop() ?? trimmed
    return `subsystem == "${escapePredicateString(trimmed)}" OR process == "${escapePredicateString(processName)}"`
  }
  return undefined
}

/** Client-side grep compiled once per call; invalid patterns fail loudly. */
function compileGrep(value: string | undefined): RegExp | undefined {
  if (value === undefined || value.trim() === '') return undefined
  try {
    return new RegExp(value)
  } catch (error) {
    throw new Error(`ios_sim_logs: grep is not a valid regular expression: ${errorMessage(error)}`)
  }
}

/** Shared device object schema (same shape as tools.ts). */
const deviceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    udid: { type: 'string', required: true },
    name: { type: 'string', required: true },
    runtime: { type: 'string', required: true },
    state: { type: 'string', required: true },
  },
} as const

function renderJson(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Apply the client-side grep, then re-assert the cap defensively (grep can
 * only shrink the ring, so this is a no-op unless a stray line is oversized).
 */
function postProcess(capture: LogCapture, grep: RegExp | undefined): { lines: string[]; truncated: boolean } {
  let lines = grep === undefined ? capture.lines : capture.lines.filter(line => line.search(grep) !== -1)
  let truncated = capture.truncated
  let bytes = 0
  for (const line of lines) bytes += Buffer.byteLength(line, 'utf8') + 1
  while (lines.length > MAX_LOG_LINES || bytes > MAX_LOG_BYTES) {
    const removed = lines.shift()
    if (removed === undefined) break
    bytes -= Buffer.byteLength(removed, 'utf8') + 1
    truncated = true
  }
  return { lines, truncated }
}

/** Create the `ios_sim_logs` tool definition bound to one controller. */
export function createSimLogTools(host: SimHostController): SimLogTools {
  const iosSimLogs = defineTool({
    name: 'ios_sim_logs',
    description: 'Read what a simulator app prints while it runs, from the device unified log. '
      + 'Two bounded modes: snapshot reads the recent persisted log (`log show --last <duration>`, '
      + 'default 2m); follow captures live output for `duration_seconds` (default 10, max 60) and '
      + 'returns everything accumulated when the window closes — never an unbounded stream. '
      + 'Filter with a raw NSPredicate (`predicate`, e.g. process == "MyApp"), the bundle_id '
      + 'convenience filter, a log level, and a client-side `grep` regex. Output is capped at '
      + '~300 lines / 30 KB (tail kept; truncated:true plus a narrowing hint when the cap bites).',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name. Defaults to the currently streamed '
          + 'device, else a booted simulator.',
      },
      mode: {
        type: 'string',
        enum: ['snapshot', 'follow'],
        description: 'snapshot: recent persisted logs via log show --last <duration> (default). '
          + 'follow: bounded live capture via log stream for duration_seconds, then return.',
      },
      duration: {
        type: 'string',
        description: 'Snapshot window for log show --last, e.g. "2m", "30s", "1h" (default "2m"). '
          + 'Ignored in follow mode.',
      },
      duration_seconds: {
        type: 'number',
        description: 'Follow capture window in seconds, 1..60 (default 10; values above 60 are '
          + 'clamped). Ignored in snapshot mode.',
      },
      bundle_id: {
        type: 'string',
        description: 'Convenience filter: captures subsystem == "<bundle_id>" OR process == '
          + '"<app process name>" (the bundle id\u2019s last component, e.g. com.apple.Preferences '
          + '→ Preferences). Ignored when predicate is set.',
      },
      predicate: {
        type: 'string',
        description: 'Raw NSPredicate for --predicate, overriding bundle_id. Examples: '
          + 'process == "MyApp", subsystem CONTAINS "my.app", eventMessage CONTAINS "error". '
          + 'Leave unset (with no bundle_id) to capture everything the device logs.',
      },
      level: {
        type: 'string',
        enum: ['default', 'info', 'debug'],
        description: 'Log level threshold (default | info | debug). Mapped to --level for follow '
          + '(log stream) and --info/--debug for snapshot (log show). Unset keeps the log tool\u2019s '
          + 'default level.',
      },
      grep: {
        type: 'string',
        description: 'Client-side regular expression applied to each captured line after the '
          + 'window closes; non-matching lines are dropped.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          mode: { type: 'string', required: true, enum: ['snapshot', 'follow'] },
          window: { type: 'string', required: true },
          lineCount: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: renderJson,
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => true,
    async execute(args: SimLogsArgs, exec) {
      assertLogsAvailable()
      const reference = args.udid?.trim() ?? ''
      if (reference !== '' && await matchesRealDevice(reference, exec.signal)) {
        throw new Error(
          'ios_sim_logs: unified-log capture for physical devices is not available yet — devicectl has no '
          + 'log subcommand and `xcrun log collect --device-udid` requires root, so real-device logs are '
          + 'skipped in this phase (revisit with a later phase).',
        )
      }
      const mode = args.mode ?? 'snapshot'
      const device = await resolveLogDevice(host, args.udid)
      if (device.state !== 'Booted') {
        throw new Error(`Simulator "${device.name}" is not booted (state ${device.state}) — call ios_sim_boot first, then retry`)
      }
      const predicate = resolveLogPredicate(args)
      const grep = compileGrep(args.grep)
      const predicateArgs = predicate === undefined ? [] : ['--predicate', predicate]
      const level = args.level

      let capture: LogCapture
      let window: string
      if (mode === 'follow') {
        const seconds = followSeconds(args.duration_seconds)
        const logArgs = ['--style', 'compact']
        // `log stream` takes --level directly.
        if (level !== undefined) logArgs.push('--level', level)
        logArgs.push(...predicateArgs)
        capture = await runLogCapture({
          udid: device.udid,
          subcommand: 'stream',
          args: logArgs,
          windowMs: seconds * 1000,
          signal: exec.signal,
        })
        window = `follow ${seconds}s`
      } else {
        const duration = snapshotDuration(args.duration)
        const logArgs = ['--last', duration, '--style', 'compact']
        // `log show` has no --level flag: --info/--debug raise the threshold.
        if (level === 'info') logArgs.push('--info')
        else if (level === 'debug') logArgs.push('--debug')
        logArgs.push(...predicateArgs)
        capture = await runLogCapture({
          udid: device.udid,
          subcommand: 'show',
          args: logArgs,
          signal: exec.signal,
        })
        window = `last ${duration}`
      }

      const { lines, truncated } = postProcess(capture, grep)
      const lineCount = lines.length
      if (truncated) lines.push(TRUNCATION_HINT)
      return {
        device: { udid: device.udid, name: device.name, runtime: device.runtime, state: device.state },
        mode,
        window,
        lineCount,
        truncated,
        lines,
      } satisfies SimLogsResult
    },
    presentCall: (args: SimLogsArgs) => ({
      card: 'generic',
      title: args.mode === 'follow' ? 'Follow simulator logs' : 'Read simulator logs',
      kind: 'execute',
    }),
  })

  return { iosSimLogs }
}
