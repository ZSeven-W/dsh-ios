/**
 * Development smoke test for the dsh-ios SwiftUI preview hot-reload tool.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-preview-smoke.mjs
 *
 * Boots a real simulator (allowed). Steps (PASS/FAIL per step, non-zero
 * exit if any step fails):
 *   1.  factory produces the ios_sim_preview tool with the right contract
 *   2.  a temp Swift package with #Preview + PreviewProvider is created
 *   3.  start: host app installed + launched, stream running, watching on
 *   4.  edit the package source → generation advances within 15 s WITHOUT
 *       relaunching (result.json pid unchanged — the hot-swap proof)
 *   5.  syntax error → status reports compiler errors, session still alive
 *   6.  fix → session recovers (generation advances again)
 *   7.  single-session guard: second start fails 409-style
 *   8.  stop → host terminated/uninstalled, watcher gone, stream released,
 *       booted-by-smoke simulators shut down, no leftovers
 *
 * Set DSH_IOS_SMOKE_SKIP_SIM=1 to run only the tool-contract part (no
 * simulator is booted).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_SIM = process.env.DSH_IOS_SMOKE_SKIP_SIM === '1'

const {
  bootDevice,
  bootedDevices,
  getAppContainer,
  listDevices,
  shutdownDevice,
} = await import(join(root, 'lib', 'simctl.js'))
const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))
const { createSimPreviewTools, IOS_PREVIEW_TOOL_NAMES } = await import(join(root, 'lib', 'tool-preview.js'))
const { PREVIEW_HOST_BUNDLE_ID } = await import(join(root, 'lib', 'preview-host.js'))

const results = []
function step(name, ok, detail = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  results.push({ name, ok })
  console.log(`${verdict} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
function skipped(name, detail = '') {
  results.push({ name, ok: true })
  console.log(`SKIP ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Minimal execution context for calling ToolDefinition.execute directly. */
function makeExec(toolName, args) {
  return {
    callId: `smoke-${toolName}`,
    rootCallId: `smoke-${toolName}`,
    name: toolName,
    arguments: args,
    signal: new AbortController().signal,
  }
}

