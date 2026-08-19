/**
 * Typed wrappers over `xcrun devicectl` for physical (USB-connected) iOS
 * devices — the real-device counterpart of simctl.ts.
 *
 * Findings that shape this module (Xcode 26.6, devicectl 518.33):
 * - `--json-output <path>` IS the only scriptable output interface and works
 *   on every subcommand used here; JSON lands in `{ info: { outcome, … },
 *   result | error }` even on failure, so errors are machine-readable.
 * - `devicectl device process terminate` takes `--pid`, not a bundle id, so
 *   terminateApp resolves the bundle id to pids via `device info processes`
 *   cross-referenced with `device info apps`.
 * - `device info apps` only lists developer apps unless
 *   `--include-default-apps --include-app-clips --include-removable-apps`
 *   are passed (with them, stock apps like com.apple.Preferences appear).
 * - devicectl has NO unified-log subcommand and `log collect --device-udid`
 *   requires root, so real-device logs are out of scope for this phase.
 * - Tunnels can hang: every call has a hard ~60 s deadline (default), the
 *   caller's AbortSignal, devicectl's own `--timeout <seconds>` flag, a
 *   detached process-group kill on expiry, and module-level child tracking.
 *
 * Safety contract: this module only ever *reads* device state or
 * launches/terminates/installs what the caller explicitly asks for. Callers
 * must never uninstall apps they did not install themselves.
 * @module @zseven-w/dsh-ios/devicectl
 */

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

/** One physical device as reported by `devicectl list devices`. */
export interface RealDevice {
  /** CoreDevice identifier (the stable udid devicectl and the tools use). */
  udid: string
  /** Hardware udid (e.g. `00008150-…`); this is what xcodebuild destinations show. */
  hardwareUdid?: string
  name: string
  /** OS version string, e.g. `26.6`. */
  osVersion?: string
  /** OS build, e.g. `23G71`. */
  build?: string
  /** Marketing name, e.g. `iPhone 17 Pro`. */
  model?: string
  /** Product type, e.g. `iPhone18,1`. */
  productType?: string
  /** Hardware platform, e.g. `iOS`. */
  platform?: string
  serialNumber?: string
  /** Mirrors the CLI State column, e.g. `available (paired)` or `unavailable`. */
  state: string
  connection: 'wired' | 'wireless' | 'unknown'
  pairingState: 'paired' | 'unpaired' | 'unknown'
  tunnelState?: string
  /** `enabled`, `disabled`, or `unknown` when devicectl reports nothing. */
  developerMode: 'enabled' | 'disabled' | 'unknown'
  bootState?: string
  ddiServicesAvailable?: boolean
}

/** Details for one device from `devicectl device info details`. */
export interface RealDeviceInfo {
  udid: string
  name: string
  osVersion?: string
  build?: string
  model?: string
  productType?: string
  platform?: string
  serialNumber?: string
  ecid?: number
  developerMode: 'enabled' | 'disabled' | 'unknown'
  bootState?: string
  ddiServicesAvailable?: boolean
  tunnelState?: string
  pairingState: 'paired' | 'unpaired' | 'unknown'
  transportType?: string
  capabilities: string[]
}

/** One installed app from `devicectl device info apps`. */
export interface RealApp {
  bundleId: string
  name: string
  /** CFBundleShortVersionString, e.g. `1.0`. */
  version?: string
  /** CFBundleVersion. */
  bundleVersion?: string
  builtByDeveloper?: boolean
  /** True for stock/system apps (the inverse of "developer app"). */
  defaultApp?: boolean
  /** `User` / `System` when devicectl reports the app type as a string. */
  appType?: string
  hidden?: boolean
  internalApp?: boolean
  removable?: boolean
  appClip?: boolean
  /** On-device .app path (no file:// scheme). */
  path?: string
}

/** One running process from `devicectl device info processes`. */
export interface RealProcess {
  /** On-device pid (NOT a host pid — lldb/leaks host attach does not apply). */
  pid: number
  /** On-device executable path (no file:// scheme). */
  executable: string
  /** Bundle id when the process belongs to an installed .app bundle. */
  bundleId?: string
  /** App display name when the bundle id resolved; else the executable's base name. */
  name: string
}

/** A parsed Apple Development signing identity from the login keychain. */
export interface SigningIdentity {
  /** Certificate hash (SHA-1). */
  hash: string
  /** Full identity string, e.g. `Apple Development: Yang Fini (SY43SLGH74)`. */
  name: string
  /** Team identifier from the identity string, when present. */
  teamId?: string
}

