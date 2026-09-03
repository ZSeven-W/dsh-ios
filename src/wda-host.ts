/**
 * Host-side lifecycle manager for WebDriverAgent (WDA) on a USB-connected
 * physical iOS device — the foundation for real-device mirroring + control.
 *
 * The controller owns the whole chain for one device:
 * - resolves the device through `xcrun devicectl` (accepts the CoreDevice
 *   udid OR the hardware udid; xcodebuild destinations and iproxy take the
 *   HARDWARE udid);
 * - runs the `WebDriverAgentRunner` via a blocking `xcodebuild … test` child
 *   (that child IS the server; it prints `ServerURLHere->…<-ServerURLHere`
 *   when ready) — or adopts an already-running WDA when one answers on the
 *   default control port (never two xcodebuild instances);
 * - maintains two `iproxy` USB tunnels (positional args: `iproxy <local>
 *   <device> <hardware-udid>`): control REST (device 8100) and MJPEG
 *   (device 9100);
 * - health-checks `GET /status` until `ready`, then creates one WDA session
 *   that is lazily reused and recreated on 404 / `invalid session` errors;
 * - gates every WDA request behind a busy cooldown: one timed-out request
 *   arms it and new requests fail fast with a busy error instead of queueing
 *   behind the stuck command (WDA serves serially and a client-side timeout
 *   never cancels the device-side work), the cheap window/size + orientation
 *   GETs get a 5 s budget of their own, and the window size is cached across
 *   ALL callers with rotation/session invalidation;
 * - treats successful WDA traffic as liveness (every 2xx response refreshes
 *   a traffic clock that keeps `running` true while the device is being
 *   driven), and only declares an ADOPTED runner dead after
 *   `ADOPTED_DEATH_PROBE_FAILURES` consecutive failed keep-alive probes
 *   with no successful traffic in between — probes are skipped while a
 *   control call is in flight or right after a success;
 * - exposes WDA control helpers (pressButton, tap in absolute POINTS,
 *   dragFromToForDuration, typeText, screenshot, source, orientation,
 *   window/size) plus the sim-host-style lifecycle (shared launches,
 *   keep-alive for unintentional exits only, acquire/release refcount,
 *   idle timeout, stderr ring, never console.log).
 *
 * Failure modes are classified into actionable statuses for the UI:
 * device locked (recovers by itself once unlocked — never killed), cert not
 * trusted, free-team profile expired (7-day lifetime → re-run the build),
 * device unplugged, build failure, launch timeout, tunnel failure.
 * @module @zseven-w/dsh-ios/wda-host
 */

import {
  spawn,
  type ChildProcessByStdio,
} from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Readable } from 'node:stream'
import {
  getRealDevice,
  requireAvailable,
  resolveSigningTeam,
  type RealDevice,
} from './devicectl.js'
import { pngDimensionsFromBase64, type StreamScreenshot } from './stream-source.js'
import {
  classifyUsbmuxTunnelFailure,
  createUsbmuxForward,
  resolveUsbDeviceId,
  usbmuxAvailable,
  usbmuxTunnelFailureDetail,
  type UsbmuxForward,
  type UsbmuxForwardOptions,
  type UsbmuxTunnelFailure,
} from './usbmux.js'

/** WDA child process shape: no stdin, piped stdout/stderr. */
type WdaChild = ChildProcessByStdio<null, Readable, Readable>

/** One USB tunnel the controller maintains (iproxy child OR usbmux forward). */
interface WdaTunnel {
  /** Owned iproxy child; absent for an adopted tunnel or a usbmux forward. */
  child?: WdaChild
  /** Owned usbmux forward; absent for an adopted tunnel or an iproxy child. */
  forward?: UsbmuxForward
  localPort: number
  devicePort: number
  udid: string
  adopted: boolean
}

/** The owned (or none) xcodebuild runner child. */
interface WdaRunner {
  child: WdaChild
  hardwareUdid: string
}

/** Discriminated failure classification surfaced through `status()`. */
export type WdaFailureReason =
  /** Device is locked: `deviceprep Code=-3 "Unlock … to Continue"` — WDA recovers by itself. */
  | 'device-locked'
  /** `Developer App Certificate is not trusted` — trust it once in Settings. */
  | 'cert-untrusted'
  /** Free-team provisioning profile expired (7-day lifetime) — re-run the build. */
  | 'profile-expired'
  /** No matching/available device over USB. */
  | 'device-unplugged'
  /** xcodebuild failed (`** TEST BUILD FAILED **` / testing failed / …). */
  | 'build-failed'
  /** No `ServerURLHere` within the startup window. */
  | 'launch-timeout'
  /** iproxy could not forward the WDA ports. */
  | 'tunnel-failed'
  /** WDA answered but `GET /status` never became ready. */
  | 'wda-not-ready'
  /** Host tooling (xcodebuild / iproxy / WDA checkout) missing. */
  | 'unavailable'

/** Error carrying a classified failure reason (plus the original cause). */
export class WdaError extends Error {
  constructor(
    readonly reason: WdaFailureReason,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'WdaError'
  }
}

/** HTTP error from a WDA request; body/value preserved for classification. */
export class WdaHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly body: string | undefined,
    readonly value: unknown,
  ) {
    super(message)
    this.name = 'WdaHttpError'
  }
}

export interface WdaOptions {
  /** WDA checkout containing `WebDriverAgent.xcodeproj` (default `~/Library/Caches/dsh-ios/wda/src`). */
  wdaProjectDir?: string
  /** First local port to try for the control tunnel (default 8100). */
  controlPortStart?: number
  /** First local port to try for the MJPEG tunnel (default 9100). */
  mjpegPortStart?: number
  /** `DEVELOPMENT_TEAM` for automatic signing; overrides `DSH_IOS_TEAM_ID`. */
  teamId?: string
  /** `PRODUCT_BUNDLE_IDENTIFIER` for the runner; overrides `DSH_IOS_WDA_BUNDLE_ID`. */
  bundleId?: string
  /** Minimum delay before an unintentional exit is restarted (default 5000 ms). */
  restartDelayMs?: number
  /** Stop WDA after this long with zero consumers (default 5 min, 0 disables). */
  idleTimeoutMs?: number
  /** Timeout for `ServerURLHere` during a (possibly cold) build (default 5 min). */
  startTimeoutMs?: number
  /** Timeout for `GET /status` to become ready (default 120 s). */
  readyTimeoutMs?: number
  /** Timeout for one WDA HTTP request (default 30 s). */
  requestTimeoutMs?: number
  /** @internal Test seam: keep-alive liveness probe for an ADOPTED WDA
   * (defaults to the real `GET /status` probe with the adopted timeout). */
  probeControl?: (port: number) => Promise<boolean>
  /** @internal Test seam: monotonic clock for the liveness windows
   * (defaults to `Date.now`). */
  now?: () => number
  /** @internal Test seam: keep-alive tick scheduler (defaults to an
   * unref'd `setInterval`); receives the tick callback and returns a clearer. */
  keepAliveInterval?: (tick: () => void, milliseconds: number) => () => void
  /** @internal Test seam: establish a usbmux forward for one tunnel, or
   * return `undefined` to fall back to the iproxy spawn (defaults to the real
   * usbmux path). Injectable so the smoke can assert teardown without
   * opening a usbmux socket. */
  makeUsbmuxForward?: (options: UsbmuxForwardOptions) => Promise<UsbmuxForward | undefined>
  /** @internal Test seam: classify why a tunnel failed (defaults to the real
   * usbmux query); the smoke injects a fixed answer to keep the socket out. */
  classifyTunnelFailure?: (udid: string) => Promise<UsbmuxTunnelFailure>
}

export interface WdaRunningInfo {
  /** CoreDevice udid (the devicectl form). */
  udid: string
  /** Hardware udid (the xcodebuild-destination / iproxy form). */
  hardwareUdid: string
  /** Local REST control URL through the USB tunnel. */
  controlUrl: string
  /** Local MJPEG stream URL through the USB tunnel. */
  mjpegUrl: string
  /** Active WDA session id. */
  sessionId: string
}

export interface WdaStatus {
  available: boolean
  running: boolean
  /** Classified failure of the last attempt (actionable for the UI). */
  reason?: WdaFailureReason
  /** Human-actionable detail for `reason`. */
  detail?: string
  device?: string
  /**
   * The device the controller is trying to run (the last `ensureRunning`
   * target) while nothing is running yet. `device` names a LIVE runner and
   * disappears the moment a launch fails, taking the failure's owner with
   * it — a caller asking "what about MY phone?" would then be told nothing
   * at all. This keeps the in-flight/just-failed device addressable so the
   * route can hand the classified reason back to the right asker.
   */
  pendingDevice?: string
  hardwareUdid?: string
  controlUrl?: string
  mjpegUrl?: string
  sessionId?: string
  /** Local ports actually used by the tunnels. */
  controlPort?: number
  mjpegPort?: number
  /** True when a pre-existing WDA/tunnel was adopted instead of spawned. */
  adopted?: boolean
  startedAt?: number
  restarts: number
  consumers: number
  lastError?: string
  /** Recent child stderr lines (ring buffer) for diagnostics. */
  stderr: string[]
}

/** Parsed `GET /status` health view. */
export interface WdaHealth {
  ready: boolean
  state?: string
  device?: string
  ip?: string
  message?: string
}

export interface WdaDrag {
  fromX: number
  fromY: number
  toX: number
  toY: number
  /** Gesture duration in seconds. */
  duration: number
}

/**
 * Default `snapshotMaxDepth` pushed into WDA before every real-device tree
 * walk. Measured on an iPhone 17 Pro with a busy list app frontmost, on the SAME
 * screen: WDA's default 50 → 32.6 s / 751 KB, 15 → 1.9 s / 12 KB, 8 → 0.15 s
 * / 3 KB. 15 (not 8) because 8 is faster still but starts dropping real
 * controls in deep hierarchies, while 15 keeps the walk under ~2 s without
 * losing the controls the agent taps. WDA serves requests SERIALLY, so the
 * old uncapped snapshot blocked every tap/find_text/ui_tree queued behind it.
 */
export const WDA_DEFAULT_SNAPSHOT_DEPTH = 15

