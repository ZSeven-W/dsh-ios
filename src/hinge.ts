/** iPhone Duo simulator hinge adapter. Physical hinges cannot be actuated. */
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { pluginEnv } from './plugin-env.js'
import type { SimHostController } from './sim-host.js'
import { sendSimFold, sendSimOrientation } from './sim-gesture.js'
import { withSimDeviceMutation } from './sim-device-operations.js'

export interface HingeDevice {
  udid: string
  name: string
  state: string
  deviceTypeIdentifier?: string
}

export interface HingePosture {
  angle: number
  activeDisplay: string
  displays: Array<{ name: string; primary: boolean; active: boolean; backlight: string; id?: number; rotation?: string; size?: number[]; scale?: number }>
}

export type HingeAction = 'status' | 'fold' | 'unfold' | 'half' | 'set' | 'portrait' | 'landscape'
export interface HingeArgs { action?: HingeAction; angle?: number }

export function isFoldableSimulator(device: HingeDevice): boolean {
  return device.deviceTypeIdentifier !== undefined
    ? /\.iPhone-Duo(?:$|-)/i.test(device.deviceTypeIdentifier)
    : /\biPhone Duo\b/i.test(device.name)
}

export function hingeTargetAngle(args: HingeArgs): number | undefined {
  const action = args.action ?? 'status'
  if (!['status', 'fold', 'unfold', 'half', 'set', 'portrait', 'landscape'].includes(action)) throw new Error('unknown hinge action')
  if (action !== 'set' && args.angle !== undefined) throw new Error('angle is only accepted with action "set"')
  if (action === 'status' || action === 'portrait' || action === 'landscape') return undefined
  if (action === 'fold') return 0
  if (action === 'unfold') return 180
  if (action === 'half') return 90
  if (typeof args.angle !== 'number' || !Number.isFinite(args.angle) || args.angle < 0 || args.angle > 180) {
    throw new Error('hinge angle must be a finite number from 0 to 180')
  }
  return args.angle
}

function runHinge(udid: string, args: string[], signal?: AbortSignal): Promise<string> {
  const override = pluginEnv('IOS_HINGE_BIN')
  const script = fileURLToPath(new URL('../assets/hinge/hinge', import.meta.url))
  const command = override || '/bin/bash'
  const argv = [...(override ? [] : [script]), '--device', udid, ...args]
  return new Promise((resolve, reject) => {
    execFile(command, argv, { timeout: 60_000, maxBuffer: 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`iPhone Duo hinge failed: ${stderr.trim() || error.message}. `
          + 'Requires macOS, Xcode 27.1+ and a booted iPhone Duo simulator. Physical devices are unsupported.'))
      } else resolve(stdout)
    })
  })
}

export function parseHingePosture(stdout: string): HingePosture {
  const value = JSON.parse(stdout) as Partial<HingePosture> | null
  if (value === null || typeof value !== 'object' || typeof value.angle !== 'number'
    || !Number.isFinite(value.angle) || value.angle < 0 || value.angle > 180
    || typeof value.activeDisplay !== 'string' || !Array.isArray(value.displays)
    || !value.displays.every(d => d !== null && typeof d === 'object'
      && typeof d.name === 'string' && typeof d.primary === 'boolean'
      && typeof d.active === 'boolean' && typeof d.backlight === 'string')
    || value.displays.filter(d => d.active).length !== 1
    || !value.displays.some(d => d.active && d.name === value.activeDisplay)) {
    throw new Error('hinge posture is unavailable or has no unambiguous active display; no fold was verified')
  }
  return value as HingePosture
}

