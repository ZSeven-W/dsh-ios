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
 *   1. `DSH_IOS_AXE_BIN` (explicit override, e.g. CI);
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
 * and not downloadable (non-macOS host, offline, `DSH_IOS_AXE_OFFLINE=1`),
 * with a clear install hint in the thrown tool error.
 * @module @zseven-w/dsh-ios/uitree-backend
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

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
  + 'set DSH_IOS_AXE_BIN to an existing axe executable to override resolution'

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
  const explicit = process.env.DSH_IOS_AXE_BIN
  if (explicit !== undefined && explicit.trim() !== '') {
    if (isExecutableFile(explicit.trim())) {
      return { available: true, source: 'path', command: explicit.trim(), installHint: AXE_INSTALL_HINT }
    }
    return {
      available: false,
      source: 'unavailable',
      reason: `DSH_IOS_AXE_BIN points at a missing or non-executable file: ${explicit.trim()}`,
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
    await new Promise<void>((resolveDownload, rejectDownload) => {
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
let downloadPromise: Promise<string> | undefined

/**
 * Resolve the helper, downloading the pinned release into the plugin cache
 * when it is absent (macOS only; skipped with `DSH_IOS_AXE_OFFLINE=1`).
 * Resolution-only failure is never fatal here: the returned object carries
 * the reason and the install hint for the tool to throw.
 */
export async function ensureAxeBinary(): Promise<AxeBinary> {
  const resolved = resolveAxeBinary()
  if (resolved.available) return resolved
  if (process.platform !== 'darwin' || process.env.DSH_IOS_AXE_OFFLINE === '1') return resolved
  if (downloadPromise === undefined) {
    downloadPromise = downloadAxeRelease().catch(error => {
      throw new Error(`axe download failed (${error instanceof Error ? error.message : String(error)}); ${AXE_INSTALL_HINT}`)
    }).finally(() => {
      downloadPromise = undefined
    })
  }
  await downloadPromise
  return resolveAxeBinary()
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

/** Dump the sanitized accessibility tree of a booted simulator. */
export async function describeUi(
  binary: AxeBinary,
  udid: string,
  signal?: AbortSignal,
): Promise<AxeElement[]> {
  const { stdout } = await execAxe(binary, ['describe-ui', '--udid', udid], AXE_EXEC_TIMEOUT_MS, signal)
  return parseDescribeUi(stdout)
}
