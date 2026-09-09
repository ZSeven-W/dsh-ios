/**
 * Public host-independent iOS QA backend.
 *
 * The QA backend deliberately lives behind a dedicated subpath
 * (`@zseven-w/dsh-ios/driver` → `lib/qa-driver.js`). It imports only Node
 * builtins and this repository's raw backend modules — no `@deepseek-ai/*`
 * packages, no tool factories. The plugin root entry may keep its host
 * imports and can re-export this driver for callers who already have the
 * host installed.
 *
 * The backend returns native acceptance only. UI assertion, reobservation,
 * unknown receipts, and scoped references belong to the QA adapter that calls
 * this API.
 *
 * @module @zseven-w/dsh-ios/qa-driver
 */

import { execFile } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SimulatorDevice } from './simctl.js'
import {
  launchApp as simctlLaunchApp,
  listDevices as listSimulatorDevices,
  takeScreenshot as simctlTakeScreenshot,
} from './simctl.js'
import type { RealDevice, SigningTeamResolution } from './devicectl.js'
import {
  getRealDevice,
  launchApp as devicectlLaunchApp,
  listRealDevices,
  matchesRealDevice,
  resolveSigningTeam,
} from './devicectl.js'
import type { AxeBinary, AxeElement } from './uitree-backend.js'
import {
  describeUi,
  ensureAxeBinary,
  resolveAxeBinary,
} from './uitree-backend.js'
import { wdaSourceToElements } from './wda-uitree.js'
import { WdaController, WdaError, type WdaOptions } from './wda-host.js'
import { PhysicalWdaStageError, resolvePhysicalWdaProjectDir } from './wda-physical-stage.js'
import { SimHostController } from './sim-host.js'
import type { SimHostStatus, SimStreamInfo } from './sim-host.js'
import { sendSimGesture, simScrollPath, type SimScrollRequest } from './sim-gesture.js'
import { runSimulatorDeviceAction, type DeviceAction } from './device-actions.js'
import { pngDimensionsFromBase64 } from './stream-source.js'
import type { WdaControllerLike } from './stream-source.js'
import { createSimulatorWdaInputRuntime } from './wda-simulator-input.js'
import type { SimulatorWdaInputRuntime, WdaSimulatorConnection } from './wda-simulator-input.js'
import {
  performWdaTargetedText,
  WDA_TARGETED_MAX_TEXT_LENGTH,
} from './wda-targeted-text.js'
import {
  createPhysicalTargetedTransport,
  readPhysicalAppIdentity,
  type PhysicalAppIdentityResult,
  type PhysicalTargetedTransport,
} from './wda-physical-target.js'
import type {
  WdaTargetedTextEnvironment,
  WdaTargetedTextResult,
  WdaTargetedTextTarget,
} from './wda-targeted-text.js'

// The QA driver re-exports the real proven targeted-text client contract so
// callers of either `./driver` or the root entry can consume the exact target
// and result types without reaching into the internal module.
export type {
  WdaTargetedTextEnvironment,
  WdaTargetedTextFrame,
  WdaTargetedTextResult,
  WdaTargetedTextStatus,
  WdaTargetedTextTarget,
  WdaTargetedTextCode,
} from './wda-targeted-text.js'

// ── Public contract ───────────────────────────────────────────────────────────

export type IosQaDeviceKind = 'simulator' | 'physical'

export interface IosQaDevice {
  /** Stable device identifier (simctl or devicectl UDID). */
  udid: string
  kind: IosQaDeviceKind
  name: string
  state: string
  /** Simulator runtime identifier. */
  runtime?: string
  /** Physical OS version. */
  osVersion?: string
  model?: string
  available?: boolean
}

export interface IosQaFrame {
  x: number
  y: number
  width: number
  height: number
}

/**
 * One bounded semantic node.
 *
 * `identifier` is set ONLY from a native AXUniqueId / WDA accessibility
 * identifier. Synthetic paths are never used as identifiers; callers that
 * want an ephemeral tree path may compute their own from node order.
 */
export interface IosQaNode {
  identifier?: string
  type: string
  name?: string
  /** Omitted when `secure === true`; secure values are never emitted. */
  value?: string
  /** Device points (same space as tap()). */
  frame: IosQaFrame
  enabled?: boolean
  focused?: boolean
  selected?: boolean
  /** undefined means unknown — never a claimed safe value. */
  visible?: boolean
  /** true = secure field; undefined = unknown — never false by omission. */
  secure?: boolean
}

export interface IosQaAppIdentity {
  bundleId?: string
  name?: string
  pid?: number
  /** True only when the actual frontmost/app backend answered. */
  verified: boolean
}

export interface IosQaObservation {
  udid: string
  backend: IosQaDeviceKind
  app: IosQaAppIdentity
  /** Point size of the observed screen. */
  screen: { width: number; height: number }
  nodes: IosQaNode[]
  /** True when maxNodes/maxDepth cut the walk. */
  truncated: boolean
  /** Actual deepest node depth walked (roots are depth 0). */
  depth: number
  maxNodes: number
  maxDepth?: number
}

export interface IosQaActionResult {
  ok: boolean
  udid: string
  backend: IosQaDeviceKind
  action: string
  unsupported?: {
    capability: string
    reason: string
    prerequisite?: string
  }
}

export interface IosQaUnsupported {
  capability: string
  reason: string
  prerequisite?: string
}

/**
 * Exact native label+type element route for fields WITHOUT an accessibility
 * identifier. The label stays a LABEL: it is encoded into a native
 * `predicate string` query and verified afterwards through WDA
 * `/attribute/label` — never assumed from `name`, which WDA falls back
 * to the label when no identifier exists.
 */
export interface IosQaSemanticTextTarget {
  /** Exact native accessibility label. */
  label: string
  /** Native WDA element type: exactly TextField, TextView, or SearchField. */
  type: string
}

/**
 * Bounded native target for a WDA element-bound text mutation.
 *
 * `typeTarget` maps this to `append`; `fillTarget` maps this to `replace`.
 * The target never carries a mode — the chosen method is the append vs
 * replace intent. `secure:true` is always rejected before any runtime/device
 * setup. Exactly ONE element route is required: `identifier` (native stable
 * accessibility identifier) OR `semantic` (exact native label+type) —
 * mixing or omitting both is rejected. Empty `text` is allowed only for
 * `fillTarget` (exactly one native clear, no value call); append with empty
 * text is rejected.
 */
export interface IosQaTargetedTextTarget {
  /** Explicit device identifier (simulator or physical). */
  udid: string
  /**
   * Requested bundle id of the running app. The simulator backend verifies
   * FRONTMOST independently (fresh AXe pid ↔ launchctl cross-check); the
   * physical backend verifies RUNNING process identity via CoreDevice
   * (devicectl — never frontmost) and corroborates the active app through
   * the dedicated WDA session's activeAppInfo.
   */
  bundleId: string
  /** Native stable accessibility identifier (never a tree path/fuzzy label). */
  identifier?: string
  /** Exact native label+type route for elements without an identifier. */
  semantic?: IosQaSemanticTextTarget
  /** Expected element frame in native/WDA point space. */
  frame: IosQaFrame
  /**
   * Text to append or to use as replacement. May be empty ONLY for
   * fillTarget (exactly one native clear, no value). Never echoed into
   * results.
   */
  text: string
  /** Optional exact process id precondition (verified independently). */
  expectedPID?: number
  /** Raw secure flag. `true` always rejects before runtime/device setup. */
  secure?: boolean
  /** Optional cancellation signal. */
  signal?: AbortSignal
}

export type IosQaTargetedTextStatus = 'unknown' | 'rejected'
export type IosQaTargetedTextAction = 'typeTarget' | 'fillTarget'
export type IosQaTargetedTextMode = 'append' | 'replace'

/**
 * Result of a native target-bound text mutation.
 *
 * `status:'unknown'` means the mutation request may have been dispatched and
 * MUST be treated as possibly-sent (never a no-dispatch rejection). A
 * non-dispatchable unsupported/physical/missing-source state is always a
 * `status:'rejected'` result with `dispatched:false`. `nativeAccepted` is true
 * only when every required native mutation returned HTTP 2xx — never a
 * business confirmation of the typed value. `reason`/`code` never contain the
 * typed text or a native/transport error body.
 */
export interface IosQaTargetedTextResult {
  udid: string
  backend: IosQaDeviceKind
  action: IosQaTargetedTextAction
  mode: IosQaTargetedTextMode
  status: IosQaTargetedTextStatus
  /** True once a mutation request was sent or may have been sent. */
  dispatched: boolean
  /** True only when all required native mutations returned HTTP 2xx. */
  nativeAccepted: boolean
  /** Stable, non-sensitive code (client code or a driver shell capability). */
  code?: string
  /** Safe human summary; never echoes text or native/transport error bodies. */
  reason?: string
  /** Present only for explicit non-dispatchable shell states. */
  unsupported?: IosQaUnsupported
  /**
   * Present only when the owned one-shot PHYSICAL transport cleanup could
   * not be proven (the loopback forward may still exist). The mutation
   * fields above are unchanged and honest regardless of this value.
   */
  transportCleanup?: {
    ok: boolean
    /** Safe fixed reason; never embeds native/transport error bodies. */
    reason?: string
  }
}

/**
 * Physical element-bound targeted-text seams. When absent, the backend uses
 * the independent CoreDevice reader (devicectl process listing) and the
 * owned one-shot 127.0.0.1 usbmux forward to the device's already-running
 * WDA control port. The physical path NEVER starts WDA, NEVER adopts or
 * kills unrelated tunnels/WDA processes, and NEVER labels the CoreDevice
 * process identity as frontmost proof.
 */
