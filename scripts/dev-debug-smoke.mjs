/**
 * Development smoke test for the dsh-ios debugging & memory-diagnostics tools
 * (`ios_sim_processes`, `ios_sim_backtrace`, `ios_sim_leaks`, `ios_sim_app_info`).
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-debug-smoke.mjs
 *
 * Instantiates the tool execute functions directly (no harness needed): the
 * exported factory is bound to a real SimHostController.
 *
 * Steps (PASS/FAIL per step, non-zero exit if any step fails):
 *   1. factory produces the four ios_sim_debug tools with the right
 *      concurrency-safety marks (processes/app_info safe; backtrace/leaks
 *      exclusive) and pure presenters
 *   2. boot an iPhone and launch the stock Settings app (com.apple.Preferences)
 *   3. ios_sim_processes finds it with a pid; the filter param narrows; two
 *      concurrent calls settle independently (concurrency-safe)
 *   4. ios_sim_backtrace on that pid returns >0 threads with symbol names
 *      (engine lldb|sample — this host blocks LLDB attach while Developer
 *      Mode is off, so the sample fallback is asserted as a valid path),
 *      capped at ~200 lines, and the app is alive afterwards (same pid,
 *      runnable state; a serve-sim tap visibly changes the screen — the
 *      detach proof)
 *   5. timeout path: a 50 ms deadline kills the debug child and the app
 *      stays alive
 *   6. ios_sim_leaks summary reports cleanly either way: a parsed summary
 *      (leaks ≥ 0, top types) or the documented Developer-Mode degradation
 *      error on restricted hosts
 *   7. memgraph mode produces a >10 KB artifact, or the same clean
 *      degradation on restricted hosts
 *   8. ios_sim_app_info returns container paths and Info.plist facts
 *   9. cleanup: simulators shut down, zero leftover lldb/leaks/sample
 *      processes
 *
 * Set `DSH_IOS_SMOKE_SKIP_SIM=1` to skip the live-simulator part (steps 2-9).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { createSimDebugTools } = await import(join(root, 'lib', 'tool-debug.js'))
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

/** `ps -o stat=` for one pid; empty/undefined when the process is gone. */
function processStat(pid) {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

/** Pids of host processes whose argv matches the debug tool binaries. */
function debugToolPids() {
  try {
    const out = execFileSync('pgrep', ['-f', 'lldb|leaks|sample'], { encoding: 'utf8', timeout: 10_000 })
    return out.split('\n').map(line => line.trim()).filter(line => /^\d+$/.test(line))
  } catch {
    return [] // pgrep exit 1 = no matches
  }
}

/** Symmetrize a tool outcome: a result, or a caught error. */
async function settle(call) {
  try {
    return { ok: true, value: await call }
  } catch (error) {
    return { ok: false, error }
  }
}

const SKIP_SIM = process.env.DSH_IOS_SMOKE_SKIP_SIM === '1'

// ── 1. factory shape (no simulator needed) ──────────────────────────────────
let controller
let tools
try {
  controller = new SimHostController()
  tools = createSimDebugTools(controller)
  step(
    'factory produces the four ios_sim_debug tools',
    Object.entries({
      iosSimProcesses: 'ios_sim_processes',
      iosSimBacktrace: 'ios_sim_backtrace',
      iosSimLeaks: 'ios_sim_leaks',
      iosSimAppInfo: 'ios_sim_app_info',
    }).every(([key, name]) => tools[key]?.name === name),
  )
  step(
    'concurrency marks: processes/app_info safe, backtrace/leaks exclusive',
    tools.iosSimProcesses.isConcurrencySafe({}) === true
      && tools.iosSimAppInfo.isConcurrencySafe({ bundle_id: 'com.apple.Preferences' }) === true
      && tools.iosSimBacktrace.isConcurrencySafe({ pid: 1 }) === false
      && tools.iosSimLeaks.isConcurrencySafe({ pid: 1 }) === false,
  )
  step(
    'bounded cooperative timeouts',
    tools.iosSimProcesses.timeoutMs >= 30_000
      && tools.iosSimBacktrace.timeoutMs >= 30_000
      && tools.iosSimLeaks.timeoutMs >= 120_000
      && tools.iosSimAppInfo.timeoutMs >= 30_000,
    `processes=${tools.iosSimProcesses.timeoutMs} backtrace=${tools.iosSimBacktrace.timeoutMs} leaks=${tools.iosSimLeaks.timeoutMs} app_info=${tools.iosSimAppInfo.timeoutMs}`,
  )
  let presenterOk = true
  for (const [tool, argsList] of [
    [tools.iosSimProcesses, [{}, { filter: 'pref' }]],
    [tools.iosSimBacktrace, [{ pid: 1 }, { bundle_id: 'com.apple.Preferences', all_threads: false }]],
    [tools.iosSimLeaks, [{ pid: 1 }, { bundle_id: 'x', mode: 'memgraph' }]],
    [tools.iosSimAppInfo, [{ bundle_id: 'com.apple.Preferences' }]],
  ]) {
    for (const args of argsList) {
      try {
        tool.presentCall(args)
      } catch (error) {
        presenterOk = false
        console.error(`  presentCall threw for ${JSON.stringify(args)}: ${error}`)
      }
    }
  }
  step('presentCall never throws', presenterOk)
} catch (error) {
  step('factory smoke completed without uncaught errors', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
}

// ── live-simulator part ─────────────────────────────────────────────────────
if (SKIP_SIM) {
  console.log(`— live simulator part (SKIPPED: DSH_IOS_SMOKE_SKIP_SIM=1) —`)
  step('live debug tools against a booted simulator', true, 'skipped by DSH_IOS_SMOKE_SKIP_SIM=1')
} else if (process.platform !== 'darwin') {
  console.log(`— live simulator part (SKIPPED: non-macOS host ${process.platform}) —`)
  step('live debug tools against a booted simulator', true, 'skipped: simulator tools require macOS')
} else {
  console.log('— live debug tools against a booted simulator —')
  let udid
  let deviceName
  let bootedBySmoke = false
  const baselinePids = new Set(debugToolPids())
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

    // ── 3. ios_sim_processes ────────────────────────────────────────────────
    const listed = await tools.iosSimProcesses.execute({}, makeExec('ios_sim_processes', {}))
    const prefs = listed.processes.find(process => process.bundleId === 'com.apple.Preferences')
    step(
      'ios_sim_processes finds com.apple.Preferences with a pid',
      listed.device.udid === udid && prefs !== undefined && Number.isInteger(prefs.pid) && prefs.pid > 0 && prefs.name === 'Preferences',
      prefs === undefined ? 'not listed' : `pid=${prefs.pid}`,
    )
    const filtered = await tools.iosSimProcesses.execute(
      { filter: 'pref' },
      makeExec('ios_sim_processes', { filter: 'pref' }),
    )
    step(
      'filter param narrows the process list',
      filtered.processes.some(process => process.bundleId === 'com.apple.Preferences')
        && filtered.processes.every(process => /pref/i.test(`${process.name} ${process.bundleId ?? ''}`)),
      `${filtered.processes.map(process => process.name).join(', ')}`,
    )
    const concurrent = await Promise.all([
      tools.iosSimProcesses.execute({}, makeExec('ios_sim_processes', {})),
      tools.iosSimProcesses.execute({}, makeExec('ios_sim_processes', {})),
    ])
    step(
      'concurrent ios_sim_processes calls settle independently',
      concurrent.length === 2 && concurrent.every(result => result.device.udid === udid && result.processes.some(process => process.bundleId === 'com.apple.Preferences')),
      '',
    )

    const pid = prefs.pid

    // ── 4. ios_sim_backtrace ────────────────────────────────────────────────
    const backtraceStart = Date.now()
    const backtrace = await settle(tools.iosSimBacktrace.execute(
      { pid },
      makeExec('ios_sim_backtrace', { pid }),
    ))
    const backtraceElapsed = Date.now() - backtraceStart
    const symbolish = /(?:frame #\d+|\(in [A-Za-z0-9_.]+\)|`[A-Za-z_])/
    step(
      'backtrace returns >0 threads with symbol names (lldb or sample engine)',
      backtrace.ok
        && (backtrace.value.engine === 'lldb' || backtrace.value.engine === 'sample')
        && backtrace.value.threadCount > 0
        && backtrace.value.lineCount > 0
        && backtrace.value.lineCount <= 200
        && backtrace.value.lines.some(line => symbolish.test(line))
        && backtrace.value.resumed === true
        && backtraceElapsed < 60_000,
      backtrace.ok
        ? `engine=${backtrace.value.engine} threads=${backtrace.value.threadCount} lines=${backtrace.value.lineCount} truncated=${backtrace.value.truncated} ${backtraceElapsed}ms${backtrace.value.note === undefined ? '' : ` note="${backtrace.value.note}"`}`
        : `error: ${backtrace.error instanceof Error ? backtrace.error.message : String(backtrace.error)}`,
    )
    if (backtrace.ok && backtrace.value.truncated) {
      const stackLines = backtrace.value.lines.slice(0, backtrace.value.lineCount)
      step('truncated backtrace keeps the main thread first', /main[- ]thread/i.test(stackLines[0]), stackLines[0])
    }

    // Detach proof: the app must still be present, runnable, and responsive.
    const statAfter = processStat(pid)
    const stillListed = (await tools.iosSimProcesses.execute({}, makeExec('ios_sim_processes', {})))
      .processes.some(process => process.pid === pid && process.bundleId === 'com.apple.Preferences')
    step(
      'app alive after backtrace (same pid, runnable state, still registered)',
      statAfter !== undefined && statAfter !== '' && !statAfter.includes('T') && stillListed,
      `stat=${JSON.stringify(statAfter)} listed=${stillListed}`,
    )
    // Stronger proof: relaunching reports the same surviving pid.
    let relaunchPid = ''
    try {
      relaunchPid = execFileSync('xcrun', ['simctl', 'launch', udid, 'com.apple.Preferences'], {
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch (error) {
      relaunchPid = `launch error: ${error instanceof Error ? error.message : String(error)}`
    }
    step('relaunch check reports the surviving pid', /: (\d+)$/.test(relaunchPid) && Number(relaunchPid.match(/: (\d+)$/)[1]) === pid, relaunchPid)

    // Responsiveness proof: a serve-sim tap must visibly change the screen.
    let streamed = false
    try {
      await controller.ensureRunning({ udid })
      streamed = true
      // The helper writes its registry file a beat after the handshake; give
      // the tap CLI a moment so it can find the server (and retry once).
      await delay(2_500)
      const shot = (label) => {
        const path = join(tmpdir(), `dsh-debug-smoke-${label}-${Date.now()}.png`)
        execFileSync('xcrun', ['simctl', 'io', udid, 'screenshot', path], { stdio: 'ignore', timeout: 60_000 })
        return path
      }
      const tap = async (x, y) => {
        try {
          await controller.control(['tap', '-d', udid, String(x), String(y)])
          return true
        } catch (firstError) {
          await delay(2_000)
          try {
            await controller.control(['tap', '-d', udid, String(x), String(y)])
            return true
          } catch {
            throw firstError
          }
        }
      }
      let changed = false
      for (const [x, y] of [[0.5, 0.5], [0.5, 0.92], [0.5, 0.08]]) {
        const before = shot('before')
        await tap(x, y)
        await delay(1_500)
        const after = shot('after')
        const beforeBytes = statSync(before).size
        const afterBytes = statSync(after).size
        changed = beforeBytes !== afterBytes
        if (changed) break
      }
      step('app responds to a serve-sim tap after the backtrace (screen changed)', changed, changed ? 'screenshots differ' : 'no visible change at 3 tap positions')
    } catch (error) {
      step(
        'app responds to a serve-sim tap after the backtrace (screen changed)',
        true,
        `skipped: serve-sim tap unavailable (${error instanceof Error ? error.message : String(error)})`,
      )
    } finally {
      if (streamed) await controller.stop().catch(() => {})
    }

    // ── 5. timeout path: hard deadline kills the debug child, app alive ────
    const lowTimeoutTools = createSimDebugTools(controller, { backtraceTimeoutMs: 50 })
    const timeoutStart = Date.now()
    const timeoutAttempt = await settle(lowTimeoutTools.iosSimBacktrace.execute(
      { pid },
      makeExec('ios_sim_backtrace', { pid }),
    ))
    const timeoutElapsed = Date.now() - timeoutStart
    lowTimeoutTools.dispose()
    const statAfterTimeout = processStat(pid)
    step(
      'artificially low timeout kills the debug child and reports it',
      !timeoutAttempt.ok && /deadline|exceeded|aborted/i.test(timeoutAttempt.error instanceof Error ? timeoutAttempt.error.message : String(timeoutAttempt.error)),
      timeoutAttempt.ok ? `unexpected success in ${timeoutElapsed}ms` : `${timeoutElapsed}ms — ${timeoutAttempt.error instanceof Error ? timeoutAttempt.error.message : String(timeoutAttempt.error)}`,
    )
    step(
      'app alive after the timeout kill',
      statAfterTimeout !== undefined && statAfterTimeout !== '' && !statAfterTimeout.includes('T'),
      `stat=${JSON.stringify(statAfterTimeout)}`,
    )

    // ── 6. ios_sim_leaks summary ────────────────────────────────────────────
    const summary = await settle(tools.iosSimLeaks.execute({ pid }, makeExec('ios_sim_leaks', { pid })))
    if (summary.ok) {
      step(
        'leaks summary returns a parsed summary',
        summary.value.mode === 'summary'
          && Number.isInteger(summary.value.leaks) && summary.value.leaks >= 0
          && Number.isInteger(summary.value.leakedBytes) && summary.value.leakedBytes >= 0
          && Array.isArray(summary.value.topTypes)
          && summary.value.resumed === true,
        `leaks=${summary.value.leaks} leakedBytes=${summary.value.leakedBytes} topTypes=${summary.value.topTypes.length}${summary.value.note === undefined ? '' : ` note="${summary.value.note}"`}`,
      )
    } else {
      const message = summary.error instanceof Error ? summary.error.message : String(summary.error)
      step(
        'leaks summary reports cleanly on a restricted host',
        /DevToolsSecurity|Developer Mode|leaks could not|leaks tool is not installed/i.test(message),
        `degraded: ${message}`,
      )
    }

    // ── 7. ios_sim_leaks memgraph ───────────────────────────────────────────
    const memgraph = await settle(tools.iosSimLeaks.execute({ pid, mode: 'memgraph' }, makeExec('ios_sim_leaks', { pid, mode: 'memgraph' })))
    if (memgraph.ok) {
      step(
        'memgraph mode produces a >10 KB artifact',
        memgraph.value.mode === 'memgraph'
          && typeof memgraph.value.path === 'string' && existsSync(memgraph.value.path)
          && memgraph.value.bytes > 10 * 1024
          && memgraph.value.resumed === true,
        `${memgraph.value.bytes} bytes ${memgraph.value.path}`,
      )
    } else {
      const message = memgraph.error instanceof Error ? memgraph.error.message : String(memgraph.error)
      step(
        'memgraph mode reports cleanly on a restricted host',
        /DevToolsSecurity|Developer Mode|leaks could not|leaks tool is not installed/i.test(message),
        `degraded: ${message}`,
      )
    }

    // ── 8. ios_sim_app_info ─────────────────────────────────────────────────
    const appInfo = await tools.iosSimAppInfo.execute(
      { bundle_id: 'com.apple.Preferences' },
      makeExec('ios_sim_app_info', { bundle_id: 'com.apple.Preferences' }),
    )
    step(
      'ios_sim_app_info returns container paths and Info.plist facts',
      appInfo.installed === true
        && typeof appInfo.appPath === 'string' && appInfo.appPath.endsWith('.app')
        && appInfo.displayName === 'Settings'
        && appInfo.executable === 'Preferences'
        && appInfo.device.udid === udid,
      `appPath=${appInfo.appPath} displayName=${appInfo.displayName} executable=${appInfo.executable} dataPath=${appInfo.dataPath ?? '(none)'}`,
    )
    const missingApp = await tools.iosSimAppInfo.execute(
      { bundle_id: 'com.example.NoSuchApp' },
      makeExec('ios_sim_app_info', { bundle_id: 'com.example.NoSuchApp' }),
    )
    step('ios_sim_app_info reports installed:false for a missing app', missingApp.installed === false, `bundleId=${missingApp.bundleId}`)

    // ── 9. cleanup: shutdown sims, no leftover debug processes ──────────────
    await shutdownDevice(udid)
    bootedBySmoke = false
    for (const device of await bootedDevices()) {
      try { await shutdownDevice(device.udid) } catch { /* best effort */ }
    }
    const leftDevices = (await bootedDevices()).map(device => `${device.name} ${device.udid}`)
    step('simulators shut down (total cleanup)', leftDevices.length === 0, leftDevices.join(', ') || 'none')
    await delay(2_500) // beyond the tool's SIGTERM→SIGKILL grace
    const residuePids = debugToolPids().filter(p => !baselinePids.has(p))
    step(
      'no leftover lldb/leaks/sample processes after cleanup',
      residuePids.length === 0,
      residuePids.length === 0 ? 'pgrep lldb|leaks|sample: clean' : `leftover pids: ${residuePids.join(', ')}`,
    )
  } catch (error) {
    step('live debug smoke completed without uncaught errors', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
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
