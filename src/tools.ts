/**
 * Model-facing tools for the iOS Simulator plugin.
 *
 * Every tool returns plain JSON (never an image content block — the DeepSeek
 * adapter rejects image blocks anywhere in a request). Visual bytes reach the
 * UI only through `output.presentationMeta`, which projects pure, replayable
 * data (device udid, screenshot file path, stable stream route id) — the
 * client/web-route layer re-mints access at render time.
 *
 * Degradation mirrors dsh-openpencil: the tools always register, but their
 * `execute` throws a clear explanatory error on non-macOS hosts or when the
 * serve-sim stream binary is unavailable.
 * @module @zseven-w/dsh-ios/tools
 */

import {
  ToolArgsError,
  defineTool,
  type JsonValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import {
  filterInstalledApps,
  listPhysicalDeviceApps,
  listSimulatorApps,
  noMatchCandidateLines,
  noMatchListingHint,
  resolveAppByName,
  type InstalledApp,
} from './app-list.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRun,
  detectProject,
  type BuildRunResult,
} from './build-run.js'
import {
  SIM_GESTURE_STEP_MS,
  sendSimGesture,
  simDragPath,
  simDragRequestOf,
  simScrollPath,
  type SimGesturePoint,
  type SimScrollRequest,
} from './sim-gesture.js'
import type { SimHostController, SimStreamInfo } from './sim-host.js'
import {
  bootDevice,
  bootedDevices,
  compareRuntimesDesc,
  getDevice,
  launchApp,
  listDevices,
  shutdownDevice,
  takeScreenshot,
  terminateApp,
  type SimulatorDevice,
} from './simctl.js'
import {
  getRealDevice,
  launchApp as devicectlLaunchApp,
  listRealDevices,
  matchesRealDevice,
  requireAvailable,
  terminateApp as devicectlTerminateApp,
  type RealDevice,
} from './devicectl.js'
import {
  WdaStreamSource,
  type StreamScreenshot,
  type WdaControllerLike,
} from './stream-source.js'
import {
  WdaError,
  wdaFailureDetail,
  type WdaFailureReason,
} from './wda-host.js'

/** Registered tool names, in registration order. */
export const IOS_TOOL_NAMES = [
  'ios_sim_devices',
  'ios_sim_boot',
  'ios_sim_shutdown',
  'ios_sim_screenshot',
  'ios_sim_interact',
  'ios_sim_list_apps',
  'ios_sim_launch_app',
  'ios_sim_build_run',
  'ios_real_start_wda',
] as const

/** One simulator device as returned by the tools. */
export interface SimDeviceInfo {
  udid: string
  name: string
  runtime: string
  state: string
}

export interface SimDevicesResult {
  devices: SimDeviceInfo[]
  count: number
  /** Udids currently in the Booted state. */
  booted: string[]
  /** USB-connected physical iOS devices (devicectl); simulator list unchanged. */
  realDevices: RealDevice[]
  realCount: number
  /** Set when the physical-device listing itself failed (simulator list still valid). */
  note?: string
}

export interface SimBootResult {
  device: SimDeviceInfo
  state: 'booted'
  streaming: true
}

export interface SimShutdownResult {
  device: SimDeviceInfo
  state: 'shutdown'
  streaming: false
}

/** Screenshot summary — the value the tools return instead of image bytes. */
export interface SimScreenshotResult {
  path: string
  bytes: number
  width?: number
  height?: number
  device: SimDeviceInfo
}

export interface SimInteractResult {
  action: 'tap' | 'type' | 'button' | 'gesture' | 'scroll'
  path: string
  bytes: number
  width?: number
  height?: number
  device: SimDeviceInfo
}

export interface SimBuildRunResult extends BuildRunResult {}

/** `ios_real_start_wda` result: WDA is up and the panel can stream. */
export interface SimRealStartWdaResult {
  device: SimDeviceInfo
  ready: true
  /** Local port of the WDA control tunnel (REST). */
  controlPort: number
  /** Local port of the WDA MJPEG tunnel (the panel stream). */
  mjpegPort: number
  /** True when an already-running WDA was adopted instead of built. */
  adopted: boolean
}

export interface SimInteractArgs {
  /** Physical-device udid/name for the WebDriverAgent path; omit for the streamed simulator. */
  udid?: string
  action: 'tap' | 'type' | 'button' | 'gesture' | 'scroll'
  x?: number
  y?: number
  text?: string
  name?: string
  json?: JsonValue
  /** Scroll direction (required when action is "scroll"). */
  direction?: 'up' | 'down' | 'left' | 'right'
  /** Fraction of the screen the scroll travels, 0..1 (default 0.6). */
  amount?: number
}

/** Physical-device resolution used by the tools (devicectl by default). */
export interface RealDeviceResolution {
  /** True when `reference` names a connected physical device. */
  matches(reference: string, signal?: AbortSignal): Promise<boolean>
  /** Resolve a physical-device reference (udid/hardware udid/name). */
  resolve(reference: string, signal?: AbortSignal): Promise<RealDevice>
}

/**
 * The WebDriverAgent backend contract the model tools use (satisfied by
 * `WdaController` as-is): the shared `WdaControllerLike` surface plus the
 * classified failure view so tools can surface actionable reasons, and the
 * tunnel ports/adoption flag so `ios_real_start_wda` can report them.
 */
export interface WdaToolBackend extends WdaControllerLike {
  status(): ReturnType<WdaControllerLike['status']> & {
    /** Classified failure of the last attempt (locked/cert/profile/…). */
    reason?: string
    /** Human-actionable detail for `reason`. */
    detail?: string
    /** Local control-tunnel port actually used. */
    controlPort?: number
    /** Local MJPEG-tunnel port actually used. */
    mjpegPort?: number
    /** True when a pre-existing WDA was adopted instead of spawned. */
    adopted?: boolean
  }
}

/** A tool target: a simulator (simctl/AXe/serve-sim) or a physical device (WDA). */
export type ToolTarget =
  | { kind: 'simulator'; device: SimulatorDevice }
  | { kind: 'real'; device: RealDevice }

export interface SimToolsOptions {
  /** Plugin-owned cache root for screenshots and builds (default `<tmp>/dsh-ios`). */
  cacheDir?: string
  /**
   * WebDriverAgent backend for physical devices (one tool, two backends).
   * When absent, real-device references still resolve but fail with a clear
   * "backend not configured" error instead of the old phase refusal.
   */
  wda?: WdaToolBackend
  /** Physical-device resolution override (tests); defaults to devicectl. */
  realDevices?: RealDeviceResolution
  /** Invalidate UI-tree depth hints after a successful foreground-app change. */
  onFrontmostAppChanged?: (udid: string) => void
}

/** The nine tool definitions bound to one sim host controller. */
export interface SimTools {
  iosSimDevices: ToolDefinition
  iosSimBoot: ToolDefinition
  iosSimShutdown: ToolDefinition
  iosSimScreenshot: ToolDefinition
  iosSimInteract: ToolDefinition
  iosSimListApps: ToolDefinition
  iosSimLaunchApp: ToolDefinition
  iosSimBuildRun: ToolDefinition
  iosRealStartWda: ToolDefinition
}

/** What `ios_sim_list_apps` reports (the listing, never a partial one). */
export interface SimListAppsResult {
  device: SimDeviceInfo
  count: number
  apps: InstalledApp[]
  /** "name (bundleId)" lines from the SAME listing when a query matched nothing. */
  candidates?: string[]
  /**
   * Guidance attached when a query matched nothing on a SUCCESSFUL listing:
   * base-name vs genuinely-not-installed, plus the listed total (WP60).
   */
  hint?: string
}

/** What `ios_sim_launch_app` reports. */
export interface SimLaunchAppResult {
  device: SimDeviceInfo | { udid: string; name: string }
  bundleId: string
  /** Display name when the call resolved a `name` instead of a bundle id. */
  name?: string
  launched: true
  /** Process id, when the backend reports one (devicectl does, simctl may). */
  pid?: number
  /** Whether a running instance was terminated first. */
  relaunched?: boolean
}

/** Error prefix required on non-macOS/unavailable hosts. */
const SIMULATOR_UNAVAILABLE = 'iOS Simulator requires macOS with Xcode'

