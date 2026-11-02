/** Scoped preload for the owned serve-sim child. Some Xcode 27.1 builds lack
 * `devicectl device motion hinge-angle`. Read the same real CoreMotion sensor
 * inside the simulator instead. No default angle and no HID write is used.
 * Keep every other child-process invocation unchanged. */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
const originalSpawn = childProcess.spawn
const hinge = fileURLToPath(new URL('./hinge', import.meta.url))
export function hingeMonitorArgs(command, args) {
  if (command !== '/usr/bin/xcrun' || !Array.isArray(args) || args.slice(0,4).join(' ') !== 'devicectl device motion hinge-angle') return undefined
  const udid = args[args.indexOf('--device') + 1]
  return typeof udid === 'string' && /^[0-9a-f-]{36}$/i.test(udid) ? [hinge, '-d', udid, 'watch'] : undefined
}
childProcess.spawn = function(command, args, options) {
  const replacement = hingeMonitorArgs(command, args)
  return replacement ? originalSpawn('/bin/bash', replacement, options) : originalSpawn(command, args, options)
}
syncBuiltinESMExports()
