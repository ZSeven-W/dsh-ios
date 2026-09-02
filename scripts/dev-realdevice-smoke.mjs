/**
 * Real-device Phase A smoke test — `xcrun devicectl` against a USB-connected
 * physical iPhone, exercising the exact code paths the tools use.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-realdevice-smoke.mjs [<udid>]
 *
 * The target device defaults to the known dev phone; override with the first
 * CLI argument or DSH_REAL_DEVICE_UDID (name/os expectations via
 * DSH_REAL_DEVICE_NAME / DSH_REAL_DEVICE_OS).
 *
 * Steps (PASS/FAIL/SKIP per step, non-zero exit if any step fails):
 *   1. devicectl list devices shows the phone with the correct name/os
 *   2. devicectl device info details reports developerMode enabled
 *   3. installed-apps list > 10 (default/stock apps included)
 *   4. running-processes list > 100
 *   5. launch com.apple.Preferences → process appears → terminate → gone
 *      (SKIP with the clear locked-device error when the phone is locked)
 *   6. Apple Development signing identity check (printed)
 *   7. bogus udid degrades every read/mutation path with a clear error
 *   8. simulator-lifecycle tools refuse real-device udids with their new
 *      specific reasons (boot/shutdown/preview/backtrace/leaks/logs);
 *      screenshot/ui_tree/tap_element route the real udid to WebDriverAgent
 *      WITHOUT booting anything
 *   9. ios_sim_processes + ios_sim_app_info serve the real device
 *  10. ios_sim_build_run real-device path: destination/signing arg assembly
 *      dry-run, then a real device build attempt — install/launch/terminate/
 *      uninstall only when the build actually succeeds
 *
 * Safety: read-only devicectl queries plus launching/terminating the Apple
 * stock Settings app only; a self-built test app is installed ONLY when the
 * signing identity exists AND the device build succeeds, and it is always
 * uninstalled afterwards. Simulators are never booted; ~/.dsh and the :8873
 * instance are never touched.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEVICE_UDID = process.argv[2] || process.env.DSH_REAL_DEVICE_UDID || '96E6B481-3807-594D-B3BC-E1E12307D47C'
const EXPECTED_NAME = process.env.DSH_REAL_DEVICE_NAME || 'Fini iPhone 17'
const EXPECTED_OS = process.env.DSH_REAL_DEVICE_OS || '26.6'
const BOGUS_UDID = '00000000-0000-0000-0000-000000000000'
const TEST_BUNDLE_ID = 'com.apple.Preferences'
const POLL_MS = 1500
const POLL_TRIES = 30

const { DevicectlError, detectAppleDevelopmentIdentity, deviceInfo, getRealDevice, launchApp, listApps, listProcesses, listRealDevices, terminateApp, uninstallApp } = await import(join(root, 'lib', 'devicectl.js'))
const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))
const { createSimTools } = await import(join(root, 'lib', 'tools.js'))
const { createSimDebugTools } = await import(join(root, 'lib', 'tool-debug.js'))
const { createSimLogTools } = await import(join(root, 'lib', 'tool-logs.js'))
const { createSimUiTools } = await import(join(root, 'lib', 'tool-uitree.js'))
const { createSimPreviewTools } = await import(join(root, 'lib', 'tool-preview.js'))
const { WdaController, probeWdaControlTunnel, resolveWdaSetting } = await import(join(root, 'lib', 'wda-host.js'))
const { assembleBuildArgs, buildRun, destinationIdFor, detectProject } = await import(join(root, 'lib', 'build-run.js'))

const results = []
let failed = 0
function step(name, verdict, detail = '') {
  const normalized = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict
  if (normalized === 'FAIL') failed += 1
  results.push({ name, verdict: normalized, detail })
  console.log(`${normalized.padEnd(4)} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Minimal execution context for calling ToolDefinition.execute directly. */
