/**
 * SwiftUI preview hot-reload engine for the iOS Simulator.
 *
 * Architecture (reimplemented from the publicly documented Codex
 * `ios-simulator-browser` skill description; github.com/openai/plugins ships
 * WITHOUT a license, so no Codex code was copied — only the published
 * approach, which the skill's SKILL.md describes as "generate a disposable
 * host project outside the user's source tree, install and launch that host
 * in the simulator, watch the package for edits, rebuild a generated dylib
 * and hot-swap it into the running host without relaunching the app"):
 *
 *  1. A disposable host app is generated under a plugin-owned cache dir —
 *     never inside the user's package. It is a minimal SwiftUI `App`
 *     (assets/preview-host/*.swift) that polls
 *     `Documents/dsh-preview-drop/` inside its own sandbox container.
 *  2. The user's Swift package is compiled into a generated dynamic
 *     library for the simulator (`xcrun swift build --sdk iphonesimulator
 *     --triple <arch>-apple-ios<v>-simulator`) exposing three @_cdecl
 *     entry points (`dsh_preview_count`, `dsh_preview_name`,
 *     `dsh_preview_make_view`).
 *  3. On every package edit (fs.watch on the package tree, 300 ms
 *     debounce) the dylib is rebuilt incrementally, ad-hoc signed, copied
 *     into the drop dir as `preview_<n>.dylib` plus a `manifest.json`, and
 *     the host dlopens it and swaps the preview view WITHOUT relaunching.
 *     Failed rebuilds never crash the loop: the host keeps the last good
 *     preview and the compiler error tail is exposed through `status()`.
 *  4. The host confirms every load by writing `result.json` (generation,
 *     previews, error, pid) back into the same dir; the plugin polls it
 *     from the Mac side of the container (`simctl get_app_container`).
 *
 * Preview enumeration scans `Sources/**` for `#Preview { … }` declarations
 * (the body is spliced into a @ViewBuilder wrapper) and for
 * `struct X_Previews: PreviewProvider` (referenced as `X_Previews.previews`).
 * Types used by a preview must be internal or public — file-private symbols
 * cannot be seen from the generated entry module (the same visibility rule
 * every generated preview host lives with).
 * @module @zseven-w/dsh-ios/preview-host
 */

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { projectSlug } from './build-run.js'
import type { SimHostController } from './sim-host.js'
import {
  bootDevice,
  bootedDevices,
  compareRuntimesDesc,
  getAppContainer,
  getDevice,
  installApp,
  launchApp,
  listDevices,
  shutdownDevice,
  terminateApp,
  uninstallApp,
  type SimulatorDevice,
} from './simctl.js'

/** Bundle id of the generated host app (stable across sessions). */
export const PREVIEW_HOST_BUNDLE_ID = 'com.dsh-ios.preview-host'

/** One preview variant shown by the generated host. */
export interface PreviewEntry {
  /** Stable index-based id inside one dylib generation (`p0`, `p1`, …). */
  id: string
  /** Display name: the `#Preview` label or the PreviewProvider struct name. */
  name: string
  kind: 'macro' | 'provider'
}

/** Timing of the most recent successful reload. */
export interface PreviewReloadInfo {
  generation: number
  /** Incremental dylib build wall time (ms). */
  buildMs: number
  /** Edit → host-confirmed swap wall time (ms). */
  totalMs: number
}

/** Snapshot returned by `status()` (the `ios_sim_preview` status action). */
export interface PreviewHostStatus {
  running: boolean
  mode: 'dylib-hot-swap'
  device?: SimulatorDevice
  host?: { bundleId: string; pid?: string }
  package?: { path: string; name: string }
  watching?: boolean
  /** Last pushed generation (monotonic counter, shared with the host manifest). */
  generation?: number
  /** Last generation the host confirmed loaded (from result.json). */
  loadedGeneration?: number
  previews?: PreviewEntry[]
  reloads?: number
  lastReload?: PreviewReloadInfo
  /** Last ~40 lines of the failed rebuild output; absent while healthy. */
  lastBuildError?: string[]
  lastRuntimeError?: string
  startedAt?: number
}

/** Result of a successful `start()`. */
export interface PreviewStartResult {
  running: true
  device: SimulatorDevice
  host: { bundleId: string; pid?: string }
  package: { path: string; name: string }
  mode: 'dylib-hot-swap'
  watching: true
  previews: PreviewEntry[]
  generation: number
}

/** Result of `stop()`. */
export interface PreviewStopResult {
  state: 'stopped'
  running: false
  device?: SimulatorDevice
  host?: { bundleId: string; terminated: boolean }
}

export interface PreviewStartOptions {
  /** Absolute path to a Swift package directory (contains Package.swift). */
  packagePath: string
  /** Simulator udid/name override (else streamed → booted → newest iPhone). */
  udid?: string
  /** Case-insensitive name substring filter when several previews exist. */
  previewFilter?: string
  signal?: AbortSignal
}

export interface PreviewHostOptions {
  /** The sim host controller shared with the rest of the plugin. */
  host: SimHostController
  /** Plugin-owned cache root for generated projects/builds. */
  cacheDir: string
  /** One-line progress logger (the cordis logger in production). */
  logger?: (line: string) => void
}

const HOST_TARGET_NAME = 'DshPreviewHost'
const DYLIB_TARGET_NAME = 'DshPreviewDylib'
const DYLIB_LIBRARY_NAME = `lib${DYLIB_TARGET_NAME}.dylib`
const DROP_DIR_NAME = 'dsh-preview-drop'
const DEFAULT_IOS_PLATFORM_VERSION = 17
const REBUILD_DEBOUNCE_MS = 300
const HOST_CONFIRM_TIMEOUT_MS = 30_000
const RELOAD_CONFIRM_TIMEOUT_MS = 15_000
const HOST_POLL_INTERVAL_MS = 500
const SWIFT_BUILD_TIMEOUT_MS = 600_000
const SWIFT_OUTPUT_RING_LINES = 1000
const ERROR_TAIL_LINES = 40
const KEPT_DYLIB_GENERATIONS = 3
const SIMULATOR_UNAVAILABLE = 'iOS Simulator requires macOS with Xcode'

