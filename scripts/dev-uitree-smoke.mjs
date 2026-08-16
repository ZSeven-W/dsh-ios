/**
 * Development smoke test for the dsh-ios UI-tree semantic tools
 * (`ios_sim_ui_tree` / `ios_sim_tap_element`, AXe-backed).
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-uitree-smoke.mjs
 *
 * Parts:
 *   A. factory shape (names, timeouts, concurrency flags)
 *   B. AXe helper resolution: default (PATH/brew/cache) must resolve;
 *      a fresh-cache pinned download into a temp dir verifies the
 *      URL+SHA-256+extract+integrity pipeline (soft-warn when offline)
 *   C. degradation: env override to a missing binary + offline mode yields
 *      the explanatory install-hint error, and restoring resolves again
 *   D. unit checks: selector resolution (nested-chain collapse, ambiguity
 *      candidate list, case-insensitive contains) and the ~40 KB cap with
 *      deepest-level pruning
 *   E. real simulator: boot an iPhone, launch Settings, dump the tree
 *      (recognizable entries incl. /General|通用/), tap the General row by
 *      label, confirm navigation (/About|关于/ appears), ambiguity error
 *      path, max_depth/filter behavior, tool-level degradation
 *   F. cleanup: shutdown, no stray axe/serve-sim processes
 *
 * Set DSH_IOS_SMOKE_SKIP_SIM=1 to skip the parts that boot a simulator.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_SIM_PART = process.env.DSH_IOS_SMOKE_SKIP_SIM === '1'

const { bootDevice, bootedDevices, listDevices, shutdownDevice } = await import(join(root, 'lib', 'simctl.js'))
const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))
const { createSimUiTools, IOS_UI_TOOL_NAMES, capTreeToBytes, resolveTapTarget } = await import(join(root, 'lib', 'tool-uitree.js'))
const {
  AXE_INSTALL_HINT,
  AXE_RELEASE_SHA256,
  AXE_VERSION,
  ensureAxeBinary,
  execAxe,
  resolveAxeBinary,
  sanitizeAxeNode,
} = await import(join(root, 'lib', 'uitree-backend.js'))

const results = []
function step(name, ok, detail = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  results.push({ name, ok })
  console.log(`${verdict} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
function warn(name, detail = '') {
  console.log(`WARN ${name}${detail === '' ? '' : ` — ${detail}`}`)
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

function collectLabels(tree, labels = []) {
  for (const node of tree) {
    if (typeof node.label === 'string' && node.label !== '') labels.push(node.label)
    collectLabels(node.children ?? [], labels)
  }
  return labels
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

let controller
let uiTools
let udid
let deviceName
let bootedBySmoke = false
const tempDirs = []

/** Save + restore an env var; `undefined` means it was absent (delete). */
function withEnv(patch, task) {
  const prior = {}
  for (const [key, value] of Object.entries(patch)) {
    prior[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return Promise.resolve()
    .then(task)
    .finally(() => {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
}

try {
  controller = new SimHostController()
  uiTools = createSimUiTools(controller)

  // ── A. factory shape ──────────────────────────────────────────────────────
  const factoryNames = [uiTools.iosSimUiTree.name, uiTools.iosSimTapElement.name]
  step(
    'factory produces the two ios_sim_ui_* tools',
    factoryNames.join(',') === IOS_UI_TOOL_NAMES.join(','),
    factoryNames.join(' '),
  )
  step(
    'ui_tree is concurrency-safe, tap_element stays exclusive',
    uiTools.iosSimUiTree.isConcurrencySafe({}) === true
      && uiTools.iosSimTapElement.isConcurrencySafe === undefined,
    'tree=safe tap=exclusive',
  )
  step(
    'tool timeouts cover the first-use download',
    uiTools.iosSimUiTree.timeoutMs >= 240_000 && uiTools.iosSimTapElement.timeoutMs >= 240_000,
    `tree=${uiTools.iosSimUiTree.timeoutMs} tap=${uiTools.iosSimTapElement.timeoutMs}`,
  )

  // ── B. helper resolution + pinned download pipeline ──────────────────────
  const resolved = await ensureAxeBinary()
  step(
    'AXe helper resolves (PATH/brew/plugin cache)',
    resolved.available === true && typeof resolved.command === 'string',
    `source=${resolved.source} command=${resolved.command}`,
  )
  if (resolved.available) {
    const version = await execAxe(resolved, ['--version'])
    step('resolved axe reports the pinned version', version.stdout.includes(AXE_VERSION), version.stdout.trim())
  } else {
    throw new Error(`AXe helper unavailable (${resolved.reason}); ${resolved.installHint}`)
  }

  const dlDir = mkdtempSync(join(tmpdir(), 'dsh-ios-axe-dl-'))
  tempDirs.push(dlDir)
  try {
    const fresh = await withEnv({ DSH_IOS_AXE_DIR: dlDir, DSH_IOS_AXE_OFFLINE: undefined }, async () => {
      return ensureAxeBinary()
    })
    const digestFile = join(dlDir, 'axe', AXE_VERSION, '.dsh-ios-axe.sha256')
    const integrity = fresh.available && fresh.source === 'cache'
      && existsSync(fresh.command ?? '') && existsSync(digestFile)
    step(
      'fresh-cache pinned download: URL + SHA-256 + extract + integrity record',
      integrity,
      fresh.available ? `downloaded into ${dlDir}` : `failed: ${fresh.reason}`,
    )
  } catch (error) {
    warn('fresh-cache download could not complete (network?), warm cache still works', String(error.message).slice(0, 160))
  } finally {
    rmSync(dlDir, { recursive: true, force: true })
  }
  step('release digest constant is a well-formed sha256', /^[0-9a-f]{64}$/.test(AXE_RELEASE_SHA256), AXE_RELEASE_SHA256)

  // ── C. degradation (resolution-only, no sim needed) ──────────────────────
  await withEnv({ DSH_IOS_AXE_BIN: '/nonexistent/axe-does-not-exist', DSH_IOS_AXE_OFFLINE: '1' }, async () => {
    const degraded = await ensureAxeBinary()
    step(
      'missing helper degrades with an install hint',
      degraded.available === false
        && String(degraded.reason).includes('DSH_IOS_AXE_BIN')
        && degraded.installHint.includes('brew install cameroncooke/axe/axe'),
      degraded.installHint,
    )
    step('install hint matches the documented brew step', AXE_INSTALL_HINT.includes('brew install cameroncooke/axe/axe'))
  })
  const restored = await ensureAxeBinary()
  step('resolution recovers after env restore', restored.available === true, `source=${restored.source}`)

  // ── D. selector + cap unit checks ────────────────────────────────────────
  const mkNode = (type, label, identifier, frame, children = []) => sanitizeAxeNode({
    type, AXLabel: label, AXUniqueId: identifier, AXValue: null,
    frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] },
    children,
  })
  const chainRoots = [
    mkNode('Application', null, null, [0, 0, 400, 800], [
      mkNode('Button', 'General', 'row.general', [16, 100, 370, 52], [
        mkNode('StaticText', 'General', null, [30, 110, 80, 30]),
      ]),
    ]),
  ]
  const chainHit = resolveTapTarget(chainRoots, { label: 'General' })
  step(
    'nested duplicates collapse to the outer tappable container',
    chainHit.element.type === 'Button' && chainHit.element.identifier === 'row.general'
      && chainHit.matchedBy === 'exact',
    `type=${chainHit.element.type} identifier=${chainHit.element.identifier}`,
  )
  const containsHit = resolveTapTarget(chainRoots, { label: 'general' })
  step('case-insensitive contains falls back when exact misses', containsHit.element.type === 'Button' && containsHit.matchedBy === 'contains')
  const ambiguousRoots = [
    mkNode('Application', null, null, [0, 0, 400, 800], [
      mkNode('Button', 'Delete', 'del.1', [16, 100, 370, 52]),
      mkNode('Button', 'Delete', 'del.2', [16, 160, 370, 52]),
    ]),
  ]
  let ambiguityError = ''
  try {
    resolveTapTarget(ambiguousRoots, { label: 'Delete' })
  } catch (error) {
    ambiguityError = String(error.message)
  }
  step(
    'distinct duplicates raise an ambiguity error listing candidates',
    ambiguityError.includes('2 elements match')
      && ambiguityError.includes('del.1') && ambiguityError.includes('del.2')
      && ambiguityError.includes('frame='),
    ambiguityError.split('\n')[0],
  )
  let noMatchError = ''
  try {
    resolveTapTarget(ambiguousRoots, { identifier: 'nope' })
  } catch (error) {
    noMatchError = String(error.message)
  }
  step('no matches raise a tree-inspection hint', noMatchError.includes('no accessibility element matches') && noMatchError.includes('ios_sim_ui_tree'))

  const deepLabel = 'row-item-with-a-fairly-long-label-'
  const deep = [mkNode('Application', null, null, [0, 0, 400, 800], [])]
  let cursor = deep[0]
  for (let i = 0; i < 120; i += 1) {
    const child = mkNode('Group', `${deepLabel}${i}`, null, [0, 0, 400, 800], [])
    cursor.children.push(child)
    cursor = child
  }
  const uncappedBytes = Buffer.byteLength(JSON.stringify(deep))
  const capped = capTreeToBytes(deep, 4096)
  const cappedBytes = Buffer.byteLength(JSON.stringify(capped.tree))
  const cappedDepth = (() => {
    let d = 0
    let node = capped.tree[0]
    while (node.children.length > 0) { d += 1; node = node.children[0] }
    return d
  })()
  step(
    'size cap prunes deepest levels first and sets truncated',
    uncappedBytes > 4096 && cappedBytes <= 4096 && capped.truncated === true && cappedDepth > 0 && cappedDepth < 120,
    `${uncappedBytes} bytes → ${cappedBytes} bytes, depth ${cappedDepth}`,
  )
  const smallCapped = capTreeToBytes(chainRoots.map(node => ({ type: node.type, label: node.label, identifier: node.identifier, frame: node.frame, children: [] })))
  step('under-cap trees pass through untruncated', smallCapped.truncated === false && smallCapped.tree.length === 1)

  if (SKIP_SIM_PART) {
    step('simulator part skipped by DSH_IOS_SMOKE_SKIP_SIM=1', true)
  } else {
    // ── E. real simulator ────────────────────────────────────────────────────
    const devices = await listDevices()
    const iphones = devices.filter(d => d.name.startsWith('iPhone'))
    if (iphones.length === 0) throw new Error('no available iPhone simulators')
    const picked = iphones.sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }))[0]
    udid = picked.udid
    deviceName = picked.name
    step('pick iPhone simulator', true, `${deviceName} (${picked.runtime}, ${udid})`)

    await bootDevice(udid)
    bootedBySmoke = true
    step('simulator booted', (await bootedDevices()).some(d => d.udid === udid), udid)

    try { execFileSync('xcrun', ['simctl', 'terminate', udid, 'com.apple.Preferences'], { stdio: 'ignore', timeout: 30_000 }) } catch { /* not running */ }
    execFileSync('xcrun', ['simctl', 'launch', udid, 'com.apple.Preferences'], { stdio: 'ignore', timeout: 60_000 })
    step('Settings launched', true, 'com.apple.Preferences')

    // Poll until the root Settings page renders (recognizable rows).
    let rootTree
    let generalLabel
    const deadline = Date.now() + 120_000
    for (;;) {
      rootTree = await uiTools.iosSimUiTree.execute({}, makeExec('ios_sim_ui_tree', {}))
      const labels = collectLabels(rootTree.tree)
      generalLabel = labels.find(label => /General|通用/.test(label))
      if (generalLabel !== undefined || Date.now() > deadline) break
      await sleep(2_000)
    }
    step(
      'ios_sim_ui_tree returns a tree with a recognizable Settings row',
      rootTree.nodeCount > 0 && generalLabel !== undefined,
      `row label=${JSON.stringify(generalLabel)}, ${rootTree.nodeCount} nodes`,
    )
    step(
      'tree reports device point dimensions consistent with the app root',
      rootTree.size.width > 0 && rootTree.size.height > 0
        && rootTree.tree[0]?.frame?.w === rootTree.size.width
        && rootTree.tree[0]?.frame?.h === rootTree.size.height,
      `${rootTree.size.width}x${rootTree.size.height} points`,
    )
    step('Settings tree fits the cap untruncated', rootTree.truncated !== true, `${rootTree.nodeCount} nodes`)

    const depth1 = await uiTools.iosSimUiTree.execute({ max_depth: 1 }, makeExec('ios_sim_ui_tree', { max_depth: 1 }))
    const depth1Leaves = depth1.tree.flatMap(node => node.children ?? [])
    step(
      'max_depth=1 collapses the tree below the root',
      depth1.nodeCount > 0 && depth1.nodeCount < rootTree.nodeCount
        && depth1Leaves.length > 0 && depth1Leaves.every(node => (node.children ?? []).length === 0),
      `${depth1.nodeCount} nodes`,
    )
    const filtered = await uiTools.iosSimUiTree.execute({ filter: generalLabel }, makeExec('ios_sim_ui_tree', { filter: generalLabel }))
    const filterHits = collectLabels(filtered.tree)
    step(
      'filter keeps matching elements (+ ancestors) and shrinks the tree',
      filtered.nodeCount > 0 && filtered.nodeCount < rootTree.nodeCount
        && filterHits.includes(generalLabel),
      `${filtered.nodeCount} nodes`,
    )

    // Ambiguity: the root page lists many chevron.forward images.
    let ambiguity = ''
    try {
      await uiTools.iosSimTapElement.execute({ identifier: 'chevron' }, makeExec('ios_sim_tap_element', { identifier: 'chevron' }))
    } catch (error) {
      ambiguity = String(error.message)
    }
    step(
      'ambiguous selector errors with a candidate list (labels+frames)',
      ambiguity.includes('elements match') && ambiguity.includes('Candidates') && ambiguity.includes('frame='),
      ambiguity.split('\n')[0],
    )

    const tapped = await uiTools.iosSimTapElement.execute({ label: generalLabel }, makeExec('ios_sim_tap_element', { label: generalLabel }))
    const frame = tapped.element?.frame ?? {}
    const centerOk = typeof tapped.center?.x === 'number' && typeof tapped.center?.y === 'number'
      && tapped.center.x >= frame.x && tapped.center.x <= frame.x + frame.w
      && tapped.center.y >= frame.y && tapped.center.y <= frame.y + frame.h
    step(
      'ios_sim_tap_element taps the matched element center',
      tapped.action === 'tap-element' && (tapped.element?.label === generalLabel || tapped.element?.identifier !== undefined)
        && centerOk,
      `center=(${tapped.center.x}, ${tapped.center.y}) frame=(${frame.x},${frame.y},${frame.w},${frame.h})`,
    )
    step(
      'tap returns a fresh screenshot summary (interact shape)',
      typeof tapped.path === 'string' && existsSync(tapped.path) && tapped.bytes > 10 * 1024
        && tapped.device?.udid === udid,
      `${Math.round(tapped.bytes / 1024)} KB ${tapped.path}`,
    )
    const tapMeta = uiTools.iosSimTapElement.output.presentationMeta({ label: generalLabel }, tapped)
    step(
      'tap presentationMeta matches the ios_sim_interact envelope',
      tapMeta.kind === 'sim-screenshot' && tapMeta.screenshotPath === tapped.path && tapMeta.path === tapped.path,
      JSON.stringify(tapMeta),
    )

    const afterTree = await uiTools.iosSimUiTree.execute({}, makeExec('ios_sim_ui_tree', {}))
    const afterLabels = collectLabels(afterTree.tree)
    step(
      'navigation happened (General page rendered)',
      afterLabels.some(label => /About|关于/.test(label)),
      `labels include ${JSON.stringify(afterLabels.find(label => /About|关于/.test(label)))}`,
    )

    // Tool-level degradation while the device is booted.
    let degradedError = ''
    await withEnv({ DSH_IOS_AXE_BIN: '/nonexistent/axe-does-not-exist', DSH_IOS_AXE_OFFLINE: '1' }, async () => {
      try {
        await uiTools.iosSimUiTree.execute({}, makeExec('ios_sim_ui_tree', {}))
      } catch (error) {
        degradedError = String(error.message)
      }
    })
    step(
      'ui_tree throws the explanatory install hint when the helper is missing',
      degradedError.includes('ios_sim_ui_tree') && degradedError.includes('AXe accessibility helper is unavailable')
        && degradedError.includes('brew install cameroncooke/axe/axe'),
      degradedError.split(';')[0],
    )
    const recovered = await uiTools.iosSimUiTree.execute({ max_depth: 0 }, makeExec('ios_sim_ui_tree', { max_depth: 0 }))
    step('ui_tree recovers after the override is cleared', recovered.nodeCount >= 1, `${recovered.nodeCount} nodes`)
  }

  // ── F. cleanup ─────────────────────────────────────────────────────────────
  if (bootedBySmoke && udid !== undefined) {
    await shutdownDevice(udid)
    bootedBySmoke = false
  }
  const leftDevices = (await bootedDevices()).map(d => `${d.name} ${d.udid}`)
  step('no booted simulators left', leftDevices.length === 0, leftDevices.join(', ') || 'none')

  let axeProcs = ''
  try {
    axeProcs = execFileSync('pgrep', ['-fl', 'axe (describe-ui|tap|list-simulators)'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch { /* pgrep exit 1 = no matches, which is what we want */ }
  step('no stray axe processes left', axeProcs === '', axeProcs || 'none')

  let serveSimProcs = ''
  try {
    serveSimProcs = execFileSync('pgrep', ['-fl', 'serve-sim'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch { /* none */ }
  step('no serve-sim processes left', serveSimProcs === '', serveSimProcs || 'none')
} catch (error) {
  step('smoke completed without uncaught errors', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  // ── best-effort cleanup no matter what happened ───────────────────────────
  try {
    if (controller !== undefined) await controller.dispose()
  } catch { /* already disposed */ }
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
    execFileSync('pkill', ['-f', 'serve-sim'], { stdio: 'ignore', timeout: 10_000 })
  } catch { /* pkill exit 1 = nothing to kill */ }
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
