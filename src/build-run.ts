/**
 * xcodebuild pipeline for `ios_sim_build_run`: detect the project kind,
 * assemble the simulator build command, build, locate the produced `.app`,
 * install it, and launch it on the simulator.
 *
 * The module owns every `xcodebuild`/`PlistBuddy` invocation; tool handlers
 * never shell out directly. `assembleBuildArgs` is exported so tests can
 * verify the command shape without a full (minutes-long) build.
 * @module @zseven-w/dsh-ios/build-run
 */

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { installApp, launchApp, type SimulatorDevice } from './simctl.js'
import {
  detectAppleDevelopmentIdentity,
  installApp as installAppOnDevice,
  launchApp as launchAppOnDevice,
  type RealDevice,
} from './devicectl.js'

/** How `projectPath` is fed to xcodebuild. */
export type ProjectKind = 'xcodeproj' | 'xcworkspace' | 'package'

/** A detected, buildable project on disk. */
export interface ProjectTarget {
  kind: ProjectKind
  /** Directory the build runs in. */
  root: string
  /** Path handed to `-project`/`-workspace` (equals `root` for packages). */
  location: string
}

/** Options shared by the arg assembler and the runner. */
export interface BuildInvocation {
  target: ProjectTarget
  /** xcodebuild scheme name; omitted means "let xcodebuild pick" (project/workspace only). */
  scheme?: string
  configuration: string
  /** Destination udid (simulator udid or physical-device identifier). */
  udid: string
  /** `-derivedDataPath` value (plugin-owned cache). */
  derivedDataPath: string
  /** Build platform; defaults to 'simulator' for backwards compatibility. */
  platform?: 'simulator' | 'device'
  /**
   * Device builds only: automatic-signing settings derived from the login
   * keychain's Apple Development identity. `-allowProvisioningUpdates` is
   * deliberately NOT passed — provisioning-profile creation is an Xcode
   * account operation; existing local profiles are used as-is and the
   * failure hint explains the signing requirements when none match.
   */
  signing?: { teamId?: string }
}

/**
 * Build target device: a simulator or a USB-connected physical device.
 * Discriminated so the install/launch steps can route to simctl vs devicectl.
 */
export type BuildDevice =
  | { kind: 'simulator'; device: SimulatorDevice }
  | { kind: 'device'; device: RealDevice }

/** Successful outcome of build + install + launch. */
export interface BuildRunResult {
  device: {
    udid: string
    name: string
    runtime: string
    state: string
  }
  state: 'launched'
  bundleId: string
  /** PID reported by `simctl launch`/`devicectl process launch`, or '' when it did not parse. */
  pid: string
  appPath: string
  projectPath: string
  scheme?: string
  configuration: string
  /** True when the app was installed/launched on a physical device. */
  physicalDevice?: boolean
}

const LIST_TIMEOUT_MS = 60_000
const PLIST_TIMEOUT_MS = 30_000
const OUTPUT_TAIL_LINES = 400
const ERROR_TAIL_LINES = 80

/** Path-safe slug for the project's cache directory. */
export function projectSlug(projectPath: string): string {
  const base = basename(projectPath).replace(/\.(xcodeproj|xcworkspace)$/u, '')
  const slug = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'project'
  return slug
}

/** Detect what `projectPath` is; throws with an actionable message when not. */
export function detectProject(projectPath: string): ProjectTarget {
  const absolute = resolve(projectPath)
  const lower = absolute.toLowerCase()
  if (lower.endsWith('.xcodeproj')) {
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`projectPath does not exist or is not a directory: ${projectPath}`)
    }
    return { kind: 'xcodeproj', root: dirname(absolute), location: absolute }
  }
  if (lower.endsWith('.xcworkspace')) {
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`projectPath does not exist or is not a directory: ${projectPath}`)
    }
    return { kind: 'xcworkspace', root: dirname(absolute), location: absolute }
  }
  if (existsSync(absolute) && statSync(absolute).isDirectory() && existsSync(join(absolute, 'Package.swift'))) {
    return { kind: 'package', root: absolute, location: absolute }
  }
  throw new Error(
    `projectPath must be an absolute path to a .xcodeproj, a .xcworkspace, or a Swift package directory containing Package.swift: ${projectPath}`,
  )
}

