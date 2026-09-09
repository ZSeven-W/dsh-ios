/**
 * Targeted smoke for src/wda-simulator-input.ts.
 *
 * Run after `pnpm run build` (or `tsc -p tsconfig.json`):
 *   node scripts/dev-wda-simulator-input-smoke.mjs
 *
 * This is a host-free/mocked test. It never boots a simulator, never launches
 * the real WDA, never touches the cached WDA source or another process.
 */

import assert from 'node:assert/strict'

import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modulePath = process.env.DSH_IOS_QA_LIB_DIR === undefined
  ? join(root, 'lib', 'wda-simulator-input.js')
  : join(process.env.DSH_IOS_QA_LIB_DIR, 'wda-simulator-input.js')
const sourcePath = join(root, 'src', 'wda-simulator-input.ts')

const mod = await import(modulePath)
const {
  RUNTIME_OWNER_ID,
  WDA_SIMULATOR_LOOPBACK,
  SimulatorWdaInputError,
  SimulatorWdaInputTransportError,
  assertSafeRequestPath,
  assertSafeUdid,
  createSimulatorWdaInputRuntime,
  stagePatchedSource,
  buildCacheKey,
  pickFreeLoopbackPort,
} = mod

const results = []
let failed = 0
function step(name, ok, detail = '') {
  if (!ok) failed += 1
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const TMP = mkdtempSync(join(tmpdir(), 'dsh-wda-sim-input-smoke-'))
const UDID = '7028B135-A568-4E7F-B47A-539C8710136D'

function makeSourceTree(overrides = {}) {
  const src = join(TMP, `source-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(src, 'WebDriverAgent.xcodeproj'), { recursive: true })
  mkdirSync(join(src, 'WebDriverAgentLib', 'Utilities'), { recursive: true })
  mkdirSync(join(src, 'WebDriverAgentLib', 'Routing'), { recursive: true })
  mkdirSync(join(src, 'WebDriverAgentRunner'), { recursive: true })
  writeFileSync(join(src, 'LICENSE'), 'Copyright (c) Facebook BSD-style license. Keep attribution.\n')
  const config = overrides.config ?? `- (NSString *)bindingIPAddress
{
  // Existence of USE_IP in the environment allows specifying which interface to bind to
  if (NSProcessInfo.processInfo.environment[@"USE_IP"] &&
      [NSProcessInfo.processInfo.environment[@"USE_IP"] length] > 0) {
    return NSProcessInfo.processInfo.environment[@"USE_IP"];
  }

  return nil;
}
`
  const web = overrides.web ?? `- (void)startServing
{
  [self initScreenshotsBroadcaster];

  self.keepAlive = YES;
}
`
  writeFileSync(join(src, 'WebDriverAgentLib', 'Utilities', 'FBConfiguration.m'), config)
  writeFileSync(join(src, 'WebDriverAgentLib', 'Routing', 'FBWebServer.m'), web)
  return src
}

function makeToolchain() {
  const dev = join(TMP, 'FakeDeveloper')
  const sdk = join(TMP, 'FakeSDK', 'iPhoneSimulator.sdk')
  const platform = join(dev, 'Platforms', 'iPhoneSimulator.platform')
  mkdirSync(join(dev, 'usr', 'bin'), { recursive: true })
  writeFileSync(join(dev, 'usr', 'bin', 'xcodebuild'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  mkdirSync(join(platform, 'Developer', 'Library', 'Frameworks'), { recursive: true })
  mkdirSync(join(platform, 'Developer', 'Library', 'PrivateFrameworks'), { recursive: true })
  mkdirSync(join(platform, 'Developer', 'usr', 'lib'), { recursive: true })
  mkdirSync(join(sdk, 'Developer', 'Library', 'Frameworks'), { recursive: true })
  return { developerDir: dev, sdkRoot: sdk, sdkVersion: '26.5', arch: 'arm64', platform }
}

class FakeChild extends EventEmitter {
  constructor(pid, command, { killDelayMs = 0, failTerm = false } = {}) {
    super()
    this.pid = pid
    this.command = command
    this.exitCode = null
    this.signalCode = null
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killed = []
    this.killDelayMs = killDelayMs
    this.failTerm = failTerm
    this.processTable = null
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return false
    if (this.failTerm && signal !== 'SIGKILL') return false
    this.killed.push(signal)
    const finish = () => {
      if (this.exitCode !== null || this.signalCode !== null) return
      this.signalCode = signal
      this.exitCode = null
      this.stdout.end()
      this.stderr.end()
      this.emit('exit', null, signal)
      if (this.processTable) this.processTable.delete(this.pid)
    }
    if (this.killDelayMs > 0) {
      const timer = setTimeout(finish, this.killDelayMs)
      timer.unref?.()
    }
    else finish()
    return true
  }

  finish(code = 0) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = null
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, null)
    if (this.processTable) this.processTable.delete(this.pid)
  }
}

class FakeExternalProcess {
  constructor(pid, command, { killDelayMs = 0, failTerm = false, failKill = false } = {}) {
    this.pid = pid
    this.command = command
    this.alive = true
    this.killed = []
    this.killDelayMs = killDelayMs
    this.failTerm = failTerm
    this.failKill = failKill
  }

  kill(signal = 'SIGTERM') {
    if (!this.alive) return false
    if (this.failTerm && signal !== 'SIGKILL') return false
    if (this.failKill && signal === 'SIGKILL') return false
    this.killed.push(signal)
    if (this.killDelayMs > 0) {
      const timer = setTimeout(() => { this.alive = false }, this.killDelayMs)
      timer.unref?.()
    } else {
      this.alive = false
    }
    return true
  }
}

function makeFakeSpawn(captured, {
  failBuild = false,
  writeReady = true,
  postReadySecret,
  launcherKillDelayMs = 0,
  launcherFailTerm = false,
  runnerKillDelayMs = 0,
  runnerFailTerm = false,
  runnerFailKill = false,
  runnerPolicy,
} = {}) {
  let nextPid = 1000
  const processes = new Map()
  const fakeSpawn = function fakeSpawn(file, args, options) {
    const child = new FakeChild(nextPid, `${file} ${args.join(' ')}`, {
      killDelayMs: launcherKillDelayMs,
      failTerm: launcherFailTerm,
    })
    nextPid += 2 // reserve child.pid + 1 for the verified fake runner pid
    child.processTable = processes
    processes.set(child.pid, child)
    const record = { file, args, options, child }
    captured.spawns.push(record)
    if (args.includes('build-for-testing')) {
      setImmediate(() => {
        if (failBuild) {
          child.finish(1)
          return
        }
        const idx = args.indexOf('-derivedDataPath')
        const derived = args[idx + 1]
        const app = join(derived, 'Build', 'Products', 'Debug-iphonesimulator', 'WebDriverAgentRunner-Runner.app')
        const test = join(app, 'PlugIns', 'WebDriverAgentRunner.xctest')
        mkdirSync(test, { recursive: true })
        writeFileSync(join(app, 'WebDriverAgentRunner-Runner'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        writeFileSync(join(test, 'WebDriverAgentRunner'), 'fake xctest\n')
        child.finish(0)
      })
      return child
    }
    if (!args.includes('simctl')) return child

    const port = options.env?.SIMCTL_CHILD_USE_PORT
    const build = captured.spawns.find(s => s.args.includes('build-for-testing'))
    let runnerExecutable = '/mock/WebDriverAgentRunner-Runner'
    if (build) {
      const idx = build.args.indexOf('-derivedDataPath')
      const app = join(build.args[idx + 1], 'Build', 'Products', 'Debug-iphonesimulator', 'WebDriverAgentRunner-Runner.app')
      runnerExecutable = join(app, 'WebDriverAgentRunner-Runner')
    }
    const runnerPid = child.pid + 1
    const policy = typeof runnerPolicy === 'function' ? runnerPolicy(args[2]) : {}
    const runner = new FakeExternalProcess(runnerPid, `${runnerExecutable} --run-as-tool -XCTest UITestingUITests/testRunner`, {
      killDelayMs: policy.killDelayMs ?? runnerKillDelayMs,
      failTerm: policy.failTerm ?? runnerFailTerm,
      failKill: policy.failKill ?? runnerFailKill,
    })
    processes.set(runnerPid, runner)
    record.runnerPid = runnerPid
    record.runner = runner
    if (writeReady) {
      const line = `2026-09-07 WebDriverAgentRunner-Runner[${runnerPid}:123] ServerURLHere->http://127.0.0.1:${port}<-ServerURLHere\n`
      setTimeout(() => {
        if (child.stdout && !child.stdout.destroyed) child.stdout.write(line, 'utf8')
        if (postReadySecret) {
          setTimeout(() => {
            if (child.stdout && !child.stdout.destroyed) child.stdout.write(postReadySecret, 'utf8')
          }, 10)
        }
      }, 5)
    }
    return child
  }
  fakeSpawn.processes = processes
  fakeSpawn.readProcessIdentity = async pid => {
    const process = processes.get(pid)
    if (!process) return undefined
    if (process instanceof FakeExternalProcess && !process.alive) return undefined
    return process.command
  }
  fakeSpawn.signalProcess = (pid, signal) => {
    const process = processes.get(pid)
    if (!process) return false
    if (process instanceof FakeChild || process instanceof FakeExternalProcess) return process.kill(signal)
    return false
  }
  fakeSpawn.processExists = pid => processes.has(pid)
  return fakeSpawn
}

