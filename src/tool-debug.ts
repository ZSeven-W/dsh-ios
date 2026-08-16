/**
 * Model-facing debugging and memory-diagnostics tools for the iOS Simulator
 * plugin — the Codex XcodeBuildMCP gap-closers:
 *
 * - `ios_sim_processes`: running UIKit app processes on a booted simulator,
 *   read from the simulator's own launchd (`simctl spawn <udid> launchctl
 *   list`, filtered to UIKitApplication entries). Empirically this is the
 *   most reliable pid+bundle mapping: the pids are host pids (simulator apps
 *   are host processes under CoreSimulator) AND the listing is scoped to one
 *   device, which a raw host `ps` is not when several sims are booted.
 * - `ios_sim_backtrace`: one-shot batch LLDB — `lldb -b -o "attach <pid>" -o
 *   "thread backtrace all" -o "detach"` — never an interactive session. A
 *   hard timeout (default 30 s) kills the LLDB process group and the target
 *   is verified resumed (SIGCONT belt-and-braces), because a left-attached
 *   process freezes the app. When macOS denies the attach (Developer Mode
 *   off), the tool degrades to Xcode's `sample` (symbolized per-thread call
 *   graph, non-suspending) and reports the `sudo DevToolsSecurity -enable`
 *   hint.
 * - `ios_sim_leaks`: `leaks <pid>` summary (leak count, total leaked bytes,
 *   top ~30 leaked types) or a `.memgraph` artifact (`--outputGraph`) that
 *   the user opens in Xcode Instruments — the graph is never parsed. leaks
 *   suspends the target while it scans, so the same hard-timeout + resume
 *   machinery applies.
 * - `ios_sim_app_info`: installed-app containers and Info.plist facts via
 *   `simctl appinfo` (OpenStep plist), with a `get_app_container` fallback.
 *
 * The attach/suspend tools (backtrace, leaks) are marked non-concurrency-safe
 * (`isConcurrencySafe: () => false`); processes/app_info are pure reads.
 * Every spawned child is tracked and killed on dispose, and every call
 * threads the caller's AbortSignal. Degradation mirrors tools.ts: the tools
 * always register but throw the shared explanatory error on non-macOS hosts.
 * @module @zseven-w/dsh-ios/tool-debug
 */

import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessByStdio,
} from 'node:child_process'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { SimHostController } from './sim-host.js'
import {
  bootedDevices,
  compareRuntimesDesc,
  getDevice,
  type SimulatorDevice,
} from './simctl.js'
import type { SimDeviceInfo } from './tools.js'

/** Error prefix required on non-macOS hosts (same text as tools.ts). */
const SIMULATOR_UNAVAILABLE = 'iOS Simulator requires macOS with Xcode'

/** Registered tool names, in registration order. */
export const IOS_DEBUG_TOOL_NAMES = [
  'ios_sim_processes',
  'ios_sim_backtrace',
  'ios_sim_leaks',
  'ios_sim_app_info',
] as const

/** Backtrace output cap: ~200 stack lines, main thread first. */
const MAX_BACKTRACE_LINES = 200
/** Top leaked types kept in a leaks summary. */
const MAX_TOP_TYPES = 30
/** Hard deadline for a batch LLDB attach → backtrace → detach round trip. */
const DEFAULT_BACKTRACE_TIMEOUT_MS = 30_000
/** Hard deadline for one leaks analysis (summary or memgraph write). */
const DEFAULT_LEAKS_TIMEOUT_MS = 120_000
/** SIGTERM → SIGKILL grace when reaping a debug child's process group. */
const KILL_GRACE_MS = 2_000
/** Poll cadence when verifying a target process resumed after a kill. */
const RESUME_POLL_MS = 300
/** Raw stdout/stderr capture cap per debug child (tail kept). */
const MAX_CHILD_CAPTURE_BYTES = 2 * 1024 * 1024
/** simctl calls (launchctl list, appinfo, get_app_container) timeout. */
const SIMCTL_CALL_TIMEOUT_MS = 30_000
/** Diagnostics kept from a failed child's stderr/stdout. */
const DIAGNOSTIC_LINE_MAX_CHARS = 240

const BACKTRACE_TRUNCATION_HINT = '[dsh-ios: backtrace truncated at ~200 lines — re-run with all_threads=false for just the main thread, or open the sample report for the full stacks]'
const MALLOC_STACK_LOGGING_HINT = 'the app was not launched with MallocStackLogging, so allocation backtraces are unavailable — relaunch with SIMCTL_CHILD_MallocStackLogging=1 xcrun simctl launch <udid> <bundle_id>, then re-run'
const DEVELOPER_MODE_HINT = 'macOS Developer Mode is required for full task inspection — run `sudo DevToolsSecurity -enable` once, then retry'

export interface SimDebugToolsOptions {
  /** Plugin-owned cache root for sample reports and memgraphs (default `<tmp>/dsh-ios`). */
  cacheDir?: string
  /** Hard deadline for one batch LLDB/sample backtrace (default 30000 ms, min 50). */
  backtraceTimeoutMs?: number
  /** Hard deadline for one leaks analysis (default 120000 ms, min 50). */
  leaksTimeoutMs?: number
}

/** One running app process on a simulator (pid is a host-visible pid). */
export interface SimAppProcess {
  pid: number
  /** Process name (the bundle id's last component, e.g. `Preferences`). */
  name: string
  bundleId?: string
}

export interface SimProcessesResult {
  device: SimDeviceInfo
  processes: SimAppProcess[]
}