/** Settle delay after an interaction, before the effect screenshot. */
const INTERACT_SETTLE_MS = 300

/**
 * Hold between the begin→move and move→end gesture frames of the CLI FALLBACK
 * gesture path. serve-sim's own drag path halves the press duration
 * (duration * 500 with a 20..2000 ms clamp), so 175 ms keeps the begin/move/end
 * timing consistent with the 0.35 s scroll the device path sends.
 *
 * WP56: this path is the fallback now, not the default — one serve-sim process
 * per touch event measured 2.05 s for a 7-event scroll (~290 ms of stationary
 * contact before the first move), which iOS reads as a press-and-drag rather
 * than a swipe. Live gestures go over the stream's control socket instead
 * (src/sim-gesture.ts, ~300 ms); this stays for the window before the stream
 * (and its wsUrl) exists.
 */
const SCROLL_HOLD_MS = 175

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** One physical device in `ios_sim_devices.realDevices` (devicectl shape). */
const realDeviceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    udid: { type: 'string', required: true },
    hardwareUdid: { type: 'string' },
    name: { type: 'string', required: true },
    osVersion: { type: 'string' },
    build: { type: 'string' },
    model: { type: 'string' },
    productType: { type: 'string' },
    platform: { type: 'string' },
    serialNumber: { type: 'string' },
    state: { type: 'string', required: true },
    connection: { type: 'string', required: true },
    pairingState: { type: 'string', required: true },
    tunnelState: { type: 'string' },
    developerMode: { type: 'string', required: true },
    bootState: { type: 'string' },
    ddiServicesAvailable: { type: 'boolean' },
  },
} as const

/**
 * Real-device guard for the simulator-lifecycle tools (boot/shutdown): a
 * physical phone is not booted or shut down from this Mac. The refusal now
 * names the specific reason and points at the WDA-backed tools instead of
 * the old "later phase (WebDriverAgent)" message.
 */
async function rejectRealDeviceReference(
  tool: string,
  reference: string | undefined,
  detail: string,
  realDevices: RealDeviceResolution,
  signal?: AbortSignal,
): Promise<void> {
  if (reference === undefined || reference.trim() === '') return
  if (await realDevices.matches(reference, signal)) {
    throw new Error(`${tool}: "${reference.trim()}" is a physical iOS device — ${detail}`)
  }
}

/** The shared device summary shape for real-device tool results. */
export function realDeviceSummary(device: RealDevice): SimDeviceInfo {
  return { udid: device.udid, name: device.name, runtime: device.osVersion ?? '', state: device.state }
}

/** WdaController's default launch timeout (matches its `startTimeoutMs`). */
const WDA_START_TIMEOUT_MS = 300_000

/** Turn a failed WDA launch into a tool error with the actionable reason.
 * `hint` is prepended to the detail for the interaction tools (which must
 * not build) so the model is told to run `ios_real_start_wda` first; the
 * start tool itself omits it. */
function wdaActionableError(
  tool: string,
  wda: WdaToolBackend,
  deviceName: string,
  error: unknown,
  hint?: string,
): Error {
  const status = wda.status()
  const reason = error instanceof WdaError ? error.reason : undefined
  const detail = (reason !== undefined ? wdaFailureDetail(reason, deviceName, WDA_START_TIMEOUT_MS) : undefined)
    ?? status.detail
  if (detail !== undefined) {
    return new Error(`${tool}: WebDriverAgent is not available for "${deviceName}" — ${hint === undefined ? '' : `${hint}; `}${detail}`)
  }
  return error instanceof Error ? error : new Error(`${tool}: ${String(error)}`)
}

/** What the four interaction tools tell the model when WDA is down. */
const WDA_START_FIRST_HINT = 'run ios_real_start_wda first (a cold build can take minutes)'

/**
 * Bring WDA up for a real-device tool call. A classified failure recorded by
 * the controller (locked device, untrusted cert, expired profile, unplugged,
 * not-built) fails fast with its actionable detail instead of re-attempting
 * a minutes-long build inside the tool call; otherwise `ensureRunning`
 * adopts the running WDA or starts one, and its failures are translated the
 * same way. The interaction tools (screenshot/interact/ui_tree/tap_element)
 * always name `ios_real_start_wda` as the way to bring WDA up.
 */
export async function ensureWdaRunning(tool: string, wda: WdaToolBackend, device: RealDevice): Promise<void> {
  const status = wda.status()
  if (!status.running && status.reason !== undefined) {
    const reason = status.reason as WdaFailureReason
    const detail = status.detail ?? wdaFailureDetail(reason, device.name, WDA_START_TIMEOUT_MS)
    throw new Error(`${tool}: WebDriverAgent is not available for "${device.name}" — ${WDA_START_FIRST_HINT}; ${detail}`)
  }
  try {
    await wda.ensureRunning({ udid: device.udid })
  } catch (error) {
    throw wdaActionableError(tool, wda, device.name, error, WDA_START_FIRST_HINT)
  }
}

/** Options for the real-device gate in `resolveToolTarget`. */
export interface ResolveToolTargetOptions {
  /**
   * False for the devicectl-only tools (ios_sim_list_apps / ios_sim_launch_app;
   * ios_sim_processes / ios_sim_app_info already resolve through devicectl in
   * src/tool-debug.ts): their physical-device path only runs `xcrun devicectl`,
   * so a missing WDA host must not lock them out. Defaults to true, so every
   * WDA-backed tool (screenshot / interact / ui_tree / tap_element / find_text /
   * tap_text / wait_for) keeps requiring the backend unchanged.
   */
  requiresWda?: boolean
}

/**
 * Resolve the device a tool should operate on: an explicit reference that
 * names a connected physical device selects the WebDriverAgent backend
 * (unless the tool declared itself devicectl-only via `requiresWda: false`);
 * anything else resolves through the simulator path unchanged (explicit
 * udid/name → streamed device → booted simulator).
 */
export async function resolveToolTarget(
  host: SimHostController,
  wda: WdaToolBackend | undefined,
  realDevices: RealDeviceResolution,
  reference: string | undefined,
  signal?: AbortSignal,
  options: ResolveToolTargetOptions = {},
): Promise<ToolTarget> {
  const trimmed = reference?.trim() ?? ''
  if (trimmed !== '' && await realDevices.matches(trimmed, signal)) {
    // WP59: "what is installed?" is the question asked BEFORE starting WDA (a
    // cold build takes minutes), so the devicectl-only tools skip the WDA gate
    // entirely — a phone is listed with `xcrun devicectl` alone (measured
    // 351 ms / 274 apps with WDA merely PRESENT, never started). The WDA-backed
    // tools keep the gate, and a simulator-only tool asked about a phone still
    // rejects through rejectRealDeviceReference above.
    if (options.requiresWda !== false && wda === undefined) {
      throw new Error(
        `"${trimmed}" is a physical iOS device but the WebDriverAgent backend is not configured — `
        + 'the ios_real_start_wda / ios_sim_screenshot / ios_sim_interact / ios_sim_ui_tree / '
        + 'ios_sim_tap_element tools need the plugin WDA host (the plugin wires it automatically)',
      )
    }
    const device = await realDevices.resolve(trimmed, signal)
    requireAvailable(device)
    return { kind: 'real', device }
  }
  return { kind: 'simulator', device: await resolveTargetDevice(host, reference) }
}

/** The device summary a tool result carries, for either backend. */
function targetSummary(target: ToolTarget): SimDeviceInfo {
  if (target.kind === 'real') return realDeviceSummary(target.device)
  const device = target.device
  return { udid: device.udid, name: device.name, runtime: device.runtime, state: device.state }
}

/**
 * Enumerate the apps installed on a resolved target, prefixed with the calling
 * tool. Both backends THROW on a failed listing (see app-list.ts): the model
 * must be able to trust that an empty list means the device is empty, because
 * once it could not, it "concluded" an installed app did not exist and went
 * looking for it in the user's source tree (WP57).
 */
async function listAppsForTarget(tool: string, target: ToolTarget, signal?: AbortSignal): Promise<InstalledApp[]> {
  try {
    return target.kind === 'real'
      ? await listPhysicalDeviceApps(target.device.udid, signal)
      : await listSimulatorApps(target.device.udid, signal)
  } catch (error) {
    const message = errorMessage(error)
    throw new Error(message.startsWith(`${tool}:`) ? message : `${tool}: ${message}`)
  }
}

