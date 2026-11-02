/** The active Duo guest display, shared by AX, upright screenshots and HID. */
import { execFile } from 'node:child_process'
import type { SimHostController } from './sim-host.js'
import { sendSimGesture } from './sim-gesture.js'
import { isFoldableSimulator, type HingeDevice, type HingePosture } from './hinge.js'

export interface DuoDisplay {
  name: string
  rotation: 'rot0' | 'rot90' | 'rot180' | 'rot270'
  scale: number
  pixels: { width: number; height: number }
  points: { width: number; height: number }
}

export function duoDisplayFromPosture(posture: Pick<HingePosture, 'displays'>): DuoDisplay {
  if (posture.displays.filter(d => d.active).length !== 1) throw new Error('Duo has no unambiguous active display; retry after the screen settles')
  const active = posture.displays.find(d => d.active)
  if (!active || !active.size || active.size.length !== 2 || !active.size.every(n => Number.isFinite(n) && n > 0)
    || !active.scale || !Number.isFinite(active.scale) || active.scale <= 0
    || !['rot0', 'rot90', 'rot180', 'rot270'].includes(active.rotation ?? '') || active.backlight === 'off') {
    throw new Error('Duo active display geometry is unavailable or transitioning; retry after the screen settles')
  }
  const swapped = active.rotation === 'rot90' || active.rotation === 'rot270'
  const pixels = { width: active.size[swapped ? 1 : 0], height: active.size[swapped ? 0 : 1] }
  return { name: active.name, rotation: active.rotation as DuoDisplay['rotation'], scale: active.scale,
    pixels, points: { width: pixels.width / active.scale, height: pixels.height / active.scale } }
}

export async function readDuoDisplay(device: HingeDevice, signal?: AbortSignal): Promise<DuoDisplay | undefined> {
  if (!isFoldableSimulator(device)) return undefined
  // Read display metadata once, without the hinge angle/CoreMotion probe or
  // the shell adapter's per-field plutil subprocesses on every AX/OCR call.
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('xcrun', ['devicectl', 'device', 'info', 'displays', '-d', device.udid, '-q', '-j', '-'],
      { timeout: 15_000, maxBuffer: 1024 * 1024, signal }, (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`Duo display query failed: ${stderr.trim() || error.message}`))
        else resolve(stdout)
      })
  })
  const data = JSON.parse(stdout) as { result?: { displays?: Array<{
    name: string; active: boolean; primary: boolean; backlightState: string;
    currentOrientation: string; nativeSize: number[]; pointScale: number; type?: { integrated?: unknown }
  }> } }
  if (!Array.isArray(data.result?.displays)) throw new Error('Duo display query returned no display metadata')
  return duoDisplayFromPosture({ displays: data.result.displays.filter(d => d.type?.integrated !== undefined).map(d => ({
    name: d.name, active: d.active, primary: d.primary, backlight: d.backlightState,
    rotation: d.currentOrientation, size: d.nativeSize, scale: d.pointScale,
  })) })
}

export function sameDuoDisplay(a: DuoDisplay, b: DuoDisplay): boolean {
  return a.name === b.name && a.rotation === b.rotation && a.scale === b.scale
    && a.pixels.width === b.pixels.width && a.pixels.height === b.pixels.height
}

export async function assertDuoDisplayUnchanged(device: HingeDevice, expected: DuoDisplay, signal?: AbortSignal): Promise<void> {
  const current = await readDuoDisplay(device, signal)
  if (!current || !sameDuoDisplay(current, expected)) {
    throw new Error('Duo active display or orientation changed during this operation; read the current screen and retry. No tap was sent.')
  }
}

/** Upright screenshot / AX display points → native portrait HID, exactly once. */
export function duoRawPoint(display: DuoDisplay, point: { x: number; y: number }): { x: number; y: number } {
  switch (display.rotation) {
    case 'rot90': return { x: point.y, y: 1 - point.x }
    case 'rot270': return { x: 1 - point.y, y: point.x }
    case 'rot180': return { x: 1 - point.x, y: 1 - point.y }
    default: return { ...point }
  }
}

export function requireDuoScreenshotSize(display: DuoDisplay, pixels: { width: number; height: number }): void {
  if (display.pixels.width !== pixels.width || display.pixels.height !== pixels.height) {
    throw new Error('Duo screenshot and active display geometry disagree; retry after the screen settles')
  }
}

/** Send through the exact active session, with the geometry of this observation. */
export async function tapDuoDisplay(host: SimHostController, device: HingeDevice, display: DuoDisplay,
  point: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
  if (![point.x, point.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
    throw new Error('Duo tap lies outside the active display')
  }
  const status = host.status()
  if (status.running && status.device !== device.udid) throw new Error('select the Duo before tapping; another simulator is streaming')
  const stream = await host.ensureRunning({ udid: device.udid })
  const release = host.acquire()
  try {
    await assertDuoDisplayUnchanged(device, display, signal)
    signal?.throwIfAborted()
    const raw = duoRawPoint(display, point)
    await sendSimGesture(stream.wsUrl, [raw, raw], { stepMs: 50 })
  } finally { release() }
}
