/**
 * SAFE private staging for the PHYSICAL-device WebDriverAgent source.
 *
 * The default physical QA path (createIosQaBackend() with no injected WDA)
 * must never run an unpatched WDA checkout on a device: the stock
 * bindingIPAddress answers nil (bind every interface) unless USE_IP is
 * set, and the MJPEG screenshots broadcaster binds every device interface by
 * default. Both expose WDA to the device LAN — the exact wildcard listeners
 * this module removes. It prepares a deterministic PRIVATE copy of the shared
 * cached checkout with the reviewed safety patches below, and never modifies
 * the shared cache:
 *
 * - HTTP always bound to 127.0.0.1 (FBConfiguration.m bindingIPAddress);
 * - MJPEG broadcaster bound to 127.0.0.1 only (FBWebServer.m
 *   screenshotsBroadcaster.interface — FBTCPSocket documents 'interface'
 *   as the listener bind address, nil = all interfaces).
 *
 * The MJPEG broadcaster stays ENABLED on device loopback (the physical
 * control/stream path still tunnels it over usbmux). The simulator input
 * runtime keeps its own separate disabled-MJPEG patch set untouched.
 *
 * The staged copy carries a content-addressed identity manifest so repeated
 * runs reuse the exact same private tree (private staged copy/cache
 * identity), and staging fails closed with an honest prerequisite error when
 * the shared cache is missing or the patch anchors no longer match.
 *
 * This module is host-free (no DSH host imports) and safe to import without
 * a device or Xcode toolchain present.
 *
 * @module @zseven-w/dsh-ios/wda-physical-stage
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Stable component that owns the private physical staging state. */
export const PHYSICAL_WDA_RUNTIME_OWNER_ID = 'dsh-ios-wda-physical-safe'

/** Identity manifest filename inside each staged copy. */
export const PHYSICAL_WDA_STAGE_MANIFEST_FILE = 'dsh-wda-physical-safe-stage.json'

export type PhysicalWdaStageErrorCode = 'UNSUPPORTED' | 'PATCH_FAILED'

/** Typed staging failure; message is always safe (no raw vendor output). */
export class PhysicalWdaStageError extends Error {
  readonly code: PhysicalWdaStageErrorCode
  constructor(code: PhysicalWdaStageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PhysicalWdaStageError'
    this.code = code
  }
}

export interface PhysicalWdaPatchDefinition {
  id: string
  file: string
  /** Exact old text; absent means fail because the source is unsupported. */
  oldText: string
  newText: string
  count?: number
}

export interface PhysicalWdaPatchAsset {
  schema: number
  owner: string
  description: string
  patches: PhysicalWdaPatchDefinition[]
}

/** Reviewed physical safety patches (anchors verified against the cached
 * WebDriverAgent checkout at revision 6e2b5c0). */
export const PHYSICAL_WDA_DEFAULT_PATCHES: PhysicalWdaPatchAsset = {
  schema: 1,
  owner: PHYSICAL_WDA_RUNTIME_OWNER_ID,
  description: 'Deterministic safety-only modifications for cached WebDriverAgent physical use: HTTP and MJPEG bind device loopback only. Original license/attribution files are copied unchanged.',
  patches: [
    {
      id: 'bindingIPAddress-unconditional-loopback',
      file: 'WebDriverAgentLib/Utilities/FBConfiguration.m',
      oldText: `- (NSString *)bindingIPAddress\n{\n  // Existence of USE_IP in the environment allows specifying which interface to bind to\n  if (NSProcessInfo.processInfo.environment[@"USE_IP"] &&\n      [NSProcessInfo.processInfo.environment[@"USE_IP"] length] > 0) {\n    return NSProcessInfo.processInfo.environment[@"USE_IP"];\n  }\n\n  return nil;\n}`,
      newText: `- (NSString *)bindingIPAddress\n{\n  // SAFE dsh-ios physical QA: HTTP must always bind to device loopback.\n  // Environment cannot disable this safety patch.\n  return @"127.0.0.1";\n}`,
      count: 1,
    },
    {
      id: 'mjpeg-broadcaster-loopback-only',
      file: 'WebDriverAgentLib/Routing/FBWebServer.m',
      oldText: `  self.screenshotsBroadcaster = [[FBTCPSocket alloc]\n                                 initWithPort:(uint16_t)FBConfiguration.sharedInstance.mjpegServerPort];`,
      newText: `  self.screenshotsBroadcaster = [[FBTCPSocket alloc]\n                                 initWithPort:(uint16_t)FBConfiguration.sharedInstance.mjpegServerPort];\n  // SAFE dsh-ios physical QA: the MJPEG broadcaster must bind to\n  // device loopback only. FBTCPSocket documents interface as the bind\n  // address; nil binds every interface and would expose the video\n  // stream on the device LAN.\n  self.screenshotsBroadcaster.interface = @"127.0.0.1";`,
      count: 1,
    },
  ],
}

