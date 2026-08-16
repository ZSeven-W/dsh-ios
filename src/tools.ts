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
  defineTool,
  type JsonValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { closeSync, mkdirSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRun,
  detectProject,
  type BuildRunResult,
} from './build-run.js'
import type { SimHostController } from './sim-host.js'
import {
  bootDevice,
  bootedDevices,
  compareRuntimesDesc,
  getDevice,
  listDevices,
  shutdownDevice,
  takeScreenshot,
  type SimulatorDevice,
} from './simctl.js'

/** Registered tool names, in registration order. */
export const IOS_TOOL_NAMES = [
  'ios_sim_devices',
  'ios_sim_boot',
  'ios_sim_shutdown',
  'ios_sim_screenshot',
  'ios_sim_interact',
  'ios_sim_build_run',
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
  action: 'tap' | 'type' | 'button' | 'gesture'
  path: string
  bytes: number
  width?: number
  height?: number
  device: SimDeviceInfo
}

export interface SimBuildRunResult extends BuildRunResult {}

export interface SimInteractArgs {
  action: 'tap' | 'type' | 'button' | 'gesture'
  x?: number
  y?: number
  text?: string
  name?: string
  json?: JsonValue
}

export interface SimToolsOptions {
  /** Plugin-owned cache root for screenshots and builds (default `<tmp>/dsh-ios`). */
  cacheDir?: string
}

/** The six tool definitions bound to one sim host controller. */
export interface SimTools {
  iosSimDevices: ToolDefinition
  iosSimBoot: ToolDefinition
  iosSimShutdown: ToolDefinition
  iosSimScreenshot: ToolDefinition
  iosSimInteract: ToolDefinition
  iosSimBuildRun: ToolDefinition
}

/** Error prefix required on non-macOS/unavailable hosts. */
const SIMULATOR_UNAVAILABLE = 'iOS Simulator requires macOS with Xcode'

