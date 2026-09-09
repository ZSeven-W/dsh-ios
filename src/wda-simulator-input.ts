/**
 * SAFE WebDriverAgent (WDA) simulator input runtime.
 *
 * This module owns only the *host runtime* needed to prove that WDA can later
 * type into simulator elements:
 * - private per-UDID leases (in-process map + filesystem lockfiles),
 * - a deterministic private copy of the cached WDA source with reviewed
 *   safety patches (HTTP always bound to 127.0.0.1, MJPEG broadcaster not
 *   started), never a mutation of the user's cached checkout,
 * - keyed xcodebuild caches and the proven `simctl spawn --run-as-tool`
 *   launch path, no shared runner installation,
 * - one fresh loopback port and no adoption of unrelated servers,
 * - a tiny loopback-only HTTP client whose errors carry dispatch
 *   uncertainty instead of body/text/secret echoes and which never retries
 *   requests automatically.
 *
 * It deliberately does NOT create app sessions, find elements, or type text;
 * that is owned by the next worker. This module is host-free (no DSH host
 * imports), safe to import without a simulator attached, and safe to compile
 * in CI.
 *
 * @module @zseven-w/dsh-ios/wda-simulator-input
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Loopback host WDA is always allowed to use. */
export const WDA_SIMULATOR_LOOPBACK = '127.0.0.1'

/** Stable component that owns lockfiles/leases created by this module. */
export const RUNTIME_OWNER_ID = 'dsh-ios-wda-simulator-input'

/** Error category used by this module. */
export type SimulatorWdaInputErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED'
  | 'PATCH_FAILED'
  | 'BUSY'
  | 'DISPOSED'
  | 'STARTUP_FAILED'
  | 'CANCELLED'
  | 'TOOL_FAILED'
  | 'REQUEST_FAILED'
  | 'INTERNAL'

export class SimulatorWdaInputError extends Error {
  readonly code: SimulatorWdaInputErrorCode
  constructor(code: SimulatorWdaInputErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SimulatorWdaInputError'
    this.code = code
  }
}

/** Typed transport error. `mayHaveDispatched` preserves mutation uncertainty. */
export class SimulatorWdaInputTransportError extends Error {
  readonly mayHaveDispatched: boolean
  constructor(message: string, mayHaveDispatched: boolean, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SimulatorWdaInputTransportError'
    this.mayHaveDispatched = mayHaveDispatched
  }
}

export interface WdaSimulatorHttpResponse {
  readonly statusCode: number
  /** JSON-decoded body; a non-JSON response body is returned as its text. */
  readonly body: unknown
}

export interface WdaSimulatorRequestOptions {
  signal?: AbortSignal
}

export interface WdaSimulatorConnection {
  readonly udid: string
  readonly generation: number
  /** Actual verified WDA runner process id (not the simctl wrapper). */
  readonly pid: number
  readonly port: number
  /**
   * One-shot loopback-only request. Never auto-retries any request.
   * Rejects stale/releasing/dead connections before any network I/O.
   */
  request(
    method: string,
    path: string,
    body?: unknown,
    options?: WdaSimulatorRequestOptions,
  ): Promise<WdaSimulatorHttpResponse>
}

export interface SimulatorWdaInputRuntimeOptions {
  /** Cached WDA checkout. Defaults to ~/Library/Caches/dsh-ios/wda/src. */
  wdaSourceDir?: string
  /**
   * Private state root. Defaults to ~/Library/Caches/dsh-ios/wda-simulator-input.
   * The module never uses this root for global kills or whole-cache deletes.
   */
  stateDir?: string
  /**
   * Directory containing qa-wda-simulator support assets. When omitted the
   * built-in patch definitions are used; asset files are still documented for
   * reviewers.
   */
  qaAssetsDir?: string
  /** Xcode Developer dir; derived from xcode-select when omitted. */
  xcodeDeveloperDir?: string
  /** iphonesimulator SDK root; derived through xcrun when omitted. */
  sdkRoot?: string
  /** SDK version; derived through xcrun when omitted. */
  sdkVersion?: string
  /** Architecture used for the build cache key (defaults to process arch). */
  arch?: string
  /** Start of the preferred private port search range. */
  portStart?: number
  /** End of the preferred private port search range (exclusive). */
  portEnd?: number
  /** Startup timeout after spawn, including WDA /status readiness. */
  startupTimeoutMs?: number
  /** Poll interval while waiting for ServerURLHere. */
  startupPollMs?: number
  /** Per-request timeout when no caller signal is supplied. */
  requestTimeoutMs?: number
  /** @internal Test seam: monotonic clock. */
  now?: () => number
  /** @internal Test seam: random nonce source. */
  randomNonce?: () => string
  /** @internal Test seam: process id used in lease ownership. */
  hostPid?: number
  /** @internal Test seam: execFile for xcode-select/xcrun/lsof. */
  execFileFn?: typeof execFile
  /** @internal Test seam: spawn used for xcodebuild/simctl. */
  spawnFn?: typeof spawn
  /** @internal Test seam: returns a fresh free loopback port. */
  pickPort?: () => Promise<number>
  /** @internal Test seam: returns a fresh free loopback port. */
  freePortFn?: () => Promise<number>
  /** @internal Test seam: check whether a process id exists (defaults to kill(pid,0)). */
  processExists?: (pid: number) => boolean
  /** @internal Test seam: lsof/runner listener verification; override for fake runs. */
  verifyListener?: (
    port: number,
    expected: ReadonlySet<number>,
    options: { execFileFn?: typeof execFile; developerDir?: string },
  ) => Promise<boolean>
  /** @internal Test seam: reads a process command/executable for ownership proof. */
  readProcessIdentity?: (pid: number) => Promise<string | undefined>
  /** @internal Test seam: signal a process by pid (defaults to process.kill). */
  signalProcess?: (pid: number, signal: NodeJS.Signals) => boolean
  /** @internal Test seam: request used for health/status probe. */
  requestFn?: typeof localHttpRequest
}

export interface SimulatorWdaInputRuntime {
  ensure(udid: string, options?: WdaSimulatorEnsureOptions): Promise<WdaSimulatorConnection>
  release(udid: string): Promise<void>
  dispose(): Promise<void>
}

export interface WdaSimulatorEnsureOptions {
  signal?: AbortSignal
}

interface PatchDefinition {
  id: string
  file: string
  /** Exact old text; absent means fail because source is unsupported. */
  oldText: string
  newText: string
  count?: number
}

export interface SafetyPatchAsset {
  schema: number
  owner: typeof RUNTIME_OWNER_ID
  description: string
  patches: PatchDefinition[]
}
const DEFAULT_PATCHES: SafetyPatchAsset = {
  schema: 1,
  owner: RUNTIME_OWNER_ID,
  description: 'Deterministic safety-only modifications for cached WebDriverAgent simulator input. Original license/attribution files are copied unchanged.',
  patches: [
    {
      id: 'bindingIPAddress-unconditional-loopback',
      file: 'WebDriverAgentLib/Utilities/FBConfiguration.m',
      oldText: `- (NSString *)bindingIPAddress
{
  // Existence of USE_IP in the environment allows specifying which interface to bind to
  if (NSProcessInfo.processInfo.environment[@"USE_IP"] &&
      [NSProcessInfo.processInfo.environment[@"USE_IP"] length] > 0) {
    return NSProcessInfo.processInfo.environment[@"USE_IP"];
  }

  return nil;
}`,
      newText: `- (NSString *)bindingIPAddress
{
  // SAFE dsh-ios simulator input: HTTP must always bind to loopback.
  // Environment cannot disable this safety patch.
  return @"127.0.0.1";
}`,
      count: 1,
    },
    {
      id: 'mjpeg-broadcaster-not-started',
      file: 'WebDriverAgentLib/Routing/FBWebServer.m',
      oldText: `  [self initScreenshotsBroadcaster];

  self.keepAlive = YES;`,
      newText: `  // SAFE dsh-ios simulator input: the MJPEG broadcaster is intentionally
  // never started. This prevents the wildcard IPv6 listener seen in the
  // exploratory prototype.
  // [self initScreenshotsBroadcaster];

  self.keepAlive = YES;`,
      count: 1,
    },
  ],
}