/** Absolute-POINT WDA control surface exposed by `WdaController.control`. */
export interface WdaControl {
  pressButton(name: string): Promise<void>
  /** Tap at absolute POINT coordinates (WDA `/wda/tap` `{x, y}`). */
  tap(x: number, y: number): Promise<void>
  /** Drag between absolute POINT coordinates over `duration` seconds. */
  dragFromToForDuration(drag: WdaDrag): Promise<void>
  typeText(text: string): Promise<void>
  /** Lock the device screen (`POST /wda/lock`). */
  lock(): Promise<void>
  /** Dismiss the lock screen (`POST /wda/unlock`; no passcode entry). */
  unlock(): Promise<void>
  /** Bring up Siri (`POST /wda/siri/activate`, optional utterance). */
  activateSiri(text?: string): Promise<void>
  screenshot(): Promise<StreamScreenshot>
  /** Accessibility tree (XML). */
  source(): Promise<string>
  /** Push `snapshotMaxDepth` into WDA so `/source` stops early instead of
   * walking the whole hierarchy (see WDA_DEFAULT_SNAPSHOT_DEPTH). */
  setSnapshotDepth(depth: number): Promise<void>
  getOrientation(): Promise<string>
  setOrientation(orientation: string): Promise<void>
  /** Active application size in POINTS (the WDA gesture coordinate space). */
  windowSize(): Promise<{ width: number; height: number }>
}

export interface WdaClientOptions {
  requestTimeoutMs?: number
  /**
   * Timeout for the cheap session-scoped GETs (window/size, orientation).
   * These answer in ~250 ms on a healthy device, so a 30 s budget would only
   * ever be spent waiting on a WDA whose dispatcher is stuck behind a slow
   * command (exactly what happens while the device plays video) — and while
   * we wait, the gesture the value was meant for queues ANOTHER command
   * behind the same stuck one. Failing fast here keeps a busy device from
   * being flooded by requests that can only time out.
   * Default WDA_FAST_TIMEOUT_MS.
   */
  shortTimeoutMs?: number
  /**
   * After any request TIMES OUT, reject new requests for this long with a
   * busy error instead of sending them into the same stuck dispatcher.
   * WDA serves requests serially and a client-side timeout does NOT cancel
   * the command on the device, so every request issued during a stall only
   * queues for its own full timeout behind the stuck one — the reported
   * "window/size 持续超时" is exactly that queue burning down. The cooldown
   * turns it into "fail this one fast, retry shortly", and bounds the
   * in-flight pile-up at the ONE request that already timed out.
   * Default WDA_BUSY_COOLDOWN_MS.
   */
  busyCooldownMs?: number
  /** @internal Test seam: monotonic clock (defaults to Date.now). */
  now?: () => number
  maxBodyBytes?: number
  /** Invoked once for every successful WDA HTTP response (2xx, parsed).
   * The controller wires its traffic-liveness hook here — the single place
   * every request funnels through — so EVERY successful call
   * (status/screenshot/source/tap/drag/button/type/orientation/window size)
   * is observed without touching the individual methods. */
  onSuccess?: () => void
}

/** Resolved host tooling for WDA (mirrors serve-sim binary resolution). */
export interface WdaTooling {
  /** True when a full spawn (build + tunnels) is possible on this host. */
  available: boolean
  projectDir: string
  projectOk: boolean
  xcodebuildCommand?: string
  /** Args prefixed to every xcodebuild spawn (empty for `xcodebuild`; `['xcodebuild']` for the xcrun fallback). */
  xcodebuildPrefix: string[]
  iproxyCommand?: string
  reason?: string
}

const DEFAULT_WDA_PROJECT_DIR = join(homedir(), 'Library', 'Caches', 'dsh-ios', 'wda', 'src')
const WDA_PROJECT = 'WebDriverAgent.xcodeproj'
const WDA_SCHEME = 'WebDriverAgentRunner'
const DEFAULT_TEAM_ID = '5CHT5RB9C3'
const DEFAULT_BUNDLE_ID = 'com.finiyang.WebDriverAgentRunner'

/** Source selected by `resolveWdaSetting` before identity discovery. */
export type WdaSettingSource = 'option' | 'env' | 'default'

/** One WDA setting after option, environment, and default precedence. */
export interface WdaSettingResolution {
  value: string
  source: WdaSettingSource
}

/** Resolve one WDA setting with trimmed, non-empty option/env values first. */
export function resolveWdaSetting(
  optionValue: string | undefined,
  envValue: string | undefined,
  defaultValue: string,
): WdaSettingResolution {
  const option = optionValue?.trim() ?? ''
  if (option !== '') return { value: option, source: 'option' }
  const env = envValue?.trim() ?? ''
  if (env !== '') return { value: env, source: 'env' }
  return { value: defaultValue, source: 'default' }
}

/** First local port the control tunnel tries — also the port a probe checks
 * when adopting a WDA this controller did not start (see stream-routes). */
export const CONTROL_PORT_START = 8100
const MJPG_PORT_START = 9100
const PORT_RANGE_LENGTH = 64
const DEVICE_PORT_CONTROL = 8100
const DEVICE_PORT_MJPEG = 9100
const DEFAULT_START_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_RESTART_DELAY_MS = 5_000
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const KEEP_ALIVE_TICK_MS = 1_000
const STOP_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000
/**
 * Timeout for the cheap session-scoped GETs (window/size, orientation).
 * A healthy device answers them in 210–370 ms; 5 s already absorbs a busy
 * moment yet fails six times faster than the general budget when WDA's
 * serial dispatcher is stuck behind a slow screenshot/tree walk (the exact
 * shape of "video playback makes WDA slow"). Failing fast means the next
 * caller is not parked for 30 s only to queue another doomed request.
 */
export const WDA_FAST_TIMEOUT_MS = 5_000
/**
 * How long new requests are rejected after one request times out. The timed
 * out command keeps executing on the device (destroying our socket does not
 * cancel it), so anything sent during the cooldown would only queue behind
 * it and burn its own timeout. Shorter than the control budget, longer than
 * one normal command: one stalled command gets a chance to drain before the
 * next caller tries.
 */
export const WDA_BUSY_COOLDOWN_MS = 10_000
/**
 * How long a freshly read active-app point size is reused across ALL
 * callers — the UI tools read the same value as the panel's gesture
 * mapping, and each read is a session-scoped round trip that a busy WDA
 * cannot serve. Invalidated on setOrientation and session recreation;
 * bounds staleness across a foreground-app switch (the one change this
 * cache cannot observe) while shrinking the stall-period call volume —
 * every call skipped is one less request queued behind a stuck command.
 */
export const WDA_WINDOW_SIZE_CACHE_TTL_MS = 3_000
/** Delay before the single retry of a transport-reset GET (~250 ms). */
const TRANSIENT_RETRY_DELAY_MS = 250
const PROBE_TIMEOUT_MS = 2_000
const TUNNEL_WAIT_MS = 15_000
const MAX_BODY_BYTES = 64 * 1024 * 1024
const MAX_PROBE_BODY_BYTES = 64 * 1024
const MAX_STDOUT_SCAN_BYTES = 256 * 1024
const STDERR_RING_LINES = 40
const STDERR_LINE_MAX_CHARS = 240
/** Throttle for liveness probes of an adopted (not owned) WDA. */
export const ADOPTED_PROBE_INTERVAL_MS = 3_000
/**
 * Timeout for the keep-alive liveness probe of an ADOPTED WDA.
 * WDA serves requests serially: a drag holds the session for its duration
 * and a `/screenshot` streams megabytes over USB, so a `/status` queued
 * behind real control traffic routinely exceeded the old 2 s budget WHILE
 * the plugin was driving the device — and a late probe was then misread as
 * death. 10 s absorbs those bursts (observed screenshots ≈2.7 MB) yet stays
 * well below the 30 s control request timeout, so a genuinely dead tunnel
 * is still detected faster than a control call would fail. Launch/adoption
 * probes keep the tight 2 s default: they only run against an idle port.
 */
export const ADOPTED_PROBE_TIMEOUT_MS = 10_000
/**
 * Consecutive failed keep-alive probes required before an adopted WDA is
 * declared dead. One late probe proves nothing (WDA serializes requests);
 * this hysteresis absorbs transient probe timeouts. Any successful WDA
 * traffic resets the counter. Exported: the smoke regression drives this
 * exact count with injected probes.
 */
export const ADOPTED_DEATH_PROBE_FAILURES = 3
/** Adopted mode: successful traffic keeps `running` true for this long after
 * the response even when the last probe verdict is stale (2× probe interval). */