/** Error raised when a `xcrun devicectl` invocation fails. */
export class DevicectlError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly stdout: string,
    readonly code?: string | number | null,
  ) {
    super(message)
    this.name = 'DevicectlError'
  }
}

/** Hard deadline for one devicectl call (tunnels can hang). */
const DEFAULT_TIMEOUT_MS = 60_000
const LIST_TIMEOUT_MS = 30_000
const APPS_TIMEOUT_MS = 90_000
const PROCESSES_TIMEOUT_MS = 30_000
const LAUNCH_TIMEOUT_MS = 60_000
const TERMINATE_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 180_000
const UNINSTALL_TIMEOUT_MS = 60_000
const SECURITY_TIMEOUT_MS = 30_000
/** SIGTERM → SIGKILL grace when reaping a stuck devicectl process group. */
const KILL_GRACE_MS = 2_000
/** Raw stdout/stderr capture cap per child (tail kept). */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

/** Shared error text for real-device features that land in a later phase. */
export const REAL_DEVICE_LIVE_VIEW_PHASE =
  'the real-device live view (streaming, screenshot, tap, ui tree) lands in a later phase (WebDriverAgent)'

type DevicectlChild = ChildProcessByStdio<null, Readable, Readable>

/** Every spawned devicectl child, reaped by disposeDevicectlChildren(). */
const children = new Set<DevicectlChild>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Kill a devicectl child's whole process group (xcrun → devicectl → tunnel). */
function signalProcessGroup(child: DevicectlChild, signal: NodeJS.Signals): void {
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

/** Kill every devicectl child still alive (plugin unload / shutdown grace). */
export function disposeDevicectlChildren(): void {
  for (const child of [...children]) signalProcessGroup(child, 'SIGKILL')
}

interface RunOutcome {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  killed: boolean
}

interface RunDevicectlOptions {
  /** Hard deadline; the process group is killed on expiry. */
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Spawn `xcrun devicectl <args>` as a detached group leader, capture its
 * output, and enforce the hard deadline: on timeout or abort the group is
 * SIGTERM'd then SIGKILL'd and the caller gets a typed failure. The child is
 * tracked module-wide so disposeDevicectlChildren() can reap stragglers.
 */
function runDevicectl(args: readonly string[], options: RunDevicectlOptions): Promise<RunOutcome> {
  const { timeoutMs, signal } = options
  if (signal?.aborted === true) throw abortError(signal)
  return new Promise<RunOutcome>((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killed = false
    const child: DevicectlChild = spawn('xcrun', ['devicectl', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Group leader so a kill reaps xcrun → devicectl at once.
      detached: true,
    })
    children.add(child)
    child.once('close', () => children.delete(child))
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
      signal?.removeEventListener('abort', onAbort)
      done()
    }
    const onAbort = (): void => killTree(KILL_GRACE_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(KILL_GRACE_MS)
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_CAPTURE_BYTES) stdout = stdout.slice(-MAX_CAPTURE_BYTES)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > MAX_CAPTURE_BYTES) stderr = stderr.slice(-MAX_CAPTURE_BYTES)
    })
    child.once('error', error => {
      finish(() => reject(new DevicectlError(`devicectl ${args.join(' ')} failed to start: ${errorMessage(error)}`, stderr, stdout)))
    })
    child.once('close', code => {
      finish(() => {
        if (signal?.aborted === true) {
          reject(abortError(signal))
          return
        }
        if (timedOut) {
          reject(new DevicectlError(
            `devicectl ${args.join(' ')} exceeded its ${timeoutMs} ms deadline and was killed — the device tunnel may be stuck; check the USB connection and retry`,
            stderr,
            stdout,
            code,
          ))
          return
        }
        resolve({ stdout, stderr, code, timedOut: false, killed })
      })
    })
  })
}

function abortError(signal: AbortSignal): DevicectlError {
  if (signal.reason instanceof Error) return new DevicectlError(signal.reason.message, '', '')
  return new DevicectlError(
    `devicectl call aborted${typeof signal.reason === 'string' && signal.reason !== '' ? `: ${signal.reason}` : ''}`,
    '',
    '',
  )
}

interface DevicectlResult {
  stdout: string
  stderr: string
  code: number | null
  /** Parsed JSON document written by `--json-output`; undefined when absent/unparseable. */
  json?: unknown
}

let jsonSeq = 0

/**
 * Run one devicectl command with `--json-output <tmp>` + `--timeout <s>` and
 * return the captured result. The JSON file is always removed afterwards.
 */