interface ScannedPreview {
  kind: 'macro' | 'provider'
  name: string
  /** Macro closure body (spliced into a @ViewBuilder wrapper). */
  body?: string
  /** Provider expression, e.g. `Module.Foo_Previews.previews`. */
  ref?: string
}

interface PackageManifest {
  name: string
  libraryTargets: string[]
  productNames: string[]
  targetDirs: Map<string, string>
  iosVersion?: number
}

/** Internal state of the single active preview session. */
interface PreviewSession {
  packagePath: string
  packageName: string
  device: SimulatorDevice
  pid: string
  filter?: string
  dropDir: string
  dylibPackageDir: string
  triple: string
  sdk: string
  platformVersion: number
  generation: number
  loadedGeneration: number
  previews: PreviewEntry[]
  watcher: PackageWatcher
  debounceTimer?: NodeJS.Timeout
  rebuildRunning: boolean
  rebuildQueued: boolean
  reloads: number
  lastReload?: PreviewReloadInfo
  lastBuildError?: string[]
  lastRuntimeError?: string
  startedAt: number
  streamStartedByUs: boolean
  bootedByUs: boolean
  disposed: boolean
}

interface PackageWatcher {
  close(): void
}

type SwiftBuildChild = ChildProcessByStdio<null, Readable, Readable>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function assertDarwin(): void {
  if (process.platform !== 'darwin') {
    throw new Error(`${SIMULATOR_UNAVAILABLE} — this host runs ${process.platform}, so no simulator tools can run here`)
  }
}

/** Simulator arch of the host machine (Apple Silicon arm64 / Intel x86_64). */
function simulatorArch(): string {
  return process.arch === 'x64' ? 'x86_64' : 'arm64'
}

function simulatorTriple(platformVersion: number): string {
  return `${simulatorArch()}-apple-ios${platformVersion}.0-simulator`
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, path)
}

/** Swift string literal escaping (JSON escaping is a safe subset for Swift). */
function swiftStringLiteral(value: string): string {
  return JSON.stringify(value)
}

function resolvePreviewHostAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(here, '..', 'assets', 'preview-host'), resolve(here, '..', '..', 'assets', 'preview-host')]
  const override = process.env.DSH_IOS_PREVIEW_HOST_ASSETS?.trim()
  if (override !== undefined && override !== '') candidates.unshift(override)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'PreviewHostApp.swift'))) return dir
  }
  throw new Error('dsh-ios: preview host assets not found — reinstall the plugin (assets/preview-host/)')
}

// ── Package manifest parsing ───────────────────────────────────────────────

/**
 * Extract the balanced `( … )` content of every `.<selector>(` call in the
 * manifest text (selectors like `.target`, `.library`). Plain-text scan with
 * a paren-depth counter; the manifests we target are declarative.
 */
function extractCallArguments(text: string, selector: string): string[] {
  const found: string[] = []
  const needle = `.${selector}`
  let searchFrom = 0
  for (;;) {
    const index = text.indexOf(needle, searchFrom)
    if (index < 0) break
    const previous = text[index - 1]
    if (previous !== undefined && /[\w$]/.test(previous)) {
      searchFrom = index + needle.length
      continue
    }
    let cursor = index + needle.length
    while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1
    if (text[cursor] !== '(') {
      searchFrom = index + needle.length
      continue
    }
    let depth = 0
    const start = cursor
    for (; cursor < text.length; cursor += 1) {
      const char = text[cursor]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          found.push(text.slice(start + 1, cursor))
          break
        }
      }
    }
    searchFrom = cursor + 1
  }
  return found
}

/** Parse Package.swift into the bits the generated packages need. */
function readPackageManifest(packageDir: string): PackageManifest {
  const manifestPath = join(packageDir, 'Package.swift')
  if (!existsSync(manifestPath)) throw new Error(`no Package.swift found in ${packageDir}`)
  const text = readFileSync(manifestPath, 'utf8')
  // The first `name:` occurrence in a manifest is the package name (targets,
  // products and dependencies all come later in the text).
  const nameMatch = /name\s*:\s*"([^"]+)"/u.exec(text)
  const name = nameMatch === null ? 'Package' : nameMatch[1]
  const iosVersionMatch = /\.iOS\(\s*\.v(\d+)\s*\)/u.exec(text)
  const iosVersion = iosVersionMatch === null ? undefined : Number(iosVersionMatch[1])

  const libraryTargets: string[] = []
  const targetDirs = new Map<string, string>()
  for (const args of extractCallArguments(text, 'target')) {
    const targetName = /name\s*:\s*"([^"]+)"/u.exec(args)
    if (targetName === null) continue
    const pathMatch = /path\s*:\s*"([^"]+)"/u.exec(args)
    const dir = pathMatch === null ? join(packageDir, 'Sources', targetName[1]) : resolve(packageDir, pathMatch[1])
    libraryTargets.push(targetName[1])
    targetDirs.set(targetName[1], dir)
  }
  const productNames = extractCallArguments(text, 'library')
    .flatMap(args => /name\s*:\s*"([^"]+)"/u.exec(args)?.slice(1) ?? [])
  return {
    name,
    libraryTargets,
    // With no declared products SwiftPM synthesizes one per target; the
    // generated dylib can depend on those implicit products by target name.
    productNames: productNames.length > 0 ? productNames : libraryTargets,
    targetDirs,
    ...(iosVersion === undefined ? {} : { iosVersion }),
  }
}

// ── Preview enumeration (Source scan) ───────────────────────────────────────

/**
 * Replace string/comment contents with spaces, keeping every position
 * (newlines preserved). Lets the brace/paren scanners below run without
 * string/comment awareness.
 */