export const ADOPTED_TRAFFIC_GRACE_MS = ADOPTED_PROBE_INTERVAL_MS * 2

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** Production keep-alive scheduler: an unref'd interval returning its clearer. */
function defaultKeepAliveInterval(tick: () => void, milliseconds: number): () => void {
  const timer = setInterval(tick, milliseconds)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Production usbmux forward factory: prefer speaking usbmux directly, and
 * return `undefined` (→ iproxy fallback) when the socket is absent or the
 * device has no USB record. */
async function defaultMakeUsbmuxForward(options: UsbmuxForwardOptions): Promise<UsbmuxForward | undefined> {
  if (!usbmuxAvailable()) return undefined
  if (await resolveUsbDeviceId(options.udid) === undefined) return undefined
  return createUsbmuxForward(options)
}

function isExecutableFile(path: string): boolean {
  try {
    const info = statSync(path)
    return info.isFile() && (info.mode & 0o111) !== 0
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
 * Resolve the host tooling WDA needs: the checkout directory, `xcodebuild`
 * (with an `xcrun xcodebuild` fallback) and `iproxy`.
 */
export function resolveWdaTooling(projectDir: string = DEFAULT_WDA_PROJECT_DIR): WdaTooling {
  if (process.platform !== 'darwin') {
    return { available: false, projectDir, projectOk: false, xcodebuildPrefix: [], reason: 'WebDriverAgent only runs on macOS' }
  }
  const projectOk = existsSync(join(projectDir, WDA_PROJECT))
  let xcodebuildCommand: string | undefined
  let xcodebuildPrefix: string[] = []
  const xcodebuild = findOnPath('xcodebuild')
  if (xcodebuild !== undefined) {
    xcodebuildCommand = xcodebuild
  } else {
    const xcrun = findOnPath('xcrun')
    if (xcrun !== undefined) {
      xcodebuildCommand = xcrun
      xcodebuildPrefix = ['xcodebuild']
    }
  }
  const iproxyCommand = findOnPath('iproxy')
  const problems: string[] = []
  if (!projectOk) problems.push(`the WDA checkout is missing at ${join(projectDir, WDA_PROJECT)}`)
  if (xcodebuildCommand === undefined) problems.push('xcodebuild is not on PATH')
  if (iproxyCommand === undefined) problems.push('iproxy (libimobiledevice) is not installed')
  return {
    available: projectOk && xcodebuildCommand !== undefined && iproxyCommand !== undefined,
    projectDir,
    projectOk,
    ...(xcodebuildCommand === undefined ? {} : { xcodebuildCommand }),
    xcodebuildPrefix,
    ...(iproxyCommand === undefined ? {} : { iproxyCommand }),
    ...(problems.length === 0 ? {} : { reason: problems.join('; ') }),
  }
}

/**
 * Lock signatures — the "device is locked" family. A locked device makes
 * xcodebuild print `** TEST BUILD FAILED **` around a deviceprep "Unlock …
 * to Continue" / "waiting for the destination to become ready" error, so this
 * family MUST be tested before the build family below: device-locked is
 * SELF-HEALING (the launch recovers once the user unlocks), while build-failed
 * is terminal and makes the agent either give up or retry a build that was
 * never broken. Measured on the attached iPhone 17 Pro: locked →
 * `reason: build-failed`, then the same command succeeded unchanged the
 * moment the device was unlocked.
 */
const WDA_LOCKED_PATTERN = /deviceprep\s+code\s*=\s*-3|unlock[^\n]*to continue|waiting for the destination to become ready/i

/**
 * Classify xcodebuild/devicectl/iproxy output into one actionable failure
 * reason. The exact signatures quoted here were observed on this machine:
 * - locked: `Error Domain=com.apple.dt.deviceprep Code=-3 "Unlock … to
 *   Continue"` followed by `Waiting for the destination to become ready`
 *   (recovers by itself once unlocked);
 * - cert: `The application could not be launched because the Developer App
 *   Certificate is not trusted`;
 * - profile: free-team profiles expire after 7 days.
 */
export function classifyWdaFailure(text: string): WdaFailureReason | undefined {
  // Locked WINS over every later family: one capture can carry BOTH a lock
  // signature and `** TEST BUILD FAILED **` (the locked device is what made
  // the build fail), and the self-healing reading must never lose to the
  // terminal one.
  if (WDA_LOCKED_PATTERN.test(text)) return 'device-locked'
  if (/developer app certificate is not trusted/i.test(text)) return 'cert-untrusted'
  if (/provisioning profile[^\n]{0,120}expired|profile[^\n]{0,80}has expired|has expired[^\n]{0,80}provisioning profile/i.test(text)) {
    return 'profile-expired'
  }
  if (/unable to find a destination matching|no connected physical device matches|is not available \(state|could not find the requested device|requested device could not be found|device [^\n]{0,60}was disconnected|unplug/i.test(text)) {
    return 'device-unplugged'
  }
  if (/\*\* test build failed \*\*|\*\* build failed \*\*|testing failed|test execute failed|xcodebuild: error|command phasescriptexecution failed/i.test(text)) {
    return 'build-failed'
  }
  return undefined
}

/** Actionable UI text for a classified failure. */
export function wdaFailureDetail(reason: WdaFailureReason, deviceName: string, startTimeoutMs: number): string {
  switch (reason) {
    case 'device-locked':
      return `unlock "${deviceName}" — WDA keeps waiting and recovers by itself once the device is unlocked`
    case 'cert-untrusted':
      return `trust the Developer App certificate once in Settings → General → VPN & Device Management on "${deviceName}", then re-run`
    case 'profile-expired':
      return 'the free-team provisioning profile expired (7-day lifetime) — re-run so xcodebuild re-issues it'
    case 'device-unplugged':
      return `connect "${deviceName}" over USB, then re-run`
    case 'build-failed':
      return 'the WebDriverAgentRunner build failed — fix the error and re-run'
    case 'launch-timeout':
      return `no ServerURLHere within ${Math.round(startTimeoutMs / 1000)} s — re-run (a cold build can take minutes)`
    case 'tunnel-failed':
      // The specific sub-case (USB up / Wi-Fi only / absent) is set at the
      // failure site; this fallback covers the generic "we tried to forward".
      return usbmuxTunnelFailureDetail('usb-link-up')
    case 'wda-not-ready':
      return 'WDA answered but did not become ready — re-run'
    case 'unavailable':
      return 'WDA tooling is unavailable on this host'
  }
}

/**
 * Extract the readiness URL from xcodebuild output:
 * `ServerURLHere->http://<device-ip>:8100<-ServerURLHere`.
 */
export function parseServerUrlHere(text: string): string | undefined {
  const match = /ServerURLHere->(https?:\/\/[^\s<]+)<-ServerURLHere/.exec(text)
  return match?.[1]
}

/**
 * iproxy argument assembly — the syntax is POSITIONAL
 * (`iproxy <local> <device> <udid>`), NOT the `8100:8100` colon form.
 */
export function assembleIproxyArgs(localPort: number, devicePort: number, udid: string): string[] {
  return [String(localPort), String(devicePort), udid]
}

/** Build settings accepted by `assembleXcodebuildTestArgs`. */
export interface WdaBuildSettings {
  teamId?: string
  bundleId?: string
}

/**
 * The verified runner invocation: `xcodebuild -project WebDriverAgent.xcodeproj
 * -scheme WebDriverAgentRunner -destination 'id=<HARDWARE_UDID>'
 * -allowProvisioningUpdates DEVELOPMENT_TEAM=… CODE_SIGN_STYLE=Automatic
 * PRODUCT_BUNDLE_IDENTIFIER=… test` (build-for-testing uses the same settings
 * and swaps the trailing verb).
 */
export function assembleXcodebuildTestArgs(hardwareUdid: string, settings: WdaBuildSettings = {}): string[] {
  return [
    '-project', WDA_PROJECT,
    '-scheme', WDA_SCHEME,
    '-destination', `id=${hardwareUdid}`,
    '-allowProvisioningUpdates',
    ...(settings.teamId === undefined ? [] : [`DEVELOPMENT_TEAM=${settings.teamId}`]),
    'CODE_SIGN_STYLE=Automatic',
    ...(settings.bundleId === undefined ? [] : [`PRODUCT_BUNDLE_IDENTIFIER=${settings.bundleId}`]),
    'test',
  ]
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
 * Cheap probe of one local port: full-body (control REST) or
 * headers-only (MJPEG, whose body never ends).
 */
function probeHttp(
  url: string,
  timeoutMs: number,
  judge: (statusCode: number, headers: IncomingHttpHeaders, body: string) => boolean,
  headersOnly = false,
): Promise<boolean> {
  return new Promise(resolveProbe => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveProbe(value)
    }
    const req = httpRequest(url, { method: 'GET', timeout: timeoutMs }, res => {
      if (headersOnly) {
        const matches = judge(res.statusCode ?? 0, res.headers, '')
        res.destroy()
        finish(matches)
        return
      }
      let body = ''
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
        if (body.length > MAX_PROBE_BODY_BYTES) {
          res.destroy()
          finish(false)
        }
      })
      res.on('error', () => finish(false))
      res.on('end', () => finish(judge(res.statusCode ?? 0, res.headers, body)))
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

/** True when `GET http://127.0.0.1:<port>/status` answers ready (WDA shape). */
export function probeWdaControlTunnel(port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return probeHttp(`http://127.0.0.1:${port}/status`, timeoutMs, (statusCode, _headers, body) => {
    if (statusCode !== 200) return false
    try {
      const doc = JSON.parse(body) as Record<string, unknown>
      const value = doc.value
      if (typeof value !== 'object' || value === null) return false
      const record = value as Record<string, unknown>
      return record.ready === true || record.state === 'success'
    } catch {
      return false
    }
  })
}

/** True when `GET http://127.0.0.1:<port>/` streams `multipart/x-mixed-replace`. */
export function probeWdaMjpegTunnel(port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return probeHttp(
    `http://127.0.0.1:${port}/`,
    timeoutMs,
    (_statusCode, headers) => /^multipart\/x-mixed-replace\b/i.test(String(headers['content-type'] ?? '')),
    true,
  )
}

export interface TunnelPortPick {
  port: number
  /** True when an existing tunnel was found on this port and adopted. */
  adopted: boolean
}

/**
 * Pick a free local port for a new tunnel starting at `startPort`. A port
 * already taken by an EXISTING tunnel (the probe matches) is adopted instead
 * of collided with; a port taken by an unrelated server is skipped.
 */
export async function pickTunnelPort(
  startPort: number,
  probe: (port: number) => Promise<boolean>,
  rangeLength: number = PORT_RANGE_LENGTH,
): Promise<TunnelPortPick> {
  if (!Number.isSafeInteger(startPort) || startPort < 1024 || startPort > 65535) {
    throw new RangeError('dsh-ios: startPort must be an integer between 1024 and 65535')
  }
  for (let offset = 0; offset < rangeLength; offset += 1) {
    const port = startPort + offset
    if (port > 65535) break
    if (await canBindLoopbackPort(port)) return { port, adopted: false }
    if (await probe(port)) return { port, adopted: true }
  }
  throw new Error(`dsh-ios: no free tunnel port in range ${startPort}..${Math.min(65535, startPort + rangeLength - 1)}`)
}

function waitForServerUrlHere(child: WdaChild, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    const finish = (error?: Error, url?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('close', onClose)
      if (error !== undefined) reject(error)
      else resolve(url!)
    }
    const onData = (chunk: Buffer): void => {
      // xcodebuild prints a LOT; only the tail matters for the handshake.
      stdout = (stdout + chunk.toString('utf8')).slice(-MAX_STDOUT_SCAN_BYTES)
      const url = parseServerUrlHere(stdout)
      if (url !== undefined) finish(undefined, url)
    }
    const onError = (error: Error): void => { finish(error) }
    const onClose = (code: number | null): void => {
      finish(new Error(`xcodebuild exited before WDA came up (code ${String(code)})`))
    }
    const timer = setTimeout(() => {
      finish(new Error(`xcodebuild did not print ServerURLHere within ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

function waitForChildClose(child: WdaChild, timeoutMs: number): Promise<boolean> {
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

/** Kill the whole child process group (xcodebuild/iproxy and their wrappers). */
function signalProcessGroup(child: WdaChild, signal: NodeJS.Signals): void {
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

async function killProcessGroup(child: WdaChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  signalProcessGroup(child, 'SIGTERM')
  const closed = await waitForChildClose(child, timeoutMs)
  if (!closed && child.exitCode === null && child.signalCode === null) {
    signalProcessGroup(child, 'SIGKILL')
    return waitForChildClose(child, timeoutMs)
  }
  return closed
}

/** True when an error is a stale WDA session (404 / `invalid session id`). */
export function isInvalidSessionError(error: unknown): boolean {
  if (!(error instanceof WdaHttpError)) return false
  const text = String(error.body ?? '')
  if (/invalid session|session does not exist|no such driver/i.test(text)) return true
  if (error.status === 404 && /session/i.test(text)) return true
  if (typeof error.value === 'object' && error.value !== null) {
    const value = error.value as Record<string, unknown>
    if (typeof value.error === 'string' && /invalid session/i.test(value.error)) return true
  }
  return false
}

/**
 * True when an error is a transport reset WDA drops under load — a dropped
 * READ, not a real failure, so an idempotent GET is safe to retry once.
 * Matches `ECONNRESET`, `socket hang up`, and `EPIPE`; `ECONNREFUSED` is
 * deliberately NOT transient (the tunnel/port is gone, not overloaded) and
 * neither is an HTTP 4xx/5xx `WdaHttpError` (the server answered).
 */
export function isTransientWdaTransportError(error: unknown): boolean {
  const text = errorMessage(error)
  if (/\bECONNREFUSED\b/i.test(text)) return false
  return /\bECONNRESET\b/i.test(text)
    || /\bsocket hang up\b/i.test(text)
    || /\bEPIPE\b/i.test(text)
}

/**
 * True when an error is the busy fast-fail the client answers during its
 * post-timeout cooldown: the device is answering too slowly, so new requests
 * are refused at once instead of queueing behind the stuck command. Callers
 * surface it as "the device is busy — retry shortly" rather than a hang.
 */
export function isWdaBusyError(error: unknown): boolean {
  return /\[wda-busy\]/i.test(errorMessage(error))
}

/** Idempotent GETs — retried once on a transport reset. POSTs are excluded
 * because a retried tap/drag/type would double-fire. `getOrientation` is a
 * GET too but deliberately left out: it is cheap and never blocks the queue
 * the way a snapshot/screenshot does. */
function isIdempotentWdaGet(method: string, path: string): boolean {
  return method === 'GET'
    && (path === '/status'
      || path.endsWith('/source')
      || path.endsWith('/screenshot')
      || path.endsWith('/window/size'))
}

/**
 * The cheap session-scoped GETs whose answer never needs the full 30 s
 * budget: they cost 210–370 ms on a healthy device, so the only way they
 * come close to the general timeout is a dispatcher stuck behind a slow
 * command (video playback is the observed case). They get
 * {@link WdaClientOptions.shortTimeoutMs} so a busy device fails them fast
 * instead of parking their callers for half a minute each.
 */
function isFastWdaPath(method: string, path: string): boolean {
  return method === 'GET' && (path.endsWith('/window/size') || path.endsWith('/orientation'))
}

/**
 * HTTP client for one running WDA instance (through the USB tunnel).
 * Owns the session: created lazily on first use, reused across calls, and
 * recreated exactly once when a call hits a 404 / `invalid session` error.
 */
export class WdaClient {
  readonly controlUrl: string
  #options: Required<WdaClientOptions>
  #sessionId: string | undefined
  #sessionPromise: Promise<string> | undefined
  /** Clock time until which new requests fail fast with a busy error. */
  #busyUntil = 0
  /** Cached active-app point size (windowSize); dropped on rotation/session. */
  #sizeCache: { size: { width: number; height: number }; at: number } | undefined

  constructor(controlUrl: string, options: WdaClientOptions = {}) {
    this.controlUrl = controlUrl.replace(/\/+$/, '')
    this.#options = {
      requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      shortTimeoutMs: options.shortTimeoutMs ?? WDA_FAST_TIMEOUT_MS,
      busyCooldownMs: options.busyCooldownMs ?? WDA_BUSY_COOLDOWN_MS,
      now: options.now ?? Date.now,
      maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
      onSuccess: options.onSuccess ?? (() => {}),
    }
  }

  get sessionId(): string | undefined {
    return this.#sessionId
  }

  /** Drop the cached session so the next call recreates it. */
  invalidateSession(): void {
    this.#sessionId = undefined
    this.#sizeCache = undefined
  }

  /** `GET /status` health view. */
  async health(): Promise<WdaHealth> {
    const doc = await this.#raw('GET', '/status')
    const value = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>).value : undefined
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    const ios = typeof record.ios === 'object' && record.ios !== null ? record.ios as Record<string, unknown> : {}
    return {
      ready: record.ready === true,
      ...(typeof record.state === 'string' ? { state: record.state } : {}),
      ...(typeof record.device === 'string' ? { device: record.device } : {}),
      ...(typeof ios.ip === 'string' ? { ip: ios.ip } : {}),
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
    }
  }

  /** Create the session lazily and reuse it; concurrent callers share one POST. */
  async ensureSession(): Promise<string> {
    if (this.#sessionId !== undefined) return this.#sessionId
    if (this.#sessionPromise !== undefined) return this.#sessionPromise
    this.#sessionPromise = this.#createSession()
    try {
      return await this.#sessionPromise
    } finally {
      this.#sessionPromise = undefined
    }
  }

  /** Raw request returning the parsed `value` of the WDA response envelope. */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.#requestValue(method, path, body)
  }

  /**
   * `POST /wda/pressButton` `{name}` — verified: really moves the phone.
   *
   * `home` takes WDA's SESSIONLESS `/wda/homescreen` instead, measured on an
   * iPhone 17 Pro at ~30 ms against ~470 ms for the session-scoped press —
   * same effect (the springboard), a fifteenth of the wait, and Home is the
   * button the panel's toolbar fires most. Any failure falls back to the
   * session route, so an older WDA without that endpoint still works.
   */
  async pressButton(name: string): Promise<void> {
    if (typeof name !== 'string' || name === '') throw new TypeError('dsh-ios: pressButton requires a button name')
    if (name === 'home') {
      try {
        await this.#requestValue('POST', '/wda/homescreen', {})
        return
      } catch {
        // Fall through to the session-scoped press below.
      }
    }
    await this.#withSession('POST', '/wda/pressButton', { name })
  }

  /** `POST /wda/tap` `{x, y}` — absolute POINT coordinates of the active app. */
  async tap(x: number, y: number): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      throw new RangeError('dsh-ios: tap requires non-negative point coordinates')
    }
    await this.#withSession('POST', '/wda/tap', { x, y })
  }

  /** `POST /wda/dragfromtoforduration` `{fromX, fromY, toX, toY, duration}`. */
  async dragFromToForDuration(drag: WdaDrag): Promise<void> {
    const { fromX, fromY, toX, toY, duration } = drag
    if (![fromX, fromY, toX, toY, duration].every(value => Number.isFinite(value)) || duration < 0) {
      throw new RangeError('dsh-ios: dragFromToForDuration requires finite coordinates and a non-negative duration')
    }
    await this.#withSession('POST', '/wda/dragfromtoforduration', { fromX, fromY, toX, toY, duration })
  }

  /** `POST /wda/keys` `{value: [text]}` (the handler joins the value array). */
  async typeText(text: string): Promise<void> {
    if (typeof text !== 'string' || text === '') throw new TypeError('dsh-ios: typeText requires a non-empty text')
    await this.#withSession('POST', '/wda/keys', { value: [text] })
  }

  /** `POST /wda/lock` — lock the device screen. */
  async lock(): Promise<void> {
    await this.#withSession('POST', '/wda/lock', {})
  }

  /** `POST /wda/unlock` — dismiss the lock screen (no passcode entry). */
  async unlock(): Promise<void> {
    await this.#withSession('POST', '/wda/unlock', {})
  }

  /** `POST /wda/siri/activate` `{text}` — bring up Siri (optionally with an
   * utterance; the panel's Siri button sends none). */
  async activateSiri(text = ''): Promise<void> {
    await this.#withSession('POST', '/wda/siri/activate', { text })
  }

  /** `GET /screenshot` → base64 PNG (1206×2622 pixels on this device). */
  async screenshot(): Promise<StreamScreenshot> {
    const value = await this.#withSession<unknown>('GET', '/screenshot')
    if (typeof value !== 'string' || value === '') {
      throw new WdaHttpError('WDA /screenshot returned no image data', undefined, undefined, value)
    }
    const size = pngDimensionsFromBase64(value)
    return { pngBase64: value, ...(size === undefined ? {} : size) }
  }

  /** `GET /source` → accessibility tree (XML by default). */
  async source(): Promise<string> {
    const value = await this.#withSession<unknown>('GET', '/source')
    return typeof value === 'string' ? value : JSON.stringify(value)
  }

  /** `POST /session/<sid>/appium/settings` `{settings: {snapshotMaxDepth}}` —
   * caps the accessibility-tree walk WDA performs for `/source` so a busy
   * app is snapshotted in ~2 s instead of ~33 s. */
  async setSnapshotDepth(depth: number): Promise<void> {
    if (!Number.isSafeInteger(depth) || depth < 0) {
      throw new RangeError('dsh-ios: setSnapshotDepth requires a non-negative integer')
    }
    await this.#withSession('POST', '/appium/settings', { settings: { snapshotMaxDepth: depth } })
  }

  /** `GET /orientation` → e.g. `PORTRAIT`. */
  async getOrientation(): Promise<string> {
    const value = await this.#withSession<unknown>('GET', '/orientation')
    if (typeof value !== 'string' || value === '') {
      throw new WdaHttpError('WDA /orientation returned no value', undefined, undefined, value)
    }
    return value
  }

  /** `POST /orientation` `{orientation}` (PORTRAIT, LANDSCAPELEFT, …). */
  async setOrientation(orientation: string): Promise<void> {
    if (typeof orientation !== 'string' || orientation === '') throw new TypeError('dsh-ios: setOrientation requires an orientation name')
    await this.#withSession('POST', '/orientation', { orientation })
    // Width and height just swapped: never hand a pre-rotation size out.
    this.#sizeCache = undefined
  }

  /**
   * `GET /window/size` → active app size in POINTS (the gesture space).
   * Reused across callers for {@link WDA_WINDOW_SIZE_CACHE_TTL_MS}: the value
   * only changes on rotation (invalidated here and by setOrientation) or a
   * foreground-app switch (bounded by the TTL), and each skipped round trip
   * is one less request queued behind a stuck command while the device is
   * busy (video playback is the observed worst case).
   */
  async windowSize(): Promise<{ width: number; height: number }> {
    const cached = this.#sizeCache
    if (cached !== undefined && this.#options.now() - cached.at < WDA_WINDOW_SIZE_CACHE_TTL_MS) {
      return cached.size
    }
    const value = await this.#withSession<unknown>('GET', '/window/size')
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new WdaHttpError('WDA /window/size returned an invalid value', undefined, undefined, value)
    }
    const record = value as Record<string, unknown>
    const width = record.width
    const height = record.height
    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
      throw new WdaHttpError('WDA /window/size returned an invalid size', undefined, undefined, value)
    }
    const size = { width, height }
    this.#sizeCache = { size, at: this.#options.now() }
    return size
  }

  async #createSession(): Promise<string> {
    const { doc, value } = await this.#request('POST', '/session', {
      capabilities: { alwaysMatch: { platformName: 'iOS' } },
    })
    const valueRecord = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    const sid = typeof doc.sessionId === 'string' && doc.sessionId !== ''
      ? doc.sessionId
      : typeof valueRecord.sessionId === 'string' && valueRecord.sessionId !== ''
        ? valueRecord.sessionId
        : undefined
    if (sid === undefined) {
      throw new WdaHttpError('WDA created a session without a sessionId', undefined, JSON.stringify(doc), value)
    }
    this.#sessionId = sid
    // A fresh session may serve a different device state: re-read the size.
    this.#sizeCache = undefined
    return sid
  }

  async #withSession<T>(method: string, path: string, body?: unknown): Promise<T> {
    let sid = await this.ensureSession()
    try {
      return await this.#requestValue<T>(method, `/session/${sid}${path}`, body)
    } catch (error) {
      if (!isInvalidSessionError(error)) throw error
      // Stale session (WDA was restarted, runner rebuilt, …): recreate once.
      this.#sessionId = undefined
      sid = await this.ensureSession()
      return this.#requestValue<T>(method, `/session/${sid}${path}`, body)
    }
  }

  async #requestValue<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { value } = await this.#request(method, path, body)
    return value as T
  }

  async #request(method: string, path: string, body?: unknown): Promise<{ doc: Record<string, unknown>; value: unknown }> {
    const raw = await this.#raw(method, path, body)
    const doc = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const value = doc.value
    if (typeof value === 'object' && value !== null) {
      const error = (value as Record<string, unknown>).error
      if (typeof error === 'string' && error !== '') {
        const message = (value as Record<string, unknown>).message
        throw new WdaHttpError(
          `WDA ${method} ${path} failed: ${error}${typeof message === 'string' && message !== '' ? ` — ${message}` : ''}`,
          undefined,
          JSON.stringify(doc),
          value,
        )
      }
    }
    return { doc, value }
  }

  /**
   * The busy gate plus the single transport-reset retry. While the cooldown
   * after a timeout lasts, EVERY request fails fast with a busy error: WDA
   * serves requests serially and a client-side timeout does not cancel the
   * command on the device, so anything sent now would only queue behind the
   * stuck command and burn its own timeout (the reported timeout cascade).
   * The gate bounds that pile-up at the one request that already timed out.
   *
   * A transport reset (ECONNRESET / socket hang up / EPIPE) is then retried
   * exactly once, and only for idempotent GETs: WDA drops connections under
   * load, so a dropped snapshot/screenshot read is not a real failure. POSTs
   * are never retried (a retried tap taps twice).
   */
  async #raw(method: string, path: string, body?: unknown): Promise<unknown> {
    if (this.#options.now() < this.#busyUntil) {
      throw new WdaHttpError(
        'WDA ' + method + ' ' + path + ' rejected while the device is busy: a recent request timed out and its command is still draining on the device — retry shortly [wda-busy]',
        undefined,
        undefined,
        undefined,
      )
    }
    const timeoutMs = isFastWdaPath(method, path)
      ? this.#options.shortTimeoutMs
      : this.#options.requestTimeoutMs
    try {
      return await this.#rawOnce(method, path, body, timeoutMs)
    } catch (error) {
      if (!isIdempotentWdaGet(method, path) || !isTransientWdaTransportError(error)) throw error
      await sleep(TRANSIENT_RETRY_DELAY_MS)
      return this.#rawOnce(method, path, body, timeoutMs)
    }
  }

  #rawOnce(method: string, path: string, body: unknown | undefined, timeoutMs: number): Promise<unknown> {
    const url = `${this.controlUrl}${path}`
    return new Promise((resolve, reject) => {
      let settled = false
      const failWith = (error: unknown): void => {
        // A timeout means the device is busy: arm the cooldown so the next
        // callers fail fast instead of queueing behind the stuck command.
        // Other failures (reset, refused, HTTP errors) are not a busy signal.
        if (error instanceof WdaHttpError && /timed out after/i.test(error.message)) {
          this.#busyUntil = this.#options.now() + this.#options.busyCooldownMs
        }
        reject(error)
      }
      const finish = (done: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        done()
      }
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = httpRequest(url, {
        method,
        timeout: timeoutMs,
        ...(payload === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } }),
      }, res => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > this.#options.maxBodyBytes) {
            res.destroy()
            finish(() => failWith(new WdaHttpError(
              `WDA ${method} ${path} response exceeded ${this.#options.maxBodyBytes} bytes`,
              res.statusCode,
              undefined,
              undefined,
            )))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', error => {
          finish(() => failWith(new WdaHttpError(
            `WDA ${method} ${path} connection error: ${errorMessage(error)}`,
            res.statusCode,
            undefined,
            undefined,
          )))
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let doc: unknown
          try {
            doc = text === '' ? undefined : JSON.parse(text)
          } catch {
            doc = undefined
          }
          if (res.statusCode === undefined || res.statusCode >= 400) {
            const value = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>).value : undefined
            const detail = typeof value === 'object' && value !== null
              ? `${String((value as Record<string, unknown>).error ?? '')}${(value as Record<string, unknown>).message === undefined ? '' : ` — ${(value as Record<string, unknown>).message}`}`.trim()
              : text.slice(0, 400)
            finish(() => failWith(new WdaHttpError(
              `WDA ${method} ${path} returned HTTP ${res.statusCode}${detail === '' ? '' : `: ${detail}`}`,
              res.statusCode,
              text,
              value,
            )))
            return
          }
          // Liveness bookkeeping must never fail a successful call.
          try {
            this.#options.onSuccess()
          } catch {
            // Ignore: the response itself succeeded.
          }
          finish(() => resolve(doc))
        })
      })
      req.on('error', error => {
        finish(() => failWith(new WdaHttpError(`WDA ${method} ${path} request failed: ${errorMessage(error)}`, undefined, undefined, undefined)))
      })
      req.on('timeout', () => {
        req.destroy()
        finish(() => failWith(new WdaHttpError(`WDA ${method} ${path} timed out after ${timeoutMs} ms`, undefined, undefined, undefined)))
      })
      const timer = setTimeout(() => {
        req.destroy()
        finish(() => failWith(new WdaHttpError(`WDA ${method} ${path} timed out after ${timeoutMs} ms`, undefined, undefined, undefined)))
      }, timeoutMs)
      timer.unref?.()
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }
}

/**
 * Lifecycle manager for WebDriverAgent on one physical device. Shape mirrors
 * `SimHostController`: shared launches, keep-alive that only restarts
 * unintentional exits, acquire/release consumer refcount, idle timeout,
 * launch serialization and a stderr ring — never console.log.
 */
export class WdaController {
  readonly tooling: WdaTooling
  readonly #options: Omit<Required<WdaOptions>, 'teamId'> & { teamId?: string }
  #runner: WdaRunner | undefined
  #tunnels: WdaTunnel[] = []
  #client: WdaClient | undefined
  #info: WdaRunningInfo | undefined
  #starting: Promise<WdaRunningInfo> | undefined
  #launchQueue: Promise<void> = Promise.resolve()
  #consumers = 0
  #keepAliveRunning = false
  #keepAliveTimer: (() => void) | undefined
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
  /** Lazily resolved once, immediately before the first WDA runner build. */
  #teamIdResolution: Promise<string> | undefined
  #teamIdSource: WdaSettingSource | undefined
  #stderrRing: string[] = []
  #stderrPartial = ''
  /** Classified failure of the last attempt; cleared on readiness. */
  #failure: { reason: WdaFailureReason; detail: string } | undefined
  /**
   * Set once a live stderr chunk carried a lock signature during THIS spawn.
   * The exit classification re-reads only the last STDERR_RING_LINES lines, so
   * a lock signature that scrolled out before a huge build-failure dump would
   * otherwise be lost and misread as build-failed; this flag pins it.
   */
  #lockedSignatureSeen = false
  /** True while a pre-existing WDA was adopted instead of spawning xcodebuild. */
  #adoptedRunner = false
  /** Last adopted-runner liveness probe result (only meaningful when adopted). */
  #probeOk = false
  /** Consecutive failed adopted-runner probes — hysteresis before death. */
  #probeFailStreak = 0
  /** Clock time of the last successful WDA HTTP response (ANY traffic). */
  #lastOkAt = 0
  /** Control calls currently in flight; the keep-alive probe waits them out. */
  #controlCallsInFlight = 0
  #probeInFlight = false
  #lastProbeAt = 0
  #controlPort: number | undefined
  #mjpegPort: number | undefined
  /** Bumped by stop(); an in-flight launch must not land afterwards. */
  #launchEpoch = 0

  constructor(options: WdaOptions = {}) {
    this.tooling = resolveWdaTooling(options.wdaProjectDir ?? DEFAULT_WDA_PROJECT_DIR)
    const bundle = resolveWdaSetting(options.bundleId, process.env.DSH_IOS_WDA_BUNDLE_ID, DEFAULT_BUNDLE_ID)
    const team = resolveWdaSetting(options.teamId, undefined, DEFAULT_TEAM_ID)
    this.#options = {
      wdaProjectDir: options.wdaProjectDir ?? DEFAULT_WDA_PROJECT_DIR,
      controlPortStart: options.controlPortStart ?? CONTROL_PORT_START,
      mjpegPortStart: options.mjpegPortStart ?? MJPG_PORT_START,
      teamId: team.source === 'default' ? undefined : team.value,
      bundleId: bundle.value,
      restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      probeControl: options.probeControl ?? ((port: number) => probeWdaControlTunnel(port, ADOPTED_PROBE_TIMEOUT_MS)),
      now: options.now ?? Date.now,
      keepAliveInterval: options.keepAliveInterval ?? defaultKeepAliveInterval,
      makeUsbmuxForward: options.makeUsbmuxForward ?? defaultMakeUsbmuxForward,
      classifyTunnelFailure: options.classifyTunnelFailure ?? ((udid: string) => classifyUsbmuxTunnelFailure(udid)),
    }
    this.#teamIdSource = team.source === 'default' ? undefined : team.source
    if (!Number.isSafeInteger(this.#options.controlPortStart) || this.#options.controlPortStart < 1024 || this.#options.controlPortStart > 65535) {
      throw new RangeError('dsh-ios: controlPortStart must be an integer between 1024 and 65535')
    }
    if (!Number.isSafeInteger(this.#options.mjpegPortStart) || this.#options.mjpegPortStart < 1024 || this.#options.mjpegPortStart > 65535) {
      throw new RangeError('dsh-ios: mjpegPortStart must be an integer between 1024 and 65535')
    }
  }

  get available(): boolean {
    return this.tooling.available
  }

  get mjpegUrl(): string | undefined {
    return this.#info?.mjpegUrl
  }

  /**
   * True while WDA is up: an owned live runner, or an adoption that either
   * passed its last probe or served successful traffic within the grace
   * window. Successful WDA traffic IS liveness — a keep-alive probe that
   * came back late (or timed out) while the device was busy serving a call
   * must not mask a WDA that is demonstrably answering.
   */
  get running(): boolean {
    if (this.#info === undefined || this.#client === undefined) return false
    if (this.#adoptedRunner) {
      return this.#probeOk
        || (this.#lastOkAt > 0 && this.#options.now() - this.#lastOkAt <= ADOPTED_TRAFFIC_GRACE_MS)
    }
    const child = this.#runner?.child
    return child !== undefined && child.exitCode === null && child.signalCode === null
  }

  /** Absolute-POINT WDA control helpers (used by the real-device tools). */
  readonly control: WdaControl = {
    pressButton: name => this.#withControl(() => this.#requireClient().pressButton(name)),
    tap: (x, y) => this.#withControl(() => this.#requireClient().tap(x, y)),
    dragFromToForDuration: drag => this.#withControl(() => this.#requireClient().dragFromToForDuration(drag)),
    typeText: text => this.#withControl(() => this.#requireClient().typeText(text)),
    lock: () => this.#withControl(() => this.#requireClient().lock()),
    unlock: () => this.#withControl(() => this.#requireClient().unlock()),
    activateSiri: text => this.#withControl(() => this.#requireClient().activateSiri(text)),
    screenshot: () => this.#withControl(() => this.#requireClient().screenshot()),
    source: () => this.#withControl(() => this.#requireClient().source()),
    setSnapshotDepth: depth => this.#withControl(() => this.#requireClient().setSnapshotDepth(depth)),
    getOrientation: () => this.#withControl(() => this.#requireClient().getOrientation()),
    setOrientation: orientation => this.#withControl(() => this.#requireClient().setOrientation(orientation)),
    windowSize: () => this.#withControl(() => this.#requireClient().windowSize()),
  }

  /**
   * Run one control call while marking it in flight: the adopted-runner
   * keep-alive probe skips while ANY call is in flight. A live call is
   * better liveness evidence than a fresh probe, and the probe would only
   * queue behind WDA's serialized handler and time out.
   */
  #withControl<T>(task: () => Promise<T>): Promise<T> {
    this.#controlCallsInFlight += 1
    try {
      return task().finally(() => { this.#controlCallsInFlight -= 1 })
    } catch (error) {
      this.#controlCallsInFlight -= 1
      throw error
    }
  }

  /**
   * Resolve the device (either udid form), ensure the runner (adopt or
   * spawn), ensure both USB tunnels, health-check `GET /status` until ready
   * and hand back a live WDA session. Concurrent callers share one launch.
   */
  async ensureRunning({ udid }: { udid: string }): Promise<WdaRunningInfo> {
    if (this.#disposed) throw new Error('dsh-ios: wda host is disposed')
    if (typeof udid !== 'string' || udid === '') throw new TypeError('dsh-ios: ensureRunning requires a non-empty udid')
    const startFor = async (): Promise<WdaRunningInfo> => {
      const current = this.#info
      if (current !== undefined && current.udid === udid && this.running && this.#client !== undefined) {
        // Session reuse: recreate-on-invalid covers stale ones later.
        try {
          await this.#client.ensureSession()
        } catch {
          // Keep the current info; the next control call recreates.
        }
        return { ...current, sessionId: this.#client.sessionId ?? current.sessionId }
      }
      if (!this.tooling.available) {
        const reason: WdaFailureReason = 'unavailable'
        this.#failure = { reason, detail: this.tooling.reason ?? wdaFailureDetail(reason, udid, this.#options.startTimeoutMs) }
        throw new WdaError('unavailable', `dsh-ios: WebDriverAgent tooling is unavailable${this.tooling.reason === undefined ? '' : ` (${this.tooling.reason})`}`)
      }
      let device: RealDevice
      try {
        device = await getRealDevice(udid)
      } catch (error) {
        this.#failure = { reason: 'device-unplugged', detail: wdaFailureDetail('device-unplugged', udid, this.#options.startTimeoutMs) }
        throw new WdaError('device-unplugged', `dsh-ios: no connected physical device matches "${udid}" — connect it over USB (${errorMessage(error)})`, error)
      }
      try {
        requireAvailable(device)
      } catch (error) {
        this.#failure = { reason: 'device-unplugged', detail: wdaFailureDetail('device-unplugged', device.name, this.#options.startTimeoutMs) }
        throw new WdaError('device-unplugged', `dsh-ios: ${errorMessage(error)}`, error)
      }
      const hardwareUdid = device.hardwareUdid ?? device.udid
      if (device.hardwareUdid === undefined) {
        this.#noteStderr(`devicectl reported no hardware udid for ${device.name}; using the CoreDevice udid for xcodebuild/iproxy`)
      }
      // Retire whatever a previous device left behind before taking over.
      await this.#teardown()
      // Claim the target BEFORE the attempt, not after it succeeds. `status()`
      // reports this as `pendingDevice`, which is the only handle a
      // device-filtered caller has on an attempt that is still building or
      // already failed (a failure tears the live `device` down). Recorded
      // late, the panel's poll for THIS phone answered a bare "not running"
      // and swallowed the actionable reason — "unlock the device".
      this.#lastDevice = udid
      const info = await this.#startForDevice(device, hardwareUdid)
      this.#lastError = undefined
      return info
    }
    let starting = this.#starting
    if (starting !== undefined) {
      try {
        await starting
      } catch {
        // A failed shared launch is still a settled one; retry below.
      }
      const info = this.#info
      if (info !== undefined && info.udid === udid && this.running) {
        this.#armIdle()
        return { ...info, sessionId: this.#client?.sessionId ?? info.sessionId }
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
   * Start the crash keep-alive loop: an unintentional exit is restarted after
   * `restartDelayMs`; intentional `stop()` calls are never fought. An adopted
   * WDA (no owned child) is watched with throttled `GET /status` probes that
   * only declare death after `ADOPTED_DEATH_PROBE_FAILURES` consecutive
   * failures with no successful WDA traffic in between.
   */
  startKeepAlive(): void {
    if (this.#keepAliveRunning || this.#disposed) return
    this.#keepAliveRunning = true
    const tick = (): void => {
      if (this.#disposed || !this.#keepAliveRunning) return
      void this.#keepAliveTick().catch(() => {})
    }
    this.#keepAliveTimer = this.#options.keepAliveInterval(tick, KEEP_ALIVE_TICK_MS)
  }

  /** Stop the keep-alive loop. */
  stopKeepAlive(): void {
    this.#keepAliveRunning = false
    this.#keepAliveTimer?.()
    this.#keepAliveTimer = undefined
  }

  /**
   * Stop WDA: kill the owned runner and owned tunnels. Pre-existing adopted
   * tunnels are left alone (they belong to whoever started them); the
   * keep-alive loop will not bring anything back until `ensureRunning`.
   */
  async stop(): Promise<void> {
    this.#clearIdle()
    this.#intentionalStop = true
    this.#lastStopAt = this.#options.now()
    this.#launchEpoch += 1
    await this.#teardown()
    // An in-flight launch may still land after teardown; reap it once settled.
    await this.#starting?.catch(() => {})
    if (this.#runner !== undefined || this.#tunnels.some(tunnel => tunnel.child !== undefined || tunnel.forward !== undefined) || this.#client !== undefined) {
      await this.#teardown()
    }
  }

  /** Stop (if running) and start again, defaulting to the current device. */
  async restart(udid?: string): Promise<WdaRunningInfo> {
    const device = udid ?? this.#info?.udid ?? this.#lastDevice
    if (device === undefined) {
      throw new Error('dsh-ios: restart requires a device; call ensureRunning first')
    }
    await this.stop()
    // An explicit restart is intentional: don't sit out the crash-quiet period.
    this.#lastStopAt = 0
    return this.ensureRunning({ udid: device })
  }

  /**
   * Re-establish the MJPEG tunnel if it stopped forwarding, without touching
   * the runner.
   *
   * The trap this closes: liveness was tracked on the CONTROL port alone.
   * A phone that re-enumerates over USB can take the video tunnel down while
   * the control tunnel survives — the controller then reports `running` and
   * `ready`, `/grant` happily mints a stream capability, and the panel shows
   * a dead player with nothing anywhere saying why. Observed exactly once the
   * user replugged the phone: iproxy 8100 alive, 9100 gone.
   *
   * Repair is deliberately narrow: the WDA runner on the device is fine and
   * costs MINUTES to rebuild, so only the missing forwarder is respawned.
   * Returns whether a live tunnel exists afterwards.
   */
  async repairStreamTunnel(): Promise<boolean> {
    const info = this.#info
    if (info === undefined || this.#disposed) return false
    const port = this.#mjpegPort
    if (port !== undefined && await probeWdaMjpegTunnel(port)) return true
    return this.#serializeLaunch(async () => {
      const current = this.#info
      if (current === undefined) return false
      // Re-probe inside the queue: a concurrent repair may have just fixed it.
      if (this.#mjpegPort !== undefined && await probeWdaMjpegTunnel(this.#mjpegPort)) return true
      const dead = this.#tunnels.filter(tunnel => tunnel.devicePort === DEVICE_PORT_MJPEG)
      for (const tunnel of dead) {
        if (tunnel.forward !== undefined) await tunnel.forward.close()
        else if (tunnel.child !== undefined) await killProcessGroup(tunnel.child, STOP_TIMEOUT_MS)
      }
      this.#tunnels = this.#tunnels.filter(tunnel => tunnel.devicePort !== DEVICE_PORT_MJPEG)
      const tunnel = await this.#ensureTunnel(current.hardwareUdid, DEVICE_PORT_MJPEG, this.#options.mjpegPortStart, probeWdaMjpegTunnel)
      if (!tunnel.adopted && !await this.#waitForTunnel(probePort => probeWdaMjpegTunnel(probePort), tunnel.localPort, TUNNEL_WAIT_MS)) {
        if (tunnel.forward !== undefined) await tunnel.forward.close()
        else if (tunnel.child !== undefined) await killProcessGroup(tunnel.child, STOP_TIMEOUT_MS)
        this.#noteStderr(`could not re-establish the MJPEG tunnel on 127.0.0.1:${tunnel.localPort}`)
        return false
      }
      this.#tunnels = [...this.#tunnels, tunnel]
      this.#mjpegPort = tunnel.localPort
      this.#info = { ...current, mjpegUrl: `http://127.0.0.1:${tunnel.localPort}/` }
      this.#noteStderr(`re-established the MJPEG tunnel on 127.0.0.1:${tunnel.localPort} (the runner was untouched)`)
      return true
    })
  }

  /** Snapshot of lifecycle state, classification, ports and recent stderr. */
  status(): WdaStatus {
    return {
      available: this.available,
      running: this.running,
      ...(this.#failure === undefined ? {} : { reason: this.#failure.reason, detail: this.#failure.detail }),
      ...(this.#info === undefined
        ? (this.#lastDevice === undefined ? {} : { pendingDevice: this.#lastDevice })
        : { device: this.#info.udid, hardwareUdid: this.#info.hardwareUdid, controlUrl: this.#info.controlUrl, mjpegUrl: this.#info.mjpegUrl }),
      ...(this.#client?.sessionId === undefined ? {} : { sessionId: this.#client.sessionId }),
      ...(this.#controlPort === undefined ? {} : { controlPort: this.#controlPort }),
      ...(this.#mjpegPort === undefined ? {} : { mjpegPort: this.#mjpegPort }),
      ...(this.#adoptedRunner ? { adopted: true } : {}),
      ...(this.#startedAt === undefined ? {} : { startedAt: this.#startedAt }),
      restarts: this.#restarts,
      consumers: this.#consumers,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      stderr: [...this.#stderrRing],
    }
  }

  /**
   * Hold WDA alive for one consumer (the web-route proxy uses this).
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

  /** Release one consumer hold (the interface pairing of `acquire()`). */
  release(): void {
    this.#consumers = Math.max(0, this.#consumers - 1)
    this.#armIdle()
  }

  /** Tear down for plugin disposal: kill children, refuse new work. */
  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposed = true
    this.stopKeepAlive()
    this.#disposePromise = (async () => {
      await this.#starting?.catch(() => {})
      await this.stop()
      await this.#launchQueue
    })()
    return this.#disposePromise
  }

  async #keepAliveTick(): Promise<void> {
    if (this.#disposed) return
    const now = this.#options.now()
    // Adopted WDA: no child exit events exist; probe the control port at a
    // throttled cadence and record a death like a child exit. A single late
    // probe proves nothing — WDA serves serially, so `/status` queues behind
    // in-flight gestures/screenshots. The probe is skipped entirely while a
    // control call is in flight or right after a successful response (a call
    // that just succeeded is better evidence than a fresh probe), and death
    // needs ADOPTED_DEATH_PROBE_FAILURES CONSECUTIVE failures with no
    // successful traffic in between.
    if (this.#adoptedRunner && this.#client !== undefined && !this.#intentionalStop && !this.#probeInFlight
      && this.#controlCallsInFlight === 0
      && now - this.#lastProbeAt >= ADOPTED_PROBE_INTERVAL_MS
      && now - this.#lastOkAt >= ADOPTED_PROBE_INTERVAL_MS) {
      this.#probeInFlight = true
      this.#lastProbeAt = now
      try {
        const port = Number.parseInt(new URL(this.#client.controlUrl).port, 10)
        const alive = Number.isSafeInteger(port) && port > 0 ? await this.#options.probeControl(port) : false
        if (alive) {
          // A fresh probe success IS successful WDA traffic.
          this.#probeOk = true
          this.#noteSuccessfulTraffic()
        } else {
          this.#probeFailStreak = Math.min(this.#probeFailStreak + 1, ADOPTED_DEATH_PROBE_FAILURES)
          if (this.#probeFailStreak >= ADOPTED_DEATH_PROBE_FAILURES) {
            this.#probeOk = false
            if (this.#exitAt === undefined) {
              this.#noteStderr(`adopted WDA no longer answers on ${this.#client.controlUrl} (${ADOPTED_DEATH_PROBE_FAILURES} consecutive failed probes); respawning after the restart delay`)
              this.#exitAt = now
            }
          }
        }
      } finally {
        this.#probeInFlight = false
      }
    }
    const exitAt = this.#exitAt
    const device = this.#lastDevice
    if (exitAt === undefined || this.#intentionalStop || device === undefined) return
    if (now - exitAt < this.#options.restartDelayMs) return
    if (!this.tooling.available) return
    this.#exitAt = undefined
    this.#restarts += 1
    try {
      await this.ensureRunning({ udid: device })
    } catch (error) {
      this.#lastError = errorMessage(error)
      // A failed launch exits again and sets a fresh exitAt via the child's
      // close handler; only re-arm here if nothing recorded an exit.
      if (this.#exitAt === undefined) this.#exitAt = this.#options.now()
    }
  }

  /**
   * Runner + owned tunnels + client + info teardown. Adopted (pre-existing)
   * tunnels are deliberately left alone; adopted runners have no child.
   */
  async #teardown(): Promise<void> {
    const runner = this.#runner
    this.#runner = undefined
    if (runner !== undefined) await killProcessGroup(runner.child, STOP_TIMEOUT_MS)
    for (const tunnel of this.#tunnels) {
      if (tunnel.forward !== undefined) await tunnel.forward.close()
      else if (tunnel.child !== undefined) await killProcessGroup(tunnel.child, STOP_TIMEOUT_MS)
    }
    this.#tunnels = []
    this.#client = undefined
    this.#info = undefined
    this.#startedAt = undefined
    this.#adoptedRunner = false
    this.#probeOk = false
    this.#probeFailStreak = 0
    this.#lastOkAt = 0
  }

  async #startForDevice(device: RealDevice, hardwareUdid: string): Promise<WdaRunningInfo> {
    // Sit out the quiet period after an intentional stop so a racing launch
    // cannot immediately undo it (explicit restart() clears this period).
    const sinceStop = this.#options.now() - this.#lastStopAt
    if (sinceStop < this.#options.restartDelayMs) {
      await sleep(this.#options.restartDelayMs - sinceStop)
    }
    const epoch = this.#launchEpoch
    // The previous attempt's classification DELIBERATELY survives into this
    // one. Blanking it here made the keep-alive loop silence itself: an
    // unplugged phone fails, the retry re-enters and clears the reason, and
    // the panel's 3-second poll then reads a bare "not running" for the whole
    // window — the user is told nothing while the one actionable line
    // ("connect the phone over USB") exists and is already known. A stale
    // reason on a re-attempt is strictly better than no reason at all, and it
    // is cleared the moment this launch succeeds (below) or reclassified the
    // moment the new attempt fails.
    try {
      const adopted = await this.#ensureRunner(device, hardwareUdid)
      if (this.#launchEpoch !== epoch) throw new Error('dsh-ios: wda launch was superseded by stop()')
      const controlTunnel = await this.#ensureTunnel(hardwareUdid, DEVICE_PORT_CONTROL, this.#options.controlPortStart, probeWdaControlTunnel)
      // Register as we create: a failure on ANY later path must reap the
      // tunnel via #teardown. The old code only registered both tunnels on
      // success, so a tunnel we spawned and then failed to use leaked — it
      // survived, squatted its port, and poisoned the next attempt (observed
      // as iproxy 8100, 8101 AND 8102 all pointing at the same device).
      this.#tunnels = [controlTunnel]
      const mjpegTunnel = await this.#ensureTunnel(hardwareUdid, DEVICE_PORT_MJPEG, this.#options.mjpegPortStart, probeWdaMjpegTunnel)
      this.#tunnels = [controlTunnel, mjpegTunnel]
      if (this.#launchEpoch !== epoch) throw new Error('dsh-ios: wda launch was superseded by stop()')
      if (!mjpegTunnel.adopted) {
        // A freshly created tunnel must actually forward before we claim it.
        const forwarding = await this.#waitForTunnel(port => probeWdaMjpegTunnel(port), mjpegTunnel.localPort, TUNNEL_WAIT_MS)
        if (!forwarding) {
          const kind = await this.#options.classifyTunnelFailure(hardwareUdid)
          const detail = usbmuxTunnelFailureDetail(kind)
          this.#failure = { reason: 'tunnel-failed', detail }
          throw new WdaError('tunnel-failed', `dsh-ios: tunnel on 127.0.0.1:${mjpegTunnel.localPort} does not forward the WDA MJPEG stream — ${detail}`)
        }
      }
      const client = new WdaClient(`http://127.0.0.1:${controlTunnel.localPort}`, {
        requestTimeoutMs: this.#options.requestTimeoutMs,
        // Traffic-liveness hook: every successful WDA response refreshes
        // #lastOkAt and resets the probe-failure streak.
        onSuccess: () => this.#noteSuccessfulTraffic(),
      })
      await this.#waitForReady(client, hardwareUdid)
      if (this.#launchEpoch !== epoch) throw new Error('dsh-ios: wda launch was superseded by stop()')
      let sessionId: string
      try {
        sessionId = await client.ensureSession()
      } catch (error) {
        throw new WdaError('wda-not-ready', `dsh-ios: WDA on ${client.controlUrl} is ready but session creation failed: ${errorMessage(error)}`, error)
      }
      this.#client = client
      this.#tunnels = [controlTunnel, mjpegTunnel]
      this.#adoptedRunner = adopted
      this.#probeOk = true
      this.#probeFailStreak = 0
      this.#lastOkAt = this.#options.now()
      this.#controlPort = controlTunnel.localPort
      this.#mjpegPort = mjpegTunnel.localPort
      const info: WdaRunningInfo = {
        udid: device.udid,
        hardwareUdid,
        controlUrl: client.controlUrl,
        mjpegUrl: `http://127.0.0.1:${mjpegTunnel.localPort}/`,
        sessionId,
      }
      this.#info = info
      this.#startedAt = this.#options.now()
      this.#exitAt = undefined
      this.#intentionalStop = false
      this.#failure = undefined
      return info
    } catch (error) {
      // Reap whatever this attempt created so a failed launch leaves nothing
      // behind. The #failure classification set by the runner stays visible.
      await this.#teardown()
      throw error
    }
  }

  /**
   * Make sure one WDA server is alive: adopt an already-running instance
   * (no second xcodebuild is ever spawned while one answers on the default
   * control port), else spawn the blocking `xcodebuild … test` child.
   */
  async #ensureRunner(device: RealDevice, hardwareUdid: string): Promise<boolean> {
    const current = this.#runner
    if (current !== undefined && current.hardwareUdid === hardwareUdid && current.child.exitCode === null && current.child.signalCode === null) {
      return false
    }
    if (await probeWdaControlTunnel(this.#options.controlPortStart)) {
      this.#noteStderr(`adopted an already-running WDA on 127.0.0.1:${this.#options.controlPortStart} — no xcodebuild spawned`)
      return true
    }
    await this.#spawnRunner(device, hardwareUdid)
    return false
  }

  async #resolveTeamId(): Promise<string> {
    const cached = this.#teamIdResolution
    if (cached !== undefined) return cached
    const resolving = (async () => {
      const resolution = await resolveSigningTeam({
        explicit: this.#teamIdSource === 'option' || this.#teamIdSource === 'env'
          ? this.#options.teamId
          : undefined,
        env: process.env.DSH_IOS_TEAM_ID,
        fallback: DEFAULT_TEAM_ID,
      })
      const teamId = resolution.teamId ?? DEFAULT_TEAM_ID
      this.#options.teamId = teamId
      this.#teamIdSource = resolution.source === 'option' || resolution.source === 'env'
        ? resolution.source
        : undefined
      this.#noteStderr(`WDA DEVELOPMENT_TEAM=${teamId} (source: ${resolution.source}) ${resolution.detail}`)
      return teamId
    })()
    this.#teamIdResolution = resolving
    return resolving
  }

  async #spawnRunner(device: RealDevice, hardwareUdid: string): Promise<void> {
    this.#lockedSignatureSeen = false
    const teamId = await this.#resolveTeamId()
    const args = assembleXcodebuildTestArgs(hardwareUdid, { teamId, bundleId: this.#options.bundleId })
    const child = spawn(this.tooling.xcodebuildCommand!, [...this.tooling.xcodebuildPrefix, ...args], {
      cwd: this.#options.wdaProjectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Group leader so stop() reaps the whole xcodebuild process tree.
      detached: true,
    })
    this.#runner = { child, hardwareUdid }
    this.#noteStderr(`xcodebuild ${args.join(' ')} (pid ${child.pid ?? '?'})`)
    child.stderr.on('data', (chunk: Buffer) => {
      this.#recordStderr(chunk, 'wda')
      // The locked-device signature is surfaced as an actionable status while
      // the launch keeps waiting — it recovers by itself once unlocked.
      const chunkReason = classifyWdaFailure(chunk.toString('utf8'))
      if (chunkReason === 'device-locked') {
        // Pin the lock BEFORE the ring can scroll it away: the exit
        // classification only sees the last STDERR_RING_LINES lines, and a
        // build-failure dump can push the lock signature out entirely.
        this.#lockedSignatureSeen = true
        if (this.#failure === undefined) {
          this.#failure = { reason: chunkReason, detail: wdaFailureDetail(chunkReason, device.name, this.#options.startTimeoutMs) }
        }
      }
    })
    child.once('close', () => {
      if (this.#runner?.child !== child) return
      this.#runner = undefined
      if (!this.#intentionalStop) this.#exitAt = this.#options.now()
    })
    try {
      const url = await waitForServerUrlHere(child, this.#options.startTimeoutMs)
      this.#noteStderr(`WDA server ready at ${url} (reachable over the USB tunnel)`)
      if (this.#failure?.reason === 'device-locked') this.#failure = undefined
    } catch (error) {
      await killProcessGroup(child, STOP_TIMEOUT_MS)
      const text = this.#stderrRing.join('\n')
      const exited = child.exitCode !== null || child.signalCode !== null
      // device-locked WINS here too: a lock signature seen on a live chunk
      // stays device-locked even when the ring (last STDERR_RING_LINES lines)
      // now carries only the build-failure tail, and the full ring still wins
      // over the terminal build-failed fallback via classifyWdaFailure's order.
      const reason = this.#lockedSignatureSeen
        ? 'device-locked'
        : classifyWdaFailure(text) ?? (exited ? 'build-failed' : 'launch-timeout')
      // Permanent-ish failures must not arm the keep-alive retry loop (the
      // close handler set #exitAt); transient ones (locked device recovers,
      // timeouts) keep it armed so WDA comes back by itself.
      if (reason === 'cert-untrusted' || reason === 'profile-expired' || reason === 'build-failed' || reason === 'unavailable') {
        this.#exitAt = undefined
      }
      this.#failure = { reason, detail: wdaFailureDetail(reason, device.name, this.#options.startTimeoutMs) }
      const tail = text === '' ? '' : ` — recent output: ${text.slice(-1200)}`
      throw new WdaError(reason, `dsh-ios: WDA failed to start on ${device.name}: ${errorMessage(error)}${tail}`, error)
    }
  }

  /** Ensure one USB tunnel (adopt a pre-existing one, else usbmux forward
   * with an iproxy fallback). */
  async #ensureTunnel(
    udid: string,
    devicePort: number,
    startPort: number,
    probe: (port: number) => Promise<boolean>,
  ): Promise<WdaTunnel> {
    const picked = await pickTunnelPort(startPort, probe)
    if (picked.adopted) {
      this.#noteStderr(`adopted existing USB tunnel 127.0.0.1:${picked.port} → device:${devicePort}`)
      return { localPort: picked.port, devicePort, udid, adopted: true }
    }
    // Prefer speaking usbmux ourselves: the bundled iproxy cannot tell a USB
    // record from a Network record when usbmuxd lists the phone twice, so a
    // Wi-Fi pairing shadows the cable and kills the forward. A direct usbmux
    // Connect pins the USB record by device id instead.
    let forward: UsbmuxForward | undefined
    try {
      forward = await this.#options.makeUsbmuxForward({ udid, devicePort, localPort: picked.port })
    } catch (error) {
      this.#noteStderr(`usbmux forward ${picked.port} failed (${errorMessage(error)}); falling back to iproxy`)
    }
    if (forward !== undefined) {
      this.#noteStderr(`usbmux forward 127.0.0.1:${picked.port} → ${udid}:${devicePort}`)
      return { forward, localPort: picked.port, devicePort, udid, adopted: false }
    }
    const child = spawn(this.tooling.iproxyCommand!, assembleIproxyArgs(picked.port, devicePort, udid), {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    this.#noteStderr(`iproxy ${picked.port} ${devicePort} ${udid} (pid ${child.pid ?? '?'})`)
    child.stderr.on('data', (chunk: Buffer) => this.#recordStderr(chunk, `iproxy(${picked.port})`))
    child.once('error', error => {
      this.#noteStderr(`iproxy ${picked.port} failed: ${errorMessage(error)}`)
    })
    return { child, localPort: picked.port, devicePort, udid, adopted: false }
  }

  async #waitForTunnel(probe: (port: number) => Promise<boolean>, port: number, timeoutMs: number): Promise<boolean> {
    const deadline = this.#options.now() + timeoutMs
    for (;;) {
      if (await probe(port)) return true
      if (this.#options.now() >= deadline) return false
      await sleep(500)
    }
  }

  /** Poll `GET /status` until ready; re-checks USB presence on failures. */
  async #waitForReady(client: WdaClient, hardwareUdid: string): Promise<void> {
    const deadline = this.#options.now() + this.#options.readyTimeoutMs
    let deviceCheckAt = this.#options.now() + 15_000
    for (;;) {
      if (this.#disposed) throw new WdaError('unavailable', 'dsh-ios: wda host is disposed')
      try {
        const health = await client.health()
        if (health.ready) return
        this.#noteStderr(`WDA on ${client.controlUrl} answered but is not ready yet`)
      } catch {
        if (this.#options.now() >= deviceCheckAt) {
          deviceCheckAt = this.#options.now() + 15_000
          try {
            requireAvailable(await getRealDevice(hardwareUdid))
          } catch {
            throw new WdaError('device-unplugged', `dsh-ios: ${hardwareUdid} is no longer available over USB — WDA cannot be reached`)
          }
        }
      }
      if (this.#options.now() >= deadline) {
        throw new WdaError('wda-not-ready', `dsh-ios: WDA on ${client.controlUrl} did not become ready within ${this.#options.readyTimeoutMs} ms`)
      }
      await sleep(1_000)
    }
  }

  /**
   * Hand back the live client. Deliberately does NOT gate on `running` /
   * the cached probe verdict: a keep-alive probe that was late while the
   * device was busy must not block the very call that would prove WDA
   * alive. A genuinely dead WDA surfaces as the real HTTP failure of the
   * call itself (the tools classify it); only a disposed host, a missing
   * client, or an intentional stop throws here.
   */
  #requireClient(): WdaClient {
    if (this.#disposed) throw new Error('dsh-ios: wda host is disposed')
    const client = this.#client
    if (client === undefined || this.#intentionalStop) {
      throw new Error('dsh-ios: WDA is not running; call ensureRunning({ udid }) first')
    }
    return client
  }

  #recordStderr(chunk: Buffer, tag: string): void {
    const text = this.#stderrPartial + chunk.toString('utf8')
    const lines = text.split('\n')
    this.#stderrPartial = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = `${tag} ${line.trimEnd()}`.trim()
      this.#stderrRing.push(trimmed.length > STDERR_LINE_MAX_CHARS ? `${trimmed.slice(0, STDERR_LINE_MAX_CHARS)}…` : trimmed)
      if (this.#stderrRing.length > STDERR_RING_LINES) this.#stderrRing.shift()
    }
  }

  /** Append a controller-authored diagnostic line to the stderr ring. */
  #noteStderr(line: string): void {
    this.#stderrRing.push(line.length > STDERR_LINE_MAX_CHARS ? `${line.slice(0, STDERR_LINE_MAX_CHARS)}…` : line)
    if (this.#stderrRing.length > STDERR_RING_LINES) this.#stderrRing.shift()
  }

  /**
   * Record proof of life from ONE successful WDA response (keep-alive probe
   * or any `WdaClient` call): refresh the traffic clock, reset the probe
   * failure streak, and cancel a pending adopted-death respawn — a WDA that
   * is answering calls is not dead, whatever a late probe said. (Only
   * adopted deaths are probe-driven, so only those are cancelled here.)
   */
  #noteSuccessfulTraffic(): void {
    this.#lastOkAt = this.#options.now()
    this.#probeFailStreak = 0
    if (this.#adoptedRunner) this.#exitAt = undefined
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