interface StagedSourceManifest {
  schema: number
  owner: string
  originalSourceDir: string
  sourceVersion?: string
  sourceDigest: string
  patchDigest: string
  patches: Array<{ id: string; file: string; applied: boolean }>
  stagedAt: string
  buildCacheKey: string
}

interface PreparedToolchain {
  developerDir: string
  sdkRoot: string
  sdkVersion: string
  arch: string
  xcodebuild: string
  xcrun: string
}

interface PreparedSource {
  stageDir: string
  manifest: StagedSourceManifest
  sourceVersion?: string
}

interface BuiltProduct {
  derivedDataDir: string
  runnerAppDir: string
  runnerExecutable: string
  testBundlePath: string
  toolchain: PreparedToolchain
  source: PreparedSource
  cacheKey: string
}

interface OwnedRun {
  udid: string
  generation: number
  runId: string
  runDir: string
  nonce: string
  /** The launcher ChildProcess (`xcrun simctl spawn ...`), not the runner. */
  child: ChildProcess
  /** Launcher host pid. */
  launcherPid: number
  /** Launcher executable/command path used for ownership checks. */
  launcherExecutable: string
  /** Verified actual WDA runner pid parsed from ServerURLHere. */
  runnerPid: number
  /** Verified runner executable path used for ownership checks. */
  runnerExecutable: string
  port: number
  lockPath: string
  lockState: RuntimeLockState
  envDigest: string
  startedAt: number
  ready: boolean
  /** Set as soon as cleanup starts; blocks stale connection requests. */
  releasing: boolean
  /** Set if the launcher exits spontaneously; blocks stale connection requests. */
  dead: boolean
  /** Aborts in-flight connection requests when release/dispose starts. */
  abortController: AbortController
  /** Shared cleanup promise so concurrent release callers observe one result. */
  cleanupPromise?: Promise<boolean>
}

interface RuntimeLease {
  udid: string
  generation: number
  run: OwnedRun
}

interface LaunchOutcome {
  child: ChildProcess
  launcherPid: number
  launcherExecutable: string
  runnerPid: number
  runnerExecutable: string
  port: number
}

/** Bytes retained per stream while waiting for the WDA startup marker. */
class BoundedTextBuffer {
  private readonly maxBytes: number
  private chunks: Buffer[] = []
  private bytes = 0

  constructor(maxBytes: number = MAX_STARTUP_LOG_BYTES) {
    this.maxBytes = maxBytes
  }

  push(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    if (buffer.length === 0) return
    this.chunks.push(buffer)
    this.bytes += buffer.length
    while (this.chunks.length > 0 && this.bytes > this.maxBytes) {
      const removed = this.chunks.shift()
      if (removed !== undefined) this.bytes -= removed.length
    }
  }

  clear(): void {
    this.chunks = []
    this.bytes = 0
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

type ReadonlyExecFile = typeof execFile

const DEFAULT_PORT_START = 1024
const DEFAULT_PORT_END = 65536
const DEFAULT_STARTUP_TIMEOUT_MS = 180_000
const DEFAULT_STARTUP_POLL_MS = 250
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_STARTUP_LOG_BYTES = 128 * 1024
const CLEANUP_WAIT_MS = 5_000
const CLEANUP_POLL_MS = 50

/** Marker used in startup text; exported for tests. */
export const SERVER_URL_MARKER = 'ServerURLHere->http://127.0.0.1:'

/** Pure validator for request paths. */
export function assertSafeRequestPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path[0] !== '/') {
    throw new SimulatorWdaInputError('INVALID_ARGUMENT', 'WDA request path must be an absolute path starting with "/"')
  }
  if (path.startsWith('//')) {
    throw new SimulatorWdaInputError('INVALID_ARGUMENT', 'protocol-relative WDA request paths are rejected')
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
    throw new SimulatorWdaInputError('INVALID_ARGUMENT', 'absolute WDA request URLs are rejected')
  }
  if (path.includes('\\')) {
    throw new SimulatorWdaInputError('INVALID_ARGUMENT', 'backslash request paths are rejected')
  }
  return path
}

/** Validate UDIDs and prevent path traversal. */
export function assertSafeUdid(udid: string): string {
  if (typeof udid !== 'string' || udid.length === 0) {
    throw new SimulatorWdaInputError('INVALID_ARGUMENT', 'UDID is required')
  }
  if (!/^[A-Za-z0-9-]{8,128}$/.test(udid)) {
    throw new SimulatorWdaInputError('INVALID_ARGUMENT', 'UDID must contain only ASCII letters, digits, and hyphens')
  }
  return udid
}

function defaultStateDir(): string {
  return join(homedir(), 'Library', 'Caches', 'dsh-ios', 'wda-simulator-input')
}

function defaultSourceDir(): string {
  return join(homedir(), 'Library', 'Caches', 'dsh-ios', 'wda', 'src')
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Recursively hash a source tree. This is intentionally not a git dependency:
 * a clean copy in another CI machine still gets deterministic cache keys.
 * Hidden `.git`, `DerivedData`, and node_modules are excluded.
 */
export async function hashSourceTree(
  sourceDir: string,
  fsImpl?: {
    readdir: typeof readdir
    stat: typeof stat
    readFile: typeof readFile
  },
): Promise<string> {
  const rd = fsImpl?.readdir ?? readdir
  const st = fsImpl?.stat ?? stat
  const rf = fsImpl?.readFile ?? readFile
  const hash = createHash('sha256')
  async function walk(dir: string): Promise<void> {
    const entries = (await rd(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'DerivedData' || entry.name === 'node_modules' || entry.name === '.DS_Store') {
        continue
      }
      const full = join(dir, entry.name)
      const info = await st(full)
      if (info.isDirectory()) {
        hash.update('D\0').update(entry.name).update('\0')
        await walk(full)
      } else if (info.isFile()) {
        hash.update('F\0').update(full.slice(sourceDir.length + 1)).update('\0')
        hash.update(await rf(full))
        hash.update('\0')
      }
    }
  }
  await walk(resolve(sourceDir))
  return hash.digest('hex')
}

async function gitHead(sourceDir: string, execFileFn?: ReadonlyExecFile): Promise<string | undefined> {
  try {
    const runner = execFileFn ?? execFile
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
      runner('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { timeout: 5_000, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) reject(error)
        else resolvePromise({ stdout, stderr })
      })
    })
    const line = stdout.trim()
    return line.length > 0 ? line : undefined
  } catch {
    return undefined
  }
}