async function execDevicectl(
  args: readonly string[],
  options: RunDevicectlOptions = { timeoutMs: DEFAULT_TIMEOUT_MS },
): Promise<DevicectlResult> {
  const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000))
  jsonSeq += 1
  const jsonPath = join(tmpdir(), `dsh-ios-devicectl-${process.pid}-${jsonSeq}-${Date.now()}.json`)
  const outcome = await runDevicectl(
    ['--timeout', String(timeoutSeconds), '--json-output', jsonPath, ...args],
    options,
  )
  // devicectl writes the JSON document (including failures) before it exits,
  // so parse it for both zero and non-zero exit codes.
  let json: unknown
  try {
    json = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch {
    json = undefined
  }
  try {
    rmSync(jsonPath, { force: true })
  } catch {
    // Temp file cleanup is best effort.
  }
  return { stdout: outcome.stdout, stderr: outcome.stderr, code: outcome.code, json }
}

/** `info.outcome` of a parsed devicectl JSON document. */
function jsonOutcome(json: unknown): 'success' | 'failed' | 'unknown' {
  if (typeof json !== 'object' || json === null) return 'unknown'
  const info = (json as { info?: unknown }).info
  if (typeof info !== 'object' || info === null) return 'unknown'
  const outcome = (info as { outcome?: unknown }).outcome
  return outcome === 'success' ? 'success' : outcome === 'failed' ? 'failed' : 'unknown'
}

