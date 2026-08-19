/**
 * Vision OCR helper resolution, compilation, execution, and coordinate
 * conversion — the backend of `ios_sim_find_text` / `ios_sim_tap_text`.
 *
 * The accessibility tree stays the primary UI-inspection source; OCR covers
 * what it cannot see: apps with no accessibility at all (Unity/Metal/
 * SpriteKit, Canvas/WebGL, custom-drawn UI), text rendered as graphics
 * (badge counts, prices baked into images), and independent verification.
 * It works identically for simulators and real devices because both already
 * produce PNG screenshots through the existing capture paths — no device
 * dependency, no signing, no npm packages.
 *
 * The helper is a plugin-owned Swift source (`assets/ocr.swift`, Vision's
 * `VNRecognizeTextRequest`, accurate, zh-Hans + en-US) compiled ON FIRST
 * USE into the plugin cache:
 *
 *     ~/Library/Caches/dsh-ios/bin/ocr/<sha256(source)[0..16]>/ocr
 *
 * The cache key is the source hash, so an edited helper recompiles into a
 * fresh slot; the compiled binary's digest is recorded next to it and
 * re-checked on every resolution (mirroring uitree-backend's AXe integrity
 * handling), so a corrupted artifact is rebuilt.
 * Degradation mirrors serve-sim / AXe: resolution-only when the helper is
 * absent and not compilable (non-macOS host, no `swiftc`, missing source),
 * with a clear install hint in the thrown tool error.
 *
 * COORDINATE SPACES (the trap that has bitten this project twice): the
 * helper emits boxes in IMAGE PIXELS (origin top-left). Taps need device
 * POINTS for WDA (`/wda/tap`) and normalized 0..1 for the simulator
 * serve-sim control path. The conversions below go through the
 * screenshot's own pixel size and the device's point size (WDA
 * `windowSize()`; for simulators the existing AXe `screenSize` helper) —
 * never a fixed 3× scale.
 * @module @zseven-w/dsh-ios/ocr-backend
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Install hint appended to every helper-unavailable tool error. */
export const OCR_INSTALL_HINT = 'the plugin compiles its bundled Vision OCR helper with swiftc on first use — '
  + 'install Xcode (or the Command Line Tools: run "xcode-select --install") so ios_sim_find_text / '
  + 'ios_sim_tap_text can run'

/** Cache base dir; `DSH_IOS_OCR_DIR` overrides it (tests/CI). */
const OCR_CACHE_BASE = join(homedir(), 'Library', 'Caches', 'dsh-ios', 'bin', 'ocr')
/** Well-known swiftc locations, probed even with a trimmed PATH. */
const SWIFTC_CANDIDATES = ['/usr/bin/swiftc', '/usr/local/bin/swiftc']
const OCR_COMPILE_TIMEOUT_MS = 5 * 60 * 1000
const OCR_EXEC_TIMEOUT_MS = 120_000
const OCR_MAX_BUFFER_BYTES = 8 * 1024 * 1024

/** Where the resolved OCR helper came from. */
export type OcrBinarySource = 'path' | 'cache' | 'unavailable'

/** One resolved OCR helper binary. */
export interface OcrBinary {
  available: boolean
  source: OcrBinarySource
  /** Absolute path of the executable (when available). */
  command?: string
  /** Why resolution failed (when unavailable). */
  reason?: string
  /** One-line install hint for the model (always set when unavailable). */
  installHint: string
  /** True when everything needed to compile the bundled helper exists. */
  compilable?: boolean
}

/** One OCR box: image pixels, origin top-left. */
export interface OcrRect {
  x: number
  y: number
  w: number
  h: number
}

/** One recognized text item (box in image pixels). */
export interface OcrItem {
  text: string
  confidence: number
  rect: OcrRect
}