/** Parse and validate a patch asset JSON (used at runtime and in tests). */
export function parsePatchAsset(input: unknown): SafetyPatchAsset {
  if (typeof input !== 'object' || input === null) {
    throw new SimulatorWdaInputError('PATCH_FAILED', 'safety patch asset must be an object')
  }
  const value = input as Record<string, unknown>
  if (value.schema !== 1 || value.owner !== RUNTIME_OWNER_ID || !Array.isArray(value.patches)) {
    throw new SimulatorWdaInputError('PATCH_FAILED', 'unsupported safety patch asset')
  }
  const patches = value.patches.map(item => {
    if (typeof item !== 'object' || item === null) {
      throw new SimulatorWdaInputError('PATCH_FAILED', 'unsupported safety patch entry')
    }
    const p = item as Record<string, unknown>
    if (typeof p.id !== 'string' || typeof p.file !== 'string' || typeof p.oldText !== 'string' || typeof p.newText !== 'string') {
      throw new SimulatorWdaInputError('PATCH_FAILED', 'safety patch entry is missing required strings')
    }
    if (p.count !== undefined && typeof p.count !== 'number') {
      throw new SimulatorWdaInputError('PATCH_FAILED', 'safety patch count must be a number')
    }
    return {
      id: p.id,
      file: p.file,
      oldText: p.oldText,
      newText: p.newText,
      count: typeof p.count === 'number' ? p.count : undefined,
    }
  })
  if (patches.length === 0) {
    throw new SimulatorWdaInputError('PATCH_FAILED', 'safety patch asset has no patches')
  }
  return { schema: 1, owner: RUNTIME_OWNER_ID, description: '', patches }
}

async function loadPatchAsset(qaAssetsDir?: string): Promise<SafetyPatchAsset> {
  if (qaAssetsDir !== undefined && qaAssetsDir.length > 0) {
    const assetFile = join(qaAssetsDir, 'safety-patches.json')
    try {
      const raw = await readFile(assetFile, 'utf8')
      return parsePatchAsset(JSON.parse(raw))
    } catch (error) {
      throw new SimulatorWdaInputError('PATCH_FAILED', `unable to load safety patch asset: ${error instanceof Error ? error.message : 'parse error'}`, { cause: error })
    }
  }
  return DEFAULT_PATCHES
}

/**
 * Apply reviewed safety patches into a NEW private copy.
 * Returns a manifest that is also written inside the stage.
 */
export async function stagePatchedSource(
  sourceDir: string,
  stateDir: string,
  patches: SafetyPatchAsset = DEFAULT_PATCHES,
  options: {
    cacheKey?: string
    fsImpl?: {
      readdir: typeof readdir
      stat: typeof stat
      readFile: typeof readFile
      writeFile: typeof writeFile
      mkdir: typeof mkdir
      rm: typeof rm
    }
    qaAssetsDir?: string
    sourceVersion?: string
  } = {},
): Promise<PreparedSource> {
  const fsImpl = options.fsImpl ?? { readdir, stat, readFile, writeFile, mkdir, rm }
  const sourceRoot = resolve(sourceDir)
  if (!existsSync(join(sourceRoot, 'WebDriverAgent.xcodeproj'))) {
    throw new SimulatorWdaInputError('UNSUPPORTED', 'cached WDA source is missing WebDriverAgent.xcodeproj')
  }
  if (!existsSync(join(sourceRoot, 'LICENSE'))) {
    throw new SimulatorWdaInputError('UNSUPPORTED', 'cached WDA source is missing its license/attribution file')
  }

  const sourceDigest = await hashSourceTree(sourceRoot, {
    readdir: fsImpl.readdir,
    stat: fsImpl.stat,
    readFile: fsImpl.readFile,
  })
  const patchDigest = sha256Text(JSON.stringify(patches.patches))
  const cacheKey = options.cacheKey ?? `wda-${sourceDigest.slice(0, 16)}-${patchDigest.slice(0, 16)}`
  const stageDir = join(stateDir, 'sources', safeSegment(cacheKey))

  // Stage is idempotent. A manifest with identical digests means it is already
  // the private patched copy for this exact source + patch set.
  const manifestPath = join(stageDir, 'dsh-wda-simulator-stage.json')
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(await fsImpl.readFile(manifestPath, 'utf8')) as StagedSourceManifest
    if (existing.schema === 1 && existing.sourceDigest === sourceDigest && existing.patchDigest === patchDigest) {
      return { stageDir, manifest: existing, sourceVersion: options.sourceVersion ?? existing.sourceVersion }
    }
  }

  await fsImpl.rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
  await fsImpl.mkdir(stageDir, { recursive: true })

  // Copy the whole source tree (excluding .git and bulky generated dirs).
  await copyTree(sourceRoot, stageDir, {
    readdir: fsImpl.readdir,
    stat: fsImpl.stat,
    readFile: fsImpl.readFile,
    writeFile: fsImpl.writeFile,
    mkdir: fsImpl.mkdir,
    rm: fsImpl.rm,
  })

  for (const patch of patches.patches) {
    const file = join(stageDir, ...patch.file.split('/'))
    const content = await fsImpl.readFile(file, 'utf8')
    const parts = content.split(patch.oldText)
    const occurrences = parts.length - 1
    if (occurrences === 0) {
      throw new SimulatorWdaInputError('PATCH_FAILED', `safety patch anchor not found in ${patch.file} (${patch.id})`)
    }
    if (patch.count !== undefined && occurrences !== patch.count) {
      throw new SimulatorWdaInputError('PATCH_FAILED', `safety patch anchor count mismatch in ${patch.file} (${patch.id})`)
    }
    await fsImpl.writeFile(file, parts.join(patch.newText), 'utf8')
  }

  const manifest: StagedSourceManifest = {
    schema: 1,
    owner: RUNTIME_OWNER_ID,
    originalSourceDir: sourceRoot,
    sourceVersion: options.sourceVersion,
    sourceDigest,
    patchDigest,
    patches: patches.patches.map(patch => ({ id: patch.id, file: patch.file, applied: true })),
    stagedAt: new Date().toISOString(),
    buildCacheKey: cacheKey,
  }
  await fsImpl.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  return { stageDir, manifest, sourceVersion: options.sourceVersion }
}

