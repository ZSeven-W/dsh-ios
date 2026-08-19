/**
 * Common host-facing stream contract shared by the simulator and real-device
 * hosts, so the web routes and the panel never care where pixels come from.
 *
 * Both hosts are exposed through this contract:
 * - `SimHostController` → `SimStreamSource` (serve-sim MJPEG + CLI control);
 * - `WdaController` → `WdaStreamSource` (WebDriverAgent MJPEG tunnel + REST
 *   control).
 *
 * Coordinate contract: `control.tap(x, y)` and `control.drag(...)` take
 * NORMALIZED 0..1 coordinates of the streamed frame (the panel's canvas
 * space). Each adapter maps those onto its backend's native space:
 * - serve-sim gestures are already normalized (0..1 of the simulator screen);
 * - WDA gestures take absolute POINT coordinates, so `WdaStreamSource`
 *   multiplies by the current window size (`GET /window/size`).
 *
 * The sim adapter only wraps the existing controller — `sim-host.ts` itself
 * is untouched, and every `SimStreamSource` call delegates straight through.
 * @module @zseven-w/dsh-ios/stream-source
 */

import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APP_SWITCHER_DRAG_DURATION_S,
  APP_SWITCHER_FROM_Y,
  APP_SWITCHER_TO_Y,
} from './app-switcher.js'
import { runSimulatorDeviceAction, type DeviceAction } from './device-actions.js'
import { takeScreenshot } from './simctl.js'
import type { SimHostController, SimStreamInfo } from './sim-host.js'

/** Which backend a stream source fronts. */
export type StreamSourceKind = 'simulator' | 'real-device'

/** Normalized point (0..1) in the streamed frame. */
export interface StreamPoint {
  x: number
  y: number
}

/** Normalized drag gesture in the streamed frame (0..1). */
export interface StreamDrag {
  fromX: number
  fromY: number
  toX: number
  toY: number
  /** Gesture duration in seconds (default 0.3). */
  duration?: number
}

/** A captured frame: base64 PNG plus its pixel size when known. */
export interface StreamScreenshot {
  pngBase64: string
  width?: number
  height?: number
}

/** Panel-facing control surface; coordinates are normalized 0..1. */
export interface StreamControl {
  /** Tap at normalized 0..1 coordinates of the streamed frame. */
  tap(x: number, y: number): Promise<void>
  /** Drag between normalized 0..1 coordinates. */
  drag(drag: StreamDrag): Promise<void>
  /** Press a hardware button; default `home`. */
  button(name?: string): Promise<void>
  /** Type text into the focused element. */
  type(text: string): Promise<void>
  /** Set the device orientation (backend-specific value); may be absent. */
  rotate?(orientation: string): Promise<void>
  /**
   * Run a device-level action (App Switcher, lock/unlock, shake, Siri, …).
   * Optional because the two backends cover different subsets — see
   * device-actions.ts for the table and how each one is delivered.
   */
  deviceAction?(action: DeviceAction): Promise<void>
  /** Capture the current frame as base64 PNG. */
  screenshot(): Promise<StreamScreenshot>
  /** Accessibility tree snapshot (backend-specific text); may be absent. */
  uiTree?(): Promise<string>
}

/** What `ensureRunning` reports for one stream source. */
export interface StreamSourceInfo {
  udid: string
  /** MJPEG stream URL the panel proxies. */
  mjpegUrl?: string
  /** Control-plane base URL (serve-sim HTTP / WDA REST). */
  controlUrl?: string
  /** Backend session identifier (WDA sessions only). */
  sessionId?: string
  /** Hardware udid for real devices (xcodebuild/iproxy form). */
  hardwareUdid?: string
}

/** Common status view for both kinds; host-specific detail stays host-side. */
export interface StreamSourceStatus {
  kind: StreamSourceKind
  available: boolean
  running: boolean
  device?: string
  consumers: number
  lastError?: string
  mjpegUrl?: string
  controlUrl?: string
}

/**
 * The common interface both hosts satisfy (via the adapters in this module).
 * Routes/panel call `ensureRunning`, hold a consumer through `acquire()`,
 * proxy `mjpegUrl`, and drive `control` — identical shape for both kinds.
 */
