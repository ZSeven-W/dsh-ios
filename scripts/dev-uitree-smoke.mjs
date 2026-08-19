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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_SIM_PART = process.env.DSH_IOS_SMOKE_SKIP_SIM === '1'

const { bootDevice, bootedDevices, listDevices, shutdownDevice } = await import(join(root, 'lib', 'simctl.js'))
const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))
const {
  createSimOcrTools,
  createSimUiTools,
  IOS_UI_TOOL_NAMES,
  LIST_ROW_REDIRECT_HINT,
  capTreeToBytes,
  resolveTapTarget,
  buildTreeResult,
  wdaTree,
  hasLabeledNode,
  DEEPEN_SNAPSHOT_DEPTH,
  invalidateWdaTreeDepthMemory,
  rememberedWdaTreeDepth,
  resetWdaTreeDepthMemory,
} = await import(join(root, 'lib', 'tool-uitree.js'))
const { createSimRowTools, IOS_ROW_TOOL_NAMES, ROW_SNAPSHOT_DEPTH } = await import(join(root, 'lib', 'tool-list-rows.js'))
const { detectListRows, parseCountsFromLabel, planRowTap, requireCountKey, verifyCountChange, rowCountFor, MIN_REPEATED_ROWS } = await import(join(root, 'lib', 'list-rows.js'))
const { WDA_DEFAULT_SNAPSHOT_DEPTH } = await import(join(root, 'lib', 'wda-host.js'))
const { IOS_SKILL_CONTENT } = await import(join(root, 'lib', 'skill.js'))
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