export interface IosQaPhysicalTargetedOptions {
  /** Independent CoreDevice identity reader (tests only; defaults to devicectl). */
  readAppIdentity?: (
    udid: string,
    target: { bundleId: string; expectedPID?: number },
    options?: { signal?: AbortSignal },
  ) => Promise<PhysicalAppIdentityResult>
  /** One-shot transport factory (tests only; defaults to the owned usbmux forward). */
  transportFactory?: (
    udid: string,
    options?: { signal?: AbortSignal; hardwareUdid?: string },
  ) => Promise<PhysicalTargetedTransport>
  /** Resolve CoreDevice logical id to the hardware UDID usbmuxd requires. */
  resolveHardwareUdid?: (udid: string, options?: { signal?: AbortSignal }) => Promise<string | undefined>
}

export interface IosQaScreenshot {
  udid: string
  backend: IosQaDeviceKind
  pngBase64: string
  /** Actual screenshot pixel dimensions (never guessed Retina math). */
  width: number
  height: number
}

export interface IosQaForeground {
  udid: string
  backend: IosQaDeviceKind
  app: IosQaAppIdentity
  unsupported?: IosQaUnsupported
}

export type IosQaScrollDirection = 'up' | 'down' | 'left' | 'right'
export type IosQaKey = 'home' | 'lock' | 'unlock' | 'siri' | 'volumeUp' | 'volumeDown'

export interface IosQaObserveOptions {
  maxNodes?: number
  maxDepth?: number
  signal?: AbortSignal
}

export interface SimDeviceSource {
  list(signal?: AbortSignal): Promise<SimulatorDevice[]>
  matches?(reference: string, signal?: AbortSignal): Promise<boolean>
}

export interface RealDeviceSource {
  list(signal?: AbortSignal): Promise<RealDevice[]>
  matches?(reference: string, signal?: AbortSignal): Promise<boolean>
  resolve?(reference: string, signal?: AbortSignal): Promise<RealDevice>
}

/** Simulator controller subset used by this backend (SimHostController fits). */
export interface SimBackendLike {
  ensureRunning(input: { udid: string }): Promise<SimStreamInfo>
  control(args: readonly string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>
  status(): SimHostStatus
  stop(): Promise<void>
  dispose?(): Promise<void>
  acquire?(): () => void
  release?(): void
  readonly streamInfo?: SimStreamInfo | undefined
}

export interface IosQaRawScreenshot {
  pngBase64: string
  width?: number
  height?: number
}

export interface IosQaSimulatorForegroundResult {
  bundleId?: string
  name?: string
  pid?: number
  verified: boolean
  capability?: string
  reason?: string
  prerequisite?: string
}

export interface IosQaBackendOptions {
  /** Injected physical WDA backend; when absent a configured WdaController is built. */
  wda?: WdaControllerLike
  /** Injected simulator stream backend; when absent SimHostController is built. */
  sim?: SimBackendLike
  realDevices?: RealDeviceSource
  simDevices?: SimDeviceSource
  /**
   * Injected safe simulator WDA input runtime. When absent a lazy owned
   * `createSimulatorWdaInputRuntime()` is created only on the first
   * targeted-text request (ordinary observe/click never create it). An
   * injected runtime is never disposed; `releaseDevice(udid)` still releases
   * that device's lease on whichever runtime this backend is using.
   */
  wdaInputRuntime?: SimulatorWdaInputRuntime
  /**
   * Owned-runtime factory seam (tests only). When no `wdaInputRuntime` is
   * injected, the backend lazily creates an OWNED safe runtime through this
   * factory on the first targeted-text request, defaulting to
   * `createSimulatorWdaInputRuntime()`. Ownership/dispose semantics still
   * apply: an owned runtime is disposed by `dispose()` and per-device leases
   * are released by `releaseDevice(udid)`.
   */
  wdaInputRuntimeFactory?: () => SimulatorWdaInputRuntime
  /**
   * AXe binary/resolver, or an injected describe-ui function
   * `(udid, signal?) => Promise<AxeElement[]>`. A one-argument function is
   * treated as describe-ui; a zero-argument function as a binary resolver.
   */
  axe?: IosQaAxeResolver
  simLaunch?: (udid: string, bundleId: string, signal?: AbortSignal) => Promise<string>
  realLaunch?: (udid: string, bundleId: string, signal?: AbortSignal) => Promise<{ pid?: number }>
  simScreenshot?: (udid: string, signal?: AbortSignal) => Promise<IosQaRawScreenshot>
  simDeviceAction?: (action: DeviceAction, pressButton: (name: string) => Promise<void>) => Promise<void>
  /** Test/foreground seam: resolve a fresh AXe pid to a launchctl app label. */
  simForegroundApp?: (udid: string, pid: number, signal?: AbortSignal) => Promise<IosQaSimulatorForegroundResult>
  wdaOptions?: {
    teamId?: string
    bundleId?: string
    projectDir?: string
    adoptExisting?: boolean
  }
  /** Test seam for lazy default physical WDA setup. */
  resolveSigningTeam?: (options: { explicit?: string; env?: string; fallback?: string; signal?: AbortSignal }) => Promise<SigningTeamResolution>
  /** Test seam for private physical WDA staging. */
  stagePhysicalWda?: () => Promise<{ stageDir: string }>
  /** Test seam for observing lazy WDA construction without host tooling. */
  wdaFactory?: (options: WdaOptions) => WdaControllerLike
  observeDefaults?: {
    maxNodes?: number
    maxDepth?: number
  }
  /**
   * Physical element-bound targeted-text seams (see
   * IosQaPhysicalTargetedOptions). Never uses the shared WdaController for
   * targeted text: the physical path builds its OWN one-shot loopback
   * transport and disposes only what it created.
   */
  physicalTargeted?: IosQaPhysicalTargetedOptions
}

export type IosQaAxeResolver =
  | AxeBinary
  | (() => Promise<AxeBinary>)
  | ((udid: string, signal?: AbortSignal) => Promise<AxeElement[]>)

export interface IosQaBackend {
  discover(options?: { signal?: AbortSignal }): Promise<IosQaDevice[]>
  launchApp(udid: string, bundleId: string, options?: { signal?: AbortSignal }): Promise<IosQaActionResult>
  observe(udid: string, options?: IosQaObserveOptions): Promise<IosQaObservation>
  tap(udid: string, x: number, y: number): Promise<IosQaActionResult>
  type(udid: string, text: string): Promise<IosQaActionResult>
  scroll(udid: string, direction: IosQaScrollDirection, amount?: number): Promise<IosQaActionResult>
  key(udid: string, key: IosQaKey): Promise<IosQaActionResult>
  screenshot(udid: string, options?: { signal?: AbortSignal }): Promise<IosQaScreenshot>
  foregroundApp(udid: string, options?: { signal?: AbortSignal }): Promise<IosQaForeground>
  /** Native element-bound append text mutation (targeted, append mode). */
  typeTarget(target: IosQaTargetedTextTarget): Promise<IosQaTargetedTextResult>
  /** Native element-bound replace text mutation (targeted, replace mode). */
  fillTarget(target: IosQaTargetedTextTarget): Promise<IosQaTargetedTextResult>
  /** Per-device cleanup: release only that device's owned input-runtime lease. */
  releaseDevice(udid: string): Promise<void>
  dispose(): Promise<void>
}

export class IosQaError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'IosQaError'
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const DEFAULT_MAX_NODES = 500
const DEFAULT_WDA_SNAPSHOT_DEPTH = 40
const SCROLL_DURATION_S = 0.35
const LAUNCHCTL_TIMEOUT_MS = 15_000
const AXE_REREAD_ATTEMPTS = 3
const AXE_REREAD_DELAY_MS = 150

/** Native WDA types accepted by the semantic targeted-text route. */
const TARGETED_SEMANTIC_TYPES = new Set(['TextField', 'TextView', 'SearchField'])

/** Label text that cannot be safely encoded into an NSPredicate format string. */
function unsafePredicateLabel(value: string): boolean {
  return /%[@A-Za-z]/.test(value) || /[\u0000-\u001F\u007F]/.test(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`dsh-ios qa: ${name} must be a non-empty string`)
  }
}

function assertFiniteNumber(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`dsh-ios qa: ${name} must be a finite number`)
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function isAxeBinary(value: unknown): value is AxeBinary {
  return typeof value === 'object' && value !== null
    && typeof (value as AxeBinary).available === 'boolean'
    && typeof (value as AxeBinary).installHint === 'string'
}

function screenSize(roots: readonly AxeElement[]): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const root of roots) {
    width = Math.max(width, root.frame.x + root.frame.w)
    height = Math.max(height, root.frame.y + root.frame.h)
  }
  if (width <= 0 || height <= 0) {
    const fallback = roots.length > 0 ? roots[0].frame : { w: 0, h: 0 }
    width = fallback.w
    height = fallback.h
  }
  return { width, height }
}

interface WalkState {
  count: number
  truncated: boolean
  maxDepthSeen: number
}

function appendAxeNode(element: AxeElement, depth: number, maxDepth: number | undefined, maxNodes: number, state: WalkState, out: IosQaNode[]): void {
  if (state.count >= maxNodes || (maxDepth !== undefined && depth > maxDepth)) {
    state.truncated = true
    return
  }
  state.count += 1
  state.maxDepthSeen = Math.max(state.maxDepthSeen, depth)
  const node: IosQaNode = {
    type: element.type,
    frame: {
      x: round2(element.frame.x),
      y: round2(element.frame.y),
      width: round2(element.frame.w),
      height: round2(element.frame.h),
    },
  }
  if (element.label !== undefined) node.name = element.label
  if (element.identifier !== undefined) node.identifier = element.identifier
  if (element.value !== undefined && element.secure !== true) node.value = element.value
  if (element.enabled !== undefined) node.enabled = element.enabled
  if (element.focused !== undefined) node.focused = element.focused
  if (element.selected !== undefined) node.selected = element.selected
  if (element.visible !== undefined) node.visible = element.visible
  if (element.secure !== undefined) node.secure = element.secure
  out.push(node)
  for (const child of element.children) {
    appendAxeNode(child, depth + 1, maxDepth, maxNodes, state, out)
    if (state.count >= maxNodes) {
      state.truncated = true
      break
    }
  }
}