export interface StreamSource {
  readonly kind: StreamSourceKind
  ensureRunning(udid: string): Promise<StreamSourceInfo>
  status(): StreamSourceStatus
  stop(): Promise<void>
  /** Hold the stream for one consumer; the returned function releases it. */
  acquire(): () => void
  /** Release the most recent `acquire()` (stack semantics). */
  release(): void
  /** Current MJPEG stream URL, when running. */
  readonly mjpegUrl: string | undefined
  readonly control: StreamControl
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function requireNormalized(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new RangeError('dsh-ios: tap/drag coordinates must be normalized 0..1 of the streamed frame')
  }
}

/** Pixel size of a PNG from its IHDR chunk, without decoding the image. */
export function pngDimensionsFromBase64(base64: string): { width: number; height: number } | undefined {
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length < 24) return undefined
  if (buffer.readUInt32BE(0) !== 0x89504e47) return undefined // \x89PNG
  if (buffer.readUInt32BE(12) !== 0x49484452) return undefined // 'IHDR'
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Thin `StreamSource` adapter over `SimHostController`. Nothing about the sim
 * host changes: launches, the refcount, keep-alive and stop semantics are all
 * delegated one-to-one, and serve-sim's own CLI is used for control.
 */
export class SimStreamSource implements StreamSource {
  readonly kind = 'simulator' as const
  #lastInfo: SimStreamInfo | undefined
  #releases: Array<() => void> = []

  constructor(private readonly host: SimHostController) {}

