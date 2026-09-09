/** Mock-only smoke for the lazy default physical QA wiring. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(new URL('.', import.meta.url).pathname, '..')
const libRoot = process.env.DSH_IOS_QA_LIB_DIR ?? join(root, 'lib')
const { createIosQaBackend, IosQaError } = await import(join(libRoot, 'qa-driver.js'))
const { WdaError } = await import(join(libRoot, 'wda-host.js'))
const { PhysicalWdaStageError } = await import(join(libRoot, 'wda-physical-stage.js'))

if (!existsSync(join(libRoot, 'qa-driver.js'))) {
  throw new Error('build first: lib/qa-driver.js is missing')
}

const real = { udid: 'REAL', name: 'mock phone', state: 'available', pairingState: 'paired' }
const control = {
  async windowSize() { return { width: 402, height: 874 } },
  async activeAppInfo() { return { bundleId: 'example.app', pid: 7 } },
  async source() { return '<XCUIElementTypeApplication name="Mock"/>' },
}
function fakeWda(ensureRunning) {
  return {
    ensureRunning,
    status() { return { available: true, running: true, consumers: 0 } },
    async stop() {}, acquire() { return () => {} }, release() {}, mjpegUrl: 'http://127.0.0.1:9100',
    control: { ...control, async screenshot() { return { pngBase64: 'a', width: 402, height: 874 } }, async setSnapshotDepth() {}, async tap() {}, async dragFromToForDuration() {}, async typeText() {}, async pressButton() {}, async lock() {}, async unlock() {}, async activateSiri() {}, async setOrientation() {} },
  }
}
const devices = {
  simDevices: { list: async () => [], matches: async () => false },
  realDevices: { list: async () => [real], matches: async udid => udid === real.udid },
}

let resolveCalls = 0
let stageCalls = 0
let made = []
const factory = options => { made.push(options); return fakeWda(async () => ({ udid: 'REAL', hardwareUdid: 'REAL', controlUrl: 'http://127.0.0.1:8100', mjpegUrl: 'http://127.0.0.1:9100', sessionId: 'mock' })) }
const backend = createIosQaBackend({
  ...devices,
  resolveSigningTeam: async () => { resolveCalls += 1; return { teamId: 'TEAM123', source: 'xcode-account', detail: 'mock' } },
  stagePhysicalWda: async () => { stageCalls += 1; return { stageDir: '/private/tmp/mock-physical-wda' } },
  wdaFactory: factory,
})
await backend.observe('REAL')
if (resolveCalls !== 1 || stageCalls !== 1 || made[0]?.teamId !== 'TEAM123' || made[0]?.wdaProjectDir !== '/private/tmp/mock-physical-wda' || made[0]?.adoptExisting !== false) {
  throw new Error('default physical WDA wiring did not resolve, stage, or configure safely')
}
await backend.dispose()

let skippedStage = 0
const explicit = createIosQaBackend({
  ...devices,
  wdaOptions: { projectDir: '/private/tmp/explicit-wda' },
  resolveSigningTeam: async () => ({ teamId: 'TEAM123', source: 'option', detail: 'mock' }),
  stagePhysicalWda: async () => { skippedStage += 1; return { stageDir: '/private/tmp/should-not-use' } },
  wdaFactory: options => { if (options.wdaProjectDir !== '/private/tmp/explicit-wda') throw new Error('explicit projectDir was not preserved'); return fakeWda(async () => ({ udid: 'REAL', hardwareUdid: 'REAL', controlUrl: 'http://127.0.0.1:8100', mjpegUrl: 'http://127.0.0.1:9100', sessionId: 'mock' })) },
})
await explicit.observe('REAL')
await explicit.dispose()
if (skippedStage !== 0) throw new Error('explicit projectDir unexpectedly staged the shared source')

const missing = createIosQaBackend({ ...devices, resolveSigningTeam: async () => ({ source: 'none', detail: 'mock' }), stagePhysicalWda: async () => { throw new Error('must not stage') }, wdaFactory: factory })
let missingCode
try { await missing.observe('REAL') } catch (error) { missingCode = error instanceof IosQaError ? error.code : undefined }
if (missingCode !== 'unsupported.wda.signing-team.unconfigured') throw new Error('missing signing team did not fail closed')

const stageFailed = createIosQaBackend({ ...devices, resolveSigningTeam: async () => ({ teamId: 'TEAM123', source: 'xcode-account', detail: 'mock' }), stagePhysicalWda: async () => { throw new PhysicalWdaStageError('PATCH_FAILED', 'mock patch mismatch') }, wdaFactory: factory })
let stageCode
try { await stageFailed.observe('REAL') } catch (error) { stageCode = error instanceof IosQaError ? error.code : undefined }
if (stageCode !== 'unsupported.wda.source.patch-failed') throw new Error('stage failure did not map to a stable unsupported code')

const refused = createIosQaBackend({ ...devices, wda: fakeWda(async () => { throw new WdaError('wda-already-running', 'foreign runner') }) })
let refusedCode
try { await refused.observe('REAL') } catch (error) { refusedCode = error instanceof IosQaError ? error.code : undefined }
if (refusedCode !== 'unsupported.wda.already-running') throw new Error('foreign runner refusal was not mapped')

console.log('PASS lazy default physical WDA wiring, explicit project, missing team, and foreign-runner mapping')
