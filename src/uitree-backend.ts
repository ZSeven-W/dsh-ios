/**
 * AXe helper resolution and execution for UI-tree semantic interaction.
 *
 * `ios_sim_ui_tree` / `ios_sim_tap_element` are built on the open-source
 * `AXe` CLI (github.com/cameroncooke/AXe, MIT license) — the same
 * accessibility-driven simulator automation XcodeBuildMCP's ui-automation
 * tools use: `describe-ui` dumps the accessibility element tree as JSON,
 * `tap`/`type`/`swipe` drive the simulator through Apple HID.
 *
 * The helper is never a system-wide install. Resolution order:
 *   1. `DSHPLUGIN_IOS_AXE_BIN` (explicit override, e.g. CI);
 *   2. an `axe` on PATH or in a Homebrew prefix (brew install
 *      cameroncooke/axe/axe lands in /opt/homebrew/bin or /usr/local/bin);
 *   3. the plugin-owned cache `~/Library/Caches/dsh-ios/bin/axe/<version>/`,
 *      populated on demand from the pinned GitHub release archive.
 * When nothing resolves and the host is macOS, `ensureAxeBinary()` downloads
 * the pinned release tarball into the cache: the SHA-256 of the archive is
 * pinned in source and verified while streaming (there is no official
 * checksum file in the AXe releases — the pinned digest below was computed
 * from the downloaded artifact and is re-verified on every use), and the
 * extracted binary's digest is recorded next to it and re-checked on every
 * later resolution so on-disk corruption or tampering is detected.
 *
 * Degradation mirrors serve-sim: resolution-only when the helper is absent
 * and not downloadable (non-macOS host, offline, `DSHPLUGIN_IOS_AXE_OFFLINE=1`),
 * with a clear install hint in the thrown tool error.
 * @module @zseven-w/dsh-ios/uitree-backend
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginEnv } from './plugin-env.js'
import type { HingeDevice } from './hinge.js'
import { readDuoDisplay, sameDuoDisplay, type DuoDisplay } from './duo-display.js'
import { readWithAxeSession } from './ax-reader.js'
import { withSimDeviceRead } from './sim-device-operations.js'

/** AXe release this plugin pins (supports Xcode 26 and 27). */
export const AXE_VERSION = '1.8.0'

/** Pinned release archive URL (universal binary: arm64 + x86_64). */
export const AXE_RELEASE_URL = 'https://github.com/cameroncooke/AXe/releases/download/v1.8.0/AXe-macOS-v1.8.0-universal.tar.gz'

/**
 * SHA-256 of the pinned archive, verified while the download streams.
 * Computed from the v1.8.0 artifact (8 432 118 bytes) on 2026-08-16; AXe
 * publishes no official checksums, so this digest is the trust anchor and
 * is pinned in source. AXe is MIT-licensed (cameroncooke/AXe LICENSE), so
 * downloading and redistributing the release binary is permitted.
 */
export const AXE_RELEASE_SHA256 = '7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834'

/** Install hint appended to every helper-unavailable tool error. */
export const AXE_INSTALL_HINT = 'install the AXe accessibility CLI with "brew install cameroncooke/axe/axe", or let the plugin '
  + 'download the pinned release into ~/Library/Caches/dsh-ios/bin (needs network access to github.com); '
  + 'set DSHPLUGIN_IOS_AXE_BIN to an existing axe executable to override resolution'

const AXE_CACHE_BASE = join(homedir(), 'Library', 'Caches', 'dsh-ios', 'bin')
const AXE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000
const AXE_EXEC_TIMEOUT_MS = 60_000
const AXE_MAX_BUFFER_BYTES = 32 * 1024 * 1024
/** Well-known Homebrew install locations, probed even with a trimmed PATH. */
const BREW_BIN_CANDIDATES = ['/opt/homebrew/bin/axe', '/usr/local/bin/axe']

/** Where the resolved axe executable came from. */
export type AxeBinarySource = 'path' | 'cache' | 'unavailable'