function observeFromAxe(roots: readonly AxeElement[], maxNodes: number, maxDepth: number | undefined): { nodes: IosQaNode[]; depth: number; truncated: boolean } {
  const state: WalkState = { count: 0, truncated: false, maxDepthSeen: -1 }
  const nodes: IosQaNode[] = []
  for (const root of roots) {
    appendAxeNode(root, 0, maxDepth, maxNodes, state, nodes)
    if (state.count >= maxNodes) {
      state.truncated = true
      break
    }
  }
  return { nodes, depth: Math.max(0, state.maxDepthSeen), truncated: state.truncated }
}

function parseLaunchctlUIKit(stdout: string): Array<{ pid: number; label: string; bundleId: string }> {
  const entries: Array<{ pid: number; label: string; bundleId: string }> = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('PID') || line.startsWith('Status')) continue
    const match = /^(\d+)\s+\S+\s+(UIKitApplication:.+)$/u.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const label = match[2].trim()
    const bundleId = label.replace(/^UIKitApplication:/u, '').split('[', 1)[0].replace(/\]/g, '')
    if (!Number.isSafeInteger(pid) || bundleId === '') continue
    entries.push({ pid, label, bundleId })
  }
  return entries
}

async function launchctlUIKitForUdid(udid: string, signal?: AbortSignal): Promise<Array<{ pid: number; label: string; bundleId: string }>> {
  return new Promise((resolve, reject) => {
    execFile('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], {
      timeout: LAUNCHCTL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      signal,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new IosQaError(`simulator launchctl list failed: ${(stderr || stdout || error.message).trim()}`, 'simulator.foreground.launchctl-failed'))
        return
      }
      resolve(parseLaunchctlUIKit(stdout))
    })
  })
}

// ── Backend ───────────────────────────────────────────────────────────────────

export function createIosQaBackend(options: IosQaBackendOptions = {}): IosQaBackend {
  return new IosQaBackendImpl(options)
}

class IosQaBackendImpl implements IosQaBackend {
  readonly #sim: SimBackendLike
  readonly #ownsSim: boolean
  #wda: WdaControllerLike | undefined
  readonly #ownsWda: boolean
  #wdaCreatedByBackend: boolean
  #ownedWdaBinding: { logicalUdid: string; hardwareUdid: string } | undefined
  readonly #simDevices: SimDeviceSource
  readonly #realDevices: RealDeviceSource
  readonly #axeResolver: IosQaAxeResolver | undefined
  readonly #simLaunch: (udid: string, bundleId: string, signal?: AbortSignal) => Promise<string>
  readonly #realLaunch: (udid: string, bundleId: string, signal?: AbortSignal) => Promise<{ pid?: number }>
  readonly #simScreenshot: (udid: string, signal?: AbortSignal) => Promise<IosQaRawScreenshot>
  readonly #simDeviceAction: (action: DeviceAction, pressButton: (name: string) => Promise<void>) => Promise<void>
  readonly #simForegroundApp: ((udid: string, pid: number, signal?: AbortSignal) => Promise<IosQaSimulatorForegroundResult>) | undefined
  readonly #observeDefaults: { maxNodes?: number; maxDepth?: number }
  readonly #hasWdaSigning: boolean
  readonly #wdaOptions: NonNullable<IosQaBackendOptions['wdaOptions']>
  readonly #resolveSigningTeam: NonNullable<IosQaBackendOptions['resolveSigningTeam']>
  readonly #stagePhysicalWda: NonNullable<IosQaBackendOptions['stagePhysicalWda']>
  readonly #wdaFactory: NonNullable<IosQaBackendOptions['wdaFactory']>
  /** Physical targeted-text seams (identity reader + transport factory). */
  readonly #physicalTargeted: IosQaPhysicalTargetedOptions
  /** Injected safe input runtime (never owned/disposed by this backend). */
  readonly #injectedInputRuntime: SimulatorWdaInputRuntime | undefined
  /** Owned-runtime factory (test seam; defaults to createSimulatorWdaInputRuntime). */
  readonly #wdaInputRuntimeFactory: () => SimulatorWdaInputRuntime
  /** Lazily-created owned safe input runtime; only created on a target request. */
  #ownedInputRuntime: SimulatorWdaInputRuntime | undefined
  readonly #ownedWdaDevices = new Map<string, { hardwareUdid: string }>()
  /** Devices for which empty AX recovery has already acquired one owned lease. */
  readonly #axeRecoveryLeases = new Set<string>()