export interface SimBacktraceResult {
  device: SimDeviceInfo
  pid: number
  name?: string
  bundleId?: string
  /** lldb = batch attach; sample = the fallback used when LLDB was denied/unavailable. */
  engine: 'lldb' | 'sample'
  allThreads: boolean
  threadCount: number
  /** Number of stack lines returned (the truncation hint is not counted). */
  lineCount: number
  truncated: boolean
  /** Symbolized stack lines, main thread first; capped at ~200 lines. */
  lines: string[]
  /** True when the target was verified running after the capture (lldb: after detach or kill). */
  resumed: boolean
  /** sample engine only: the full sample report on disk. */
  reportPath?: string
  /** Engine fallback reason and environment hints (e.g. DevToolsSecurity). */
  note?: string
}

export interface SimLeakType {
  type: string
  count: number
  bytes: number
}

export interface SimLeaksResult {
  device: SimDeviceInfo
  pid: number
  name?: string
  bundleId?: string
  mode: 'summary' | 'memgraph'
  /** summary: leak count and total leaked bytes. */
  leaks?: number
  leakedBytes?: number
  /** summary: live heap node count and size string as reported by leaks. */
  nodes?: number
  nodesBytes?: string
  /** summary: most frequent leaked types (top ~30, by count then bytes). */
  topTypes?: SimLeakType[]
  /** memgraph: artifact path (open it in Xcode Instruments; never parsed here). */
  path?: string
  /** memgraph: artifact size in bytes. */
  bytes?: number
  /** True when the target was verified running after the analysis. */
  resumed: boolean
  /** Environment hints (restricted inspection, MallocStackLogging, …). */
  note?: string
}

export interface SimAppInfoResult {
  device: SimDeviceInfo
  bundleId: string
  installed: boolean
  /** Installed .app bundle path. */
  appPath?: string
  /** Writable data container path (absent for system apps without one). */
  dataPath?: string
  /** Bundle container directory holding the .app. */
  bundleContainer?: string
  displayName?: string
  executable?: string
  name?: string
  version?: string
  shortVersion?: string
  applicationType?: string
}

/** The four debug tool definitions bound to one sim host controller. */
export interface SimDebugTools {
  iosSimProcesses: ToolDefinition
  iosSimBacktrace: ToolDefinition
  iosSimLeaks: ToolDefinition
  iosSimAppInfo: ToolDefinition
  /** Kill any debug child still running (timeout/abort grace in flight). */
  dispose(): void
}

type DebugChild = ChildProcessByStdio<null, Readable, Readable>