  get mjpegUrl(): string | undefined {
    if (this.#lastInfo !== undefined) return this.#lastInfo.streamUrl
    const status = this.host.status()
    if (status.running && status.port !== undefined) {
      // serve-sim helpers bind 127.0.0.1; derive the MJPEG route from the port.
      return `http://127.0.0.1:${status.port}/stream.mjpeg`
    }
    return undefined
  }

  async ensureRunning(udid: string): Promise<StreamSourceInfo> {
    const info = await this.host.ensureRunning({ udid })
    this.#lastInfo = info
    return { udid: info.device, mjpegUrl: info.streamUrl, controlUrl: info.url }
  }

  status(): StreamSourceStatus {
    const status = this.host.status()
    return {
      kind: this.kind,
      available: status.available,
      running: status.running,
      ...(status.device === undefined ? {} : { device: status.device }),
      consumers: status.consumers,
      ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
      ...(this.mjpegUrl === undefined ? {} : { mjpegUrl: this.mjpegUrl }),
      ...(this.#lastInfo === undefined ? {} : { controlUrl: this.#lastInfo.url }),
    }
  }

  stop(): Promise<void> {
    return this.host.stop()
  }

  acquire(): () => void {
    const release = this.host.acquire()
    this.#releases.push(release)
    let released = false
    return () => {
      if (released) return
      released = true
      const index = this.#releases.indexOf(release)
      if (index >= 0) this.#releases.splice(index, 1)
      release()
    }
  }

  release(): void {
    this.#releases.pop()?.()
  }

  readonly control: StreamControl = {
    tap: async (x, y) => {
      requireNormalized(x, y)
      await this.#run(['tap', String(x), String(y)])
    },
    drag: async drag => {
      requireNormalized(drag.fromX, drag.fromY)
      requireNormalized(drag.toX, drag.toY)
      const holdMs = Math.min(2_000, Math.max(20, Math.round((drag.duration ?? 0.3) * 500)))
      // serve-sim's `gesture` CLI sends one WS gesture frame per call; a drag
      // is begin → move → end with the requested press duration in between.
      await this.#run(['gesture', JSON.stringify({ type: 'begin', x: drag.fromX, y: drag.fromY })])
      await sleep(holdMs)
      await this.#run(['gesture', JSON.stringify({ type: 'move', x: drag.toX, y: drag.toY })])
      await sleep(holdMs)
      await this.#run(['gesture', JSON.stringify({ type: 'end', x: drag.toX, y: drag.toY })])
    },
    button: async (name = 'home') => {
      await this.#run(['button', name])
    },
    type: async text => {
      if (typeof text !== 'string' || text === '') throw new TypeError('dsh-ios: type requires a non-empty text')
      await this.#run(['type', text])
    },
    rotate: async orientation => {
      await this.#run(['rotate', orientation])
    },
    deviceAction: action => runSimulatorDeviceAction(
      action,
      async name => { await this.#run(['button', name]) },
    ),
    screenshot: async () => {
      const udid = this.#requireDevice()
      const path = join(tmpdir(), `dsh-ios-stream-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
      try {
        await takeScreenshot(udid, path)
        const pngBase64 = readFileSync(path).toString('base64')
        const size = pngDimensionsFromBase64(pngBase64)
        return { pngBase64, ...(size === undefined ? {} : size) }
      } catch (error) {
        throw new Error(`dsh-ios: the simulator screenshot failed: ${errorMessage(error)}`)
      } finally {
        try {
          unlinkSync(path)
        } catch {
          // Temp file cleanup is best effort.
        }
      }
    },
  }

  async #run(args: readonly string[]): Promise<void> {
    const udid = this.#requireDevice()
    await this.host.control([...args, '-d', udid])
  }

  #requireDevice(): string {
    const udid = this.host.status().device ?? this.#lastInfo?.device
    if (udid === undefined) {
      throw new Error('dsh-ios: no simulator is streaming; call ensureRunning first')
    }
    return udid
  }
}

/**
 * Structural view of `WdaController` used by the adapter below. Declared here
 * (instead of importing wda-host.ts) so this module stays decoupled from the
 * real-device host; `WdaController` satisfies it as-is.
 */
export interface WdaControllerLike {
  ensureRunning(input: { udid: string }): Promise<{
    udid: string
    hardwareUdid: string
    controlUrl: string
    mjpegUrl: string
    sessionId: string
  }>
  status(): {
    available: boolean
    running: boolean
    device?: string
    controlUrl?: string
    mjpegUrl?: string
    sessionId?: string
    consumers: number
    lastError?: string
  }
  stop(): Promise<void>
  acquire(): () => void
  release(): void
  readonly mjpegUrl: string | undefined
  readonly control: {
    pressButton(name: string): Promise<void>
    /** Absolute POINT coordinates (WDA `/wda/tap` contract). */
    tap(x: number, y: number): Promise<void>
    /** Absolute POINT coordinates + duration in seconds. */
    dragFromToForDuration(drag: { fromX: number; fromY: number; toX: number; toY: number; duration: number }): Promise<void>
    typeText(text: string): Promise<void>
    setOrientation(orientation: string): Promise<void>
    screenshot(): Promise<{ pngBase64: string; width?: number; height?: number }>
    source(): Promise<string>
    setSnapshotDepth(depth: number): Promise<void>
    /** Active application size in POINTS (the WDA gesture coordinate space). */
    windowSize(): Promise<{ width: number; height: number }>
  }
}

/**
 * How long the active app's point size may be reused for gesture mapping.
 * Short enough that a human cannot rotate the phone and land a tap inside
 * the window, long enough that a burst of taps/drags pays the ~250 ms
 * `GET /window/size` once instead of once (or twice) per gesture.
 */
export const WDA_WINDOW_SIZE_TTL_MS = 1200

/**
 * Thin `StreamSource` adapter over `WdaController`: normalized panel
 * coordinates are multiplied by the live window size (points) into the
 * absolute point coordinates WDA's `/wda/tap` and `/wda/dragfromtoforduration`
 * expect.
 */
export class WdaStreamSource implements StreamSource {
  readonly kind = 'real-device' as const

  constructor(private readonly wda: WdaControllerLike) {}

  get mjpegUrl(): string | undefined {
    return this.wda.mjpegUrl
  }

  async ensureRunning(udid: string): Promise<StreamSourceInfo> {
    const info = await this.wda.ensureRunning({ udid })
    return {
      udid: info.udid,
      hardwareUdid: info.hardwareUdid,
      mjpegUrl: info.mjpegUrl,
      controlUrl: info.controlUrl,
      sessionId: info.sessionId,
    }
  }

  status(): StreamSourceStatus {
    const status = this.wda.status()
    return {
      kind: this.kind,
      available: status.available,
      running: status.running,
      ...(status.device === undefined ? {} : { device: status.device }),
      consumers: status.consumers,
      ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
      ...(status.mjpegUrl === undefined ? {} : { mjpegUrl: status.mjpegUrl }),
      ...(status.controlUrl === undefined ? {} : { controlUrl: status.controlUrl }),
    }
  }

  stop(): Promise<void> {
    return this.wda.stop()
  }

  acquire(): () => void {
    return this.wda.acquire()
  }

  release(): void {
    this.wda.release()
  }

  readonly control: StreamControl = {
    tap: async (x, y) => {
      requireNormalized(x, y)
      const point = await this.#absolute(x, y)
      await this.wda.control.tap(point.x, point.y)
    },
    drag: async drag => {
      requireNormalized(drag.fromX, drag.fromY)
      requireNormalized(drag.toX, drag.toY)
      const from = await this.#absolute(drag.fromX, drag.fromY)
      const to = await this.#absolute(drag.toX, drag.toY)
      await this.wda.control.dragFromToForDuration({
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        duration: drag.duration ?? 0.3,
      })
    },
    button: async (name = 'home') => {
      await this.wda.control.pressButton(name)
    },
    type: async text => {
      await this.wda.control.typeText(text)
    },
    deviceAction: async action => {
      if (action !== 'app-switcher') {
        throw new Error(`dsh-ios: the ${action} action is not available on a physical device yet`)
      }
      // A real phone honours the gesture the simulator swallows: drag from the
      // home indicator to mid-screen, and let WDA hold the touch there for the
      // rest of the duration — that dwell is what distinguishes the switcher
      // from a plain swipe-to-home.
      const size = await this.#windowSize()
      await this.wda.control.dragFromToForDuration({
        fromX: Math.round(size.width / 2),
        fromY: Math.round(size.height * APP_SWITCHER_FROM_Y),
        toX: Math.round(size.width / 2),
        toY: Math.round(size.height * APP_SWITCHER_TO_Y),
        duration: APP_SWITCHER_DRAG_DURATION_S,
      })
    },
    rotate: async orientation => {
      await this.wda.control.setOrientation(orientation)
      // Width and height just swapped: never map the next tap through the
      // pre-rotation size.
      this.#sizeCache = undefined
    },
    screenshot: () => this.wda.control.screenshot(),
    uiTree: () => this.wda.control.source(),
  }

  async #absolute(x: number, y: number): Promise<StreamPoint> {
    const size = await this.#windowSize()
    return { x: Math.round(x * size.width), y: Math.round(y * size.height) }
  }

  /**
   * The active app's point size, cached for {@link WDA_WINDOW_SIZE_TTL_MS}.
   *
   * Measured on an iPhone 17 Pro: `GET /window/size` is a SESSION-scoped WDA
   * call costing 210–370 ms, the same order as the gesture it precedes. Read
   * fresh every time, it made a tap two round trips (~1.1 s) and a drag
   * three (it converts both endpoints) — a third to a half of the latency
   * the user feels was us asking a question whose answer had not changed.
   *
   * Staleness is bounded on purpose rather than eliminated: a physical
   * rotation swaps width and height, so the window is kept short enough that
   * a human cannot rotate the phone and tap inside it, our OWN rotate drops
   * the cache outright, and a new WDA session (restart/adoption) invalidates
   * it by identity rather than by clock.
   */
  async #windowSize(): Promise<{ width: number; height: number }> {
    const sessionId = this.wda.status().sessionId
    const cached = this.#sizeCache
    if (
      cached !== undefined
      && cached.sessionId === sessionId
      && Date.now() - cached.at < WDA_WINDOW_SIZE_TTL_MS
    ) {
      return cached.size
    }
    const size = await this.wda.control.windowSize()
    this.#sizeCache = { size, at: Date.now(), ...(sessionId === undefined ? {} : { sessionId }) }
    return size
  }

  #sizeCache: { size: { width: number; height: number }; at: number; sessionId?: string } | undefined
}