/** Best error description from a devicectl JSON `error` object. */
function jsonErrorDetail(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const error = (json as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as Record<string, unknown>
  const userInfo = record.userInfo
  if (typeof userInfo !== 'object' || userInfo === null) return undefined
  const infos = userInfo as Record<string, unknown>
  const readString = (key: string): string | undefined => {
    const entry = infos[key]
    if (typeof entry !== 'object' || entry === null) return undefined
    const value = (entry as { string?: unknown }).string
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }
  // NSLocalizedFailureReason is the actionable one (e.g. "device … locked").
  return readString('NSLocalizedFailureReason') ?? readString('NSLocalizedDescription')
}

/** Non-empty tail of the CLI text output (fallback diagnostics). */
function textDiagnostic(stdout: string, stderr: string): string {
  const pool = `${stderr}\n${stdout}`.split('\n').map(line => line.trim()).filter(line => line !== '')
  const kept = pool.slice(-6)
  return kept.join(' | ')
}

/** Map raw devicectl failures to clear, actionable errors. */
function classifyFailure(label: string, result: DevicectlResult): DevicectlError {
  const detail = jsonErrorDetail(result.json) ?? textDiagnostic(result.stdout, result.stderr)
  const joined = `${detail}\n${result.stderr}`.trim()
  const lower = joined.toLowerCase()
  if (/unlocked|fbsopenapplication|locked/i.test(lower)) {
    return new DevicectlError(
      `${label} failed because the device is locked — unlock the iPhone and enter its passcode (the device must stay unlocked), then retry`,
      result.stderr,
      result.stdout,
      result.code,
    )
  }
  if (/developer mode/i.test(lower)) {
    return new DevicectlError(
      `${label} failed because Developer Mode is disabled on the device — enable it in Settings → Privacy & Security → Developer Mode (device reboots), then retry`,
      result.stderr,
      result.stdout,
      result.code,
    )
  }
  if (/not paired|unpaired|pairing/i.test(lower)) {
    return new DevicectlError(
      `${label} failed because the device is not paired/trusted — connect it over USB, tap "Trust This Computer", and confirm with \`xcrun devicectl list devices\``,
      result.stderr,
      result.stdout,
      result.code,
    )
  }
  // CoreDevice 1011: "CoreDeviceService was unable to locate a device matching
  // the requested device identifier". Measured cost of NOT saying this: an
  // agent read the empty `device info apps` output as "the app is not
  // installed", concluded the app did not exist, and spent the rest of a 377 s
  // session grepping the user's source trees for it (WP57).
  if (/unable to locate a device|coredeviceservice|coredeviceerror[^\d]*1011/i.test(lower)) {
    return new DevicectlError(
      `${label} failed because the device is not reachable by CoreDevice right now — reconnect it over USB `
      + 'and retry (this is not the same as the app being missing: nothing was enumerated at all)',
      result.stderr,
      result.stdout,
      result.code,
    )
  }
  if (/not found|no such device|device was not specified/i.test(lower)) {
    return new DevicectlError(
      `${label} failed: the device was not found — check the USB connection and \`xcrun devicectl list devices\``,
      result.stderr,
      result.stdout,
      result.code,
    )
  }
  return new DevicectlError(
    `${label} failed (exit ${String(result.code)})${detail === '' ? '' : `: ${detail}`}`,
    result.stderr,
    result.stdout,
    result.code,
  )
}

/**
 * Run one devicectl command and enforce success: exit code 0 AND JSON
 * `info.outcome === "success"` (devicectl sometimes exits 0 with a failed
 * outcome in the JSON). Throws DevicectlError with a classified message.
 */
async function runSuccessful(
  args: readonly string[],
  label: string,
  options: RunDevicectlOptions = { timeoutMs: DEFAULT_TIMEOUT_MS },
): Promise<DevicectlResult> {
  const result = await execDevicectl(args, options)
  const outcome = jsonOutcome(result.json)
  const failed = result.code !== 0 || outcome === 'failed'
  if (!failed) return result
  throw classifyFailure(label, result)
}

/** The `result` object of a successful devicectl JSON document. */
function resultJson(result: DevicectlResult): Record<string, unknown> | undefined {
  if (typeof result.json !== 'object' || result.json === null) return undefined
  const nested = (result.json as { result?: unknown }).result
  if (typeof nested !== 'object' || nested === null) return undefined
  return nested as Record<string, unknown>
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Strip a `file://` scheme from an on-device path. */
function stripFileUrl(value: string): string {
  return value.startsWith('file://') ? value.slice('file://'.length) : value
}

/** Derive the CLI-style state string for one device record. */
function deriveState(
  connectionProperties: Record<string, unknown> | undefined,
  pairingState: string | undefined,
): string {
  const tunnelState = connectionProperties === undefined
    ? undefined
    : readStringField(connectionProperties, 'tunnelState')
  if (tunnelState === 'unavailable' || connectionProperties === undefined) return 'unavailable'
  return pairingState === 'paired' ? 'available (paired)' : 'available'
}

function parseJsonDevices(json: unknown): RealDevice[] {
  if (typeof json !== 'object' || json === null) return []
  const result = (json as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) return []
  const entries = (result as { devices?: unknown }).devices
  if (!Array.isArray(entries)) return []
  const devices: RealDevice[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const identifier = readStringField(record, 'identifier')
    if (identifier === undefined) continue
    const deviceProperties = typeof record.deviceProperties === 'object' && record.deviceProperties !== null
      ? record.deviceProperties as Record<string, unknown>
      : undefined
    const hardwareProperties = typeof record.hardwareProperties === 'object' && record.hardwareProperties !== null
      ? record.hardwareProperties as Record<string, unknown>
      : undefined
    const connectionProperties = typeof record.connectionProperties === 'object' && record.connectionProperties !== null
      ? record.connectionProperties as Record<string, unknown>
      : undefined
    const pairingState = connectionProperties === undefined
      ? 'unknown'
      : readStringField(connectionProperties, 'pairingState') ?? 'unknown'
    const developerMode = deviceProperties === undefined
      ? 'unknown'
      : readStringField(deviceProperties, 'developerModeStatus') ?? 'unknown'
    const transport = connectionProperties === undefined
      ? 'unknown'
      : readStringField(connectionProperties, 'transportType') ?? 'unknown'
    // EVERY optional field is spread in per-field, never assigned. Guarding
    // only the PARENT (`deviceProperties === undefined ? {} : {...}`) still
    // materializes each missing child as a key holding `undefined`, and DSH's
    // lossless-JSON boundary rejects a present key whose value is undefined —
    // which fails the WHOLE `ios_sim_devices` call, not just that field. One
    // half-described device (an offline iPad that reports no bootState /
    // marketingName / serialNumber) is enough to take the tool down, so the
    // omission has to be per field. Reads are hoisted so each property is
    // read once rather than twice per conditional.
    const hardwareUdid = hardwareProperties === undefined ? undefined : readStringField(hardwareProperties, 'udid')
    const osVersion = deviceProperties === undefined ? undefined : readStringField(deviceProperties, 'osVersionNumber')
    const build = deviceProperties === undefined ? undefined : readStringField(deviceProperties, 'osBuildUpdate')
    const bootState = deviceProperties === undefined ? undefined : readStringField(deviceProperties, 'bootState')
    const model = hardwareProperties === undefined ? undefined : readStringField(hardwareProperties, 'marketingName')
    const productType = hardwareProperties === undefined ? undefined : readStringField(hardwareProperties, 'productType')
    const platform = hardwareProperties === undefined ? undefined : readStringField(hardwareProperties, 'platform')
    const serialNumber = hardwareProperties === undefined ? undefined : readStringField(hardwareProperties, 'serialNumber')
    const tunnelState = connectionProperties === undefined ? undefined : readStringField(connectionProperties, 'tunnelState')
    devices.push({
      udid: identifier,
      ...(hardwareUdid === undefined ? {} : { hardwareUdid }),
      name: (deviceProperties === undefined ? undefined : readStringField(deviceProperties, 'name')) ?? identifier,
      ...(osVersion === undefined ? {} : { osVersion }),
      ...(build === undefined ? {} : { build }),
      ...(bootState === undefined ? {} : { bootState }),
      ...(deviceProperties?.ddiServicesAvailable === true ? { ddiServicesAvailable: true } : {}),
      ...(model === undefined ? {} : { model }),
      ...(productType === undefined ? {} : { productType }),
      ...(platform === undefined ? {} : { platform }),
      ...(serialNumber === undefined ? {} : { serialNumber }),
      state: deriveState(connectionProperties, pairingState),
      connection: transport === 'wired' || transport === 'wireless' ? transport : 'unknown',
      pairingState: pairingState === 'paired' || pairingState === 'unpaired' ? pairingState : 'unknown',
      ...(tunnelState === undefined ? {} : { tunnelState }),
      developerMode: developerMode === 'enabled' || developerMode === 'disabled' ? developerMode : 'unknown',
    })
  }
  return devices
}

/**
 * Text fallback for `devicectl list devices` (used when JSON output is
 * unavailable). Columns are located by their header names.
 */
function parseDevicesText(stdout: string): RealDevice[] {
  const lines = stdout.split('\n').map(line => line.replace(/\r$/, ''))
  const headerIndex = lines.findIndex(line => line.includes('Identifier'))
  if (headerIndex < 0) return []
  const header = lines[headerIndex]
  const columnAt = (name: string): number | undefined => {
    let from = 0
    for (;;) {
      const index = header.indexOf(name, from)
      if (index < 0) return undefined
      // Require a separator right after the header word.
      const boundary = index + name.length
      if (boundary >= header.length || /[\s-]/.test(header[boundary])) return index
      from = index + 1
    }
  }
  const idAt = columnAt('Identifier')
  const nameAt = columnAt('Name')
  const stateAt = columnAt('State')
  const modelAt = columnAt('Model')
  if (idAt === undefined) return []
  const slice = (line: string, start: number, next: number | undefined): string =>
    line.slice(start, next).trim()
  const starts = [idAt, nameAt, stateAt, modelAt].filter((v): v is number => v !== undefined).sort((a, b) => a - b)
  const devices: RealDevice[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim() === '' || line.trim().startsWith('-')) continue
    const id = slice(line, idAt, starts.find(v => v > idAt))
    if (id === '') continue
    const name = nameAt === undefined ? id : slice(line, nameAt, starts.find(v => v > nameAt))
    const state = stateAt === undefined ? 'unknown' : slice(line, stateAt, starts.find(v => v > stateAt))
    devices.push({
      udid: id,
      name,
      state,
      connection: 'unknown',
      pairingState: state.includes('paired') ? 'paired' : 'unknown',
      developerMode: 'unknown',
      ...(modelAt === undefined ? {} : { model: slice(line, modelAt, starts.find(v => v > modelAt)) }),
    })
  }
  return devices
}

/** List every physical device devicectl knows about (JSON first, text fallback). */
export async function listRealDevices(signal?: AbortSignal): Promise<RealDevice[]> {
  const result = await execDevicectl(['list', 'devices'], { timeoutMs: LIST_TIMEOUT_MS, signal })
  if (result.code !== 0) throw classifyFailure('devicectl list devices', result)
  const jsonDevices = parseJsonDevices(result.json)
  if (jsonDevices.length > 0 || result.json !== undefined) return jsonDevices
  return parseDevicesText(result.stdout)
}

/**
 * Resolve a user-supplied reference (identifier, hardware udid, or
 * case-insensitive device name) to one physical device. Unknown references
 * fail with a short list of the connected devices.
 */
export async function getRealDevice(reference: string, signal?: AbortSignal): Promise<RealDevice> {
  const trimmed = reference.trim()
  if (trimmed === '') throw new DevicectlError('device reference must be a non-empty udid or device name', '', '')
  const devices = await listRealDevices(signal)
  const lower = trimmed.toLowerCase()
  const byUdid = devices.find(device => device.udid === trimmed || device.hardwareUdid === trimmed)
  if (byUdid !== undefined) return byUdid
  const byName = devices.filter(device => device.name.toLowerCase() === lower)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) return byName[0]
  const names = devices.slice(0, 8).map(device => `${device.name} (${device.udid})`)
  throw new DevicectlError(
    `no connected physical device matches "${trimmed}" — run ios_sim_devices to list real devices`
      + (names.length === 0 ? '; no physical device is currently connected' : `; connected devices: ${names.join(', ')}`),
    '',
    '',
  )
}

