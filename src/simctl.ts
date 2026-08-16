/**
 * Thin typed wrappers over `xcrun simctl` for host-side simulator lifecycle.
 *
 * These helpers enumerate/boot/shutdown devices, capture screenshots, and
 * install/launch apps; every interaction with the streamed simulator UI goes
 * through `serve-sim` (see sim-host.ts).
 * @module @zseven-w/dsh-ios/simctl
 */

import { execFile } from 'node:child_process'

/** One available simulator device as reported by `simctl list devices`. */
export interface SimulatorDevice {
  udid: string
  name: string
  /** Runtime identifier, e.g. `com.apple.CoreSimulator.SimRuntime.iOS-26-4`. */
  runtime: string
  state: string
}

/** Error raised when an `xcrun simctl` invocation fails. */
export class SimctlError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code?: string | number,
  ) {
    super(message)
    this.name = 'SimctlError'
  }
}

const SIMCTL_LIST_TIMEOUT_MS = 30_000
const SIMCTL_BOOT_TIMEOUT_MS = 60_000
const SIMCTL_BOOTSTATUS_TIMEOUT_MS = 240_000
const SIMCTL_SHUTDOWN_TIMEOUT_MS = 60_000
const SIMCTL_SCREENSHOT_TIMEOUT_MS = 60_000
const SIMCTL_INSTALL_TIMEOUT_MS = 180_000
const SIMCTL_LAUNCH_TIMEOUT_MS = 60_000
const SIMCTL_CONTAINER_TIMEOUT_MS = 30_000
const SIMCTL_TERMINATE_TIMEOUT_MS = 30_000
const SIMCTL_UNINSTALL_TIMEOUT_MS = 60_000
const SIMCTL_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/** Run `xcrun simctl <args>` and resolve its stdout, with a typed failure. */
function execSimctl(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('xcrun', ['simctl', ...args], {
      timeout: timeoutMs,
      maxBuffer: SIMCTL_MAX_BUFFER_BYTES,
      signal,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim()
        reject(new SimctlError(
          `simctl ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`,
          stderr,
          error.code,
        ))
        return
      }
      resolve(stdout)
    })
  })
}

interface SimctlDeviceEntry {
  udid: string
  name: string
  state: string
  isAvailable?: boolean
}

/** True when simctl reports the device is already in the wanted boot state. */
function alreadyInState(stderr: string, state: 'Booted' | 'Shutdown'): boolean {
  return stderr.includes(`current state: ${state}`) || stderr.includes(`Unable to ${state === 'Booted' ? 'boot' : 'shutdown'} device in current state`)
}

/**
 * List every *available* simulator device as `{ udid, name, runtime, state }`.
 * Unavailable devices (mismatched runtime, corrupt, …) are skipped.
 */