/** One parsed thread section (header + stack lines) from lldb or sample. */
interface ThreadSection {
  header: string
  lines: string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function renderJson(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Shared device object schema used by every tool result. Kept `as const` so
 * `defineTool` can infer the concrete output value type (an interface-typed
 * schema would widen to an empty object under the DSL's inference).
 */
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

/** Degradation guard: throws the shared explanatory error on unsupported hosts. */
function assertDebugAvailable(): void {
  if (process.platform !== 'darwin') {
    throw new Error(`${SIMULATOR_UNAVAILABLE} — this host runs ${process.platform}, so no simulator tools can run here`)
  }
}

/**
 * Resolve the device debug tools operate on: an explicit udid/name wins,
 * then the currently streamed device, then a booted simulator (newest-runtime
 * iPhone first). Unlike tools.ts this never boots anything.
 */
async function resolveDebugDevice(host: SimHostController, reference?: string): Promise<SimulatorDevice> {
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

function requireBooted(device: SimulatorDevice): void {
  if (device.state !== 'Booted') {
    throw new Error(`Simulator "${device.name}" is not booted (state ${device.state}) — call ios_sim_boot first, then retry`)
  }
}

/** Run `xcrun simctl <args>` and resolve stdout; abortable and typed. */
function execSimctlCapture(args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('xcrun', ['simctl', ...args], {
      timeout: SIMCTL_CALL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim()
        reject(new Error(`simctl ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`))
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * List the running UIKit app processes of one simulator from its launchd.
 * `simctl spawn <udid> launchctl list` prints `<pid>\t<status>\t<label>` rows;
 * app rows carry the label `UIKitApplication:<bundle-id>[<instance>][...]`.
 * The pids are host pids (simulator apps are host processes), so they feed
 * lldb/leaks/sample directly.
 */
async function listAppProcesses(udid: string, signal?: AbortSignal): Promise<SimAppProcess[]> {
  const stdout = await execSimctlCapture(['spawn', udid, 'launchctl', 'list'], signal)
  const processes: SimAppProcess[] = []
  for (const line of stdout.split('\n')) {
    const [pidRaw, , labelRaw] = line.split('\t')
    const label = (labelRaw ?? '').trim()
    if (!label.startsWith('UIKitApplication:')) continue
    const pid = Number(pidRaw)
    if (!Number.isInteger(pid) || pid < 1) continue
    const rest = label.slice('UIKitApplication:'.length)
    const bracket = rest.indexOf('[')
    const bundleId = (bracket >= 0 ? rest.slice(0, bracket) : rest).trim()
    const name = (bundleId === '' ? rest : bundleId).split('.').pop() ?? rest
    processes.push({ pid, name, ...(bundleId === '' ? {} : { bundleId }) })
  }
  return processes.sort((a, b) => a.pid - b.pid)
}

/**
 * Resolve the process a debug tool targets on one device. An explicit pid
 * must belong to that device's UIKitApplication list — this is what keeps
 * the tools from ever attaching to arbitrary host processes. A bundle_id
 * resolves to the first matching running process (by pid order).
 */
async function resolveTargetProcess(
  device: SimulatorDevice,
  pid: number | undefined,
  bundleId: string | undefined,
  signal?: AbortSignal,
): Promise<SimAppProcess> {
  const processes = await listAppProcesses(device.udid, signal)
  if (pid !== undefined) {
    if (!Number.isInteger(pid) || pid < 1) {
      throw new Error(`ios_sim_debug: pid must be a positive integer (got ${JSON.stringify(pid)})`)
    }
    const found = processes.find(process => process.pid === pid)
    if (found === undefined) {
      throw new Error(
        `pid ${pid} is not a running app process on simulator "${device.name}" — targets are restricted to this simulator's UIKitApplication processes (host processes outside the simulator are never attached); use ios_sim_processes to list them`,
      )
    }
    return found
  }
  const trimmed = bundleId?.trim() ?? ''
  if (trimmed === '') {
    throw new Error('ios_sim_debug: pass either pid or bundle_id (a pid found via ios_sim_processes is the most precise)')
  }
  const lower = trimmed.toLowerCase()
  const matches = processes.filter(process =>
    (process.bundleId ?? '').toLowerCase() === lower || process.name.toLowerCase() === lower)
  if (matches.length === 0) {
    throw new Error(
      `no running process for bundle id "${trimmed}" on simulator "${device.name}" — launch the app (ios_sim_build_run or simctl launch), then retry`,
    )
  }
  return matches[0]
}

/** Xcode developer tools resolved once per factory (absolute paths when possible). */
interface DebugBinaries {
  lldb?: string
  leaks?: string
  sample?: string
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, command)
    try {
      if (statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0) return candidate
    } catch {
      // Not this candidate.
    }
  }
  return undefined
}

function resolveDebugBinaries(): DebugBinaries {
  const find = (name: string): string | undefined => {
    if (process.platform !== 'darwin') return undefined
    try {
      const out = execFileSync('xcrun', ['--find', name], { encoding: 'utf8', timeout: SIMCTL_CALL_TIMEOUT_MS })
      const path = out.trim()
      return path === '' ? undefined : path
    } catch {
      return findOnPath(name)
    }
  }
  return { lldb: find('lldb'), leaks: find('leaks'), sample: find('sample') }
}

/** Kill a debug child's whole process group (lldb → debugserver, leaks helpers). */
function signalProcessGroup(child: DebugChild, signal: NodeJS.Signals): void {
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

/** Tracks every debug child so dispose() can reap stragglers. */
class ChildTracker {
  readonly #children = new Set<DebugChild>()

  track(child: DebugChild): void {
    this.#children.add(child)
    child.once('close', () => this.#children.delete(child))
  }

  dispose(): void {
    for (const child of [...this.#children]) signalProcessGroup(child, 'SIGKILL')
  }
}

function abortError(label: string, signal: AbortSignal, resumed?: boolean): Error {
  if (signal.reason instanceof Error) return signal.reason
  const resumeDetail = resumed === undefined ? '' : ` (target resume: ${resumed ? 'verified' : 'not found'})`
  return new Error(
    `${label} aborted${typeof signal.reason === 'string' && signal.reason !== '' ? `: ${signal.reason}` : ''}${resumeDetail}`,
  )
}

/** `ps -o stat=` for one pid; undefined when the process is gone. */
function processStat(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

/**
 * Verify a target process is running again after a debugger was killed or
 * detached. A debugger-stopped process shows `T` in `ps stat`; when it does,
 * SIGCONT it (harmless if already running) and re-poll. Returns true when the
 * process exists and is not stopped.
 */
async function ensureProcessRunning(pid: number): Promise<boolean> {
  await sleep(RESUME_POLL_MS)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const stat = processStat(pid)
    if (stat === undefined || stat === '') return false
    if (!stat.includes('T')) return true
    try {
      process.kill(pid, 'SIGCONT')
    } catch {
      return false
    }
    await sleep(RESUME_POLL_MS)
  }
  const stat = processStat(pid)
  return stat !== undefined && stat !== '' && !stat.includes('T')
}

interface RunChildOptions {
  command: string
  args: readonly string[]
  /** Label used in every error message for this child. */
  label: string
  /** Hard deadline; the child's process group is killed on expiry. */
  timeoutMs: number
  signal: AbortSignal
  tracker: ChildTracker
  /** Target pid to resume (SIGCONT if still stopped) after we kill the child. */
  resumePid?: number
}

interface ChildRunOutcome {
  stdout: string
  stderr: string
  code: number | null
  killed: boolean
  timedOut: boolean
  /** True when a resume-after-kill ran and the target was verified running. */
  resumed?: boolean
}

/**
 * Spawn one debug child (detached group leader), capture its output, and
 * enforce the hard deadline: on timeout or abort the group is SIGTERM'd then
 * SIGKILL'd, the target process (if any) is resumed and verified, and the
 * caller gets a typed failure. A killed debugger never leaves the target
 * attached/frozen.
 */
function runDebugChild(options: RunChildOptions): Promise<ChildRunOutcome> {
  const { command, args, label, timeoutMs, signal, tracker, resumePid } = options
  if (signal.aborted) throw abortError(label, signal)
  return new Promise<ChildRunOutcome>((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killed = false
    const child: DebugChild = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Group leader so a kill reaps lldb → debugserver (or leaks helpers) at once.
      detached: true,
    })
    tracker.track(child)
    const killTree = (graceMs: number): void => {
      killed = true
      signalProcessGroup(child, 'SIGTERM')
      if (graceMs > 0) {
        const killer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), graceMs)
        killer.unref?.()
      }
    }
    const finish = (done: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      done()
    }
    const onAbort = (): void => killTree(KILL_GRACE_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(KILL_GRACE_MS)
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_CHILD_CAPTURE_BYTES) stdout = stdout.slice(-MAX_CHILD_CAPTURE_BYTES)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > MAX_CHILD_CAPTURE_BYTES) stderr = stderr.slice(-MAX_CHILD_CAPTURE_BYTES)
    })
    child.once('error', error => {
      finish(() => reject(new Error(`${label} failed to start: ${errorMessage(error)}`)))
    })
    child.once('close', code => {
      finish(() => {
        void (async () => {
          let resumed: boolean | undefined
          if (resumePid !== undefined && (timedOut || killed)) {
            resumed = await ensureProcessRunning(resumePid)
          }
          if (signal.aborted) {
            reject(abortError(label, signal, resumed))
            return
          }
          if (timedOut) {
            const resumeDetail = resumePid === undefined
              ? ''
              : resumed === true
                ? `; the target process was verified resumed (pid ${resumePid})`
                : `; the target process was NOT found afterwards (pid ${resumePid}, it may have exited)`
            reject(new Error(`${label} exceeded its ${timeoutMs} ms deadline and was killed${resumeDetail}`))
            return
          }
          resolve({ stdout, stderr, code, killed, timedOut: false, resumed })
        })()
      })
    })
  })
}

/** First non-empty diagnostic line from stderr (else stdout), truncated. */
function firstDiagnostic(stderr: string, stdout: string): string | undefined {
  const pool = `${stderr}\n${stdout}`.split('\n')
  for (const raw of pool) {
    const line = raw.trim()
    if (line === '') continue
    return line.length > DIAGNOSTIC_LINE_MAX_CHARS ? `${line.slice(0, DIAGNOSTIC_LINE_MAX_CHARS)}…` : line
  }
  return undefined
}

/** Last non-empty diagnostic lines, truncated (for failure details). */
function tailDiagnostic(text: string, lines: number): string {
  const kept = text.split('\n').map(line => line.trim()).filter(line => line !== '').slice(-lines)
  return kept.map(line => line.length > DIAGNOSTIC_LINE_MAX_CHARS ? `${line.slice(0, DIAGNOSTIC_LINE_MAX_CHARS)}…` : line).join(' | ')
}

/** One lldb batch attempt: captured threads, or the attach failure detail. */
interface LldbAttempt {
  kind: 'captured' | 'failed'
  threads?: ThreadSection[]
  detail?: string
}

/**
 * One-shot batch LLDB: attach → `thread backtrace (all)` → detach. `-b` runs
 * the `-o` commands and quits, so this is never an interactive session. The
 * hard timeout + group kill + resume machinery lives in `runDebugChild`.
 */
async function captureBacktraceLldb(
  lldbPath: string,
  pid: number,
  allThreads: boolean,
  options: { timeoutMs: number; signal: AbortSignal; tracker: ChildTracker },
): Promise<LldbAttempt> {
  const backtrace = allThreads ? 'thread backtrace all' : 'thread backtrace'
  const outcome = await runDebugChild({
    command: lldbPath,
    args: ['-b', '-o', `attach ${pid}`, '-o', backtrace, '-o', 'detach'],
    label: `lldb backtrace of pid ${pid}`,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    tracker: options.tracker,
    resumePid: pid,
  })
  const threads = parseLldbThreads(outcome.stdout)
  if (threads.length > 0) return { kind: 'captured', threads }
  const detail = firstDiagnostic(outcome.stderr, outcome.stdout)
  return {
    kind: 'failed',
    detail: detail ?? `lldb exited ${String(outcome.code)} without any backtrace`,
  }
}

/** Parse `thread backtrace (all)` output into per-thread sections. */
function parseLldbThreads(text: string): ThreadSection[] {
  const threads: ThreadSection[] = []
  let current: ThreadSection | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (/^\(lldb\)/.test(line)) continue
    if (/^Process \d+ (stopped|resuming|detached|exited)/.test(line)) {
      current = undefined
      continue
    }
    const header = /^(\*?)\s*thread #\d+/.exec(line)
    if (header !== null) {
      current = { header: line.trim(), lines: [] }
      threads.push(current)
      continue
    }
    if (current !== undefined) {
      if (line.trim() === '' && current.lines.length === 0) continue
      current.lines.push(line)
    }
  }
  return threads
}

/**
 * `sample` fallback: Xcode's non-suspending sampler. The report's call graph
 * section is parsed into the same per-thread shape as lldb output. `sample`
 * ships with Xcode and — unlike lldb attach — needs no Developer Mode.
 */
async function captureBacktraceSample(
  samplePath: string,
  pid: number,
  options: { timeoutMs: number; signal: AbortSignal; tracker: ChildTracker; reportPath: string },
): Promise<ThreadSection[]> {
  const outcome = await runDebugChild({
    command: samplePath,
    args: [String(pid), '1', '1', '-file', options.reportPath],
    label: `sample of pid ${pid}`,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    tracker: options.tracker,
    // sample does not suspend the target; nothing to resume after a kill.
  })
  if (!existsSync(options.reportPath)) {
    const detail = tailDiagnostic(outcome.stderr === '' ? outcome.stdout : outcome.stderr, 3)
    throw new Error(`sample of pid ${pid} produced no report${detail === '' ? '' : `: ${detail}`}`)
  }
  let report: string
  try {
    report = readFileSync(options.reportPath, 'utf8').slice(0, MAX_CHILD_CAPTURE_BYTES)
  } catch (error) {
    throw new Error(`sample of pid ${pid} wrote an unreadable report: ${errorMessage(error)}`)
  }
  const threads = parseSampleThreads(report)
  if (threads.length === 0) {
    throw new Error(`sample of pid ${pid} produced no thread sections (report: ${options.reportPath})`)
  }
  return threads
}

/** Parse the `Call graph:` section of a sample report into thread sections. */
function parseSampleThreads(text: string): ThreadSection[] {
  const threads: ThreadSection[] = []
  let inCallGraph = false
  let current: ThreadSection | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!inCallGraph) {
      if (line.trim() === 'Call graph:') inCallGraph = true
      continue
    }
    const header = /^\s{1,6}\d+\s+Thread_\S+/.test(line)
    if (header) {
      current = { header: line.trim(), lines: [] }
      threads.push(current)
      continue
    }
    if (line.trim() === '') {
      current = undefined
      continue
    }
    if (current !== undefined) current.lines.push(line)
  }
  return threads
}