/**
 * Assemble the exact `xcodebuild` argument vector for the build. Simulator
 * builds target `platform=iOS Simulator,id=<udid>`; device builds target
 * `platform=iOS,id=<udid>` and append automatic code-signing settings
 * (CODE_SIGN_STYLE=Automatic + DEVELOPMENT_TEAM) when a signing team is
 * known. Exported for dry-run verification.
 */
export function assembleBuildArgs(invocation: BuildInvocation): string[] {
  const { target, configuration, udid, derivedDataPath } = invocation
  const platform = invocation.platform ?? 'simulator'
  const args: string[] = []
  if (target.kind === 'xcodeproj') args.push('-project', target.location)
  else if (target.kind === 'xcworkspace') args.push('-workspace', target.location)
  if (invocation.scheme !== undefined) args.push('-scheme', invocation.scheme)
  args.push(
    '-configuration', configuration,
    '-destination', `${platform === 'device' ? 'platform=iOS,id=' : 'platform=iOS Simulator,id='}${udid}`,
    '-derivedDataPath', derivedDataPath,
  )
  if (platform === 'device') {
    args.push('CODE_SIGN_STYLE=Automatic')
    if (invocation.signing?.teamId !== undefined) {
      args.push(`DEVELOPMENT_TEAM=${invocation.signing.teamId}`)
    }
  }
  args.push('build')
  return args
}

/** Read the top-level `name:` of a Swift package manifest (best effort). */
export async function packageNameFromManifest(packageDir: string): Promise<string | undefined> {
  try {
    const manifest = await readFile(join(packageDir, 'Package.swift'), 'utf8')
    const match = /^\s*name\s*:\s*"([^"]+)"/mu.exec(manifest)
    return match === null ? undefined : match[1]
  } catch {
    return undefined
  }
}