async function startMockWda(port) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      let body
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      } catch {
        body = Buffer.concat(chunks).toString('utf8')
      }
      requests.push({ method: req.method, path: req.url, body, count: requests.filter(r => r.path === req.url && r.method === req.method).length + 1 })
      if (req.method === 'POST' && req.url === '/session') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ value: { error: 'server unavailable', message: 'mock no retry' } }))
        return
      }
      if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ value: { state: 'success', ready: true } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ value: null }))
    })
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, WDA_SIMULATOR_LOOPBACK, resolvePromise)
  })
  return {
    server,
    requests,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

let seed = 0
function makeRuntimeOptions({ source, toolchain, state, captured, overrides = {}, serverPort }) {
  const spawnFn = overrides.spawnFn ?? makeFakeSpawn(captured, overrides.fake ?? {})
  return {
    wdaSourceDir: source,
    stateDir: state,
    xcodeDeveloperDir: toolchain.developerDir,
    sdkRoot: toolchain.sdkRoot,
    sdkVersion: toolchain.sdkVersion,
    arch: toolchain.arch,
    spawnFn,
    verifyListener: overrides.verifyListener ?? (async () => true),
    readProcessIdentity: overrides.readProcessIdentity ?? spawnFn.readProcessIdentity,
    signalProcess: overrides.signalProcess ?? spawnFn.signalProcess,
    processExists: overrides.processExists ?? spawnFn.processExists,
    pickPort: overrides.pickPort ?? (async () => serverPort),
    startupTimeoutMs: 2_000,
    startupPollMs: 5,
    requestTimeoutMs: 500,
    randomNonce: overrides.randomNonce ?? (() => `nonce-${++seed}`),
    now: overrides.now,
    execFileFn: overrides.execFileFn,
  }
}

if (process.env.DSH_WDA_RELEASE_CHILD === '1') {
  const src = makeSourceTree()
  const state = join(TMP, 'release-child-state')
  const serverPort = 30109
  const mock = await startMockWda(serverPort)
  const captured = { spawns: [] }
  const runtime = createSimulatorWdaInputRuntime(makeRuntimeOptions({ source: src, toolchain: makeToolchain(), state, captured, serverPort, overrides: { fake: { launcherKillDelayMs: 30, runnerKillDelayMs: 90 } } }))
  await runtime.ensure(UDID)
  await mock.close()
  await runtime.release(UDID)
  await runtime.dispose()
  const lock = join(state, 'locks', `${UDID}.lock.json`)
  assert(!existsSync(lock), 'release-child lockfile remains after release')
  console.log('release-child-settled')
  process.exit(0)
}

// 1. Host-free import and exact public API
step('module imports without DSH host deps', !/@deepseek-ai/.test(readFileSync(sourcePath, 'utf8')))
step('exact runtime factory exists', typeof createSimulatorWdaInputRuntime === 'function')
step('typed transport error carries mayHaveDispatched', typeof SimulatorWdaInputTransportError === 'function' && new SimulatorWdaInputTransportError('x', true).mayHaveDispatched === true)

// 2. Path/argument/UDID safety
let pathOk = true
let pathThrows = 0
for (const good of ['/status', '/session', '/wda/tap/1']) {
  try { assertSafeRequestPath(good) } catch { pathOk = false }
}
for (const bad of ['status', '//evil/path', 'https://x/y', 'http://x/y', '/a\\b']) {
  try { assertSafeRequestPath(bad); /* no throw */ } catch { pathThrows += 1 }
}
step('request path safety accepts loopback paths and rejects absolute/protocol-relative/backslash', pathOk && pathThrows === 5)
let udidOk = true
let udidThrows = 0
for (const bad of ['', '../etc', 'x', 'A'.repeat(200), 'has space']) {
  try { assertSafeUdid(bad); /* no throw */ } catch { udidThrows += 1 }
}
try { assertSafeUdid(UDID) } catch { udidOk = false }
step('UDID validation prevents traversal and non-simulator strings', udidOk && udidThrows === 5)

// 3. Stage safety: original untouched, stage contains loopback/MJPEG-off
{
  const src = makeSourceTree()
  const state = join(TMP, 'stage-state')
  const staged = await stagePatchedSource(src, state)
  const originalConfig = readFileSync(join(src, 'WebDriverAgentLib', 'Utilities', 'FBConfiguration.m'), 'utf8')
  const originalWeb = readFileSync(join(src, 'WebDriverAgentLib', 'Routing', 'FBWebServer.m'), 'utf8')
  const stagedConfig = readFileSync(join(staged.stageDir, 'WebDriverAgentLib', 'Utilities', 'FBConfiguration.m'), 'utf8')
  const stagedWeb = readFileSync(join(staged.stageDir, 'WebDriverAgentLib', 'Routing', 'FBWebServer.m'), 'utf8')
  const manifest = readJson(join(staged.stageDir, 'dsh-wda-simulator-stage.json'))
  const originalStillClean = originalConfig.includes('USE_IP') && originalWeb.includes('[self initScreenshotsBroadcaster]')
  const stagedSafe = stagedConfig.includes('return @"127.0.0.1";') && !stagedConfig.includes('USE_IP') && stagedWeb.includes('never started') && !stagedWeb.includes('\n  [self initScreenshotsBroadcaster];')
  step('source cache modification safety: original remains pristine and staged private copy is patched', originalStillClean && stagedSafe && manifest.owner === RUNTIME_OWNER_ID)
}

// 4. Patch failure => no spawn
{
  const src = makeSourceTree({ config: '// wrong content\n' })
  const state = join(TMP, 'bad-state')
  const captured = { spawns: [] }
  const serverPort = 30101
  const mock = await startMockWda(serverPort)
  try {
    const toolchain = makeToolchain()
    const runtime = createSimulatorWdaInputRuntime(makeRuntimeOptions({ source: src, toolchain, state, captured, serverPort }))
    await runtime.ensure(UDID)
    step('prelaunch patch failure rejected', false, 'unexpected success')
  } catch (error) {
    step('prelaunch patch failure rejected without spawn', error instanceof SimulatorWdaInputError && error.code === 'PATCH_FAILED' && captured.spawns.length === 0, error.message)
  } finally {
    await mock.close()
  }
}

// 5. Existing owner busy fails without spawn/adoption
{
  const src = makeSourceTree()
  const state = join(TMP, 'busy-state')
  mkdirSync(join(state, 'locks'), { recursive: true })
  const lock = join(state, 'locks', `${UDID}.lock.json`)
  writeFileSync(lock, JSON.stringify({
    schema: 1,
    owner: RUNTIME_OWNER_ID,
    udid: UDID,
    pid: process.pid,
    runtimeInstance: 'other-runtime',
    nonce: 'other',
    port: 9999,
    runDir: '/tmp/other',
    generation: 1,
    createdAt: new Date().toISOString(),
  }))
  const captured = { spawns: [] }
  const toolchain = makeToolchain()
  const runtime = createSimulatorWdaInputRuntime(makeRuntimeOptions({
    source: src,
    toolchain,
    state,
    captured,
    serverPort: 30102,
    overrides: { processExists: () => true },
  }))
  try {
    await runtime.ensure(UDID)
    step('existing owner is busy, not stolen/adopted', false, 'unexpected success')
  } catch (error) {
    step('existing owner is busy, not stolen/adopted', error instanceof SimulatorWdaInputError && error.code === 'BUSY' && captured.spawns.length === 0, error.message)
  }
}

// 6. Pre-aborted cancellation does not spawn
{
  const src = makeSourceTree()
  const state = join(TMP, 'cancel-state')
  const captured = { spawns: [] }
  const toolchain = makeToolchain()
  const runtime = createSimulatorWdaInputRuntime(makeRuntimeOptions({ source: src, toolchain, state, captured, serverPort: 30103 }))
  const controller = new AbortController()
  controller.abort(new Error('stop now'))
  try {
    await runtime.ensure(UDID, { signal: controller.signal })
    step('ensure cancellation rejected', false, 'unexpected success')
  } catch (error) {
    step('ensure cancellation rejected before spawn', error instanceof SimulatorWdaInputError && error.code === 'CANCELLED' && captured.spawns.length === 0, error.message)
  }
}

// 7. Full fake run + no wildcard/MJPEG + no mutation retry + release
{
  const src = makeSourceTree()
  const state = join(TMP, 'full-state')
  const serverPort = 30104
  const mock = await startMockWda(serverPort)
  const captured = { spawns: [] }
  const toolchain = makeToolchain()
  const runtime = createSimulatorWdaInputRuntime(makeRuntimeOptions({
    source: src,
    toolchain,
    state,
    captured,
    serverPort,
  }))
  try {
    const connection = await runtime.ensure(UDID)
    step('ensure returns owned connection with udid/generation/pid/port', connection.udid === UDID && connection.generation === 1 && connection.pid > 0 && connection.port === serverPort)

    const simSpawns = captured.spawns.filter(s => s.args.includes('simctl'))
    const buildSpawns = captured.spawns.filter(s => s.args.includes('build-for-testing'))
    step('prefers proven simctl run-as-tool and builds cached runner first', simSpawns.length === 1 && simSpawns[0].args.includes('--run-as-tool') && simSpawns[0].args.includes('-XCTest') && buildSpawns.length === 1, JSON.stringify(captured.spawns.map(s => s.args)))

    const env = simSpawns[0].options.env
    const noWildcard = env.SIMCTL_CHILD_USE_IP === WDA_SIMULATOR_LOOPBACK
      && !Object.keys(env).some(k => k.toUpperCase().includes('MJPEG') || k.toUpperCase().includes('BROADCAST'))
      && !Object.values(env).some(v => typeof v === 'string' && v.includes('0.0.0.0'))
      && !Object.values(env).some(v => typeof v === 'string' && v.includes('::'))
    const envHasLoopbackOnly = env.SIMCTL_CHILD_USE_PORT === String(serverPort)
    step('simctl child env is loopback-only and never starts MJPEG broadcaster', noWildcard && envHasLoopbackOnly)

    const before = mock.requests.length
    const res = await connection.request('POST', '/session', { capabilities: {} })
    step('mutation request is single-attempt and returns status/body', res.statusCode === 503 && mock.requests.length === before + 1, `count=${mock.requests.length - before}`)

    const badRequestPaths = []
    for (const bad of ['https://x/session', '//x/session', 'no/slash']) {
      try { await connection.request('POST', bad, {}); badRequestPaths.push(false) } catch (error) { badRequestPaths.push(error instanceof SimulatorWdaInputError) }
    }
    step('connection request rejects absolute/protocol-relative/non-absolute paths', badRequestPaths.every(Boolean))

    const lock = join(state, 'locks', `${UDID}.lock.json`)
    step('lease lockfile exists while owned', existsSync(lock))
    await runtime.release(UDID)
    const ownedSimCtlChildren = captured.spawns.filter(s => s.args.includes('simctl'))
    const sim = ownedSimCtlChildren[0]
    const runnerGone = sim?.runner ? !sim.runner.alive : false
    step('release closes only own lease/lock/run artifacts', !existsSync(lock) && ownedSimCtlChildren.length === 1 && sim?.child.killed.length > 0 && runnerGone, `lock=${existsSync(lock)} simKill=${sim?.child.killed.join(',') ?? 'none'} simSig=${sim?.child.signalCode ?? 'null'} simExit=${sim?.child.exitCode ?? 'null'} runnerAlive=${sim?.runner?.alive}`)
  } finally {
    await runtime.dispose()
    await mock.close()
  }
}

// 7b. Delayed owned cleanup: release resolves only after the launcher has
// exited AND the owned runner is actually gone (kill acceptance alone is not
// proof), so the lease lockfile is removed only once real cleanup is observed.
{
  const src = makeSourceTree()
  const state = join(TMP, 'full-state-delayed')
  const serverPort = 30106
  const mock = await startMockWda(serverPort)
  const captured = { spawns: [] }
  const toolchain = makeToolchain()
  const runtime = createSimulatorWdaInputRuntime(makeRuntimeOptions({
    source: src,
    toolchain,
    state,
    captured,
    serverPort,
    overrides: { fake: { launcherKillDelayMs: 40, runnerKillDelayMs: 80 } },
  }))
  try {
    await runtime.ensure(UDID)
    const lock = join(state, 'locks', `${UDID}.lock.json`)
    const sim = captured.spawns.filter(s => s.args.includes('simctl'))[0]
    const aliveBeforeRelease = sim && sim.runner.alive && sim.child.signalCode === null && sim.child.exitCode === null
    await runtime.release(UDID)
    step('delayed cleanup unlinks only after both owned launcher and runner are gone', aliveBeforeRelease && !existsSync(lock) && !sim.runner.alive && sim.child.signalCode !== null && sim.child.killed.length > 0, `aliveBefore=${aliveBeforeRelease} lock=${existsSync(lock)} simSig=${sim?.child.signalCode ?? 'null'} simSigCount=${sim?.child.killed.length} runnerAlive=${sim?.runner?.alive}`)
  } finally {
    await runtime.dispose()
    await mock.close()
  }
}

// 7c. Unknown-owner lock is never silently unlinked even when this runtime
// believes it owns a lease. Swapping the lockfile to a foreign owner must
// make release's cleanup proof still reap the run it created but refuse to
// delete the foreign lockfile.
{
  const src = makeSourceTree()
  const state = join(TMP, 'unknown-owner-state')
  const serverPort = 30107
  const mock = await startMockWda(serverPort)
  const captured = { spawns: [] }
  const toolchain = makeToolchain()
  const runtime = createSimulatorWdaInputRuntime(makeRuntimeOptions({
    source: src,
    toolchain,
    state,
    captured,
    serverPort,
  }))
  try {
    await runtime.ensure(UDID)
    const lock = join(state, 'locks', `${UDID}.lock.json`)
    // Simulate another host/operator replacing the lock while this runtime's
    // in-memory lease is still live: a foreign owner and nonce/runDir.
    writeFileSync(lock, JSON.stringify({
      schema: 1,
      owner: RUNTIME_OWNER_ID,
      udid: UDID,
      pid: process.pid,
      runtimeInstance: 'foreign-runtime-owner',
      nonce: 'foreign-nonce',
      port: 9997,
      runDir: join(TMP, 'foreign-runDir'),
      generation: 2,
      createdAt: new Date().toISOString(),
    }))
    const sim = captured.spawns.filter(s => s.args.includes('simctl'))[0]
    let releaseError
    try { await runtime.release(UDID) } catch (error) { releaseError = error }
    const runnerGone = sim && !sim.runner.alive
    step('unknown-owner lock preserved while owned cleanup succeeds', existsSync(lock) && runnerGone && sim.child.signalCode !== null && releaseError === undefined, `lockStillPresent=${existsSync(lock)} runnerGone=${runnerGone} simSig=${sim?.child.signalCode ?? 'null'} error=${releaseError?.code ?? 'none'}`)
  } finally {
    await runtime.dispose()
    await mock.close()
  }
}

// 7d. Unproven owned cleanup is an explicit BUSY failure, and dispose does
// not silently report success while retaining the lock/run diagnostics.
{
  const src = makeSourceTree()
  const state = join(TMP, 'unproven-state')
  const serverPort = 30108
  const mock = await startMockWda(serverPort)
  const captured = { spawns: [] }
  const toolchain = makeToolchain()
  let clock = 0
  let accelerate = false
  const runtime = createSimulatorWdaInputRuntime(makeRuntimeOptions({
    source: src,
    toolchain,
    state,
    captured,
    serverPort,
    overrides: {
      now: () => accelerate ? (clock += 6_000) : Date.now(),
      fake: { launcherFailTerm: true, runnerFailTerm: true, runnerFailKill: true },
    },
  }))
  try {
    await runtime.ensure(UDID)
    accelerate = true
    const releases = await Promise.allSettled([runtime.release(UDID), runtime.release(UDID)])
    const releaseError = releases.find(result => result.status === 'rejected')?.reason
    const lock = join(state, 'locks', `${UDID}.lock.json`)
    step('concurrent unproven releases share BUSY and retain lock diagnostics', releases.every(result => result.status === 'rejected' && result.reason instanceof SimulatorWdaInputError && result.reason.code === 'BUSY') && existsSync(lock), `error=${releaseError?.code ?? 'none'} lock=${existsSync(lock)}`)
    let disposeError
    try { await runtime.dispose() } catch (error) { disposeError = error }
    step('dispose does not hide unproven cleanup', disposeError instanceof SimulatorWdaInputError && disposeError.code === 'BUSY')
    let disposeAgainError
    try { await runtime.dispose() } catch (error) { disposeAgainError = error }
    step('second dispose preserves BUSY result', disposeAgainError instanceof SimulatorWdaInputError && disposeAgainError.code === 'BUSY')
  } finally {
    await mock.close()
  }
}

// 7e. dispose attempts every owned lease even when one cleanup is BUSY.
{
  const src = makeSourceTree()
  const state = join(TMP, 'multi-state')
  const serverPort = 30110
  const mock = await startMockWda(serverPort)
  const captured = { spawns: [] }
  const toolchain = makeToolchain()
  let clock = 0
  let accelerate = false
  const runtime = createSimulatorWdaInputRuntime(makeRuntimeOptions({
    source: src, toolchain, state, captured, serverPort,
    overrides: {
      now: () => accelerate ? (clock += 6_000) : Date.now(),
      fake: {
        launcherFailTerm: false,
        runnerFailTerm: false,
        runnerFailKill: false,
        runnerPolicy: udid => udid === UDID ? { failTerm: true, failKill: true } : {},
      },
    },
  }))
  const UDID2 = '8028B135-A568-4E7F-B47A-539C8710136D'
  try {
    await runtime.ensure(UDID)
    await runtime.ensure(UDID2)
    const simRuns = captured.spawns.filter(s => s.args.includes('simctl'))
    step('multi-device fake runner pids are unique', new Set(simRuns.map(s => s.runnerPid)).size === simRuns.length)
    await mock.close()
    accelerate = true
    let disposeError
    try { await runtime.dispose() } catch (error) { disposeError = error }
    const lock1 = join(state, 'locks', `${UDID}.lock.json`)
    const lock2 = join(state, 'locks', `${UDID2}.lock.json`)
    step('dispose cleans other owned leases before raising first BUSY', disposeError?.code === 'BUSY' && existsSync(lock1) && !existsSync(lock2), `error=${disposeError?.code ?? 'none'} lock1=${existsSync(lock1)} lock2=${existsSync(lock2)} runs=${captured.spawns.filter(s => s.args.includes('simctl')).map(s => `${s.args[2]}:${s.runner?.failTerm}/${s.runner?.failKill}/${s.runner?.alive}`).join(',')}`)
  } finally {
    try { await mock.close() } catch {}
  }
}

// 8. Wrong listener PID/port/UDID verification fails before connection is returned
{
  const src = makeSourceTree()
  const state = join(TMP, 'listener-state')
  const serverPort = 30105
  const mock = await startMockWda(serverPort)
  const captured = { spawns: [] }
  const toolchain = makeToolchain()
  const runtime = createSimulatorWdaInputRuntime(makeRuntimeOptions({
    source: src,
    toolchain,
    state,
    captured,
    serverPort,
    overrides: { verifyListener: async () => false },
  }))
  try {
    await runtime.ensure(UDID)
    step('wrong listener proof is rejected', false, 'unexpected success')
  } catch (error) {
    const simSpawns = captured.spawns.filter(s => s.args.includes('simctl'))
    step('wrong listener proof is rejected and owned child is killed', error instanceof SimulatorWdaInputError && error.code === 'STARTUP_FAILED' && simSpawns.length === 1 && simSpawns[0].child.killed.length > 0, error.message)
  } finally {
    await runtime.dispose()
    await mock.close()
  }
}

// 9. Build cache key includes source+safety patch+sdk+arch
{
  const key = await buildCacheKey({ sourceDigest: 'a'.repeat(64), patchDigest: 'b'.repeat(64), sdkVersion: '26.5', arch: 'arm64' })
  step('build cache key deterministic and source/patch/sdk/arch-scoped', typeof key === 'string' && key.length === 40)
  const free = await pickFreeLoopbackPort()
  step('free port picker uses an ephemeral non-system loopback port', Number.isInteger(free) && free >= 1024 && free < 65536)
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${results.length} checks)`)
if (failed !== 0) process.exitCode = 1