async function copyTree(
  src: string,
  dest: string,
  fns: {
    readdir: typeof readdir
    stat: typeof stat
    readFile: typeof readFile
    writeFile: typeof writeFile
    mkdir: typeof mkdir
    rm: typeof rm
  },
): Promise<void> {
  const entries = await fns.readdir(src, { withFileTypes: true })
  await fns.mkdir(dest, { recursive: true })
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'DerivedData' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue
    const sourcePath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    const info = await fns.stat(sourcePath)
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

async function readExecFileOutput(
  execFileFn: ReadonlyExecFile,
  file: string,
  args: readonly string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFileFn(file, [...args], { timeout: options.timeout ?? 15_000, encoding: 'utf8', env: options.env, cwd: options.cwd }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? '').trim() || String(stdout ?? '').trim()
        reject(new SimulatorWdaInputError('TOOL_FAILED', `${file} ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`, { cause: error }))
        return
      }
      resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

async function resolveToolchain(
  options: SimulatorWdaInputRuntimeOptions,
): Promise<PreparedToolchain> {
  const execFileFn = options.execFileFn ?? execFile
  const arch = options.arch ?? (process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : process.arch)
  const developerDir = options.xcodeDeveloperDir ?? (await readExecFileOutput(execFileFn, 'xcode-select', ['-p'], {})).stdout.trim()
  const xcodebuild = join(developerDir, 'usr', 'bin', 'xcodebuild')
  const xcrun = '/usr/bin/xcrun'
  const sdkRoot = options.sdkRoot ?? (await readExecFileOutput(execFileFn, 'xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { env: { DEVELOPER_DIR: developerDir } })).stdout.trim()
  const sdkVersion = options.sdkVersion ?? (await readExecFileOutput(execFileFn, 'xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], { env: { DEVELOPER_DIR: developerDir } })).stdout.trim()
  const platformDir = join(developerDir, 'Platforms', 'iPhoneSimulator.platform')
  const required = [
    join(developerDir, 'usr', 'bin', 'xcodebuild'),
    join(platformDir, 'Developer', 'Library', 'Frameworks'),
    join(platformDir, 'Developer', 'Library', 'PrivateFrameworks'),
    join(platformDir, 'Developer', 'usr', 'lib'),
    join(sdkRoot, 'Developer', 'Library', 'Frameworks'),
  ]
  for (const path of required) {
    if (!existsSync(path)) {
      throw new SimulatorWdaInputError('UNSUPPORTED', `missing required Xcode/simulator path: ${path}`)
    }
  }
  return { developerDir, sdkRoot, sdkVersion, arch, xcodebuild, xcrun }
}

/** Build cache key after the source has been staged. */
export async function buildCacheKey(parts: {
  sourceDigest: string
  patchDigest: string
  sdkVersion: string
  arch: string
}): Promise<string> {
  return sha256Text(`${parts.sourceDigest}|${parts.patchDigest}|${parts.sdkVersion}|${parts.arch}`).slice(0, 40)
}

/** Pick a fresh loopback port by binding to port 0 and closing. */
export async function pickFreeLoopbackPort(
  rangeStart = DEFAULT_PORT_START,
  rangeEnd = DEFAULT_PORT_END,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, WDA_SIMULATOR_LOOPBACK, () => {
      const address = server.address()
      if (address === null || typeof address === 'string' || address.port < rangeStart || address.port >= rangeEnd) {
        server.close(() => reject(new SimulatorWdaInputError('TOOL_FAILED', `unable to obtain a port in ${rangeStart}..${rangeEnd - 1}`)))
        return
      }
      const port = address.port
      server.close(() => resolvePromise(port))
    })
  })
}

async function findSourceVersion(sourceDir: string, execFileFn?: ReadonlyExecFile): Promise<string | undefined> {
  if (!existsSync(join(sourceDir, '.git'))) return undefined
  return gitHead(sourceDir, execFileFn)
}

/** Parse WDA's startup log line into the runner's simulator/host-side pid. */
export function parseRunnerPidFromLog(line: string): number | undefined {
  const match = /WebDriverAgentRunner-Runner\[(\d+):/.exec(line)
  return match === null ? undefined : Number(match[1])
}

/** True when a log chunk contains the exact loopback ServerURL marker. */
export function findServerReady(
  text: string,
  expectedPort: number,
): { port: number; pid?: number; line?: string } | undefined {
  const needle = `ServerURLHere->http://${WDA_SIMULATOR_LOOPBACK}:${expectedPort}<-ServerURLHere`
  if (!text.includes(needle)) return undefined
  const index = text.indexOf(needle)
  const lineStart = Math.max(0, text.lastIndexOf('\n', index) + 1)
  const lineEnd = text.indexOf('\n', index)
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
  return { port: expectedPort, pid: parseRunnerPidFromLog(line), line }
}

function sanitizeRuntimeEnv(
  developerDir: string,
  sdkRoot: string,
  run: { udid: string; nonce: string; port: number; runnerAppDir: string; platformDir: string },
): NodeJS.ProcessEnv {
  const appFrameworks = join(run.runnerAppDir, 'Frameworks')
  const sdkDeveloperFrameworks = join(sdkRoot, 'Developer', 'Library', 'Frameworks')
  const platformDeveloperFrameworks = join(run.platformDir, 'Developer', 'Library', 'Frameworks')
  const platformDeveloperPrivateFrameworks = join(run.platformDir, 'Developer', 'Library', 'PrivateFrameworks')
  const platformDeveloperUsrLib = join(run.platformDir, 'Developer', 'usr', 'lib')
  const frameworkPath = [
    appFrameworks,
    platformDeveloperFrameworks,
    platformDeveloperPrivateFrameworks,
    sdkDeveloperFrameworks,
  ].join(':')
  const libraryPath = [
    appFrameworks,
    platformDeveloperUsrLib,
  ].join(':')
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? homedir(),
    TMPDIR: process.env.TMPDIR ?? join(homedir(), 'Library', 'Caches'),
    DEVELOPER_DIR: developerDir,
    SIMCTL_CHILD_USE_IP: WDA_SIMULATOR_LOOPBACK,
    SIMCTL_CHILD_USE_PORT: String(run.port),
    SIMCTL_CHILD_DSH_WDA_SIMULATOR_INPUT_RUN_ID: run.nonce,
    SIMCTL_CHILD_DYLD_FRAMEWORK_PATH: frameworkPath,
    SIMCTL_CHILD_DYLD_LIBRARY_PATH: libraryPath,
  }
}

/** Shape persisted in the per-device lease lockfile. */
export interface RuntimeLockState {
  schema: number
  owner: string
  udid: string
  pid: number
  runtimeInstance: string
  nonce: string
  port: number
  runDir: string
  generation: number
  createdAt: string
}

function lockFileFor(stateDir: string, udid: string): string {
  return join(stateDir, 'locks', `${safeSegment(udid)}.lock.json`)
}

async function isProcessAlive(pid: number, processExists?: (pid: number) => boolean): Promise<boolean> {
  if (processExists !== undefined) return processExists(pid)
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function defaultReadProcessIdentity(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await readExecFileOutput(execFile, '/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 3_000 })
    const command = stdout.trim()
    return command.length === 0 ? undefined : command
  } catch {
    return undefined
  }
}

function defaultSignalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * Returns true only when a live process command is readable and contains the
 * expected executable path. This is the gate before signaling any pid that is
 * not represented by a ChildProcess in this runtime.
 */
async function processCommandMatches(
  pid: number,
  expectedPath: string | undefined,
  readProcessIdentity?: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || expectedPath === undefined || expectedPath.length === 0) return false
  const command = await (readProcessIdentity ?? defaultReadProcessIdentity)(pid)
  return typeof command === 'string' && command.includes(expectedPath)
}

/**
 * Keep only bounded, printable startup diagnostics. This deliberately excludes
 * later user-typed values because this module writes it only before any
 * request/user text can be sent.
 */
function sanitizeStartupDiagnostics(text: string): string {
  const cleaned = text
    .replace(/\0/g, '?')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?')
  const max = MAX_STARTUP_LOG_BYTES
  return cleaned.length > max ? cleaned.slice(-max) : cleaned
}

async function persistStartupDiagnostics(
  stateDir: string,
  runId: string,
  text: string,
): Promise<string | undefined> {
  try {
    const diagnosticsDir = join(stateDir, 'diagnostics')
    await mkdir(diagnosticsDir, { recursive: true })
    const file = join(diagnosticsDir, `${safeSegment(runId)}.startup.log`)
    await writeFile(file, sanitizeStartupDiagnostics(text), 'utf8')
    return file
  } catch {
    return undefined
  }
}


async function tryAcquireLock(
  lockPath: string,
  udid: string,
  options: {
    stateDir: string
    runtimeInstance: string
    pid: number
    nonce: string
    port: number
    runDir: string
    generation: number
    processExists?: (pid: number) => boolean
  },
): Promise<RuntimeLockState> {
  const lockState: RuntimeLockState = {
    schema: 1,
    owner: RUNTIME_OWNER_ID,
    udid,
    pid: options.pid,
    runtimeInstance: options.runtimeInstance,
    nonce: options.nonce,
    port: options.port,
    runDir: options.runDir,
    generation: options.generation,
    createdAt: new Date().toISOString(),
  }
  try {
    const handle = await open(lockPath, 'wx')
    try {
      await handle.writeFile(JSON.stringify(lockState, null, 2), 'utf8')
    } finally {
      await handle.close()
    }
    return lockState
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      let existing: RuntimeLockState | undefined
      try {
        existing = JSON.parse(await readFile(lockPath, 'utf8')) as RuntimeLockState
      } catch {
        existing = undefined
      }
      if (existing !== undefined && existing.schema === 1 && existing.owner === RUNTIME_OWNER_ID) {
        const alive = await isProcessAlive(existing.pid, options.processExists)
        if (alive) {
          throw new SimulatorWdaInputError('BUSY', `a WDA simulator input lease for ${udid} is already held by pid ${existing.pid}`)
        }
      }
      // Stale unknown/crashed owner: do not blind-delete. Surface as busy with
      // a cleanup prerequisite; the user/operator owns that file, not this run.
      throw new SimulatorWdaInputError('BUSY', `WDA simulator input lease path is occupied and needs manual cleanup: ${lockPath}`)
    }
    throw error
  }
}

/** Read a lockfile without treating missing as failure. */
export async function readLockState(lockPath: string): Promise<RuntimeLockState | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8')
    return JSON.parse(raw) as RuntimeLockState
  } catch {
    return undefined
  }
}

