/**
 * Device-level actions that are not touches: the App Switcher, Lock/Unlock,
 * Shake, Siri, the Action button, and window re-centering.
 *
 * Each action names HOW it is delivered, because the three mechanisms have
 * very different costs and were each established by experiment:
 *
 * - `serve-sim` — a hardware-button frame through the stream helper. Fast
 *   (~280 ms) and never touches macOS focus. Verified working for `home` and
 *   `lock`; `siri`/`shake`/`appswitcher` are ACCEPTED by the CLI and silently
 *   do nothing, which is why they are not routed here.
 * - `menu` — click an item in Simulator.app's `Device` menu. Verified: it only
 *   fires while Simulator is FRONTMOST (a background click/AXPress is a
 *   no-op), so the helper raises it, clicks, and hands focus straight back —
 *   a ~0.6 s blip. This is the only way to reach the App Switcher: the swipe
 *   that opens it on a real device cannot be synthesized through serve-sim's
 *   touch channel (tried at 280 ms, 30 ms and 8 ms event spacing with a
 *   jittered 1 s dwell — a mid-screen drag scrolls fine, but a touch starting
 *   in the home-indicator strip is swallowed by the system gesture
 *   recognizer).
 * - `keystroke` — a key combination delivered to the focused Simulator. Used
 *   for Unlock, which has no menu item: ⇧⌘H twice in a row dismisses the lock
 *   screen (verified), and without it `lock` would be a one-way trip — the
 *   swipe-up-to-unlock is swallowed exactly like the App Switcher gesture.
 *
 * DELIBERATELY ABSENT: `Restart` and `Erase All Content and Settings…`. Both
 * exist in the same menu, both are irreversible from a panel click, and
 * neither belongs one stray click away from a live session.
 *
 * @module @zseven-w/dsh-ios/device-actions
 */

import { execFile } from 'node:child_process'

/** How long any AppleScript may take before it is killed. */
const OSASCRIPT_TIMEOUT_MS = 8_000

/** Every device action the panel and the tools may ask for. */
export const DEVICE_ACTIONS = [
  'app-switcher',
  'lock',
  'unlock',
  'shake',
  'siri',
  'action-button',
  're-center',
] as const

export type DeviceAction = typeof DEVICE_ACTIONS[number]

export function isDeviceAction(value: unknown): value is DeviceAction {
  return typeof value === 'string' && (DEVICE_ACTIONS as readonly string[]).includes(value)
}

/** How one action reaches the simulator. */
export type DeviceActionTransport =
  | { kind: 'serve-sim'; button: string }
  | { kind: 'menu'; item: string }
  | { kind: 'keystroke'; repeat: number }

export interface DeviceActionSpec {
  action: DeviceAction
  transport: DeviceActionTransport
  /** True when the phone (WebDriverAgent) can do it too. */
  realDevice: boolean
}

/**
 * The action table. `realDevice` records what WDA can actually deliver: the
 * switcher (a dwelling drag), lock/unlock (`/wda/lock`, `/wda/unlock`) and
 * Siri (`/wda/siri/activate`). Shake, the Action button and window
 * re-centering are simulator-window concepts with no device equivalent.
 */
export const DEVICE_ACTION_SPECS: readonly DeviceActionSpec[] = [
  { action: 'app-switcher', transport: { kind: 'menu', item: 'App Switcher' }, realDevice: true },
  { action: 'lock', transport: { kind: 'serve-sim', button: 'lock' }, realDevice: true },
  // ⇧⌘H twice: the lock screen has no menu item, and the swipe is unusable.
  { action: 'unlock', transport: { kind: 'keystroke', repeat: 2 }, realDevice: true },
  { action: 'shake', transport: { kind: 'menu', item: 'Shake' }, realDevice: false },
  { action: 'siri', transport: { kind: 'menu', item: 'Siri' }, realDevice: true },
  { action: 'action-button', transport: { kind: 'menu', item: 'Action Button' }, realDevice: false },
  { action: 're-center', transport: { kind: 'menu', item: 'Re-Center Open Apps' }, realDevice: false },
]