/** Bundle-like identifiers that are not Apple-owned (rule-based, no app list). */
function nonAppleBundleIds(text) {
  const ids = String(text).match(/\b(?:com|org|net|io|app)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+\b/g) ?? []
  return [...new Set(ids.filter(id => !id.startsWith('com.apple.')))]
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

  // ── README i18n + logo delivery (pure files, no device) ──────────────────
  const readmeLocales = [
    ['README.md', 'English'],
    ['README.zh.md', '简体中文'],
    ['README.zh-TW.md', '繁體中文'],
    ['README.ja.md', '日本語'],
    ['README.ko.md', '한국어'],
    ['README.fr.md', 'Français'],
    ['README.es.md', 'Español'],
    ['README.de.md', 'Deutsch'],
    ['README.pt.md', 'Português'],
    ['README.ru.md', 'Русский'],
    ['README.hi.md', 'हिन्दी'],
    ['README.tr.md', 'Türkçe'],
    ['README.th.md', 'ไทย'],
    ['README.vi.md', 'Tiếng Việt'],
    ['README.id.md', 'Bahasa Indonesia'],
  ]
  const expectedReadmes = readmeLocales.map(([file]) => file).sort()
  const actualReadmes = readdirSync(root).filter(file => /^README(?:\.[^.]+(?:-[^.]+)?)?\.md$/.test(file)).sort()
  const readmes = new Map(readmeLocales.map(([file]) => [file, readFileSync(join(root, file), 'utf8')]))
  step(
    'README delivery contains exactly the 15 expected locales',
    actualReadmes.join('\n') === expectedReadmes.join('\n'),
    actualReadmes.join(', '),
  )
  const switchersValid = readmeLocales.every(([file, active]) => {
    const content = readmes.get(file)
    const switcher = content.split('\n').find(line => line.includes('&middot;') && line.includes('./README')) ?? ''
    return (switcher.match(/<a href=/g) ?? []).length === 14
      && switcher.includes(`<b>${active}</b>`)
      && !switcher.includes(`><b>${active}</b></a>`)
      && readmeLocales.every(([target, label]) => target === file
        ? switcher.includes(`<b>${label}</b>`)
        : switcher.includes(`<a href="./${target}">${label}</a>`))
  })
  step('every README switcher has 15 locales with only the current locale bold and unlinked', switchersValid)
  const logoBlock = '<p align="center">\n  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />\n</p>\n\n<h1 align="center">'
  step(
    'all 15 READMEs place the local 120px logo block above the centered h1',
    existsSync(join(root, 'docs', 'images', 'dsh-ios-logo.png'))
      && [...readmes.values()].every(content => content.startsWith(logoBlock)),
  )
  const englishLines = readmes.get('README.md').split('\n')
  const englishTables = englishLines.filter(line => line.startsWith('|'))
  const structureSignature = content => {
    const lines = content.split('\n')
    return JSON.stringify({
      headings: lines.filter(line => /^#{2,3} /.test(line)).map(line => line.match(/^#+/)[0].length),
      tableLines: lines.filter(line => line.startsWith('|')).length,
      fences: lines.filter(line => line.startsWith('```')).length,
    })
  }
  const englishSignature = structureSignature(readmes.get('README.md'))
  const structuralParity = [...readmes.values()].every(content => structureSignature(content) === englishSignature)
  const tablesTranslated = readmeLocales.filter(([file]) => file !== 'README.md').every(([file]) => {
    const tableLines = readmes.get(file).split('\n').filter(line => line.startsWith('|'))
    return tableLines.every((line, index) => /^\|[- :|]+$/.test(line) || line !== englishTables[index])
  })
  step(
    'localized READMEs preserve heading/table/fence structure and contain no unchanged English table rows',
    structuralParity && tablesTranslated,
    `signature=${englishSignature}`,
  )
  const nonAppleReadmeIds = nonAppleBundleIds([...readmes.values()].join('\n'))
  step(
    'README examples contain no non-Apple bundle identifiers',
    nonAppleReadmeIds.length === 0,
    nonAppleReadmeIds.join(', ') || 'none',
  )

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

  // ── D2. WP62: the hint is computed from what was SAMPLED, not a blanket
  // "the app has no accessibility information" claim; and the real-device tree
  // auto-deepens ONCE before ever telling the model to fall back to OCR.
  const staticDevice = { udid: 'STATIC-UDID', name: 'Static Phone', runtime: '26.0', state: 'booted' }
  const unlabeledRoot = mkNode('Application', null, null, [0, 0, 402, 874], [
    mkNode('Other', null, null, [16, 100, 100, 44]),
    mkNode('Other', null, null, [16, 160, 200, 44]),
  ])

  // 1. Filter miss → names the filter + sampled depth, never claims no-a11y.
  const filterMiss = buildTreeResult([unlabeledRoot], { width: 402, height: 874 }, staticDevice, { filter: '喜欢' }, { sampledDepth: 3 })
  step(
    'filter miss names the filter and sampled depth, never claims no accessibility info',
    filterMiss.sampledDepth === 3
      && String(filterMiss.hint ?? '').includes('喜欢')
      && /depth 3/.test(String(filterMiss.hint ?? ''))
      && !/accessibility information/i.test(String(filterMiss.hint ?? '')),
    String(filterMiss.hint ?? ''),
  )

  // 2. Shallow + unlabeled → names the depth and says re-run deeper; OCR is not first.
  const shallowTree = buildTreeResult([unlabeledRoot], { width: 402, height: 874 }, staticDevice, {}, { sampledDepth: 15 })
  step(
    'shallow unlabeled tree names the depth and says re-run deeper, not OCR first',
    shallowTree.sampledDepth === 15
      && /depth sampled \(15\)/.test(String(shallowTree.hint ?? ''))
      && /max_depth/.test(String(shallowTree.hint ?? ''))
      && /40/.test(String(shallowTree.hint ?? ''))
      && !/ios_sim_find_text/.test(String(shallowTree.hint ?? '')),
    String(shallowTree.hint ?? ''),
  )

  // 3. Deep (>= 40) + unlabeled → the "little or no accessibility information" hint + OCR.
  const deepTree = buildTreeResult([unlabeledRoot], { width: 402, height: 874 }, staticDevice, {}, { sampledDepth: 40 })
  step(
    'deep unlabeled tree says little-or-no accessibility information with OCR fallback',
    deepTree.sampledDepth === 40
      && /little or no accessibility information/.test(String(deepTree.hint ?? ''))
      && /ios_sim_find_text/.test(String(deepTree.hint ?? '')),
    String(deepTree.hint ?? ''),
  )

  // 4. sampledDepth is present in all three results.
  step(
    'sampledDepth is present in all three hint results',
    filterMiss.sampledDepth === 3 && shallowTree.sampledDepth === 15 && deepTree.sampledDepth === 40,
    `${filterMiss.sampledDepth}/${shallowTree.sampledDepth}/${deepTree.sampledDepth}`,
  )

  // 5. Auto-deepen: an injectable fake WDA whose depth-15 snapshot has no labels
  //    and whose depth-40 snapshot does. The default-cap call must retry ONCE at
  //    40 and report it; an explicit max_depth must never deepen.
  const SHALLOW_XML = [
    '<XCUIElementTypeApplication type="XCUIElementTypeApplication" enabled="true" visible="true" x="0" y="0" width="402" height="874">',
    '  <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" x="16" y="100" width="100" height="44"/>',
    '  <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" x="16" y="160" width="200" height="44"/>',
    '</XCUIElementTypeApplication>',
  ].join('')
  const DEEP_XML = [
    '<XCUIElementTypeApplication type="XCUIElementTypeApplication" enabled="true" visible="true" x="0" y="0" width="402" height="874">',
    '  <XCUIElementTypeButton type="XCUIElementTypeButton" name="like" label="Like" enabled="true" visible="true" x="16" y="100" width="100" height="44"/>',
    '</XCUIElementTypeApplication>',
  ].join('')
  const makeFakeWda = () => {
    const depthCalls = []
    let depth = 0
    return {
      depthCalls,
      control: {
        async setSnapshotDepth(d) { depthCalls.push(d); depth = d },
        async source() { return depth >= 40 ? DEEP_XML : SHALLOW_XML },
      },
    }
  }

  resetWdaTreeDepthMemory('FAKE')
  const wdaAuto = makeFakeWda()
  const autoSample = await wdaTree(wdaAuto, { udid: 'FAKE', name: 'Fake Phone' })
  step(
    'auto-deepen retries once at 40 when the default-depth snapshot has no labels',
    autoSample.deepened === true
      && autoSample.sampledDepth === 40
      && hasLabeledNode(autoSample.roots) === true
      && autoSample.depthsTried.length === 2
      && autoSample.depthsTried[0] === WDA_DEFAULT_SNAPSHOT_DEPTH
      && autoSample.depthsTried[1] === DEEPEN_SNAPSHOT_DEPTH
      && wdaAuto.depthCalls.length === 2
      && wdaAuto.depthCalls[0] === WDA_DEFAULT_SNAPSHOT_DEPTH
      && wdaAuto.depthCalls[1] === DEEPEN_SNAPSHOT_DEPTH,
    `setSnapshotDepth=[${wdaAuto.depthCalls.join(',')}] deepened=${autoSample.deepened}`,
  )
  step(
    'a satisfactory auto-deepened snapshot remembers depth 40 for its udid',
    rememberedWdaTreeDepth('FAKE') === DEEPEN_SNAPSHOT_DEPTH,
    `remembered=${rememberedWdaTreeDepth('FAKE')}`,
  )

  const wdaRemembered = makeFakeWda()
  const rememberedSample = await wdaTree(wdaRemembered, { udid: 'FAKE', name: 'Fake Phone' })
  step(
    'the next implicit read starts at the remembered depth instead of re-climbing',
    rememberedSample.deepened === false
      && rememberedSample.sampledDepth === DEEPEN_SNAPSHOT_DEPTH
      && rememberedSample.depthsTried.length === 1
      && wdaRemembered.depthCalls.join(',') === String(DEEPEN_SNAPSHOT_DEPTH),
    `setSnapshotDepth=[${wdaRemembered.depthCalls.join(',')}] deepened=${rememberedSample.deepened}`,
  )

  const wdaExplicit = makeFakeWda()
  const explicitSample = await wdaTree(wdaExplicit, { udid: 'FAKE', name: 'Fake Phone' }, 3)
  step(
    'an explicit max_depth never deepens (exactly one snapshot)',
    explicitSample.deepened === false
      && explicitSample.sampledDepth === 3
      && explicitSample.depthsTried.length === 1
      && wdaExplicit.depthCalls.length === 1
      && wdaExplicit.depthCalls[0] === 3,
    `setSnapshotDepth=[${wdaExplicit.depthCalls.join(',')}] deepened=${explicitSample.deepened}`,
  )

  invalidateWdaTreeDepthMemory('FAKE')
  const wdaInvalidated = makeFakeWda()
  const invalidatedSample = await wdaTree(wdaInvalidated, { udid: 'FAKE', name: 'Fake Phone' })
  step(
    'foreground-app invalidation clears the hint and restores the default deepen ladder',
    invalidatedSample.deepened === true
      && wdaInvalidated.depthCalls.join(',') === `${WDA_DEFAULT_SNAPSHOT_DEPTH},${DEEPEN_SNAPSHOT_DEPTH}`,
    `setSnapshotDepth=[${wdaInvalidated.depthCalls.join(',')}]`,
  )

  // 6. The playbook carries the real-device never-tap-unidentified-control rule.
  step(
    'playbook carries the real-device never-tap-unidentified rule',
    /never tap an unidentified control/i.test(IOS_SKILL_CONTENT)
      && /every tap on a real device has real consequences/i.test(IOS_SKILL_CONTENT)
      && /look deeper/i.test(IOS_SKILL_CONTENT),
    'IOS_SKILL_CONTENT',
  )

  // ── D3. WP63: list/feed row abstraction, count-change verification, and
  // the false-clue calibration — pure fixtures, no device, no app names.
  const FEED_BOUNDS = { width: 402, height: 874 }
  const feedRoots = [
    mkNode('Application', null, null, [0, 0, 402, 874], [
      mkNode('Cell', '57 回复。18 喜欢。592 次查看', null, [0, 100, 402, 240]),
      mkNode('Cell', '57 replies. 18 likes. 592 views', null, [0, 352, 402, 240]),
      mkNode('Cell', '1.2万 次播放。9 评论', null, [0, 604, 402, 240]),
      mkNode('Cell', 'scrolled-out row', null, [0, 900, 402, 240]),
    ]),
  ]
  const detected = detectListRows(feedRoots, { bounds: FEED_BOUNDS })
  step(
    'repeated isomorphic cells are detected as rows with index, frame, and aggregated label',
    detected.rows.length === 3
      && detected.rows.every((row, index) => row.index === index)
      && detected.rows[0].label === '57 回复。18 喜欢。592 次查看'
      && detected.rows[0].frame.y === 100 && detected.rows[0].frame.h === 240,
    `${detected.rows.length} rows, ${detected.omittedOffscreen} off-screen omitted`,
  )
  step(
    'off-screen cells are omitted and counted, never listed as tappable rows',
    detected.omittedOffscreen === 1 && !detected.rows.some(row => row.label === 'scrolled-out row'),
  )
  step(
    'isomorphic siblings share one shape group',
    detected.repeatedGroups === 1 && detected.rows.every(row => row.group === detected.rows[0].group),
    `group=${detected.rows[0]?.group}`,
  )

  const listFilterMiss = buildTreeResult(
    feedRoots,
    FEED_BOUNDS,
    staticDevice,
    { filter: 'bookmark' },
    { sampledDepth: 60 },
  )
  step(
    'a deep text/filter miss on repeated aggregated rows redirects to the row tools',
    listFilterMiss.nodeCount === 0
      && String(listFilterMiss.hint ?? '').includes(LIST_ROW_REDIRECT_HINT)
      && /this looks like a list/i.test(String(listFilterMiss.hint ?? ''))
      && /ios_sim_ui_rows/.test(String(listFilterMiss.hint ?? ''))
      && /ios_sim_tap_row/.test(String(listFilterMiss.hint ?? '')),
    String(listFilterMiss.hint ?? ''),
  )
  let listLabelMiss = ''
  try {
    resolveTapTarget(feedRoots, { label: 'bookmark' }, { sampledDepth: 60 })
  } catch (error) {
    listLabelMiss = String(error.message)
  }
  step(
    'a deep label miss on repeated aggregated rows redirects instead of repeating label search',
    /this looks like a list/i.test(listLabelMiss)
      && /control you seek lives inside an aggregated row/.test(listLabelMiss)
      && /ios_sim_ui_rows/.test(listLabelMiss)
      && /ios_sim_tap_row/.test(listLabelMiss),
    listLabelMiss,
  )
  const rowsWithControls = [
    mkNode('Application', null, null, [0, 0, 402, 874], [
      mkNode('Cell', 'first row', null, [0, 100, 402, 120], [mkNode('Button', 'Open', null, [320, 120, 50, 40])]),
      mkNode('Cell', 'second row', null, [0, 232, 402, 120], [mkNode('Button', 'Open', null, [320, 252, 50, 40])]),
    ]),
  ]
  const ordinaryMiss = buildTreeResult(rowsWithControls, FEED_BOUNDS, staticDevice, { filter: 'bookmark' }, { sampledDepth: 60 })
  step(
    'repeated cells with real child controls do not trigger the aggregated-row redirect',
    !/this looks like a list/i.test(String(ordinaryMiss.hint ?? ''))
      && /filter "bookmark" matched nothing/i.test(String(ordinaryMiss.hint ?? '')),
    String(ordinaryMiss.hint ?? ''),
  )

  const zhCounts = parseCountsFromLabel('57 回复。18 喜欢。592 次查看')
  step(
    'counts parse generically from a 中文 label (number + classifier, no app vocabulary)',
    zhCounts.some(count => count.key === '回复' && count.value === 57)
      && zhCounts.some(count => count.key === '喜欢' && count.value === 18)
      && zhCounts.some(count => count.key === '次查看' && count.value === 592),
    zhCounts.map(count => `${count.key}=${count.value}`).join(', '),
  )
  const enCounts = parseCountsFromLabel('57 replies. 18 likes. 592 views')
  step(
    'counts parse generically from an English label (number + classifier)',
    enCounts.some(count => count.key === 'replies' && count.value === 57)
      && enCounts.some(count => count.key === 'likes' && count.value === 18)
      && enCounts.some(count => count.key === 'views' && count.value === 592),
    enCounts.map(count => `${count.key}=${count.value}`).join(', '),
  )
  const scaled = parseCountsFromLabel('1.2万 次播放。2.5K 次浏览')
  step(
    'numeric multipliers (万/k) scale parsed values — units, not app vocabulary',
    scaled.some(count => count.key === '次播放' && count.value === 12000)
      && scaled.some(count => count.key === '次浏览' && count.value === 2500),
    scaled.map(count => `${count.key}=${count.value}`).join(', '),
  )

  const swiftuiRoots = [
    mkNode('Application', null, null, [0, 0, 402, 874], [
      mkNode('Other', 'row one text', null, [0, 100, 402, 120]),
      mkNode('Other', 'row two text', null, [0, 232, 402, 120]),
      mkNode('Other', 'row three text', null, [0, 364, 402, 120]),
      mkNode('Other', 'lone ungrouped block', null, [0, 500, 402, 100]),
    ]),
  ]
  const swiftRows = detectListRows(swiftuiRoots, { bounds: FEED_BOUNDS })
  step(
    'non-Cell rows are recognized by the repeated-shape fallback',
    swiftRows.rows.length === 3 && swiftRows.fallbackRows === 3
      && swiftRows.rows.every(row => row.label !== undefined),
    `${swiftRows.rows.length} rows (${swiftRows.fallbackRows} fallback)`,
  )
  step(
    'a lone block without a cell type and without repetition is NOT a row',
    !swiftRows.rows.some(row => row.label === 'lone ungrouped block'),
    'repetition is the evidence',
  )

  const plan = planRowTap(detected.rows, 1, 0.9, 0.5, FEED_BOUNDS)
  step(
    'row taps are planned at a RELATIVE position inside the row frame (no absolute guessing)',
    plan.row.index === 1
      && plan.tap.x === Math.round(0.9 * 402 * 100) / 100
      && plan.tap.y === Math.round((352 + 0.5 * 240) * 100) / 100
      && plan.inRow.x === 0.9 && plan.inRow.y === 0.5,
    `tap=(${plan.tap.x},${plan.tap.y}) inRow=(0.9,0.5)`,
  )
  let outOfRange = ''
  try { planRowTap(detected.rows, 7, 0.5, 0.5, FEED_BOUNDS) } catch (error) { outOfRange = String(error.message) }
  step(
    'an out-of-range row index FAILS with the real row count (never clamps)',
    /does not exist/.test(outOfRange) && /3 visible row\(s\)/.test(outOfRange) && /Re-run ios_sim_ui_rows/.test(outOfRange),
    outOfRange.split('\n')[0],
  )
  let badFraction = ''
  try { planRowTap(detected.rows, 0, 1.5, 0.5, FEED_BOUNDS) } catch (error) { badFraction = String(error.message) }
  step('a relative position outside 0..1 is rejected', /fraction within 0\.\.1/.test(badFraction), badFraction.split('\n')[0])

  let probeError = ''
  try { requireCountKey(detected.rows[0], '收藏') } catch (error) { probeError = String(error.message) }
  step(
    'the probe-guard refuses a count key the row does not carry, BEFORE any tap',
    /refused, never probed/.test(probeError)
      && /ios_sim_ui_rows/.test(probeError)
      && /回复=57/.test(probeError),
    probeError.split('\n')[0],
  )
  step(
    'a carried key passes the probe-guard with its parsed value',
    requireCountKey(detected.rows[0], '喜欢') === 18,
  )

  const mkRow = (label, y = 100) => ({
    index: 0, type: 'Cell', frame: { x: 0, y, w: 402, h: 240 }, label, counts: parseCountsFromLabel(label),
  })
  const likedBefore = mkRow('18 喜欢')
  const likedAfter = mkRow('19 喜欢')
  const sameAfter = mkRow('18 喜欢')
  const wrongAfter = mkRow('20 喜欢')
  const movedAfter = mkRow('19 喜欢', 400)
  const rewordedAfter = mkRow('这条动态更新了')
  step(
    'count verification: exact ±1 verifies; no change / wrong delta / moved row / reworded label do not',
    verifyCountChange(likedBefore, likedAfter, '喜欢', 1).verified === true
      && verifyCountChange(likedAfter, likedBefore, '喜欢', -1).verified === true
      && verifyCountChange(likedBefore, sameAfter, '喜欢', 1).verified === false
      && verifyCountChange(likedBefore, sameAfter, '喜欢', 1).changed === false
      && verifyCountChange(likedBefore, wrongAfter, '喜欢', 1).changed === true
      && verifyCountChange(likedBefore, wrongAfter, '喜欢', 1).verified === false
      && /moved by 2, not the expected \+1/.test(verifyCountChange(likedBefore, wrongAfter, '喜欢', 1).reason ?? '')
      && /moved after the action/.test(verifyCountChange(likedBefore, movedAfter, '喜欢', 1).reason ?? '')
      && /absent from the re-read label/.test(verifyCountChange(likedBefore, rewordedAfter, '喜欢', 1).reason ?? ''),
    'only the count change is the confirmation',
  )

  // WP63 false-clue calibration: an empty or shallow read must never claim
  // "little or no accessibility information" — attribute it to depth / filter /
  // genuinely-none instead.
  const emptyRoot = mkNode('Application', null, null, [0, 0, 402, 874], [])
  const emptyShallow = buildTreeResult([emptyRoot], { width: 402, height: 874 }, staticDevice, {}, { sampledDepth: 15 })
  step(
    'an EMPTY tree at shallow depth names the depth — never "little or no accessibility information"',
    /depth sampled \(15\)/.test(String(emptyShallow.hint ?? ''))
      && /max_depth/.test(String(emptyShallow.hint ?? ''))
      && !/accessibility information/i.test(String(emptyShallow.hint ?? '')),
    String(emptyShallow.hint ?? ''),
  )
  const emptyDeep = buildTreeResult([emptyRoot], { width: 402, height: 874 }, staticDevice, {}, { sampledDepth: 40 })
  step(
    'only a DEEP empty read may say "little or no accessibility information" (case c)',
    /little or no accessibility information/.test(String(emptyDeep.hint ?? ''))
      && /ios_sim_find_text/.test(String(emptyDeep.hint ?? '')),
    String(emptyDeep.hint ?? ''),
  )
  const cappedChain = mkNode('Application', null, null, [0, 0, 402, 874], [])
  {
    let cursor = cappedChain
    for (let i = 0; i < 200; i += 1) {
      const child = mkNode('Group', null, null, [0, 0, 402, 874], [])
      cursor.children.push(child)
      cursor = child
    }
    for (let i = 0; i < 900; i += 1) cursor.children.push(mkNode('StaticText', `deep-label-${i}`, null, [0, 0, 100, 20], []))
  }
  const cappedUnlabeled = buildTreeResult([cappedChain], { width: 402, height: 874 }, staticDevice, {}, { sampledDepth: 40 })
  step(
    'an output-capped read whose labels were pruned is reported as filtered, never as no-a11y',
    cappedUnlabeled.truncated === true
      && /pruned/.test(String(cappedUnlabeled.hint ?? ''))
      && /max_depth/.test(String(cappedUnlabeled.hint ?? ''))
      && !/accessibility information/i.test(String(cappedUnlabeled.hint ?? '')),
    String(cappedUnlabeled.hint ?? '').slice(0, 160),
  )
  const offRoot = mkNode('Application', null, null, [0, 0, 402, 874], [
    mkNode('Other', null, null, [16, 100, 100, 44]),
    mkNode('Button', 'visible-only-after-scroll', null, [0, 900, 100, 44]),
  ])
  const offUnlabeled = buildTreeResult([offRoot], { width: 402, height: 874 }, staticDevice, {}, { sampledDepth: 40 })
  step(
    'labels that were all off-screen are reported as excluded, never as no-a11y',
    offUnlabeled.omittedOffscreen === 1
      && /off-screen/.test(String(offUnlabeled.hint ?? ''))
      && /include_offscreen=true/.test(String(offUnlabeled.hint ?? ''))
      && !/accessibility information/i.test(String(offUnlabeled.hint ?? '')),
    String(offUnlabeled.hint ?? ''),
  )
  const emptyFullTree = buildTreeResult([emptyRoot], { width: 402, height: 874 }, staticDevice, {}, {})
  step(
    'the simulator full-tree path treats an empty read as deep by construction (case c)',
    /little or no accessibility information/.test(String(emptyFullTree.hint ?? '')),
    String(emptyFullTree.hint ?? ''),
  )

  const rowTools = createSimRowTools(controller)
  const ocrTools = createSimOcrTools(controller)
  step(
    'row tools register the two list-row names',
    [rowTools.iosSimUiRows.name, rowTools.iosSimTapRow.name].join(',') === IOS_ROW_TOOL_NAMES.join(','),
    [rowTools.iosSimUiRows.name, rowTools.iosSimTapRow.name].join(' '),
  )
  step(
    'ui_rows is concurrency-safe, tap_row stays exclusive',
    rowTools.iosSimUiRows.isConcurrencySafe({}) === true
      && rowTools.iosSimTapRow.isConcurrencySafe === undefined,
  )
  step(
    'ROW_SNAPSHOT_DEPTH is 60 — the measured depth where feed cells appear',
    ROW_SNAPSHOT_DEPTH === 60 && MIN_REPEATED_ROWS === 2,
    `ROW_SNAPSHOT_DEPTH=${ROW_SNAPSHOT_DEPTH}`,
  )
  step(
    'row tool descriptions contain no non-Apple bundle identifiers',
    nonAppleBundleIds(`${rowTools.iosSimUiRows.description} ${rowTools.iosSimTapRow.description}`).length === 0,
    'the RULE ships; one user\u2019s app list does not',
  )
  step(
    'ui_tree description carries the aggregated-row redirect without relying on the skill',
    /aggregated cells without per-control children/i.test(uiTools.iosSimUiTree.description)
      && /cannot be found by label/i.test(uiTools.iosSimUiTree.description)
      && /ios_sim_ui_rows/.test(uiTools.iosSimUiTree.description)
      && /ios_sim_tap_row/.test(uiTools.iosSimUiTree.description),
    'ui_tree → ui_rows + tap_row',
  )
  step(
    'find_text description warns that icon-only controls have no OCR text and routes list rows',
    /icon-only controls carry no OCR text/i.test(ocrTools.iosSimFindText.description)
      && /for list rows use ios_sim_ui_rows/i.test(ocrTools.iosSimFindText.description),
    'find_text → ui_rows',
  )
  step(
    'tap_row states the probe-guard rule (refuse before tap, expect_count ±1)',
    /REFUSED before it happens/i.test(rowTools.iosSimTapRow.description)
      && /never probe a control/i.test(rowTools.iosSimTapRow.description)
      && /expect_count/.test(rowTools.iosSimTapRow.description)
      && (rowTools.iosSimTapRow.parameters.required ?? []).includes('row')
      && (rowTools.iosSimTapRow.parameters.properties.expect_count?.required ?? []).includes('key')
      && rowTools.iosSimTapRow.parameters.properties.expect_count?.properties?.delta?.type === 'integer',
  )
  step(
    'ui_rows states the three-case rule (a shallow read is never reported as no-a11y)',
    /shallow read is never/i.test(rowTools.iosSimUiRows.description)
      && /max_depth is 60/i.test(rowTools.iosSimUiRows.description)
      && /genuinely no accessibility information after a DEEP read/i.test(rowTools.iosSimUiRows.description),
  )
  step(
    'playbook carries the list-row rules and the three-case false-clue rule',
    /## Lists and feeds/.test(IOS_SKILL_CONTENT)
      && /ios_sim_ui_rows/.test(IOS_SKILL_CONTENT)
      && /ios_sim_tap_row/.test(IOS_SKILL_CONTENT)
      && /expect_count=\{key,delta\}/.test(IOS_SKILL_CONTENT)
      && /never probed/.test(IOS_SKILL_CONTENT)
      && /NEVER evidence that an app lacks accessibility support/.test(IOS_SKILL_CONTENT)
      && /depth too shallow/.test(IOS_SKILL_CONTENT)
      && /output was filtered/.test(IOS_SKILL_CONTENT)
      && /DEEP, unfiltered read with no labels/.test(IOS_SKILL_CONTENT),
  )



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
  if (!SKIP_SIM_PART) {
    if (bootedBySmoke && udid !== undefined) {
      await shutdownDevice(udid)
      bootedBySmoke = false
    }
    const leftDevices = (await bootedDevices()).map(d => `${d.name} ${d.udid}`)
    step('no booted simulators left', leftDevices.length === 0, leftDevices.join(', ') || 'none')
  }

  let axeProcs = ''
  try {
    axeProcs = execFileSync('pgrep', ['-fl', 'axe (describe-ui|tap|list-simulators)'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch { /* pgrep exit 1 = no matches, which is what we want */ }
  step('no stray axe processes left', axeProcs === '', axeProcs || 'none')

  if (!SKIP_SIM_PART) {
    let serveSimProcs = ''
    try {
      serveSimProcs = execFileSync('pgrep', ['-fl', 'serve-sim'], { encoding: 'utf8', timeout: 10_000 }).trim()
    } catch { /* none */ }
    step('no serve-sim processes left', serveSimProcs === '', serveSimProcs || 'none')
  }
} catch (error) {
  step('smoke completed without uncaught errors', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  // ── best-effort cleanup no matter what happened ───────────────────────────
  try {
    if (controller !== undefined) await controller.dispose()
  } catch { /* already disposed */ }
  if (!SKIP_SIM_PART) {
    try {
      if (bootedBySmoke && udid !== undefined) await shutdownDevice(udid)
    } catch { /* already shut down */ }
    try {
      execFileSync('pkill', ['-f', 'serve-sim'], { stdio: 'ignore', timeout: 10_000 })
    } catch { /* pkill exit 1 = nothing to kill */ }
  }
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// ── negative zero must never reach a tool result ──────────────────────────
// From a real session: 4 of 7 ios_sim_ui_tree calls died with "value is not
// lossless JSON". The cause was three `frame.x: -0` deep in the Calendar
// hierarchy — AXe reports off-screen-left frames as -0, JSON.parse KEEPS the
// sign while JSON.stringify writes "0", so the value does not round-trip and
// DSH rejects the ENTIRE result rather than the one coordinate.
{
  const negZeroNode = sanitizeAxeNode({
    AXLabel: 'Off-screen row',
    type: 'Cell',
    frame: { x: -0, y: -0, width: 320, height: 44 },
  })
  step(
    'sanitizeAxeNode flattens -0 frame coordinates to +0',
    Object.is(negZeroNode.frame.x, 0) && Object.is(negZeroNode.frame.y, 0)
      && negZeroNode.frame.w === 320 && negZeroNode.frame.h === 44,
    `x=${Object.is(negZeroNode.frame.x, -0) ? '-0' : negZeroNode.frame.x} y=${Object.is(negZeroNode.frame.y, -0) ? '-0' : negZeroNode.frame.y}`,
  )
  step(
    'real coordinates are untouched by the normalization',
    sanitizeAxeNode({ type: 'Button', frame: { x: -12.5, y: 40, width: 10, height: 10 } }).frame.x === -12.5,
    'only zero is special-cased; negative positions stay negative',
  )
  const walk = (value, path = '$', hits = []) => {
    if (value === undefined) { hits.push(`${path} = undefined`); return hits }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return hits
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) hits.push(`${path} = ${Object.is(value, -0) ? '-0' : String(value)}`)
      return hits
    }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`, hits)); return hits }
    if (typeof value !== 'object') { hits.push(`${path} typeof ${typeof value}`); return hits }
    for (const key of Object.keys(value)) walk(value[key], `${path}.${key}`, hits)
    return hits
  }
  const offenders = walk([negZeroNode, sanitizeAxeNode({ type: 'Other', frame: { x: -0, y: 5, width: -0, height: 0 } })])
  step(
    'a sanitized tree survives the same lossless-JSON boundary DSH applies',
    offenders.length === 0,
    offenders.length === 0 ? 'no undefined-valued keys, no -0, no non-finite numbers' : offenders.join(', '),
  )
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