/** Degradation guard: throws the shared explanatory error on unsupported hosts. */
function assertSimulatorAvailable(host: SimHostController): void {
  if (process.platform !== 'darwin') {
    throw new Error(`${SIMULATOR_UNAVAILABLE} — this host runs ${process.platform}, so no simulator tools can run here`)
  }
  const status = host.status()
  if (!status.available) {
    throw new Error(`${SIMULATOR_UNAVAILABLE} — the serve-sim simulator stream is unavailable on this host (${status.serveSimSource})`)
  }
}

/**
 * Resolve the device a tool should operate on: an explicit udid/name wins,
 * then the currently streamed device, then a booted simulator. With
 * `bootFallback`, an iPhone on the newest runtime is booted when nothing is
 * already running.
 */
async function resolveTargetDevice(
  host: SimHostController,
  reference?: string,
  options: { bootFallback?: boolean } = {},
): Promise<SimulatorDevice> {
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
  if (options.bootFallback === true) {
    const devices = await listDevices()
    if (devices.length === 0) {
      throw new Error('No simulator devices are installed — install an iOS Simulator runtime in Xcode, then retry')
    }
    const iphones = devices.filter(device => device.name.toLowerCase().startsWith('iphone'))
    const pool = iphones.length > 0 ? iphones : devices
    const picked = pool.sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))[0]
    await bootDevice(picked.udid)
    return { ...picked, state: 'Booted' }
  }
  throw new Error('No booted simulator and no live stream — call ios_sim_boot first, then retry')
}

/** Require a live stream and return its device. */
async function streamedDevice(host: SimHostController): Promise<SimulatorDevice> {
  const status = host.status()
  if (!status.running || status.device === undefined) {
    throw new Error('No simulator is being streamed — call ios_sim_boot first, then interact with the live view')
  }
  return getDevice(status.device)
}

/**
 * Stable per-device screenshot paths inside the plugin cache:
 * `<cacheDir>/screenshots/screenshot-<udid>-<n>.png` with a monotonically
 * increasing index so replays and repeated captures never collide.
 */
class ScreenshotStore {
  readonly #root: string
  #next = new Map<string, number>()

  constructor(cacheDir: string) {
    this.#root = join(cacheDir, 'screenshots')
  }