async function pollUntil(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

function watcherCount() {
  if (typeof process.getActiveResourcesInfo !== 'function') return undefined
  // fs.watch reports as FSEventWrap on macOS, FSWatcher elsewhere.
  return process.getActiveResourcesInfo().filter(resource => resource === 'FSWatcher' || resource === 'FSEventWrap').length
}

function readHostResult(container) {
  try {
    return JSON.parse(readFileSync(join(container, 'Documents', 'dsh-preview-drop', 'result.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function listAppsContains(udid, bundleId) {
  try {
    const out = execFileSync('xcrun', ['simctl', 'listapps', udid], { encoding: 'utf8', timeout: 30_000 })
    return out.includes(bundleId)
  } catch {
    return false
  }
}

function pgrepServeSim() {
  try {
    return execFileSync('pgrep', ['-fl', 'serve-sim'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return ''
  }
}

let controller
let tools
let udid
let deviceName
let bootedBySmoke = false
let tempDir
let streamBaseline = ''

const PACKAGE_SOURCE = `import SwiftUI

/// A small view exercised by the preview smoke.
public struct DemoView: View {
  public init() {}
  public var body: some View {
    Text("Hello preview").font(.largeTitle).foregroundColor(.blue)
  }
}

/// A PreviewProvider variant — the host pages between it and the #Preview.
public struct DemoView_Previews: PreviewProvider {
  public static var previews: some View {
    Text("Provider preview").foregroundColor(.green)
  }
}

#Preview("Demo macro") {
  DemoView()
}
`

try {
  // ── 1. tool contract (no simulator needed) ────────────────────────────────
  controller = new SimHostController()
  controller.startKeepAlive() // production parity: crash-restarted streams
  tools = createSimPreviewTools(controller)
  const tool = tools.iosSimPreview
  step(
    'factory produces ios_sim_preview with the right name',
    tool.name === IOS_PREVIEW_TOOL_NAMES[0],
    tool.name,
  )
  step(
    'concurrency flags: status concurrent, start/stop exclusive',
    tool.isConcurrencySafe({ action: 'status' }) === true && tool.isConcurrencySafe({ action: 'start' }) === false,
    'status=safe start=exclusive',
  )
  step('start declares a 15-minute timeout', tool.timeoutMs === 900_000)

  if (!controller.status().available) throw new Error('serve-sim unavailable; cannot continue')

  if (SKIP_SIM) {
    skipped('live preview hot-reload smoke (boots a simulator)', 'skipped by DSH_IOS_SMOKE_SKIP_SIM=1')
  } else {
    // ── 2. temp Swift package with previews ──────────────────────────────────
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-ios-preview-smoke-'))
    const packageDir = join(tempDir, 'DemoPreviewPkg')
    mkdirSync(join(packageDir, 'Sources', 'DemoPreviewPkg'), { recursive: true })
    writeFileSync(join(packageDir, 'Package.swift'), `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: "DemoPreviewPkg",
  platforms: [.iOS(.v17)],
  products: [.library(name: "DemoPreviewPkg", targets: ["DemoPreviewPkg"])],
  targets: [.target(name: "DemoPreviewPkg")]
)
`)
    writeFileSync(join(packageDir, 'Sources', 'DemoPreviewPkg', 'DemoView.swift'), PACKAGE_SOURCE)
    step('temp package with #Preview + PreviewProvider created', true, packageDir)

    // ── 3. start the preview session ────────────────────────────────────────
    const forcedUdid = process.env.DSH_IOS_SMOKE_DEVICE?.trim()
    const devices = await listDevices()
    const booted = await bootedDevices()
    const iphones = devices.filter(d => d.name.startsWith('iPhone'))
    if (iphones.length === 0) throw new Error('no available iPhone simulators')
    const byRuntime = (a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true })
    if (forcedUdid !== undefined && forcedUdid !== '') {
      const forced = iphones.find(d => d.udid === forcedUdid) ?? devices.find(d => d.udid === forcedUdid)
      if (forced === undefined) throw new Error(`DSH_IOS_SMOKE_DEVICE ${forcedUdid} is not an available simulator`)
      if (forced.state !== 'Booted') {
        await bootDevice(forced.udid)
        bootedBySmoke = true
      }
      udid = forced.udid
      deviceName = forced.name
    } else {
      const bootedIphone = booted.filter(d => d.name.startsWith('iPhone')).sort(byRuntime)[0]
      if (bootedIphone !== undefined) {
        udid = bootedIphone.udid
        deviceName = bootedIphone.name
      } else {
        const picked = iphones.sort(byRuntime)[0]
        udid = picked.udid
        deviceName = picked.name
        await bootDevice(udid)
        bootedBySmoke = true
      }
    }
    step('target iPhone simulator ready', true, `${deviceName} (${udid}, bootedBySmoke=${bootedBySmoke})`)

    streamBaseline = pgrepServeSim()
    const watcherBaseline = watcherCount()
    const startedAt = Date.now()
    const startResult = await tool.execute(
      { packagePath: packageDir, udid, action: 'start' },
      makeExec('ios_sim_preview', { packagePath: packageDir, udid, action: 'start' }),
    )
    const startMs = Date.now() - startedAt
    step(
      'start returns a live hot-swap session',
      startResult.running === true && startResult.watching === true && startResult.mode === 'dylib-hot-swap'
        && startResult.device.udid === udid && startResult.generation === 1 && Array.isArray(startResult.previews)
        && startResult.previews.length >= 1
        && startResult.previews.some(p => p.name.includes('Demo macro'))
        && startResult.previews.some(p => p.name.includes('DemoView_Previews')),
      `${startResult.previews.map(p => p.name).join(', ')} (${(startMs / 1000).toFixed(1)}s start)`,
    )
    step(
      'start presentationMeta is a sim-stream envelope',
      tool.output.presentationMeta({}, startResult)?.kind === 'sim-stream'
        && tool.output.presentationMeta({}, startResult).streamRouteId.includes(udid),
      JSON.stringify(tool.output.presentationMeta({}, startResult)),
    )
    step('host app is installed on the simulator', listAppsContains(udid, PREVIEW_HOST_BUNDLE_ID), PREVIEW_HOST_BUNDLE_ID)

    const container = await getAppContainer(udid, PREVIEW_HOST_BUNDLE_ID)
    const firstResult = await pollUntil(async () => {
      const result = readHostResult(container)
      return result !== undefined && result.generation >= 1 ? result : undefined
    }, 10_000)
    step(
      'host app launched and first preview dylib loaded (generation 1)',
      firstResult !== undefined && typeof firstResult.pid === 'number',
      `pid=${firstResult?.pid} previews=${JSON.stringify(firstResult?.previews)}`,
    )
    if (firstResult === undefined) throw new Error('host never loaded generation 1; cannot continue')
    const pid0 = firstResult.pid
    const streamUp = await pollUntil(async () => {
      const status = controller.status()
      return status.running === true && status.device === udid ? status : undefined
    }, 10_000)
    step('simulator stream is running for the device', streamUp !== undefined, `port=${streamUp?.port}`)
    step(
      'file watcher is active',
      watcherBaseline !== undefined && watcherCount() >= watcherBaseline + 1,
      `FSWatchers ${watcherBaseline} → ${watcherCount()}`,
    )

    // ── 4. edit → hot reload within 15 s, NO relaunch ───────────────────────
    const edited = PACKAGE_SOURCE.replace('Hello preview', 'Reloaded preview').replace('.blue', '.red')
    writeFileSync(join(packageDir, 'Sources', 'DemoPreviewPkg', 'DemoView.swift'), edited)
    const editAt = Date.now()
    const reloaded = await pollUntil(async () => {
      const status = tools.controller.status()
      return status.loadedGeneration >= 2 && status.lastReload !== undefined ? status : undefined
    }, 15_000)
    step(
      'edit hot-reloads within 15s (generation advanced)',
      reloaded !== undefined && reloaded.loadedGeneration >= 2 && reloaded.generation >= 2,
      `generation ${reloaded?.loadedGeneration} in ${reloaded === undefined ? 'timeout' : `${Date.now() - editAt} ms (build ${reloaded.lastReload?.buildMs} ms, total ${reloaded.lastReload?.totalMs} ms)`}`,
    )
    const pid1 = readHostResult(container)?.pid
    step('reload happened WITHOUT relaunching (same host pid)', reloaded !== undefined && pid1 === pid0, `pid ${pid0} → ${pid1}`)

    // ── 5. syntax error → compiler error surfaced, session alive ────────────
    writeFileSync(
      join(packageDir, 'Sources', 'DemoPreviewPkg', 'DemoView.swift'),
      `import SwiftUI
public struct DemoView: View {
  public init() {}
  public var body: some View {
    Text("broken
  }
}
#Preview { DemoView() }
`,
    )
    const failing = await pollUntil(async () => {
      const status = tools.controller.status()
      return status.lastBuildError !== undefined && status.lastBuildError.length > 0 ? status : undefined
    }, 60_000)
    step(
      'syntax error is reported through status (last ~40 error lines)',
      failing !== undefined && failing.lastBuildError.some(line => line.includes('error')),
      failing === undefined ? 'timeout' : failing.lastBuildError.slice(0, 2).join(' | '),
    )
    step(
      'session survives the error (still watching, last good kept)',
      failing !== undefined && failing.watching === true && failing.loadedGeneration >= 2,
      `loadedGeneration=${failing?.loadedGeneration} watching=${failing?.watching}`,
    )

    // ── 6. fix → session recovers ────────────────────────────────────────────
    writeFileSync(
      join(packageDir, 'Sources', 'DemoPreviewPkg', 'DemoView.swift'),
      PACKAGE_SOURCE.replace('Hello preview', 'Recovered preview').replace('.blue', '.orange'),
    )
    const recovered = await pollUntil(async () => {
      const status = tools.controller.status()
      return status.loadedGeneration >= 3 ? status : undefined
    }, 15_000)
    step(
      'fixing the source recovers the session (generation advances again)',
      recovered !== undefined && recovered.loadedGeneration >= 3,
      `loadedGeneration=${recovered?.loadedGeneration}`,
    )

    // ── 7. single-session guard ──────────────────────────────────────────────
    let secondStartError = ''
    try {
      await tool.execute({ packagePath: packageDir, action: 'start' }, makeExec('ios_sim_preview', { packagePath: packageDir, action: 'start' }))
    } catch (error) {
      secondStartError = error instanceof Error ? error.message : String(error)
    }
    step('second start fails 409-style (one session at a time)', secondStartError.includes('only one preview session'), secondStartError.slice(0, 120))

    const statusResult = await tool.execute({ action: 'status' }, makeExec('ios_sim_preview', { action: 'status' }))
    step(
      'status action reports the live session',
      statusResult.running === true && statusResult.watching === true && Array.isArray(statusResult.previews)
        && statusResult.previews.length >= 1 && statusResult.generation >= 3,
      `generation ${statusResult.generation} / loaded ${statusResult.loadedGeneration}`,
    )

    // ── 8. stop → total cleanup ──────────────────────────────────────────────
    const stopResult = await tool.execute({ action: 'stop' }, makeExec('ios_sim_preview', { action: 'stop' }))
    step('stop terminates the host app', stopResult.state === 'stopped' && stopResult.host?.terminated === true, JSON.stringify(stopResult.host))
    step('host app is uninstalled', !listAppsContains(udid, PREVIEW_HOST_BUNDLE_ID), 'not in listapps')
    let containerGone = false
    try {
      await getAppContainer(udid, PREVIEW_HOST_BUNDLE_ID)
    } catch {
      containerGone = true
    }
    step('host app container removed', containerGone)
    step('serve-sim stream released', controller.status().running === false, `running=${controller.status().running}`)
    step('file watcher fully closed', watcherBaseline === undefined || watcherCount() === watcherBaseline, `watchers ${watcherBaseline} → ${watcherCount()}`)
    if (streamBaseline === '') {
      // Only strict when nothing else owned a serve-sim before we started
      // (parallel work on this Mac may own one; that is not ours to reap).
      step('no new serve-sim processes left', pgrepServeSim() === '', pgrepServeSim() || 'none')
    } else {
      skipped('no new serve-sim processes left', `a pre-existing serve-sim was present at baseline: ${streamBaseline.split('\n')[0]}`)
    }
    const bootedAfter = await bootedDevices()
    const leftBooted = bootedAfter.filter(d => d.name.startsWith('iPhone')).map(d => d.udid)
    step(
      'stop honors prior state (smoke-booted device is left to the smoke)',
      leftBooted.includes(udid),
      `device still booted after stop: ${leftBooted.join(', ') || 'none'}`,
    )
    if (bootedBySmoke) {
      await shutdownDevice(udid)
      const bootedFinal = (await bootedDevices()).map(d => d.udid)
      step('smoke-booted device shut down in cleanup', !bootedFinal.includes(udid), `booted now: ${bootedFinal.join(', ') || 'none'}`)
    }
  }
} catch (error) {
  step('smoke completed without uncaught errors', false, error instanceof Error ? error.message : String(error))
} finally {
  // ── best-effort cleanup no matter what happened ───────────────────────────
  try {
    await tools?.controller.dispose()
  } catch { /* already disposed or teardown best-effort */ }
  try {
    if (controller !== undefined) await controller.dispose()
  } catch { /* already disposed */ }
  try {
    if (bootedBySmoke && udid !== undefined) await shutdownDevice(udid)
  } catch { /* already shut down */ }
  try {
    execFileSync('pkill', ['-f', 'serve-sim'], { stdio: 'ignore', timeout: 10_000 })
  } catch { /* pkill exit 1 = nothing to kill */ }
  try {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
  } catch { /* best-effort */ }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