function makeExec(toolName, args) {
  return {
    callId: `realdevice-smoke-${toolName}`,
    rootCallId: `realdevice-smoke-${toolName}`,
    name: toolName,
    arguments: args,
    signal: new AbortController().signal,
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function pollFor(fn, label) {
  for (let attempt = 0; attempt < POLL_TRIES; attempt += 1) {
    const value = await fn()
    if (value !== undefined) return value
    await sleep(POLL_MS)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function expectThrow(toolName, invoke, pattern, label) {
  try {
    await invoke()
    step(label, 'FAIL', 'no error was thrown')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const ok = pattern.test(message)
    step(label, ok ? 'PASS' : 'FAIL', ok ? 'clear error' : `unexpected error: ${message}`)
  }
}

let host
let wdaHost
let tools
let debugTools
let logTools
let uiTools
let previewTools
let installedBundleId

console.log(`dsh-ios real-device smoke — target ${DEVICE_UDID} (expect "${EXPECTED_NAME}" / iOS ${EXPECTED_OS})`)
console.log('')

// ── Fixture-only regressions ────────────────────────────────────────────────
{
  const optionWins = resolveWdaSetting(' OPTION_TEAM ', 'ENV_TEAM', 'DEFAULT_TEAM')
  const envWins = resolveWdaSetting(undefined, ' ENV_TEAM ', 'DEFAULT_TEAM')
  const defaultWins = resolveWdaSetting(undefined, '   ', 'DEFAULT_TEAM')
  step(
    'WDA team-id precedence is option > env > default',
    optionWins.value === 'OPTION_TEAM' && optionWins.source === 'option'
      && envWins.value === 'ENV_TEAM' && envWins.source === 'env'
      && defaultWins.value === 'DEFAULT_TEAM' && defaultWins.source === 'default',
    `${optionWins.value}/${envWins.value}/${defaultWins.value}`,
  )
  const fakeCoreDeviceUdid = 'COREDEVICE-UUID'
  const fakeHardwareUdid = '00008030-AAAA'
  const fakeDevice = {
    kind: 'device',
    device: {
      udid: fakeCoreDeviceUdid,
      hardwareUdid: fakeHardwareUdid,
      name: 'Fake iPhone',
      state: 'available (paired)',
      connection: 'wired',
      pairingState: 'paired',
      developerMode: 'enabled',
    },
  }
  const destinationId = destinationIdFor(fakeDevice)
  const dryArgs = assembleBuildArgs({
    target: { kind: 'package', root: '/tmp/dsh-smoke', location: '/tmp/dsh-smoke' },
    scheme: 'DshDeviceSmoke',
    configuration: 'Debug',
    udid: destinationId,
    derivedDataPath: '/tmp/dsh-smoke-dd',
    platform: 'device',
    signing: { teamId: 'FAKE-TEAM' },
  })
  step(
    'device build arg assembly targets hardware UDID, never CoreDevice UUID',
    destinationId === fakeHardwareUdid
      && dryArgs.includes('-destination') && dryArgs.includes(`platform=iOS,id=${fakeHardwareUdid}`)
      && !dryArgs.includes(`platform=iOS,id=${fakeCoreDeviceUdid}`)
      && dryArgs.includes('CODE_SIGN_STYLE=Automatic')
      && dryArgs.includes('DEVELOPMENT_TEAM=FAKE-TEAM'),
    dryArgs.join(' '),
  )
}

try {
  // ── 1. list devices: correct name/os ──────────────────────────────────────
  const devices = await listRealDevices()
  const device = devices.find(d => d.udid === DEVICE_UDID)
  step(
    'devicectl list devices shows the phone',
    device !== undefined,
    device === undefined ? `found: ${devices.map(d => `${d.name} (${d.udid})`).join(', ') || 'none'}` : '',
  )
  if (device === undefined) throw new Error('target device not found — connect it over USB and retry')
  const nameOk = device.name === EXPECTED_NAME
  const osOk = device.osVersion === EXPECTED_OS
  step(
    'correct name/os',
    nameOk && osOk,
    `name=${device.name} os=${device.osVersion ?? '?'} state=${device.state} model=${device.model ?? '?'} devmode=${device.developerMode}`,
  )
  step(
    'wired connection reported',
    device.connection === 'wired',
    `connection=${device.connection} pairing=${device.pairingState}`,
  )

  // ── 2. device info details ────────────────────────────────────────────────
  const info = await deviceInfo(DEVICE_UDID)
  step(
    'device info details: developer mode enabled',
    info.developerMode === 'enabled',
    `name=${info.name} os=${info.osVersion ?? '?'} build=${info.build ?? '?'} productType=${info.productType ?? '?'} serial=${info.serialNumber ?? '?'} devmode=${info.developerMode}`,
  )

  // ── 3. apps list > 10 ─────────────────────────────────────────────────────
  const apps = await listApps(DEVICE_UDID)
  step(
    'installed-apps list > 10',
    apps.length > 10,
    `${apps.length} apps (settings present: ${apps.some(a => a.bundleId === TEST_BUNDLE_ID)})`,
  )

  // ── 4. processes > 100 ────────────────────────────────────────────────────
  const processes = await listProcesses(DEVICE_UDID)
  step(
    'running-processes list > 100',
    processes.length > 100,
    `${processes.length} processes`,
  )

  // ── 5. launch Preferences → appears → terminate → gone ────────────────────
  // Tool factories are created up front (no side effects, nothing booted) so
  // the processes tool can observe the launched stock app. The WDA host is
  // wired into the live-view tools: with a real udid they now route to
  // WebDriverAgent instead of refusing with the old phase error.
  host = new SimHostController()
  wdaHost = new WdaController()
  const toolsCache = join(tmpdir(), 'dsh-ios-realdevice-smoke-cache')
  tools = createSimTools(host, { wda: wdaHost, cacheDir: toolsCache })
  debugTools = createSimDebugTools(host)
  logTools = createSimLogTools(host)
  uiTools = createSimUiTools(host, { wda: wdaHost, cacheDir: toolsCache })
  previewTools = createSimPreviewTools(host)

  let preferencesPid
  try {
    const launched = await launchApp(DEVICE_UDID, TEST_BUNDLE_ID)
    preferencesPid = launched.pid
    const appeared = await pollFor(async () => {
      const procs = await listProcesses(DEVICE_UDID)
      return procs.find(p => p.bundleId === TEST_BUNDLE_ID)
    }, `process for ${TEST_BUNDLE_ID}`)
    step(
      'launch Preferences → process appears',
      appeared.pid > 0,
      `pid ${appeared.pid} (launch reported ${preferencesPid ?? 'no pid'})`,
    )
    const prefFiltered = await debugTools.iosSimProcesses.execute(
      { udid: DEVICE_UDID, filter: 'pref' },
      makeExec('ios_sim_processes', { udid: DEVICE_UDID, filter: 'pref' }),
    )
    step(
      'ios_sim_processes filter finds the running Preferences app',
      prefFiltered.processes.some(p => p.bundleId === TEST_BUNDLE_ID),
      `${prefFiltered.processes.length} matches: ${prefFiltered.processes.slice(0, 5).map(p => `${p.name}${p.bundleId === undefined ? '' : `(${p.bundleId})`}`).join(', ')}`,
    )
    const terminated = await terminateApp(DEVICE_UDID, TEST_BUNDLE_ID)
    const gone = await pollFor(async () => {
      const procs = await listProcesses(DEVICE_UDID)
      return procs.some(p => p.bundleId === TEST_BUNDLE_ID) ? undefined : true
    }, `process ${TEST_BUNDLE_ID} to exit`)
    step(
      'terminate Preferences → process gone',
      gone === true && terminated.pids.length > 0,
      `terminated pids [${terminated.pids.join(', ')}]`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/locked|unlocked/i.test(message)) {
      // The user's phone is locked: verify the error is the clear one and skip.
      step('launch Preferences (device locked)', 'SKIP', `clear locked-device error: ${message}`)
    } else {
      step('launch/terminate Preferences', 'FAIL', message)
    }
  }

  // ── 6. signing identity check ─────────────────────────────────────────────
  const signing = await detectAppleDevelopmentIdentity()
  if (signing === undefined) {
    step('Apple Development signing identity', 'SKIP', 'none found — install testing stays a dry run')
  } else {
    step(
      'Apple Development signing identity found',
      'PASS',
      `${signing.name} (hash ${signing.hash.slice(0, 10)}…${signing.hash.slice(-6)}, team ${signing.teamId ?? '(none)'})`,
    )
  }

  // ── 7. bogus udid degrades every path with a clear error ──────────────────
  await expectThrow('getRealDevice', () => getRealDevice(BOGUS_UDID), /no connected physical device matches/i, 'bogus udid: getRealDevice clear error')
  await expectThrow('listApps', () => listApps(BOGUS_UDID), /not found/i, 'bogus udid: listApps clear error')
  await expectThrow('listProcesses', () => listProcesses(BOGUS_UDID), /not found/i, 'bogus udid: listProcesses clear error')
  await expectThrow('launchApp', () => launchApp(BOGUS_UDID, TEST_BUNDLE_ID), /not found/i, 'bogus udid: launchApp clear error')
  await expectThrow('deviceInfo', () => deviceInfo(BOGUS_UDID), /not found/i, 'bogus udid: deviceInfo clear error')

  // ── 8./9. tool surface via the real factories (never boots anything) ──────
  const devicesResult = await tools.iosSimDevices.execute({}, makeExec('ios_sim_devices', {}))
  const realEntry = (devicesResult.realDevices ?? []).find(d => d.udid === DEVICE_UDID)
  step(
    'ios_sim_devices gains realDevices (sim list unchanged)',
    realEntry !== undefined && Array.isArray(devicesResult.devices) && devicesResult.realCount === devicesResult.realDevices.length,
    `sims=${devicesResult.count} real=${devicesResult.realCount} entry="${realEntry?.name ?? '?'}" os=${realEntry?.osVersion ?? '?'}${devicesResult.note === undefined ? '' : ` note=${devicesResult.note}`}`,
  )

  await expectThrow('ios_sim_boot', () => tools.iosSimBoot.execute({ udid: DEVICE_UDID }, makeExec('ios_sim_boot', { udid: DEVICE_UDID })), /physical iOS device[\s\S]*boots iOS Simulators only/i, 'ios_sim_boot refuses real udid (no boot)')
  await expectThrow('ios_sim_shutdown', () => tools.iosSimShutdown.execute({ udid: DEVICE_UDID }, makeExec('ios_sim_shutdown', { udid: DEVICE_UDID })), /physical iOS device[\s\S]*shuts down iOS Simulators only/i, 'ios_sim_shutdown refuses real udid')
  await expectThrow('ios_sim_logs', () => logTools.iosSimLogs.execute({ udid: DEVICE_UDID, mode: 'snapshot' }, makeExec('ios_sim_logs', { udid: DEVICE_UDID })), /log collect|no log subcommand/i, 'ios_sim_logs explains the real-device gap')
  await expectThrow('ios_sim_backtrace', () => debugTools.iosSimBacktrace.execute({ udid: DEVICE_UDID, bundle_id: TEST_BUNDLE_ID }, makeExec('ios_sim_backtrace', { udid: DEVICE_UDID })), /host LLDB/, 'ios_sim_backtrace rejects real udid (host LLDB cannot attach)')
  await expectThrow('ios_sim_leaks', () => debugTools.iosSimLeaks.execute({ udid: DEVICE_UDID, bundle_id: TEST_BUNDLE_ID }, makeExec('ios_sim_leaks', { udid: DEVICE_UDID })), /host leaks tool/, 'ios_sim_leaks rejects real udid (host leaks cannot inspect)')
  await expectThrow('ios_sim_preview', () => previewTools.iosSimPreview.execute({ udid: DEVICE_UDID, action: 'start', packagePath: join(root, 'package.json') }, makeExec('ios_sim_preview', { udid: DEVICE_UDID })), /SwiftUI preview hot reload runs on simulators only/, 'ios_sim_preview rejects real udid (hot reload is simulator-only)')

  // The live-view tools now route real udids to WebDriverAgent. With WDA up
  // they complete for real (read-only, and the tap-element probe uses a
  // selector that can never match, so no tap lands on the personal phone);
  // without a running WDA the smoke skips instead of triggering a build.
  let wdaUp = false
  try {
    wdaUp = await probeWdaControlTunnel(8100)
  } catch { /* probe failure = not up */ }
  if (wdaUp) {
    const shot = await tools.iosSimScreenshot.execute({ udid: DEVICE_UDID }, makeExec('ios_sim_screenshot', { udid: DEVICE_UDID }))
    step(
      'ios_sim_screenshot routes the real udid to WDA',
      typeof shot.path === 'string' && existsSync(shot.path) && shot.bytes > 0 && shot.device.udid === DEVICE_UDID,
      `${Math.round(shot.bytes / 1024)} KB ${shot.path}`,
    )
    const tree = await uiTools.iosSimUiTree.execute({ udid: DEVICE_UDID }, makeExec('ios_sim_ui_tree', { udid: DEVICE_UDID }))
    step(
      'ios_sim_ui_tree routes the real udid to WDA',
      tree.nodeCount > 0 && tree.size.width > 0 && tree.size.height > 0 && tree.device.udid === DEVICE_UDID,
      `${tree.nodeCount} nodes ${tree.size.width}x${tree.size.height}`,
    )
    await expectThrow(
      'ios_sim_tap_element resolves against the WDA tree (no tap performed)',
      () => uiTools.iosSimTapElement.execute(
        { udid: DEVICE_UDID, identifier: 'com.dsh-ios.smoke.never-matches-anything' },
        makeExec('ios_sim_tap_element', { udid: DEVICE_UDID }),
      ),
      /no accessibility element matches/i,
    )
  } else {
    step('ios_sim_screenshot WDA routing', 'SKIP', 'WDA not running on 127.0.0.1:8100 — the tool would start it')
    step('ios_sim_ui_tree WDA routing', 'SKIP', 'WDA not running on 127.0.0.1:8100 — the tool would start it')
    step('ios_sim_tap_element WDA routing', 'SKIP', 'WDA not running on 127.0.0.1:8100 — the tool would start it')
  }

  const processResult = await debugTools.iosSimProcesses.execute({ udid: DEVICE_UDID }, makeExec('ios_sim_processes', { udid: DEVICE_UDID }))
  step(
    'ios_sim_processes serves the real device',
    processResult.processes.length > 100,
    `${processResult.processes.length} processes, device=${processResult.device.name} (${processResult.device.runtime})`,
  )
  const appInfo = await debugTools.iosSimAppInfo.execute({ udid: DEVICE_UDID, bundle_id: TEST_BUNDLE_ID }, makeExec('ios_sim_app_info', { udid: DEVICE_UDID, bundle_id: TEST_BUNDLE_ID }))
  step(
    'ios_sim_app_info serves the real device',
    appInfo.installed === true && appInfo.bundleId === TEST_BUNDLE_ID,
    `installed=${appInfo.installed} name=${appInfo.displayName ?? '?'} path=${appInfo.appPath ?? '?'} type=${appInfo.applicationType ?? '?'}`,
  )
  const missingInfo = await debugTools.iosSimAppInfo.execute({ udid: DEVICE_UDID, bundle_id: 'com.example.definitely.not.installed' }, makeExec('ios_sim_app_info', { udid: DEVICE_UDID }))
  step(
    'ios_sim_app_info installed:false for unknown bundle id',
    missingInfo.installed === false,
    'installed=false',
  )

  // ── 10. build_run real-device path ────────────────────────────────────────
  const tempDirs = []
  try {
    const deviceDestinationId = device.hardwareUdid ?? device.udid
    const dryArgs = assembleBuildArgs({
      target: { kind: 'package', root: '/tmp/dsh-smoke', location: '/tmp/dsh-smoke' },
      scheme: 'DshDeviceSmoke',
      configuration: 'Debug',
      udid: deviceDestinationId,
      derivedDataPath: '/tmp/dsh-smoke-dd',
      platform: 'device',
      signing: { teamId: signing?.teamId },
    })
    step(
      'device build arg assembly: platform=iOS,id=<hardware-udid> + signing',
      dryArgs.includes('-destination') && dryArgs.includes(`platform=iOS,id=${deviceDestinationId}`)
        && dryArgs.includes('CODE_SIGN_STYLE=Automatic')
        && (signing?.teamId === undefined || dryArgs.includes(`DEVELOPMENT_TEAM=${signing.teamId}`)),
      dryArgs.join(' '),
    )

    // Generate the minimal self-built SwiftUI app (build/install/launch only
    // when signing is available and the host can target the device).
    const appDir = mkdtempSync(join(tmpdir(), 'dsh-ios-realdevice-smoke-'))
    tempDirs.push(appDir)
    const sourcesDir = join(appDir, 'Sources', 'DshDeviceSmoke')
    mkdirSync(sourcesDir, { recursive: true })
    writeFileSync(join(appDir, 'Package.swift'), [
      '// swift-tools-version:5.9',
      'import PackageDescription',
      '',
      'let package = Package(',
      '    name: "DshDeviceSmoke",',
      '    platforms: [.iOS(.v17)],',
      '    targets: [',
      '        .executableTarget(name: "DshDeviceSmoke", path: "Sources/DshDeviceSmoke"),',
      '    ],',
      ')',
      '',
    ].join('\n'))
    writeFileSync(join(sourcesDir, 'SmokeApp.swift'), [
      'import SwiftUI',
      '',
      '@main',
      'struct SmokeApp: App {',
      '    var body: some Scene {',
      '        WindowGroup {',
      '            VStack(spacing: 12) {',
      '                Image(systemName: "checkmark.seal")',
      '                    .font(.system(size: 48))',
      '                Text("dsh-ios real-device smoke")',
      '                    .font(.headline)',
      '            }',
      '            .padding()',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'))

    if (signing === undefined) {
      await expectThrow('buildRun without signing', () => buildRun({
        target: detectProject(appDir),
        scheme: 'DshDeviceSmoke',
        configuration: 'Debug',
        device: { kind: 'device', device },
        cacheDir: join(tmpdir(), 'dsh-ios-realdevice-cache'),
        signal: new AbortController().signal,
      }), /Apple Development signing identity/i, 'ios_sim_build_run explains code-signing requirements')
      step('device install test', 'SKIP', 'no signing identity — dry-run arg assembly only')
    } else {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('smoke build deadline')), 300_000)
      timer.unref?.()
      try {
        const result = await buildRun({
          target: detectProject(appDir),
          scheme: 'DshDeviceSmoke',
          configuration: 'Debug',
          device: { kind: 'device', device },
          cacheDir: join(tmpdir(), 'dsh-ios-realdevice-cache'),
          signal: controller.signal,
        })
        installedBundleId = result.bundleId
        step('device build + install + launch', 'PASS', `bundleId=${result.bundleId} pid=${result.pid}`)
        const appSeen = await pollFor(async () => {
          const procs = await listProcesses(DEVICE_UDID)
          return procs.find(p => p.bundleId === installedBundleId)
        }, `process for ${installedBundleId}`)
        step('installed app runs on the device', appSeen !== undefined, `pid ${appSeen?.pid ?? '?'}`)
        const terminated = await terminateApp(DEVICE_UDID, installedBundleId)
        const gone = await pollFor(async () => {
          const procs = await listProcesses(DEVICE_UDID)
          return procs.some(p => p.bundleId === installedBundleId) ? undefined : true
        }, `process ${installedBundleId} to exit`)
        step('terminate self-built app', gone === true && terminated.pids.length > 0, `pids [${terminated.pids.join(', ')}]`)
        await uninstallApp(DEVICE_UDID, installedBundleId)
        const uninstalled = (await listApps(DEVICE_UDID)).every(a => a.bundleId !== installedBundleId)
        step('uninstall self-built app → gone', uninstalled, 'app list no longer contains it')
        installedBundleId = undefined
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/is not installed[\s\S]*Components|download and install the platform|iOS \d[\d.]* is not installed/i.test(message)) {
          step(
            'device build (host platform gap)',
            'SKIP',
            `xcodebuild cannot target the device on this host yet (Xcode iOS platform vs device OS): ${message.split('\n').slice(0, 4).join(' | ').slice(0, 400)}`,
          )
        } else {
          step('device build + install + launch', 'FAIL', message.slice(0, 600))
        }
      } finally {
        clearTimeout(timer)
      }
    }
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  } catch (error) {
    step('build_run real-device path', 'FAIL', error instanceof Error ? error.message : String(error))
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const noReachableDevice = /device is not reachable by CoreDevice right now/i.test(message)
  step('smoke setup', noReachableDevice ? 'SKIP' : 'FAIL', message)
} finally {
  // Cleanup: only the in-memory controllers; nothing was booted, nothing was
  // installed beyond the (always removed) self-built app.
  try {
    if (installedBundleId !== undefined) {
      await uninstallApp(DEVICE_UDID, installedBundleId)
      console.log(`cleanup: uninstalled leftover ${installedBundleId}`)
    }
  } catch { /* best effort */ }
  try { debugTools?.dispose() } catch { /* best effort */ }
  try { await wdaHost?.dispose() } catch { /* best effort */ }
  try { await host?.dispose() } catch { /* best effort */ }
}

console.log('')
const failedCount = failed
console.log(`${results.length} steps: ${results.filter(r => r.verdict === 'PASS').length} passed, ${results.filter(r => r.verdict === 'SKIP').length} skipped, ${failedCount} failed`)
process.exitCode = failedCount > 0 ? 1 : 0
