/**
 * Development smoke test for the dsh-ios `ios_sim_logs` tool.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-logs-smoke.mjs
 *
 * Instantiates the tool's execute function directly (no harness needed): the
 * exported factory is bound to a real SimHostController.
 *
 * Steps (PASS/FAIL per step, non-zero exit if any step fails):
 *   1. factory produces the ios_sim_logs definition (concurrency-safe,
 *      bounded timeout, pure presenter)
 *   2. boot an iPhone and launch the stock Settings app
 *      (com.apple.Preferences)
 *   3. snapshot mode with predicate `process == "Preferences"` returns
 *      >0 lines with the right envelope, no ANSI, and capped output
 *   4. the bundle_id convenience filter builds the OR predicate
 *   5. follow mode with a 5 s window returns, and no `log stream` process
 *      is left behind afterwards (pgrep diff against the smoke baseline)
 *   6. cap enforcement: an unpredicated noisy capture stays ≤ 300 lines /
 *      30 KB while capturing, sets truncated, and carries the narrowing hint
 *   7. client-side grep: keep-pattern, drop-pattern, and invalid-regex error
 *   8. concurrent follow captures settle independently
 *   9. cleanup: simulators shut down, zero leftover `log` processes
 *
 * Set `DSH_IOS_SMOKE_SKIP_SIM=1` to skip the live-simulator part (steps 2-9).
 */

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { createSimLogTools } = await import(join(root, 'lib', 'tool-logs.js'))
const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))
const { listDevices, bootDevice, shutdownDevice, bootedDevices } = await import(join(root, 'lib', 'simctl.js'))