export interface PhysicalWdaStageManifest {
  schema: number
  owner: string
  originalSourceDir: string
  sourceVersion?: string
  sourceDigest: string
  patchDigest: string
  stagedDigest: string
  patches: Array<{ id: string; file: string; applied: boolean }>
  stagedAt: string
  cacheKey: string
}

export interface PhysicalWdaPreparedSource {
  /** Absolute path of the private patched copy (the WdaController project dir). */
  stageDir: string
  manifest: PhysicalWdaStageManifest
  sourceVersion?: string
}

/** Injectable filesystem functions (tests use a tmp-backed set). */
export interface PhysicalWdaStageFsImpl {
  readdir: typeof readdir
  stat: typeof stat
  lstat: typeof lstat
  readFile: typeof readFile
  writeFile: typeof writeFile
  mkdir: typeof mkdir
  rm: typeof rm
  rename: typeof rename
}

const DEFAULT_FS: PhysicalWdaStageFsImpl = { readdir, stat, lstat, readFile, writeFile, mkdir, rm, rename }

/** Shared cached checkout the default path stages from (never modified). */
export function defaultPhysicalWdaSourceDir(): string {
  return join(homedir(), 'Library', 'Caches', 'dsh-ios', 'wda', 'src')
}

/** Private staging state root (the staged copies live here). */
export function defaultPhysicalWdaStateDir(): string {
  return join(homedir(), 'Library', 'Caches', 'dsh-ios', 'wda-physical-safe')
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function gitHead(sourceDir: string, execFileFn: typeof execFile): Promise<string | undefined> {
  try {
    const stdout = await new Promise<string>((resolveHead, rejectHead) => {
      execFileFn('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { timeout: 5_000, encoding: 'utf8' }, (error, out) => {
        if (error) rejectHead(error)
        else resolveHead(out)
      })
    })
    const line = stdout.trim()
    return line.length > 0 ? line : undefined
  } catch {
    return undefined
  }
}

/** Parse and validate a physical patch asset (schema 1, this module's owner). */
export function parsePhysicalPatchAsset(input: unknown): PhysicalWdaPatchAsset {
  if (typeof input !== 'object' || input === null) {
    throw new PhysicalWdaStageError('PATCH_FAILED', 'physical safety patch asset must be an object')
  }
  const value = input as Record<string, unknown>
  if (value.schema !== 1 || value.owner !== PHYSICAL_WDA_RUNTIME_OWNER_ID || !Array.isArray(value.patches)) {
    throw new PhysicalWdaStageError('PATCH_FAILED', 'unsupported physical safety patch asset')
  }
  const patches = value.patches.map(item => {
    if (typeof item !== 'object' || item === null) {
      throw new PhysicalWdaStageError('PATCH_FAILED', 'unsupported physical safety patch entry')
    }
    const patch = item as Record<string, unknown>
    if (typeof patch.id !== 'string' || typeof patch.file !== 'string'
      || typeof patch.oldText !== 'string' || typeof patch.newText !== 'string') {
      throw new PhysicalWdaStageError('PATCH_FAILED', 'physical safety patch entry is missing required strings')
    }
    if (patch.count !== undefined && typeof patch.count !== 'number') {
      throw new PhysicalWdaStageError('PATCH_FAILED', 'physical safety patch count must be a number')
    }
    return {
      id: patch.id,
      file: patch.file,
      oldText: patch.oldText,
      newText: patch.newText,
      count: typeof patch.count === 'number' ? patch.count : undefined,
    }
  })
  if (patches.length === 0) {
    throw new PhysicalWdaStageError('PATCH_FAILED', 'physical safety patch asset has no patches')
  }
  return { schema: 1, owner: PHYSICAL_WDA_RUNTIME_OWNER_ID, description: '', patches }
}