/**
 * True when `reference` names a connected physical device. Never throws:
 * when devicectl itself is unavailable this returns false so the simulator
 * tool paths keep working unchanged.
 */
export async function matchesRealDevice(reference: string, signal?: AbortSignal): Promise<boolean> {
  const trimmed = reference.trim()
  if (trimmed === '') return false
  try {
    const devices = await listRealDevices(signal)
    const lower = trimmed.toLowerCase()
    return devices.some(device =>
      device.udid === trimmed
      || device.hardwareUdid === trimmed
      || device.name.toLowerCase() === lower)
  } catch {
    return false
  }
}

/** Require a device to be paired and available before any mutation. */
export function requireAvailable(device: RealDevice): void {
  if (device.pairingState !== 'paired' || device.state === 'unavailable') {
    throw new DevicectlError(
      `device "${device.name}" is not available (state ${device.state}) — connect it over USB and confirm pairing with \`xcrun devicectl list devices\``,
      '',
      '',
    )
  }
}

/** Facts about one device via `devicectl device info details`. */
export async function deviceInfo(udid: string, signal?: AbortSignal): Promise<RealDeviceInfo> {
  const result = await runSuccessful(
    ['device', 'info', 'details', '--device', udid],
    `devicectl device info details for ${udid}`,
    { timeoutMs: DEFAULT_TIMEOUT_MS, signal },
  )
  const nested = resultJson(result)
  if (nested === undefined) {
    throw new DevicectlError(`devicectl device info details for ${udid} returned no JSON result`, result.stderr, result.stdout)
  }
  const deviceProperties = typeof nested.deviceProperties === 'object' && nested.deviceProperties !== null
    ? nested.deviceProperties as Record<string, unknown>
    : {}
  const hardwareProperties = typeof nested.hardwareProperties === 'object' && nested.hardwareProperties !== null
    ? nested.hardwareProperties as Record<string, unknown>
    : {}
  const connectionProperties = typeof nested.connectionProperties === 'object' && nested.connectionProperties !== null
    ? nested.connectionProperties as Record<string, unknown>
    : {}
  const developerMode = readStringField(deviceProperties, 'developerModeStatus') ?? 'unknown'
  const pairingState = readStringField(connectionProperties, 'pairingState') ?? 'unknown'
  const capabilities = Array.isArray(nested.capabilities)
    ? nested.capabilities.flatMap(entry =>
      typeof entry === 'object' && entry !== null
        ? [readStringField(entry as Record<string, unknown>, 'featureIdentifier')].filter((v): v is string => v !== undefined)
        : [])
    : []
  const ecidRaw = hardwareProperties.ecid
  return {
    udid: nested.identifier !== undefined && typeof nested.identifier === 'string' ? nested.identifier : udid,
    name: readStringField(deviceProperties, 'name') ?? udid,
    ...(readStringField(deviceProperties, 'osVersionNumber') === undefined ? {} : { osVersion: readStringField(deviceProperties, 'osVersionNumber') }),
    ...(readStringField(deviceProperties, 'osBuildUpdate') === undefined ? {} : { build: readStringField(deviceProperties, 'osBuildUpdate') }),
    ...(readStringField(hardwareProperties, 'marketingName') === undefined ? {} : { model: readStringField(hardwareProperties, 'marketingName') }),
    ...(readStringField(hardwareProperties, 'productType') === undefined ? {} : { productType: readStringField(hardwareProperties, 'productType') }),
    ...(readStringField(hardwareProperties, 'platform') === undefined ? {} : { platform: readStringField(hardwareProperties, 'platform') }),
    ...(readStringField(hardwareProperties, 'serialNumber') === undefined ? {} : { serialNumber: readStringField(hardwareProperties, 'serialNumber') }),
    ...(typeof ecidRaw === 'number' ? { ecid: ecidRaw } : {}),
    developerMode: developerMode === 'enabled' || developerMode === 'disabled' ? developerMode : 'unknown',
    ...(readStringField(deviceProperties, 'bootState') === undefined ? {} : { bootState: readStringField(deviceProperties, 'bootState') }),
    ...(deviceProperties.ddiServicesAvailable === true ? { ddiServicesAvailable: true } : {}),
    ...(readStringField(connectionProperties, 'tunnelState') === undefined ? {} : { tunnelState: readStringField(connectionProperties, 'tunnelState') }),
    pairingState: pairingState === 'paired' || pairingState === 'unpaired' ? pairingState : 'unknown',
    ...(readStringField(connectionProperties, 'transportType') === undefined ? {} : { transportType: readStringField(connectionProperties, 'transportType') }),
    capabilities,
  }
}