/** Move the main thread's section to the front (kept whole by the capping). */
function mainThreadFirst(threads: ThreadSection[]): ThreadSection[] {
  const mainIndex = threads.findIndex(thread => /main[- ]thread/i.test(thread.header))
  if (mainIndex <= 0) return threads
  return [threads[mainIndex], ...threads.slice(0, mainIndex), ...threads.slice(mainIndex + 1)]
}

/** Cap stacked thread sections to ~200 lines, main thread first and intact. */
function capThreadLines(threads: ThreadSection[], maxLines: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = []
  for (const thread of threads) {
    const block = [thread.header, ...thread.lines]
    const room = maxLines - lines.length
    if (block.length <= room) {
      lines.push(...block)
      continue
    }
    lines.push(...block.slice(0, room))
    return { lines, truncated: true }
  }
  return { lines, truncated: false }
}

function safeSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

function positiveTimeout(value: number | undefined, fallback: number, optionName: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 50) {
    throw new RangeError(`dsh-ios: ${optionName} must be a number ≥ 50 ms (got ${JSON.stringify(value)})`)
  }
  return Math.round(value)
}

/** First fatal diagnostic from a leaks run, if any. */
function fatalDiagnostic(stderr: string, stdout: string): string | undefined {
  const pool = `${stderr}\n${stdout}`.split('\n')
  for (const raw of pool) {
    const line = raw.trim()
    if (line === '') continue
    if (/\[fatal\]|Failed to get DYLD info|minimal corpse|cannot examine process|not allowed to attach/i.test(line)) {
      return line.length > DIAGNOSTIC_LINE_MAX_CHARS ? `${line.slice(0, DIAGNOSTIC_LINE_MAX_CHARS)}…` : line
    }
  }
  return undefined
}

