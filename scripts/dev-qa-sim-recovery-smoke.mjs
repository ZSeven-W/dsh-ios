/** Mock-only regression for bounded AXe empty-tree recovery through owned WDA input leases. */
import assert from 'node:assert/strict'
import { join } from 'node:path'

const root = join(new URL('.', import.meta.url).pathname, '..')
const libRoot = process.env.DSH_IOS_QA_LIB_DIR ?? join(root, 'lib')
const { createIosQaBackend } = await import(join(libRoot, 'qa-driver.js'))
const UDID = '7028B135-A568-4E7F-B47A-539C8710136D'
const empty = [{ type: 'Application', label: '', identifier: '', frame: { x: 0, y: 0, w: 0, h: 0 }, children: [] }]
const usable = [{ type: 'Application', label: 'QA Fixture', frame: { x: 0, y: 0, w: 402, h: 874 }, children: [{ type: 'Button', label: 'Apply', frame: { x: 20, y: 20, w: 80, h: 40 }, children: [] }] }]
const baseOptions = {
  simDevices: { list: async () => [{ udid: UDID, name: 'DSH-QA', runtime: 'iOS', state: 'Booted' }], matches: async udid => udid === UDID },
  realDevices: { list: async () => [], matches: async () => false },
  sim: { async ensureRunning() { return { url: 'http://127.0.0.1:3181', streamUrl: 'http://127.0.0.1:3181/stream.mjpeg', wsUrl: 'ws://127.0.0.1:3181/ws', port: 3181, device: UDID } }, async control() { return { stdout: '', stderr: '' } }, status() { return { available: true, running: true, consumers: 0, restarts: 0, serveSimSource: 'package-bin', stderr: [] } }, async stop() {}, async dispose() {} },
  simForegroundApp: async () => ({ bundleId: 'dev.zseven.qa.fixture.ios', name: 'QA Fixture', pid: 123, verified: true }),
}
function fakeRuntime(options = {}) {
  const calls = { ensure: 0, release: 0, dispose: 0 }
  const runtime = { async ensure() { calls.ensure += 1; if (options.ensureError !== undefined) throw options.ensureError; return { udid: UDID, generation: 1, pid: 1, port: 1234, request: async () => ({ statusCode: 200, body: {} }) } }, async release() { calls.release += 1 }, async dispose() { calls.dispose += 1 } }
  return { runtime, calls }
}
function makeBackend(axe, runtimeFactory, extra = {}) { return createIosQaBackend({ ...baseOptions, axe, wdaInputRuntimeFactory: runtimeFactory, ...extra }) }

// An AX transport exception is not an empty-tree recovery trigger.
let thrownReads = 0; const thrownRuntime = fakeRuntime(); const thrownBackend = makeBackend(async () => { thrownReads += 1; throw new Error('AXe transport failed') }, () => thrownRuntime.runtime)
await assert.rejects(() => thrownBackend.observe(UDID), /AXe transport failed/); assert.equal(thrownReads, 1); assert.equal(thrownRuntime.calls.ensure, 0); await thrownBackend.dispose()

// A resolver that ignores cancellation must still stop before recovery.
let cancelledAfterRead = 0; const cancelledAfterRuntime = fakeRuntime(); const cancelledAfterReadBackend = makeBackend(async () => { cancelledAfterRead += 1; abortAfterRead.abort(); return empty }, () => cancelledAfterRuntime.runtime)
const abortAfterRead = new AbortController(); await assert.rejects(() => cancelledAfterReadBackend.observe(UDID, { signal: abortAfterRead.signal })); assert.equal(cancelledAfterRead, 1); assert.equal(cancelledAfterRuntime.calls.ensure, 0); await cancelledAfterReadBackend.dispose()

let normalReads = 0; const normal = fakeRuntime(); const normalBackend = makeBackend(async () => { normalReads += 1; return usable }, () => normal.runtime)
const normalObservation = await normalBackend.observe(UDID); assert.equal(normalObservation.nodes.length, 2); assert.equal(normal.calls.ensure, 0); assert.equal(normalReads, 1); await normalBackend.dispose(); assert.equal(normal.calls.dispose, 0)

// One transient empty tree followed by a semantically usable tree needs no lease.
let transientReads = 0; const transientRuntime = fakeRuntime(); const transientBackend = makeBackend(async () => { transientReads += 1; return transientReads === 1 ? empty : usable }, () => transientRuntime.runtime)
assert.equal((await transientBackend.observe(UDID)).nodes.length, 2); assert.equal(transientRuntime.calls.ensure, 0); await transientBackend.dispose()

let recoveredReads = 0; const recovered = fakeRuntime(); const recoveredBackend = makeBackend(async () => { recoveredReads += 1; return recoveredReads < 4 ? empty : usable }, () => recovered.runtime)
const recoveredObservation = await recoveredBackend.observe(UDID); assert.equal(recoveredObservation.nodes.length, 2); assert.equal(recovered.calls.ensure, 1)
await recoveredBackend.observe(UDID); assert.equal(recovered.calls.ensure, 1, 'existing recovery lease ensured more than once'); await recoveredBackend.releaseDevice(UDID); assert.equal(recovered.calls.release, 1); await recoveredBackend.dispose(); assert.equal(recovered.calls.dispose, 1)

// Injected runtimes are released by releaseDevice but never disposed by this backend.
let injectedReads = 0; const injected = fakeRuntime(); const injectedBackend = makeBackend(async () => { injectedReads += 1; return injectedReads < 4 ? empty : usable }, () => { throw new Error('factory must not run for injected runtime') }, { wdaInputRuntime: injected.runtime })
assert.equal((await injectedBackend.observe(UDID)).nodes.length, 2); assert.equal(injected.calls.ensure, 1); await injectedBackend.releaseDevice(UDID); assert.equal(injected.calls.release, 1); await injectedBackend.dispose(); assert.equal(injected.calls.dispose, 0)

let failedReads = 0; const failed = fakeRuntime({ ensureError: Object.assign(new Error('runtime refused'), { code: 'BUSY' }) }); const failedBackend = makeBackend(async () => { failedReads += 1; return empty }, () => failed.runtime)
await assert.rejects(() => failedBackend.observe(UDID), /runtime refused/); assert.equal(failed.calls.ensure, 1); assert.equal(failedReads, 3); await failedBackend.dispose()

let stillEmptyReads = 0; const stillEmpty = fakeRuntime(); const stillEmptyBackend = makeBackend(async () => { stillEmptyReads += 1; return empty }, () => stillEmpty.runtime)
await assert.rejects(() => stillEmptyBackend.observe(UDID), error => error?.code === 'simulator.axe.incomplete'); assert.equal(stillEmpty.calls.ensure, 1); assert.equal(stillEmptyReads, 4); await stillEmptyBackend.dispose()

let cancelledReads = 0; const cancelledRuntime = fakeRuntime(); const cancelledBackend = makeBackend(async () => { cancelledReads += 1; return empty }, () => cancelledRuntime.runtime)
const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(() => cancelledBackend.observe(UDID, { signal: cancelled.signal })); assert.equal(cancelledReads, 0); assert.equal(cancelledRuntime.calls.ensure, 0); await cancelledBackend.dispose()

console.log('PASS structural empty-tree reread recovery, owned lease lifecycle, failure/empty/cancel fail-closed, and normal-tree zero-ensure')