/** Flags so `device info apps` includes stock/default apps (not just developer apps). */
const ALL_APPS_FLAGS = ['--include-default-apps', '--include-app-clips', '--include-removable-apps']

/**
 * Parse `result.apps[]`, or `undefined` when the document carries NO apps array
 * at all. The distinction is the point: an absent array means devicectl never
 * enumerated anything (an unreachable device, a truncated JSON write), while an
 * empty array is a real answer. Collapsing the two is what let a failed listing
 * read as "the app is not installed" (WP57).
 */
function parseJsonApps(json: unknown): RealApp[] | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const result = (json as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) return undefined
  const entries = (result as { apps?: unknown }).apps
  if (!Array.isArray(entries)) return undefined
  const apps: RealApp[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const bundleId = readStringField(record, 'bundleIdentifier')
    if (bundleId === undefined) continue
    apps.push({
      bundleId,
      name: readStringField(record, 'name') ?? bundleId,
      ...(readStringField(record, 'version') === undefined ? {} : { version: readStringField(record, 'version') }),
      ...(readStringField(record, 'bundleVersion') === undefined ? {} : { bundleVersion: readStringField(record, 'bundleVersion') }),
      ...(record.builtByDeveloper === true ? { builtByDeveloper: true } : {}),
      ...(record.defaultApp === true ? { defaultApp: true } : {}),
      ...(readStringField(record, 'appType') === undefined ? {} : { appType: readStringField(record, 'appType') }),
      ...(record.hidden === true ? { hidden: true } : {}),
      ...(record.internalApp === true ? { internalApp: true } : {}),
      ...(record.removable === true ? { removable: true } : {}),
      ...(record.appClip === true ? { appClip: true } : {}),
      ...(readStringField(record, 'url') === undefined ? {} : { path: stripFileUrl(readStringField(record, 'url')!) }),
    })
  }
  return apps
}