function leaksUnavailableError(pid: number, fatal: string): Error {
  return new Error(
    `leaks could not analyze pid ${pid}: ${fatal} — ${DEVELOPER_MODE_HINT}. `
      + `Note: leaks also needs the app to have been launched with MallocStackLogging for allocation backtraces (${'SIMCTL_CHILD_MallocStackLogging=1'}).`,
  )
}

interface LeaksSummaryParse {
  leaks: number
  leakedBytes: number
  nodes?: number
  nodesBytes?: string
  topTypes: SimLeakType[]
}

/** Parse the leaks summary: count/bytes line, nodes line, top leak types. */
function parseLeaksSummary(stdout: string): LeaksSummaryParse | undefined {
  const leaksMatch = /^Process \d+: (\d+) leaks for (\d+) total leaked bytes\./m.exec(stdout)
  if (leaksMatch === null) return undefined
  const leaks = Number(leaksMatch[1])
  const leakedBytes = Number(leaksMatch[2])
  const nodesMatch = /^Process \d+: (\d+) nodes malloced for ([0-9.]+\s+\w+)/m.exec(stdout)
  const counts = new Map<string, { count: number; bytes: number }>()
  for (const match of stdout.matchAll(/^\s*\d+\s+\([^)]*\)\s+ROOT LEAK:\s+(.+?)\s*\[(\d+)\]\s*$/gm)) {
    let type = match[1].trim()
    type = type.startsWith('<') && type.endsWith('>') ? type.slice(1, -1).replace(/\s+0x[0-9a-f]+$/i, '') : '<unknown>'
    const count = Number((/^\s*(\d+)/.exec(match[0]) ?? [])[1] ?? 1)
    const bytes = Number(match[2])
    const agg = counts.get(type) ?? { count: 0, bytes: 0 }
    agg.count += count
    agg.bytes += bytes
    counts.set(type, agg)
  }
  const topTypes = [...counts.entries()]
    .map(([type, agg]) => ({ type, count: agg.count, bytes: agg.bytes }))
    .sort((a, b) => b.count - a.count || b.bytes - a.bytes)
    .slice(0, MAX_TOP_TYPES)
  return {
    leaks,
    leakedBytes,
    ...(nodesMatch === null ? {} : { nodes: Number(nodesMatch[1]), nodesBytes: nodesMatch[2] }),
    topTypes,
  }
}

/** Parse scalar key/value pairs from `simctl appinfo`'s OpenStep plist output. */
function parseOpenStepPlist(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line === '{' || line === '}') continue
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.*?);\s*$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (value.startsWith('file://')) {
      try {
        value = decodeURIComponent(value).replace(/\/$/, '')
      } catch {
        // Keep the raw URL when decoding fails.
      }
    }
    fields[match[1]] = value
  }
  return fields
}

/** `get_app_container` for one kind; undefined when absent/unavailable. */
async function getAppContainer(udid: string, bundleId: string, kind: 'app' | 'data', signal?: AbortSignal): Promise<string | undefined> {
  try {
    const stdout = await execSimctlCapture(['get_app_container', udid, bundleId, kind], signal)
    const path = stdout.trim()
    return path === '' || path === '(null)' ? undefined : path
  } catch {
    return undefined
  }
}