/** One resolved AXe helper binary. */
export interface AxeBinary {
  available: boolean
  source: AxeBinarySource
  /** Absolute path of the executable (when available). */
  command?: string
  /** Why resolution failed (when unavailable). */
  reason?: string
  /** One-line install hint for the model (always set when unavailable). */
  installHint: string
}

/** One raw node of the `axe describe-ui` JSON payload. */
export interface RawAxeNode {
  type?: unknown
  AXLabel?: unknown
  AXUniqueId?: unknown
  AXValue?: unknown
  /** Raw AXe role/subrole, retained for secure-field classification. */
  subrole?: unknown
  /** Raw AXe role, retained for secure-field classification. */
  role?: unknown
  /** Raw AXe pid, retained for foreground app identity. */
  pid?: unknown
  /** Raw AXe focus state, when the backend reports one. */
  focused?: unknown
  frame?: unknown
  children?: unknown
  /**
   * Interactivity flags. `axe describe-ui` emits `enabled` as a JSON
   * boolean (absent/null when the app reports none); it exposes NO
   * visibility flag. The WDA normalizer passes its `enabled`/`visible`
   * attributes through the same fields, so both backends produce the same
   * node shape.
   */
  enabled?: unknown
  visible?: unknown
  /**
   * Selection state. WDA's /source XML exposes `selected="true"|"false"` on
   * picker/table rows; AXe's simulator tree has an equivalent trait. Absent
   * stays undefined — never invented, so an absent field keeps meaning
   * "unknown" and the tree stays small (WP60).
   */
  selected?: unknown
  /** Positive secure classification from a raw/sanitized backend. */
  secure?: unknown
  // Sanitized-shape aliases: makes re-sanitization of an already-sanitized
  // node idempotent (synthetic trees and cached payloads).
  label?: unknown
  identifier?: unknown
  value?: unknown
  w?: unknown
  h?: unknown
}

/** One sanitized accessibility element (points coordinates). */
export interface AxeElement {
  type: string
  label?: string
  identifier?: string
  value?: string
  /**
   * Interactivity flags, when the backend reports them (WDA carries both
   * per element; AXe only `enabled`). Absent stays `undefined` — never
   * invented.
   */
  enabled?: boolean
  visible?: boolean
  /**
   * Selection state, when the backend reports it (WDA's `selected`
   * attribute, AXe's equivalent trait). Absent stays `undefined` — never
   * invented, so an absent field means "unknown" and the tree stays small.
   */
  selected?: boolean
  /**
   * Secure-text classification when the backend makes it known (AXe
   * AXSecureTextField subrole; WDA XCUIElementTypeSecureTextField). Absent
   * stays undefined: a missing role/subrole/type must never be reported as
   * safe by omission.
   */
  secure?: boolean
  /**
   * Focus state when the backend reports it. Absent stays undefined —
   * never guessed from AXValue/label.
   */
  focused?: boolean
  /** Backend process id when present (AXe application roots). */
  pid?: number
  frame: { x: number; y: number; w: number; h: number }
  children: AxeElement[]
}