/**
 * All apps installed on the device, including stock/default apps. Exit code 0
 * with no `result.apps` array THROWS: the listing did not happen, and callers
 * (ios_sim_list_apps, launch-by-name) must never report that as zero apps.
 */
export async function listApps(udid: string, signal?: AbortSignal): Promise<RealApp[]> {
  const result = await runSuccessful(
    ['device', 'info', 'apps', '--device', udid, ...ALL_APPS_FLAGS],
    `devicectl device info apps for ${udid}`,
    { timeoutMs: APPS_TIMEOUT_MS, signal },
  )
  const apps = parseJsonApps(result.json)
  if (apps === undefined) {
    throw new DevicectlError(
      `devicectl device info apps for ${udid} reported success but wrote no app list — the enumeration `
      + 'failed (reconnect the device over USB and retry); this is not the same as the device having no apps',
      result.stderr,
      result.stdout,
      result.code,
    )
  }
  return apps
}

/** One installed app by exact bundle id; undefined when not installed. */
export async function getApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<RealApp | undefined> {
  const result = await runSuccessful(
    ['device', 'info', 'apps', '--device', udid, ...ALL_APPS_FLAGS, '--bundle-id', bundleId],
    `devicectl device info apps --bundle-id ${bundleId} for ${udid}`,
    { timeoutMs: APPS_TIMEOUT_MS, signal },
  )
  // Lenient on purpose (unlike listApps): a single-bundle query that comes back
  // without an apps array is ios_sim_app_info's documented installed:false.
  const apps = parseJsonApps(result.json) ?? []
  return apps.find(app => app.bundleId === bundleId)
}

/**
 * All running processes on the device. App processes are enriched with
 * bundleId/display name by cross-referencing the installed-apps list
 * (a process whose executable lives inside an installed .app bundle belongs
 * to that app). Pids are ON-DEVICE pids, not host pids.
 */
export async function listProcesses(udid: string, signal?: AbortSignal): Promise<RealProcess[]> {
  const result = await runSuccessful(
    ['device', 'info', 'processes', '--device', udid],
    `devicectl device info processes for ${udid}`,
    { timeoutMs: PROCESSES_TIMEOUT_MS, signal },
  )
  const nested = resultJson(result)
  const entries = nested === undefined ? undefined : nested.runningProcesses
  if (!Array.isArray(entries)) {
    throw new DevicectlError(`devicectl device info processes for ${udid} returned no process list`, result.stderr, result.stdout)
  }
  const processes: RealProcess[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const pid = record.processIdentifier
    const executableRaw = readStringField(record, 'executable')
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || executableRaw === undefined) continue
    const executable = stripFileUrl(executableRaw)
    processes.push({ pid, executable, name: executable.split('/').pop() ?? executable })
  }
  let apps: RealApp[] | undefined
  try {
    apps = await listApps(udid, signal)
  } catch {
    apps = undefined // bundle-id enrichment is best effort; raw pids still return.
  }
  if (apps !== undefined) {
    const byPath = new Map<string, RealApp>()
    for (const app of apps) {
      if (app.path === undefined) continue
      const normalized = app.path.endsWith('/') ? app.path : `${app.path}/`
      byPath.set(normalized, app)
    }
    for (const process of processes) {
      const prefix = `${process.executable.split('/').slice(0, -1).join('/')}/`
      const app = byPath.get(prefix)
      if (app !== undefined) {
        process.bundleId = app.bundleId
        process.name = app.name
      }
    }
  }
  return processes.sort((a, b) => a.pid - b.pid)
}