/** List xcodebuild schemes for a project/workspace (`xcodebuild -list -json`). */
export async function listSchemes(target: ProjectTarget, signal?: AbortSignal): Promise<string[]> {
  if (target.kind === 'package') return []
  const stdout = await new Promise<string>((resolveList, rejectList) => {
    execFile('xcodebuild', ['-list', '-json'], {
      cwd: target.root,
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    }, (error, out, stderr) => {
      if (error !== null) {
        rejectList(new Error(`xcodebuild -list failed${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
        return
      }
      resolveList(out)
    })
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const record = parsed as Record<string, unknown>
  for (const section of [record.workspace, record.project]) {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) continue
    const schemes = (section as Record<string, unknown>).schemes
    if (!Array.isArray(schemes)) continue
    // `xcodebuild -list -json` reports schemes as plain strings.
    const names = schemes.flatMap(scheme => {
      if (typeof scheme === 'string' && scheme !== '') return [scheme]
      if (typeof scheme === 'object' && scheme !== null && !Array.isArray(scheme)) {
        const name = (scheme as Record<string, unknown>).name
        if (typeof name === 'string' && name !== '') return [name]
      }
      return []
    })
    if (names.length > 0) return names
  }
  return []
}

/** Resolve the scheme to build: explicit > package manifest > first listed. */
export async function resolveScheme(
  target: ProjectTarget,
  scheme: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (scheme !== undefined && scheme.trim() !== '') return scheme.trim()
  if (target.kind === 'package') {
    const manifestName = await packageNameFromManifest(target.location)
    return manifestName ?? basename(target.location)
  }
  const schemes = await listSchemes(target, signal)
  if (schemes.length > 0) return schemes[0]
  return undefined
}

type XcodebuildChild = ChildProcessByStdio<null, Readable, Readable>

/** Run `xcodebuild … build`, capturing the last OUTPUT_TAIL_LINES output lines. */
export async function runXcodeBuild(
  invocation: BuildInvocation,
  signal: AbortSignal,
): Promise<{ exitCode: number | null; lines: string[] }> {
  const args = assembleBuildArgs(invocation)
  const child: XcodebuildChild = spawn('xcodebuild', args, {
    cwd: invocation.target.root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      lines.push(line.trimEnd())
      if (lines.length > OUTPUT_TAIL_LINES) lines.shift()
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const onAbort = (): void => { child.kill('SIGKILL') }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('close', code => resolveExit(code))
    })
    return { exitCode, lines }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Activity/boilerplate lines xcodebuild floods stdout with; not actionable. */
const BUILD_NOISE = /^(Write auxiliary files|WriteAuxiliaryFile|Touch|CodeSign|RegisterExecutionPolicyException|RegisterWithLaunchServices|ProcessInfoPlistFile|ProcessProductPackaging|CopyPlistFile|CreateBuildDirectory|CreateUniversalBinary|CreateCoreMLModel|MkDir|SymLink|CpResource|CpHeader|CompileAssetCatalog|CompileC|CompileSwift|SwiftDriver|SwiftEmitModule|SwiftCompile|ScanDependencies|BuiltinSwift|LinkStoryboards|Validate|GenerateDSYMFile|PBXCp|PhaseScriptExecution|MergeSwiftModule|EmitSwiftModule|Verify|SetOwnerAndGroup|SetMode|ComputeTargetDependencyGraph|ComputePackagePrebuildTargetDependencyGraph|GatherProvisioningInputs|ProcessXCFramework|AppIntentsSSUTraining|Activate|ExtractAppIntentsMetadata|CopyStringsFile|note: Building targets|note: Target dependency|note: Planning|note: Build preparation|note: Using)/u

/**
 * Reduce xcodebuild output to the last ~80 informative lines: drop blank
 * lines and the boilerplate activity lines above, keep compiler diagnostics
 * (`file.swift:12:3: error: …` plus their caret context).
 */
export function filterBuildOutput(lines: string[], limit = ERROR_TAIL_LINES): string[] {
  return lines.filter(line => line !== '' && !BUILD_NOISE.test(line)).slice(-limit)
}

/** Tail of build output used inside the thrown failure message. */
export function buildFailureDetail(lines: string[]): string {
  const tail = filterBuildOutput(lines)
  return tail.length === 0 ? '(no output captured)' : tail.join('\n')
}

/**
 * Locate the freshly built `.app` under the DerivedData products directory
 * for the target SDK (`-iphonesimulator` for simulators, `-iphoneos` for
 * physical devices).
 */
export function findBuiltApp(
  derivedDataPath: string,
  configuration: string,
  productHint?: string,
  sdkSuffix: 'iphonesimulator' | 'iphoneos' = 'iphonesimulator',
): string | undefined {
  const products = join(derivedDataPath, 'Build', 'Products', `${configuration}-${sdkSuffix}`)
  if (!existsSync(products)) return undefined
  const apps = readdirSync(products)
    .filter(name => name.endsWith('.app'))
    .map(name => join(products, name))
    .filter(path => statSync(path).isDirectory() && existsSync(join(path, 'Info.plist')))
  if (apps.length === 0) return undefined
  if (productHint !== undefined) {
    const hinted = apps.find(path => basename(path) === `${productHint}.app`)
    if (hinted !== undefined) return hinted
  }
  apps.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return apps[0]
}

/** Read `CFBundleIdentifier` from a built app's Info.plist via PlistBuddy. */
export async function readBundleIdentifier(appPath: string, signal?: AbortSignal): Promise<string> {
  const infoPlist = join(appPath, 'Info.plist')
  if (!existsSync(infoPlist)) {
    throw new Error(`built app has no Info.plist: ${appPath}`)
  }
  const stdout = await new Promise<string>((resolvePlist, rejectPlist) => {
    execFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', infoPlist], {
      timeout: PLIST_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      signal,
    }, (error, out, stderr) => {
      if (error !== null) {
        rejectPlist(new Error(`could not read CFBundleIdentifier from ${infoPlist}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
        return
      }
      resolvePlist(out)
    })
  })
  const bundleId = stdout.trim()
  if (bundleId === '') throw new Error(`CFBundleIdentifier is empty in ${infoPlist}`)
  return bundleId
}

export interface BuildRunOptions {
  target: ProjectTarget
  scheme?: string
  configuration: string
  /** Simulator or physical device to install/launch onto. */
  device: BuildDevice
  cacheDir: string
  signal: AbortSignal
}

/** Actionable code-signing explanation shown when no identity exists. */
export const DEVICE_SIGNING_HINT =
  'building and installing on a physical iPhone requires code signing with an "Apple Development" '
  + 'certificate in the login keychain (security find-identity -v -p codesigning). '
  + 'With an identity present, xcodebuild automatic signing (CODE_SIGN_STYLE=Automatic + DEVELOPMENT_TEAM) '
  + 'uses the provisioning profiles already installed on this Mac; when none covers the app, create one '
  + 'in Xcode (Signing & Capabilities) or run the build with -allowProvisioningUpdates once (requires an '
  + 'authenticated Apple ID session). Also install the iOS platform matching the device\u2019s OS version '
  + '(Xcode → Settings → Components).'

/** Extra guidance appended to device-build failures. */
function deviceFailureHint(lines: string[]): string {
  const tail = lines.join('\n')
  if (/is not installed[\s\S]*Settings > Components|download and install the platform/i.test(tail)) {
    return '\nThe iOS platform matching the device\u2019s OS is not installed on this Mac — '
      + 'install it via Xcode → Settings → Components, then retry.'
  }
  if (/provisioning profile|code signing|signing for|development team|requires a development team/i.test(tail)) {
    return '\nCode-signing note: ' + DEVICE_SIGNING_HINT
  }
  return ''
}

/**
 * Full pipeline: build → find the app → install → launch. Simulator targets
 * route install/launch through simctl; physical devices build with
 * `-destination platform=iOS,id=<udid>`, require an Apple Development
 * signing identity (checked up front, with an actionable error when absent),
 * and install/launch through devicectl. Build failures throw with the
 * filtered xcodebuild tail plus, for device builds, a signing/platform hint.
 */
export async function buildRun(options: BuildRunOptions): Promise<BuildRunResult> {
  const { target, configuration, device, cacheDir, signal } = options
  const platform: 'simulator' | 'device' = device.kind
  let signing: { teamId?: string } | undefined
  if (device.kind === 'device') {
    const identity = await detectAppleDevelopmentIdentity(signal)
    if (identity === undefined) {
      throw new Error(
        `ios_sim_build_run: no valid Apple Development signing identity was found in the login keychain — ${DEVICE_SIGNING_HINT}`,
      )
    }
    signing = { ...(identity.teamId === undefined ? {} : { teamId: identity.teamId }) }
  }
  const udid = device.device.udid
  const derivedDataPath = join(cacheDir, 'builds', projectSlug(target.location), 'DerivedData')
  const scheme = await resolveScheme(target, options.scheme, signal)
  const invocation: BuildInvocation = {
    target,
    scheme,
    configuration,
    udid,
    derivedDataPath,
    platform,
    signing,
  }

  const { exitCode, lines } = await runXcodeBuild(invocation, signal)
  if (exitCode !== 0) {
    throw new Error(
      `xcodebuild failed (exit ${String(exitCode)}) for ${normalize(target.location)}:\n${buildFailureDetail(lines)}`
      + (platform === 'device' ? deviceFailureHint(lines) : ''),
    )
  }
  const appPath = findBuiltApp(derivedDataPath, configuration, scheme, platform === 'device' ? 'iphoneos' : 'iphonesimulator')
  if (appPath === undefined) {
    throw new Error(
      `xcodebuild finished but no .app bundle was found under ${derivedDataPath} — `
      + `check the scheme/configuration produce an iOS ${platform === 'device' ? 'device' : 'Simulator'} app`,
    )
  }
  const bundleId = await readBundleIdentifier(appPath, signal)
  if (device.kind === 'device') {
    await installAppOnDevice(udid, appPath, signal)
    const { pid } = await launchAppOnDevice(udid, bundleId, signal)
    return {
      device: {
        udid,
        name: device.device.name,
        runtime: device.device.osVersion ?? '',
        state: device.device.state,
      },
      state: 'launched',
      bundleId,
      pid: pid === undefined ? '' : String(pid),
      appPath,
      projectPath: target.location,
      ...(scheme === undefined ? {} : { scheme }),
      configuration,
      physicalDevice: true,
    }
  }
  await installApp(udid, appPath, signal)
  const launchOutput = await launchApp(udid, bundleId, signal)
  // `simctl launch` prints `<bundle-id>: <pid>`.
  const pidMatch = /:\s*(\d+)\s*$/u.exec(launchOutput.trim())
  return {
    device: { udid, name: device.device.name, runtime: device.device.runtime, state: 'Booted' },
    state: 'launched',
    bundleId,
    pid: pidMatch === null ? '' : pidMatch[1],
    appPath,
    projectPath: target.location,
    ...(scheme === undefined ? {} : { scheme }),
    configuration,
  }
}