export async function listDevices(): Promise<SimulatorDevice[]> {
  const stdout = await execSimctl(['list', 'devices', '--json'], SIMCTL_LIST_TIMEOUT_MS)
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new SimctlError(
      `simctl list devices returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      stdout,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SimctlError('simctl list devices returned an unexpected shape', stdout)
  }
  const runtimes = (parsed as { devices?: unknown }).devices
  if (typeof runtimes !== 'object' || runtimes === null || Array.isArray(runtimes)) {
    throw new SimctlError('simctl list devices is missing its devices map', stdout)
  }
  const devices: SimulatorDevice[] = []
  for (const [runtime, entries] of Object.entries(runtimes as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const device = entry as unknown as SimctlDeviceEntry
      if (device.isAvailable !== true) continue
      if (typeof device.udid !== 'string' || typeof device.name !== 'string' || typeof device.state !== 'string') continue
      devices.push({ udid: device.udid, name: device.name, runtime, state: device.state })
    }
  }
  return devices
}

/**
 * Boot `udid` and block until it has finished booting.
 * Tolerates a device that is already booted (boot → bootstatus returns fast).
 */
export async function bootDevice(udid: string): Promise<void> {
  await execSimctl(['boot', udid], SIMCTL_BOOT_TIMEOUT_MS).catch(error => {
    if (error instanceof SimctlError && alreadyInState(error.stderr, 'Booted')) return
    throw error
  })
  await execSimctl(['bootstatus', udid, '-b'], SIMCTL_BOOTSTATUS_TIMEOUT_MS)
}

/** Shut `udid` down; tolerates a device that is already shut down. */
export async function shutdownDevice(udid: string): Promise<void> {
  await execSimctl(['shutdown', udid], SIMCTL_SHUTDOWN_TIMEOUT_MS).catch(error => {
    if (error instanceof SimctlError && alreadyInState(error.stderr, 'Shutdown')) return
    throw error
  })
}

/** All available devices currently in the `Booted` state. */
export async function bootedDevices(): Promise<SimulatorDevice[]> {
  return (await listDevices()).filter(device => device.state === 'Booted')
}

/** Order runtime identifiers newest-first (numeric-aware segment compare). */
export function compareRuntimesDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true })
}

/**
 * Resolve a user-supplied device reference (UDID or case-insensitive device
 * name) to one available device. A name matching several runtimes prefers a
 * booted device, then the newest runtime. Unknown references fail with a
 * short list of the available devices for the model to correct itself.
 */
export async function getDevice(reference: string): Promise<SimulatorDevice> {
  const trimmed = reference.trim()
  if (trimmed === '') throw new SimctlError('simulator reference must be a non-empty udid or device name', '')
  const devices = await listDevices()
  const byUdid = devices.find(device => device.udid === trimmed)
  if (byUdid !== undefined) return byUdid
  const byName = devices.filter(device => device.name.toLowerCase() === trimmed.toLowerCase())
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    const booted = byName.find(device => device.state === 'Booted')
    if (booted !== undefined) return booted
    return byName.sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))[0]
  }
  const names = devices
    .sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))
    .slice(0, 8)
    .map(device => `${device.name} (${device.runtime})`)
  throw new SimctlError(
    `unknown simulator "${trimmed}" — run ios_sim_devices to list available devices`
      + (names.length === 0 ? '' : `; available include: ${names.join(', ')}`),
    '',
  )
}

/** Capture the device screen into `filePath` (`simctl io <udid> screenshot`). */
export async function takeScreenshot(udid: string, filePath: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['io', udid, 'screenshot', filePath], SIMCTL_SCREENSHOT_TIMEOUT_MS, signal)
}

/** Install a built `.app` bundle on the simulator. */
export async function installApp(udid: string, appPath: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['install', udid, appPath], SIMCTL_INSTALL_TIMEOUT_MS, signal)
}

/** Launch an installed app; resolves the `simctl launch` stdout (contains the pid). */
export async function launchApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<string> {
  return execSimctl(['launch', udid, bundleId], SIMCTL_LAUNCH_TIMEOUT_MS, signal)
}

/**
 * Absolute host path of the app's data container
 * (`simctl get_app_container <udid> <bundleId> data`). The returned path is
 * on the Mac filesystem, so plugin code can read/write the app's sandbox
 * directly (used by the preview host's drop directory).
 */
export async function getAppContainer(udid: string, bundleId: string, signal?: AbortSignal): Promise<string> {
  const stdout = await execSimctl(['get_app_container', udid, bundleId, 'data'], SIMCTL_CONTAINER_TIMEOUT_MS, signal)
  const path = stdout.trim()
  if (path === '') throw new SimctlError(`simctl get_app_container returned no path for ${bundleId}`, stdout)
  return path
}

/** Terminate a running app; resolves `simctl terminate` stdout (contains the pid). */
export async function terminateApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<string> {
  return execSimctl(['terminate', udid, bundleId], SIMCTL_TERMINATE_TIMEOUT_MS, signal)
}

/** Uninstall an app (removes its data container as well). */
export async function uninstallApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['uninstall', udid, bundleId], SIMCTL_UNINSTALL_TIMEOUT_MS, signal)
}