function stripStringsAndComments(text: string): string {
  const chars = [...text]
  const out = chars.slice()
  let index = 0
  while (index < chars.length) {
    const char = chars[index]
    if (char === '/' && chars[index + 1] === '/') {
      while (index < chars.length && chars[index] !== '\n') {
        if (out[index] !== '\n') out[index] = ' '
        index += 1
      }
      continue
    }
    if (char === '/' && chars[index + 1] === '*') {
      while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) {
        if (out[index] !== '\n') out[index] = ' '
        index += 1
      }
      if (index < chars.length) {
        out[index] = ' '
        out[index + 1] = ' '
        index += 2
      }
      continue
    }
    if (char === '"') {
      if (chars[index + 1] === '"' && chars[index + 2] === '"') {
        index += 3
        while (index < chars.length && !(chars[index] === '"' && chars[index + 1] === '"' && chars[index + 2] === '"')) {
          if (out[index] !== '\n') out[index] = ' '
          index += 1
        }
        // Keep the closing delimiter visible (positions stay aligned and the
        // label scanner can still see the string as a quoted literal).
        index += 3
        continue
      }
      index += 1
      while (index < chars.length && chars[index] !== '"') {
        if (chars[index] === '\\') {
          if (out[index] !== '\n') out[index] = ' '
          index += 1
        }
        if (index < chars.length && out[index] !== '\n') out[index] = ' '
        index += 1
      }
      // Keep the closing quote visible; only the content is blanked.
      index += 1
      continue
    }
    index += 1
  }
  return out.join('')
}

/** Index of the delimiter closing the one opened at `openIndex`. */
function findClosingDelimiter(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === open) depth += 1
    else if (text[index] === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** First `"…"` in the text with basic `\"`/`\\` unescaping, else undefined. */
function firstQuotedString(text: string): string | undefined {
  const match = /"((?:[^"\\]|\\.)*)"/u.exec(text)
  if (match === null) return undefined
  return match[1].replace(/\\(["\\])/gu, '$1')
}

/**
 * Enumerate `#Preview { … }` declarations (name + closure body). Structure
 * is scanned on the sanitized text (positions preserved), while the label
 * and body are read back from the original source so real string contents
 * survive into the generated entry.
 */
function scanMacroPreviews(original: string, sanitized: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = []
  const pattern = /#Preview\b/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sanitized)) !== null) {
    if (match.index > 0 && /[\w$]/u.test(sanitized[match.index - 1])) continue
    let cursor = match.index + match[0].length
    while (cursor < sanitized.length && /\s/u.test(sanitized[cursor])) cursor += 1
    let label: string | undefined
    if (sanitized[cursor] === '(') {
      const close = findClosingDelimiter(sanitized, cursor, '(', ')')
      if (close < 0) continue
      label = firstQuotedString(original.slice(cursor + 1, close))
      cursor = close + 1
    }
    while (cursor < sanitized.length && /\s/u.test(sanitized[cursor])) cursor += 1
    // Only the trailing-closure form can be re-spliced into a wrapper.
    if (sanitized[cursor] !== '{') continue
    const close = findClosingDelimiter(sanitized, cursor, '{', '}')
    if (close < 0) continue
    const body = original.slice(cursor + 1, close).trim()
    found.push({ name: label !== undefined && label !== '' ? label : `#Preview ${found.length + 1}`, body })
  }
  return found
}

/** Enumerate `struct X_Previews: PreviewProvider` declarations. */
function scanProviderPreviews(sanitized: string, module: string | undefined): { name: string; ref: string }[] {
  const found: { name: string; ref: string }[] = []
  const pattern = /struct\s+([A-Za-z_]\w*)\s*:\s*PreviewProvider\b/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sanitized)) !== null) {
    const structName = match[1]
    const qualifier = module === undefined ? '' : `${module}.`
    found.push({ name: structName, ref: `${qualifier}${structName}.previews` })
  }
  return found
}

const IGNORED_SCAN_DIRS = new Set(['.build', '.git', '.swiftpm', 'DerivedData', 'node_modules', 'xcuserdata'])

function walkSwiftFiles(root: string, depth = 0): string[] {
  const files: string[] = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth < 12 && !IGNORED_SCAN_DIRS.has(entry.name)) files.push(...walkSwiftFiles(path, depth + 1))
    } else if (entry.isFile() && entry.name.endsWith('.swift') && !entry.name.startsWith('.')) {
      files.push(path)
    }
  }
  return files
}

/** Best-effort module for a source file from the manifest target dirs. */
function resolveModuleForFile(manifest: PackageManifest, filePath: string): string | undefined {
  let best: { dir: string; name: string } | undefined
  for (const [name, dir] of manifest.targetDirs) {
    if (filePath.startsWith(`${dir}/`) && (best === undefined || dir.length > best.dir.length)) {
      best = { dir, name }
    }
  }
  return best?.name
}

