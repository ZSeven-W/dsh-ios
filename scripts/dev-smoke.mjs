/**
 * Development smoke test for the dsh-ios sim host manager.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-smoke.mjs
 *
 * Steps (PASS/FAIL per step, non-zero exit if any step fails):
 *   1. resolve serve-sim binary and assert it is available
 *   2. pick an available iPhone simulator (prefer iOS 26.x, newest runtime)
 *   3. boot it, ensureRunning, and share one launch between concurrent callers
 *   4. fetch 2 seconds of streamUrl and assert >100 KB received
 *   5. drive `serve-sim tap 0.5 0.5` through the same binary resolution
 *   6. stop(), then verify the keep-alive loop does not fight the stop
 *   7. dispose() and shut the simulator down
 *   8. verify no serve-sim processes or booted simulators are left behind
 */

import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { listDevices, bootDevice, shutdownDevice, bootedDevices } = await import(join(root, 'lib', 'simctl.js'))
const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))

const results = []
function step(name, ok, detail = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  results.push({ name, ok })
  console.log(`${verdict} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

let controller
let udid
let deviceName

try {
  // ── 1. serve-sim binary resolution ────────────────────────────────────────
  controller = new SimHostController()
  const status0 = controller.status()
  step(
    'serve-sim binary resolves',
    status0.available,
    `source=${status0.serveSimSource} command=${status0.serveSimCommand ?? '(none)'}`,
  )
  if (!status0.available) throw new Error('serve-sim unavailable; cannot continue')

  // ── 2. pick an iPhone simulator, prefer iOS 26.x ──────────────────────────
  const devices = await listDevices()
  const iphones = devices.filter(d => d.name.startsWith('iPhone'))
  if (iphones.length === 0) throw new Error('no available iPhone simulators')
  const byRuntime = (a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true })
  const ios26 = iphones.filter(d => d.runtime.includes('iOS-26')).sort(byRuntime)
  const fallback = iphones.sort(byRuntime)
  const picked = (ios26.length > 0 ? ios26 : fallback)[0]
  udid = picked.udid
  deviceName = picked.name
  step(
    'pick iPhone simulator',
    true,
    `${deviceName} (${picked.runtime}, ${udid})`,
  )

  // ── 3. boot + ensureRunning with concurrent callers sharing one launch ────
  controller.startKeepAlive()
  await bootDevice(udid)
  step('boot simulator', true, `${deviceName} booted`)

  const [a, b] = await Promise.all([
    controller.ensureRunning({ udid }),
    controller.ensureRunning({ udid }),
  ])
  step(
    'ensureRunning returns stream handshake',
    typeof a.port === 'number' && a.streamUrl.startsWith('http') && a.device === udid,
    `port=${a.port} streamUrl=${a.streamUrl}`,
  )
  step('concurrent callers share one launch', a.port === b.port && a.streamUrl === b.streamUrl, `port ${a.port} == ${b.port}`)
  const runningStatus = controller.status()
  step(
    'status reports running stream',
    runningStatus.running && runningStatus.device === udid && runningStatus.port === a.port,
    `running=${runningStatus.running} restarts=${runningStatus.restarts}`,
  )

  // ── 4. consume 2 seconds of the MJPEG stream ──────────────────────────────
  const streamResult = await new Promise((resolve, reject) => {
    let received = 0
    let headers = {}
    const req = http.get(a.streamUrl, res => {
      headers = {
        contentType: String(res.headers['content-type'] ?? ''),
        cors: String(res.headers['access-control-allow-origin'] ?? ''),
      }
      if (res.statusCode !== 200) {
        req.destroy()
        reject(new Error(`stream HTTP ${res.statusCode}`))
        return
      }
      res.on('data', chunk => { received += chunk.length })
      res.on('error', reject)
    })
    req.on('error', reject)
    const kill = setTimeout(() => {
      req.destroy()
      resolve({ received, headers })
    }, 2000)
    kill.unref?.()
  })
  step(
    'stream endpoint is multipart MJPEG with CORS *',
    streamResult.headers.contentType.startsWith('multipart/x-mixed-replace')
      && streamResult.headers.cors === '*',
    `content-type=${streamResult.headers.contentType} cors=${streamResult.headers.cors}`,
  )
  step(
    'stream delivers >100KB in 2s',
    streamResult.received > 100 * 1024,
    `${(streamResult.received / 1024).toFixed(1)} KB received`,
  )

  // ── 5. drive a tap through the same binary resolution ─────────────────────
  const tap = await controller.control(['tap', '-d', udid, '0.5', '0.5'])
  step('serve-sim tap via resolved binary', true, `tap exited clean (stderr="${tap.stderr.trim()}")`)

  // ── 6. intentional stop; keep-alive must not fight it ─────────────────────
  await controller.stop()
  step('stop() settles', true)
  await new Promise(r => setTimeout(r, 2600))
  const stoppedStatus = controller.status()
  step(
    'keep-alive does not fight intentional stop',
    !stoppedStatus.running,
    `running=${stoppedStatus.running} restarts=${stoppedStatus.restarts}`,
  )

  // ── 7. dispose + shutdown the simulator ────────────────────────────────────
  await controller.dispose()
  step('dispose() settles', true)
  await shutdownDevice(udid)
  step('simulator shut down', true)

  // ── 8. no leftovers ───────────────────────────────────────────────────────
  const leftDevices = (await bootedDevices()).map(d => `${d.name} ${d.udid}`)
  step('no booted simulators left', leftDevices.length === 0, leftDevices.join(', ') || 'none')

  let serveSimProcs = ''
  try {
    serveSimProcs = execFileSync('pgrep', ['-fl', 'serve-sim'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    // pgrep exit 1 = no matches, which is what we want
  }
  step('no serve-sim processes left', serveSimProcs === '', serveSimProcs || 'none')
} catch (error) {
  step('smoke completed without uncaught errors', false, error instanceof Error ? error.message : String(error))
} finally {
  // ── best-effort cleanup no matter what happened ───────────────────────────
  try {
    if (controller !== undefined) await controller.dispose()
  } catch { /* already disposed or teardown best-effort */ }
  try {
    if (udid !== undefined) await shutdownDevice(udid)
  } catch { /* already shut down */ }
  try {
    execFileSync('pkill', ['-f', 'serve-sim'], { stdio: 'ignore', timeout: 10_000 })
  } catch { /* pkill exit 1 = nothing to kill */ }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