  nextPath(udid: string): string {
    mkdirSync(this.#root, { recursive: true })
    const safe = udid.replace(/[^A-Za-z0-9_-]/g, '_')
    let next = this.#next.get(safe)
    if (next === undefined) {
      next = 0
      const prefix = `screenshot-${safe}-`
      for (const entry of readdirSync(this.#root)) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.png')) continue
        const index = Number(entry.slice(prefix.length, -4))
        if (Number.isInteger(index) && index >= next) next = index + 1
      }
    }
    // THREE independent counters share this directory (this store, the UI
    // tools' twin in tool-uitree.ts, and the panel capture route) — each
    // scans the directory only once, so their counters collide and a later
    // write would overwrite an earlier capture whose signed URL is still
    // live. Skipping names that exist on disk keeps every writer safe.
    let path = join(this.#root, `screenshot-${safe}-${next}.png`)
    while (existsSync(path)) {
      next += 1
      path = join(this.#root, `screenshot-${safe}-${next}.png`)
    }
    this.#next.set(safe, next + 1)
    return path
  }
}

/** Read PNG dimensions from the IHDR chunk (best effort, 24-byte header). */
function readPngSize(path: string): { width: number; height: number } | undefined {
  try {
    const fd = openSync(path, 'r')
    try {
      const header = Buffer.alloc(24)
      if (readSync(fd, header, 0, 24, 0) !== 24) return undefined
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const isPng = header.subarray(0, 8).equals(pngSignature)
      const isIhdr = header.subarray(12, 16).toString('ascii') === 'IHDR'
      if (!isPng || !isIhdr) return undefined
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/** Screenshot summary used by `ios_sim_screenshot` and `ios_sim_interact`. */
interface ScreenshotCapture {
  path: string
  bytes: number
  width?: number
  height?: number
  device: SimDeviceInfo
}

async function captureScreenshot(
  store: ScreenshotStore,
  udid: string,
  signal?: AbortSignal,
): Promise<ScreenshotCapture> {
  const device = await getDevice(udid)
  const path = store.nextPath(device.udid)
  await takeScreenshot(device.udid, path, signal)
  const bytes = statSync(path).size
  const size = readPngSize(path)
  return {
    path,
    bytes,
    ...(size === undefined ? {} : { width: size.width, height: size.height }),
    device: { udid: device.udid, name: device.name, runtime: device.runtime, state: device.state },
  }
}

/**
 * WDA screenshot for a physical device, written into the SAME cache layout
 * (`<cacheDir>/screenshots/screenshot-<udid>-<n>.png`) so the signed
 * screenshot URL + presentationMeta flow works unchanged.
 */
async function captureWdaScreenshot(
  tool: string,
  store: ScreenshotStore,
  wda: WdaToolBackend,
  device: RealDevice,
): Promise<ScreenshotCapture> {
  let shot: StreamScreenshot
  try {
    shot = await wda.control.screenshot()
  } catch (error) {
    throw new Error(`${tool}: the WebDriverAgent screenshot failed: ${errorMessage(error)}`)
  }
  const path = store.nextPath(device.udid)
  try {
    writeFileSync(path, Buffer.from(shot.pngBase64, 'base64'))
  } catch (error) {
    throw new Error(`${tool}: could not write the screenshot to ${path}: ${errorMessage(error)}`)
  }
  const bytes = statSync(path).size
  const size = readPngSize(path)
    ?? (shot.width !== undefined && shot.height !== undefined ? { width: shot.width, height: shot.height } : undefined)
  return {
    path,
    bytes,
    ...(size === undefined ? {} : { width: size.width, height: size.height }),
    device: realDeviceSummary(device),
  }
}

/** Screenshot presentation envelope — stable, replayable identifiers only. */
function screenshotMeta(value: unknown): JsonValue {
  const result = value as unknown as SimScreenshotResult
  return {
    kind: 'sim-screenshot',
    screenshotPath: result.path,
    path: result.path,
    device: { ...result.device },
  }
}

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const

/** One scroll's finger path in normalized 0..1 coordinates. */
interface ScrollPath {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

/**
 * Validate scroll args into the pure geometry request `simScrollPath` traces.
 * The geometry itself lives in sim-gesture.ts (direction named by the CONTENT,
 * the whole path clamped into the 8%..92% band) so the WS path, the CLI
 * fallback and the WDA drag can never disagree about where the finger goes.
 */
function scrollRequestOf(args: SimInteractArgs): SimScrollRequest {
  const direction = args.direction
  if (direction === undefined || (SCROLL_DIRECTIONS as readonly string[]).indexOf(direction) === -1) {
    throw new Error(
      `ios_sim_interact: action "scroll" requires direction "up", "down", "left" or "right"`
      + ` (got ${direction === undefined ? 'nothing' : JSON.stringify(direction)})`,
    )
  }
  // The path length is `amount` of the travelling axis, so 0.6 scrolls 60% of
  // the screen — a flick-sized jump, not a pixel nudge.
  const amount = args.amount ?? 0.6
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1) {
    throw new Error(`ios_sim_interact: scroll amount must be a number within 0..1, got ${String(amount)}`)
  }
  const anchorX = typeof args.x === 'number' && Number.isFinite(args.x) ? args.x : 0.5
  const anchorY = typeof args.y === 'number' && Number.isFinite(args.y) ? args.y : 0.5
  if (anchorX < 0 || anchorX > 1 || anchorY < 0 || anchorY > 1) {
    throw new Error(`ios_sim_interact: scroll anchor x/y must be within 0..1, got x=${args.x} y=${args.y}`)
  }
  return { direction, amount, anchorX, anchorY }
}

/** Validate scroll args and return the traced path's ENDPOINTS (the WDA drag
 * and the CLI fallback consume those; the WS path traces every point). */
function scrollArgs(args: SimInteractArgs): ScrollPath {
  const points = simScrollPath(scrollRequestOf(args))
  const from = points[0]
  const to = points[points.length - 1]
  return { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }
}

/**
 * The CLI fallback shape for a traced gesture: begin → move → end, one
 * serve-sim `gesture` invocation each. serve-sim's `gesture` subcommand only
 * accepts single touch frames, so a path can only be approximated by its
 * endpoints here — which is exactly why the WS channel exists (WP56).
 */
function dragFramePayloads(path: ScrollPath): string[][] {
  return [
    ['gesture', JSON.stringify({ type: 'begin', x: path.fromX, y: path.fromY })],
    ['gesture', JSON.stringify({ type: 'move', x: path.toX, y: path.toY })],
    ['gesture', JSON.stringify({ type: 'end', x: path.toX, y: path.toY })],
  ]
}

/** Map a validated interact call to serve-sim control arguments.
 * Scroll returns one `gesture` frame per call (begin → move → end) so the
 * simulator reuses the same proven plain-drag path as `StreamControl.drag`.
 * Exported so the smoke can assert the recorded serve-sim control args. */
export function interactControlArgs(args: SimInteractArgs): string[][] {
  switch (args.action) {
    case 'tap': {
      if (typeof args.x !== 'number' || typeof args.y !== 'number' || !Number.isFinite(args.x) || !Number.isFinite(args.y)) {
        throw new Error('ios_sim_interact: action "tap" requires numeric x and y (normalized 0..1)')
      }
      if (args.x < 0 || args.x > 1 || args.y < 0 || args.y > 1) {
        throw new Error(`ios_sim_interact: tap x/y must be within 0..1, got x=${args.x} y=${args.y}`)
      }
      return [['tap', String(args.x), String(args.y)]]
    }
    case 'type': {
      if (typeof args.text !== 'string' || args.text === '') {
        throw new Error('ios_sim_interact: action "type" requires a non-empty text')
      }
      return [['type', args.text]]
    }
    case 'button': {
      if (typeof args.name !== 'string' || args.name.trim() === '') {
        throw new Error('ios_sim_interact: action "button" requires a button name, e.g. "home"')
      }
      return [['button', args.name.trim()]]
    }
    case 'gesture': {
      if (typeof args.json !== 'object' || args.json === null || Array.isArray(args.json)) {
        throw new Error('ios_sim_interact: action "gesture" requires a json object, e.g. {"type":"begin","x":0.5,"y":0.5}')
      }
      // A normalized {fromX,fromY,toX,toY} payload describes a PATH, and the
      // CLI cannot express one — fall back to the same begin→move→end triple a
      // scroll uses. A single {type,x,y} frame is one event: forward it as-is.
      const drag = simDragRequestOf(args.json)
      if (drag !== undefined) {
        return dragFramePayloads({ fromX: drag.fromX, fromY: drag.fromY, toX: drag.toX, toY: drag.toY })
      }
      return [['gesture', JSON.stringify(args.json)]]
    }
    case 'scroll': {
      return dragFramePayloads(scrollArgs(args))
    }
  }
}

/**
 * Perform one interact call on a physical device through the shared
 * normalized `StreamControl` contract (`WdaStreamSource` multiplies 0..1
 * coordinates by the live window size into WDA's absolute points). On real
 * devices a `gesture` maps to a WDA drag, so the JSON must carry a
 * normalized from/to pair.
 */
async function performWdaInteract(stream: WdaStreamSource, args: SimInteractArgs): Promise<void> {
  switch (args.action) {
    case 'tap': {
      if (typeof args.x !== 'number' || typeof args.y !== 'number' || !Number.isFinite(args.x) || !Number.isFinite(args.y)
        || args.x < 0 || args.x > 1 || args.y < 0 || args.y > 1) {
        throw new Error(`ios_sim_interact: tap x/y must be within 0..1, got x=${String(args.x)} y=${String(args.y)}`)
      }
      await stream.control.tap(args.x, args.y)
      return
    }
    case 'type': {
      if (typeof args.text !== 'string' || args.text === '') {
        throw new Error('ios_sim_interact: action "type" requires a non-empty text')
      }
      await stream.control.type(args.text)
      return
    }
    case 'button': {
      if (typeof args.name !== 'string' || args.name.trim() === '') {
        throw new Error('ios_sim_interact: action "button" requires a button name, e.g. "home"')
      }
      await stream.control.button(args.name.trim())
      return
    }
    case 'gesture': {
      const json = args.json as Record<string, unknown>
      const number = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined
      const fromX = number(json.fromX)
      const fromY = number(json.fromY)
      const toX = number(json.toX)
      const toY = number(json.toY)
      if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
        throw new Error(
          'ios_sim_interact: on a physical device action "gesture" maps to a WebDriverAgent drag — '
          + 'pass json {"fromX":0.1,"fromY":0.5,"toX":0.9,"toY":0.5,"duration":0.3} with normalized 0..1 coordinates',
        )
      }
      if (![fromX, fromY, toX, toY].every(value => value >= 0 && value <= 1)) {
        throw new Error('ios_sim_interact: gesture from/to coordinates must be normalized 0..1')
      }
      const duration = number(json.duration) ?? 0.3
      await stream.control.drag({ fromX, fromY, toX, toY, duration })
      return
    }
    case 'scroll': {
      const path = scrollArgs(args)
      // WdaStreamSource multiplies the normalized path by the live window size
      // into absolute points and calls /wda/dragfromtoforduration. 0.35 s is
      // fast enough to feel like a flick, slow enough that WDA does not treat
      // it as a system gesture.
      await stream.control.drag({ fromX: path.fromX, fromY: path.fromY, toX: path.toX, toY: path.toY, duration: 0.35 })
      return
    }
  }
}

/** What the gesture router needs from the sim host (`SimHostController`
 * satisfies it as-is; the smoke passes a recording stand-in). */
export interface SimGestureHostLike {
  /** Live stream handshake — undefined when nothing is streaming. */
  readonly streamInfo?: SimStreamInfo | undefined
  control(args: readonly string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>
}

async function performSimInteractControl(host: SimGestureHostLike, deviceUdid: string, payloads: string[][]): Promise<void> {
  for (const payload of payloads) {
    await host.control([payload[0], '-d', deviceUdid, ...payload.slice(1)])
    // A scroll is begin → move → end; dwelling between frames is what makes
    // serve-sim register a drag instead of three independent touches.
    if (payloads.length > 1 && payload !== payloads[payloads.length - 1]) {
      await sleep(SCROLL_HOLD_MS)
    }
  }
}

/** Which channel actually carried one simulator interaction. */
export type SimGestureChannel = 'ws' | 'cli'

/** How one simulator interaction was delivered (diagnostics + smoke asserts). */
export interface SimInteractDelivery {
  channel: SimGestureChannel
  /** Frames written when the WS channel carried it (1 begin + moves + 1 end). */
  frames?: number
  /** Measured wall time of the traced gesture, ms. */
  elapsedMs?: number
  /** Why the WS channel was skipped or refused; the CLI carried it instead. */
  wsError?: string
}

/**
 * The normalized finger path a multi-event interaction traces, or undefined for
 * the single-event actions (tap/type/button/one raw `{type,x,y}` frame) the CLI
 * delivers in one process with nothing to time.
 * Exported so the smoke can assert the geometry without a socket.
 */
export function simInteractGesturePath(args: SimInteractArgs): SimGesturePoint[] | undefined {
  if (args.action === 'scroll') return simScrollPath(scrollRequestOf(args))
  if (args.action === 'gesture') {
    const drag = simDragRequestOf(args.json)
    return drag === undefined ? undefined : simDragPath(drag)
  }
  return undefined
}

/**
 * Deliver one simulator interaction. Multi-event gestures (scroll, and a
 * `gesture` payload that describes a drag path) go over serve-sim's WebSocket
 * control channel — the same socket the browser panel drives — because the CLI
 * spawns ONE PROCESS PER TOUCH EVENT: a 7-event scroll measured 2.05 s wall
 * with ~290 ms of stationary contact before the first move, and iOS classified
 * that as a press-and-drag (it opened Calendar's NEW EVENT sheet) instead of a
 * swipe. The traced path takes ~300 ms at 16 ms/frame and scrolls correctly.
 *
 * The CLI stays as the fallback in two cases, because a slow scroll beats a
 * lost one: no live stream reports a wsUrl yet (a tool call can arrive before
 * the stream exists), or the socket refuses/drops the gesture. Single events
 * never take the socket at all.
 */
export async function performSimInteract(
  host: SimGestureHostLike,
  deviceUdid: string,
  args: SimInteractArgs,
  payloads: string[][],
  options: { stepMs?: number } = {},
): Promise<SimInteractDelivery> {
  const points = simInteractGesturePath(args)
  const info = host.streamInfo
  // The control socket belongs to the ONE device serve-sim streams: a
  // handshake naming another device (mid switch) must not receive this gesture.
  const wsUrl = info !== undefined && info.device === deviceUdid && typeof info.wsUrl === 'string'
    ? info.wsUrl
    : undefined
  let wsError: string | undefined
  if (points !== undefined) {
    if (wsUrl === undefined) {
      wsError = `no live serve-sim stream reports a control-socket url for ${deviceUdid} `
        + '— the gesture went through the serve-sim CLI instead (one process per touch event)'
    } else {
      try {
        const report = await sendSimGesture(wsUrl, points, { stepMs: options.stepMs ?? SIM_GESTURE_STEP_MS })
        return { channel: 'ws', frames: report.frames, elapsedMs: report.elapsedMs }
      } catch (error) {
        wsError = errorMessage(error)
      }
    }
  }
  await performSimInteractControl(host, deviceUdid, payloads)
  return { channel: 'cli', ...(wsError === undefined ? {} : { wsError }) }
}

/** Create the six `ios_sim_*` tool definitions bound to one controller. */
export function createSimTools(host: SimHostController, options: SimToolsOptions = {}): SimTools {
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'dsh-ios')
  const screenshots = new ScreenshotStore(cacheDir)
  const wda = options.wda
  const realDevices: RealDeviceResolution = options.realDevices ?? { matches: matchesRealDevice, resolve: getRealDevice }
  const onFrontmostAppChanged = options.onFrontmostAppChanged
  /** Shared normalized control surface for the real-device interact path. */
  const wdaStream = wda === undefined ? undefined : new WdaStreamSource(wda)

  const iosSimDevices = defineTool({
    name: 'ios_sim_devices',
    description: 'List the iOS Simulator devices available on this Mac (udid, name, runtime, state) '
      + 'plus any USB-connected physical iOS devices under `realDevices` (devicectl: udid, name, '
      + 'osVersion, model, state, developerMode). Use this to discover the udid or name to pass to the '
      + 'other ios_sim_* tools — physical-device udids work with ios_sim_processes, ios_sim_app_info, '
      + 'ios_sim_build_run (install/launch) and, through WebDriverAgent, ios_sim_screenshot, '
      + 'ios_sim_interact, ios_sim_ui_tree and ios_sim_tap_element; only the live panel stream for real '
      + 'devices lands in a later phase.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          devices: { type: 'array', required: true, items: deviceSchema },
          count: { type: 'integer', required: true },
          booted: { type: 'array', required: true, items: { type: 'string' } },
          realDevices: { type: 'array', required: true, items: realDeviceSchema },
          realCount: { type: 'integer', required: true },
          note: { type: 'string' },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(_args: unknown, exec) {
      assertSimulatorAvailable(host)
      const devices = await listDevices()
      const booted = devices.filter(device => device.state === 'Booted').map(device => device.udid)
      let realDevices: RealDevice[] = []
      let note: string | undefined
      try {
        realDevices = await listRealDevices(exec.signal)
      } catch (error) {
        note = `physical-device listing unavailable: ${errorMessage(error)}`
      }
      return {
        devices,
        count: devices.length,
        booted,
        realDevices,
        realCount: realDevices.length,
        ...(note === undefined ? {} : { note }),
      } satisfies SimDevicesResult
    },
    presentCall: () => ({ card: 'generic', title: 'List iOS devices' }),
  })

  const iosSimBoot = defineTool({
    name: 'ios_sim_boot',
    description: 'Boot an iOS Simulator device and start the live serve-sim stream for it. '
      + 'The stream stays alive for the conversation so the UI can show the simulator live. '
      + 'Use ios_sim_devices first to discover a udid or device name (e.g. "iPhone 17 Pro").',
    parameters: {
      udid: {
        type: 'string',
        required: true,
        description: 'Simulator udid or device name (e.g. "iPhone 17 Pro"). Discover devices with ios_sim_devices.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          state: { type: 'string', required: true, const: 'booted' },
          streaming: { type: 'boolean', required: true, const: true },
        },
      },
      render: renderJson,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const result = value as unknown as SimBootResult
        return {
          kind: 'sim-stream',
          device: { ...result.device },
          streamRouteId: `dsh-ios/stream/${result.device.udid}`,
        }
      },
    },
    timeoutMs: 420_000,
    async execute(args: { udid: string }, exec) {
      assertSimulatorAvailable(host)
      await rejectRealDeviceReference(
        'ios_sim_boot',
        args.udid,
        'this tool boots iOS Simulators only — a physical phone is powered on and off from the device '
        + 'itself, never from this Mac (use ios_sim_screenshot, ios_sim_interact, ios_sim_ui_tree or '
        + 'ios_sim_tap_element to work with the connected device)',
        realDevices,
        exec.signal,
      )
      const device = await getDevice(args.udid)
      await host.ensureRunning({ udid: device.udid })
      return {
        device: { udid: device.udid, name: device.name, runtime: device.runtime, state: 'Booted' },
        state: 'booted',
        streaming: true,
      } satisfies SimBootResult
    },
    presentCall: (args: { udid: string }) => ({
      card: 'generic',
      title: `Boot simulator ${args.udid}`,
      kind: 'execute',
    }),
  })

  const iosSimShutdown = defineTool({
    name: 'ios_sim_shutdown',
    description: 'Shut down an iOS Simulator device. Stops its live serve-sim stream '
      + '(if the stream targets that device) and powers the simulator off.',
    parameters: {
      udid: {
        type: 'string',
        required: true,
        description: 'Simulator udid or device name to shut down.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          state: { type: 'string', required: true, const: 'shutdown' },
          streaming: { type: 'boolean', required: true, const: false },
        },
      },
      render: renderJson,
    },
    timeoutMs: 120_000,
    async execute(args: { udid: string }, exec) {
      assertSimulatorAvailable(host)
      await rejectRealDeviceReference(
        'ios_sim_shutdown',
        args.udid,
        'this tool shuts down iOS Simulators only — a physical phone is powered on and off from the '
        + 'device itself, never from this Mac (use ios_sim_screenshot, ios_sim_interact, '
        + 'ios_sim_ui_tree or ios_sim_tap_element to work with the connected device)',
        realDevices,
        exec.signal,
      )
      const device = await getDevice(args.udid)
      const status = host.status()
      if (status.device === device.udid) await host.stop()
      await shutdownDevice(device.udid)
      return {
        device: { udid: device.udid, name: device.name, runtime: device.runtime, state: 'Shutdown' },
        state: 'shutdown',
        streaming: false,
      } satisfies SimShutdownResult
    },
    presentCall: (args: { udid: string }) => ({
      card: 'generic',
      title: `Shutdown simulator ${args.udid}`,
      kind: 'execute',
    }),
  })

  const iosSimScreenshot = defineTool({
    name: 'ios_sim_screenshot',
    description: 'Capture a PNG screenshot of a booted iOS Simulator — or of a USB-connected physical '
      + 'iOS device (pass its udid from ios_sim_devices.realDevices; captured through WebDriverAgent) — '
      + 'and return a small JSON summary (path, bytes, device). The image itself reaches the UI through '
      + 'the tool card, never as an image block in the result. The returned path is for the USER to '
      + 'look at: do NOT feed it to an image-reading tool unless this model accepts image input — on a '
      + 'text-only model that call always fails. To READ the screen, use ios_sim_find_text (OCR text + '
      + 'coordinates) or ios_sim_ui_tree (accessibility elements) instead.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name, or a physical-device udid/name from '
          + 'ios_sim_devices.realDevices (WebDriverAgent must be running for the device — '
          + 'run ios_real_start_wda first if it is not). Defaults to '
          + 'the currently streamed device, else the first booted simulator.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer' },
          height: { type: 'integer' },
          device: { ...deviceSchema, required: true },
        },
      },
      render: renderJson,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => screenshotMeta(value),
    },
    timeoutMs: 420_000,
    async execute(args: { udid?: string }, exec) {
      const target = await resolveToolTarget(host, wda, realDevices, args.udid, exec.signal)
      if (target.kind === 'real') {
        await ensureWdaRunning('ios_sim_screenshot', wda!, target.device)
        return captureWdaScreenshot('ios_sim_screenshot', screenshots, wda!, target.device)
      }
      assertSimulatorAvailable(host)
      return captureScreenshot(screenshots, target.device.udid, exec.signal)
    },
    presentCall: (args: { udid?: string }) => ({
      card: 'generic',
      title: args.udid === undefined ? 'Screenshot simulator' : `Screenshot ${args.udid}`,
      kind: 'execute',
    }),
  })

  const iosSimInteract = defineTool({
    name: 'ios_sim_interact',
    description: 'Interact with the streamed iOS Simulator — or with a USB-connected physical iOS device '
      + 'through WebDriverAgent (pass its udid from ios_sim_devices.realDevices): tap at normalized 0..1 '
      + 'coordinates, type text, press a hardware button (e.g. "home"), or send a gesture (on a physical '
      + 'device a gesture is a drag: {"fromX":…,"fromY":…,"toX":…,"toY":…,"duration":…} in 0..1). '
      + 'On a REAL device every tap has real consequences (posts, likes, purchases, messages, shares): '
      + 'NEVER tap an unidentified control to find out what it does — if a control cannot be identified, '
      + 'STOP and report what you see instead of guessing coordinates. '
      + 'Use action "scroll" (with direction) to scroll — never hand-build a drag or reach for raw WDA/curl '
      + 'for scrolling; this tool covers it. After the action settles (~300 ms) a fresh screenshot is captured '
      + 'and returned with the same summary shape as ios_sim_screenshot, so the effect of the interaction is '
      + 'visible. Simulators require a live stream: call ios_sim_boot first.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Physical-device udid or name (from ios_sim_devices.realDevices) to interact with '
          + 'through WebDriverAgent (run ios_real_start_wda first if WDA is not running). Omit to '
          + 'interact with the currently streamed simulator.',
      },
      action: {
        type: 'string',
        required: true,
        enum: ['tap', 'type', 'button', 'gesture', 'scroll'],
        description: 'Interaction to send to the device.',
      },
      x: { type: 'number', description: 'Tap X position, normalized 0..1 (required when action is "tap"; for "scroll" the anchor point the gesture starts from, default 0.5).' },
      y: { type: 'number', description: 'Tap Y position, normalized 0..1 (required when action is "tap"; for "scroll" the anchor point the gesture starts from, default 0.5).' },
      text: { type: 'string', description: 'Text to type (required when action is "type").' },
      name: { type: 'string', description: 'Hardware button name, e.g. "home", "volumeUp" (required when action is "button").' },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction (required when action is "scroll"). Named by the CONTENT: '
          + '"down" reveals content further down the page (the finger moves UP), "up" the opposite. '
          + '"left"/"right" scroll horizontally the same way.',
      },
      amount: {
        type: 'number',
        description: 'Fraction of the screen the scroll travels, 0..1 (default 0.6). Only used when action is "scroll".',
      },
      json: {
        type: 'json',
        description: 'Gesture JSON. A normalized drag works on BOTH targets, e.g. '
          + '{"fromX":0.1,"fromY":0.5,"toX":0.9,"toY":0.5,"duration":0.3} (the simulator traces it over the live '
          + 'stream at 60 Hz, a physical device runs it as a WebDriverAgent drag). A simulator also accepts one '
          + 'raw serve-sim frame, e.g. {"type":"begin","x":0.5,"y":0.5} (required when action is "gesture").',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['tap', 'type', 'button', 'gesture', 'scroll'] },
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer' },
          height: { type: 'integer' },
          device: { ...deviceSchema, required: true },
        },
      },
      render: renderJson,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => screenshotMeta(value),
    },
    timeoutMs: 420_000,
    async execute(args: SimInteractArgs, exec) {
      const reference = args.udid?.trim() ?? ''
      if (reference !== '' && await realDevices.matches(reference, exec.signal)) {
        if (wda === undefined || wdaStream === undefined) {
          throw new Error(
            `"${reference}" is a physical iOS device but the WebDriverAgent backend is not configured — `
            + 'the ios_sim_interact tool needs the plugin WDA host (the plugin wires it automatically)',
          )
        }
        const device = await realDevices.resolve(reference, exec.signal)
        requireAvailable(device)
        await ensureWdaRunning('ios_sim_interact', wda, device)
        try {
          await performWdaInteract(wdaStream, args)
        } catch (error) {
          if (/^ios_sim_interact:/.test(errorMessage(error))) throw error
          throw new Error(`ios_sim_interact: WebDriverAgent ${args.action} failed: ${errorMessage(error)}`)
        }
        await sleep(INTERACT_SETTLE_MS)
        const screenshot = await captureWdaScreenshot('ios_sim_interact', screenshots, wda, device)
        return { action: args.action, ...screenshot } satisfies SimInteractResult
      }
      assertSimulatorAvailable(host)
      const payloads = interactControlArgs(args)
      const device = await streamedDevice(host)
      try {
        // WP56: scrolls and drag paths ride the stream's WS control socket
        // (~300 ms, reads as a flick); everything else, and every case with no
        // live socket, stays on the serve-sim CLI.
        await performSimInteract(host, device.udid, args, payloads)
      } catch (error) {
        throw new Error(`ios_sim_interact: serve-sim ${args.action} failed: ${errorMessage(error)}`)
      }
      await sleep(INTERACT_SETTLE_MS)
      const screenshot = await captureScreenshot(screenshots, device.udid, exec.signal)
      return { action: args.action, ...screenshot } satisfies SimInteractResult
    },
    presentCall: (args: SimInteractArgs) => ({
      card: 'generic',
      title: `${args.action} on simulator`,
      kind: 'execute',
      rawInput: args.action === 'tap'
        ? { x: args.x, y: args.y }
        : args.action === 'type'
          ? { text: args.text }
          : args.action === 'button'
            ? { name: args.name }
            : args.action === 'scroll'
              ? { direction: args.direction, amount: args.amount }
              : { gesture: args.json },
    }),
  })

  const iosSimListApps = defineTool({
    name: 'ios_sim_list_apps',
    description: 'List the apps INSTALLED on a booted iOS Simulator, or on a USB-connected physical device '
      + '(pass its udid from ios_sim_devices.realDevices): bundle id, display name, version, and whether it '
      + 'is a stock Apple app. Run this BEFORE opening a third-party app: its bundle id cannot be guessed — '
      + 'a plausible-looking id — an app\u2019s former name, or the pattern a sibling app uses — is routinely not the installed one '
      + 'at all — and ios_sim_launch_app accepts a name instead. Filter with query, a case-insensitive '
      + 'substring matched against BOTH the display name and the bundle id (localized Chinese/Japanese names '
      + 'work on a SIMULATOR; a phone reports base — usually English — names, so match those or the bundle id). '
      + 'User-installed apps only by default; include_system:true adds the stock apps. A listing that FAILS '
      + 'throws with the reason (e.g. the device is not reachable by CoreDevice) instead of returning an '
      + 'empty list, so count:0 always means the device really has no matching app. Concurrency-safe.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name, or a physical-device udid/name from '
          + 'ios_sim_devices.realDevices. Defaults to the streamed simulator, else the only booted one.',
      },
      query: {
        type: 'string',
        description: 'Case-insensitive substring matched against the display name AND the bundle id, '
          + 'e.g. "calendar", "safari" or "日历". Omit to list everything.',
      },
      include_system: {
        type: 'boolean',
        description: 'Include stock Apple apps (default false: only user-installed apps, which is what '
          + '"open <app>" normally means).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          count: { type: 'integer', required: true },
          apps: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bundleId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                baseName: { type: 'string' },
                version: { type: 'string' },
                system: { type: 'boolean', required: true },
              },
            },
          },
          candidates: {
            type: 'array',
            items: { type: 'string' },
          },
          hint: {
            type: 'string',
          },
        },
      },
      render: renderJson,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args: { udid?: string; query?: string; include_system?: boolean }, exec) {
      // devicectl-only: listing a phone never needs WebDriverAgent (WP59).
      const target = await resolveToolTarget(host, wda, realDevices, args.udid, exec.signal, { requiresWda: false })
      // Only the simulator path needs the serve-sim plumbing; a phone is listed
      // through devicectl alone.
      if (target.kind === 'simulator') assertSimulatorAvailable(host)
      const apps = await listAppsForTarget('ios_sim_list_apps', target, exec.signal)
      const query = args.query === undefined ? '' : args.query.trim()
      const filtered = filterInstalledApps(apps, {
        ...(args.query === undefined ? {} : { query: args.query }),
        includeSystem: args.include_system === true,
      })
      // A query that matched nothing surfaces the installed names as candidates
      // from the SAME listing — a Chinese user asking for 日历 (base name
      // Calendar) can act on "日历 (com.apple.mobilecal)" instead of guessing.
      const candidates = filtered.length === 0 && query !== ''
        ? noMatchCandidateLines(apps)
        : undefined
      // WP60: the same no-match must also say WHY, or a bare count:0 gets read
      // as "the app is not installed" (the 377 s detour). A phone reports base
      // names only; a simulator resolves localized names. Never emitted for an
      // unfiltered listing, which keeps today's "the device is empty" meaning.
      const hint = filtered.length === 0 && query !== ''
        ? noMatchListingHint(target.kind === 'real' ? 'real' : 'simulator', apps.length)
        : undefined
      return {
        device: targetSummary(target),
        count: filtered.length,
        apps: filtered,
        ...(hint === undefined ? {} : { hint }),
        ...(candidates === undefined || candidates.length === 0 ? {} : { candidates }),
      } satisfies SimListAppsResult
    },
    presentCall: (args: { query?: string; include_system?: boolean }) => ({
      card: 'generic',
      title: args.query === undefined || args.query.trim() === ''
        ? 'List installed apps'
        : `List installed apps matching "${args.query.trim()}"`,
      kind: 'execute',
    }),
  })

  const iosSimLaunchApp = defineTool({
    name: 'ios_sim_launch_app',
    description: 'Launch an already-installed app on a booted iOS Simulator — or on a USB-connected '
      + 'physical device (pass its udid from ios_sim_devices.realDevices; launched through devicectl). '
      + 'Pass EITHER bundleId OR name (exactly one): name is a case-insensitive substring of the display '
      + 'name, resolved against the installed apps exactly like ios_sim_list_apps (localized '
      + 'Chinese/Japanese names work on a SIMULATOR; on a phone the listing is base — usually English — '
      + 'names, so pass the English name or bundleId), so opening a third-party app never needs its bundle '
      + 'id. Bundle ids of third-party apps '
      + 'CANNOT be guessed (an app\u2019s former name often survives as a DIFFERENT id that is not installed), so use '
      + 'name, or run ios_sim_list_apps first. Use this to OPEN an app; ios_sim_build_run is for building '
      + 'and installing one from source. Stable Apple bundle ids (Apple apps only): Calendar '
      + 'com.apple.mobilecal, Safari com.apple.mobilesafari, Settings com.apple.Preferences, Photos '
      + 'com.apple.mobileslideshow, Messages com.apple.MobileSMS, Mail com.apple.mobilemail, Clock '
      + 'com.apple.mobiletimer, Maps com.apple.Maps, Notes com.apple.mobilenotes, Reminders '
      + 'com.apple.reminders, Files com.apple.DocumentsApp, App Store com.apple.AppStore, Contacts '
      + 'com.apple.MobileAddressBook.',
    parameters: {
      bundleId: {
        type: 'string',
        description: 'Bundle identifier of the installed app, e.g. "com.apple.mobilecal" for Calendar. '
          + 'Required unless name is given; passing both is an error.',
      },
      name: {
        type: 'string',
        description: 'Display-name substring of an installed app, e.g. "Calendar", "Safari" or "日历" '
          + '(case-insensitive; bundle ids are matched as a fallback). Resolves to exactly one app — '
          + 'several matches come back as a candidate list to choose from.',
      },
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name, or a physical-device udid/name from '
          + 'ios_sim_devices.realDevices. Defaults to the streamed simulator, else the only booted one.',
      },
      relaunch: {
        type: 'boolean',
        description: 'Terminate a running instance first so the app starts from its launch screen '
          + '(default false: an already-running app is brought to the foreground as-is).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { type: 'object', required: true, additionalProperties: false, properties: {
            udid: { type: 'string', required: true },
            name: { type: 'string', required: true },
            runtime: { type: 'string' },
            state: { type: 'string' },
          } },
          bundleId: { type: 'string', required: true },
          name: { type: 'string' },
          launched: { type: 'boolean', required: true, const: true },
          pid: { type: 'integer' },
          relaunched: { type: 'boolean' },
        },
      },
      render: renderJson,
    },
    timeoutMs: 120_000,
    async execute(args: { bundleId?: string; name?: string; udid?: string; relaunch?: boolean }, exec) {
      const requestedId = args.bundleId?.trim() ?? ''
      const requestedName = args.name?.trim() ?? ''
      // Two ways to name ONE app, so both together is an argument error rather
      // than a silent precedence rule the model would have to learn.
      if (requestedId !== '' && requestedName !== '') {
        throw new ToolArgsError([
          'ios_sim_launch_app takes either bundleId or name, not both — drop one '
          + `(bundleId="${requestedId}", name="${requestedName}")`,
        ])
      }
      if (requestedId === '' && requestedName === '') {
        throw new Error(
          'ios_sim_launch_app: bundleId is required, e.g. "com.apple.mobilecal" — or pass name to resolve '
          + 'one by display name; run ios_sim_list_apps to see what is installed',
        )
      }
      const relaunch = args.relaunch === true
      // devicectl-only: a phone's real-device launch is `devicectl device
      // process launch`, which never needs WebDriverAgent (WP59).
      const target = await resolveToolTarget(host, wda, realDevices, args.udid, exec.signal, { requiresWda: false })
      // Name resolution reads the SAME listing ios_sim_list_apps returns, but
      // WITH the stock apps: "open Safari" must resolve, and a system app is
      // still an app to launch.
      const resolved = requestedName === ''
        ? undefined
        : resolveAppByName(
          'ios_sim_launch_app',
          await listAppsForTarget('ios_sim_launch_app', target, exec.signal),
          requestedName,
          targetSummary(target).name,
          { physical: target.kind === 'real' },
        )
      const bundleId = resolved === undefined ? requestedId : resolved.bundleId
      const resolvedName = resolved === undefined ? {} : { name: resolved.name }
      if (target.kind === 'real') {
        const device = target.device
        if (relaunch) {
          // Best effort: an app that is not running has nothing to terminate,
          // which devicectl reports as a failure — never fail the launch for it.
          await devicectlTerminateApp(device.udid, bundleId, exec.signal).catch(() => undefined)
        }
        let launched: { pid?: number }
        try {
          launched = await devicectlLaunchApp(device.udid, bundleId, exec.signal)
        } catch (error) {
          throw new Error(
            `ios_sim_launch_app: could not launch ${bundleId} on ${device.name}: ${errorMessage(error)} — the `
            + 'app may not be installed, or the bundle id may be wrong (a third-party bundle id cannot be '
            + 'guessed); run ios_sim_list_apps to see what is installed',
          )
        }
        onFrontmostAppChanged?.(device.udid)
        return {
          device: { udid: device.udid, name: device.name },
          bundleId,
          ...resolvedName,
          launched: true as const,
          ...(launched.pid === undefined ? {} : { pid: launched.pid }),
          ...(relaunch ? { relaunched: true as boolean } : {}),
        }
      }
      assertSimulatorAvailable(host)
      const device = target.device
      if (relaunch) {
        await terminateApp(device.udid, bundleId, exec.signal).catch(() => undefined)
      }
      let stdout: string
      try {
        stdout = await launchApp(device.udid, bundleId, exec.signal)
      } catch (error) {
        throw new Error(
          `ios_sim_launch_app: could not launch ${bundleId} on ${device.name}: ${errorMessage(error)} — the `
          + 'app may not be installed, or the bundle id may be wrong (a third-party bundle id cannot be '
          + 'guessed); run ios_sim_list_apps to see what is installed',
        )
      }
      onFrontmostAppChanged?.(device.udid)
      // simctl prints "<bundleId>: <pid>" on success.
      const pid = Number.parseInt(stdout.split(':').pop()?.trim() ?? '', 10)
      return {
        device: { udid: device.udid, name: device.name, runtime: device.runtime, state: device.state },
        bundleId,
        ...resolvedName,
        launched: true as const,
        ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
        ...(relaunch ? { relaunched: true as boolean } : {}),
      }
    },
    presentCall: (args: { bundleId?: string; name?: string }) => ({
      card: 'generic',
      title: `Launch ${args.bundleId ?? args.name ?? 'app'}`,
      kind: 'execute',
      rawInput: {
        ...(args.bundleId === undefined ? {} : { bundleId: args.bundleId }),
        ...(args.name === undefined ? {} : { name: args.name }),
      },
    }),
  })

  const iosSimBuildRun = defineTool({
    name: 'ios_sim_build_run',
    description: 'Build an Xcode project (.xcodeproj), workspace (.xcworkspace), or Swift package '
      + 'directory for the iOS Simulator, install the built .app on the simulator, and launch it. '
      + 'Pass the udid of a USB-connected physical device (from ios_sim_devices.realDevices) to '
      + 'build, install, and launch on the real device instead: the build uses '
      + '-destination "platform=iOS,id=<udid>", requires an Apple Development signing identity in '
      + 'the login keychain (and a matching provisioning profile), and installs/launches via '
      + 'devicectl. On build failure the result contains the tail of the xcodebuild output with '
      + 'the actionable compiler errors. Takes minutes for a full build.',
    parameters: {
      projectPath: {
        type: 'string',
        required: true,
        description: 'Absolute path to a .xcodeproj, a .xcworkspace, or a Swift package directory (contains Package.swift).',
      },
      scheme: {
        type: 'string',
        description: 'xcodebuild scheme name. Defaults to the first scheme of the project, or the package name for Swift packages.',
      },
      udid: {
        type: 'string',
        description: 'Target simulator or physical-device udid (or device name). A physical-device udid '
          + '(ios_sim_devices.realDevices) builds for platform=iOS with code signing and installs/launches '
          + 'via devicectl. Simulator targets default to the currently streamed device, else a booted '
          + 'simulator, else the newest-runtime iPhone (which is booted).',
      },
      configuration: {
        type: 'string',
        description: 'Build configuration. Defaults to Debug.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          state: { type: 'string', required: true, const: 'launched' },
          bundleId: { type: 'string', required: true },
          pid: { type: 'string', required: true },
          appPath: { type: 'string', required: true },
          projectPath: { type: 'string', required: true },
          scheme: { type: 'string' },
          configuration: { type: 'string', required: true },
          physicalDevice: { type: 'boolean' },
        },
      },
      render: renderJson,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const result = value as unknown as SimBuildRunResult
        return {
          kind: 'sim-build-run',
          device: { ...result.device },
          bundleId: result.bundleId,
          appPath: result.appPath,
        }
      },
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    async execute(args: { projectPath: string; scheme?: string; udid?: string; configuration?: string }, exec) {
      const target = detectProject(args.projectPath)
      const configuration = args.configuration !== undefined && args.configuration.trim() !== ''
        ? args.configuration.trim()
        : 'Debug'
      const reference = args.udid?.trim() ?? ''
      if (reference !== '' && await matchesRealDevice(reference, exec.signal)) {
        // Physical-device pipeline: devicectl build/install/launch. The
        // serve-sim stream is not involved, so only macOS matters here.
        if (process.platform !== 'darwin') {
          throw new Error('iOS device builds require macOS with Xcode — this host runs ' + process.platform)
        }
        const device = await getRealDevice(reference, exec.signal)
        requireAvailable(device)
        return buildRun({
          target,
          scheme: args.scheme,
          configuration,
          device: { kind: 'device', device },
          cacheDir,
          signal: exec.signal,
        })
      }
      assertSimulatorAvailable(host)
      const device = await resolveTargetDevice(host, args.udid, { bootFallback: true })
      // simctl install/launch need a booted device; boot is idempotent when
      // the fallback above already booted it.
      await bootDevice(device.udid)
      return buildRun({
        target,
        scheme: args.scheme,
        configuration,
        device: { kind: 'simulator', device },
        cacheDir,
        signal: exec.signal,
      })
    },
    presentCall: (args: { projectPath: string }) => ({
      card: 'generic',
      title: `Build & run ${args.projectPath}`,
      kind: 'execute',
      locations: [{ path: args.projectPath }],
    }),
  })

  const iosRealStartWda = defineTool({
    name: 'ios_real_start_wda',
    description: 'Start WebDriverAgent (WDA) on a USB-connected PHYSICAL iOS device — real devices only, '
      + 'never a simulator. Resolves the device (accepts either udid form from ios_sim_devices.realDevices), '
      + 'adopts an already-running WebDriverAgent when one answers, otherwise runs the xcodebuild '
      + 'build/launch (a cold build can take minutes), then waits until WDA reports ready and returns '
      + 'the control/MJPEG ports the live panel streams through. Run this first when '
      + 'ios_sim_screenshot / ios_sim_interact / ios_sim_ui_tree / ios_sim_tap_element report '
      + 'WebDriverAgent is not running for the device.',
    parameters: {
      udid: {
        type: 'string',
        required: true,
        description: 'Physical-device udid or hardware udid (from ios_sim_devices.realDevices) to start '
          + 'WebDriverAgent on.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          ready: { type: 'boolean', required: true, const: true },
          controlPort: { type: 'integer', required: true },
          mjpegPort: { type: 'integer', required: true },
          adopted: { type: 'boolean', required: true },
        },
      },
      render: renderJson,
    },
    timeoutMs: 480_000,
    async execute(args: { udid: string }, exec) {
      const reference = typeof args.udid === 'string' ? args.udid.trim() : ''
      if (reference === '') {
        throw new Error('ios_real_start_wda requires a physical-device udid from ios_sim_devices.realDevices')
      }
      if (!await realDevices.matches(reference, exec.signal)) {
        throw new Error(
          `ios_real_start_wda: "${reference}" is not a connected physical iOS device — pass a udid from `
          + 'ios_sim_devices.realDevices (this tool starts WebDriverAgent on real devices only, never simulators)',
        )
      }
      if (wda === undefined) {
        throw new Error('ios_real_start_wda: the WebDriverAgent backend is not configured — the plugin wires it automatically')
      }
      const device = await realDevices.resolve(reference, exec.signal)
      requireAvailable(device)
      // Deliberately NOT the interaction tools' fast-fail path: this tool IS
      // the explicit start gesture, so it must re-attempt even when a
      // previous attempt recorded a classified failure (re-run the build).
      try {
        await wda.ensureRunning({ udid: device.udid })
      } catch (error) {
        throw wdaActionableError('ios_real_start_wda', wda, device.name, error)
      }
      const status = wda.status()
      if (!status.running || typeof status.controlPort !== 'number' || typeof status.mjpegPort !== 'number') {
        throw new Error('ios_real_start_wda: WebDriverAgent settled but is not running — check the real-device panel status')
      }
      return {
        device: realDeviceSummary(device),
        ready: true,
        controlPort: status.controlPort,
        mjpegPort: status.mjpegPort,
        adopted: status.adopted === true,
      } satisfies SimRealStartWdaResult
    },
    presentCall: (args: { udid: string }) => ({
      card: 'generic',
      title: `Start WebDriverAgent on ${args.udid}`,
      kind: 'execute',
    }),
  })

  return {
    iosSimDevices,
    iosSimBoot,
    iosSimShutdown,
    iosSimScreenshot,
    iosSimInteract,
    iosSimListApps,
    iosSimLaunchApp,
    iosSimBuildRun,
    iosRealStartWda,
  }
}