async function verifyListener(
  port: number,
  expected: ReadonlySet<number>,
  options: { execFileFn?: typeof execFile; developerDir?: string },
): Promise<boolean> {
  const execFileFn = options.execFileFn ?? execFile
  try {
    const { stdout } = await readExecFileOutput(execFileFn, '/usr/sbin/lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { timeout: 5_000 })
    const lines = stdout.trim().split('\n').slice(1)
    if (lines.length !== 1) return false
    const fields = lines[0].split(/\s+/)
    const pid = Number(fields[1])
    if (!expected.has(pid)) return false
    const address = fields.find(field => field.startsWith(`${WDA_SIMULATOR_LOOPBACK}:${port}`))
    if (address === undefined) return false
    return true
  } catch {
    return false
  }
}

export function localHttpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  options?: WdaSimulatorRequestOptions & { timeoutMs?: number },
): Promise<WdaSimulatorHttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const safePath = assertSafeRequestPath(path)
    const normalizedMethod = String(method ?? '').toUpperCase()
    if (!/^[A-Z]+$/.test(normalizedMethod)) {
      reject(new SimulatorWdaInputError('INVALID_ARGUMENT', 'HTTP method must contain only letters'))
      return
    }
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const signal = options?.signal
    let settled = false
    let dispatched = false
    // Dynamic import keeps the module host-free for importing; Node's request
    // is only needed when a request is actually made.
    void import('node:http').then(({ request }) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
      const req = request(
        {
          hostname: WDA_SIMULATOR_LOOPBACK,
          port,
          method: normalizedMethod,
          path: safePath,
          headers: payload === undefined ? {} : {
            'Content-Type': 'application/json',
            'Content-Length': String(payload.length),
          },
        },
        res => {
          settled = true
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown = text
            if (text.length > 0) {
              try {
                parsed = JSON.parse(text)
              } catch {
                parsed = text
              }
            }
            resolvePromise({ statusCode: res.statusCode ?? 0, body: parsed })
          })
        },
      )
      req.setTimeout(timeoutMs, () => {
        if (!settled) {
          dispatched = true
          req.destroy(new Error('WDA request timed out'))
        }
      })
      signal?.addEventListener('abort', () => {
        if (!settled) {
          dispatched = true
          req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
      }, { once: true })
      req.on('error', error => {
        if (settled) return
        settled = true
        reject(new SimulatorWdaInputTransportError('WDA HTTP transport error', dispatched, { cause: error }))
      })
      req.end(payload)
      dispatched = true
    }).catch(error => {
      reject(new SimulatorWdaInputTransportError('WDA HTTP client unavailable', false, { cause: error }))
    })
  })
}

class RuntimeImpl implements SimulatorWdaInputRuntime {
  readonly options: SimulatorWdaInputRuntimeOptions
  readonly stateDir: string
  readonly sourceDir: string
  readonly runtimeInstance: string
  readonly leases = new Map<string, RuntimeLease>()
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(options: SimulatorWdaInputRuntimeOptions = {}) {
    this.sourceDir = resolve(options.wdaSourceDir ?? defaultSourceDir())
    this.stateDir = resolve(options.stateDir ?? defaultStateDir())
    this.options = {
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      startupPollMs: DEFAULT_STARTUP_POLL_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      portStart: DEFAULT_PORT_START,
      portEnd: DEFAULT_PORT_END,
      ...options,
    }
    this.runtimeInstance = createHash('sha256')
      .update(`${RUNTIME_OWNER_ID}:${options.hostPid ?? process.pid}:${options.randomNonce?.() ?? randomBytes(12).toString('hex')}`)
      .digest('hex')
      .slice(0, 24)
  }

  private ensureNotDisposed(): void {
    if (this.disposed) throw new SimulatorWdaInputError('DISPOSED', 'WDA simulator input runtime has been disposed')
  }