let helperPathPromise: Promise<string> | undefined
function query(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000, maxBuffer: 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Duo readback failed: ${stderr.trim() || error.message}`))
      else resolve(stdout)
    })
  })
}

interface AngleChannel {
  read: (signal?: AbortSignal) => Promise<string>
  close: () => void
}
const angleChannels = new Map<string, AngleChannel>()
/** One idle-bounded, read-only helper per device. Sensor samples are NEVER
 * cached. Requests serialize so cancellation cannot consume another reply. */
function angleChannel(udid: string, helper: string): AngleChannel {
  const existing = angleChannels.get(udid)
  if (existing) return existing
  const child = spawn('xcrun', ['simctl', 'spawn', udid, helper, 'serve'], { stdio: 'pipe' })
  let queue: Promise<unknown> = Promise.resolve(), closed = false, buffer = ''
  let pending: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  let readyResolve!: () => void, readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  void ready.catch(() => {})
  // simctl spawn can take more than 5s under host load. Do not spend the
  // sensor's sample budget before the guest has even started reading stdin.
  const startup = setTimeout(() => close(new Error('Duo angle sensor startup timed out; retry when the simulator is ready')), 15_000)
  const close = (reason = new Error('Duo angle sensor transport closed; retry the operation')): void => {
    if (closed) return
    closed = true
    clearTimeout(idle)
    clearTimeout(startup)
    readyReject(reason)
    if (angleChannels.get(udid) === channel) angleChannels.delete(udid)
    process.off('exit', onExit)
    const request = pending; pending = undefined
    request?.reject(reason)
    child.stdin.end(); child.kill()
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > 1024) { close(); return }
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
      if (line === 'READY') { clearTimeout(startup); readyResolve(); continue }
      const request = pending; pending = undefined
      if (!request) { close(); return }
      if (!/^\d+(?:\.\d+)?$/.test(line) || Number(line) > 180) {
        request.reject(new Error('Duo angle sensor returned no valid fresh sample')); close(); return
      }
      request.resolve(line)
    }
  })
  child.stderr.resume()
  child.on('error', () => close()); child.on('exit', () => close()); child.stdin.on('error', () => close())
  child.unref()
  for (const pipe of [child.stdin, child.stdout, child.stderr]) (pipe as typeof pipe & { unref?: () => void }).unref?.()
  const onExit = (): void => close()
  process.once('exit', onExit)
  const channel: AngleChannel = { close, read(signal) {
    const result = queue.catch(() => {}).then(async () => {
      signal?.throwIfAborted()
      if (closed) throw new Error('Duo angle sensor transport closed')
      clearTimeout(idle)
      const abort = (): void => close()
      signal?.addEventListener('abort', abort, { once: true })
      try {
        await ready
        signal?.throwIfAborted()
        return await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => close(new Error('Duo angle sensor sample timed out; retry the operation')), 5_000)
          pending = {
            resolve(value) { clearTimeout(timer); resolve(value) },
            reject(error) { clearTimeout(timer); reject(error) },
          }
          child.stdin.write('get\n')
        })
      } finally {
        signal?.removeEventListener('abort', abort)
        // Keep the read-only, blocked-on-stdin helper warm between occasional
        // folds. No sensor polling or cached angle is introduced.
        if (!closed) { idle = setTimeout(close, 300_000); idle.unref() }
      }
    })
    queue = result
    return result
  } }
  angleChannels.set(udid, channel)
  return channel
}

/** Fresh sensor and display reads, without dozens of shell/plutil children.
 * Cache only the signed helper's path, never the angle or active display. */
export async function readHingePosture(device: HingeDevice, signal?: AbortSignal): Promise<HingePosture> {
  return readHingeSample(device, signal)
}

/** Share only a global orientation lookup within one action. The real hinge
 * sensor and integrated display/backlight metadata remain fresh every poll. */
async function readHingeSample(device: HingeDevice, signal?: AbortSignal,
  orientationRead?: Promise<string>): Promise<HingePosture> {
  signal?.throwIfAborted()
  if (pluginEnv('IOS_HINGE_BIN')) return parseHingePosture(await runHinge(device.udid, ['posture', '--json'], signal))
  helperPathPromise ??= runHinge(device.udid, ['helper-path']).then(path => path.trim()).catch(error => {
    helperPathPromise = undefined
    throw error
  })
  const sensor = helperPathPromise.then(path => {
    signal?.throwIfAborted()
    return angleChannel(device.udid, path).read(signal)
  })
  const [angle, displays, orientation] = await Promise.all([
    sensor,
    query('xcrun', ['devicectl', 'device', 'info', 'displays', '-d', device.udid, '-q', '-j', '-'], signal),
    orientationRead ?? query('xcrun', ['devicectl', 'device', 'orientation', 'get', '-d', device.udid, '-q', '-j', '-'], signal),
  ])
  const integrated = (JSON.parse(displays).result?.displays ?? []).filter((d: { type?: { integrated?: unknown } }) => d.type?.integrated !== undefined)
  const rows = integrated.map((d: Record<string, unknown>) => ({
    name: d.name, id: d.displayId, primary: d.primary, active: d.active,
    backlight: d.backlightState, rotation: d.currentOrientation, size: d.nativeSize, scale: d.pointScale,
  }))
  return parseHingePosture(JSON.stringify({
    angle: angle.trim() === '' ? null : Number(angle),
    orientation: JSON.parse(orientation).result?.deviceOrientation,
    activeDisplay: rows.find((d: { active?: unknown }) => d.active === true)?.name,
    displays: rows,
  }))
}

const queues = new Map<string, Promise<unknown>>()
/** Serialize each device across readback, mutation and screenshot capture. */
async function serial<T>(udid: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(udid) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(action)
  queues.set(udid, current)
  try { return await current }
  finally { if (queues.get(udid) === current) queues.delete(udid) }
}

export async function runHingeAction(device: HingeDevice, args: HingeArgs, signal?: AbortSignal,
  setStreamAngle?: (angle: number) => Promise<void>, setStreamOrientation?: (orientation: string) => Promise<void>) {
  const target = hingeTargetAngle(args)
  const requestedOrientation = args.action === 'portrait' || args.action === 'landscape' ? args.action : undefined
  if (!isFoldableSimulator(device)) {
    if (target !== undefined || requestedOrientation) throw new Error('hinge control requires an iPhone Duo simulator; this device has no supported hinge')
    return { supported: false as const, device: { udid: device.udid, name: device.name } }
  }
  if (device.state !== 'Booted') throw new Error('boot the iPhone Duo simulator before using its hinge')
  const perform = async () => {
    let rotatingDisplay: string | undefined
    if (requestedOrientation) {
      if (!setStreamOrientation) throw new Error('Duo rotation requires the active simulator control session')
      const before = await readHingeSample(device, signal)
      rotatingDisplay = before.activeDisplay
      const active = before.displays.find(d => d.active)!
      // The inner panel's natural axis is offset by 90 degrees. Select a
      // physical pose that produces the requested UPRIGHT active display.
      const physical = active.primary
        ? requestedOrientation === 'portrait' ? 'portrait' : 'landscape_left'
        : requestedOrientation === 'portrait' ? 'landscape_right' : 'portrait'
      await setStreamOrientation(physical)
    }
    if (target !== undefined) {
      signal?.throwIfAborted()
      // The active serve-sim session owns the guest HID services. Use its
      // acknowledged fold command rather than competing with a legacy HID
      // helper. Devices without a stream keep the standalone transport.
      if (setStreamAngle !== undefined) await setStreamAngle(target)
      else await runHinge(device.udid, ['set', String(target)], signal)
    }
    // Guest display/backlight transitions can trail CoreMotion by several
    // seconds under simulator load (observed beyond 4s on the main panel).
    // Keep verification bounded, but do not reject an ordinary slow switch.
    const started = Date.now()
    const deadline = started + 12_000
    signal?.throwIfAborted()
    const orientationRead = pluginEnv('IOS_HINGE_BIN') ? undefined
      : query('xcrun', ['devicectl', 'device', 'orientation', 'get', '-d', device.udid, '-q', '-j', '-'], signal)
    // A cancellation before the first sample must not leave this eagerly
    // started lookup unobserved. Promise.all below still propagates failure.
    void orientationRead?.catch(() => {})
    let posture: HingePosture
    do {
      posture = await readHingeSample(device, signal, orientationRead)
      const active = posture.displays.find(d => d.active)!
      const swapped = active.rotation === 'rot90' || active.rotation === 'rot270'
      const width = active.size?.[swapped ? 1 : 0]
      const height = active.size?.[swapped ? 0 : 1]
      const displayOrientation = width && height ? width > height ? 'landscape' : 'portrait' : undefined
      const orientationConfirmed = !requestedOrientation || (displayOrientation === requestedOrientation
        && posture.activeDisplay === rotatingDisplay && active.backlight !== 'off')
      const angleConfirmed = target === undefined || Math.abs(posture.angle - target) <= 1
      const displayConfirmed = target === undefined || (target !== 0 && target !== 180)
        || (target === 0 ? active.primary : !active.primary)
      if (angleConfirmed && displayConfirmed && orientationConfirmed && (target === undefined || active.backlight !== 'off')) {
        return {
          supported: true as const,
          device: { udid: device.udid, name: device.name },
          ...posture,
          ...(displayOrientation ? { displayOrientation } : {}),
          ...(requestedOrientation ? { requestedOrientation, orientationConfirmed: true } : {}),
          ...(target === undefined ? {} : { requestedAngle: target, angleConfirmed: true,
            ...(target === 0 || target === 180 ? { displayConfirmed: true } : {}) }),
        }
      }
      if (Date.now() >= deadline) break
      await delay(Date.now() - started < 2_000 ? 75 : 250, undefined, { signal })
    } while (true)
    if (requestedOrientation) throw new Error(`Duo rotation unconfirmed: requested ${requestedOrientation}, active display ${posture.activeDisplay}. Read the current screen and retry; orientation lock or a display switch may prevent rotation.`)
    throw new Error(`hinge change unconfirmed: requested ${target}°, observed ${posture.angle}°, `
      + `active display ${posture.activeDisplay}. The angle and active display are separate; no success was reported.`)
  }
  return serial(device.udid, () => target === undefined && !requestedOrientation ? perform() : withSimDeviceMutation(device.udid, signal, perform))
}

/** Production controls always use the native session, including cold starts.
 * A stale panel must not take over another simulator's stream slot. */
export async function runStreamHingeAction(host: SimHostController, device: HingeDevice,
  args: HingeArgs, signal?: AbortSignal) {
  const control = async (send: (wsUrl: string) => Promise<void>): Promise<void> => {
    signal?.throwIfAborted()
    const status = host.status()
    if (status.running && status.device !== device.udid) {
      throw new Error('Select the iPhone Duo in the device picker before adjusting its hinge; another simulator is streaming.')
    }
    const stream = await host.ensureRunning({ udid: device.udid })
    signal?.throwIfAborted()
    const release = host.acquire()
    try { await send(stream.wsUrl) }
    finally { release() }
  }
  return runHingeAction(device, args, signal,
    angle => control(url => sendSimFold(url, angle, signal)),
    orientation => control(url => sendSimOrientation(url, orientation, signal)))
}

/** The bundled CLI picks the display that actually hosts the UI. */
export async function takeHingeScreenshot(udid: string, path: string, signal?: AbortSignal): Promise<void> {
  await serial(udid, async () => { await runHinge(udid, ['screenshot', path], signal) })
}
