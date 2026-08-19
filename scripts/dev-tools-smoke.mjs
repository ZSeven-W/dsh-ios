/**
 * Development smoke test for the dsh-ios model-facing tools.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-tools-smoke.mjs [--full-build]
 *
 * Instantiates the tools' execute functions directly (no harness needed):
 * the exported factory is bound to a real SimHostController.
 *
 * Steps (PASS/FAIL per step, non-zero exit if any step fails):
 *   1. factory produces the six ios_sim_* definitions with the right names
 *   2. ios_sim_devices lists >0 devices and is concurrency-safe
 *   3. ios_sim_boot boots an iPhone and starts the serve-sim stream
 *   4. ios_sim_screenshot produces a PNG >50 KB with replayable meta
 *   5. ios_sim_interact tap 0.5 0.5 returns a fresh screenshot summary
 *   6. ios_sim_shutdown stops the stream and shuts the simulator down
 *   7. ios_sim_build_run argument assembly (dry run); with --full-build a
 *      minimal SwiftUI app project is generated, built, installed and launched
 *   8. presenters stay pure (presentCall/presentationMeta never throw)
 *   9. cleanup: no booted simulators, no serve-sim processes left
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fullBuild = process.argv.includes('--full-build')

const { listDevices, shutdownDevice, bootedDevices } = await import(join(root, 'lib', 'simctl.js'))
const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))
const { createSimTools, IOS_TOOL_NAMES } = await import(join(root, 'lib', 'tools.js'))
const { assembleBuildArgs, filterBuildOutput } = await import(join(root, 'lib', 'build-run.js'))

const results = []
function step(name, ok, detail = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  results.push({ name, ok })
  console.log(`${verdict} ${name}${detail === '' ? '' : ` — ${detail}`}`)
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

let controller
let tools
let udid
let deviceName
let bootedBySmoke = false
const tempDirs = []

try {
  // ── 1. factory + registration names ───────────────────────────────────────
  controller = new SimHostController()
  tools = createSimTools(controller)
  const factoryNames = [
    tools.iosSimDevices.name, tools.iosSimBoot.name, tools.iosSimShutdown.name,
    tools.iosSimScreenshot.name, tools.iosSimInteract.name, tools.iosSimListApps.name,
    tools.iosSimLaunchApp.name, tools.iosSimBuildRun.name, tools.iosRealStartWda.name,
  ]
  step(
    'factory produces the nine tools (eight ios_sim_* + ios_real_start_wda)',
    factoryNames.join(',') === IOS_TOOL_NAMES.join(','),
    factoryNames.join(' '),
  )
  step(
    'concurrency flags',
    tools.iosSimDevices.isConcurrencySafe({}) === true
      && tools.iosSimBuildRun.isConcurrencySafe({ projectPath: '/tmp/Demo.xcodeproj' }) === false,
    'devices=safe build_run=exclusive',
  )
  step('build_run declares a 10-minute timeout', tools.iosSimBuildRun.timeoutMs === 600_000)
  step('ios_real_start_wda declares an 8-minute timeout (cold build + ready wait)', tools.iosRealStartWda.timeoutMs === 480_000)

  if (!controller.status().available) throw new Error('serve-sim unavailable; cannot continue')

  // ── 2. ios_sim_devices ────────────────────────────────────────────────────
  const devicesResult = await tools.iosSimDevices.execute({}, makeExec('ios_sim_devices', {}))
  step(
    'ios_sim_devices lists >0 devices',
    Array.isArray(devicesResult.devices) && devicesResult.devices.length > 0
      && devicesResult.count === devicesResult.devices.length,
    `${devicesResult.count} devices`,
  )

  // Pick an iPhone, prefer the newest runtime (mirrors the sim-host smoke).
  const iphones = devicesResult.devices.filter(d => d.name.startsWith('iPhone'))
  if (iphones.length === 0) throw new Error('no available iPhone simulators')
  const byRuntime = (a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true })
  const picked = iphones.sort(byRuntime)[0]
  udid = picked.udid
  deviceName = picked.name
  step('pick iPhone simulator', true, `${deviceName} (${picked.runtime}, ${udid})`)

  // ── 3. ios_sim_boot ───────────────────────────────────────────────────────
  const bootResult = await tools.iosSimBoot.execute({ udid }, makeExec('ios_sim_boot', { udid }))
  step(
    'ios_sim_boot boots + streams',
    bootResult.state === 'booted' && bootResult.streaming === true && bootResult.device.udid === udid,
    `${deviceName} booted, stream up`,
  )
  bootedBySmoke = true
  const bootMeta = tools.iosSimBoot.output.presentationMeta({ udid }, bootResult)
  step(
    'boot presentationMeta is a stable sim-stream envelope',
    bootMeta.kind === 'sim-stream' && bootMeta.device.udid === udid
      && typeof bootMeta.streamRouteId === 'string' && bootMeta.streamRouteId.includes(udid),
    JSON.stringify(bootMeta),
  )
  step('sim host reports the running stream', controller.status().running === true
    && controller.status().device === udid, `port=${controller.status().port}`)

  // ── 4. ios_sim_screenshot ─────────────────────────────────────────────────
  const shot = await tools.iosSimScreenshot.execute({}, makeExec('ios_sim_screenshot', {}))
  const shotOk = typeof shot.path === 'string' && existsSync(shot.path) && shot.bytes > 50 * 1024
    && shot.device.udid === udid && shot.width > 0 && shot.height > 0
  step(
    'ios_sim_screenshot produces a PNG >50 KB',
    shotOk,
    `${Math.round(shot.bytes / 1024)} KB, ${shot.width}x${shot.height}, ${shot.path}`,
  )
  const shotMeta = tools.iosSimScreenshot.output.presentationMeta({}, shot)
  step(
    'screenshot presentationMeta carries kind + screenshotPath + device',
    shotMeta.kind === 'sim-screenshot' && shotMeta.screenshotPath === shot.path
      && shotMeta.path === shot.path && shotMeta.device.udid === udid,
  )
  const shotRender = tools.iosSimScreenshot.output.render({}, shot)
  step(
    'screenshot render returns text blocks, never image blocks',
    Array.isArray(shotRender) && shotRender.length === 1 && shotRender[0].type === 'text',
  )

  // ── 5. ios_sim_interact ───────────────────────────────────────────────────
  const interactArgs = { action: 'tap', x: 0.5, y: 0.5 }
  const interacted = await tools.iosSimInteract.execute(interactArgs, makeExec('ios_sim_interact', interactArgs))
  const interactOk = interacted.action === 'tap' && typeof interacted.path === 'string'
    && interacted.path !== shot.path && existsSync(interacted.path) && interacted.bytes > 0
  step(
    'ios_sim_interact tap 0.5 0.5 returns a fresh screenshot summary',
    interactOk,
    `${Math.round(interacted.bytes / 1024)} KB, ${interacted.path}`,
  )
  const interactMeta = tools.iosSimInteract.output.presentationMeta(interactArgs, interacted)
  step(
    'interact meta matches the screenshot shape',
    interactMeta.kind === 'sim-screenshot' && interactMeta.screenshotPath === interacted.path,
  )

  // ── 6. ios_sim_shutdown ───────────────────────────────────────────────────
  const shutdownResult = await tools.iosSimShutdown.execute({ udid }, makeExec('ios_sim_shutdown', { udid }))
  step(
    'ios_sim_shutdown stops the stream and shuts the device down',
    shutdownResult.state === 'shutdown' && shutdownResult.streaming === false
      && shutdownResult.device.udid === udid,
    'state=shutdown',
  )
  step('stream is gone after shutdown', controller.status().running === false)
  bootedBySmoke = false
  const afterShutdown = await listDevices()
  const ours = afterShutdown.find(d => d.udid === udid)
  step('device reports Shutdown', ours !== undefined && ours.state === 'Shutdown', ours?.state ?? 'missing')

  // ── 7. ios_sim_build_run ──────────────────────────────────────────────────
  const dryRun = {
    target: { kind: 'xcodeproj', root: '/tmp/dry-run', location: '/tmp/dry-run/Demo.xcodeproj' },
    scheme: 'Demo',
    configuration: 'Debug',
    udid: 'FAKE-UDID-0001',
    derivedDataPath: '/tmp/dsh-ios/builds/Demo/DerivedData',
  }
  const buildArgs = assembleBuildArgs(dryRun)
  const argsOk = buildArgs.includes('-project') && buildArgs.includes('/tmp/dry-run/Demo.xcodeproj')
    && buildArgs.includes('-scheme') && buildArgs.includes('Demo')
    && buildArgs.includes('-configuration') && buildArgs.includes('Debug')
    && buildArgs.includes('-destination') && buildArgs.includes('platform=iOS Simulator,id=FAKE-UDID-0001')
    && buildArgs.includes('-derivedDataPath') && buildArgs.includes('/tmp/dsh-ios/builds/Demo/DerivedData')
    && buildArgs[buildArgs.length - 1] === 'build'
  step('ios_sim_build_run argument assembly (dry run)', argsOk, buildArgs.join(' '))
  const noisy = [
    'CompileSwift normal arm64 /tmp/X.swift',
    'note: Building targets in dependency order',
    '',
    '/tmp/App.swift:12:3: error: cannot find \'Foo\' in scope',
    '   12 |     Foo()',
    '      |     ^',
  ]
  const filtered = filterBuildOutput(noisy)
  step(
    'build output filter keeps diagnostics, drops noise',
    filtered.includes('/tmp/App.swift:12:3: error: cannot find \'Foo\' in scope')
      && !filtered.includes('note: Building targets in dependency order') && !filtered.includes(''),
    filtered.join(' | '),
  )

  if (fullBuild) {
    // Generate a minimal SwiftUI app project, then exercise the whole
    // build → install → launch pipeline through the tool.
    const appDir = mkdtempSync(join(tmpdir(), 'dsh-ios-smoke-app-'))
    tempDirs.push(appDir)
    const projDir = join(appDir, 'MinimalApp.xcodeproj')
    mkdirSync(join(appDir, 'MinimalApp'), { recursive: true })
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(appDir, 'MinimalApp', 'App.swift'), [
      'import SwiftUI',
      '',
      '@main',
      'struct MinimalApp: App {',
      '    var body: some Scene {',
      '        WindowGroup {',
      '            Text("Smoke")',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'), { recursive: true })
    const objectVersion = 56
    const oid = index => `AA00000000000000000000${String(index).padStart(2, '0')}`
    writeFileSync(join(projDir, 'project.pbxproj'), [
      '// !$*UTF8*$!',
      '{',
      '\tarchiveVersion = 1;',
      '\tclasses = {',
      '\t};',
      `\tobjectVersion = ${objectVersion};`,
      '\tobjects = {',
      '',
      '/* Begin PBXBuildFile section */',
      `\t\t${oid(1)} /* App.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${oid(2)} /* App.swift */; };`,
      '/* End PBXBuildFile section */',
      '',
      '/* Begin PBXFileReference section */',
      `\t\t${oid(2)} /* App.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = App.swift; sourceTree = "<group>"; };`,
      `\t\t${oid(3)} /* MinimalApp.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = MinimalApp.app; sourceTree = BUILT_PRODUCTS_DIR; };`,
      '/* End PBXFileReference section */',
      '',
      '/* Begin PBXGroup section */',
      `\t\t${oid(4)} = {`,
      '\t\t\tisa = PBXGroup;',
      '\t\t\tchildren = (',
      `\t\t\t\t${oid(5)} /* MinimalApp */,`,
      `\t\t\t\t${oid(6)} /* Products */,`,
      '\t\t\t);',
      '\t\t\tsourceTree = "<group>";',
      '\t\t};',
      `\t\t${oid(5)} /* MinimalApp */ = {`,
      '\t\t\tisa = PBXGroup;',
      '\t\t\tchildren = (',
      `\t\t\t\t${oid(2)} /* App.swift */,`,
      '\t\t\t);',
      '\t\t\tpath = MinimalApp;',
      '\t\t\tsourceTree = "<group>";',
      '\t\t};',
      `\t\t${oid(6)} /* Products */ = {`,
      '\t\t\tisa = PBXGroup;',
      '\t\t\tchildren = (',
      `\t\t\t\t${oid(3)} /* MinimalApp.app */,`,
      '\t\t\t);',
      '\t\t\tname = Products;',
      '\t\t\tsourceTree = "<group>";',
      '\t\t};',
      '/* End PBXGroup section */',
      '',
      '/* Begin PBXNativeTarget section */',
      `\t\t${oid(7)} /* MinimalApp */ = {`,
      '\t\t\tisa = PBXNativeTarget;',
      `\t\t\tbuildConfigurationList = ${oid(8)} /* Build configuration list for PBXNativeTarget "MinimalApp" */;`,
      '\t\t\tbuildPhases = (',
      `\t\t\t\t${oid(9)} /* Sources */,`,
      '\t\t\t);',
      '\t\t\tbuildRules = (',
      '\t\t\t);',
      '\t\t\tdependencies = (',
      '\t\t\t);',
      '\t\t\tname = MinimalApp;',
      '\t\t\tproductName = MinimalApp;',
      `\t\t\tproductReference = ${oid(3)} /* MinimalApp.app */;`,
      '\t\t\tproductType = "com.apple.product-type.application";',
      '\t\t};',
      '/* End PBXNativeTarget section */',
      '',
      '/* Begin PBXProject section */',
      `\t\t${oid(10)} /* Project object */ = {`,
      '\t\t\tisa = PBXProject;',
      '\t\t\tattributes = {',
      '\t\t\t\tBuildIndependentTargetsInParallel = 1;',
      '\t\t\t\tLastUpgradeCheck = 1500;',
      '\t\t\t};',
      `\t\t\tbuildConfigurationList = ${oid(11)} /* Build configuration list for PBXProject "MinimalApp" */;`,
      '\t\t\tcompatibilityVersion = "Xcode 14.0";',
      '\t\t\tdevelopmentRegion = en;',
      '\t\t\thasScannedForEncodings = 0;',
      '\t\t\tknownRegions = (',
      '\t\t\t\ten,',
      '\t\t\t\tBase,',
      '\t\t\t);',
      `\t\t\tmainGroup = ${oid(4)};`,
      `\t\t\tproductRefGroup = ${oid(6)} /* Products */;`,
      '\t\t\tprojectDirPath = "";',
      '\t\t\tprojectRoot = "";',
      '\t\t\ttargets = (',
      `\t\t\t\t${oid(7)} /* MinimalApp */,`,
      '\t\t\t);',
      '\t\t};',
      '/* End PBXProject section */',
      '',
      '/* Begin PBXSourcesBuildPhase section */',
      `\t\t${oid(9)} /* Sources */ = {`,
      '\t\t\tisa = PBXSourcesBuildPhase;',
      '\t\t\tbuildActionMask = 2147483647;',
      '\t\t\tfiles = (',
      `\t\t\t\t${oid(1)} /* App.swift in Sources */,`,
      '\t\t\t);',
      '\t\t\trunOnlyForDeploymentPostprocessing = 0;',
      '\t\t};',
      '/* End PBXSourcesBuildPhase section */',
      '',
      '/* Begin XCBuildConfiguration section */',
      `\t\t${oid(12)} /* Debug */ = {`,
      '\t\t\tisa = XCBuildConfiguration;',
      '\t\t\tbuildSettings = {',
      '\t\t\t\tCODE_SIGNING_ALLOWED = NO;',
      '\t\t\t\tCODE_SIGN_STYLE = Automatic;',
      '\t\t\t\tCURRENT_PROJECT_VERSION = 1;',
      '\t\t\t\tENABLE_PREVIEWS = YES;',
      '\t\t\t\tGENERATE_INFOPLIST_FILE = YES;',
      '\t\t\t\tINFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES;',
      '\t\t\t\tINFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES;',
      '\t\t\t\tINFOPLIST_KEY_UILaunchScreen_Generation = YES;',
      '\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;',
      '\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (',
      '\t\t\t\t\t"$(inherited)",',
      '\t\t\t\t\t"@executable_path/Frameworks",',
      '\t\t\t\t);',
      '\t\t\t\tMARKETING_VERSION = 1.0;',
      '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = dev.dsh.smoke.MinimalApp;',
      '\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";',
      '\t\t\t\tSDKROOT = iphoneos;',
      '\t\t\t\tSUPPORTED_PLATFORMS = "iphoneos iphonesimulator";',
      '\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;',
      '\t\t\t\tSWIFT_VERSION = 5.0;',
      '\t\t\t\tTARGETED_DEVICE_FAMILY = 1;',
      '\t\t\t};',
      '\t\t\tname = Debug;',
      '\t\t};',
      `\t\t${oid(13)} /* Debug */ = {`,
      '\t\t\tisa = XCBuildConfiguration;',
      '\t\t\tbuildSettings = {',
      '\t\t\t\tCLANG_ENABLE_MODULES = YES;',
      '\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;',
      '\t\t\t\tENABLE_TESTABILITY = YES;',
      '\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;',
      '\t\t\t\tMTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE;',
      '\t\t\t\tONLY_ACTIVE_ARCH = YES;',
      '\t\t\t\tSDKROOT = iphoneos;',
      '\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)";',
      '\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";',
      '\t\t\t};',
      '\t\t\tname = Debug;',
      '\t\t};',
      '/* End XCBuildConfiguration section */',
      '',
      '/* Begin XCConfigurationList section */',
      `\t\t${oid(11)} /* Build configuration list for PBXProject "MinimalApp" */ = {`,
      '\t\t\tisa = XCConfigurationList;',
      '\t\t\tbuildConfigurations = (',
      `\t\t\t\t${oid(13)} /* Debug */,`,
      '\t\t\t);',
      '\t\t\tdefaultConfigurationIsVisible = 0;',
      '\t\t\tdefaultConfigurationName = Debug;',
      '\t\t};',
      `\t\t${oid(8)} /* Build configuration list for PBXNativeTarget "MinimalApp" */ = {`,
      '\t\t\tisa = XCConfigurationList;',
      '\t\t\tbuildConfigurations = (',
      `\t\t\t\t${oid(12)} /* Debug */,`,
      '\t\t\t);',
      '\t\t\tdefaultConfigurationIsVisible = 0;',
      '\t\t\tdefaultConfigurationName = Debug;',
      '\t\t};',
      '/* End XCConfigurationList section */',
      '\t};',
      `\trootObject = ${oid(10)} /* Project object */;`,
      '}',
      '',
    ].join('\n'))

    const buildResult = await tools.iosSimBuildRun.execute(
      { projectPath: projDir, udid },
      makeExec('ios_sim_build_run', { projectPath: projDir, udid }),
    )
    bootedBySmoke = true
    step(
      'ios_sim_build_run full path: build → install → launch',
      buildResult.state === 'launched' && buildResult.bundleId === 'dev.dsh.smoke.MinimalApp'
        && /^\d+$/.test(buildResult.pid) && existsSync(buildResult.appPath),
      `bundleId=${buildResult.bundleId} pid=${buildResult.pid} app=${buildResult.appPath}`,
    )
    step(
      'build_run presentationMeta is a stable envelope',
      tools.iosSimBuildRun.output.presentationMeta({ projectPath: projDir }, buildResult).kind === 'sim-build-run',
    )
    await shutdownDevice(udid)
    bootedBySmoke = false
  } else {
    step('ios_sim_build_run full path skipped (dry run only)', true, 'pass --full-build to build a minimal SwiftUI app')
  }

  // ── 8. presenters stay pure ───────────────────────────────────────────────
  const presenterSamples = [
    [tools.iosSimDevices, {}],
    [tools.iosSimBoot, { udid }],
    [tools.iosSimShutdown, { udid }],
    [tools.iosSimScreenshot, { udid }],
    [tools.iosSimInteract, { action: 'button', name: 'home' }],
    [tools.iosSimBuildRun, { projectPath: '/tmp/Demo.xcodeproj', udid }],
  ]
  let presentersOk = true
  for (const [tool, args] of presenterSamples) {
    try {
      tool.presentCall(args)
    } catch (error) {
      presentersOk = false
      console.error(`  presentCall threw for ${tool.name}: ${error}`)
    }
  }
  const metaValue = { path: '/cache/screenshots/x.png', bytes: 1, device: { udid, name: deviceName, runtime: 'r', state: 'Booted' } }
  const metaA = tools.iosSimScreenshot.output.presentationMeta({}, metaValue)
  const metaB = tools.iosSimScreenshot.output.presentationMeta({}, metaValue)
  step(
    'presentCall never throws and presentationMeta is pure/replayable',
    presentersOk && JSON.stringify(metaA) === JSON.stringify(metaB),
  )

  // ── 9. no leftovers ───────────────────────────────────────────────────────
  const leftDevices = (await bootedDevices()).map(d => `${d.name} ${d.udid}`)
  step('no booted simulators left', leftDevices.length === 0, leftDevices.join(', ') || 'none')

  let serveSimProcs = ''
  try {
    serveSimProcs = execFileSync('pgrep', ['-fl', 'serve-sim'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    // pgrep exit 1 = no matches, which is what we want
  }
  step('no serve-sim processes left', serveSimProcs === '', serveSimProcs || 'none')
} catch (error) {
  step('smoke completed without uncaught errors', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  // ── best-effort cleanup no matter what happened ───────────────────────────
  try {
    if (tools !== undefined && controller !== undefined && udid !== undefined) {
      await tools.iosSimShutdown.execute({ udid }, makeExec('ios_sim_shutdown', { udid }))
    }
  } catch { /* device may not be booted/streamed */ }
  try {
    if (controller !== undefined) await controller.dispose()
  } catch { /* already disposed or teardown best-effort */ }
  try {
    if (bootedBySmoke && udid !== undefined) await shutdownDevice(udid)
  } catch { /* already shut down */ }
  try {
    const left = await bootedDevices()
    for (const device of left) {
      try { await shutdownDevice(device.udid) } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
  try {
    execFileSync('pkill', ['-f', 'serve-sim'], { stdio: 'ignore', timeout: 10_000 })
  } catch { /* pkill exit 1 = nothing to kill */ }
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