/** Scan the package for #Preview and PreviewProvider declarations. */
function scanPackagePreviews(packagePath: string, manifest: PackageManifest): ScannedPreview[] {
  const previews: ScannedPreview[] = []
  for (const filePath of walkSwiftFiles(packagePath)) {
    let text: string
    try {
      text = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    const sanitized = stripStringsAndComments(text)
    const module = resolveModuleForFile(manifest, filePath)
    for (const macro of scanMacroPreviews(text, sanitized)) {
      previews.push({ kind: 'macro', name: macro.name, body: macro.body })
    }
    for (const provider of scanProviderPreviews(sanitized, module)) {
      previews.push({ kind: 'provider', name: provider.name, ref: provider.ref })
    }
  }
  return previews
}

function toPreviewEntries(previews: ScannedPreview[]): PreviewEntry[] {
  return previews.map((preview, index) => ({
    id: `p${index}`,
    name: preview.name,
    kind: preview.kind,
  }))
}

// ── Generated Swift sources ─────────────────────────────────────────────────

function generateDylibPackageSwift(packagePath: string, packageName: string, productNames: string[], platformVersion: number): string {
  const productDependencies = productNames
    .map(product => `.product(name: ${swiftStringLiteral(product)}, package: ${swiftStringLiteral(packageName)})`)
    .join(', ')
  return `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: ${swiftStringLiteral(DYLIB_TARGET_NAME)},
  platforms: [.iOS(.v${platformVersion})],
  products: [
    .library(name: ${swiftStringLiteral(DYLIB_TARGET_NAME)}, type: .dynamic, targets: ["PreviewEntry"])
  ],
  dependencies: [
    .package(path: ${swiftStringLiteral(packagePath)})
  ],
  targets: [
    .target(name: "PreviewEntry", dependencies: [${productDependencies}])
  ]
)
`
}

/**
 * The hot-swap entry file: a view registry with three @_cdecl entry points
 * the host resolves through dlsym. `#Preview` bodies are spliced into a
 * @ViewBuilder wrapper; PreviewProvider structs are referenced directly.
 */
function generateEntrySwift(previews: ScannedPreview[], imports: string[]): string {
  const lines: string[] = []
  lines.push('// Generated by the dsh-ios plugin — hot-swapped SwiftUI preview entry points.')
  lines.push('// Regenerated on every package edit; do not edit by hand.')
  lines.push('import SwiftUI')
  for (const module of imports) lines.push(`import ${module}`)
  lines.push('')
  lines.push('private final class ViewBox {')
  lines.push('  let view: AnyView')
  lines.push('  init(_ view: AnyView) { self.view = view }')
  lines.push('}')
  lines.push('')
  lines.push('@ViewBuilder')
  lines.push('private func dshBuild<Content: View>(@ViewBuilder _ content: () -> Content) -> Content {')
  lines.push('  content()')
  lines.push('}')
  lines.push('')
  const caseLines: string[] = []
  const nameLines: string[] = []
  let macroIndex = 0
  previews.forEach((preview, index) => {
    nameLines.push(`private let dshCName${index} = ${swiftStringLiteral(preview.name)}.utf8CString`)
    if (preview.kind === 'macro') {
      const structName = `DshPreview${macroIndex}`
      macroIndex += 1
      lines.push(`private struct ${structName}: View {`)
      lines.push('  var body: some View {')
      lines.push('    dshBuild {')
      for (const bodyLine of (preview.body ?? '').split('\n')) lines.push(`      ${bodyLine}`)
      lines.push('    }')
      lines.push('  }')
      lines.push('}')
      caseLines.push(`  case ${index}: return AnyView(${structName}())`)
    } else {
      caseLines.push(`  case ${index}: return AnyView(${preview.ref ?? 'EmptyView()'})`)
    }
  })
  lines.push('')
  lines.push('private func dshItem(_ index: Int) -> AnyView {')
  lines.push('  switch index {')
  lines.push(...caseLines)
  lines.push('  default: return AnyView(EmptyView())')
  lines.push('  }')
  lines.push('}')
  if (nameLines.length > 0) {
    lines.push('')
    lines.push(...nameLines)
  }
  lines.push('')
  lines.push('@_cdecl("dsh_preview_count")')
  lines.push('public func dshPreviewCount() -> Int {')
  lines.push(`  return ${previews.length}`)
  lines.push('}')
  lines.push('')
  lines.push('@_cdecl("dsh_preview_name")')
  lines.push('public func dshPreviewName(_ index: Int) -> UnsafePointer<CChar>? {')
  lines.push('  switch index {')
  for (let index = 0; index < previews.length; index += 1) {
    lines.push(`  case ${index}: return dshCName${index}.withUnsafeBufferPointer { $0.baseAddress }`)
  }
  lines.push('  default: return nil')
  lines.push('  }')
  lines.push('}')
  lines.push('')
  lines.push('@_cdecl("dsh_preview_make_view")')
  lines.push('public func dshPreviewMakeView(_ index: Int) -> UnsafeMutableRawPointer {')
  lines.push('  Unmanaged.passRetained(ViewBox(dshItem(index))).toOpaque()')
  lines.push('}')
  return `${lines.join('\n')}\n`
}

function generateHostPackageSwift(platformVersion: number): string {
  return `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: ${swiftStringLiteral(HOST_TARGET_NAME)},
  platforms: [.iOS(.v${platformVersion})],
  targets: [.executableTarget(name: ${swiftStringLiteral(HOST_TARGET_NAME)})]
)
`
}

function generateInfoPlist(platformVersion: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>DSH Preview Host</string>
	<key>CFBundleExecutable</key>
	<string>${HOST_TARGET_NAME}</string>
	<key>CFBundleIdentifier</key>
	<string>${PREVIEW_HOST_BUNDLE_ID}</string>
	<key>CFBundleName</key>
	<string>DSH Preview Host</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>MinimumOSVersion</key>
	<string>${platformVersion}.0</string>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key>
		<false/>
	</dict>
	<key>UIDeviceFamily</key>
	<array>
		<integer>1</integer>
		<integer>2</integer>
	</array>
</dict>
</plist>
`
}

// ── Build/toolchain helpers ─────────────────────────────────────────────────

/** Run `xcrun swift build` for the simulator, keeping the output tail. */
function runSwiftBuild(
  packageDir: string,
  triple: string,
  sdk: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ exitCode: number | null; lines: string[] }> {
  return new Promise(resolveBuild => {
    const child: SwiftBuildChild = spawn('xcrun', ['swift', 'build', '--sdk', sdk, '--triple', triple, '--disable-index-store'], {
      cwd: packageDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const lines: string[] = []
    const collect = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        lines.push(line.trimEnd())
        if (lines.length > SWIFT_OUTPUT_RING_LINES) lines.shift()
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let timer: NodeJS.Timeout | undefined
    const finish = (exitCode: number | null): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolveBuild({ exitCode, lines })
    }
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', () => finish(-1))
    child.once('close', code => finish(code))
  })
}

/** Resolve the build products dir for a package (`swift build --show-bin-path`). */
async function swiftBinPath(packageDir: string, triple: string, sdk: string, signal: AbortSignal): Promise<string> {
  const stdout = await new Promise<string>((resolvePath, rejectPath) => {
    execFile('xcrun', ['swift', 'build', '--sdk', sdk, '--triple', triple, '--disable-index-store', '--show-bin-path'], {
      cwd: packageDir,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      signal,
    }, (error, out, stderr) => {
      if (error !== null) {
        rejectPath(new Error(`swift build --show-bin-path failed${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
        return
      }
      resolvePath(out)
    })
  })
  const path = stdout.trim()
  if (path === '') throw new Error('swift build --show-bin-path returned no path')
  return path
}