  async ensure(udid: string, options?: WdaSimulatorEnsureOptions): Promise<WdaSimulatorConnection> {
    this.ensureNotDisposed()
    assertSafeUdid(udid)
    const signal = options?.signal
    if (signal?.aborted === true) {
      throw new SimulatorWdaInputError('CANCELLED', 'WDA simulator input ensure was cancelled')
    }

    const existing = this.leases.get(udid)
    if (existing !== undefined && !existing.run.releasing && !existing.run.dead) {
      return this.toConnection(existing)
    }

    const locksDir = join(this.stateDir, 'locks')
    await mkdir(locksDir, { recursive: true })
    const lockPath = lockFileFor(this.stateDir, udid)
    const existingLock = await readLockState(lockPath)
    if (existingLock !== undefined) {
      const alive = await isProcessAlive(existingLock.pid, this.options.processExists)
      if (alive) {
        throw new SimulatorWdaInputError('BUSY', `a WDA simulator input lease for ${udid} is already active (pid ${existingLock.pid})`)
      }
      throw new SimulatorWdaInputError('BUSY', `WDA simulator input lease for ${udid} is stale; cleanup prerequisite remains: ${lockPath}`)
    }

    const patches = await loadPatchAsset(this.options.qaAssetsDir)
    const sourceVersion = await findSourceVersion(this.sourceDir, this.options.execFileFn)
    const source = await stagePatchedSource(this.sourceDir, this.stateDir, patches, {
      sourceVersion,
      qaAssetsDir: this.options.qaAssetsDir,
    })
    const toolchain = await resolveToolchain(this.options)
    const cacheKey = await buildCacheKey({
      sourceDigest: source.manifest.sourceDigest,
      patchDigest: source.manifest.patchDigest,
      sdkVersion: toolchain.sdkVersion,
      arch: toolchain.arch,
    })

    const pickPort = this.options.pickPort ?? this.options.freePortFn ?? pickFreeLoopbackPort
    const port = await pickPort(this.options.portStart, this.options.portEnd)
    const runId = `${safeSegment(udid)}-${this.options.randomNonce?.() ?? randomBytes(8).toString('hex')}`
    const runDir = join(this.stateDir, 'runs', safeSegment(udid), runId)
    await mkdir(runDir, { recursive: true })
    const generation = this.generationFor(udid)
    const nonce = this.options.randomNonce?.() ?? randomBytes(8).toString('hex')
    const envDigest = sha256Text(`${nonce}:${udid}:${port}:${generation}`)

    const lockState = await tryAcquireLock(lockPath, udid, {
      stateDir: this.stateDir,
      runtimeInstance: this.runtimeInstance,
      pid: this.options.hostPid ?? process.pid,
      nonce,
      port,
      runDir,
      generation,
      processExists: this.options.processExists,
    })

    const outcome = await this.launchBuiltRunner(
      udid,
      runDir,
      runId,
      nonce,
      port,
      generation,
      signal,
      source,
      toolchain,
      cacheKey,
      lockPath,
      lockState,
    )

    const abortController = new AbortController()
    const run: OwnedRun = {
      udid,
      generation,
      runId,
      runDir,
      nonce,
      child: outcome.child,
      launcherPid: outcome.launcherPid,
      launcherExecutable: outcome.launcherExecutable,
      runnerPid: outcome.runnerPid,
      runnerExecutable: outcome.runnerExecutable,
      port,
      lockPath,
      lockState,
      envDigest,
      startedAt: this.now(),
      ready: true,
      releasing: false,
      dead: false,
      abortController,
    }
    const lease: RuntimeLease = { udid, generation, run }
    // Keep stale connections from sending to a reused port after the launcher
    // exits on its own.
    run.child.once('exit', () => {
      run.dead = true
    })
    this.leases.set(udid, lease)

    // The launcher's stdout/stderr are pipes that were drained while waiting
    // for ServerURLHere. From this point on all vendor output is intentionally
    // discarded from the parent: no buffers are retained and no files append it.
    run.child.stdout?.removeAllListeners('data')
    run.child.stderr?.removeAllListeners('data')
    run.child.stdout?.resume()
    run.child.stderr?.resume()
    return this.toConnection(lease)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private generationFor(udid: string): number {
    const current = this.leases.get(udid)
    return current === undefined ? 1 : current.generation + 1
  }

  private toConnection(lease: RuntimeLease): WdaSimulatorConnection {
    const udid = lease.udid
    const generation = lease.generation
    return {
      udid,
      generation,
      pid: lease.run.runnerPid,
      port: lease.run.port,
      request: async (method, path, body, options) => {
        this.ensureConnectionActive(udid, generation)
        const run = this.leases.get(udid)?.run
        if (run === undefined || run.releasing || run.dead || !run.ready) {
          throw new SimulatorWdaInputError('DISPOSED', 'WDA simulator connection is no longer active')
        }
        const callerSignal = options?.signal
        const combined = new AbortController()
        const forwardRunAbort = () => combined.abort(run.abortController.signal.reason)
        run.abortController.signal.addEventListener('abort', forwardRunAbort, { once: true })
        let forwardCallerAbort: (() => void) | undefined
        if (callerSignal !== undefined) {
          forwardCallerAbort = () => combined.abort(callerSignal.reason)
          if (callerSignal.aborted) combined.abort(callerSignal.reason)
          else callerSignal.addEventListener('abort', forwardCallerAbort, { once: true })
        }
        try {
          const requestImpl = this.options.requestFn ?? localHttpRequest
          return await requestImpl(run.port, method, path, body, { ...options, signal: combined.signal })
        } finally {
          run.abortController.signal.removeEventListener('abort', forwardRunAbort)
          if (forwardCallerAbort !== undefined && callerSignal !== undefined) {
            callerSignal.removeEventListener('abort', forwardCallerAbort)
          }
        }
      },
    }
  }

  private ensureConnectionActive(udid: string, generation: number): void {
    if (this.disposed) {
      throw new SimulatorWdaInputError('DISPOSED', 'WDA simulator input runtime has been disposed')
    }
    const current = this.leases.get(udid)
    if (current === undefined || current.generation !== generation) {
      throw new SimulatorWdaInputError('DISPOSED', 'WDA simulator connection is stale and was not sent to the current runtime')
    }
    if (current.run.releasing || current.run.dead || !current.run.ready) {
      throw new SimulatorWdaInputError('DISPOSED', 'WDA simulator connection is no longer active')
    }
  }

  private async launchBuiltRunner(
    udid: string,
    runDir: string,
    runId: string,
    nonce: string,
    port: number,
    generation: number,
    signal: AbortSignal | undefined,
    source: PreparedSource,
    toolchain: PreparedToolchain,
    cacheKey: string,
    lockPath: string,
    lockState: RuntimeLockState,
  ): Promise<LaunchOutcome> {
    const derivedDataDir = join(this.stateDir, 'builds', safeSegment(cacheKey), 'DerivedData')
    const runnerAppDir = join(derivedDataDir, 'Build', 'Products', 'Debug-iphonesimulator', 'WebDriverAgentRunner-Runner.app')
    const runnerExecutable = join(runnerAppDir, 'WebDriverAgentRunner-Runner')
    const testBundlePath = join(runnerAppDir, 'PlugIns', 'WebDriverAgentRunner.xctest')
    const built: BuiltProduct = { derivedDataDir, runnerAppDir, runnerExecutable, testBundlePath, toolchain, source, cacheKey }

    if (!existsSync(runnerExecutable) || !existsSync(testBundlePath)) {
      try {
        await this.buildRunner(built, udid, signal)
      } catch (error) {
        // No WDA runner was spawned yet; the newly-created lock/run dir can be
        // removed safely after a build failure/cancel.
        await this.removeOwnLock(lockPath, lockState)
        await rm(runDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
        throw error
      }
    }
    if (!existsSync(runnerExecutable) || !existsSync(testBundlePath)) {
      // No process was spawned; safe to remove this newly-created lock/run dir.
      await this.removeOwnLock(lockPath, lockState)
      await rm(runDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
      throw new SimulatorWdaInputError('TOOL_FAILED', 'xcodebuild reported success but the WDA runner product is missing')
    }

    const platformDir = join(toolchain.developerDir, 'Platforms', 'iPhoneSimulator.platform')
    const env = sanitizeRuntimeEnv(toolchain.developerDir, toolchain.sdkRoot, {
      udid,
      nonce,
      port,
      runnerAppDir,
      platformDir,
    })

    const spawnFn = this.options.spawnFn ?? spawn
    const startupOut = new BoundedTextBuffer()
    const startupErr = new BoundedTextBuffer()
    let child: ChildProcess
    try {
      child = spawnFn(toolchain.xcrun, [
        'simctl',
        'spawn',
        udid,
        runnerExecutable,
        '--run-as-tool',
        '-XCTest',
        'UITestingUITests/testRunner',
      ], {
        cwd: runDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      // No child was created; remove the freshly-owned lock/run dir.
      await this.removeOwnLock(lockPath, lockState)
      await rm(runDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
      throw error
    }

    // Drain child stdout/stderr through pipes immediately. Only bounded startup
    // text is retained while not ready; no file descriptors are inherited by the
    // runner and no vendor output is ever appended to unbounded files.
    const onStdoutData = (chunk: Buffer | string) => startupOut.push(chunk)
    const onStderrData = (chunk: Buffer | string) => startupErr.push(chunk)
    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)

    await writeFile(join(runDir, 'run.json'), JSON.stringify({
      schema: 1,
      owner: RUNTIME_OWNER_ID,
      runtimeInstance: this.runtimeInstance,
      udid,
      runId,
      nonce,
      envDigest: sha256Text(`${nonce}:${udid}:${port}:${generation}`),
      launcherPid: child.pid ?? null,
      port,
      generation,
      startedAt: this.now(),
      lockPath,
    }, null, 2), 'utf8')
    await writeFile(join(runDir, 'child.pid'), String(child.pid ?? ''), 'utf8')
    await writeFile(join(runDir, 'port'), String(port), 'utf8')

    let ready: Awaited<ReturnType<RuntimeImpl['waitForReady']>>
    try {
      ready = await this.waitForReady(child, startupOut, startupErr, port, signal)
    } catch (error) {
      child.stdout?.removeListener('data', onStdoutData)
      child.stderr?.removeListener('data', onStderrData)
      throw error
    }

    if (!ready.ready) {
      // Before user text exists we may persist bounded sanitized startup
      // diagnostics; after readiness no vendor output is ever retained.
      const diagnosticText = sanitizeStartupDiagnostics(`${startupOut.text()}\n${startupErr.text()}`)
      await persistStartupDiagnostics(this.stateDir, runId, diagnosticText)
      child.stdout?.removeListener('data', onStdoutData)
      child.stderr?.removeListener('data', onStderrData)
      await this.cleanupLaunchFailure(
        child,
        toolchain.xcrun,
        ready.runnerPid,
        runnerExecutable,
        port,
        lockPath,
        lockState,
        runDir,
      )
      throw new SimulatorWdaInputError('STARTUP_FAILED', `WDA simulator runner did not become ready on 127.0.0.1:${port}`)
    }
    if (ready.runnerPid === undefined) {
      child.stdout?.removeListener('data', onStdoutData)
      child.stderr?.removeListener('data', onStderrData)
      await this.cleanupLaunchFailure(
        child,
        toolchain.xcrun,
        undefined,
        runnerExecutable,
        port,
        lockPath,
        lockState,
        runDir,
      )
      throw new SimulatorWdaInputError('STARTUP_FAILED', `WDA simulator runner did not expose a verifiable pid on port ${port}`)
    }

    try {
      // Verify only the actual WDA runner pid owns the loopback listener and
      // that there are no extra/wildcard listeners on the port.
      const expectedPids = new Set<number>([ready.runnerPid])
      const verifyListenerFn = this.options.verifyListener ?? verifyListener
      const listenerOk = await verifyListenerFn(port, expectedPids, { execFileFn: this.options.execFileFn, developerDir: toolchain.developerDir })
      if (!listenerOk) {
        throw new SimulatorWdaInputError('STARTUP_FAILED', `WDA simulator runner listener verification failed on port ${port}`)
      }

      // A minimal /status probe proves the HTTP listener is ours and loopback.
      await (this.options.requestFn ?? localHttpRequest)(port, 'GET', '/status', undefined, {
        timeoutMs: this.options.requestTimeoutMs,
        signal,
      })
    } catch (error) {
      child.stdout?.removeListener('data', onStdoutData)
      child.stderr?.removeListener('data', onStderrData)
      const diagnosticText = sanitizeStartupDiagnostics(`${startupOut.text()}\n${startupErr.text()}`)
      await persistStartupDiagnostics(this.stateDir, runId, diagnosticText)
      await this.cleanupLaunchFailure(
        child,
        toolchain.xcrun,
        ready.runnerPid,
        runnerExecutable,
        port,
        lockPath,
        lockState,
        runDir,
      )
      throw error
    }

    // Startup proven. Clear bounded buffers; any later vendor output is drained
    // and discarded by the ensure() caller through pipe resume.
    startupOut.clear()
    startupErr.clear()
    child.stdout?.removeListener('data', onStdoutData)
    child.stderr?.removeListener('data', onStderrData)
    return {
      child,
      launcherPid: child.pid ?? this.options.hostPid ?? process.pid,
      launcherExecutable: toolchain.xcrun,
      runnerPid: ready.runnerPid,
      runnerExecutable,
      port,
    }
  }

  private async buildRunner(built: BuiltProduct, udid: string, signal?: AbortSignal): Promise<void> {
    await mkdir(built.derivedDataDir, { recursive: true })
    const args = [
      '-project', join(built.source.stageDir, 'WebDriverAgent.xcodeproj'),
      '-scheme', 'WebDriverAgentRunner',
      '-configuration', 'Debug',
      '-destination', `platform=iOS Simulator,id=${udid}`,
      '-derivedDataPath', built.derivedDataDir,
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'build-for-testing',
    ]
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: process.env.HOME ?? homedir(),
      TMPDIR: process.env.TMPDIR ?? join(homedir(), 'Library', 'Caches'),
      DEVELOPER_DIR: built.toolchain.developerDir,
    }
    const spawnFn = this.options.spawnFn ?? spawn
    const child = spawnFn(built.toolchain.xcodebuild, args, { cwd: built.source.stageDir, env, stdio: ['ignore', 'pipe', 'pipe'] })

    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    child.stdout?.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      outBytes += buffer.length
      out.push(buffer)
      while (out.length > 0 && outBytes > MAX_STARTUP_LOG_BYTES * 2) {
        const removed = out.shift()
        if (removed !== undefined) outBytes -= removed.length
      }
    })
    child.stderr?.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      errBytes += buffer.length
      err.push(buffer)
      while (err.length > 0 && errBytes > MAX_STARTUP_LOG_BYTES * 2) {
        const removed = err.shift()
        if (removed !== undefined) errBytes -= removed.length
      }
    })

    const exited = new Promise<
      | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
      | { kind: 'timeout' }
      | { kind: 'cancelled' }
    >(resolveExit => {
      child.once('exit', (code, sig) => resolveExit({ kind: 'exit', code, signal: sig }))
      child.once('error', () => resolveExit({ kind: 'exit', code: -1, signal: null }))
      const timer = setTimeout(() => resolveExit({ kind: 'timeout' }), Math.max(this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, 300_000))
      if (typeof timer.unref === 'function') timer.unref()
      const onAbort = () => {
        clearTimeout(timer)
        resolveExit({ kind: 'cancelled' })
      }
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })

    const result = await exited
    if (result.kind === 'timeout' || result.kind === 'cancelled') {
      await this.signalOwnedProcess(
        child,
        undefined,
        built.toolchain.xcodebuild,
        result.kind === 'cancelled' ? 'SIGTERM' : 'SIGKILL',
      )
      if (result.kind === 'cancelled') {
        throw new SimulatorWdaInputError('CANCELLED', 'WDA simulator build was cancelled')
      }
      const tail = Buffer.concat([...out, ...err]).toString('utf8').slice(-MAX_STARTUP_LOG_BYTES)
      throw new SimulatorWdaInputError('TOOL_FAILED', `xcodebuild did not complete in time${tail === '' ? '' : `: ${tail.split('\n').slice(-5).join('\n')}`}`)
    }
    const tail = Buffer.concat([...out, ...err]).toString('utf8').slice(-MAX_STARTUP_LOG_BYTES)
    if (result.code !== 0) {
      throw new SimulatorWdaInputError('TOOL_FAILED', `xcodebuild failed${tail === '' ? '' : `: ${tail.split('\n').slice(-5).join('\n')}`}`)
    }
  }