  constructor(options: IosQaBackendOptions) {
    const providedSim = options.sim
    this.#ownsSim = providedSim === undefined
    this.#sim = providedSim ?? new SimHostController()

    const wdaOptions = options.wdaOptions ?? {}
    const envTeam = process.env.DSH_IOS_TEAM_ID?.trim() ?? ''
    const explicitTeam = typeof wdaOptions.teamId === 'string' && wdaOptions.teamId.trim() !== ''
    this.#hasWdaSigning = options.wda !== undefined || explicitTeam || envTeam !== ''
    this.#wda = options.wda
    this.#ownsWda = options.wda === undefined
    this.#wdaCreatedByBackend = options.wda === undefined
    this.#wdaOptions = wdaOptions
    this.#resolveSigningTeam = options.resolveSigningTeam ?? resolveSigningTeam
    this.#stagePhysicalWda = options.stagePhysicalWda ?? (async () => resolvePhysicalWdaProjectDir())
    this.#wdaFactory = options.wdaFactory ?? (wda => new WdaController(wda))

    this.#injectedInputRuntime = options.wdaInputRuntime
    this.#wdaInputRuntimeFactory = options.wdaInputRuntimeFactory ?? createSimulatorWdaInputRuntime
    this.#physicalTargeted = options.physicalTargeted ?? {}

    this.#simDevices = options.simDevices ?? {
      list: _signal => listSimulatorDevices(),
      matches: async (reference, _signal) => {
        const devices = await listSimulatorDevices()
        return devices.some(device => device.udid === reference)
      },
    }
    this.#realDevices = options.realDevices ?? {
      list: signal => listRealDevices(signal),
      matches: (reference, signal) => matchesRealDevice(reference, signal),
      resolve: (reference, signal) => getRealDevice(reference, signal),
    }
    this.#axeResolver = options.axe
    this.#simLaunch = options.simLaunch ?? ((udid, bundleId, signal) => simctlLaunchApp(udid, bundleId, signal))
    this.#realLaunch = options.realLaunch ?? ((udid, bundleId, signal) => devicectlLaunchApp(udid, bundleId, signal))
    this.#simScreenshot = options.simScreenshot ?? (async (udid, signal) => {
      const path = join(tmpdir(), `dsh-ios-qa-${udid}-${process.pid}-${Date.now()}.png`)
      try {
        await simctlTakeScreenshot(udid, path, signal)
        const pngBase64 = readFileSync(path).toString('base64')
        const size = pngDimensionsFromBase64(pngBase64)
        return { pngBase64, ...(size === undefined ? {} : size) }
      } finally {
        try { rmSync(path, { force: true }) } catch { /* best effort */ }
      }
    })
    this.#simDeviceAction = options.simDeviceAction ?? runSimulatorDeviceAction
    this.#simForegroundApp = options.simForegroundApp
    this.#observeDefaults = options.observeDefaults ?? {}
  }

  async discover(options: { signal?: AbortSignal } = {}): Promise<IosQaDevice[]> {
    const devices: IosQaDevice[] = []
    try {
      const sims = await this.#simDevices.list(options.signal)
      for (const sim of sims) {
        devices.push({
          udid: sim.udid,
          kind: 'simulator',
          name: sim.name,
          state: sim.state,
          ...(sim.runtime === undefined ? {} : { runtime: sim.runtime }),
          available: sim.state === 'Booted' || sim.state.toLowerCase().includes('boot'),
        })
      }
    } catch (error) {
      // Simulator discovery is best-effort; physical listing can still work.
    }
    try {
      const reals = await this.#realDevices.list(options.signal)
      for (const real of reals) {
        devices.push({
          udid: real.udid,
          kind: 'physical',
          name: real.name,
          state: real.state,
          ...(real.osVersion === undefined ? {} : { osVersion: real.osVersion }),
          ...(real.model === undefined ? {} : { model: real.model }),
          available: real.state.includes('available') && real.pairingState === 'paired',
        })
      }
    } catch {
      // A missing devicectl should not hide the simulator list.
    }
    return devices
  }

  async launchApp(udid: string, bundleId: string, options: { signal?: AbortSignal } = {}): Promise<IosQaActionResult> {
    assertNonEmpty(udid, 'udid')
    assertNonEmpty(bundleId, 'bundleId')
    const kind = await this.#resolveKind(udid, options.signal)
    try {
      if (kind === 'simulator') {
        const output = await this.#simLaunch(udid, bundleId, options.signal)
        // simctl launch stdout contains the pid; acceptance is simply that the
        // native launcher returned.
        void output
        return this.#ok(kind, udid, 'launchApp')
      }
      await this.#realLaunch(udid, bundleId, options.signal)
      return this.#ok('physical', udid, 'launchApp')
    } catch (error) {
      throw new IosQaError(`dsh-ios qa: launchApp failed for ${udid}: ${errorMessage(error)}`, 'launch-failed')
    }
  }

  async observe(udid: string, options: IosQaObserveOptions = {}): Promise<IosQaObservation> {
    assertNonEmpty(udid, 'udid')
    const signal = options.signal
    const kind = await this.#resolveKind(udid, signal)
    const maxNodes = this.#validMaxNodes(options.maxNodes ?? this.#observeDefaults.maxNodes)
    const maxDepth = options.maxDepth ?? this.#observeDefaults.maxDepth
    if (kind === 'simulator') {
      const roots = await this.#describeSimulator(udid, signal)
      const size = screenSize(roots)
      const built = observeFromAxe(roots, maxNodes, maxDepth)
      // Bind observation to the SAME captured AXe PID via the shared
      // launchctl/foreground verification path. A PID/app switch between the
      // tree dump and the launchctl read leaves verified:false instead of
      // labelling an old tree with a new app.
      const resolution = await this.#simulatorForeground(udid, roots, signal)
      return {
        udid,
        backend: 'simulator',
        app: this.#appIdentityFromResolution(resolution),
        screen: { width: round2(size.width), height: round2(size.height) },
        nodes: built.nodes,
        truncated: built.truncated,
        depth: built.depth,
        maxNodes,
        ...(maxDepth === undefined ? {} : { maxDepth }),
      }
    }
    const wda = await this.#requireWda(udid, signal)
    const backend = 'physical'
    // Bound the WDA snapshot before /source is called. Older WDA builds may
    // reject the setting; ignore that and snapshot at whatever the device can do.
    try {
      await wda.control.setSnapshotDepth(Math.max(1, Math.min(maxDepth ?? DEFAULT_WDA_SNAPSHOT_DEPTH, 100)))
    } catch {
      // Older WDA without /appium/settings.
    }
    const xml = await wda.control.source()
    const roots = wdaSourceToElements(xml)
    const built = observeFromAxe(roots, maxNodes, maxDepth)
    const screen = await this.#wdaPointSize(wda).catch(() => screenSize(roots))
    const app = await this.#wdaAppIdentity(wda).catch(() => ({ verified: false } as IosQaAppIdentity))
    return {
      udid,
      backend,
      app,
      screen: { width: round2(screen.width), height: round2(screen.height) },
      nodes: built.nodes,
      truncated: built.truncated,
      depth: built.depth,
      maxNodes,
      ...(maxDepth === undefined ? {} : { maxDepth }),
    }
  }

  async tap(udid: string, x: number, y: number): Promise<IosQaActionResult> {
    assertNonEmpty(udid, 'udid')
    assertFiniteNumber(x, 'x')
    assertFiniteNumber(y, 'y')
    if (x < 0 || y < 0) throw new RangeError('dsh-ios qa: tap coordinates must be non-negative device points')
    const kind = await this.#resolveKind(udid)
    try {
      if (kind === 'simulator') {
        const size = await this.#simulatorPointSize(udid)
        if (size.width <= 0 || size.height <= 0) {
          return this.#unsupported(kind, udid, 'tap', 'simulator.point-size.unavailable', 'the simulator point size could not be read from the accessibility tree')
        }
        await this.#withSimLease(udid, async () => {
          await this.#sim.control(['tap', String(x / size.width), String(y / size.height), '-d', udid])
        })
        return this.#ok(kind, udid, 'tap')
      }
      const wda = await this.#requireWda(udid)
      await wda.control.tap(x, y)
      return this.#ok(kind, udid, 'tap')
    } catch (error) {
      if (error instanceof IosQaError && error.code?.startsWith('unsupported.')) {
        return this.#unsupportedResultFromError(kind, udid, 'tap', error)
      }
      throw error
    }
  }

  async type(udid: string, text: string): Promise<IosQaActionResult> {
    assertNonEmpty(udid, 'udid')
    if (typeof text !== 'string' || text === '') throw new TypeError('dsh-ios qa: type requires a non-empty string')
    const kind = await this.#resolveKind(udid)
    try {
      if (kind === 'simulator') {
        await this.#withSimLease(udid, async () => {
          await this.#sim.control(['type', text, '-d', udid])
        })
        return this.#ok(kind, udid, 'type')
      }
      const wda = await this.#requireWda(udid)
      await wda.control.typeText(text)
      return this.#ok(kind, udid, 'type')
    } catch (error) {
      if (error instanceof IosQaError && error.code?.startsWith('unsupported.')) {
        return this.#unsupportedResultFromError(kind, udid, 'type', error)
      }
      throw error
    }
  }

  async scroll(udid: string, direction: IosQaScrollDirection, amount = 0.6): Promise<IosQaActionResult> {
    assertNonEmpty(udid, 'udid')
    if ((['up', 'down', 'left', 'right'] as readonly string[]).indexOf(direction) < 0) {
      throw new RangeError(`dsh-ios qa: scroll direction must be up/down/left/right, got ${String(direction)}`)
    }
    if (!Number.isFinite(amount) || amount < 0 || amount > 1) {
      throw new RangeError('dsh-ios qa: scroll amount must be a number within 0..1')
    }
    const kind = await this.#resolveKind(udid)
    try {
      if (kind === 'simulator') {
        const request: SimScrollRequest = { direction, amount, anchorX: 0.5, anchorY: 0.5 }
        const points = simScrollPath(request)
        await this.#withSimLease(udid, async info => {
          if (info !== undefined && info.device === udid && typeof info.wsUrl === 'string') {
            await sendSimGesture(info.wsUrl, points)
            return
          }
          const from = points[0]
          const to = points[points.length - 1]
          for (const [type, point] of [['begin', from], ['move', to], ['end', to]] as const) {
            await this.#sim.control(['gesture', JSON.stringify({ type, x: point.x, y: point.y }), '-d', udid])
          }
        })
        return this.#ok(kind, udid, 'scroll')
      }
      const wda = await this.#requireWda(udid)
      const request: SimScrollRequest = { direction, amount, anchorX: 0.5, anchorY: 0.5 }
      const points = simScrollPath(request)
      const size = await this.#wdaPointSize(wda)
      const from = points[0]
      const to = points[points.length - 1]
      await wda.control.dragFromToForDuration({
        fromX: Math.round(from.x * size.width),
        fromY: Math.round(from.y * size.height),
        toX: Math.round(to.x * size.width),
        toY: Math.round(to.y * size.height),
        duration: SCROLL_DURATION_S,
      })
      return this.#ok(kind, udid, 'scroll')
    } catch (error) {
      if (error instanceof IosQaError && error.code?.startsWith('unsupported.')) {
        return this.#unsupportedResultFromError(kind, udid, 'scroll', error)
      }
      throw error
    }
  }

  async key(udid: string, key: IosQaKey): Promise<IosQaActionResult> {
    assertNonEmpty(udid, 'udid')
    if ((['home', 'lock', 'unlock', 'siri', 'volumeUp', 'volumeDown'] as readonly string[]).indexOf(key) < 0) {
      throw new RangeError(`dsh-ios qa: unknown key ${String(key)}`)
    }
    const kind = await this.#resolveKind(udid)
    try {
      if (kind === 'simulator') {
        if (key === 'volumeUp' || key === 'volumeDown') {
          return this.#unsupported(kind, udid, 'key', 'simulator.volume-keys.unsupported', 'serve-sim / Simulator.app do not expose reliable volume keys on a simulator')
        }
        await this.#withSimLease(udid, async () => {
          if (key === 'home' || key === 'lock') {
            await this.#sim.control(['button', key, '-d', udid])
            return
          }
          const pressButton = async (name: string): Promise<void> => {
            await this.#sim.control(['button', name, '-d', udid])
          }
          const action: DeviceAction = key === 'unlock' ? 'unlock' : 'siri'
          await this.#simDeviceAction(action, pressButton)
        })
        return this.#ok(kind, udid, 'key')
      }
      const wda = await this.#requireWda(udid)
      switch (key) {
        case 'home':
        case 'volumeUp':
        case 'volumeDown':
          await wda.control.pressButton(key)
          break
        case 'lock':
          await wda.control.lock()
          break
        case 'unlock':
          await wda.control.unlock()
          break
        case 'siri':
          await wda.control.activateSiri()
          break
      }
      return this.#ok(kind, udid, 'key')
    } catch (error) {
      if (error instanceof IosQaError && error.code?.startsWith('unsupported.')) {
        return this.#unsupportedResultFromError(kind, udid, 'key', error)
      }
      throw error
    }
  }

  async screenshot(udid: string, options: { signal?: AbortSignal } = {}): Promise<IosQaScreenshot> {
    assertNonEmpty(udid, 'udid')
    const kind = await this.#resolveKind(udid, options.signal)
    if (kind === 'simulator') {
      const shot = await this.#simScreenshot(udid, options.signal)
      const width = shot.width
      const height = shot.height
      if (!Number.isSafeInteger(width) || width === undefined || !Number.isSafeInteger(height) || height === undefined || width <= 0 || height <= 0) {
        throw new IosQaError('simulator screenshot did not report pixel dimensions', 'screenshot.dimensions-unavailable')
      }
      return { udid, backend: 'simulator', pngBase64: shot.pngBase64, width, height }
    }
    const wda = await this.#requireWda(udid, options.signal)
    const shot = await wda.control.screenshot()
    const width = shot.width
    const height = shot.height
    if (!Number.isSafeInteger(width) || width === undefined || !Number.isSafeInteger(height) || height === undefined || width <= 0 || height <= 0) {
      throw new IosQaError('WDA screenshot did not report pixel dimensions', 'screenshot.dimensions-unavailable')
    }
    return { udid, backend: 'physical', pngBase64: shot.pngBase64, width, height }
  }

  async foregroundApp(udid: string, options: { signal?: AbortSignal } = {}): Promise<IosQaForeground> {
    assertNonEmpty(udid, 'udid')
    const signal = options.signal
    const kind = await this.#resolveKind(udid, signal)
    if (kind === 'simulator') {
      let roots: AxeElement[]
      try {
        roots = await this.#describeSimulator(udid, signal)
      } catch (error) {
        return {
          udid,
          backend: 'simulator',
          app: { verified: false },
          unsupported: { capability: 'simulator.foreground-app.unavailable', reason: `fresh AXe describe-ui failed: ${errorMessage(error)}` },
        }
      }
      const resolution = await this.#simulatorForeground(udid, roots, signal)
      return this.#foregroundFromResolution(udid, kind, resolution)
    }
    let wda: WdaControllerLike
    try {
      wda = await this.#requireWda(udid, signal)
    } catch (error) {
      if (error instanceof IosQaError && error.code?.startsWith('unsupported.')) {
        const code = error.code.replace(/^unsupported\./u, '')
        return {
          udid,
          backend: 'physical',
          app: { verified: false },
          unsupported: { capability: code, reason: error.message },
        }
      }
      throw error
    }
    const app = await this.#wdaAppIdentity(wda)
    if (!app.verified) {
      return {
        udid,
        backend: 'physical',
        app,
        unsupported: {
          capability: app.bundleId !== undefined ? 'wda.active-app-info.incomplete' : 'wda.active-app-info.unavailable',
          reason: 'WDA did not provide a verified active app identity',
          prerequisite: 'use a WDA build that supports GET /wda/activeAppInfo',
        },
      }
    }
    return { udid, backend: 'physical', app }
  }

  async typeTarget(target: IosQaTargetedTextTarget): Promise<IosQaTargetedTextResult> {
    return this.#targetedText(target, 'append', 'typeTarget')
  }

  async fillTarget(target: IosQaTargetedTextTarget): Promise<IosQaTargetedTextResult> {
    return this.#targetedText(target, 'replace', 'fillTarget')
  }

  /**
   * Per-device cleanup for a QA session stop. Releases that device's owned
   * safe-input-runtime lease (and matches on an injected runtime the backend
   * is using). It never disposes the shared/injected simulator stream or WDA
   * backends and never shuts down user devices/apps or unrelated devices.
   *
   * A genuinely absent lease resolves cleanly (released). An intentional
   * unproven-cleanup state from the runtime (e.g. BUSY artifacts left behind)
   * is NOT treated as released: it propagates as a sanitized typed cleanup
   * error so the QA adapter knows the per-device stop did not fully clean up.
   */
  async releaseDevice(udid: string): Promise<void> {
    assertNonEmpty(udid, 'udid')
    const runtime = this.#injectedInputRuntime ?? this.#ownedInputRuntime
    if (runtime !== undefined) {
      try {
        await runtime.release(udid)
        this.#axeRecoveryLeases.delete(udid)
      } catch (error) {
        throw this.#cleanupError(error, 'release')
      }
    }
    const bindingMatches = this.#ownedWdaBinding !== undefined
      && (this.#ownedWdaBinding.logicalUdid === udid || this.#ownedWdaBinding.hardwareUdid === udid)
    const statusDevice = this.#wda?.status().device
    if (this.#wdaCreatedByBackend && this.#wda !== undefined && (bindingMatches || statusDevice === udid)) {
      try {
        await this.#wda.stop()
        this.#ownedWdaDevices.clear()
        this.#ownedWdaBinding = undefined
      } catch (error) {
        throw new IosQaError('dsh-ios qa: release of the owned WebDriverAgent failed without a clean proof', 'wda.release-failed')
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#ownsSim) {
      try { await this.#sim.stop() } catch { /* stop is best-effort */ }
      if (this.#sim.dispose !== undefined) {
        try { await this.#sim.dispose() } catch { /* best-effort */ }
      }
    }
    if (this.#ownsWda && this.#wda !== undefined) {
      if ('dispose' in this.#wda && typeof (this.#wda as unknown as { dispose?: () => Promise<void> }).dispose === 'function') {
        try { await (this.#wda as unknown as { dispose: () => Promise<void> }).dispose() } catch { /* best-effort */ }
      }
    }
    if (this.#ownedInputRuntime !== undefined) {
      const runtime = this.#ownedInputRuntime
      try {
        await runtime.dispose()
        // Only drop the handle after a proven dispose; an intentional
        // unproven-cleanup state must keep the runtime handle so a later
        // release/retry still sees BUSY instead of a fresh orphan-spawning run.
        this.#ownedInputRuntime = undefined
        this.#axeRecoveryLeases.clear()
      } catch (error) {
        throw this.#cleanupError(error, 'dispose')
      }
    }
    this.#ownedWdaDevices.clear()
    this.#ownedWdaBinding = undefined
  }

  // ── Public surface private helpers ──────────────────────────────────────────

  /**
   * Shared implementation for `typeTarget` (append) and `fillTarget`
   * (replace). Enforces secure refusal before any setup, routes simulator and
   * physical udids to their dedicated element-bound paths, and propagates the
   * targeted-text client result honestly. The simulator path samples a
   * verified FRONTMOST app/PID (AXe ↔ launchctl) before its runtime ensure;
   * the physical path samples independent CoreDevice RUNNING process
   * identity (never frontmost) plus mandatory WDA activeApp corroboration.
   */
  async #targetedText(
    target: IosQaTargetedTextTarget,
    mode: IosQaTargetedTextMode,
    action: IosQaTargetedTextAction,
  ): Promise<IosQaTargetedTextResult> {
    const base = { udid: '', backend: 'simulator' as const, action, mode }
    if (target === undefined || target === null || typeof target !== 'object') {
      return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'INVALID_ARGUMENT', reason: 'target is required' }
    }
    if (typeof target.udid !== 'string' || target.udid === '' || typeof target.bundleId !== 'string' || target.bundleId === '') {
      return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'INVALID_ARGUMENT', reason: 'udid and bundleId are required' }
    }
    // Exactly one element route: native identifier XOR native label+type.
    const hasIdentifier = target.identifier !== undefined
    const hasSemantic = target.semantic !== undefined
    if (hasIdentifier === hasSemantic) {
      return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'INVALID_ARGUMENT', reason: 'exactly one of identifier or semantic must be provided' }
    }
    if (hasIdentifier) {
      if (typeof target.identifier !== 'string' || target.identifier === '') {
        return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'INVALID_ARGUMENT', reason: 'identifier must be a non-empty string when provided' }
      }
    } else {
      const semantic = target.semantic
      if (semantic === undefined || semantic === null || typeof semantic !== 'object'
        || typeof semantic.label !== 'string' || semantic.label === ''
        || typeof semantic.type !== 'string' || !TARGETED_SEMANTIC_TYPES.has(semantic.type)) {
        return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'INVALID_ARGUMENT', reason: 'semantic must provide a non-empty label and a native type (TextField, TextView, or SearchField)' }
      }
      if (semantic.label.length > WDA_TARGETED_MAX_TEXT_LENGTH || unsafePredicateLabel(semantic.label)) {
        return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'INVALID_ARGUMENT', reason: 'semantic label cannot be safely encoded into a native predicate string' }
      }
    }
    const frame = target.frame
    if (frame === undefined || frame === null || typeof frame !== 'object'
      || !Number.isFinite(frame.x) || !Number.isFinite(frame.y)
      || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)
      || frame.width < 0 || frame.height < 0) {
      return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'INVALID_ARGUMENT', reason: 'frame must be finite non-negative point bounds' }
    }
    if (typeof target.text !== 'string' || target.text.length > WDA_TARGETED_MAX_TEXT_LENGTH) {
      return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'INVALID_ARGUMENT', reason: 'text must be a string within the bounded length' }
    }
    if (mode === 'append' && target.text.length === 0) {
      return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'INVALID_ARGUMENT', reason: 'append requires a non-empty text; use fillTarget to clear the element' }
    }
    if (target.secure === true) {
      return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'SECURE_REJECTED', reason: 'secure text targets are rejected before any runtime/device setup' }
    }
    if (target.secure !== undefined && typeof target.secure !== 'boolean') {
      return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'INVALID_ARGUMENT', reason: 'secure must be a boolean when provided' }
    }
    // Do not read the target text into any reason/report fields.
    void target.text

    const signal = target.signal
    if (signal?.aborted === true) {
      return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: 'CANCELLED', reason: 'operation was cancelled before mutation' }
    }

    let kind: IosQaDeviceKind
    try {
      kind = await this.#resolveKind(target.udid, signal)
    } catch (error) {
      return { ...base, status: 'rejected', dispatched: false, nativeAccepted: false, code: errorMessage(error).includes('unknown-device') ? 'UNKNOWN_DEVICE' : 'DEVICE_UNRESOLVED', reason: errorMessage(error) }
    }
    if (kind === 'physical') {
      return this.#physicalTargetedText(target, mode, action, frame, signal)
    }

    // Sample actual verified app/PID BEFORE runtime setup.
    let before: IosQaSimulatorForegroundResult
    try {
      const roots = await this.#describeSimulator(target.udid, signal)
      before = await this.#simulatorForeground(target.udid, roots, signal)
    } catch {
      before = { verified: false, capability: 'simulator.foreground-app.unavailable', reason: 'could not sample the simulator foreground app before runtime setup' }
    }
    if (!before.verified || before.bundleId === undefined || before.pid === undefined) {
      return {
        ...base,
        udid: target.udid,
        status: 'rejected',
        dispatched: false,
        nativeAccepted: false,
        code: 'APP_IDENTITY_UNAVAILABLE',
        reason: before.reason ?? 'the simulator foreground app could not be verified before runtime setup',
        unsupported: {
          capability: before.capability ?? 'simulator.foreground-app.unavailable',
          reason: before.reason ?? 'the simulator foreground app could not be verified before runtime setup',
        },
      }
    }
    if (before.bundleId !== target.bundleId) {
      return {
        ...base,
        udid: target.udid,
        status: 'rejected',
        dispatched: false,
        nativeAccepted: false,
        code: 'APP_IDENTITY_MISMATCH',
        reason: 'the verified foreground app does not match the requested bundleId',
      }
    }
    if (target.expectedPID !== undefined && target.expectedPID !== before.pid) {
      return {
        ...base,
        udid: target.udid,
        status: 'rejected',
        dispatched: false,
        nativeAccepted: false,
        code: 'APP_IDENTITY_MISMATCH',
        reason: 'the requested pid precondition does not match the verified app at startup',
      }
    }
    const expectedPID = target.expectedPID ?? before.pid
    // Lazy runtime ensure; only reached on a targeted-text request.
    let connection: WdaSimulatorConnection
    try {
      connection = await this.#ensureInputRuntime(target.udid, signal)
    } catch (error) {
      const runtimeError = error as { code?: string }
      const code = runtimeError?.code === 'UNSUPPORTED' ? 'RUNTIME_UNSUPPORTED'
        : runtimeError?.code === 'BUSY' ? 'RUNTIME_BUSY'
          : 'RUNTIME_UNAVAILABLE'
      return {
        ...base,
        udid: target.udid,
        status: 'rejected',
        dispatched: false,
        nativeAccepted: false,
        code,
        reason: 'the safe simulator WDA input runtime could not be prepared; no mutation was dispatched',
        unsupported: {
          capability: code === 'RUNTIME_BUSY' ? 'input-runtime.busy' : code === 'RUNTIME_UNSUPPORTED' ? 'input-runtime.source-unavailable' : 'input-runtime.unavailable',
          reason: 'safe staged WDA input runtime prerequisite was not met',
          prerequisite: 'ensure the cached safe WDA source/runtime prerequisite is present',
        },
      }
    }

    const clientTarget: WdaTargetedTextTarget = {
      udid: target.udid,
      bundleId: target.bundleId,
      ...(target.identifier === undefined ? {} : { identifier: target.identifier }),
      ...(target.semantic === undefined ? {} : { semantic: { label: target.semantic.label, type: target.semantic.type } }),
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      mode,
      text: target.text,
      expectedPID,
      ...(target.secure === undefined ? {} : { secure: target.secure }),
      ...(signal === undefined ? {} : { signal }),
    }
    const environment: WdaTargetedTextEnvironment = {
      transport: {
        udid: target.udid,
        request: (method, path, body, options) => connection.request(method, path, body, options),
      },
      readAppIdentity: async (udid, options) => {
        try {
          const roots = await this.#describeSimulator(udid, options?.signal)
          const resolved = await this.#simulatorForeground(udid, roots, options?.signal)
          if (!resolved.verified || resolved.pid === undefined) {
            return { bundleId: resolved.bundleId ?? '', pid: resolved.pid ?? -1, verified: false }
          }
          return { bundleId: resolved.bundleId ?? '', pid: resolved.pid, verified: true }
        } catch {
          return { bundleId: '', pid: -1, verified: false }
        }
      },
    }

    // The client is intentionally documented to never throw for operational
    // failures and to never echo text/native bodies in its result.
    const clientResult = await performWdaTargetedText(clientTarget, environment)
    const result: IosQaTargetedTextResult = {
      udid: target.udid,
      backend: 'simulator',
      action,
      mode,
      status: clientResult.status,
      dispatched: clientResult.dispatched,
      nativeAccepted: clientResult.nativeAccepted,
    }
    if (clientResult.code !== undefined) result.code = clientResult.code
    if (clientResult.reason !== undefined) result.reason = clientResult.reason
    return result
  }

  /**
   * Physical element-bound targeted text.
   *
   * Contract (fail-closed, never weakened):
   * 1. Independent CoreDevice sample BEFORE any transport/session setup: the
   *    requested bundle has a RUNNING on-device process (devicectl). This is
   *    process identity — NEVER frontmost proof; devicectl exposes no
   *    foreground signal.
   * 2. The sample pins `expectedPID` (explicit or the single verified
   *    process). Ambiguity without a pin fails closed.
   * 3. The unchanged client then enforces: udid equality, a dedicated pinned
   *    session (forceAppLaunch/shouldTerminateApp false), mandatory
   *    session-scoped WDA activeAppInfo corroboration (bundleId AND pid),
   *    exactly-one element via accessibility id OR exact native label+type
   *    `predicate string` (label verified through /attribute/label), fresh
   *    native label/type/enabled/visible/secure(via type)/rect guards
   *    immediately pre-mutation, and exactly-once clear/value — no taps, no
   *    global /wda/keys, no mutation retries. Empty fill text = one clear.
   * 4. The transport is ONE-SHOT and OWNED: a fresh 127.0.0.1 usbmux forward
   *    to the already-running device WDA. No WDA startup, no adoption of
   *    unrelated tunnels, and dispose closes only what this call created.
   */
  async #physicalTargetedText(
    target: IosQaTargetedTextTarget,
    mode: IosQaTargetedTextMode,
    action: IosQaTargetedTextAction,
    frame: { x: number; y: number; width: number; height: number },
    signal: AbortSignal | undefined,
  ): Promise<IosQaTargetedTextResult> {
    const udid = target.udid
    const bundleId = target.bundleId
    /** Fresh abort read (a call so TS never carries stale narrowing). */
    const cancelled = (): boolean => signal?.aborted === true
    const rejected = (code: string, reason: string, unsupported?: IosQaUnsupported): IosQaTargetedTextResult => ({
      udid,
      backend: 'physical',
      action,
      mode,
      status: 'rejected',
      dispatched: false,
      nativeAccepted: false,
      code,
      reason,
      ...(unsupported === undefined ? {} : { unsupported }),
    })

    const readIdentity = this.#physicalTargeted.readAppIdentity
      ?? ((deviceUdid: string, identityTarget: { bundleId: string; expectedPID?: number }, options?: { signal?: AbortSignal }) =>
        readPhysicalAppIdentity(deviceUdid, identityTarget, options))

    // 1. Independent CoreDevice identity BEFORE any transport/session setup.
    let before: PhysicalAppIdentityResult
    try {
      before = await readIdentity(udid, { bundleId, expectedPID: target.expectedPID }, { signal })
    } catch {
      before = {
        verified: false,
        capability: 'physical.targeted.identity.unavailable',
        reason: 'the independent CoreDevice identity reader failed',
      }
    }
    if (cancelled()) {
      return rejected('CANCELLED', 'operation was cancelled before mutation')
    }
    if (!before.verified || before.bundleId === undefined || before.pid === undefined) {
      const capability = before.capability ?? 'physical.targeted.identity.unavailable'
      const code = capability === 'physical.targeted.identity.ambiguous'
        ? 'APP_IDENTITY_AMBIGUOUS'
        : capability === 'physical.targeted.identity.unavailable'
          ? 'APP_IDENTITY_UNAVAILABLE'
          : 'APP_IDENTITY_MISMATCH'
      return rejected(code, before.reason ?? 'the independent CoreDevice app identity could not be verified before setup', {
        capability,
        reason: before.reason ?? 'the independent CoreDevice app identity could not be verified before setup',
        prerequisite: 'run the app on the device and, when several processes share the bundle, pin the exact process with expectedPID',
      })
    }
    if (before.bundleId !== bundleId) {
      return rejected('APP_IDENTITY_MISMATCH', 'the CoreDevice sample does not match the requested bundleId', {
        capability: 'physical.targeted.identity.not-running',
        reason: 'the independent CoreDevice sample resolved a different bundle',
      })
    }
    if (target.expectedPID !== undefined && target.expectedPID !== before.pid) {
      return rejected('APP_IDENTITY_MISMATCH', 'the requested pid precondition does not match the verified CoreDevice process', {
        capability: 'physical.targeted.identity.pid-mismatch',
        reason: 'the requested pid precondition does not match the verified CoreDevice process',
      })
    }
    const expectedPID = target.expectedPID ?? before.pid
    let hardwareUdid: string | undefined
    try {
      if (this.#physicalTargeted.resolveHardwareUdid !== undefined) {
        hardwareUdid = await this.#physicalTargeted.resolveHardwareUdid(udid, { signal })
      } else if (this.#realDevices.resolve !== undefined) {
        const resolved = await this.#realDevices.resolve(udid, signal)
        const requestedMatches = resolved.udid === udid || resolved.hardwareUdid === udid
        hardwareUdid = requestedMatches && typeof resolved.hardwareUdid === 'string' && resolved.hardwareUdid.trim() !== ''
          ? resolved.hardwareUdid
          : undefined
      } else if (this.#physicalTargeted.transportFactory !== undefined) {
        hardwareUdid = udid
      }
    } catch {
      hardwareUdid = undefined
    }
    if (cancelled()) return rejected('CANCELLED', 'operation was cancelled before mutation')
    if (hardwareUdid === undefined || hardwareUdid === '') {
      return rejected('APP_IDENTITY_MISMATCH', 'CoreDevice identity has no verified hardware UDID for usbmux', {
        capability: 'physical.targeted.hardware-udid.unavailable',
        reason: 'the CoreDevice logical identifier could not be mapped to the attached hardware UDID',
      })
    }

    // 2. Own one-shot transport (fresh 127.0.0.1 usbmux forward). Never
    // starts WDA, never adopts/kills unrelated tunnels or processes.
    const buildTransport = this.#physicalTargeted.transportFactory
      ?? ((deviceUdid: string, options?: { signal?: AbortSignal; hardwareUdid?: string }) =>
        createPhysicalTargetedTransport({ udid: deviceUdid, hardwareUdid, ...(options?.signal === undefined ? {} : { signal: options.signal }) }))
    let transport: PhysicalTargetedTransport
    try {
      transport = await buildTransport(udid, { signal, hardwareUdid })
    } catch (error) {
      if (cancelled()) {
        return rejected('CANCELLED', 'operation was cancelled before mutation')
      }
      const detail = typeof error === 'object' && error !== null && 'detail' in error && typeof (error as { detail?: unknown }).detail === 'string'
        ? (error as { detail: string }).detail
        : undefined
      return rejected('TRANSPORT_UNAVAILABLE', 'the owned one-shot loopback transport to device WDA could not be created; no mutation was dispatched', {
        capability: 'physical.targeted.transport.unavailable',
        reason: 'the owned one-shot loopback transport to device WDA could not be created; no mutation was dispatched',
        ...(detail === undefined ? {} : { prerequisite: detail }),
      })
    }

    const clientTarget: WdaTargetedTextTarget = {
      udid,
      bundleId,
      ...(target.identifier === undefined ? {} : { identifier: target.identifier }),
      ...(target.semantic === undefined ? {} : { semantic: { label: target.semantic.label, type: target.semantic.type } }),
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      mode,
      text: target.text,
      expectedPID,
      ...(target.secure === undefined ? {} : { secure: target.secure }),
      ...(signal === undefined ? {} : { signal }),
    }
    const environment: WdaTargetedTextEnvironment = {
      transport: {
        // The transport's OWN udid (not the target's): the client's udid
        // equality guard must keep its teeth on the physical path too.
        udid: transport.udid,
        request: (method, path, body, options) => transport.request(method, path, body, options),
      },
      readAppIdentity: async (deviceUdid, options) => {
        try {
          const fresh = await readIdentity(deviceUdid, { bundleId, expectedPID }, options)
          if (!fresh.verified || fresh.bundleId === undefined || fresh.pid === undefined) {
            return { bundleId: '', pid: -1, verified: false }
          }
          // The client enforces the pin: fresh bundle + fresh pid must equal
          // the pre-setup sample; any drift rejects before mutation.
          return { bundleId: fresh.bundleId, pid: fresh.pid, verified: true }
        } catch {
          return { bundleId: '', pid: -1, verified: false }
        }
      },
    }

    let clientResult: WdaTargetedTextResult
    let cleanupFailure: unknown
    try {
      clientResult = await performWdaTargetedText(clientTarget, environment)
    } finally {
      try {
        await transport.dispose()
      } catch (error) {
        cleanupFailure = error
      }
    }

    const result: IosQaTargetedTextResult = {
      udid,
      backend: 'physical',
      action,
      mode,
      status: clientResult.status,
      dispatched: clientResult.dispatched,
      nativeAccepted: clientResult.nativeAccepted,
    }
    if (clientResult.code !== undefined) result.code = clientResult.code
    if (clientResult.reason !== undefined) result.reason = clientResult.reason
    if (cleanupFailure !== undefined) {
      result.transportCleanup = {
        ok: false,
        reason: 'the owned one-shot transport cleanup could not be proven (the loopback forward may still exist)',
      }
    }
    return result
  }

  async #ensureInputRuntime(udid: string, signal?: AbortSignal): Promise<WdaSimulatorConnection> {
    if (this.#injectedInputRuntime !== undefined) {
      return this.#injectedInputRuntime.ensure(udid, { signal })
    }
    if (this.#ownedInputRuntime === undefined) {
      this.#ownedInputRuntime = this.#wdaInputRuntimeFactory()
    }
    return this.#ownedInputRuntime.ensure(udid, { signal })
  }

  /**
   * Translate a failed safe-input-runtime cleanup into a sanitized typed
   * driver error. The returned error carries a stable code and a safe message
   * with no native/transport error body and no underlying internal detail
   * (file paths, vendor logs) echoed to the QA caller. BUSY from the runtime
   * is preserved semantically so cleanup-failure is visible to the adapter.
   */
  #cleanupError(error: unknown, phase: 'release' | 'dispose'): IosQaError {
    const codeOf = (candidate: unknown): unknown =>
      candidate !== null && typeof candidate === 'object' && 'code' in candidate
        ? (candidate as { code?: unknown }).code
        : undefined
    const runtimeCode = codeOf(error)
    const busy = runtimeCode === 'BUSY'
    const stableCode = phase === 'release'
      ? (busy ? 'input-runtime.busy' : 'input-runtime.release-failed')
      : (busy ? 'input-runtime.dispose-busy' : 'input-runtime.dispose-failed')
    return new IosQaError(
      busy
        ? `dsh-ios qa: ${phase} could not prove safe input-runtime cleanup for a device (BUSY artifacts remain; no orphan will be reused)`
        : `dsh-ios qa: ${phase} of the owned safe input runtime failed without a clean proof`,
      stableCode,
    )
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  async #describeSimulator(udid: string, signal?: AbortSignal): Promise<AxeElement[]> {
    const resolver = this.#axeResolver
    const describe = async (): Promise<AxeElement[]> => {
      if (resolver === undefined) {
        const resolved = resolveAxeBinary()
        const binary = resolved.available ? resolved : await ensureAxeBinary()
        if (!binary.available || binary.command === undefined) {
          throw new IosQaError(`AXe is unavailable${binary.reason === undefined ? '' : ` (${binary.reason})`}`, 'simulator.axe.unavailable')
        }
        return describeUi(binary, udid, signal)
      }
      if (typeof resolver === 'function') {
        if (resolver.length >= 1) {
          const roots = await (resolver as (deviceUdid: string, abortSignal?: AbortSignal) => Promise<AxeElement[]>)(udid, signal)
          if (!Array.isArray(roots)) throw new TypeError('dsh-ios qa: axe describe-ui injection must resolve to an array of AXe roots')
          return roots
        }
        const value = await (resolver as () => Promise<AxeBinary | AxeElement[]>)()
        if (Array.isArray(value)) return value
        const binary = value
        if (!isAxeBinary(binary) || !binary.available || binary.command === undefined) {
          throw new IosQaError('AXe binary resolver did not provide an available binary', 'simulator.axe.unavailable')
        }
        return describeUi(binary, udid, signal)
      }
      if (!isAxeBinary(resolver) || !resolver.available || resolver.command === undefined) {
        throw new IosQaError('the provided AXe binary is unavailable', 'simulator.axe.unavailable')
      }
      return describeUi(resolver, udid, signal)
    }
    const usable = (roots: readonly AxeElement[]): boolean => roots.some(root => root.children.length > 0 || root.frame.w > 0 || root.frame.h > 0 || (typeof root.label === 'string' && root.label.trim() !== '') || (typeof root.identifier === 'string' && root.identifier.trim() !== ''))
    signal?.throwIfAborted()
    let roots = await describe()
    for (let attempt = 1; !usable(roots) && attempt < AXE_REREAD_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, AXE_REREAD_DELAY_MS))
      signal?.throwIfAborted()
      roots = await describe()
    }
    if (!usable(roots) && !this.#axeRecoveryLeases.has(udid)) {
      // A bounded empty-tree reread is the only recovery trigger. Acquire one
      // lease from this backend's own safe input runtime, then take one fresh
      // AX snapshot. This does not restart apps/system services or reuse an
      // unrelated runner; releaseDevice/dispose owns the lease cleanup.
      signal?.throwIfAborted()
      await this.#ensureInputRuntime(udid, signal)
      this.#axeRecoveryLeases.add(udid)
      signal?.throwIfAborted()
      roots = await describe()
    }
    if (!usable(roots)) throw new IosQaError('AXe returned an incomplete simulator accessibility tree; retry after the simulator accessibility service recovers', 'simulator.axe.incomplete')
    return roots
  }

  async #resolveKind(udid: string, signal?: AbortSignal): Promise<IosQaDeviceKind> {
    let isSim = false
    try {
      if (this.#simDevices.matches !== undefined) {
        isSim = await this.#simDevices.matches(udid, signal)
      } else {
        const devices = await this.#simDevices.list(signal)
        isSim = devices.some(device => device.udid === udid)
      }
    } catch {
      isSim = false
    }
    if (isSim) return 'simulator'
    let isReal = false
    try {
      if (this.#realDevices.matches !== undefined) {
        isReal = await this.#realDevices.matches(udid, signal)
      } else {
        const devices = await this.#realDevices.list(signal)
        isReal = devices.some(device => device.udid === udid)
      }
    } catch {
      isReal = false
    }
    if (isReal) return 'physical'
    throw new IosQaError(`unknown device udid "${udid}" — it matches neither a known simulator nor a connected physical device`, 'unknown-device')
  }

  /**
   * Start/ensure the serve-sim stream for the requested simulator and hold
   * one consumer lease for the duration of the control call. Explicit
   * devices are respected by `ensureRunning`; adopted/user-owned servers are
   * reused. The lease is always released in `finally`, including on error.
   */
  async #withSimLease<T>(udid: string, task: (info: SimStreamInfo) => Promise<T>): Promise<T> {
    const info = await this.#sim.ensureRunning({ udid })
    const release = this.#sim.acquire === undefined ? () => {} : this.#sim.acquire()
    try {
      return await task(info)
    } finally {
      release()
    }
  }

  async #simulatorPointSize(udid: string): Promise<{ width: number; height: number }> {
    try {
      const roots = await this.#describeSimulator(udid)
      return screenSize(roots)
    } catch (error) {
      throw new IosQaError(`AXe point-size resolution failed: ${errorMessage(error)}`, 'unsupported.simulator.point-size.unavailable')
    }
  }

  async #requireWda(udid: string, signal?: AbortSignal): Promise<WdaControllerLike> {
    if (this.#wda === undefined) {
      let resolution: SigningTeamResolution
      try {
        resolution = await this.#resolveSigningTeam({
          explicit: this.#wdaOptions.teamId,
          env: process.env.DSH_IOS_TEAM_ID,
          fallback: undefined,
          signal,
        })
      } catch (error) {
        throw new IosQaError(`unable to resolve WebDriverAgent signing team: ${errorMessage(error)}`, 'unsupported.wda.signing-team.unavailable')
      }
      if (resolution.teamId === undefined || resolution.teamId.trim() === '' || resolution.source === 'none') {
        throw new IosQaError(
          'WebDriverAgent signing team is not configured; set DSH_IOS_TEAM_ID or provide wdaOptions.teamId',
          'unsupported.wda.signing-team.unconfigured',
        )
      }
      let projectDir = optionalString(this.#wdaOptions.projectDir)
      if (projectDir === undefined) {
        try {
          projectDir = (await this.#stagePhysicalWda()).stageDir
        } catch (error) {
          if (error instanceof PhysicalWdaStageError) {
            const code = error.code === 'PATCH_FAILED'
              ? 'unsupported.wda.source.patch-failed'
              : 'unsupported.wda.source.unavailable'
            throw new IosQaError(error.message, code)
          }
          throw new IosQaError(`unable to stage the private WebDriverAgent source: ${errorMessage(error)}`, 'unsupported.wda.source.unavailable')
        }
      }
      this.#wda = this.#wdaFactory({
        ...this.#wdaOptions,
        teamId: resolution.teamId,
        wdaProjectDir: projectDir,
        adoptExisting: this.#wdaOptions.adoptExisting ?? false,
      })
      this.#wdaCreatedByBackend = true
    }
    if (this.#hasWdaSigning === false && this.#wda !== undefined && this.#ownsWda === false) {
      throw new IosQaError(
        'WebDriverAgent signing team is not configured; set DSH_IOS_TEAM_ID or provide wdaOptions.teamId',
        'unsupported.wda.signing-team.unconfigured',
      )
    }
    try {
      if (this.#wdaCreatedByBackend) this.#ownedWdaBinding = { logicalUdid: udid, hardwareUdid: udid }
      const running = await this.#wda.ensureRunning({ udid })
      if (this.#wdaCreatedByBackend) {
        // WdaController owns one active runner at a time. Replace the prior
        // binding so releasing an older device cannot stop the newer runner.
        this.#ownedWdaDevices.clear()
        this.#ownedWdaDevices.set(udid, { hardwareUdid: running.hardwareUdid })
        this.#ownedWdaDevices.set(running.udid, { hardwareUdid: running.hardwareUdid })
        this.#ownedWdaDevices.set(running.hardwareUdid, { hardwareUdid: running.hardwareUdid })
        this.#ownedWdaBinding = { logicalUdid: running.udid, hardwareUdid: running.hardwareUdid }
      }
    } catch (error) {
      if (error instanceof WdaError) {
        const code = error.reason === 'wda-already-running'
          ? 'unsupported.wda.already-running'
          : error.reason === 'unavailable'
            ? 'unsupported.wda.tooling.unavailable'
            : 'wda.start-failed'
        throw new IosQaError(`WebDriverAgent is not running for ${udid}: ${error.message}`, code)
      }
      throw new IosQaError(`WebDriverAgent is not running for ${udid}: ${errorMessage(error)}`, 'wda.start-failed')
    }
    return this.#wda
  }

  async #wdaPointSize(wda: WdaControllerLike): Promise<{ width: number; height: number }> {
    return wda.control.windowSize()
  }

  async #wdaAppIdentity(wda: WdaControllerLike): Promise<IosQaAppIdentity> {
    const control = wda.control as WdaControllerLike['control'] & { activeAppInfo?: () => Promise<{ pid?: number; bundleId?: string; name?: string }> }
    if (control.activeAppInfo === undefined) {
      return { verified: false }
    }
    try {
      const info = await control.activeAppInfo()
      const pid = typeof info.pid === 'number' && Number.isSafeInteger(info.pid) ? info.pid : undefined
      const bundleId = optionalString(info.bundleId)
      const name = optionalString(info.name)
      return {
        ...(pid === undefined ? {} : { pid }),
        ...(bundleId === undefined ? {} : { bundleId }),
        ...(name === undefined ? {} : { name }),
        verified: bundleId !== undefined || name !== undefined || pid !== undefined,
      }
    } catch {
      return { verified: false }
    }
  }

  /**
   * Shared simulator foreground verifier. It takes the ORIGINAL AXe roots
   * already captured by the caller and verifies that their PID still maps
   * EXACTLY to one launchctl UIKitApplication entry. This is used by both
   * `observe()` (so an observation cannot label an old tree with a new app)
   * and `foregroundApp()` (for the actual frontmost-app answer).
   */
  async #simulatorForeground(udid: string, roots: readonly AxeElement[], signal?: AbortSignal): Promise<IosQaSimulatorForegroundResult> {
    const root = roots.find(item => item.type === 'Application') ?? roots[0]
    const rootPid = root?.pid
    const rootName = root?.label
    if (typeof rootPid !== 'number' || !Number.isSafeInteger(rootPid)) {
      return {
        ...(rootName === undefined ? {} : { name: rootName }),
        verified: false,
        capability: 'simulator.foreground-app.unavailable',
        reason: 'the AXe tree did not expose an application pid; the frontmost bundle cannot be verified',
      }
    }
    const pid = rootPid
    if (this.#simForegroundApp !== undefined) {
      const resolved = await this.#simForegroundApp(udid, pid, signal)
      if (resolved.verified && resolved.pid !== undefined && resolved.pid !== pid) {
        return {
          ...(resolved.bundleId === undefined ? {} : { bundleId: resolved.bundleId }),
          ...(rootName === undefined ? {} : { name: rootName }),
          pid,
          verified: false,
          capability: 'simulator.foreground-app.ambiguous',
          reason: `the foreground verifier returned pid ${resolved.pid}, but the captured AXe tree has pid ${pid}`,
        }
      }
      return {
        ...(resolved.bundleId === undefined ? {} : { bundleId: resolved.bundleId }),
        name: resolved.name ?? rootName,
        pid: resolved.pid ?? pid,
        verified: resolved.verified,
        ...(resolved.capability === undefined ? {} : { capability: resolved.capability }),
        ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
        ...(resolved.prerequisite === undefined ? {} : { prerequisite: resolved.prerequisite }),
      }
    }
    try {
      const entries = await launchctlUIKitForUdid(udid, signal)
      const matches = entries.filter(entry => entry.pid === pid)
      if (matches.length === 0) {
        return {
          ...(rootName === undefined ? {} : { name: rootName }),
          pid,
          verified: false,
          capability: 'simulator.foreground-app.unavailable',
          reason: `AXe pid ${pid} did not exactly match a UIKitApplication launchctl entry`,
          prerequisite: 'retry after the app settles; ambiguity is not treated as proof',
        }
      }
      if (matches.length > 1) {
        return {
          ...(rootName === undefined ? {} : { name: rootName }),
          pid,
          verified: false,
          capability: 'simulator.foreground-app.ambiguous',
          reason: `AXe pid ${pid} matched ${matches.length} launchctl UIKitApplication entries`,
        }
      }
      return {
        bundleId: matches[0].bundleId,
        ...(rootName === undefined ? {} : { name: rootName }),
        pid,
        verified: true,
      }
    } catch (error) {
      return {
        ...(rootName === undefined ? {} : { name: rootName }),
        pid,
        verified: false,
        capability: 'simulator.foreground-app.unavailable',
        reason: errorMessage(error),
      }
    }
  }

  #appIdentityFromResolution(resolved: IosQaSimulatorForegroundResult): IosQaAppIdentity {
    return {
      ...(resolved.bundleId === undefined ? {} : { bundleId: resolved.bundleId }),
      ...(resolved.name === undefined ? {} : { name: resolved.name }),
      ...(resolved.pid === undefined ? {} : { pid: resolved.pid }),
      verified: resolved.verified,
    }
  }

  #foregroundFromResolution(udid: string, kind: IosQaDeviceKind, resolved: IosQaSimulatorForegroundResult): IosQaForeground {
    const app = this.#appIdentityFromResolution(resolved)
    if (resolved.verified) return { udid, backend: kind, app }
    return {
      udid,
      backend: kind,
      app,
      unsupported: {
        capability: resolved.capability ?? 'simulator.foreground-app.unavailable',
        reason: resolved.reason ?? 'the simulator foreground app could not be verified',
        ...(resolved.prerequisite === undefined ? {} : { prerequisite: resolved.prerequisite }),
      },
    }
  }

  #validMaxNodes(value: number | undefined): number {
    if (value === undefined) return DEFAULT_MAX_NODES
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`dsh-ios qa: maxNodes must be a positive integer, got ${String(value)}`)
    }
    return value
  }

  #ok(kind: IosQaDeviceKind, udid: string, action: string): IosQaActionResult {
    return { ok: true, udid, backend: kind, action }
  }

  #unsupported(kind: IosQaDeviceKind, udid: string, action: string, capability: string, reason: string, prerequisite?: string): IosQaActionResult {
    return {
      ok: false,
      udid,
      backend: kind,
      action,
      unsupported: {
        capability,
        reason,
        ...(prerequisite === undefined ? {} : { prerequisite }),
      },
    }
  }

  #unsupportedResultFromError(kind: IosQaDeviceKind, udid: string, action: string, error: IosQaError): IosQaActionResult {
    const code = error.code ?? 'unsupported.backend'
    const cap = code.replace(/^unsupported\./u, '')
    return this.#unsupported(kind, udid, action, cap, error.message)
  }
}