async function loadPhysicalPatchAsset(qaAssetsDir?: string): Promise<PhysicalWdaPatchAsset> {
  if (qaAssetsDir !== undefined && qaAssetsDir.length > 0) {
    const assetFile = join(qaAssetsDir, 'qa-wda-physical', 'safety-patches.json')
    try {
      const raw = await readFile(assetFile, 'utf8')
      return parsePhysicalPatchAsset(JSON.parse(raw))
    } catch (error) {
      throw new PhysicalWdaStageError(
        'PATCH_FAILED',
        'unable to load physical safety patch asset: ' + (error instanceof Error ? error.message : 'parse error'),
        { cause: error },
      )
    }
  }
  return PHYSICAL_WDA_DEFAULT_PATCHES
}

async function copyTree(
  src: string,
  dest: string,
  fns: PhysicalWdaStageFsImpl,
): Promise<void> {
  const entries = await fns.readdir(src, { withFileTypes: true })
  await fns.mkdir(dest, { recursive: true })
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'DerivedData' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue
    const sourcePath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    const info = await fns.lstat(sourcePath)
    if (info.isSymbolicLink()) {
      throw new PhysicalWdaStageError('PATCH_FAILED', 'symbolic links are not allowed in the cached WDA source: ' + entry.name)
    }
    if (info.isDirectory()) {
      await copyTree(sourcePath, destPath, fns)
    } else if (info.isFile()) {
      await fns.writeFile(destPath, await fns.readFile(sourcePath))
      if ((info.mode & 0o111) !== 0) {
        await chmod(destPath, 0o755)
      }
    }
  }
}

async function hashSafeTree(sourceDir: string, fns: PhysicalWdaStageFsImpl): Promise<string> {
  const hash = createHash('sha256')
  async function walk(dir: string): Promise<void> {
    const entries = (await fns.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'DerivedData' || entry.name === 'node_modules' || entry.name === '.DS_Store' || entry.name === PHYSICAL_WDA_STAGE_MANIFEST_FILE) continue
      const full = join(dir, entry.name)
      const info = await fns.lstat(full)
      if (info.isSymbolicLink()) throw new PhysicalWdaStageError('PATCH_FAILED', 'symbolic links are not allowed in the WDA tree: ' + entry.name)
      if (info.isDirectory()) {
        hash.update('D\0').update(entry.name).update('\0')
        await walk(full)
      } else if (info.isFile()) {
        hash.update('F\0').update(full.slice(sourceDir.length + 1)).update('\0')
        hash.update(await fns.readFile(full)).update('\0')
      }
    }
  }
  await walk(resolve(sourceDir))
  return hash.digest('hex')
}

function assertSafePatchPath(file: string): void {
  if (isAbsolute(file) || file.split('/').some(part => part === '' || part === '.' || part === '..') || file.includes('\\')) {
    throw new PhysicalWdaStageError('PATCH_FAILED', 'physical safety patch path is not confined to the staged tree')
  }
}