/** A size in pixels or points (never mixed inside one computation). */
export interface PixelSize {
  width: number
  height: number
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

/** Plugin cache base dir for the compiled helper. */
export function ocrCacheBase(): string {
  const override = process.env.DSH_IOS_OCR_DIR
  return override !== undefined && override.trim() !== '' ? override.trim() : OCR_CACHE_BASE
}

/** Cache dir for one source revision (keyed by the source hash). */
function ocrCacheInstallDir(sourceSha256: string): string {
  return join(ocrCacheBase(), sourceSha256.slice(0, 16))
}

/**
 * Resolve the bundled Swift source (`assets/ocr.swift`): an explicit
 * `DSH_IOS_OCR_SWIFT` override wins — and a bad override FAILS (like
 * `DSH_IOS_AXE_BIN`) instead of silently falling through — then the path
 * relative to this compiled module (works from `lib/` in the repo and
 * inside the installed package), then a cwd-relative fallback for
 * development working copies.
 */
export function resolveOcrSwiftSource(): { path?: string; reason?: string } {
  const explicit = process.env.DSH_IOS_OCR_SWIFT
  if (explicit !== undefined && explicit.trim() !== '') {
    const candidate = explicit.trim()
    try {
      if (statSync(candidate).isFile()) return { path: candidate }
    } catch {
      // Missing override → hard failure below.
    }
    return { reason: `DSH_IOS_OCR_SWIFT points at a missing or unreadable file: ${candidate}` }
  }
  const candidates: string[] = []
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'ocr.swift'))
  candidates.push(join(process.cwd(), 'assets', 'ocr.swift'))
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return { path: candidate }
    } catch {
      // Try the next candidate.
    }
  }
  return { reason: `the bundled OCR Swift source was not found (tried ${candidates.join(', ')})` }
}

/** The swiftc compiler to use (explicit override → PATH → well-known). */
function resolveSwiftc(): { command?: string; reason?: string } {
  const explicit = process.env.DSH_IOS_SWIFTC
  if (explicit !== undefined && explicit.trim() !== '') {
    if (isExecutableFile(explicit.trim())) return { command: explicit.trim() }
    return { reason: `DSH_IOS_SWIFTC points at a missing or non-executable file: ${explicit.trim()}` }
  }
  const onPath = findOnPath('swiftc')
  if (onPath !== undefined) return { command: onPath }
  const known = SWIFTC_CANDIDATES.find(isExecutableFile)
  if (known !== undefined) return { command: known }
  return { reason: 'swiftc (the Swift compiler) was not found on PATH — install Xcode or the Command Line Tools' }
}

/**
 * Validate a cached compile: executable binary + recorded digest matches the
 * BINARY's own bytes (the cache slot is keyed by the source hash; the digest
 * pins the compiled artifact against corruption).
 */