/** Launch a bundle id; resolves the on-device pid devicectl reports. */
export async function launchApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<{ pid?: number }> {
  const result = await runSuccessful(
    ['device', 'process', 'launch', '--device', udid, bundleId],
    `devicectl device process launch ${bundleId} on ${udid}`,
    { timeoutMs: LAUNCH_TIMEOUT_MS, signal },
  )
  const nested = resultJson(result)
  const process = nested === undefined || typeof nested.process !== 'object' || nested.process === null
    ? undefined
    : nested.process as Record<string, unknown>
  const pid = process?.processIdentifier
  return { ...(typeof pid === 'number' && Number.isInteger(pid) ? { pid } : {}) }
}

/**
 * Terminate every running process of a bundle id (the app process plus any
 * extensions in its bundle), mirroring `simctl terminate` semantics.
 * Returns the terminated pids; throws a clear error when the app is not
 * running.
 */
export async function terminateApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<{ pids: number[] }> {
  const processes = await listProcesses(udid, signal)
  const last = bundleId.split('.').pop() ?? bundleId
  let matches = processes.filter(process => process.bundleId === bundleId)
  if (matches.length === 0) {
    matches = processes.filter(process => process.name === last)
  }
  if (matches.length === 0) {
    throw new DevicectlError(
      `no running process for bundle id "${bundleId}" on the device — launch the app first, then retry`,
      '',
      '',
    )
  }
  const terminated: number[] = []
  for (const process of matches) {
    try {
      await runSuccessful(
        ['device', 'process', 'terminate', '--device', udid, '--pid', String(process.pid)],
        `devicectl device process terminate pid ${process.pid} (${bundleId}) on ${udid}`,
        { timeoutMs: TERMINATE_TIMEOUT_MS, signal },
      )
      terminated.push(process.pid)
    } catch (error) {
      // The process may have exited between listing and terminating.
      if (error instanceof DevicectlError && /not found|no such process/i.test(error.message)) continue
      throw error
    }
  }
  return { pids: terminated }
}

/** Install a signed `.app` bundle on the device. Only self-built apps, ever. */
export async function installApp(udid: string, appPath: string, signal?: AbortSignal): Promise<void> {
  await runSuccessful(
    ['device', 'install', 'app', '--device', udid, appPath],
    `devicectl device install app ${appPath} on ${udid}`,
    { timeoutMs: INSTALL_TIMEOUT_MS, signal },
  )
}

/** Uninstall an app by bundle id. Callers must only uninstall apps they installed. */
export async function uninstallApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<void> {
  await runSuccessful(
    ['device', 'uninstall', 'app', '--device', udid, bundleId],
    `devicectl device uninstall app ${bundleId} on ${udid}`,
    { timeoutMs: UNINSTALL_TIMEOUT_MS, signal },
  )
}

/**
 * Look up an Apple Development signing identity in the login keychain
 * (`security find-identity -v -p codesigning`). Returns undefined when no
 * valid Apple Development identity exists — the callers then refuse
 * device-install flows and explain the code-signing requirements instead.
 */
export async function detectAppleDevelopmentIdentity(signal?: AbortSignal): Promise<SigningIdentity | undefined> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('security', ['find-identity', '-v', '-p', 'codesigning'], {
      timeout: SECURITY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      signal,
    }, (error, out, stderr) => {
      if (error !== null) {
        reject(new DevicectlError(
          `security find-identity failed${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`,
          stderr,
          out,
          error.code,
        ))
        return
      }
      resolve(out)
    })
  })
  const pattern = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(Apple Development(?:[^"]*))"/gmu
  for (const match of stdout.matchAll(pattern)) {
    const identity = match[2].trim()
    const teamMatch = /\(([0-9A-Z]{10})\)\s*$/u.exec(identity)
    return {
      hash: match[1],
      name: identity,
      ...(teamMatch === null ? {} : { teamId: teamMatch[1] }),
    }
  }
  return undefined
}