function isExecutableFile(path: string): boolean {
  try {
    const info = statSync(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, command)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

function sha256File(path: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

/** Plugin cache base dir; `DSH_IOS_AXE_DIR` overrides it (tests/CI). */
export function axeCacheBase(): string {
  const override = process.env.DSH_IOS_AXE_DIR
  return override !== undefined && override.trim() !== '' ? override.trim() : AXE_CACHE_BASE
}

function axeCacheInstallDir(): string {
  return join(axeCacheBase(), 'axe', AXE_VERSION)
}

function axeCacheBinary(): string {
  return join(axeCacheInstallDir(), 'axe')
}

function axeCacheDigestFile(): string {
  return join(axeCacheInstallDir(), '.dsh-ios-axe.sha256')
}

/** Validate a cached install: executable binary + recorded digest matches. */
function validCachedBinary(): string | undefined {
  const binary = axeCacheBinary()
  if (!isExecutableFile(binary)) return undefined
  const recorded = axeCacheDigestFile()
  try {
    const expected = readFileSync(recorded, 'utf8').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(expected)) return undefined
    return sha256File(binary) === expected ? binary : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the axe helper synchronously: env override → PATH → brew prefixes
 * → plugin cache. Never performs network access; `ensureAxeBinary()` adds
 * the pinned-release download step.
 */
export function resolveAxeBinary(): AxeBinary {
  if (process.platform !== 'darwin') {
    return {
      available: false,
      source: 'unavailable',
      reason: 'AXe only runs on macOS with Xcode',
      installHint: AXE_INSTALL_HINT,
    }
  }
  const explicit = pluginEnv('IOS_AXE_BIN')
  if (explicit !== undefined && explicit.trim() !== '') {
    if (isExecutableFile(explicit.trim())) {
      return { available: true, source: 'path', command: explicit.trim(), installHint: AXE_INSTALL_HINT }
    }
    return {
      available: false,
      source: 'unavailable',
      reason: `DSHPLUGIN_IOS_AXE_BIN points at a missing or non-executable file: ${explicit.trim()}`,
      installHint: AXE_INSTALL_HINT,
    }
  }
  const onPath = findOnPath('axe')
  if (onPath !== undefined) return { available: true, source: 'path', command: onPath, installHint: AXE_INSTALL_HINT }
  const inBrew = BREW_BIN_CANDIDATES.find(isExecutableFile)
  if (inBrew !== undefined) return { available: true, source: 'path', command: inBrew, installHint: AXE_INSTALL_HINT }
  const cached = validCachedBinary()
  if (cached !== undefined) return { available: true, source: 'cache', command: cached, installHint: AXE_INSTALL_HINT }
  if (existsSync(axeCacheInstallDir())) {
    // Present but corrupt (missing/corrupted binary or digest) — report it
    // and let ensure() re-download a clean copy.
    return {
      available: false,
      source: 'unavailable',
      reason: `the cached axe install under ${axeCacheInstallDir()} failed integrity verification`,
      installHint: AXE_INSTALL_HINT,
    }
  }
  return {
    available: false,
    source: 'unavailable',
    reason: 'no axe binary found on PATH, in Homebrew, or in the plugin cache',
    installHint: AXE_INSTALL_HINT,
  }
}

/**
 * Fetch the pinned release tarball into the plugin cache, verifying the
 * pinned SHA-256 after the transfer, then extract (system `tar`) and
 * record the extracted binary's digest for future integrity checks.
 * The transfer goes through the system `curl` so standard proxy
 * environment variables (https_proxy/…) apply — Node's fetch ignores them,
 * which breaks downloads on proxied developer machines.
 */
async function downloadAxeRelease(): Promise<string> {
  const installDir = axeCacheInstallDir()
  const base = axeCacheBase()
  mkdirSync(base, { recursive: true })
  const tmpArchive = join(base, `.axe-${AXE_VERSION}-${process.pid}-${Date.now()}.tar.gz.tmp`)
  try {
    const bundled = fileURLToPath(new URL('../assets/axe/AXe-macOS-v1.8.0-universal.tar.gz', import.meta.url))
    if (existsSync(bundled)) copyFileSync(bundled, tmpArchive)
    else await new Promise<void>((resolveDownload, rejectDownload) => {
      execFile('curl', [
        '-fsSL',
        '--retry', '3',
        '--retry-delay', '1',
        '--connect-timeout', '30',
        '--max-time', '240',
        '-o', tmpArchive,
        AXE_RELEASE_URL,
      ], { timeout: AXE_DOWNLOAD_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, error => {
        if (error !== null) {
          rejectDownload(new Error(`curl download failed (${error.message.includes('ETIMEDOUT') ? 'timeout' : 'HTTP or network error'})`))
        } else {
          resolveDownload()
        }
      })
    })
    const digest = sha256File(tmpArchive)
    if (digest !== AXE_RELEASE_SHA256) {
      throw new Error(
        `download integrity check failed: expected sha256 ${AXE_RELEASE_SHA256} but got ${digest}`,
      )
    }
    // The tarball extracts exactly `axe`, `Frameworks/`, `AXe_AXe.bundle/`
    // at the top level; they must stay together (the binary resolves its
    // frameworks relative to its own location).
    mkdirSync(installDir, { recursive: true })
    await new Promise<void>((resolveExtract, rejectExtract) => {
      execFile('tar', ['-xzf', tmpArchive, '-C', installDir], { timeout: AXE_DOWNLOAD_TIMEOUT_MS, maxBuffer: AXE_MAX_BUFFER_BYTES }, error => {
        if (error !== null) rejectExtract(new Error(`tar extraction failed: ${String(error)}`))
        else resolveExtract()
      })
    })
    const binary = axeCacheBinary()
    if (!isExecutableFile(binary)) {
      chmodSync(binary, 0o755)
    }
    // Sanity-check the fresh binary and record its digest for later runs.
    const version = await execAxe({ available: true, source: 'cache', command: binary, installHint: AXE_INSTALL_HINT }, ['--version'], AXE_EXEC_TIMEOUT_MS)
    if (!version.stdout.includes(AXE_VERSION)) {
      throw new Error(`downloaded axe reports unexpected version: ${version.stdout.trim()}`)
    }
    writeFileSync(axeCacheDigestFile(), `${sha256File(binary)}\n`, 'utf8')
    return binary
  } finally {
    rmSync(tmpArchive, { force: true })
  }
}

/** Shared in-flight download so concurrent tool calls wait on one fetch. */
let downloadPromise: Promise<void> | undefined
let downloadFailure: { at: number; message: string } | undefined
const AXE_SETUP_WAIT_MS = 8_000
const AXE_DOWNLOAD_RETRY_MS = 5 * 60_000

/**
 * Resolve the helper, downloading the pinned release into the plugin cache
 * when it is absent (macOS only; skipped with `DSHPLUGIN_IOS_AXE_OFFLINE=1`).
 * Resolution-only failure is never fatal here: the returned object carries
 * the reason and the install hint for the tool to throw.
 */
export async function ensureAxeBinary(): Promise<AxeBinary> {
  const resolved = resolveAxeBinary()
  if (resolved.available) return resolved
  if (pluginEnv('IOS_AXE_BIN')) return resolved
  if (process.platform !== 'darwin' || pluginEnv('IOS_AXE_OFFLINE') === '1') return resolved
  if (downloadFailure && Date.now() - downloadFailure.at < AXE_DOWNLOAD_RETRY_MS) {
    return { ...resolved, reason: `${downloadFailure.message}; automatic download is cooling down. Use ios_sim_find_text meanwhile.` }
  }
  if (downloadPromise !== undefined) {
    return { ...resolved, reason: 'AXe is being prepared in the background; use ios_sim_find_text meanwhile.' }
  }
  if (downloadPromise === undefined) {
    downloadPromise = downloadAxeRelease().then(() => {
      downloadFailure = undefined
    }).catch(error => {
      downloadFailure = { at: Date.now(), message: `axe download failed (${error instanceof Error ? error.message : String(error)})` }
    }).finally(() => {
      downloadPromise = undefined
    })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([downloadPromise, new Promise<void>(resolve => { timer = setTimeout(resolve, AXE_SETUP_WAIT_MS) })])
  } finally { clearTimeout(timer) }
  const ready = resolveAxeBinary()
  return ready.available ? ready : { ...ready, reason: downloadFailure?.message
    ?? 'AXe is still being prepared in the background; use ios_sim_find_text meanwhile, then retry the accessibility tool.' }
}

/**
 * Run one axe subcommand. Non-zero exits raise with the tool output (axe
 * prints its error text on stdout), as does an "Error:" prefix on stdout
 * (defensive: some axe paths print errors without a failing exit code).
 */
export function execAxe(
  binary: AxeBinary,
  args: readonly string[],
  timeoutMs = AXE_EXEC_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  if (!binary.available || binary.command === undefined) {
    return Promise.reject(new Error(`axe is unavailable${binary.reason === undefined ? '' : ` (${binary.reason})`}; ${binary.installHint}`))
  }
  return new Promise((resolve, reject) => {
    execFile(binary.command!, [...args], {
      timeout: timeoutMs,
      maxBuffer: AXE_MAX_BUFFER_BYTES,
      signal,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stdout.trim() || stderr.trim()
        reject(new Error(`axe ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`))
        return
      }
      if (stdout.trimStart().startsWith('Error:')) {
        reject(new Error(`axe ${args.join(' ')} failed: ${stdout.trim()}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  // Normalize NEGATIVE ZERO. AXe reports off-screen-left frames as `-0`, and
  // `JSON.parse('-0')` preserves it while `JSON.stringify(-0)` writes `0` —
  // so a tree carrying one is not losslessly serializable and DSH rejects the
  // ENTIRE tool result ("value is not lossless JSON"). Seen in a real session:
  // 4 of 7 ios_sim_ui_tree calls died on three `frame.x: -0` deep in the
  // Calendar hierarchy. `value === 0` is true for -0, so this flattens both.
  return value === 0 ? 0 : value
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Sanitize one raw AXe node into the plugin's element shape (idempotent). */
export function sanitizeAxeNode(raw: RawAxeNode): AxeElement {
  const rawFrame = raw.frame as {
    x?: unknown
    y?: unknown
    width?: unknown
    height?: unknown
    w?: unknown
    h?: unknown
  } | undefined
  const x = finiteNumber(rawFrame?.x) ?? 0
  const y = finiteNumber(rawFrame?.y) ?? 0
  const w = finiteNumber(rawFrame?.width ?? rawFrame?.w) ?? 0
  const h = finiteNumber(rawFrame?.height ?? rawFrame?.h) ?? 0
  const children: AxeElement[] = []
  if (Array.isArray(raw.children)) {
    for (const child of raw.children) {
      if (typeof child === 'object' && child !== null) children.push(sanitizeAxeNode(child as RawAxeNode))
    }
  }
  const label = optionalString(raw.AXLabel ?? raw.label)
  const identifier = optionalString(raw.AXUniqueId ?? raw.identifier)
  const value = optionalString(raw.AXValue ?? raw.value)
  const node: AxeElement = {
    type: typeof raw.type === 'string' && raw.type !== '' ? raw.type : 'Element',
    frame: { x, y, w, h },
    children,
  }
  if (label !== undefined) node.label = label
  if (identifier !== undefined) node.identifier = identifier
  if (value !== undefined) node.value = value
  // Boolean flags only: AXe emits `enabled` true/false (or null/absent),
  // WDA's normalizer passes its "true"/"false" attributes already parsed.
  // Anything else is treated as unreported, never guessed.
  if (typeof raw.enabled === 'boolean') node.enabled = raw.enabled
  if (typeof raw.visible === 'boolean') node.visible = raw.visible
  // Same rule as enabled/visible: a boolean from the backend is the fact; an
  // absent/other value is "unreported" and the field stays off the node.
  if (typeof raw.selected === 'boolean') node.selected = raw.selected
  // Secure classification must be POSITIVE only. A null/absent AXe subrole
  // cannot assert "not secure" (the backend may simply not expose one), and
  // WDA's sanitizer passes an explicit secure=true for SecureTextField nodes.
  // Unknown therefore stays absent, never false.
  if (raw.secure === true) node.secure = true
  else if (raw.subrole === 'AXSecureTextField' || raw.role === 'AXSecureTextField') node.secure = true
  else if (typeof raw.type === 'string' && (raw.type === 'SecureTextField' || raw.type.includes('Secure'))) node.secure = true
  if (typeof raw.focused === 'boolean') node.focused = raw.focused
  const pid = finiteNumber(raw.pid)
  if (pid !== undefined && Number.isSafeInteger(pid) && pid >= 0) node.pid = pid
  return node
}

/**
 * Parse `axe describe-ui` stdout into sanitized root elements. describe-ui
 * returns a JSON array with one entry per on-screen application (usually 1).
 */
export function parseDescribeUi(stdout: string): AxeElement[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`axe describe-ui returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('axe describe-ui returned an unexpected payload (expected a JSON array of application roots)')
  }
  const roots: AxeElement[] = []
  for (const entry of parsed) {
    if (typeof entry === 'object' && entry !== null) roots.push(sanitizeAxeNode(entry as RawAxeNode))
  }
  if (roots.length === 0) {
    throw new Error('axe describe-ui returned an empty element tree')
  }
  return roots
}

/** Display context belongs to this fresh tree only; never a per-device cache. */
const treeDisplays = new WeakMap<AxeElement[], DuoDisplay>()
export function duoDisplayForTree(roots: AxeElement[]): DuoDisplay | undefined { return treeDisplays.get(roots) }

/** AX application containers retain portrait/previous-screen bounds on Duo.
 * Only replace that container after its actual content viewport agrees with
 * the measured active display. Never scale descendants or combine screens. */
export function alignDuoTree(roots: AxeElement[], display: DuoDisplay): AxeElement[] {
  const matches = (node: AxeElement): boolean => Math.abs(node.frame.x) < 1 && Math.abs(node.frame.y) < 1
    && Math.abs(node.frame.w - display.points.width) < 1 && Math.abs(node.frame.h - display.points.height) < 1
  for (const root of roots) {
    if (root.type !== 'Application' || !root.children.some(matches)) {
      throw new Error('Duo accessibility content does not match the active display; retry after the screen settles')
    }
  }
  const aligned = roots.map(root => ({ ...root, frame: { x: 0, y: 0, w: display.points.width, h: display.points.height } }))
  treeDisplays.set(aligned, display)
  return aligned
}

/** Dump a tree with a stable active-display context on Duo. */
async function describeUiOnce(
  binary: AxeBinary,
  udid: string,
  signal?: AbortSignal,
  device?: HingeDevice,
): Promise<AxeElement[]> {
  for (let attempt = 0; ; attempt++) {
    const before = device === undefined ? undefined : await readDuoDisplay(device, signal)
    let stdout: string
    try {
      const session = before !== undefined && binary.source === 'cache' && binary.command
        ? readWithAxeSession(binary.command, udid, signal) : undefined
      stdout = session !== undefined ? await session
        : (await execAxe(binary, ['describe-ui', '--udid', udid], AXE_EXEC_TIMEOUT_MS, signal)).stdout
    } catch (error) {
      // AXe's testmanagerd remote session can be left disconnected after a
      // simulator restart. Recover this observed transport failure once;
      // do not restart apps or hide arbitrary accessibility failures.
      if (before === undefined || attempt > 0 || !/Timed out creating the simulator remote automation session|Channel disconnected/i.test(String(error))) throw error
      await new Promise<void>((resolve, reject) => {
        execFile('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'kickstart', '-k', 'user/foreground/com.apple.testmanagerd'],
          { timeout: 5_000, maxBuffer: 1024 * 1024, signal }, error => error === null ? resolve() : reject(error))
      }).catch(error => {
        signal?.throwIfAborted()
        // kickstart may have restarted the daemon before its CLI times out.
        // Only a fresh, independently validated AX read can prove recovery.
        if ((error as { killed?: boolean }).killed !== true) throw error
      })
      continue
    }
    const roots = parseDescribeUi(stdout)
    if (before === undefined) return roots
    const after = await readDuoDisplay(device!, signal)
    try {
      if (!after || !sameDuoDisplay(before, after)) throw new Error('Duo display changed while reading accessibility; retry with the current screen')
      return alignDuoTree(roots, after)
    } catch (error) {
      if (attempt >= 1) throw error
      signal?.throwIfAborted()
    }
  }
}

const describeQueues = new Map<string, Promise<unknown>>()
/** One remote automation session per device: parallel model reads must not
 * compete for testmanagerd. Other simulators remain independent. */
export async function describeUi(binary: AxeBinary, udid: string, signal?: AbortSignal, device?: HingeDevice): Promise<AxeElement[]> {
  const previous = describeQueues.get(udid) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(() => {
    signal?.throwIfAborted()
    return withSimDeviceRead(udid, signal, freshSignal => describeUiOnce(binary, udid, freshSignal, device))
  })
  describeQueues.set(udid, pending)
  try { return await pending }
  finally { if (describeQueues.get(udid) === pending) describeQueues.delete(udid) }
}
