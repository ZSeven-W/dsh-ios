/**
 * Development smoke test for orphaned serve-sim helper recovery.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-orphan-smoke.mjs
 *
 * Reproduces the production failure mode where a previous DSH host was
 * killed ungracefully (SIGKILL — dispose() never runs) and its detached
 * serve-sim child survived as an orphan:
 *
 *   Scenario 1 (adoption):
 *     1. boot device A, then manually spawn a detached serve-sim helper for
 *        it on port 3181 (NOT through SimHostController — this simulates
 *        the orphan)
 *     2. a fresh SimHostController picks the next free port (3182) but the
 *        handshake reports the orphan's 3181 → the handshake must be
 *        ADOPTED: same device, orphan's port/streamUrl/wsUrl are authoritative
 *     3. status() reflects adopted mode and logs the adoption; the stream
 *        delivers >100KB/2s through the adopted URL; refcounts work
 *     4. stop() reaps the adopted helper via `serve-sim -k <device>`:
 *        `serve-sim -l` is empty, port 3181 is free, keep-alive does not
 *        fight the intentional stop
 *
 *   Scenario 2 (reclaim):
 *     5. an orphan streams device A while a stale serve-sim state file
 *        registers it against device B; ensureRunning(B) sees a handshake
 *        for a DIFFERENT device → the stale helper is reclaimed via
 *        `serve-sim -k` and a fresh owned stream starts for B
 *     6. the fresh stream serves device B, the orphan is gone
 *
 *   Cleanup: zero serve-sim processes, zero booted simulators.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { SimHostController, resolveServeSimBinary } = await import(join(root, 'lib', 'sim-host.js'))
const { listDevices, bootDevice, shutdownDevice, bootedDevices } = await import(join(root, 'lib', 'simctl.js'))

const ORPHAN_PORT = 3181
const STATE_DIR = join(tmpdir(), 'serve-sim')
const stateFile = udid => join(STATE_DIR, `server-${udid}.json`)

const results = []
function step(name, ok, detail = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  results.push({ name, ok })
  console.log(`${verdict} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function canBindLoopbackPort(port) {
  return new Promise(resolveBind => {
    const probe = createServer()
    probe.unref()
    probe.once('error', () => resolveBind(false))
    probe.listen({ host: '127.0.0.1', port }, () => {
      probe.close(() => resolveBind(true))
    })
  })
}

async function pollUntil(name, fn, { timeoutMs = 30_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`${name}: timed out after ${timeoutMs} ms`)
    await sleep(intervalMs)
  }
}

/** Read the first JSON line printed by a serve-sim child's stdout. */
function waitForJsonLine(stream, label, timeoutMs = 150_000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${label}: no JSON line within ${timeoutMs} ms`))
    }, timeoutMs)
    stream.on('data', chunk => {
      if (settled) return
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      settled = true
      clearTimeout(timer)
      try {
        resolve(JSON.parse(buffer.slice(0, newline).trim()))
      } catch (error) {
        reject(error)
      }
    })
    stream.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Spawn a detached serve-sim foreground stream (the orphan simulation). */
async function spawnOrphan(binary, udid, port) {
  const orphan = spawn(binary.command, [...binary.args, '--no-preview', '--quiet', '--port', String(port), udid], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  orphan.unref()
  orphan.stderr.resume()
  const handshake = await waitForJsonLine(orphan.stdout, `orphan serve-sim (${udid}, port ${port})`)
  const state = await pollUntil(`state file for ${udid}`, () => {
    if (!existsSync(stateFile(udid))) return null
    try {
      const info = JSON.parse(readFileSync(stateFile(udid), 'utf8'))
      return typeof info.pid === 'number' && info.pid > 0 ? info : null
    } catch {
      return null
    }
  })
  return { orphan, handshake, state }
}

/** Fetch `streamUrl` for 2 seconds and return the received byte count. */
async function consumeStream(streamUrl) {
  return new Promise((resolve, reject) => {
    let received = 0
    let statusCode = 0
    const req = http.get(streamUrl, res => {
      statusCode = res.statusCode ?? 0
      if (statusCode !== 200) {
        req.destroy()
        reject(new Error(`stream HTTP ${statusCode}`))
        return
      }
      res.on('data', chunk => { received += chunk.length })
      res.on('error', reject)
    })
    req.on('error', reject)
    const kill = setTimeout(() => {
      req.destroy()
      resolve({ received, statusCode })
    }, 2000)
    kill.unref?.()
  })
}

async function serveSimList(controller) {
  const { stdout } = await controller.control(['-l'])
  return JSON.parse(stdout)
}

function serveSimProcesses() {
  try {
    return execFileSync('pgrep', ['-fl', 'serve-sim'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return ''
  }
}

let controller1
let controller2
let orphan1
let orphan2
let deviceA
let deviceB
const stateFilesCreated = new Set()

try {
  // ── 0. binary resolution + a clean, deterministic port baseline ──────────
  controller1 = new SimHostController()
  const status0 = controller1.status()
  step(
    'serve-sim binary resolves',
    status0.available,
    `source=${status0.serveSimSource} command=${status0.serveSimCommand ?? '(none)'}`,
  )
  if (!status0.available) throw new Error('serve-sim unavailable; cannot continue')
  const binary = resolveServeSimBinary()
  const port3181Free = await canBindLoopbackPort(ORPHAN_PORT)
  const port3182Free = await canBindLoopbackPort(ORPHAN_PORT + 1)
  step(
    'ports 3181 and 3182 start free',
    port3181Free && port3182Free,
    `3181=${port3181Free ? 'free' : 'busy'} 3182=${port3182Free ? 'free' : 'busy'}`,
  )
  if (!port3181Free || !port3182Free) {
    throw new Error(`serve-sim ports not free (3181=${port3181Free}, 3182=${port3182Free}); kill leftover helpers and retry`)
  }

  // ── 1. pick two distinct iPhone simulators ───────────────────────────────
  const devices = await listDevices()
  const iphones = devices.filter(d => d.name.startsWith('iPhone'))
  if (iphones.length < 2) throw new Error('need at least two available iPhone simulators')
  const byRuntime = (a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true })
  const sorted = [...iphones].sort(byRuntime)
  deviceA = sorted[0]
  deviceB = sorted.find(d => d.udid !== deviceA.udid) ?? sorted[1]
  step(
    'pick two iPhone simulators',
    deviceA.udid !== deviceB.udid,
    `A=${deviceA.name} (${deviceA.runtime}) B=${deviceB.name} (${deviceB.runtime})`,
  )

  // ── 2. boot device A and spawn the orphan for it on 3181 ─────────────────
  await bootDevice(deviceA.udid)
  step('boot device A', true, `${deviceA.name} booted`)
  orphan1 = await spawnOrphan(binary, deviceA.udid, ORPHAN_PORT)
  step(
    'detached orphan streams device A on 3181',
    orphan1.handshake.device === deviceA.udid && orphan1.handshake.port === ORPHAN_PORT,
    `pid=${orphan1.state.pid} port=${orphan1.handshake.port} streamUrl=${orphan1.handshake.streamUrl}`,
  )

  // ── 3. scenario 1: a fresh controller must ADOPT the orphan ──────────────
  controller1.startKeepAlive()
  const adopted = await controller1.ensureRunning({ udid: deviceA.udid })
  step(
    'ensureRunning succeeds by adoption (no port-mismatch rejection)',
    adopted.device === deviceA.udid,
    `device=${adopted.device} port=${adopted.port}`,
  )
  step(
    'handshake port is the orphan\'s 3181 (authoritative)',
    adopted.port === ORPHAN_PORT && adopted.port === orphan1.handshake.port,
    `port=${adopted.port} (controller requested the next free port)`,
  )
  step(
    'adopted streamUrl/wsUrl are the orphan\'s',
    adopted.streamUrl === orphan1.handshake.streamUrl && adopted.wsUrl === orphan1.handshake.wsUrl,
    `streamUrl=${adopted.streamUrl}`,
  )
  const adoptedStatus = controller1.status()
  step(
    'status() reflects adopted mode',
    adoptedStatus.adopted === true && adoptedStatus.running === true
      && adoptedStatus.device === deviceA.udid && adoptedStatus.port === ORPHAN_PORT,
    `adopted=${adoptedStatus.adopted} running=${adoptedStatus.running} port=${adoptedStatus.port}`,
  )
  step(
    'adoption is logged in the stderr ring (requested 3182, adopted 3181)',
    adoptedStatus.stderr.some(line => line.includes('adopted existing serve-sim helper')
      && line.includes(`port ${ORPHAN_PORT}`) && line.includes('requested 3182')),
    `stderr lines: ${adoptedStatus.stderr.filter(line => line.includes('adopted')).join(' | ')}`,
  )

  // keep-alive must keep the adoption (its 1s HTTP probe sees it alive)
  await sleep(2600)
  const probedStatus = controller1.status()
  step(
    'keep-alive probe keeps the adopted helper',
    probedStatus.running === true && probedStatus.adopted === true,
    `running=${probedStatus.running} adopted=${probedStatus.adopted}`,
  )

  // ── 4. the adopted URL must actually stream ──────────────────────────────
  const adoptedStream = await consumeStream(adopted.streamUrl)
  step(
    'adopted stream delivers >100KB in 2s',
    adoptedStream.received > 100 * 1024,
    `${(adoptedStream.received / 1024).toFixed(1)} KB received`,
  )

  // ── 5. refcounts work in adopted mode ────────────────────────────────────
  const release = controller1.acquire()
  const heldStatus = controller1.status()
  release()
  const releasedStatus = controller1.status()
  step(
    'acquire/release refcounts work in adopted mode',
    heldStatus.consumers === 1 && releasedStatus.consumers === 0,
    `consumers ${heldStatus.consumers} -> ${releasedStatus.consumers}`,
  )

  // ── 6. stop() must reap the adopted helper (no child to signal) ──────────
  await controller1.stop()
  step('stop() settles in adopted mode', true)
  const stoppedList = await pollUntil('adopted helper reaped by stop()', async () => {
    const list = await serveSimList(controller1).catch(() => null)
    if (list !== null && list.running === false) return list
    return null
  })
  step(
    'serve-sim -l is empty after stop()',
    stoppedList !== null && stoppedList.running === false,
    JSON.stringify(stoppedList),
  )
  const portFreeAfterStop = await pollUntil('port 3181 released', async () => canBindLoopbackPort(ORPHAN_PORT))
  step('port 3181 is free after stop()', portFreeAfterStop === true)
  const procsAfterStop = await pollUntil('orphan processes exited', () => (serveSimProcesses() === '' ? true : null), { timeoutMs: 15_000 })
  step('no serve-sim processes after stop()', procsAfterStop === true, serveSimProcesses())

  await sleep(2600)
  const postStopStatus = controller1.status()
  step(
    'keep-alive does not fight the adopted stop',
    postStopStatus.running === false,
    `running=${postStopStatus.running} restarts=${postStopStatus.restarts}`,
  )
  await controller1.dispose()
  step('dispose() settles after adopted stop', true)

  // ── 7. scenario 2: a stale helper registered against a DIFFERENT device ──
  await bootDevice(deviceB.udid)
  step('boot device B', true, `${deviceB.name} booted`)
  orphan2 = await spawnOrphan(binary, deviceA.udid, ORPHAN_PORT)
  step(
    'second orphan streams device A on 3181',
    orphan2.handshake.device === deviceA.udid && orphan2.handshake.port === ORPHAN_PORT,
    `pid=${orphan2.state.pid}`,
  )
  // Simulate stale serve-sim daemon metadata: the orphan helper is
  // registered under device B's slot, so a request for B yields a
  // handshake that reports device A.
  writeFileSync(stateFile(deviceB.udid), JSON.stringify({
    pid: orphan2.state.pid,
    port: orphan2.state.port,
    device: orphan2.state.device,
    url: orphan2.state.url,
    streamUrl: orphan2.state.streamUrl,
    wsUrl: orphan2.state.wsUrl,
  }, null, 2))
  stateFilesCreated.add(stateFile(deviceB.udid))
  step('stale state file registers the orphan against device B', existsSync(stateFile(deviceB.udid)))

  controller2 = new SimHostController()
  controller2.startKeepAlive()
  const reclaimed = await controller2.ensureRunning({ udid: deviceB.udid })
  step(
    'ensureRunning(B) reclaims the stale helper and starts fresh for B',
    reclaimed.device === deviceB.udid,
    `device=${reclaimed.device} port=${reclaimed.port}`,
  )
  const reclaimStatus = controller2.status()
  step(
    'reclaim is logged; stream is own-child (not adopted)',
    reclaimStatus.stderr.some(line => line.includes('reclaiming the stale helper'))
      && reclaimStatus.adopted !== true,
    `adopted=${reclaimStatus.adopted} port=${reclaimStatus.port}`,
  )
  const postReclaimList = await pollUntil('reclaim leaves only device B streaming', async () => {
    const list = await serveSimList(controller2).catch(() => null)
    if (list === null || list.running !== true) return null
    const streams = list.streams ?? [list]
    const onlyB = streams.length === 1 && streams[0].device === deviceB.udid
    return onlyB ? streams[0] : null
  })
  step(
    'serve-sim -l shows only device B',
    postReclaimList.device === deviceB.udid,
    `device=${postReclaimList.device} port=${postReclaimList.port} pid=${postReclaimList.pid}`,
  )
  const orphan2Gone = await pollUntil('orphan helper is gone', async () => {
    const procs = serveSimProcesses()
    return procs.includes(String(orphan2.state.pid)) ? null : true
  }, { timeoutMs: 15_000 })
  step('the stale orphan helper was killed', orphan2Gone === true, `orphan pid=${orphan2.state.pid}`)
  const staleSlotCleared = (() => {
    if (!existsSync(stateFile(deviceB.udid))) return true
    try {
      const info = JSON.parse(readFileSync(stateFile(deviceB.udid), 'utf8'))
      return info.device === deviceB.udid
    } catch {
      return false
    }
  })()
  step('stale device-B state file was cleaned up', staleSlotCleared)

  const reclaimedStream = await consumeStream(reclaimed.streamUrl)
  step(
    'fresh device-B stream delivers >100KB in 2s',
    reclaimedStream.received > 100 * 1024,
    `${(reclaimedStream.received / 1024).toFixed(1)} KB received`,
  )

  // ── 8. full cleanup ──────────────────────────────────────────────────────
  await controller2.dispose()
  step('dispose() settles for the reclaimed stream', true)
  await shutdownDevice(deviceA.udid)
  await shutdownDevice(deviceB.udid)
  step('simulators shut down', true)
  const leftDevices = (await bootedDevices()).map(d => `${d.name} ${d.udid}`)
  step('no booted simulators left', leftDevices.length === 0, leftDevices.join(', ') || 'none')
  const leftoverProcs = await pollUntil('all serve-sim processes exited', async () => {
    const procs = serveSimProcesses()
    return procs === '' ? true : null
  }, { timeoutMs: 15_000 })
  step('no serve-sim processes left', leftoverProcs === true, serveSimProcesses())
  const portFreeAtEnd = await canBindLoopbackPort(ORPHAN_PORT)
  step('port 3181 free at the end', portFreeAtEnd === true)
} catch (error) {
  step('smoke completed without uncaught errors', false, error instanceof Error ? error.message : String(error))
} finally {
  // ── best-effort cleanup no matter what happened ───────────────────────────
  try {
    if (controller2 !== undefined) await controller2.dispose()
  } catch { /* teardown best-effort */ }
  try {
    if (controller1 !== undefined) await controller1.dispose()
  } catch { /* teardown best-effort */ }
  for (const entry of [orphan1, orphan2]) {
    const child = entry?.orphan
    if (child === undefined || child.pid === undefined) continue
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  }
  try {
    execFileSync('pkill', ['-f', 'serve-sim'], { stdio: 'ignore', timeout: 10_000 })
  } catch { /* pkill exit 1 = nothing to kill */ }
  try {
    for (const path of stateFilesCreated) rmSync(path, { force: true })
  } catch { /* teardown best-effort */ }
  try {
    if (deviceA !== undefined) await shutdownDevice(deviceA.udid)
  } catch { /* already shut down */ }
  try {
    if (deviceB !== undefined) await shutdownDevice(deviceB.udid)
  } catch { /* already shut down */ }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