  private async waitForReady(
    child: ChildProcess,
    startupOut: BoundedTextBuffer,
    startupErr: BoundedTextBuffer,
    port: number,
    signal?: AbortSignal,
  ): Promise<{ ready: boolean; runnerPid?: number }> {
    const deadline = this.now() + (this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    const pollMs = this.options.startupPollMs ?? DEFAULT_STARTUP_POLL_MS
    let childExited: { code: number | null; signal: NodeJS.Signals | null } | undefined
    child.once('exit', (code, sig) => {
      childExited = { code, signal: sig }
    })

    while (true) {
      if (signal?.aborted === true) return { ready: false }
      const tail = `${startupOut.text()}\n${startupErr.text()}`.slice(-MAX_STARTUP_LOG_BYTES)
      const found = findServerReady(tail, port)
      if (found !== undefined) {
        return { ready: true, runnerPid: found.pid }
      }
      if (childExited !== undefined) return { ready: false }
      if (this.now() >= deadline) return { ready: false }
      await sleep(pollMs, signal)
    }
  }

  /**
   * Signal only launcher/runner pids whose command line still matches the
   * executable this runtime actually spawned/verified. This prevents sending
   * signals to an unrelated process that reused the pid.
   */
  private async signalOwnedProcess(
    child: ChildProcess | undefined,
    externalPid: number | undefined,
    expectedExecutable: string,
    signal: NodeJS.Signals,
  ): Promise<boolean> {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      if (await processCommandMatches(child.pid ?? -1, expectedExecutable, this.options.readProcessIdentity)) {
        try {
          return child.kill(signal) ?? true
        } catch {
          return false
        }
      }
    }
    if (externalPid !== undefined && child?.pid !== externalPid) {
      if (await processCommandMatches(externalPid, expectedExecutable, this.options.readProcessIdentity)) {
        try {
          return (this.options.signalProcess ?? defaultSignalProcess)(externalPid, signal)
        } catch {
          return false
        }
      }
    }
    return false
  }