const results = []
function step(name, ok, detail = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  results.push({ name, ok })
  console.log(`${verdict} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** Minimal execution context for calling ToolDefinition.execute directly. */
function makeExec(toolName, args) {
  return {
    callId: `smoke-${toolName}`,
    rootCallId: `smoke-${toolName}`,
    name: toolName,
    arguments: args,
    signal: new AbortController().signal,
  }
}

/** Pids of host processes whose argv matches `log stream`/`log show`. */
function logToolPids() {
  try {
    const out = execFileSync('pgrep', ['-f', 'log (stream|show)'], { encoding: 'utf8', timeout: 10_000 })
    return out.split('\n').map(line => line.trim()).filter(line => /^\d+$/.test(line))
  } catch {
    return [] // pgrep exit 1 = no matches
  }
}

/** Byte size of the returned log lines only (the hint line is not counted). */
function logBytes(result) {
  const logLines = result.truncated ? result.lines.slice(0, result.lineCount) : result.lines
  return Buffer.byteLength(logLines.join('\n'), 'utf8')
}

function capInvariants(result) {
  return result.lineCount <= 300
    && logBytes(result) <= 30 * 1024
    && !/\u001b/.test(result.lines.join('\n'))
    && (result.truncated
      ? result.lines.length === result.lineCount + 1
        && /narrow/.test(result.lines[result.lines.length - 1])
      : result.lines.length === result.lineCount)
}

const SKIP_SIM = process.env.DSH_IOS_SMOKE_SKIP_SIM === '1'

// ── 1. factory shape (no simulator needed) ──────────────────────────────────
let controller
let tools
try {
  controller = new SimHostController()
  tools = createSimLogTools(controller)
  step('factory produces the ios_sim_logs tool', tools.iosSimLogs.name === 'ios_sim_logs')
  step('ios_sim_logs is concurrency-safe', tools.iosSimLogs.isConcurrencySafe({}) === true)
  step('ios_sim_logs declares a bounded cooperative timeout', tools.iosSimLogs.timeoutMs === 600_000)
  let presenterOk = true
  for (const args of [{}, { mode: 'follow', duration_seconds: 5 }, { mode: 'snapshot', predicate: 'x == "y"' }]) {
    try {
      tools.iosSimLogs.presentCall(args)
    } catch (error) {
      presenterOk = false
      console.error(`  presentCall threw for ${JSON.stringify(args)}: ${error}`)
    }
  }
  step('presentCall never throws', presenterOk)
} catch (error) {
  step('factory smoke completed without uncaught errors', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
}

// ── live-simulator part ──────────────────────────────────────────────────────
if (SKIP_SIM) {
  console.log(`— live simulator part (SKIPPED: DSH_IOS_SMOKE_SKIP_SIM=1) —`)
  step('live log capture against a booted simulator', true, 'skipped by DSH_IOS_SMOKE_SKIP_SIM=1')
} else if (process.platform !== 'darwin') {
  console.log(`— live simulator part (SKIPPED: non-macOS host ${process.platform}) —`)
  step('live log capture against a booted simulator', true, 'skipped: simulator tools require macOS')
} else {
  console.log('— live log capture against a booted simulator —')
  let udid
  let deviceName
  let bootedBySmoke = false
  const baselinePids = new Set(logToolPids())
  try {
    const devices = await listDevices()
    const iphones = devices.filter(device => device.name.startsWith('iPhone'))
    if (iphones.length === 0) throw new Error('no available iPhone simulators')
    const byRuntime = (a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true })
    const picked = iphones.sort(byRuntime)[0]
    udid = picked.udid
    deviceName = picked.name
    step('pick iPhone simulator', true, `${deviceName} (${picked.runtime}, ${udid})`)

    await bootDevice(udid)
    bootedBySmoke = true
    step('boot simulator', true, `${deviceName} booted`)

    // ── 2. launch the stock Settings app ────────────────────────────────────
    execFileSync('xcrun', ['simctl', 'launch', udid, 'com.apple.Preferences'], { stdio: 'ignore', timeout: 60_000 })
    await delay(4_000)
    step('launch com.apple.Preferences', true, 'launched, 4s settle')

    // ── 3. snapshot with a process predicate ────────────────────────────────
    const snapshot = await tools.iosSimLogs.execute(
      { mode: 'snapshot', predicate: 'process == "Preferences"' },
      makeExec('ios_sim_logs', { mode: 'snapshot', predicate: 'process == "Preferences"' }),
    )
    step(
      'snapshot predicate process == "Preferences" returns >0 lines',
      snapshot.mode === 'snapshot' && snapshot.window === 'last 2m'
        && snapshot.device.udid === udid && snapshot.lineCount > 0
        && capInvariants(snapshot),
      `lineCount=${snapshot.lineCount} truncated=${snapshot.truncated}`,
    )

    // ── 4. bundle_id convenience filter ─────────────────────────────────────
    const byBundle = await tools.iosSimLogs.execute(
      { mode: 'snapshot', bundle_id: 'com.apple.Preferences' },
      makeExec('ios_sim_logs', { mode: 'snapshot', bundle_id: 'com.apple.Preferences' }),
    )
    step(
      'bundle_id convenience filter captures the app logs',
      byBundle.mode === 'snapshot' && byBundle.lineCount > 0 && capInvariants(byBundle),
      `lineCount=${byBundle.lineCount}`,
    )

    // ── 5. follow 5s window returns; its process is gone afterwards ─────────
    const followStart = Date.now()
    const follow = await tools.iosSimLogs.execute(
      { mode: 'follow', duration_seconds: 5, predicate: 'process == "Preferences"' },
      makeExec('ios_sim_logs', { mode: 'follow', duration_seconds: 5, predicate: 'process == "Preferences"' }),
    )
    const followElapsed = Date.now() - followStart
    step(
      'follow 5s window returns the bounded envelope',
      follow.mode === 'follow' && follow.window === 'follow 5s'
        && follow.device.udid === udid && followElapsed >= 4_000 && followElapsed <= 15_000
        && capInvariants(follow),
      `${followElapsed} ms, lineCount=${follow.lineCount}`,
    )
    await delay(2_500) // beyond the tool's SIGTERM→SIGKILL grace
    const leakedPids = logToolPids().filter(pid => !baselinePids.has(pid))
    step(
      'follow left no log process behind',
      leakedPids.length === 0,
      leakedPids.length === 0 ? 'pgrep log stream|show: no new processes' : `leaked pids: ${leakedPids.join(', ')}`,
    )

    // ── 6. cap enforcement: unpredicated noisy capture ──────────────────────
    let noisy = null
    for (const seconds of [10, 20, 30]) {
      noisy = await tools.iosSimLogs.execute(
        { mode: 'follow', duration_seconds: seconds },
        makeExec('ios_sim_logs', { mode: 'follow', duration_seconds: seconds }),
      )
      if (!capInvariants(noisy)) break
      if (noisy.truncated) break
    }
    step(
      'unpredicated noisy capture hits the cap and flags it',
      noisy !== null && noisy.truncated === true
        && noisy.lineCount > 0 && capInvariants(noisy),
      noisy === null ? 'no capture' : `lineCount=${noisy.lineCount} bytes=${logBytes(noisy)} truncated=${noisy.truncated}`,
    )

    // ── 7. client-side grep ─────────────────────────────────────────────────
    execFileSync('xcrun', ['simctl', 'launch', udid, 'com.apple.Preferences'], { stdio: 'ignore', timeout: 60_000 })
    await delay(4_000)
    const keepGrep = await tools.iosSimLogs.execute(
      { mode: 'snapshot', predicate: 'process == "Preferences"', grep: 'Preferences' },
      makeExec('ios_sim_logs', { mode: 'snapshot', predicate: 'process == "Preferences"', grep: 'Preferences' }),
    )
    const keepLogLines = keepGrep.truncated ? keepGrep.lines.slice(0, keepGrep.lineCount) : keepGrep.lines
    step(
      'grep keeps matching lines only (client-side)',
      keepGrep.lineCount > 0 && keepLogLines.every(line => /Preferences/.test(line)) && capInvariants(keepGrep),
      `lineCount=${keepGrep.lineCount}`,
    )
    const dropGrep = await tools.iosSimLogs.execute(
      { mode: 'snapshot', predicate: 'process == "Preferences"', grep: 'NO_SUCH_MARKER_xyzzy' },
      makeExec('ios_sim_logs', { mode: 'snapshot', predicate: 'process == "Preferences"', grep: 'NO_SUCH_MARKER_xyzzy' }),
    )
    step('grep that matches nothing returns zero lines', dropGrep.lineCount === 0 && dropGrep.lines.length <= 1, `lineCount=${dropGrep.lineCount}`)
    let grepError = ''
    try {
      await tools.iosSimLogs.execute(
        { mode: 'snapshot', predicate: 'process == "Preferences"', grep: '[' },
        makeExec('ios_sim_logs', { mode: 'snapshot', predicate: 'process == "Preferences"', grep: '[' }),
      )
    } catch (error) {
      grepError = error instanceof Error ? error.message : String(error)
    }
    step(
      'invalid grep regex is rejected with a clear error',
      /not a valid regular expression/.test(grepError),
      grepError,
    )

    // ── 8. concurrent follow captures settle independently ──────────────────
    const concurrent = await Promise.all([
      tools.iosSimLogs.execute(
        { mode: 'follow', duration_seconds: 4, predicate: 'process == "Preferences"' },
        makeExec('ios_sim_logs', { mode: 'follow', duration_seconds: 4, predicate: 'process == "Preferences"' }),
      ),
      tools.iosSimLogs.execute(
        { mode: 'follow', duration_seconds: 4, predicate: 'process == "Preferences"' },
        makeExec('ios_sim_logs', { mode: 'follow', duration_seconds: 4, predicate: 'process == "Preferences"' }),
      ),
    ])
    step(
      'concurrent follow captures settle independently',
      concurrent.length === 2
        && concurrent.every(result => result.mode === 'follow' && result.window === 'follow 4s' && capInvariants(result)),
      `lineCounts=${concurrent.map(result => result.lineCount).join(',')}`,
    )

    // ── 9. cleanup: shutdown sims, no leftover log processes ────────────────
    await shutdownDevice(udid)
    bootedBySmoke = false
    const leftDevices = (await bootedDevices()).map(device => `${device.name} ${device.udid}`)
    step('simulators shut down', leftDevices.length === 0, leftDevices.join(', ') || 'none')
    await delay(1_000)
    const residuePids = logToolPids().filter(pid => !baselinePids.has(pid))
    step(
      'no leftover log processes after cleanup',
      residuePids.length === 0,
      residuePids.length === 0 ? 'pgrep log stream|show: clean' : `leftover pids: ${residuePids.join(', ')}`,
    )
  } catch (error) {
    step('live log smoke completed without uncaught errors', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
  } finally {
    // ── best-effort cleanup no matter what happened ─────────────────────────
    try {
      if (controller !== undefined) await controller.dispose()
    } catch { /* already disposed or teardown best-effort */ }
    try {
      if (bootedBySmoke && udid !== undefined) await shutdownDevice(udid)
    } catch { /* already shut down */ }
    try {
      const left = await bootedDevices()
      for (const device of left) {
        try { await shutdownDevice(device.udid) } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
    try {
      execFileSync('pkill', ['-f', 'simctl spawn'], { stdio: 'ignore', timeout: 10_000 })
    } catch { /* pkill exit 1 = nothing to kill */ }
  }
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