export function deviceActionSpec(action: DeviceAction): DeviceActionSpec {
  const spec = DEVICE_ACTION_SPECS.find(entry => entry.action === action)
  /* v8 ignore next -- every DeviceAction has a spec; the union guarantees it. */
  if (spec === undefined) throw new Error(`dsh-ios: unknown device action ${action}`)
  return spec
}

/** Actionable text for the failures a user can fix. */
export const DEVICE_ACTION_PERMISSION_HINT =
  'macOS needs permission to drive Simulator.app: System Settings ▸ Privacy & Security ▸ Accessibility, '
  + 'then enable the app running DSH (Terminal / iTerm / your editor)'

export const DEVICE_ACTION_SIMULATOR_HINT =
  'the Simulator app is not running — boot a simulator first (ios_sim_boot)'

/** Classify an osascript failure into something the caller can act on. */
export function deviceActionFailureHint(message: string): string {
  if (/simulator-not-running/.test(message)) return DEVICE_ACTION_SIMULATOR_HINT
  if (/not allowed assistive|osascript is not allowed|-1719|1002|assistive access/i.test(message)) {
    return DEVICE_ACTION_PERMISSION_HINT
  }
  if (/menu-item-missing/.test(message)) {
    return 'this Xcode\'s Simulator has no such Device menu item — the action is unavailable on this host'
  }
  if (/simulator-not-frontmost/.test(message)) {
    return 'Simulator.app would not come to the front — another app may be holding focus; try again'
  }
  return message
}

/** AppleScript literal, single-quoted safely for embedding. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The shared shape: remember who is frontmost, raise Simulator, do the thing,
 * hand focus back. `frontmost of process` is restored rather than `activate`d
 * so a non-scriptable window (a browser tab, a terminal) also returns.
 */
function focusedSimulatorScript(body: string): string {
  return `
tell application "System Events"
  if not (exists process "Simulator") then error "dsh-ios: simulator-not-running"
  set previousName to ""
  try
    set previousName to name of first process whose frontmost is true
  end try
  tell application "Simulator" to activate
  set raised to false
  repeat 40 times
    if frontmost of process "Simulator" then
      set raised to true
      exit repeat
    end if
    delay 0.05
  end repeat
  if not raised then error "dsh-ios: simulator-not-frontmost"
${body}
  delay 0.15
  if previousName is not "" and previousName is not "Simulator" then
    try
      set frontmost of process previousName to true
    end try
  end if
end tell
`
}

/** Click one `Device` menu item by its exact English title. */
export function simulatorMenuItemScript(item: string): string {
  return focusedSimulatorScript(`  tell process "Simulator"
    if not (exists menu item ${appleScriptString(item)} of menu 1 of menu bar item "Device" of menu bar 1) then error "dsh-ios: menu-item-missing"
    click menu item ${appleScriptString(item)} of menu 1 of menu bar item "Device" of menu bar 1
  end tell`)
}

/** Press ⇧⌘H `repeat` times (key code 4 = H). */
export function simulatorHomeKeystrokeScript(repeat: number): string {
  const presses = Array.from({ length: Math.max(1, repeat) }, (_, index) =>
    `  key code 4 using {command down, shift down}${index + 1 < repeat ? '\n  delay 0.25' : ''}`).join('\n')
  return focusedSimulatorScript(presses)
}

function runOsascript(script: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      const detail = `${stderr === '' ? error.message : stderr}`.trim()
      reject(new Error(detail))
    })
  })
}

/**
 * Run one device action against the booted simulator. `pressButton` is the
 * serve-sim path, injected so the caller owns the stream helper (and so this
 * module stays testable without one).
 */
export async function runSimulatorDeviceAction(
  action: DeviceAction,
  pressButton: (name: string) => Promise<void>,
  timeoutMs: number = OSASCRIPT_TIMEOUT_MS,
): Promise<void> {
  const spec = deviceActionSpec(action)
  try {
    if (spec.transport.kind === 'serve-sim') {
      await pressButton(spec.transport.button)
      return
    }
    const script = spec.transport.kind === 'menu'
      ? simulatorMenuItemScript(spec.transport.item)
      : simulatorHomeKeystrokeScript(spec.transport.repeat)
    await runOsascript(script, timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`dsh-ios: the ${action} action failed — ${deviceActionFailureHint(message)}`)
  }
}