function validCachedBinary(sourceSha256: string): string | undefined {
  const binary = join(ocrCacheInstallDir(sourceSha256), 'ocr')
  if (!isExecutableFile(binary)) return undefined
  const digestFile = join(ocrCacheInstallDir(sourceSha256), '.dsh-ios-ocr-source.sha256')
  try {
    const recorded = readFileSync(digestFile, 'utf8').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(recorded)) return undefined
    return recorded === sha256File(binary) ? binary : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the OCR helper synchronously: source file + swiftc probe + cache
 * digest validation. Never compiles; `ensureOcrBinary()` adds the
 * compile-on-first-use step.
 */
export function resolveOcrBinary(): OcrBinary {
  if (process.platform !== 'darwin') {
    return {
      available: false,
      source: 'unavailable',
      reason: 'Vision OCR only runs on macOS with Xcode',
      installHint: OCR_INSTALL_HINT,
    }
  }
  const source = resolveOcrSwiftSource()
  if (source.path === undefined) {
    return {
      available: false,
      source: 'unavailable',
      reason: source.reason,
      installHint: OCR_INSTALL_HINT,
    }
  }
  const swiftc = resolveSwiftc()
  if (swiftc.command === undefined) {
    return {
      available: false,
      source: 'unavailable',
      reason: swiftc.reason,
      installHint: OCR_INSTALL_HINT,
    }
  }
  const sourceSha256 = sha256File(source.path)
  const cached = validCachedBinary(sourceSha256)
  if (cached !== undefined) {
    return { available: true, source: 'cache', command: cached, installHint: OCR_INSTALL_HINT }
  }
  return {
    available: false,
    source: 'unavailable',
    reason: 'the OCR helper has not been compiled into the plugin cache yet (compiled on first use)',
    installHint: OCR_INSTALL_HINT,
    compilable: true,
  }
}

/** Run the compiled helper. Non-zero exits raise with its stderr/stdout. */
export function execOcr(
  binary: OcrBinary,
  imagePath: string,
  signal?: AbortSignal,
  timeoutMs = OCR_EXEC_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  if (!binary.available || binary.command === undefined) {
    return Promise.reject(new Error(`the OCR helper is unavailable${binary.reason === undefined ? '' : ` (${binary.reason})`}; ${binary.installHint}`))
  }
  return new Promise((resolve, reject) => {
    execFile(binary.command!, [imagePath], {
      timeout: timeoutMs,
      maxBuffer: OCR_MAX_BUFFER_BYTES,
      signal,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim() || stdout.trim()
        reject(new Error(`OCR helper failed${detail === '' ? '' : `: ${detail}`}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Compile the bundled Swift source into the plugin cache
 * (`~/Library/Caches/dsh-ios/bin/ocr/<hash>/ocr`), then record the compiled
 * binary's digest next to it for later integrity checks. The fresh binary
 * is sanity-launched (its no-argument usage path) before it replaces any
 * previous artifact.
 */
async function compileOcrHelper(): Promise<string> {
  const source = resolveOcrSwiftSource()
  const swiftc = resolveSwiftc()
  if (source.path === undefined || swiftc.command === undefined) {
    const reason = source.reason ?? swiftc.reason
    throw new Error(`cannot compile the OCR helper${reason === undefined ? '' : ` (${reason})`}; ${OCR_INSTALL_HINT}`)
  }
  const base = ocrCacheBase()
  const sourceSha256 = sha256File(source.path)
  const installDir = ocrCacheInstallDir(sourceSha256)
  const binary = join(installDir, 'ocr')
  const digestFile = join(installDir, '.dsh-ios-ocr-source.sha256')
  const cached = validCachedBinary(sourceSha256)
  if (cached !== undefined) return cached
  mkdirSync(base, { recursive: true })
  mkdirSync(installDir, { recursive: true })
  const tmp = join(base, `.ocr-${sourceSha256.slice(0, 16)}-${process.pid}-${Date.now()}.tmp`)
  try {
    await new Promise<void>((resolveCompile, rejectCompile) => {
      execFile(swiftc.command!, ['-O', source.path!, '-o', tmp], { timeout: OCR_COMPILE_TIMEOUT_MS, maxBuffer: OCR_MAX_BUFFER_BYTES }, error => {
        if (error !== null) {
          rejectCompile(new Error(`swiftc -O ${source.path} failed: ${error.message}`))
        } else {
          resolveCompile()
        }
      })
    })
    // Sanity launch: with no arguments the helper prints its usage and exits
    // 2 — that proves the binary runs (its dylibs load) without touching a
    // screenshot.
    await new Promise<void>((resolveRun, rejectRun) => {
      execFile(tmp, [], { timeout: 60_000, maxBuffer: 1024 * 1024 }, error => {
        if (error === null || (typeof error.code === 'number' && error.code === 2)) resolveRun()
        else rejectRun(new Error(`compiled OCR helper failed its sanity launch: ${error.message}`))
      })
    })
    renameSync(tmp, binary)
    // Pin the COMPILED binary's digest (the directory is already keyed by
    // the source hash): a corrupted artifact fails validation on the next
    // resolution and gets recompiled.
    writeFileSync(digestFile, `${sha256File(binary)}\n`, 'utf8')
    return binary
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Shared in-flight compile so concurrent tool calls wait on one build. */
let compilePromise: Promise<string> | undefined

/**
 * Resolve the helper, compiling the bundled source into the plugin cache
 * when it is absent (macOS with swiftc only). Resolution-only failure is
 * never fatal here: the returned object carries the reason and the install
 * hint for the tool to throw.
 */
export async function ensureOcrBinary(): Promise<OcrBinary> {
  const resolved = resolveOcrBinary()
  if (resolved.available || resolved.compilable !== true) return resolved
  if (compilePromise === undefined) {
    compilePromise = compileOcrHelper().catch(error => {
      throw new Error(`OCR helper compilation failed (${error instanceof Error ? error.message : String(error)}); ${OCR_INSTALL_HINT}`)
    }).finally(() => {
      compilePromise = undefined
    })
  }
  await compilePromise
  return resolveOcrBinary()
}

/** Parse the helper's JSON payload into sanitized items (confidence-sorted). */
export function parseOcrOutput(stdout: string): OcrItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`the OCR helper returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the OCR helper returned an unexpected payload (expected an object with an items array)')
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.items)) {
    throw new Error('the OCR helper returned an unexpected payload (missing items array)')
  }
  const seen = new Set<string>()
  const items: OcrItem[] = []
  for (const entry of record.items) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : undefined
    const x = typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : undefined
    const y = typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : undefined
    const w = typeof raw.w === 'number' && Number.isFinite(raw.w) ? raw.w : undefined
    const h = typeof raw.h === 'number' && Number.isFinite(raw.h) ? raw.h : undefined
    if (text === '' || confidence === undefined || x === undefined || y === undefined || w === undefined || h === undefined) continue
    if (confidence < 0 || confidence > 1 || x < 0 || y < 0 || w < 0 || h < 0) continue
    // Exact-duplicate observations (same text at the same box) collapse.
    const key = `${text}\u0000${x}\u0000${y}\u0000${w}\u0000${h}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ text, confidence, rect: { x, y, w, h } })
  }
  // Highest confidence first (stable: equal confidence keeps Vision order).
  items.sort((a, b) => b.confidence - a.confidence)
  return items
}

/**
 * Filter OCR items: case-insensitive substring on the query and a
 * minimum-confidence floor. Empty/absent query keeps everything.
 */
export function filterOcrItems(
  items: readonly OcrItem[],
  query?: string,
  minConfidence = 0,
): OcrItem[] {
  const needle = query !== undefined && query.trim() !== '' ? query.trim().toLowerCase() : undefined
  return items.filter(item =>
    (needle === undefined || item.text.toLowerCase().includes(needle))
    && item.confidence >= minConfidence,
  )
}

function requireSize(size: PixelSize, what: string): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new RangeError(`${what} must be a finite positive size, got ${size.width}x${size.height}`)
  }
}

/**
 * Pixel box → device-point box, scaled independently per axis through the
 * screenshot's own pixel size and the device's point size (never a fixed
 * 3× scale).
 */
export function pixelRectToPoints(rect: OcrRect, pixelSize: PixelSize, pointSize: PixelSize): OcrRect {
  requireSize(pixelSize, 'pixelSize')
  requireSize(pointSize, 'pointSize')
  const scaleX = pointSize.width / pixelSize.width
  const scaleY = pointSize.height / pixelSize.height
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    w: rect.w * scaleX,
    h: rect.h * scaleY,
  }
}

/** Inverse of `pixelRectToPoints` (device points → image pixels). */
export function pointsRectToPixels(rect: OcrRect, pointSize: PixelSize, pixelSize: PixelSize): OcrRect {
  requireSize(pixelSize, 'pixelSize')
  requireSize(pointSize, 'pointSize')
  const scaleX = pixelSize.width / pointSize.width
  const scaleY = pixelSize.height / pointSize.height
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    w: rect.w * scaleX,
    h: rect.h * scaleY,
  }
}

/**
 * Pixel box → normalized 0..1 box (the simulator serve-sim control path).
 * Only the screenshot's own pixel size matters: the control multiplies by
 * the live logical size internally.
 */
export function pixelRectToNormalized(rect: OcrRect, pixelSize: PixelSize): OcrRect {
  requireSize(pixelSize, 'pixelSize')
  return {
    x: rect.x / pixelSize.width,
    y: rect.y / pixelSize.height,
    w: rect.w / pixelSize.width,
    h: rect.h / pixelSize.height,
  }
}

/** Inverse of `pixelRectToNormalized` (normalized 0..1 → image pixels). */
export function normalizedRectToPixels(rect: OcrRect, pixelSize: PixelSize): OcrRect {
  requireSize(pixelSize, 'pixelSize')
  return {
    x: rect.x * pixelSize.width,
    y: rect.y * pixelSize.height,
    w: rect.w * pixelSize.width,
    h: rect.h * pixelSize.height,
  }
}

/** Center of a box (any space; the unit carries through). */
export function rectCenter(rect: OcrRect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/** Pixel box center → device-point tap coordinates (WDA `/wda/tap`). */
export function pixelCenterToPoints(
  center: { x: number; y: number },
  pixelSize: PixelSize,
  pointSize: PixelSize,
): { x: number; y: number } {
  requireSize(pixelSize, 'pixelSize')
  requireSize(pointSize, 'pointSize')
  return {
    x: center.x * (pointSize.width / pixelSize.width),
    y: center.y * (pointSize.height / pixelSize.height),
  }
}

/** Pixel box center → normalized 0..1 tap coordinates (serve-sim control). */
export function pixelRectToNormalizedCenter(rect: OcrRect, pixelSize: PixelSize): { x: number; y: number } {
  requireSize(pixelSize, 'pixelSize')
  const center = rectCenter(rect)
  return { x: center.x / pixelSize.width, y: center.y / pixelSize.height }
}