async function assertNoSymlinkPath(path: string, fns: PhysicalWdaStageFsImpl): Promise<void> {
  // System prefixes such as macOS /var may themselves be symlinks. Reject
  // symlinks at the caller-controlled root; every descendant is checked by
  // copy/hash before it can be consumed.
  try {
    if ((await fns.lstat(resolve(path))).isSymbolicLink()) throw new PhysicalWdaStageError('PATCH_FAILED', 'symlink path is not allowed for physical WDA staging')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function verifyPatchedTree(stageDir: string, patches: PhysicalWdaPatchAsset, fns: PhysicalWdaStageFsImpl): Promise<string> {
  for (const patch of patches.patches) {
    assertSafePatchPath(patch.file)
    const file = join(stageDir, ...patch.file.split('/'))
    const content = await fns.readFile(file, 'utf8')
    const applied = content.split(patch.newText).length - 1
    if (applied === 0 || (patch.count !== undefined && applied !== patch.count)) throw new PhysicalWdaStageError('PATCH_FAILED', 'staged physical safety patch is not verified: ' + patch.id)
  }
  return hashSafeTree(stageDir, fns)
}

async function withStageLock<T>(stateRoot: string, fns: PhysicalWdaStageFsImpl, fn: () => Promise<T>): Promise<T> {
  const lock = join(stateRoot, '.physical-stage.lock')
  await fns.mkdir(stateRoot, { recursive: true })
  for (let attempt = 0; ; attempt += 1) {
    try { await fns.mkdir(lock); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 200) throw new PhysicalWdaStageError('PATCH_FAILED', 'physical WDA staging is busy; refusing an unsafe concurrent build', { cause: error })
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    }
  }
  try { return await fn() } finally { await fns.rm(lock, { recursive: true, force: true }).catch(() => undefined) }
}

export interface StagePhysicalWdaOptions {
  /** Explicit content-addressed cache key (defaults to source+patch digests). */
  cacheKey?: string
  /** Injectable filesystem (tests). */
  fsImpl?: PhysicalWdaStageFsImpl
  /** Cached checkout git revision, recorded into the identity manifest. */
  sourceVersion?: string
  /** Physical safety patches (defaults to PHYSICAL_WDA_DEFAULT_PATCHES). */
  patches?: PhysicalWdaPatchAsset
}

/**
 * Apply the reviewed physical safety patches into a NEW private copy under
 * stateDir/sources/<cacheKey>. Idempotent: a manifest with identical
 * source/patch digests means the stage is already the private patched copy
 * for this exact source + patch set and is reused unchanged. The shared
 * cached source tree is never written to.
 */
export async function stagePhysicalWdaSource(
  sourceDir: string,
  stateDir: string,
  options: StagePhysicalWdaOptions = {},
): Promise<PhysicalWdaPreparedSource> {
  const fns = options.fsImpl ?? DEFAULT_FS
  const patches = options.patches ?? PHYSICAL_WDA_DEFAULT_PATCHES
  const sourceRoot = resolve(sourceDir)
  const stateRoot = resolve(stateDir)
  if (sourceRoot === stateRoot || relative(sourceRoot, stateRoot) === '' || (!relative(sourceRoot, stateRoot).startsWith('..' + '/'))) {
    throw new PhysicalWdaStageError('PATCH_FAILED', 'physical WDA source and private staging roots must be isolated')
  }
  await assertNoSymlinkPath(sourceRoot, fns)
  await assertNoSymlinkPath(stateRoot, fns)
  if (!existsSync(join(sourceRoot, 'WebDriverAgent.xcodeproj'))) {
    throw new PhysicalWdaStageError('UNSUPPORTED', 'cached WDA source is missing WebDriverAgent.xcodeproj')
  }
  if (!existsSync(join(sourceRoot, 'LICENSE'))) {
    throw new PhysicalWdaStageError('UNSUPPORTED', 'cached WDA source is missing its license/attribution file')
  }

  const sourceDigest = await hashSafeTree(sourceRoot, fns)
  const patchDigest = sha256Text(JSON.stringify(patches.patches))
  const cacheKey = options.cacheKey ?? 'physical-wda-' + sourceDigest.slice(0, 16) + '-' + patchDigest.slice(0, 16)
  const canonicalDir = join(stateRoot, 'sources', safeSegment(cacheKey))
  return withStageLock(stateRoot, fns, async () => {
    const manifestPath = join(canonicalDir, PHYSICAL_WDA_STAGE_MANIFEST_FILE)
    let canonicalOccupied = false
    try {
      const stageInfo = await fns.lstat(canonicalDir)
      canonicalOccupied = true
      if (stageInfo.isSymbolicLink()) throw new PhysicalWdaStageError('PATCH_FAILED', 'staged WDA path must not be a symlink')
      if (stageInfo.isDirectory()) {
        const existing = JSON.parse(await fns.readFile(manifestPath, 'utf8')) as PhysicalWdaStageManifest
        if (existing.schema === 1 && existing.sourceDigest === sourceDigest && existing.patchDigest === patchDigest && typeof existing.stagedDigest === 'string') {
          const actualDigest = await verifyPatchedTree(canonicalDir, patches, fns)
          if (actualDigest === existing.stagedDigest) return { stageDir: canonicalDir, manifest: existing, sourceVersion: options.sourceVersion ?? existing.sourceVersion }
        }
      }
    } catch (error) {
      if (error instanceof PhysicalWdaStageError && error.message === 'staged WDA path must not be a symlink') throw error
      // A malformed/incomplete cache is never returned. Build beside it and
      // leave it intact in case another process still has it open.
    }

    const nonce = safeSegment(`${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const tempDir = join(stateRoot, 'tmp', `stage-${nonce}`)
    const publishedDir = canonicalOccupied ? join(stateRoot, 'sources', `${safeSegment(cacheKey)}-${nonce}`) : canonicalDir
    await fns.mkdir(tempDir, { recursive: true })
    try {
      await copyTree(sourceRoot, tempDir, fns)
      for (const patch of patches.patches) {
        assertSafePatchPath(patch.file)
        const file = join(tempDir, ...patch.file.split('/'))
        const content = await fns.readFile(file, 'utf8')
        const parts = content.split(patch.oldText)
        const occurrences = parts.length - 1
        if (occurrences === 0 || (patch.count !== undefined && occurrences !== patch.count)) throw new PhysicalWdaStageError('PATCH_FAILED', 'physical safety patch anchor mismatch in ' + patch.file + ' (' + patch.id + ')')
        await fns.writeFile(file, parts.join(patch.newText), 'utf8')
      }
      const stagedDigest = await verifyPatchedTree(tempDir, patches, fns)
      const manifest: PhysicalWdaStageManifest = {
    schema: 1,
    owner: PHYSICAL_WDA_RUNTIME_OWNER_ID,
    originalSourceDir: sourceRoot,
    ...(options.sourceVersion === undefined ? {} : { sourceVersion: options.sourceVersion }),
    sourceDigest,
    patchDigest,
    patches: patches.patches.map(patch => ({ id: patch.id, file: patch.file, applied: true })),
        stagedDigest,
        stagedAt: new Date().toISOString(),
        cacheKey,
      }
      await fns.writeFile(join(tempDir, PHYSICAL_WDA_STAGE_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8')
      await fns.mkdir(join(stateRoot, 'sources'), { recursive: true })
      await fns.rename(tempDir, publishedDir)
      return { stageDir: publishedDir, manifest, sourceVersion: options.sourceVersion }
    } finally {
      await fns.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}

export interface ResolvePhysicalWdaProjectOptions {
  /** Shared cached checkout (defaults to ~/Library/Caches/dsh-ios/wda/src). */
  sourceDir?: string
  /** Private staging state root (defaults to ~/Library/Caches/dsh-ios/wda-physical-safe). */
  stateDir?: string
  /** Assets directory containing qa-wda-physical/safety-patches.json (optional). */
  qaAssetsDir?: string
  /** @internal Test seam: execFile for the optional git head read. */
  execFileFn?: typeof execFile
  /** @internal Test seam: injectable filesystem. */
  fsImpl?: PhysicalWdaStageFsImpl
}

/**
 * Resolve the DEFAULT physical WDA project directory for the QA backend:
 * the shared cached checkout staged into a private safety-patched copy.
 * Never modifies the shared cache. Missing prerequisites fail with an honest
 * UNSUPPORTED error naming the cache location.
 */
export async function resolvePhysicalWdaProjectDir(
  options: ResolvePhysicalWdaProjectOptions = {},
): Promise<PhysicalWdaPreparedSource> {
  const sourceRoot = resolve(options.sourceDir ?? defaultPhysicalWdaSourceDir())
  const stateRoot = resolve(options.stateDir ?? defaultPhysicalWdaStateDir())
  if (!existsSync(join(sourceRoot, 'WebDriverAgent.xcodeproj')) || !existsSync(join(sourceRoot, 'LICENSE'))) {
    throw new PhysicalWdaStageError(
      'UNSUPPORTED',
      'the shared cached WebDriverAgent checkout is missing at ' + sourceRoot
        + ' — clone WebDriverAgent into the dsh-ios WDA cache first or provide wdaOptions.projectDir',
    )
  }
  const patches = await loadPhysicalPatchAsset(options.qaAssetsDir)
  const sourceVersion = await gitHead(sourceRoot, options.execFileFn ?? execFile)
  return stagePhysicalWdaSource(sourceRoot, stateRoot, {
    patches,
    ...(options.fsImpl === undefined ? {} : { fsImpl: options.fsImpl }),
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
  })
}