/** Ad-hoc code-sign a bundle or dylib for the simulator. */
async function codesignAdHoc(path: string, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveSign, rejectSign) => {
    execFile('codesign', ['--force', '--sign', '-', path], { timeout: 120_000, signal }, (error, _out, stderr) => {
      if (error !== null) {
        rejectSign(new Error(`codesign failed for ${path}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
        return
      }
      resolveSign()
    })
  })
}

/** Reduce swift build output to the actionable tail (progress lines dropped). */
function filterSwiftBuildErrors(lines: string[]): string[] {
  const kept = lines
    .filter(line => line !== '')
    .filter(line => !/^\[\d+\/\d+\] /u.test(line))
    .filter(line => !/^(Build complete!|Planning build|Building for debugging\.\.\.|Fetching |Updating |Resolving |Computing version)/u.test(line))
  return kept.slice(-ERROR_TAIL_LINES)
}

// ── File watching ───────────────────────────────────────────────────────────

/**
 * Watch the package tree for source edits. macOS Node supports recursive
 * `fs.watch`; on platforms where it fails, fall back to per-directory
 * watchers (one level of nesting at a time — the smoke asserts watchers are
 * fully released on stop either way).
 */
function watchPackageTree(root: string, onChange: () => void): PackageWatcher {
  const watchers: FSWatcher[] = []
  let closed = false
  try {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (closed) return
      const name = typeof filename === 'string' ? filename : ''
      // Recursive watch reports RELATIVE paths ('.build/debug/foo.o'), so the
      // ignore check must look at the top-level segment — comparing the whole
      // string only matched the directory entry itself, and every artifact a
      // user-run `swift build` wrote inside .build triggered a rebuild.
      const top = name.split(sep)[0] ?? ''
      if (top !== '' && IGNORED_SCAN_DIRS.has(top)) return
      onChange()
    })
    watchers.push(watcher)
  } catch {
    const attachDirectories = (dir: string): void => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || IGNORED_SCAN_DIRS.has(entry.name)) continue
        const child = join(dir, entry.name)
        watchers.push(watch(child, () => {
          if (!closed) onChange()
        }))
        attachDirectories(child)
      }
    }
    attachDirectories(root)
  }
  return {
    close() {
      closed = true
      for (const watcher of watchers) watcher.close()
    },
  }
}

// ── Device resolution ───────────────────────────────────────────────────────

async function resolvePreviewDevice(host: SimHostController, reference?: string): Promise<{ device: SimulatorDevice; bootedByUs: boolean }> {
  if (reference !== undefined && reference.trim() !== '') {
    return { device: await getDevice(reference), bootedByUs: false }
  }
  const status = host.status()
  if (status.running && status.device !== undefined) {
    try {
      return { device: await getDevice(status.device), bootedByUs: false }
    } catch {
      // Stream device vanished from simctl; fall through to booted devices.
    }
  }
  const booted = await bootedDevices()
  if (booted.length > 0) {
    const iphones = booted.filter(device => device.name.toLowerCase().startsWith('iphone'))
    const pool = iphones.length > 0 ? iphones : booted
    return { device: pool.sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))[0], bootedByUs: false }
  }
  const devices = await listDevices()
  if (devices.length === 0) {
    throw new Error('No simulator devices are installed — install an iOS Simulator runtime in Xcode, then retry')
  }
  const iphones = devices.filter(device => device.name.toLowerCase().startsWith('iphone'))
  const pool = iphones.length > 0 ? iphones : devices
  const picked = pool.sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))[0]
  await bootDevice(picked.udid)
  return { device: { ...picked, state: 'Booted' }, bootedByUs: true }
}

// ── The controller ──────────────────────────────────────────────────────────

/**
 * Owns the single active preview session: generated host app + generated
 * preview dylib + the debounced rebuild/watcher loop + host confirmation
 * polling. One session at a time — a second `start()` fails 409-style.
 */
export class PreviewHostController {
  readonly #host: SimHostController
  readonly #cacheDir: string
  readonly #logger?: (line: string) => void
  #session: PreviewSession | undefined

  constructor(options: PreviewHostOptions) {
    this.#host = options.host
    this.#cacheDir = options.cacheDir
    this.#logger = options.logger
  }

  #log(line: string): void {
    this.#logger?.(line)
  }

  /** Start the preview session (generates + builds + installs + launches). */
  async start(options: PreviewStartOptions): Promise<PreviewStartResult> {
    assertDarwin()
    if (this.#session !== undefined) {
      throw new Error(
        `ios_sim_preview: a preview session is already running for ${this.#session.packagePath} — `
        + 'only one preview session at a time; stop it first (action:"stop") or inspect it (action:"status")',
      )
    }
    const hostStatus = this.#host.status()
    if (!hostStatus.available) {
      throw new Error(`${SIMULATOR_UNAVAILABLE} — the serve-sim simulator stream is unavailable on this host (${hostStatus.serveSimSource})`)
    }
    const signal = options.signal ?? new AbortController().signal
    const packagePath = resolve(options.packagePath)
    if (!existsSync(packagePath) || !statSync(packagePath).isDirectory() || !existsSync(join(packagePath, 'Package.swift'))) {
      throw new Error(`ios_sim_preview: packagePath must be an absolute path to a Swift package directory containing Package.swift: ${packagePath}`)
    }
    const manifest = readPackageManifest(packagePath)
    if (manifest.libraryTargets.length === 0) {
      throw new Error(`ios_sim_preview: ${packagePath} has no library targets — the preview dylib needs at least one .target to import`)
    }
    const filter = options.previewFilter !== undefined && options.previewFilter.trim() !== '' ? options.previewFilter.trim() : undefined
    const scanned = scanPackagePreviews(packagePath, manifest)
    const matching = filter === undefined
      ? scanned
      : scanned.filter(preview => preview.name.toLowerCase().includes(filter.toLowerCase()))
    if (matching.length === 0) {
      if (filter !== undefined) {
        const names = scanned.map(preview => preview.name)
        throw new Error(
          `ios_sim_preview: previewFilter ${JSON.stringify(filter)} matched none of the ${scanned.length} previews found`
          + ` in ${packagePath}${names.length === 0 ? '' : ` — found: ${names.join(', ')}`}`,
        )
      }
      throw new Error(
        `ios_sim_preview: no SwiftUI previews found in ${packagePath} — scanned Sources/**/*.swift for `
        + '#Preview { … } and struct X_Previews: PreviewProvider declarations (types used by a preview must be internal or public)',
      )
    }
    const previews = toPreviewEntries(matching)

    // Resolve the device and make sure it is booted and streamed.
    const { device, bootedByUs } = await resolvePreviewDevice(this.#host, options.udid)
    await bootDevice(device.udid)
    const streamWasRunning = this.#host.status().running && this.#host.status().device === device.udid
    await this.#host.ensureRunning({ udid: device.udid })

    const platformVersion = Math.max(DEFAULT_IOS_PLATFORM_VERSION, manifest.iosVersion ?? DEFAULT_IOS_PLATFORM_VERSION)
    const triple = simulatorTriple(platformVersion)
    const sdk = await new Promise<string>((resolveSdk, rejectSdk) => {
      execFile('xcrun', ['--show-sdk-path', '--sdk', 'iphonesimulator'], { timeout: 30_000, signal }, (error, out) => {
        if (error !== null) rejectSdk(new Error(`xcrun --show-sdk-path --sdk iphonesimulator failed: ${errorMessage(error)}`))
        else resolveSdk(out.trim())
      })
    })
    const sessionCacheDir = join(this.#cacheDir, 'preview-hot', projectSlug(packagePath))
    const dropDir = join(sessionCacheDir, 'drop')
    const dylibPackageDir = join(sessionCacheDir, 'dylib-package')

    const session: PreviewSession = {
      packagePath,
      packageName: manifest.name,
      device: { ...device, state: 'Booted' },
      pid: '',
      ...(filter === undefined ? {} : { filter }),
      dropDir,
      dylibPackageDir,
      triple,
      sdk,
      platformVersion,
      generation: 0,
      loadedGeneration: 0,
      previews,
      watcher: { close() {} },
      rebuildRunning: false,
      rebuildQueued: false,
      reloads: 0,
      startedAt: Date.now(),
      streamStartedByUs: !streamWasRunning,
      bootedByUs,
      disposed: false,
    }
    this.#session = session
    try {
      this.#log(`dsh-ios preview: generating host app for ${packagePath} (device ${device.udid})`)
      const appPath = await this.#generateHostApp(sessionCacheDir, platformVersion, triple, sdk, signal)
      await installApp(device.udid, appPath, signal)
      const launchOutput = await launchApp(device.udid, PREVIEW_HOST_BUNDLE_ID, signal)
      const pidMatch = /:\s*(\d+)\s*$/u.exec(launchOutput.trim())
      session.pid = pidMatch === null ? '' : pidMatch[1]
      const container = await getAppContainer(device.udid, PREVIEW_HOST_BUNDLE_ID, signal)
      session.dropDir = join(container, 'Documents', DROP_DIR_NAME)
      this.#log(`dsh-ios preview: host launched on ${device.name} (pid ${session.pid}); building the first preview dylib`)

      await this.#prepareDylibPackage(session, manifest, matching)
      const build = await runSwiftBuild(session.dylibPackageDir, session.triple, session.sdk, signal, SWIFT_BUILD_TIMEOUT_MS)
      if (build.exitCode !== 0) {
        throw new Error(
          `swift build failed (exit ${String(build.exitCode)}) for ${packagePath}:\n${filterSwiftBuildErrors(build.lines).join('\n')}`,
        )
      }
      const buildMs = Date.now() - session.startedAt
      await this.#pushGeneration(session, matching, signal)
      const confirmed = await this.#waitForHostGeneration(session, 1, HOST_CONFIRM_TIMEOUT_MS)
      if (!confirmed) {
        const live = this.#readHostResult(session)
        const hostError = typeof live.error === 'string' && live.error !== '' ? ` — host reports: ${live.error}` : ''
        throw new Error(
          `ios_sim_preview: the host app did not confirm the first preview within ${HOST_CONFIRM_TIMEOUT_MS / 1000}s${hostError}`
          + ` — the session will not keep watching; stop it and retry`,
        )
      }
      session.loadedGeneration = 1
      session.watcher = watchPackageTree(packagePath, () => this.#scheduleRebuild(session))
      this.#log(`dsh-ios preview: session live — ${previews.length} preview(s), generation 1 (initial build ${buildMs} ms)`)
      return {
        running: true,
        device: { udid: device.udid, name: device.name, runtime: device.runtime, state: 'Booted' },
        host: { bundleId: PREVIEW_HOST_BUNDLE_ID, ...(session.pid === '' ? {} : { pid: session.pid }) },
        package: { path: packagePath, name: manifest.name },
        mode: 'dylib-hot-swap',
        watching: true,
        previews,
        generation: 1,
      }
    } catch (error) {
      session.disposed = true
      session.watcher.close()
      await this.#teardown(session).catch(() => {})
      this.#session = undefined
      throw error
    }
  }

  /** Live snapshot; reads the host's result.json so callers see fresh state. */
  status(): PreviewHostStatus {
    const session = this.#session
    if (session === undefined) return { running: false, mode: 'dylib-hot-swap' }
    const live = this.#readHostResult(session)
    if (typeof live.generation === 'number' && live.generation > session.loadedGeneration) {
      session.loadedGeneration = live.generation
    }
    const hostError = typeof live.error === 'string' && live.error !== '' ? `host: ${live.error}` : undefined
    const runtimeError = session.lastRuntimeError ?? hostError
    return {
      running: true,
      mode: 'dylib-hot-swap',
      device: { udid: session.device.udid, name: session.device.name, runtime: session.device.runtime, state: 'Booted' },
      host: { bundleId: PREVIEW_HOST_BUNDLE_ID, ...(session.pid === '' ? {} : { pid: session.pid }) },
      package: { path: session.packagePath, name: session.packageName },
      watching: true,
      generation: session.generation,
      loadedGeneration: session.loadedGeneration,
      previews: session.previews,
      reloads: session.reloads,
      ...(session.lastReload === undefined ? {} : { lastReload: session.lastReload }),
      ...(session.lastBuildError === undefined ? {} : { lastBuildError: session.lastBuildError }),
      ...(runtimeError === undefined ? {} : { lastRuntimeError: runtimeError }),
      startedAt: session.startedAt,
    }
  }

  /** Kill the watcher, terminate/uninstall the host, release stream/boot. */
  async stop(signal?: AbortSignal): Promise<PreviewStopResult> {
    assertDarwin()
    const session = this.#session
    if (session === undefined) return { state: 'stopped', running: false }
    session.disposed = true
    if (session.debounceTimer !== undefined) clearTimeout(session.debounceTimer)
    session.watcher.close()
    await this.#teardown(session, signal)
    const result: PreviewStopResult = {
      state: 'stopped',
      running: false,
      device: { udid: session.device.udid, name: session.device.name, runtime: session.device.runtime, state: session.bootedByUs ? 'Shutdown' : session.device.state },
      host: { bundleId: PREVIEW_HOST_BUNDLE_ID, terminated: true },
    }
    this.#session = undefined
    this.#log(`dsh-ios preview: session stopped (${session.packagePath}, ${session.reloads} reloads)`)
    return result
  }

  /** Plugin disposal: stop the session so unload cleans up fully. */
  async dispose(): Promise<void> {
    await this.stop().catch(() => {})
  }

  /** Terminate the host app, uninstall it, release the stream and any boot we did. */
  async #teardown(session: PreviewSession, signal?: AbortSignal): Promise<void> {
    try {
      await terminateApp(session.device.udid, PREVIEW_HOST_BUNDLE_ID, signal)
    } catch {
      // Already terminated (or never launched) — uninstall still cleans up.
    }
    try {
      await uninstallApp(session.device.udid, PREVIEW_HOST_BUNDLE_ID, signal)
    } catch {
      // Already uninstalled.
    }
    if (session.streamStartedByUs) {
      await this.#host.stop().catch(() => {})
    }
    if (session.bootedByUs) {
      await shutdownDevice(session.device.udid).catch(() => {})
    }
  }

  /** Generate + build + sign the disposable host app in the plugin cache. */
  async #generateHostApp(
    sessionCacheDir: string,
    platformVersion: number,
    triple: string,
    sdk: string,
    signal: AbortSignal,
  ): Promise<string> {
    const packageDir = join(sessionCacheDir, 'host-package')
    rmSync(packageDir, { recursive: true, force: true })
    const sourcesDir = join(packageDir, 'Sources', HOST_TARGET_NAME)
    mkdirSync(sourcesDir, { recursive: true })
    const assetsDir = resolvePreviewHostAssetsDir()
    for (const name of ['PreviewHostApp.swift', 'PreviewSession.swift', 'PreviewRootView.swift']) {
      copyFileSync(join(assetsDir, name), join(sourcesDir, name))
    }
    writeFileSync(join(packageDir, 'Package.swift'), generateHostPackageSwift(platformVersion))
    const build = await runSwiftBuild(packageDir, triple, sdk, signal, SWIFT_BUILD_TIMEOUT_MS)
    if (build.exitCode !== 0) {
      throw new Error(`swift build failed (exit ${String(build.exitCode)}) for the generated preview host:\n${filterSwiftBuildErrors(build.lines).join('\n')}`)
    }
    const binPath = await swiftBinPath(packageDir, triple, sdk, signal)
    const executable = join(binPath, HOST_TARGET_NAME)
    if (!existsSync(executable)) throw new Error(`generated preview host executable not found at ${executable}`)
    const appDir = join(sessionCacheDir, `${HOST_TARGET_NAME}.app`)
    rmSync(appDir, { recursive: true, force: true })
    mkdirSync(appDir, { recursive: true })
    copyFileSync(executable, join(appDir, HOST_TARGET_NAME))
    writeFileSync(join(appDir, 'Info.plist'), generateInfoPlist(platformVersion))
    await codesignAdHoc(appDir, signal)
    return appDir
  }

  /** (Re)write the generated dylib package: manifest + hot-swap entry file. */
  async #prepareDylibPackage(session: PreviewSession, manifest: PackageManifest, scanned: ScannedPreview[]): Promise<void> {
    rmSync(session.dylibPackageDir, { recursive: true, force: true })
    const entryDir = join(session.dylibPackageDir, 'Sources', 'PreviewEntry')
    mkdirSync(entryDir, { recursive: true })
    writeFileSync(
      join(session.dylibPackageDir, 'Package.swift'),
      generateDylibPackageSwift(session.packagePath, manifest.name, manifest.productNames, session.platformVersion),
    )
    writeFileSync(join(entryDir, 'Entry.swift'), generateEntrySwift(scanned, manifest.libraryTargets))
  }

  /** Copy the freshly built dylib into the host drop dir and bump the manifest. */
  async #pushGeneration(session: PreviewSession, scanned: ScannedPreview[], signal: AbortSignal): Promise<void> {
    session.generation += 1
    const binPath = await swiftBinPath(session.dylibPackageDir, session.triple, session.sdk, signal)
    const dylib = join(binPath, DYLIB_LIBRARY_NAME)
    if (!existsSync(dylib)) throw new Error(`built preview dylib not found at ${dylib}`)
    mkdirSync(session.dropDir, { recursive: true })
    const target = join(session.dropDir, `preview_${session.generation}.dylib`)
    copyFileSync(dylib, target)
    await codesignAdHoc(target, signal)
    writeJsonAtomic(join(session.dropDir, 'manifest.json'), {
      generation: session.generation,
      dylib: `preview_${session.generation}.dylib`,
      previews: scanned.map(preview => preview.name),
    })
    for (const entry of readdirSync(session.dropDir)) {
      if (!/^preview_(\d+)\.dylib$/u.test(entry)) continue
      const generation = Number(/^preview_(\d+)\.dylib$/u.exec(entry)![1])
      if (generation <= session.generation - KEPT_DYLIB_GENERATIONS) {
        try {
          rmSync(join(session.dropDir, entry))
        } catch {
          // The host may still have the file mapped; stale drops are harmless.
        }
      }
    }
  }

  /** Poll result.json until the host confirms `generation` (or the timeout). */
  async #waitForHostGeneration(session: PreviewSession, generation: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const live = this.#readHostResult(session)
      if (typeof live.generation === 'number' && live.generation >= generation) return true
      if (Date.now() >= deadline) return false
      await sleep(HOST_POLL_INTERVAL_MS)
    }
  }

  #readHostResult(session: PreviewSession): Record<string, unknown> {
    return readJsonFile(join(session.dropDir, 'result.json')) ?? {}
  }

  /** Debounced watcher entry point; coalesces rebuilds while one is running. */
  #scheduleRebuild(session: PreviewSession): void {
    if (session.disposed) return
    if (session.rebuildRunning) {
      session.rebuildQueued = true
      return
    }
    if (session.debounceTimer !== undefined) clearTimeout(session.debounceTimer)
    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = undefined
      void this.#runRebuild(session).catch(error => {
        session.lastRuntimeError = errorMessage(error)
        this.#log(`dsh-ios preview: rebuild crashed: ${errorMessage(error)}`)
      })
    }, REBUILD_DEBOUNCE_MS)
  }

  /**
   * One rebuild cycle: re-scan previews, regenerate the entry file, run the
   * incremental swift build, push the new dylib and wait for host
   * confirmation. Build failures keep the last good preview and are exposed
   * through status() — the loop never dies.
   */
  async #runRebuild(session: PreviewSession): Promise<void> {
    if (session.disposed) return
    session.rebuildRunning = true
    const startedAt = Date.now()
    try {
      if (!existsSync(join(session.packagePath, 'Package.swift'))) {
        session.lastRuntimeError = `Package.swift vanished from ${session.packagePath}; keeping the last good preview and watching`
        this.#log(`dsh-ios preview: ${session.lastRuntimeError}`)
        return
      }
      const manifest = readPackageManifest(session.packagePath)
      const scanned = scanPackagePreviews(session.packagePath, manifest)
      const matching = session.filter === undefined
        ? scanned
        : scanned.filter(preview => preview.name.toLowerCase().includes(session.filter!.toLowerCase()))
      // An empty scan still builds: when the edit broke the file (e.g. an
      // unterminated string swallowed the declarations) the compiler error
      // must reach status(), and when the user genuinely removed every
      // preview the host simply shows its "no previews" state.
      session.previews = toPreviewEntries(matching)
      // The generated package dir persists between rebuilds so SwiftPM's
      // incremental build only recompiles the touched sources + the entry.
      const entryPath = join(session.dylibPackageDir, 'Sources', 'PreviewEntry', 'Entry.swift')
      const entryText = generateEntrySwift(matching, manifest.libraryTargets)
      if (!existsSync(entryPath) || readFileSync(entryPath, 'utf8') !== entryText) {
        mkdirSync(dirname(entryPath), { recursive: true })
        writeFileSync(entryPath, entryText)
      }
      const buildStart = Date.now()
      const build = await runSwiftBuild(session.dylibPackageDir, session.triple, session.sdk, new AbortController().signal, SWIFT_BUILD_TIMEOUT_MS)
      const buildMs = Date.now() - buildStart
      if (build.exitCode !== 0) {
        session.lastBuildError = [
          `swift build failed (exit ${String(build.exitCode)})`,
          ...filterSwiftBuildErrors(build.lines),
        ]
        session.lastRuntimeError = undefined
        this.#log(`dsh-ios preview: rebuild failed (generation ${session.generation} untouched) — compiler errors recorded; keeping the last good preview`)
        return
      }
      if (session.disposed) return
      session.lastBuildError = undefined
      await this.#pushGeneration(session, matching, new AbortController().signal)
      const confirmed = await this.#waitForHostGeneration(session, session.generation, RELOAD_CONFIRM_TIMEOUT_MS)
      const totalMs = Date.now() - startedAt
      if (confirmed) {
        session.loadedGeneration = session.generation
        session.reloads += 1
        session.lastReload = { generation: session.generation, buildMs, totalMs }
        session.lastRuntimeError = undefined
        this.#log(`dsh-ios preview: hot reloaded package preview generation ${session.generation} in pid ${session.pid} (build ${buildMs} ms, total ${totalMs} ms)`)
      } else {
        session.lastRuntimeError = `host did not confirm generation ${session.generation} within ${RELOAD_CONFIRM_TIMEOUT_MS / 1000}s — keeping the last good preview; watching continues`
        this.#log(`dsh-ios preview: ${session.lastRuntimeError}`)
      }
    } catch (error) {
      session.lastRuntimeError = errorMessage(error)
      this.#log(`dsh-ios preview: rebuild error: ${session.lastRuntimeError} — watching continues`)
    } finally {
      session.rebuildRunning = false
      if (session.rebuildQueued && !session.disposed) {
        session.rebuildQueued = false
        void this.#runRebuild(session).catch(() => {})
      }
    }
  }
}