/** Create the four debug tool definitions bound to one controller. */
export function createSimDebugTools(host: SimHostController, options: SimDebugToolsOptions = {}): SimDebugTools {
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'dsh-ios')
  const backtraceTimeoutMs = positiveTimeout(options.backtraceTimeoutMs, DEFAULT_BACKTRACE_TIMEOUT_MS, 'backtraceTimeoutMs')
  const leaksTimeoutMs = positiveTimeout(options.leaksTimeoutMs, DEFAULT_LEAKS_TIMEOUT_MS, 'leaksTimeoutMs')
  const binaries = resolveDebugBinaries()
  const tracker = new ChildTracker()

  const iosSimProcesses = defineTool({
    name: 'ios_sim_processes',
    description: 'List the running app processes on a booted iOS Simulator (host-visible pid, process name, '
      + 'bundle id), read from the simulator\u2019s own launchd (UIKitApplication entries). Use this to discover '
      + 'the pid or bundle_id for ios_sim_backtrace and ios_sim_leaks. Filter with a case-insensitive substring '
      + 'matched against the process name and bundle id. Concurrency-safe.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name. Defaults to the currently streamed device, else a booted simulator.',
      },
      filter: {
        type: 'string',
        description: 'Case-insensitive substring matched against the process name and bundle id (e.g. "pref" matches com.apple.Preferences).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          processes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                pid: { type: 'integer', required: true },
                name: { type: 'string', required: true },
                bundleId: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args: { udid?: string; filter?: string }, exec) {
      assertDebugAvailable()
      const device = await resolveDebugDevice(host, args.udid)
      requireBooted(device)
      const processes = await listAppProcesses(device.udid, exec.signal)
      const filter = args.filter?.trim() ?? ''
      const filtered = filter === ''
        ? processes
        : processes.filter(process =>
          process.name.toLowerCase().includes(filter.toLowerCase())
          || (process.bundleId ?? '').toLowerCase().includes(filter.toLowerCase()))
      return {
        device: { udid: device.udid, name: device.name, runtime: device.runtime, state: device.state },
        processes: filtered,
      } satisfies SimProcessesResult
    },
    presentCall: (args: { udid?: string; filter?: string }) => ({
      card: 'generic',
      title: args.filter === undefined ? 'List simulator processes' : `List simulator processes (filter: ${args.filter})`,
      kind: 'execute',
    }),
  })

  const iosSimBacktrace = defineTool({
    name: 'ios_sim_backtrace',
    description: 'Capture a symbolized backtrace of a running simulator app in one shot: batch LLDB '
      + '(attach → thread backtrace → detach), never an interactive session. The target is always detached '
      + 'and verified resumed — even when the capture times out the LLDB child is killed — so the app keeps '
      + 'running. When macOS denies LLDB attach (Developer Mode disabled), the tool falls back to Xcode\u2019s '
      + 'sample tool (symbolized, non-suspending) and reports the enable hint. Output is capped at ~200 stack '
      + 'lines with the main thread first; set all_threads=false for just the main thread. '
      + 'NOT concurrency-safe: one capture at a time.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name. Defaults to the currently streamed device, else a booted simulator.',
      },
      pid: {
        type: 'number',
        description: 'Host-visible pid of the app to inspect (from ios_sim_processes). Either pid or bundle_id is required; pid is the most precise.',
      },
      bundle_id: {
        type: 'string',
        description: 'Bundle id of the running app to inspect (e.g. com.apple.Preferences). Used when pid is not given.',
      },
      all_threads: {
        type: 'boolean',
        description: 'Backtrace every thread (default true). false returns only the main thread.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          pid: { type: 'integer', required: true },
          name: { type: 'string' },
          bundleId: { type: 'string' },
          engine: { type: 'string', required: true, enum: ['lldb', 'sample'] },
          allThreads: { type: 'boolean', required: true },
          threadCount: { type: 'integer', required: true },
          lineCount: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
          resumed: { type: 'boolean', required: true },
          reportPath: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args: { udid?: string; pid?: number; bundle_id?: string; all_threads?: boolean }, exec) {
      assertDebugAvailable()
      const device = await resolveDebugDevice(host, args.udid)
      requireBooted(device)
      const target = await resolveTargetProcess(device, args.pid, args.bundle_id, exec.signal)
      const allThreads = args.all_threads !== false

      let threads: ThreadSection[] | undefined
      let engine: 'lldb' | 'sample' = 'lldb'
      let reportPath: string | undefined
      let note: string | undefined
      if (binaries.lldb !== undefined) {
        const attempt = await captureBacktraceLldb(binaries.lldb, target.pid, allThreads, {
          timeoutMs: backtraceTimeoutMs,
          signal: exec.signal,
          tracker,
        })
        if (attempt.kind === 'captured') {
          threads = attempt.threads
        } else {
          engine = 'sample'
          note = `LLDB capture failed (${attempt.detail ?? 'no output'}) and sample was used instead`
          if (/not allowed to attach|attach failed/i.test(attempt.detail ?? '')) {
            note += ` — ${DEVELOPER_MODE_HINT} to enable LLDB attach`
          }
        }
      } else {
        engine = 'sample'
        note = 'Xcode\u2019s lldb is not installed on this host; sample was used instead'
      }
      if (threads === undefined) {
        if (binaries.sample === undefined) {
          throw new Error(`ios_sim_backtrace: LLDB capture is unavailable${note === undefined ? '' : ` (${note})`} and Xcode\u2019s sample tool is not installed — install Xcode or the Command Line Tools, then retry`)
        }
        const sampleReport = join(cacheDir, 'samples', `sample-${safeSlug(target.name)}-${target.pid}-${Date.now()}.txt`)
        mkdirSync(dirname(sampleReport), { recursive: true })
        threads = await captureBacktraceSample(binaries.sample, target.pid, {
          timeoutMs: backtraceTimeoutMs,
          signal: exec.signal,
          tracker,
          reportPath: sampleReport,
        })
        reportPath = sampleReport
      }

      const ordered = mainThreadFirst(threads)
      const mainOnly = ordered.filter(thread => /main[- ]thread/i.test(thread.header))
      // Never hand back an empty capture: when the main thread is not present
      // (all_threads=false and the debugger selected a worker), keep the
      // selected thread instead.
      const kept = allThreads ? ordered : (mainOnly.length > 0 ? mainOnly.slice(0, 1) : ordered.slice(0, 1))
      const { lines, truncated } = capThreadLines(kept, MAX_BACKTRACE_LINES)
      const lineCount = lines.length
      if (truncated) lines.push(BACKTRACE_TRUNCATION_HINT)
      // The liveness proof: after a normal detach or a kill the target must
      // be running again (never left frozen under the debugger).
      const resumed = await ensureProcessRunning(target.pid)
      if (!resumed && engine === 'lldb') {
        note = note === undefined
          ? 'the target process was not observed running after detach — check ios_sim_processes'
          : `${note}; the target process was not observed running after detach`
      }
      return {
        device: { udid: device.udid, name: device.name, runtime: device.runtime, state: device.state },
        pid: target.pid,
        ...(target.name === undefined ? {} : { name: target.name }),
        ...(target.bundleId === undefined ? {} : { bundleId: target.bundleId }),
        engine,
        allThreads,
        threadCount: kept.length,
        lineCount,
        truncated,
        lines,
        resumed,
        ...(reportPath === undefined ? {} : { reportPath }),
        ...(note === undefined ? {} : { note }),
      } satisfies SimBacktraceResult
    },
    presentCall: (args: { udid?: string; pid?: number; bundle_id?: string }) => ({
      card: 'generic',
      title: `Backtrace ${args.pid !== undefined ? `pid ${args.pid}` : args.bundle_id ?? 'simulator app'}`,
      kind: 'execute',
    }),
  })

  const iosSimLeaks = defineTool({
    name: 'ios_sim_leaks',
    description: 'Analyze a running simulator app for leaked memory with Xcode\u2019s leaks tool. '
      + 'summary mode returns the leak count, total leaked bytes, and the top ~30 leaked types; '
      + 'memgraph mode writes a .memgraph artifact (open it in Xcode Instruments — never parsed here) '
      + 'and returns its path and size. leaks suspends the app while it scans; the app is always '
      + 'resumed afterwards, even when the capture times out. NOT concurrency-safe. On restricted '
      + 'hosts (macOS Developer Mode off) leaks cannot inspect simulator processes and the tool '
      + 'degrades with the enable hint; without MallocStackLogging leak counts still work but '
      + 'allocation backtraces are absent.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name. Defaults to the currently streamed device, else a booted simulator.',
      },
      pid: {
        type: 'number',
        description: 'Host-visible pid of the app to inspect (from ios_sim_processes). Either pid or bundle_id is required.',
      },
      bundle_id: {
        type: 'string',
        description: 'Bundle id of the running app to inspect (e.g. com.apple.Preferences). Used when pid is not given.',
      },
      mode: {
        type: 'string',
        enum: ['summary', 'memgraph'],
        description: 'summary (default): parsed leak count, total bytes, and top leaked types. '
          + 'memgraph: write a .memgraph artifact for Xcode Instruments and return its path and size.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          pid: { type: 'integer', required: true },
          name: { type: 'string' },
          bundleId: { type: 'string' },
          mode: { type: 'string', required: true, enum: ['summary', 'memgraph'] },
          leaks: { type: 'integer' },
          leakedBytes: { type: 'integer' },
          nodes: { type: 'integer' },
          nodesBytes: { type: 'string' },
          topTypes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', required: true },
                count: { type: 'integer', required: true },
                bytes: { type: 'integer', required: true },
              },
            },
          },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          resumed: { type: 'boolean', required: true },
          note: { type: 'string' },
        },
      },
      render: renderJson,
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    async execute(args: { udid?: string; pid?: number; bundle_id?: string; mode?: 'summary' | 'memgraph' }, exec) {
      assertDebugAvailable()
      if (binaries.leaks === undefined) {
        throw new Error('Xcode\u2019s leaks tool is not installed on this host — install Xcode or the Command Line Tools, then retry')
      }
      const device = await resolveDebugDevice(host, args.udid)
      requireBooted(device)
      const target = await resolveTargetProcess(device, args.pid, args.bundle_id, exec.signal)
      const mode = args.mode ?? 'summary'
      const base = {
        device: { udid: device.udid, name: device.name, runtime: device.runtime, state: device.state },
        pid: target.pid,
        ...(target.name === undefined ? {} : { name: target.name }),
        ...(target.bundleId === undefined ? {} : { bundleId: target.bundleId }),
        mode,
      }

      if (mode === 'memgraph') {
        const memgraphDir = join(cacheDir, 'memgraphs')
        mkdirSync(memgraphDir, { recursive: true })
        const filePath = join(memgraphDir, `leaks-${safeSlug(target.name)}-${target.pid}-${Date.now()}.memgraph`)
        const outcome = await runDebugChild({
          command: binaries.leaks,
          args: [`--outputGraph=${filePath}`, String(target.pid)],
          label: `leaks memgraph of pid ${target.pid}`,
          timeoutMs: leaksTimeoutMs,
          signal: exec.signal,
          tracker,
          resumePid: target.pid,
        })
        const fatal = fatalDiagnostic(outcome.stderr, outcome.stdout)
        if (fatal !== undefined) throw leaksUnavailableError(target.pid, fatal)
        if (!existsSync(filePath)) {
          const detail = tailDiagnostic(outcome.stderr === '' ? outcome.stdout : outcome.stderr, 3)
          throw new Error(`leaks reported a memgraph capture but no file was written${detail === '' ? '' : `: ${detail}`}`)
        }
        const bytes = statSync(filePath).size
        const resumed = await ensureProcessRunning(target.pid)
        return {
          ...base,
          mode: 'memgraph',
          path: filePath,
          bytes,
          resumed,
          ...(resumed ? {} : { note: 'the target process was not observed running after the capture — check ios_sim_processes' }),
        } satisfies SimLeaksResult
      }

      // summary: --nostacks keeps the report to the parsed essentials; leak
      // counts and top types do not need allocation backtraces.
      const outcome = await runDebugChild({
        command: binaries.leaks,
        args: ['--nostacks', String(target.pid)],
        label: `leaks summary of pid ${target.pid}`,
        timeoutMs: leaksTimeoutMs,
        signal: exec.signal,
        tracker,
        resumePid: target.pid,
      })
      const fatal = fatalDiagnostic(outcome.stderr, outcome.stdout)
      if (fatal !== undefined) throw leaksUnavailableError(target.pid, fatal)
      const parsed = parseLeaksSummary(outcome.stdout)
      if (parsed === undefined) {
        const detail = tailDiagnostic(outcome.stderr === '' ? outcome.stdout : outcome.stderr, 3)
        throw new Error(`leaks produced no parseable summary for pid ${target.pid}${detail === '' ? '' : `: ${detail}`}`)
      }
      const restricted = /not debuggable|restricted processes/i.test(outcome.stderr)
      const notes: string[] = []
      if (restricted) notes.push(`restricted inspection mode (${DEVELOPER_MODE_HINT})`)
      if (parsed.leaks > 0 && !/multi-line stacks/i.test(outcome.stdout)) notes.push(MALLOC_STACK_LOGGING_HINT)
      const resumed = await ensureProcessRunning(target.pid)
      if (!resumed) notes.push('the target process was not observed running after the analysis — check ios_sim_processes')
      return {
        ...base,
        mode: 'summary',
        leaks: parsed.leaks,
        leakedBytes: parsed.leakedBytes,
        ...(parsed.nodes === undefined ? {} : { nodes: parsed.nodes, nodesBytes: parsed.nodesBytes }),
        topTypes: parsed.topTypes,
        resumed,
        ...(notes.length === 0 ? {} : { note: notes.join('. ') }),
      } satisfies SimLeaksResult
    },
    presentCall: (args: { udid?: string; pid?: number; bundle_id?: string; mode?: string }) => ({
      card: 'generic',
      title: `Leak analysis ${args.pid !== undefined ? `pid ${args.pid}` : args.bundle_id ?? 'simulator app'}${args.mode === 'memgraph' ? ' (memgraph)' : ''}`,
      kind: 'execute',
    }),
  })

  const iosSimAppInfo = defineTool({
    name: 'ios_sim_app_info',
    description: 'Read installed-app facts for one simulator app: the app bundle path, the writable data '
      + 'container path, and basic Info.plist values (display name, executable, version), via simctl '
      + 'appinfo with a get_app_container fallback. Returns installed:false when the bundle id is not '
      + 'installed. Concurrency-safe.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name. Defaults to the currently streamed device, else a booted simulator.',
      },
      bundle_id: {
        type: 'string',
        required: true,
        description: 'Bundle id of the installed app to inspect (e.g. com.apple.Preferences).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          bundleId: { type: 'string', required: true },
          installed: { type: 'boolean', required: true },
          appPath: { type: 'string' },
          dataPath: { type: 'string' },
          bundleContainer: { type: 'string' },
          displayName: { type: 'string' },
          executable: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'string' },
          shortVersion: { type: 'string' },
          applicationType: { type: 'string' },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args: { udid?: string; bundle_id: string }, exec) {
      assertDebugAvailable()
      const bundleId = args.bundle_id.trim()
      if (bundleId === '') throw new Error('ios_sim_app_info: bundle_id must be a non-empty bundle identifier')
      const device = await resolveDebugDevice(host, args.udid)
      const fields = parseOpenStepPlist(await execSimctlCapture(['appinfo', device.udid, bundleId], exec.signal))
      // appinfo never errors for a missing app — it echoes only the bundle id.
      let installed = fields.Path !== undefined || fields.Bundle !== undefined
      let appPath = fields.Path
      if (!installed) {
        // Older simctl or odd outputs: confirm via get_app_container.
        const container = await getAppContainer(device.udid, bundleId, 'app', exec.signal)
        if (container !== undefined) {
          installed = true
          appPath = container
        }
      }
      let dataPath: string | undefined = fields.DataContainer
      if (installed && dataPath === undefined) {
        dataPath = await getAppContainer(device.udid, bundleId, 'data', exec.signal)
      }
      const bundleContainer = fields.BundleContainer ?? fields.Bundle
      return {
        device: { udid: device.udid, name: device.name, runtime: device.runtime, state: device.state },
        bundleId,
        installed,
        ...(appPath === undefined ? {} : { appPath }),
        ...(dataPath === undefined ? {} : { dataPath }),
        ...(bundleContainer === undefined ? {} : { bundleContainer }),
        ...(fields.CFBundleDisplayName === undefined ? {} : { displayName: fields.CFBundleDisplayName }),
        ...(fields.CFBundleExecutable === undefined ? {} : { executable: fields.CFBundleExecutable }),
        ...(fields.CFBundleName === undefined ? {} : { name: fields.CFBundleName }),
        ...(fields.CFBundleVersion === undefined ? {} : { version: fields.CFBundleVersion }),
        ...(fields.CFBundleShortVersionString === undefined ? {} : { shortVersion: fields.CFBundleShortVersionString }),
        ...(fields.ApplicationType === undefined ? {} : { applicationType: fields.ApplicationType }),
      } satisfies SimAppInfoResult
    },
    presentCall: (args: { bundle_id: string }) => ({
      card: 'generic',
      title: `App info ${args.bundle_id}`,
      kind: 'execute',
    }),
  })

  return {
    iosSimProcesses,
    iosSimBacktrace,
    iosSimLeaks,
    iosSimAppInfo,
    dispose: () => tracker.dispose(),
  }
}