/** Settle delay after an interaction, before the effect screenshot. */
const INTERACT_SETTLE_MS = 300

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
    const path = join(this.#root, `screenshot-${safe}-${next}.png`)
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

/** Map a validated interact call to serve-sim control arguments. */
function interactControlArgs(args: SimInteractArgs): string[] {
  switch (args.action) {
    case 'tap': {
      if (typeof args.x !== 'number' || typeof args.y !== 'number' || !Number.isFinite(args.x) || !Number.isFinite(args.y)) {
        throw new Error('ios_sim_interact: action "tap" requires numeric x and y (normalized 0..1)')
      }
      if (args.x < 0 || args.x > 1 || args.y < 0 || args.y > 1) {
        throw new Error(`ios_sim_interact: tap x/y must be within 0..1, got x=${args.x} y=${args.y}`)
      }
      return ['tap', String(args.x), String(args.y)]
    }
    case 'type': {
      if (typeof args.text !== 'string' || args.text === '') {
        throw new Error('ios_sim_interact: action "type" requires a non-empty text')
      }
      return ['type', args.text]
    }
    case 'button': {
      if (typeof args.name !== 'string' || args.name.trim() === '') {
        throw new Error('ios_sim_interact: action "button" requires a button name, e.g. "home"')
      }
      return ['button', args.name.trim()]
    }
    case 'gesture': {
      if (typeof args.json !== 'object' || args.json === null || Array.isArray(args.json)) {
        throw new Error('ios_sim_interact: action "gesture" requires a json object, e.g. {"type":"begin","x":0.5,"y":0.5}')
      }
      return ['gesture', JSON.stringify(args.json)]
    }
  }
}

/** Create the six `ios_sim_*` tool definitions bound to one controller. */
export function createSimTools(host: SimHostController, options: SimToolsOptions = {}): SimTools {
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'dsh-ios')
  const screenshots = new ScreenshotStore(cacheDir)

  const iosSimDevices = defineTool({
    name: 'ios_sim_devices',
    description: 'List the iOS Simulator devices available on this Mac (udid, name, runtime, state). '
      + 'Use this to discover the udid or name to pass to the other ios_sim_* tools.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          devices: { type: 'array', required: true, items: deviceSchema },
          count: { type: 'integer', required: true },
          booted: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(_args: unknown, _exec) {
      assertSimulatorAvailable(host)
      const devices = await listDevices()
      const booted = devices.filter(device => device.state === 'Booted').map(device => device.udid)
      return { devices, count: devices.length, booted } satisfies SimDevicesResult
    },
    presentCall: () => ({ card: 'generic', title: 'List iOS simulators' }),
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
    async execute(args: { udid: string }, _exec) {
      assertSimulatorAvailable(host)
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
    async execute(args: { udid: string }, _exec) {
      assertSimulatorAvailable(host)
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
    description: 'Capture a PNG screenshot of a booted iOS Simulator and return a small JSON '
      + 'summary (path, bytes, device). The image itself reaches the UI through the tool card, '
      + 'never as an image block in the result.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name. Defaults to the currently streamed '
          + 'device, else the first booted simulator.',
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
    timeoutMs: 120_000,
    async execute(args: { udid?: string }, exec) {
      assertSimulatorAvailable(host)
      const device = await resolveTargetDevice(host, args.udid)
      return captureScreenshot(screenshots, device.udid, exec.signal)
    },
    presentCall: (args: { udid?: string }) => ({
      card: 'generic',
      title: args.udid === undefined ? 'Screenshot simulator' : `Screenshot ${args.udid}`,
      kind: 'execute',
    }),
  })

  const iosSimInteract = defineTool({
    name: 'ios_sim_interact',
    description: 'Interact with the streamed iOS Simulator: tap at normalized 0..1 coordinates, '
      + 'type text (US keyboard), press a hardware button (e.g. "home"), or send a touch gesture. '
      + 'After the action settles (~300 ms) a fresh screenshot is captured and returned with the '
      + 'same summary shape as ios_sim_screenshot, so the effect of the interaction is visible. '
      + 'Requires a live stream: call ios_sim_boot first.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['tap', 'type', 'button', 'gesture'],
        description: 'Interaction to send to the streamed simulator.',
      },
      x: { type: 'number', description: 'Tap X position, normalized 0..1 (required when action is "tap").' },
      y: { type: 'number', description: 'Tap Y position, normalized 0..1 (required when action is "tap").' },
      text: { type: 'string', description: 'Text to type on the US keyboard (required when action is "type").' },
      name: { type: 'string', description: 'Hardware button name, e.g. "home", "lock", "volumeUp" (required when action is "button").' },
      json: { type: 'json', description: 'Gesture JSON, e.g. {"type":"begin","x":0.5,"y":0.5} (required when action is "gesture").' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['tap', 'type', 'button', 'gesture'] },
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
    timeoutMs: 180_000,
    async execute(args: SimInteractArgs, exec) {
      assertSimulatorAvailable(host)
      const payload = interactControlArgs(args)
      const device = await streamedDevice(host)
      try {
        await host.control([payload[0], '-d', device.udid, ...payload.slice(1)])
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
            : { gesture: args.json },
    }),
  })

  const iosSimBuildRun = defineTool({
    name: 'ios_sim_build_run',
    description: 'Build an Xcode project (.xcodeproj), workspace (.xcworkspace), or Swift package '
      + 'directory for the iOS Simulator, install the built .app on the simulator, and launch it. '
      + 'On build failure the result contains the tail of the xcodebuild output with the actionable '
      + 'compiler errors. Takes minutes for a full build.',
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
        description: 'Target simulator udid or device name. Defaults to the currently streamed device, '
          + 'else a booted simulator, else the newest-runtime iPhone (which is booted).',
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
      assertSimulatorAvailable(host)
      const target = detectProject(args.projectPath)
      const device = await resolveTargetDevice(host, args.udid, { bootFallback: true })
      // simctl install/launch need a booted device; boot is idempotent when
      // the fallback above already booted it.
      await bootDevice(device.udid)
      const configuration = args.configuration !== undefined && args.configuration.trim() !== ''
        ? args.configuration.trim()
        : 'Debug'
      return buildRun({
        target,
        scheme: args.scheme,
        configuration,
        device,
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

  return {
    iosSimDevices,
    iosSimBoot,
    iosSimShutdown,
    iosSimScreenshot,
    iosSimInteract,
    iosSimBuildRun,
  }
}