  private async signalOwnedRun(
    run: {
      child: ChildProcess
      launcherPid: number
      launcherExecutable: string
      runnerPid?: number
      runnerExecutable: string
    },
    signal: NodeJS.Signals,
  ): Promise<void> {
    await this.signalOwnedProcess(run.child, run.launcherPid, run.launcherExecutable, signal)
    await this.signalOwnedProcess(undefined, run.runnerPid, run.runnerExecutable, signal)
  }

  private async runnerIsGone(
    pid: number | undefined,
    executable: string,
  ): Promise<boolean> {
    if (pid === undefined || pid <= 0) return true
    const identity = await (this.options.readProcessIdentity ?? defaultReadProcessIdentity)(pid)
    // Missing command means the process is not alive. A mismatched command
    // means the old pid has been reused by an unrelated process, so the owned
    // runner is no longer at that pid.
    return identity === undefined || !identity.includes(executable)
  }

  private async waitForOwnedProcessCleanup(
    child: ChildProcess,
    launcherPid: number,
    launcherExecutable: string,
    runnerPid: number | undefined,
    runnerExecutable: string,
  ): Promise<boolean> {
    let escalated = false
    let waitUntil = this.now() + CLEANUP_WAIT_MS
    while (true) {
      const childExited = child.exitCode !== null || child.signalCode !== null
      const runnerGone = await this.runnerIsGone(runnerPid, runnerExecutable)
      if (childExited && runnerGone) return true
      if (this.now() >= waitUntil) {
        if (!escalated) {
          await this.signalOwnedRun({
            child,
            launcherPid,
            launcherExecutable,
            runnerPid,
            runnerExecutable,
          }, 'SIGKILL')
          escalated = true
          waitUntil = this.now() + CLEANUP_WAIT_MS
          continue
        }
        return false
      }
      // Cleanup is a foreground lifecycle operation. Keep the timer referenced
      // so a short-lived caller cannot exit while release() is still proving
      // that both owned processes are gone.
      await sleep(CLEANUP_POLL_MS, undefined, { unref: false })
    }
  }

  private async cleanupLaunchFailure(
    child: ChildProcess,
    launcherExecutable: string,
    runnerPid: number | undefined,
    runnerExecutable: string,
    port: number,
    lockPath: string,
    lockState: RuntimeLockState,
    runDir: string,
  ): Promise<void> {
    const launcherPid = child.pid ?? -1
    await this.signalOwnedRun({ child, launcherPid, launcherExecutable, runnerPid, runnerExecutable }, 'SIGTERM')
    const proven = await this.waitForOwnedProcessCleanup(
      child,
      launcherPid,
      launcherExecutable,
      runnerPid,
      runnerExecutable,
    )
    if (proven) {
      await this.removeOwnLock(lockPath, lockState)
      await rm(runDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
    // If cleanup could not be proven, lockfile/runDir/diagnostics are left in
    // place so future starts report BUSY instead of spawning over an orphan.
    void port
  }

  async release(udid: string): Promise<void> {
    assertSafeUdid(udid)
    const lease = this.leases.get(udid)
    if (lease === undefined) return
    const run = lease.run
    if (run.releasing) {
      const proven = await run.cleanupPromise
      if (proven !== true) throw new SimulatorWdaInputError('BUSY', 'WDA simulator input cleanup remains unproven; owned artifacts were retained for recovery')
      return
    }
    run.releasing = true
    run.dead = true
    run.abortController.abort()
    run.cleanupPromise = (async () => {
      await this.signalOwnedRun(run, 'SIGTERM')
      const proven = await this.waitForOwnedProcessCleanup(
        run.child,
        run.launcherPid,
        run.launcherExecutable,
        run.runnerPid,
        run.runnerExecutable,
      )
      if (proven) {
        await this.removeOwnLock(run.lockPath, run.lockState)
        await rm(run.runDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
        if (this.leases.get(udid)?.generation === lease.generation) this.leases.delete(udid)
      }
      return proven
    })()
    const proven = await run.cleanupPromise
    if (proven !== true) throw new SimulatorWdaInputError('BUSY', 'WDA simulator input cleanup remains unproven; owned artifacts were retained for recovery')
  }

  private async removeOwnLock(lockPath: string, state: RuntimeLockState): Promise<void> {
    try {
      const current = await readLockState(lockPath)
      if (current === undefined) return
      if (
        current.nonce === state.nonce &&
        current.port === state.port &&
        current.udid === state.udid &&
        current.runtimeInstance === this.runtimeInstance
      ) {
        await rm(lockPath, { force: true })
      }
    } catch {
      // Best effort. Never remove another owner's lock.
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.disposePromise = (async () => {
      let firstError: unknown
      const keys = [...this.leases.keys()]
      for (const key of keys) {
        const lease = this.leases.get(key)
        if (lease === undefined) continue
        try {
          if (!lease.run.releasing) await this.release(key)
          else if (await lease.run.cleanupPromise !== true) {
            throw new SimulatorWdaInputError('BUSY', 'WDA simulator input cleanup remains unproven; owned artifacts were retained for recovery')
          }
        } catch (error) {
          firstError ??= error
        }
      }
      if (firstError !== undefined) throw firstError
    })()
    return this.disposePromise
  }
}

function sleep(ms: number, signal?: AbortSignal, options: { unref?: boolean } = {}): Promise<void> {
  return new Promise(resolvePromise => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }
    const onAbort = (): void => finish()
    if (signal?.aborted === true) {
      finish()
      return
    }
    timer = setTimeout(finish, ms)
    if (options.unref !== false && typeof timer.unref === 'function') timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Create the public runtime. */
export function createSimulatorWdaInputRuntime(options: SimulatorWdaInputRuntimeOptions = {}): SimulatorWdaInputRuntime {
  return new RuntimeImpl(options)
}
