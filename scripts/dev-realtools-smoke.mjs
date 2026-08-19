/**
 * Development smoke test for the real-device (WebDriverAgent) backends of the
 * model tools: ios_sim_screenshot, ios_sim_interact, ios_sim_ui_tree and
 * ios_sim_tap_element — one tool, two backends — plus the explicit starter
 * ios_real_start_wda.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-realtools-smoke.mjs [<udid>]
 *
 * Part A (static, runs with NO device attached and MUST pass):
 *   - WDA `source()` XML → compact-node normalization against a captured
 *     real-device fixture (wrapper collapse, identifier recovery from `name`,
 *     value de-duplication, entity decoding, empty-payload error,
 *     enabled/visible flag preservation)
 *   - AXe describe-ui fixture parity: `enabled` booleans map to the same
 *     flag shape, absent flags stay undefined
 *   - selector matching on the normalized fixture with the SAME rules as the
 *     AXe path (exact first, case-insensitive contains, nested-duplicate
 *     collapse, ambiguity → candidate list with visible/enabled flags,
 *     no-match hint) plus the visibility/enabled gate: an off-screen-only
 *     match refuses with the scroll-into-view message (allow_offscreen
 *     escapes), a disabled match refuses even with allow_offscreen
 *   - tool routing with a mocked WDA client: sim udid → simctl/AXe path
 *     unchanged; real udid → WDA path (screenshot cache layout + meta,
 *     interact tap/type/button/gesture→drag mapping + settle screenshot,
 *     ui_tree filter/max_depth/size + off-screen exclusion by default
 *     (omittedOffscreen) + include_offscreen enumeration, tap_element
 *     center tap + settle)
 *   - WP56 simulator gesture channel (src/sim-gesture.ts): the host touch/
 *     button frame encoders ([tag 3|4][utf-8 JSON], the twins of
 *     src/client/protocol.ts), the PURE scroll/drag geometry (19-point path,
 *     monotonic, inside the 8%..92% band for every direction × amount, the CLI
 *     fallback frames read from the same path's endpoints), and
 *     `sendSimGesture` against a LOCAL fake control socket (a `ws` server in
 *     this process): begin + N moves + end over ONE socket, ~16 ms per frame,
 *     the socket closed afterwards, and both failure paths rejecting with the
 *     actionable serve-sim message. Routing: a live stream takes the WS channel
 *     (~300 ms, 0 CLI processes), while no stream / a refused socket / a stream
 *     for another device fall back to the 3-invocation CLI path, and single
 *     events (tap/type/button/one raw frame) never touch the socket. The bug
 *     this closes: the CLI spawns one process per touch event — 2.05 s for a
 *     7-event scroll with ~290 ms of stationary contact — which iOS read as a
 *     press-and-drag (scrolling Calendar's month view opened the NEW EVENT
 *     sheet instead of scrolling)
 *   - not-ready reason propagation: WdaController.status() reasons
 *     (device-locked / cert-untrusted / device-unplugged) surface as the
 *     actionable error, and a recorded failure fast-fails without retrying
 *   - the still-refused tools' NEW messages (boot/shutdown: a phone is not
 *     booted from this Mac)
 *   - WP57 installed-app enumeration (src/app-list.ts): `simctl listapps`
 *     old-style-plist parsing (user vs system, \Uxxxx-escaped CJK display
 *     names decoded), devicectl `result.apps[]` mapping, the query matching
 *     both display name and bundle id, and the invariant that a FAILED listing
 *     throws (non-zero exit, non-plist stdout, CoreDevice error 1011, a
 *     success document with no apps array) instead of looking like `count: 0`;
 *     plus `ios_sim_launch_app` name resolution (one match launches, several
 *     list the candidates, none points at ios_sim_list_apps, both arguments is
 *     a coded error) and the playbook's no-guessing / stay-on-the-device rules
 *
 * Part B (live, opt-in with DSH_IOS_SMOKE_REAL_DEVICE=1):
 *   If `devicectl list devices` shows the phone AND WDA answers on
 *   http://127.0.0.1:8100/status, a REAL pass runs: ios_sim_ui_tree returns
 *   a recognizable tree, ios_sim_screenshot writes a PNG >50 KB, and
 *   ios_sim_interact button home works. SAFETY: read-only queries plus the
 *   home button only — nothing is opened, installed, typed into or deleted.
 *   ios_sim_tap_element is NOT exercised live (it would tap the user's
 *   screen). Simulators are never booted; ~/.dsh and the :8873 instance are
 *   never touched.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_LIVE_PART = process.env.DSH_IOS_SMOKE_REAL_DEVICE === '1'
// The same `ws` the plugin's own gesture channel and relay resolve (WP56).
const { WebSocketServer } = createRequire(import.meta.url)('ws')
const DEVICE_UDID = process.argv[2] || process.env.DSH_REAL_DEVICE_UDID || '96E6B481-3807-594D-B3BC-E1E12307D47C'
const FAKE_REAL_UDID = '00000000-0000-0000-0000-0000000000AA'
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))
const { createSimTools, IOS_TOOL_NAMES, interactControlArgs, performSimInteract, resolveToolTarget, simInteractGesturePath } = await import(join(root, 'lib', 'tools.js'))
const {
  SIM_GESTURE_STEP_MS,
  SIM_SCROLL_STEPS,
  SIM_TOUCH_TAG,
  encodeSimButtonFrame,
  encodeSimTouchFrame,
  sendSimGesture,
  simDragPath,
  simDragRequestOf,
  simScrollPath,
} = await import(join(root, 'lib', 'sim-gesture.js'))
const { createSimUiTools, capTreeToBytes, resolveTapTarget } = await import(join(root, 'lib', 'tool-uitree.js'))
const { wdaSourceToElements, parseWdaXml } = await import(join(root, 'lib', 'wda-uitree.js'))
const { parseDescribeUi, sanitizeAxeNode } = await import(join(root, 'lib', 'uitree-backend.js'))
const { WdaController, WdaError, probeWdaControlTunnel } = await import(join(root, 'lib', 'wda-host.js'))
const { listRealDevices } = await import(join(root, 'lib', 'devicectl.js'))
const {
  filterInstalledApps,
  listPhysicalDeviceApps,
  listSimulatorApps,
  lprojCandidates,
  localizeSimApps,
  noMatchCandidateLines,
  parseSimctlListApps,
  resolveAppByName,
} = await import(join(root, 'lib', 'app-list.js'))
const { parseStringsText, readStrings } = await import(join(root, 'lib', 'plist.js'))
const { IOS_SKILL_CONTENT } = await import(join(root, 'lib', 'skill.js'))

/**
 * Captured `GET /session/<sid>/source` from the dev iPhone (iOS 26.6,
 * WebDriverAgent 16.2.0) while the SleepLockScreen app was frontmost —
 * the exact document shape `wdaSourceToElements` normalizes.
 */
const FIXTURE_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="SleepLockScreen" label="SleepLockScreen" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0" traits="" processId="11490" bundleId="com.apple.SleepLockScreen">',
  '  <XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0" traits="">',
  '    <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0" traits="">',
  '      <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0" traits="">',
  '        <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0" traits="">',
  '          <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0" traits="">',
  '            <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0" traits="">',
  '              <XCUIElementTypeOther type="XCUIElementTypeOther" name="SleepLockScreenView" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0" traits="">',
  '                <XCUIElementTypeOther type="XCUIElementTypeOther" name="SleepLockScreenContainerView" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0" traits="">',
  '                  <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="false" accessible="false" x="142" y="240" width="118" height="65" index="0" traits="">',
  '                    <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="false" accessible="false" x="142" y="240" width="118" height="65" index="0" traits="">',
  '                      <XCUIElementTypeOther type="XCUIElementTypeOther" name="UIA.SleepLockScreen.Alarm.Button" enabled="true" visible="false" accessible="false" x="142" y="256" width="118" height="41" index="0" traits="">',
  '                        <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="false" accessible="false" x="142" y="256" width="118" height="41" index="0" traits=""/>',
  '                      </XCUIElementTypeOther>',
  '                      <XCUIElementTypeButton type="XCUIElementTypeButton" name="UIA.SleepLockScreen.Alarm.Button" label="无闹钟" enabled="true" visible="false" accessible="true" x="142" y="256" width="118" height="41" index="1" traits="Button">',
  '                        <XCUIElementTypeImage type="XCUIElementTypeImage" name="alarm" label="闹钟" enabled="true" visible="false" accessible="false" x="169" y="270" width="12" height="13" index="0" traits="Image"/>',
  '                        <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="无闹钟" name="无闹钟" label="无闹钟" enabled="true" visible="false" accessible="false" x="142" y="256" width="118" height="41" index="1" traits="StaticText"/>',
  '                      </XCUIElementTypeButton>',
  '                    </XCUIElementTypeOther>',
  '                  </XCUIElementTypeOther>',
  '                  <XCUIElementTypeButton type="XCUIElementTypeButton" name="UIA.Snooze.Button" label="稍后提醒" enabled="false" visible="true" accessible="true" x="16" y="400" width="370" height="52" index="2" traits="Button"/>',
  '                  <XCUIElementTypeButton type="XCUIElementTypeButton" name="UIA.Hidden.Button" label="隐藏的按钮" enabled="true" visible="false" accessible="true" x="16" y="1200" width="370" height="52" index="3" traits="Button"/>',
  '                </XCUIElementTypeOther>',
  '              </XCUIElementTypeOther>',
  '            </XCUIElementTypeOther>',
  '          </XCUIElementTypeOther>',
  '        </XCUIElementTypeOther>',
  '      </XCUIElementTypeOther>',
  '    </XCUIElementTypeOther>',
  '  </XCUIElementTypeWindow>',
  '</XCUIElementTypeApplication>',
].join('\n')

const results = []
let failed = 0
function step(name, verdict, detail = '') {
  const normalized = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict
  if (normalized === 'FAIL') failed += 1
  results.push({ name, verdict: normalized, detail })
  console.log(`${normalized.padEnd(4)} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function makeExec(toolName, args) {
  return {
    callId: `realtools-smoke-${toolName}`,
    rootCallId: `realtools-smoke-${toolName}`,
    name: toolName,
    arguments: args,
    signal: new AbortController().signal,
  }
}

/** Bundle-like identifiers that are not Apple-owned (rule-based, no app list). */
function nonAppleBundleIds(text) {
  const ids = String(text).match(/\b(?:com|org|net|io|app)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+\b/g) ?? []
  return [...new Set(ids.filter(id => !id.startsWith('com.apple.')))]
}

async function expectThrow(label, invoke, pattern, alsoForbidden) {
  try {
    await invoke()
    step(label, 'FAIL', 'no error was thrown')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const ok = pattern.test(message) && (alsoForbidden === undefined || !alsoForbidden.test(message))
    step(label, ok ? 'PASS' : 'FAIL', ok ? message : `unexpected error: ${message}`)
  }
}

function collectLabels(tree, labels = []) {
  for (const node of tree) {
    if (typeof node.label === 'string' && node.label !== '') labels.push(node.label)
    collectLabels(node.children ?? [], labels)
  }
  return labels
}

const fakeRealDevice = {
  udid: FAKE_REAL_UDID,
  name: 'Smoke Phone',
  osVersion: '26.6',
  model: 'iPhone 17 Pro',
  state: 'available (paired)',
  connection: 'wired',
  pairingState: 'paired',
  developerMode: 'enabled',
}

/** Mocked WdaToolBackend recording every call; behavior via `state`. */
function makeFakeWda() {
  const state = {
    ensureRunningCalls: 0,
    taps: [],
    buttons: [],
    texts: [],
    drags: [],
    status: {
      available: true,
      running: true,
      consumers: 0,
      reason: undefined,
      detail: undefined,
      controlPort: 8100,
      mjpegPort: 9100,
      adopted: false,
    },
    ensureRunningError: undefined,
    screenshotError: undefined,
    sourceError: undefined,
  }
  const wda = {
    async ensureRunning({ udid }) {
      state.ensureRunningCalls += 1
      if (state.ensureRunningError !== undefined) throw state.ensureRunningError
      // Mirror WdaController's settle: running + ports + cleared failure.
      state.status.running = true
      state.status.device = udid
      state.status.controlPort = 8100
      state.status.mjpegPort = 9100
      state.status.adopted = false
      state.status.reason = undefined
      state.status.detail = undefined
      return { udid, hardwareUdid: 'FAKE-HW-UDID', controlUrl: 'http://127.0.0.1:8100', mjpegUrl: 'http://127.0.0.1:9100/', sessionId: 'SESSION-FAKE' }
    },
    status() {
      return { ...state.status }
    },
    async stop() {},
    acquire() {
      return () => {}
    },
    release() {},
    get mjpegUrl() {
      return undefined
    },
    control: {
      async pressButton(name) {
        state.buttons.push(name)
      },
      async tap(x, y) {
        state.taps.push({ x, y })
      },
      async dragFromToForDuration(drag) {
        state.drags.push(drag)
      },
      async typeText(text) {
        state.texts.push(text)
      },
      async screenshot() {
        if (state.screenshotError !== undefined) throw state.screenshotError
        return { pngBase64: TINY_PNG_B64, width: 1, height: 1 }
      },
      async source() {
        if (state.sourceError !== undefined) throw state.sourceError
        return FIXTURE_XML
      },
      async windowSize() {
        return { width: 402, height: 874 }
      },
      async getOrientation() {
        return 'PORTRAIT'
      },
      async setOrientation() {},
    },
    __state: state,
  }
  return wda
}

const tempDirs = []
let host
let liveWda
/** Local fake serve-sim control socket (WP56); closed in the finally. */
let gestureServer

try {
  host = new SimHostController()
  const realDevices = {
    matches: async reference => reference === FAKE_REAL_UDID,
    resolve: async () => fakeRealDevice,
  }

  // ── A1. WDA XML → compact-node normalization (captured fixture) ───────────
  const roots = wdaSourceToElements(FIXTURE_XML)
  step(
    'fixture normalizes to one Application root in device points',
    roots.length === 1 && roots[0].type === 'Application'
      && roots[0].frame.w === 402 && roots[0].frame.h === 874,
    `root=${roots[0].type} frame=(${roots[0].frame.x},${roots[0].frame.y},${roots[0].frame.w},${roots[0].frame.h})`,
  )
  const allNodes = []
  const walkAll = (nodes, depth = 0) => {
    for (const node of nodes) {
      allNodes.push(node)
      walkAll(node.children, depth + 1)
    }
  }
  walkAll(roots)
  step(
    'wrapper collapse: no same-frame info-less duplicates survive',
    !allNodes.some(node => node.type === 'Window' || node.label === 'SleepLockScreenView' && node.children.length > 2)
      && allNodes.length < 20,
    `${allNodes.length} nodes (was 19 XML elements)`,
  )
  const alarm = allNodes.find(node => node.type === 'Button' && node.label === '无闹钟')
  step(
    'label/value/identifier mapping (label wins, name becomes identifier, value de-duplicated)',
    alarm !== undefined && alarm.identifier === 'UIA.SleepLockScreen.Alarm.Button' && alarm.value === undefined,
    `button id=${alarm?.identifier}`,
  )
  step(
    'WDA enabled/visible attributes survive as booleans on the compact node',
    alarm?.visible === false && alarm?.enabled === true,
    `alarm visible=${alarm?.visible} enabled=${alarm?.enabled}`,
  )
  const snooze = allNodes.find(node => node.type === 'Button' && node.label === '稍后提醒')
  step(
    'a disabled control keeps enabled=false (greyed-out, still on-screen)',
    snooze?.enabled === false && snooze?.visible === true,
    `snooze visible=${snooze?.visible} enabled=${snooze?.enabled}`,
  )
  const hiddenRow = allNodes.find(node => node.type === 'Button' && node.label === '隐藏的按钮')
  step(
    'a scrolled-out row keeps visible=false',
    hiddenRow?.visible === false && hiddenRow?.enabled === true,
    `hidden visible=${hiddenRow?.visible} enabled=${hiddenRow?.enabled}`,
  )
  step(
    'StaticText mirrored value collapsed (no label double-match)',
    !allNodes.some(node => node.type === 'StaticText' && node.label === '无闹钟'),
  )
  const alarmIcon = allNodes.find(node => node.type === 'Image' && node.label === '闹钟')
  step(
    'icon keeps its own identifier (name differs from label)',
    alarmIcon !== undefined && alarmIcon.identifier === 'alarm',
    `image id=${alarmIcon?.identifier}`,
  )
  const entityRoots = wdaSourceToElements('<XCUIElementTypeApplication x="0" y="0" width="100" height="200"><XCUIElementTypeButton name="A &amp; B &lt;x&gt;" label="A &amp; B &lt;x&gt;"/></XCUIElementTypeApplication>')
  step(
    'XML entities decode in attribute values',
    entityRoots[0]?.children[0]?.label === 'A & B <x>',
    `label=${JSON.stringify(entityRoots[0]?.children[0]?.label)}`,
  )
  await expectThrow('empty payload raises', () => wdaSourceToElements('<?xml version="1.0" encoding="UTF-8"?>'), /no accessibility elements/i)

  // AXe backend parity: real describe-ui emits `enabled` as a JSON boolean
  // (absent/null when unreported) and NO visibility flag.
  const axeFixture = parseDescribeUi(JSON.stringify([
    {
      type: 'Application',
      AXLabel: null,
      AXUniqueId: null,
      AXValue: null,
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        { type: 'Button', AXLabel: 'Back', enabled: true, frame: { x: 8, y: 100, width: 80, height: 44 }, children: [] },
        { type: 'Button', AXLabel: 'Next', enabled: false, frame: { x: 300, y: 100, width: 80, height: 44 }, children: [] },
        { type: 'Button', AXLabel: 'Save', enabled: null, frame: { x: 8, y: 160, width: 80, height: 44 }, children: [] },
        { type: 'Button', AXLabel: 'Off', frame: { x: 8, y: 220, width: 80, height: 44 }, children: [] },
      ],
    },
  ]))
  const axeButtons = axeFixture[0].children
  step(
    'AXe enabled booleans map to the same flag shape (absent/null stay undefined)',
    axeButtons[0].enabled === true && axeButtons[1].enabled === false
      && axeButtons[2].enabled === undefined && axeButtons[3].enabled === undefined
      && axeButtons.every(node => node.visible === undefined),
    axeButtons.map(node => `${node.label}:${node.enabled}`).join(' '),
  )
  step(
    'sanitize is idempotent for already-sanitized nodes (flags survive)',
    sanitizeAxeNode(axeButtons[0]).enabled === true && sanitizeAxeNode(alarm).visible === false && sanitizeAxeNode(alarm).enabled === true,
  )

  // WP60: WDA's selected attribute is the ONLY way to confirm which option in
  // a list is chosen without pixels, so it must survive into the tree. Emitted
  // only when the backend reports it - an absent attribute stays absent, never
  // an invented false.
  const selectedRoots = wdaSourceToElements([
    '<XCUIElementTypeApplication x="0" y="0" width="100" height="200">',
    '  <XCUIElementTypeCell name="rowA" label="A" selected="true" enabled="true" visible="true" x="0" y="0" width="100" height="40"/>',
    '  <XCUIElementTypeCell name="rowB" label="B" selected="false" enabled="true" visible="true" x="0" y="40" width="100" height="40"/>',
    '  <XCUIElementTypeCell name="rowC" label="C" enabled="true" visible="true" x="0" y="80" width="100" height="40"/>',
    '</XCUIElementTypeApplication>',
  ].join('\n'))
  const selectedRows = selectedRoots[0].children
  step(
    'WDA selected=true -> true, selected=false -> false, missing -> ABSENT (not false)',
    selectedRows.length === 3
      && selectedRows[0].selected === true
      && selectedRows[1].selected === false
      && selectedRows[2].selected === undefined
      && !('selected' in selectedRows[2]),
    selectedRows.map(node => `${node.label}:${JSON.stringify(node.selected)}`).join(' '),
  )
  // The AXe simulator tree has the same trait; sanitizeAxeNode carries it too.
  const axeSelected = parseDescribeUi(JSON.stringify([
    { type: 'Application', frame: { x: 0, y: 0, width: 100, height: 200 }, children: [
      { type: 'Cell', AXLabel: 'A', selected: true, frame: { x: 0, y: 0, width: 100, height: 40 }, children: [] },
      { type: 'Cell', AXLabel: 'B', selected: false, frame: { x: 0, y: 40, width: 100, height: 40 }, children: [] },
      { type: 'Cell', AXLabel: 'C', frame: { x: 0, y: 80, width: 100, height: 40 }, children: [] },
    ] },
  ]))
  const axeSelectedRows = axeSelected[0].children
  step(
    'AXe selected maps to the same flag shape (absent stays undefined)',
    axeSelectedRows[0].selected === true && axeSelectedRows[1].selected === false && axeSelectedRows[2].selected === undefined,
    axeSelectedRows.map(node => `${node.label}:${JSON.stringify(node.selected)}`).join(' '),
  )

  // ── A2. shared selector-matching rules + visibility/enabled gate ──────────
  await expectThrow(
    'off-screen-only match refuses by default (scroll-into-view message)',
    () => resolveTapTarget(roots, { label: '无闹钟' }),
    /matched an off-screen element[\s\S]*scroll it into view first[\s\S]*allow_offscreen=true/,
  )
  const byLabel = resolveTapTarget(roots, { label: '无闹钟' }, { allowOffscreen: true })
  step(
    'allow_offscreen escape hatch taps the off-screen match anyway',
    byLabel.element.type === 'Button' && byLabel.matchedBy === 'exact',
    `type=${byLabel.element.type} matchedBy=${byLabel.matchedBy}`,
  )
  const byIdentifier = resolveTapTarget(roots, { identifier: 'UIA.SleepLockScreen.Alarm.Button' }, { allowOffscreen: true })
  step(
    'exact identifier match resolves the same Button (escape hatch)',
    byIdentifier.element.type === 'Button' && byIdentifier.matchedBy === 'exact',
  )
  const contains = resolveTapTarget(roots, { label: '闹' }, { allowOffscreen: true })
  step(
    'case-insensitive contains fallback works (nested chain collapses to the tappable Button)',
    contains.matchedBy === 'contains' && contains.element.type === 'Button',
    `type=${contains.element.type} matchedBy=${contains.matchedBy}`,
  )
  await expectThrow(
    'a disabled-only match refuses with the is-disabled message',
    () => resolveTapTarget(roots, { label: '稍后提醒' }),
    /matched a disabled element[\s\S]*is disabled[\s\S]*enable it first/,
  )
  await expectThrow(
    'disabled stays refused even with the allow_offscreen escape hatch',
    () => resolveTapTarget(roots, { label: '稍后提醒' }, { allowOffscreen: true }),
    /matched a disabled element[\s\S]*is disabled/,
  )
  await expectThrow(
    'off-screen geometry (frame beyond the screen) refuses too',
    () => resolveTapTarget(roots, { label: '隐藏的按钮' }, { allowOffscreen: false }),
    /matched an off-screen element[\s\S]*scroll it into view first/,
  )
  const geoSneak = resolveTapTarget(roots, { label: '隐藏的按钮' }, { allowOffscreen: true })
  step(
    'geometry-based off-screen rows resolve through the escape hatch',
    geoSneak.element.label === '隐藏的按钮' && geoSneak.matchedBy === 'exact',
    `type=${geoSneak.element.type}`,
  )
  let ambiguity = ''
  const ambiguousRoots = wdaSourceToElements([
    '<XCUIElementTypeApplication x="0" y="0" width="400" height="800">',
    '  <XCUIElementTypeButton name="del.1" label="Delete" x="16" y="100" width="370" height="52"/>',
    '  <XCUIElementTypeButton name="del.2" label="Delete" x="16" y="160" width="370" height="52"/>',
    '</XCUIElementTypeApplication>',
  ].join(''))
  try {
    resolveTapTarget(ambiguousRoots, { label: 'Delete' })
  } catch (error) {
    ambiguity = String(error.message)
  }
  step(
    'distinct duplicates raise the candidate-list ambiguity error',
    ambiguity.includes('2 elements match') && ambiguity.includes('del.1') && ambiguity.includes('del.2')
      && ambiguity.includes('frame='),
    ambiguity.split('\n')[0],
  )
  // A gated ambiguity: one candidate off-screen, one disabled, one viable.
  let gatedAmbiguity = ''
  try {
    resolveTapTarget(wdaSourceToElements([
      '<XCUIElementTypeApplication x="0" y="0" width="400" height="800">',
      '  <XCUIElementTypeButton name="del.1" label="Delete" enabled="true" visible="true" x="16" y="100" width="370" height="52"/>',
      '  <XCUIElementTypeButton name="del.2" label="Delete" enabled="true" visible="false" x="16" y="160" width="370" height="52"/>',
      '  <XCUIElementTypeButton name="del.3" label="Delete" enabled="false" visible="true" x="16" y="220" width="370" height="52"/>',
      '</XCUIElementTypeApplication>',
    ].join('')), { label: 'Delete' }, { allowOffscreen: true })
  } catch (error) {
    gatedAmbiguity = String(error.message)
  }
  step(
    'candidate lists show the false flags and the skipped count',
    gatedAmbiguity.includes('3 elements match') && gatedAmbiguity.includes('skipped: off-screen or disabled')
      && gatedAmbiguity.includes('visible=false') && gatedAmbiguity.includes('enabled=false')
      && gatedAmbiguity.includes('del.1') && gatedAmbiguity.includes('del.2') && gatedAmbiguity.includes('del.3'),
    gatedAmbiguity.split('\n')[0],
  )
  // Without the escape hatch the same selector degrades to the ONE viable
  // candidate (visible AND enabled) instead of failing.
  const gatedPick = resolveTapTarget(wdaSourceToElements([
    '<XCUIElementTypeApplication x="0" y="0" width="400" height="800">',
    '  <XCUIElementTypeButton name="del.1" label="Delete" enabled="true" visible="true" x="16" y="100" width="370" height="52"/>',
    '  <XCUIElementTypeButton name="del.2" label="Delete" enabled="true" visible="false" x="16" y="160" width="370" height="52"/>',
    '  <XCUIElementTypeButton name="del.3" label="Delete" enabled="false" visible="true" x="16" y="220" width="370" height="52"/>',
    '</XCUIElementTypeApplication>',
  ].join('')), { label: 'Delete' })
  step(
    'the default gate matches ONLY visible+enabled candidates',
    gatedPick.element.identifier === 'del.1' && gatedPick.matchedBy === 'exact',
    `identifier=${gatedPick.element.identifier}`,
  )
  await expectThrow('no-match raises the tree-inspection hint', () => resolveTapTarget(roots, { identifier: 'nope' }), /no accessibility element matches[\s\S]*ios_sim_ui_tree/i)
  const capped = capTreeToBytes(roots.map(node => ({ type: node.type, label: node.label, identifier: node.identifier, frame: node.frame, children: [] })))
  step('normalized fixture fits the 40 KB cap untruncated', capped.truncated === false)

  // ── A3. routing: real udid → WDA, sim udid → simctl/AXe path unchanged ────
  const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-ios-realtools-cache-'))
  tempDirs.push(cacheDir)
  const fakeWda = makeFakeWda()
  const tools = createSimTools(host, { wda: fakeWda, realDevices, cacheDir })
  const uiTools = createSimUiTools(host, { wda: fakeWda, realDevices, cacheDir })

  const shot = await tools.iosSimScreenshot.execute({ udid: FAKE_REAL_UDID }, makeExec('ios_sim_screenshot', { udid: FAKE_REAL_UDID }))
  step(
    'ios_sim_screenshot real udid → WDA screenshot into the shared cache layout',
    typeof shot.path === 'string' && shot.path.includes(join(cacheDir, 'screenshots', `screenshot-${FAKE_REAL_UDID}-`))
      && existsSync(shot.path) && shot.bytes > 0 && shot.width === 1 && shot.height === 1
      && shot.device.udid === FAKE_REAL_UDID && shot.device.name === 'Smoke Phone'
      && fakeWda.__state.ensureRunningCalls === 1,
    `${shot.path} (${shot.bytes} bytes)`,
  )
  const shotMeta = tools.iosSimScreenshot.output.presentationMeta({ udid: FAKE_REAL_UDID }, shot)
  step(
    'real-device screenshot keeps the signed sim-screenshot presentationMeta',
    shotMeta.kind === 'sim-screenshot' && shotMeta.screenshotPath === shot.path && shotMeta.device.udid === FAKE_REAL_UDID,
  )

  const tapped = await tools.iosSimInteract.execute(
    { udid: FAKE_REAL_UDID, action: 'tap', x: 0.5, y: 0.5 },
    makeExec('ios_sim_interact', { udid: FAKE_REAL_UDID, action: 'tap', x: 0.5, y: 0.5 }),
  )
  step(
    'ios_sim_interact tap: normalized 0..1 → absolute points via window size',
    tapped.action === 'tap' && fakeWda.__state.taps.length === 1
      && fakeWda.__state.taps[0].x === 201 && fakeWda.__state.taps[0].y === 437,
    `wda tap(${fakeWda.__state.taps[0]?.x}, ${fakeWda.__state.taps[0]?.y}) for 0.5×402, 0.5×874`,
  )
  step(
    'interact keeps the ~300 ms settle + fresh screenshot shape',
    typeof tapped.path === 'string' && existsSync(tapped.path) && tapped.path !== shot.path
      && tapped.bytes > 0 && tapped.device.udid === FAKE_REAL_UDID,
    tapped.path,
  )
  const home = await tools.iosSimInteract.execute(
    { udid: FAKE_REAL_UDID, action: 'button', name: 'home' },
    makeExec('ios_sim_interact', { udid: FAKE_REAL_UDID, action: 'button', name: 'home' }),
  )
  step(
    'ios_sim_interact button home → WDA pressButton',
    home.action === 'button' && fakeWda.__state.buttons.join(',') === 'home' && existsSync(home.path),
  )
  const dragged = await tools.iosSimInteract.execute(
    { udid: FAKE_REAL_UDID, action: 'gesture', json: { fromX: 0.1, fromY: 0.2, toX: 0.9, toY: 0.8, duration: 0.5 } },
    makeExec('ios_sim_interact', { udid: FAKE_REAL_UDID, action: 'gesture' }),
  )
  const drag = fakeWda.__state.drags[0]
  step(
    'ios_sim_interact gesture → WDA drag (normalized to absolute)',
    dragged.action === 'gesture' && drag !== undefined
      && drag.fromX === 40 && drag.fromY === 175 && drag.toX === 362 && drag.toY === 699
      && drag.duration === 0.5,
    `drag(${drag?.fromX},${drag?.fromY})→(${drag?.toX},${drag?.toY}) ${drag?.duration}s`,
  )
  const typed = await tools.iosSimInteract.execute(
    { udid: FAKE_REAL_UDID, action: 'type', text: 'hello' },
    makeExec('ios_sim_interact', { udid: FAKE_REAL_UDID, action: 'type' }),
  )
  step(
    'ios_sim_interact type → WDA typeText',
    typed.action === 'type' && fakeWda.__state.texts.join(',') === 'hello',
  )

  // ── A3b. ios_sim_interact scroll: arg validation + both backends ──────────
  // WP54: agents were hand-building /wda/dragfromtoforduration + /wda/scroll via
  // raw curl because interact had no scroll verb — this closes that gap.
  const scrollFrame = (args, index) => JSON.parse(interactControlArgs(args)[index][1])
  await expectThrow(
    'scroll rejects a missing direction with an actionable message',
    () => interactControlArgs({ action: 'scroll' }),
    /action "scroll" requires direction "up", "down", "left" or "right"/,
  )
  await expectThrow(
    'scroll rejects an invalid direction',
    () => interactControlArgs({ action: 'scroll', direction: 'diagonal' }),
    /action "scroll" requires direction "up", "down", "left" or "right"[\s\S]*diagonal/,
  )
  for (const direction of ['up', 'down', 'left', 'right']) {
    const frames = interactControlArgs({ action: 'scroll', direction })
    const ok = frames.length === 3
      && JSON.parse(frames[0][1]).type === 'begin'
      && JSON.parse(frames[1][1]).type === 'move'
      && JSON.parse(frames[2][1]).type === 'end'
    step(`scroll accepts direction ${JSON.stringify(direction)} (begin→move→end)`, ok)
  }
  const downFrames = interactControlArgs({ action: 'scroll', direction: 'down' }).map(payload => JSON.parse(payload[1]))
  step(
    "scroll 'down' produces an UPWARD finger path (start y > end y) inside 8%..92%",
    downFrames.length === 3
      && downFrames[0].y > downFrames[2].y
      && [downFrames[0].y, downFrames[2].y].every(y => y >= 0.08 && y <= 0.92)
      && downFrames[0].x === downFrames[2].x,
    `begin y=${downFrames[0]?.y} → end y=${downFrames[2]?.y}`,
  )
  const edgeScroll = interactControlArgs({ action: 'scroll', direction: 'down', y: 0.99 }).map(payload => JSON.parse(payload[1]))
  step(
    'a scroll anchored at the bottom is clamped out of the home-indicator strip',
    edgeScroll[0].y >= 0.08 && edgeScroll[0].y <= 0.92 && edgeScroll[2].y >= 0.08 && edgeScroll[2].y <= 0.92,
    `begin y=${edgeScroll[0]?.y} end y=${edgeScroll[2]?.y}`,
  )

  // Real-device scroll → WDA dragFromToForDuration in POINTS (402×874 window).
  const scrolled = await tools.iosSimInteract.execute(
    { udid: FAKE_REAL_UDID, action: 'scroll', direction: 'down' },
    makeExec('ios_sim_interact', { udid: FAKE_REAL_UDID, action: 'scroll', direction: 'down' }),
  )
  const scrollDrag = fakeWda.__state.drags[fakeWda.__state.drags.length - 1]
  step(
    'ios_sim_interact scroll → WDA dragFromToForDuration in points (window size), ≈0.35 s, clamped',
    scrolled.action === 'scroll' && scrollDrag !== undefined
      && scrollDrag.fromX === 201 && scrollDrag.fromY === 437
      && scrollDrag.toX === 201 && scrollDrag.toY === Math.round(0.08 * 874)
      && Math.abs(scrollDrag.duration - 0.35) < 1e-9
      && scrollDrag.fromY >= 0.08 * 874 && scrollDrag.fromY <= 0.92 * 874
      && scrollDrag.toY >= 0.08 * 874 && scrollDrag.toY <= 0.92 * 874
      && scrollDrag.fromY > scrollDrag.toY,
    `drag(${scrollDrag?.fromX},${scrollDrag?.fromY})→(${scrollDrag?.toX},${scrollDrag?.toY}) ${scrollDrag?.duration}s`,
  )

// ── A3c. WP56: simulator gestures ride the stream's WS control channel ────
  // Measured on a live simulator: the serve-sim CLI spawns ONE PROCESS PER
  // TOUCH EVENT, so a scroll (begin + 5 moves + end = 7 invocations) took
  // 2.05 s wall with ~290 ms of stationary contact before the first move. iOS
  // read that as a press-and-drag — scrolling Calendar's month view opened the
  // NEW EVENT sheet. The same path over serve-sim's WS touch channel at 16 ms
  // per frame scrolls correctly (八月 → 九月, nothing created). These steps pin
  // the frame encoding, the pure geometry, the socket timing and the fallback.
  const beginFrame = encodeSimTouchFrame('begin', 0.5, 0.25)
  step(
    'encodeSimTouchFrame is [tag 3][utf-8 JSON {type,x,y}] (host twin of the panel encoder)',
    SIM_TOUCH_TAG === 3 && beginFrame[0] === 3
      && beginFrame.subarray(1).toString('utf8') === '{"type":"begin","x":0.5,"y":0.25}',
    `frame[0]=${beginFrame[0]} body=${beginFrame.subarray(1).toString('utf8')}`,
  )
  const clampedFrame = encodeSimTouchFrame('move', 1.7, -0.4)
  step(
    'touch frames clamp x/y into 0..1 exactly like the client encoder',
    clampedFrame.subarray(1).toString('utf8') === '{"type":"move","x":1,"y":0}',
    clampedFrame.subarray(1).toString('utf8'),
  )
  const buttonFrame = encodeSimButtonFrame('home')
  step(
    'encodeSimButtonFrame is [tag 4][utf-8 JSON {button}]',
    buttonFrame[0] === 4 && buttonFrame.subarray(1).toString('utf8') === '{"button":"home"}',
    `frame[0]=${buttonFrame[0]} body=${buttonFrame.subarray(1).toString('utf8')}`,
  )

  // simScrollPath is PURE: the geometry is assertable without a socket, and it
  // is the ONE source the CLI/WDA endpoints are read from (so they cannot drift).
  const inBand = value => value >= 0.08 && value <= 0.92
  const geometryFailures = []
  for (const direction of ['up', 'down', 'left', 'right']) {
    for (const amount of [0.1, 1.0]) {
      const path = simScrollPath({ direction, amount, anchorX: 0.5, anchorY: 0.5 })
      const vertical = direction === 'up' || direction === 'down'
      const travel = path.map(point => (vertical ? point.y : point.x))
      const fixed = path.map(point => (vertical ? point.x : point.y))
      if (path.length !== SIM_SCROLL_STEPS + 1) geometryFailures.push(`${direction}/${amount}: ${path.length} points`)
      if (!travel.every(inBand)) geometryFailures.push(`${direction}/${amount}: outside 8%..92% (${travel.join(',')})`)
      if (!fixed.every(value => value === 0.5)) geometryFailures.push(`${direction}/${amount}: the still axis moved`)
      // 'down'/'right' reveal content further along, so the FINGER goes the
      // other way (smaller coordinate); 'up'/'left' mirror it.
      const descending = direction === 'down' || direction === 'right'
      const ordered = travel.every((value, index) => index === 0 || (descending ? value < travel[index - 1] : value > travel[index - 1]))
      if (!ordered) geometryFailures.push(`${direction}/${amount}: not monotonic (${travel[0]} → ${travel[travel.length - 1]})`)
    }
  }
  step(
    `simScrollPath geometry: ${SIM_SCROLL_STEPS + 1} points, monotonic, inside 8%..92% for every direction × amount 0.1/1.0`,
    geometryFailures.length === 0,
    geometryFailures.length === 0 ? 'down/right = finger up/left; up/left mirror it' : geometryFailures.join(' | '),
  )
  const downPath = simScrollPath({ direction: 'down', amount: 0.6, anchorX: 0.5, anchorY: 0.5 })
  const upPath = simScrollPath({ direction: 'up', amount: 0.6, anchorX: 0.5, anchorY: 0.5 })
  step(
    "'down' produces an UPWARD finger path and 'up' its mirror",
    downPath[0].y > downPath[downPath.length - 1].y
      && upPath[0].y < upPath[upPath.length - 1].y
      && downPath[downPath.length - 1].y === 0.08 && upPath[upPath.length - 1].y === 0.92,
    `down ${downPath[0].y} → ${downPath[downPath.length - 1].y}; up ${upPath[0].y} → ${upPath[upPath.length - 1].y}`,
  )
  const edgePath = simScrollPath({ direction: 'down', amount: 0.6, anchorX: 0.5, anchorY: 0.99 })
  step(
    'an anchor inside the home-indicator strip is clamped before the path is traced',
    edgePath.every(point => inBand(point.y)),
    `begin y=${edgePath[0].y} end y=${edgePath[edgePath.length - 1].y}`,
  )
  const cliEndpoints = interactControlArgs({ action: 'scroll', direction: 'down' }).map(payload => JSON.parse(payload[1]))
  step(
    'the CLI fallback frames are the traced path\'s own endpoints (no second geometry)',
    cliEndpoints[0].y === downPath[0].y && cliEndpoints[2].y === downPath[downPath.length - 1].y,
    `cli begin y=${cliEndpoints[0].y} end y=${cliEndpoints[2].y}`,
  )

  // A drag-shaped gesture payload is a PATH too (same reason, same fallback);
  // one raw {type,x,y} frame is a single event and stays on the CLI.
  step(
    'simInteractGesturePath: scroll + drag payloads trace, single events do not',
    simInteractGesturePath({ action: 'scroll', direction: 'down' }).length === SIM_SCROLL_STEPS + 1
      && simInteractGesturePath({ action: 'gesture', json: { fromX: 0.1, fromY: 0.5, toX: 0.9, toY: 0.5 } }).length >= 2
      && simInteractGesturePath({ action: 'gesture', json: { type: 'begin', x: 0.5, y: 0.5 } }) === undefined
      && simInteractGesturePath({ action: 'tap', x: 0.5, y: 0.5 }) === undefined
      && simInteractGesturePath({ action: 'button', name: 'home' }) === undefined,
    'tap/type/button/one frame = one CLI process, nothing to time',
  )
  const dragPath = simDragPath({ fromX: 0.2, fromY: 0.8, toX: 0.8, toY: 0.2, duration: 0.32 })
  step(
    'a drag payload spends its requested duration on POINT COUNT, not on dwelling',
    simDragRequestOf({ fromX: 0.2, fromY: 0.8, toX: 0.8, toY: 0.2 }) !== undefined
      && simDragRequestOf({ type: 'begin', x: 0.5, y: 0.5 }) === undefined
      && dragPath.length === 21 && dragPath[0].x === 0.2 && dragPath[dragPath.length - 1].y === 0.2,
    `0.32 s → ${dragPath.length} points at ${SIM_GESTURE_STEP_MS} ms/frame`,
  )
  const dragFallback = interactControlArgs({ action: 'gesture', json: { fromX: 0.1, fromY: 0.5, toX: 0.9, toY: 0.5 } })
  step(
    'the CLI fallback for a drag payload is the begin→move→end triple, not the raw JSON',
    dragFallback.length === 3 && JSON.parse(dragFallback[0][1]).type === 'begin'
      && JSON.parse(dragFallback[1][1]).x === 0.9 && JSON.parse(dragFallback[2][1]).type === 'end',
    dragFallback.map(payload => payload[1]).join(' '),
  )

  // sendSimGesture against a LOCAL fake serve-sim control socket (ws server in
  // this process — no simulator, no network beyond 127.0.0.1).
  const wsFrames = []
  let wsConnections = 0
  let wsClosed = false
  gestureServer = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  await new Promise((resolve, reject) => {
    gestureServer.once('listening', resolve)
    gestureServer.once('error', reject)
  })
  gestureServer.on('connection', socket => {
    wsConnections += 1
    socket.on('message', data => wsFrames.push({ at: Date.now(), bytes: Buffer.from(data) }))
    socket.on('close', () => { wsClosed = true })
  })
  const gestureWsUrl = `ws://127.0.0.1:${gestureServer.address().port}/ws`
  const waitUntil = async (predicate, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    return predicate()
  }
  const twelvePoints = Array.from({ length: 12 }, (_, index) => ({ x: 0.5, y: 0.8 - index * 0.05 }))
  const report = await sendSimGesture(gestureWsUrl, twelvePoints)
  await waitUntil(() => wsFrames.length >= 13)
  const decoded = wsFrames.map(frame => ({ tag: frame.bytes[0], body: JSON.parse(frame.bytes.subarray(1).toString('utf8')) }))
  const types = decoded.map(frame => frame.body.type)
  step(
    'sendSimGesture writes exactly begin + N moves + end over ONE socket',
    wsConnections === 1 && decoded.length === 13
      && types.join(',') === ['begin', ...Array.from({ length: 11 }, () => 'move'), 'end'].join(',')
      && decoded.every(frame => frame.tag === SIM_TOUCH_TAG)
      && decoded[0].body.y === 0.8 && decoded[11].body.y === decoded[12].body.y
      && report.frames === 13 && report.moves === 11,
    `${decoded.length} frames on ${wsConnections} socket(s): ${types.join(',')}`,
  )
  const gaps = decoded.slice(0, 12).map((frame, index) => (index === 0 ? 0 : wsFrames[index].at - wsFrames[index - 1].at))
  const spread = wsFrames[wsFrames.length - 1].at - wsFrames[0].at
  step(
    `the 12-point path is paced at ${SIM_GESTURE_STEP_MS} ms/frame and finishes in well under 1 s`,
    wsFrames.every((frame, index) => index === 0 || frame.at >= wsFrames[index - 1].at)
      && gaps.slice(1).every(gap => gap >= 10)
      && spread >= 11 * 10 && report.elapsedMs < 1_000,
    `elapsed ${report.elapsedMs} ms (server spread ${spread} ms, gaps ${gaps.slice(1).join('/')} ms)`,
  )
  step(
    'the socket is closed once the gesture is delivered (no consumer left behind)',
    await waitUntil(() => wsClosed),
    `server observed close=${wsClosed}`,
  )

  // Failure paths: both must name the serve-sim stream so the caller can fall back.
  await expectThrow(
    'no wsUrl rejects with the actionable serve-sim message',
    () => sendSimGesture('', twelvePoints),
    /serve-sim stream gesture channel \(no wsUrl[\s\S]*serve-sim CLI/,
  )
  const deadPort = await new Promise(resolve => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  await expectThrow(
    'an unreachable control socket rejects with the actionable serve-sim message',
    () => sendSimGesture(`ws://127.0.0.1:${deadPort}/ws`, twelvePoints, { connectTimeoutMs: 1_000 }),
    /serve-sim stream gesture channel \(ws:\/\/127\.0\.0\.1[\s\S]*is unavailable[\s\S]*serve-sim CLI/,
  )

  // Routing: WS when the host has a live stream for THIS device, CLI otherwise.
  const makeGestureHost = streamInfo => {
    const calls = []
    return {
      calls,
      streamInfo,
      async control(args) {
        calls.push(args.join(' '))
        return { stdout: '', stderr: '' }
      },
    }
  }
  const scrollArgsForRouter = { action: 'scroll', direction: 'down' }
  const scrollPayloads = interactControlArgs(scrollArgsForRouter)
  const liveInfo = { url: 'http://127.0.0.1:3181', streamUrl: 'http://127.0.0.1:3181/stream.mjpeg', wsUrl: gestureWsUrl, port: 3181, device: 'SIM-GESTURE-UDID' }
  const wsHost = makeGestureHost(liveInfo)
  const framesBefore = wsFrames.length
  const wsDelivery = await performSimInteract(wsHost, 'SIM-GESTURE-UDID', scrollArgsForRouter, scrollPayloads)
  await waitUntil(() => wsFrames.length >= framesBefore + SIM_SCROLL_STEPS + 2)
  step(
    `a live stream carries the scroll over the WS channel in ~300 ms (${SIM_SCROLL_STEPS + 2} frames, 0 CLI processes)`,
    wsDelivery.channel === 'ws' && wsDelivery.frames === SIM_SCROLL_STEPS + 2
      && wsHost.calls.length === 0 && wsFrames.length - framesBefore === SIM_SCROLL_STEPS + 2
      && wsDelivery.elapsedMs >= 200 && wsDelivery.elapsedMs <= 600,
    `channel=${wsDelivery.channel} frames=${wsDelivery.frames} elapsed=${wsDelivery.elapsedMs} ms (CLI path measured 2050 ms)`,
  )
  const noStreamHost = makeGestureHost(undefined)
  const noStreamDelivery = await performSimInteract(noStreamHost, 'SIM-GESTURE-UDID', scrollArgsForRouter, scrollPayloads)
  step(
    'no live stream → the scroll falls back to the CLI gesture path (3 serve-sim invocations)',
    noStreamDelivery.channel === 'cli' && noStreamHost.calls.length === 3
      && noStreamHost.calls[0].startsWith('gesture -d SIM-GESTURE-UDID ')
      && /no live serve-sim stream reports a control-socket url/.test(noStreamDelivery.wsError ?? ''),
    `channel=${noStreamDelivery.channel} calls=${noStreamHost.calls.length}`,
  )
  const deadHost = makeGestureHost({ ...liveInfo, wsUrl: `ws://127.0.0.1:${deadPort}/ws` })
  const deadDelivery = await performSimInteract(deadHost, 'SIM-GESTURE-UDID', scrollArgsForRouter, scrollPayloads)
  step(
    'a refused socket falls back to the CLI and keeps the actionable reason (a slow scroll beats a lost one)',
    deadDelivery.channel === 'cli' && deadHost.calls.length === 3
      && /serve-sim stream gesture channel[\s\S]*is unavailable/.test(deadDelivery.wsError ?? ''),
    (deadDelivery.wsError ?? '').slice(0, 120),
  )
  const otherDeviceHost = makeGestureHost({ ...liveInfo, device: 'SOME-OTHER-UDID' })
  const otherDelivery = await performSimInteract(otherDeviceHost, 'SIM-GESTURE-UDID', scrollArgsForRouter, scrollPayloads)
  step(
    "a stream for ANOTHER device never receives this device's gesture",
    otherDelivery.channel === 'cli' && otherDeviceHost.calls.length === 3,
    `channel=${otherDelivery.channel} calls=${otherDeviceHost.calls.length}`,
  )
  const tapHost = makeGestureHost(liveInfo)
  const tapDelivery = await performSimInteract(tapHost, 'SIM-GESTURE-UDID', { action: 'tap', x: 0.5, y: 0.5 }, interactControlArgs({ action: 'tap', x: 0.5, y: 0.5 }))
  step(
    'single events stay on the CLI even with a live socket (one process, one event)',
    tapDelivery.channel === 'cli' && tapHost.calls.join(' ') === 'tap -d SIM-GESTURE-UDID 0.5 0.5'
      && tapDelivery.wsError === undefined,
    tapHost.calls.join(' '),
  )
  const dragHost = makeGestureHost(liveInfo)
  const dragArgs = { action: 'gesture', json: { fromX: 0.1, fromY: 0.5, toX: 0.9, toY: 0.5, duration: 0.32 } }
  const dragFramesBefore = wsFrames.length
  const dragDelivery = await performSimInteract(dragHost, 'SIM-GESTURE-UDID', dragArgs, interactControlArgs(dragArgs))
  await waitUntil(() => wsFrames.length >= dragFramesBefore + 22)
  step(
    'a drag-shaped gesture payload is traced over the WS channel too',
    dragDelivery.channel === 'ws' && dragDelivery.frames === 22 && dragHost.calls.length === 0
      && wsFrames.length - dragFramesBefore === 22,
    `channel=${dragDelivery.channel} frames=${dragDelivery.frames} elapsed=${dragDelivery.elapsedMs} ms`,
  )

  const wdaCallsBeforeSim = fakeWda.__state.ensureRunningCalls
  const simRouteDir = mkdtempSync(join(tmpdir(), 'dsh-ios-sim-route-'))
  tempDirs.push(simRouteDir)
  writeFileSync(join(simRouteDir, 'xcrun'), `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'simctl' && args[1] === 'list' && args[2] === 'devices') {
  process.stdout.write(JSON.stringify({ devices: {} }))
  process.exit(0)
}
process.exit(1)
`, { mode: 0o755 })
  const simRoutePath = process.env.PATH
  process.env.PATH = `${simRouteDir}:${simRoutePath}`
  try {
    await expectThrow(
      'sim udid still routes to the fixture simctl path (no WDA calls)',
      () => tools.iosSimScreenshot.execute({ udid: 'FFFF-SIM-0001' }, makeExec('ios_sim_screenshot', { udid: 'FFFF-SIM-0001' })),
      /unknown simulator "FFFF-SIM-0001"/,
    )
  } finally {
    process.env.PATH = simRoutePath
  }
  step('sim-udid call never touched the WDA backend', fakeWda.__state.ensureRunningCalls === wdaCallsBeforeSim)

  const tree = await uiTools.iosSimUiTree.execute({ udid: FAKE_REAL_UDID }, makeExec('ios_sim_ui_tree', { udid: FAKE_REAL_UDID }))
  step(
    'ios_sim_ui_tree real udid → normalized WDA tree with point size',
    tree.nodeCount > 0 && tree.tree[0]?.type === 'Application'
      && tree.size.width === 402 && tree.size.height === 874
      && tree.device.udid === FAKE_REAL_UDID && tree.truncated !== true,
    `${tree.nodeCount} nodes, ${tree.size.width}x${tree.size.height}`,
  )
  const treeLabels = collectLabels(tree.tree)
  step(
    'default tree EXCLUDES off-screen elements and reports the omitted count',
    !treeLabels.includes('无闹钟') && !treeLabels.includes('闹钟') && !treeLabels.includes('隐藏的按钮')
      && tree.omittedOffscreen > 0 && treeLabels.includes('稍后提醒'),
    `${tree.nodeCount} nodes, ${tree.omittedOffscreen} omitted; labels: ${treeLabels.join(', ')}`,
  )
  const treeAll = await uiTools.iosSimUiTree.execute(
    { udid: FAKE_REAL_UDID, include_offscreen: true },
    makeExec('ios_sim_ui_tree', { udid: FAKE_REAL_UDID, include_offscreen: true }),
  )
  const treeAllLabels = collectLabels(treeAll.tree)
  step(
    'include_offscreen=true enumerates the full tree (omitted count zero)',
    treeAll.omittedOffscreen === 0 && treeAll.nodeCount > tree.nodeCount
      && treeAllLabels.includes('无闹钟') && treeAllLabels.includes('闹钟') && treeAllLabels.includes('隐藏的按钮'),
    `${treeAll.nodeCount} nodes; labels: ${treeAllLabels.join(', ')}`,
  )
  const depth1 = await uiTools.iosSimUiTree.execute({ udid: FAKE_REAL_UDID, max_depth: 1 }, makeExec('ios_sim_ui_tree', { udid: FAKE_REAL_UDID, max_depth: 1 }))
  step('max_depth applies on the WDA tree', depth1.nodeCount > 0 && depth1.nodeCount < tree.nodeCount, `${depth1.nodeCount} nodes`)
  const filtered = await uiTools.iosSimUiTree.execute({ udid: FAKE_REAL_UDID, filter: '闹钟' }, makeExec('ios_sim_ui_tree', { udid: FAKE_REAL_UDID, filter: '闹钟' }))
  const filteredAll = await uiTools.iosSimUiTree.execute(
    { udid: FAKE_REAL_UDID, filter: '闹钟', include_offscreen: true },
    makeExec('ios_sim_ui_tree', { udid: FAKE_REAL_UDID, filter: '闹钟', include_offscreen: true }),
  )
  step(
    'filter keeps matching elements (+ ancestors); off-screen matches need include_offscreen',
    filtered.nodeCount > 0 && filtered.nodeCount < treeAll.nodeCount
      && !collectLabels(filtered.tree).includes('闹钟')
      && collectLabels(filteredAll.tree).includes('闹钟'),
    `default ${filtered.nodeCount} nodes, include_offscreen ${filteredAll.nodeCount} nodes`,
  )

  await expectThrow(
    'tap_element refuses an off-screen-only match with the actionable message',
    () => uiTools.iosSimTapElement.execute({ udid: FAKE_REAL_UDID, label: '无闹钟' }, makeExec('ios_sim_tap_element', { udid: FAKE_REAL_UDID, label: '无闹钟' })),
    /matched an off-screen element[\s\S]*scroll it into view first[\s\S]*allow_offscreen=true/,
  )
  await expectThrow(
    'tap_element refuses a disabled match',
    () => uiTools.iosSimTapElement.execute({ udid: FAKE_REAL_UDID, label: '稍后提醒' }, makeExec('ios_sim_tap_element', { udid: FAKE_REAL_UDID, label: '稍后提醒' })),
    /matched a disabled element[\s\S]*is disabled/,
  )
  const tapsBeforeGate = fakeWda.__state.taps.length
  const tapElement = await uiTools.iosSimTapElement.execute(
    { udid: FAKE_REAL_UDID, label: '无闹钟', allow_offscreen: true },
    makeExec('ios_sim_tap_element', { udid: FAKE_REAL_UDID, label: '无闹钟', allow_offscreen: true }),
  )
  const centerTap = fakeWda.__state.taps[1]
  step(
    'tap_element allow_offscreen escape hatch taps the element center + settle screenshot',
    tapElement.action === 'tap-element' && tapElement.element.type === 'Button'
      && tapElement.center.x === 201 && tapElement.center.y === 276.5
      && centerTap !== undefined && centerTap.x === 201 && centerTap.y === 276.5
      && existsSync(tapElement.path) && tapElement.device.udid === FAKE_REAL_UDID,
    `center=(${tapElement.center.x}, ${tapElement.center.y}) tap=(${centerTap?.x}, ${centerTap?.y})`,
  )
  step(
    'the two refusals never reached the tap control',
    tapsBeforeGate === 1,
    `taps before gate=${tapsBeforeGate}`,
  )
  const tapMeta = uiTools.iosSimTapElement.output.presentationMeta({ label: '无闹钟' }, tapElement)
  step(
    'tap_element keeps the sim-screenshot presentationMeta',
    tapMeta.kind === 'sim-screenshot' && tapMeta.screenshotPath === tapElement.path,
  )
  await expectThrow(
    'tap_element no-match uses the shared resolver error',
    () => uiTools.iosSimTapElement.execute({ udid: FAKE_REAL_UDID, identifier: 'nope' }, makeExec('ios_sim_tap_element', { udid: FAKE_REAL_UDID })),
    /no accessibility element matches[\s\S]*ios_sim_ui_tree/i,
  )

  // ── A4. not-ready reason propagation ──────────────────────────────────────
  const lockedWda = makeFakeWda()
  lockedWda.__state.status = {
    available: true,
    running: false,
    consumers: 0,
    reason: 'device-locked',
    detail: 'unlock "Smoke Phone" — WDA keeps waiting and recovers by itself once the device is unlocked',
  }
  const lockedTools = createSimTools(host, { wda: lockedWda, realDevices, cacheDir })
  await expectThrow(
    'recorded device-locked reason fast-fails with the actionable detail (no retry)',
    () => lockedTools.iosSimScreenshot.execute({ udid: FAKE_REAL_UDID }, makeExec('ios_sim_screenshot', { udid: FAKE_REAL_UDID })),
    /WebDriverAgent is not available for "Smoke Phone"[\s\S]*run ios_real_start_wda first[\s\S]*unlock "Smoke Phone"/i,
  )
  step('fast-fail never re-attempted ensureRunning', lockedWda.__state.ensureRunningCalls === 0)

  const certWda = makeFakeWda()
  certWda.__state.ensureRunningError = new WdaError('cert-untrusted', 'dsh-ios: WDA failed to start on Smoke Phone')
  const certUi = createSimUiTools(host, { wda: certWda, realDevices, cacheDir })
  await expectThrow(
    'ensureRunning cert-untrusted failure surfaces the trust-certificate fix',
    () => certUi.iosSimUiTree.execute({ udid: FAKE_REAL_UDID }, makeExec('ios_sim_ui_tree', { udid: FAKE_REAL_UDID })),
    /WebDriverAgent is not available for "Smoke Phone"[\s\S]*run ios_real_start_wda first[\s\S]*trust the Developer App certificate/i,
  )
  const unpluggedWda = makeFakeWda()
  unpluggedWda.__state.ensureRunningError = new WdaError('device-unplugged', 'dsh-ios: no connected physical device matches')
  const unpluggedTools = createSimTools(host, { wda: unpluggedWda, realDevices, cacheDir })
  await expectThrow(
    'ensureRunning device-unplugged failure surfaces the USB fix',
    () => unpluggedTools.iosSimInteract.execute({ udid: FAKE_REAL_UDID, action: 'button', name: 'home' }, makeExec('ios_sim_interact', { udid: FAKE_REAL_UDID })),
    /WebDriverAgent is not available for "Smoke Phone"[\s\S]*run ios_real_start_wda first[\s\S]*connect "Smoke Phone" over USB/i,
  )
  const sourceWda = makeFakeWda()
  sourceWda.__state.sourceError = new Error('connection reset')
  const sourceUi = createSimUiTools(host, { wda: sourceWda, realDevices, cacheDir })
  await expectThrow(
    'WDA source() failures stay descriptive',
    () => sourceUi.iosSimUiTree.execute({ udid: FAKE_REAL_UDID }, makeExec('ios_sim_ui_tree', { udid: FAKE_REAL_UDID })),
    /source\(\) failed for Smoke Phone[\s\S]*connection reset/i,
  )

  // ── A5. still-refused tools carry their NEW specific reasons ──────────────
  if (host.status().available) {
    await expectThrow(
      'ios_sim_boot still refuses real udids (no boot)',
      () => tools.iosSimBoot.execute({ udid: FAKE_REAL_UDID }, makeExec('ios_sim_boot', { udid: FAKE_REAL_UDID })),
      /physical iOS device[\s\S]*boots iOS Simulators only/i,
      /later phase/i,
    )
    await expectThrow(
      'ios_sim_shutdown still refuses real udids',
      () => tools.iosSimShutdown.execute({ udid: FAKE_REAL_UDID }, makeExec('ios_sim_shutdown', { udid: FAKE_REAL_UDID })),
      /physical iOS device[\s\S]*shuts down iOS Simulators only/i,
      /later phase/i,
    )
  } else {
    step('boot/shutdown refusal (serve-sim unavailable on this host)', 'SKIP', host.status().serveSimSource)
  }

  // ── A6. ios_real_start_wda: the explicit start gesture ────────────────────
  step(
    'ios_real_start_wda is registered with the core tools',
    IOS_TOOL_NAMES.includes('ios_real_start_wda') && typeof tools.iosRealStartWda.execute === 'function'
      && typeof tools.iosRealStartWda.output.schema === 'object',
    `IOS_TOOL_NAMES=${IOS_TOOL_NAMES.join(', ')}`,
  )
  step(
    'the tool describes itself as REAL-DEVICE only (never a simulator)',
    /physical iOS device|real devices only|never a simulator/i.test(tools.iosRealStartWda.description)
      && /ios_sim_screenshot|ios_sim_interact/.test(tools.iosRealStartWda.description)
      && /waits until WDA reports ready|control\/MJPEG ports/i.test(tools.iosRealStartWda.description),
    tools.iosRealStartWda.description.slice(0, 140),
  )
  const startWda = makeFakeWda()
  const startTools = createSimTools(host, { wda: startWda, realDevices, cacheDir })
  const startResult = await startTools.iosRealStartWda.execute(
    { udid: FAKE_REAL_UDID },
    makeExec('ios_real_start_wda', { udid: FAKE_REAL_UDID }),
  )
  step(
    'ios_real_start_wda resolves the device, ensures WDA and reports the ports',
    startResult.ready === true
      && startResult.device.udid === FAKE_REAL_UDID
      && startResult.device.name === 'Smoke Phone'
      && startResult.controlPort === 8100
      && startResult.mjpegPort === 9100
      && startResult.adopted === false
      && startWda.__state.ensureRunningCalls === 1,
    JSON.stringify(startResult),
  )
  await expectThrow(
    'ios_real_start_wda refuses a simulator-style reference',
    () => startTools.iosRealStartWda.execute({ udid: 'FFFF-SIM-0001' }, makeExec('ios_real_start_wda', { udid: 'FFFF-SIM-0001' })),
    /not a connected physical iOS device[\s\S]*real devices only/i,
  )
  const startFailWda = makeFakeWda()
  startFailWda.__state.ensureRunningError = new WdaError('profile-expired', 'dsh-ios: provisioning profile expired')
  const startFailTools = createSimTools(host, { wda: startFailWda, realDevices, cacheDir })
  await expectThrow(
    'ios_real_start_wda surfaces the classified failure actionably (no "run yourself first" hint)',
    () => startFailTools.iosRealStartWda.execute({ udid: FAKE_REAL_UDID }, makeExec('ios_real_start_wda', { udid: FAKE_REAL_UDID })),
    /ios_real_start_wda: WebDriverAgent is not available for "Smoke Phone"[\s\S]*free-team provisioning profile expired/i,
    /run ios_real_start_wda first/i,
  )
  const recordedFailWda = makeFakeWda()
  recordedFailWda.__state.status = {
    available: true,
    running: false,
    consumers: 0,
    reason: 'build-failed',
    detail: 'the WebDriverAgentRunner build failed — fix the error and re-run',
  }
  const recordedFailTools = createSimTools(host, { wda: recordedFailWda, realDevices, cacheDir })
  const recordedResult = await recordedFailTools.iosRealStartWda.execute(
    { udid: FAKE_REAL_UDID },
    makeExec('ios_real_start_wda', { udid: FAKE_REAL_UDID }),
  )
  step(
    'ios_real_start_wda RE-ATTEMPTS a previously recorded failure (it IS the start gesture)',
    recordedResult.ready === true && recordedFailWda.__state.ensureRunningCalls === 1,
    `ensureRunningCalls=${recordedFailWda.__state.ensureRunningCalls} (must be 1, not a fast-fail)`,
  )

  // ── B. live pass: phone connected AND WDA up on :8100 ─────────────────────
  let live = false
  if (!RUN_LIVE_PART) {
    step('live pass (phone + running WDA)', 'SKIP', 'fixture-only by default; opt in with DSH_IOS_SMOKE_REAL_DEVICE=1')
  } else {
    try {
      const devices = await listRealDevices()
      const phone = devices.find(d => d.udid === DEVICE_UDID)
      live = phone !== undefined && await probeWdaControlTunnel(8100)
      if (!live) {
        step('live pass (phone + running WDA)', 'SKIP', phone === undefined ? 'phone not connected' : 'WDA not answering on 127.0.0.1:8100')
      }
    } catch (error) {
      step('live pass (phone + running WDA)', 'SKIP', `devicectl unavailable: ${String(error)}`)
    }
  }
  if (live) {
    const liveCache = mkdtempSync(join(tmpdir(), 'dsh-ios-realtools-live-'))
    tempDirs.push(liveCache)
    liveWda = new WdaController()
    const liveTools = createSimTools(host, { wda: liveWda, cacheDir: liveCache })
    const liveUi = createSimUiTools(host, { wda: liveWda, cacheDir: liveCache })

    const liveTree = await liveUi.iosSimUiTree.execute({ udid: DEVICE_UDID }, makeExec('ios_sim_ui_tree', { udid: DEVICE_UDID }))
    const liveLabels = collectLabels(liveTree.tree)
    step(
      'LIVE ios_sim_ui_tree returns a tree with recognizable elements',
      liveTree.nodeCount > 0 && liveTree.tree[0]?.type === 'Application'
        && liveTree.size.width > 0 && liveTree.size.height > 0
        && liveLabels.some(label => label !== ''),
      `${liveTree.nodeCount} nodes ${liveTree.size.width}x${liveTree.size.height}; labels: ${liveLabels.slice(0, 6).join(', ')}`,
    )
    // Home first so the screenshot captures an awake (not near-black AOD) screen.
    const liveHome = await liveTools.iosSimInteract.execute(
      { udid: DEVICE_UDID, action: 'button', name: 'home' },
      makeExec('ios_sim_interact', { udid: DEVICE_UDID, action: 'button', name: 'home' }),
    )
    step(
      'LIVE ios_sim_interact button home works',
      liveHome.action === 'button' && existsSync(liveHome.path) && liveHome.bytes > 50 * 1024
        && liveHome.device.udid === DEVICE_UDID,
      `${Math.round(liveHome.bytes / 1024)} KB ${liveHome.path}`,
    )
    const liveShot = await liveTools.iosSimScreenshot.execute({ udid: DEVICE_UDID }, makeExec('ios_sim_screenshot', { udid: DEVICE_UDID }))
    step(
      'LIVE ios_sim_screenshot writes a PNG >50 KB',
      existsSync(liveShot.path) && liveShot.bytes > 50 * 1024 && liveShot.device.udid === DEVICE_UDID,
      `${Math.round(liveShot.bytes / 1024)} KB ${liveShot.width}x${liveShot.height} ${liveShot.path}`,
    )
    step('LIVE ios_sim_tap_element', 'SKIP', 'not exercised on the personal phone (safety: read-only + home button only)')
  }
} catch (error) {
  step('smoke completed without uncaught errors', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  try { await liveWda?.dispose() } catch { /* best effort */ }
  try { await host?.dispose() } catch { /* best effort */ }
  try { gestureServer?.close() } catch { /* best effort */ }
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// ── C. the devicectl listing must be LOSSLESS JSON ────────────────────────
// The production failure this closes: DSH materializes every tool result
// through a lossless-JSON boundary that rejects a PRESENT key holding
// `undefined`. The listing built one object per device with the optional
// fields guarded only by their PARENT, so a half-described device — an
// offline iPad that reports no bootState / marketingName / serialNumber —
// carried four undefined-valued keys and took the whole `ios_sim_devices`
// call down with `value is not lossless JSON`, in Native AND Code Mode. A
// fake `xcrun` serves exactly that mix: one fully-described phone and one
// device that answers with almost nothing.
{
  const losslessDir = mkdtempSync(join(tmpdir(), 'dsh-ios-lossless-'))
  tempDirs.push(losslessDir)
  const listingDoc = {
    info: { outcome: 'success' },
    result: {
      devices: [
        {
          identifier: '11111111-1111-1111-1111-111111111111',
          deviceProperties: { name: 'Full Phone', osVersionNumber: '26.6', osBuildUpdate: '23G71', bootState: 'booted', ddiServicesAvailable: true, developerModeStatus: 'enabled' },
          hardwareProperties: { udid: '00008150-000AFULL0000', marketingName: 'iPhone 17 Pro', productType: 'iPhone18,1', platform: 'iOS', serialNumber: 'FULL000001' },
          connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' },
        },
        // The half-described one: paired long ago, nothing else reported.
        {
          identifier: '22222222-2222-2222-2222-222222222222',
          deviceProperties: { name: 'Sparse iPad' },
          hardwareProperties: { udid: '00008020-000ASPARSE00', productType: 'iPad8,5', platform: 'iOS' },
          connectionProperties: { pairingState: 'paired' },
        },
      ],
    },
  }
  writeFileSync(join(losslessDir, 'xcrun'), `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'devicectl' && args.includes('list') && args.includes('devices')) {
  const idx = args.indexOf('--json-output')
  if (idx >= 0 && idx + 1 < args.length) writeFileSync(args[idx + 1], ${JSON.stringify(JSON.stringify(listingDoc))})
  process.exit(0)
}
process.exit(1)
`, { mode: 0o755 })
  const oldPath = process.env.PATH
  process.env.PATH = `${losslessDir}:${oldPath}`
  try {
    const listed = await listRealDevices()
    // The same boundary DSH applies: a key that exists but holds undefined is
    // a rejection, as are non-finite numbers and -0.
    const offenders = []
    const walk = (value, path) => {
      if (value === undefined) { offenders.push(`${path} = undefined`); return }
      if (value === null || typeof value === 'boolean' || typeof value === 'string') return
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) offenders.push(`${path} = ${String(value)}`)
        return
      }
      if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return }
      if (typeof value !== 'object') { offenders.push(`${path} typeof ${typeof value}`); return }
      for (const key of Object.keys(value)) walk(value[key], `${path}.${key}`)
    }
    walk(listed, 'realDevices')
    step(
      'a half-described device never yields undefined-valued keys (the lossless-JSON boundary)',
      offenders.length === 0,
      offenders.length === 0 ? `${listed.length} devices, every key lossless` : offenders.join(', '),
    )
    const sparse = listed.find(device => device.udid === '22222222-2222-2222-2222-222222222222')
    step(
      'the half-described device still lists, with only the fields it actually reported',
      sparse !== undefined && sparse.name === 'Sparse iPad' && sparse.productType === 'iPad8,5'
        && !('bootState' in sparse) && !('model' in sparse) && !('serialNumber' in sparse)
        && !('ddiServicesAvailable' in sparse) && !('tunnelState' in sparse),
      sparse === undefined ? 'missing from the listing' : `keys=${Object.keys(sparse).join(',')}`,
    )
    const full = listed.find(device => device.udid === '11111111-1111-1111-1111-111111111111')
    step(
      'a fully-described device keeps every field (omission is per-field, not wholesale)',
      full !== undefined && full.model === 'iPhone 17 Pro' && full.serialNumber === 'FULL000001'
        && full.bootState === 'booted' && full.ddiServicesAvailable === true && full.tunnelState === 'connected',
      full === undefined ? 'missing from the listing' : `keys=${Object.keys(full).length}`,
    )
  } finally {
    process.env.PATH = oldPath
  }
}

// ── ios_sim_launch_app: opening an app must not require the shell ──────────
// From a real session: asked to "open the Calendar app", the model had no
// launch tool, reached for `tools.bash({command:'xcrun simctl launch …',
// description:'…'})`, and then confused THAT description with run_code's own
// required top-level one — six rejected calls in a row before it recovered.
// A first-class launch tool removes the whole detour.
{
  const names = [...IOS_TOOL_NAMES]
  step(
    'ios_sim_launch_app and ios_sim_list_apps are registered tool names',
    names.includes('ios_sim_launch_app') && names.includes('ios_sim_list_apps'),
    names.join(', '),
  )
  const listTool = createSimTools(new SimHostController(), {}).iosSimListApps
  step(
    // Same contract as the playbook: the RULE ships to every user, one user's
    // installed app does not.
    'tool descriptions contain no non-Apple bundle identifiers',
    nonAppleBundleIds(Object.values(createSimTools(new SimHostController(), {}))
      .map(t => t?.description ?? '').join('\n')).length === 0,
    'only Apple\'s own bundle ids may appear as examples',
  )
  step(
    'ios_sim_list_apps takes udid/query/include_system, all optional, and is concurrency-safe',
    (listTool.parameters.required ?? []).length === 0
      && listTool.parameters.properties.query?.type === 'string'
      && listTool.parameters.properties.include_system?.type === 'boolean'
      && listTool.isConcurrencySafe({}) === true
      && /not the installed one/.test(listTool.description)
      && /cannot be guessed/.test(listTool.description),
    'the description states the guessed-vs-installed rule generically, naming no third-party app',
  )
  const launchTool = createSimTools(new SimHostController(), {}).iosSimLaunchApp
  step(
    'bundleId and name are both optional in the SCHEMA (exactly-one is enforced in execute)',
    launchTool !== undefined
      && (launchTool.parameters.required ?? []).length === 0
      && launchTool.parameters.properties.bundleId?.type === 'string'
      && launchTool.parameters.properties.name?.type === 'string'
      && launchTool.parameters.properties.udid?.type === 'string'
      && launchTool.parameters.properties.relaunch?.type === 'boolean',
    `required=[${(launchTool?.parameters.required ?? []).join(',')}] props=${Object.keys(launchTool?.parameters.properties ?? {}).join(',')}`,
  )
  step(
    'launch_app tells the model a third-party bundle id cannot be guessed',
    /CANNOT be guessed/.test(launchTool.description) && /ios_sim_list_apps/.test(launchTool.description),
    'name or list — never a guessed id',
  )
  step(
    'the description names the stable Apple bundle ids the model would otherwise guess',
    /com\.apple\.mobilecal/.test(launchTool.description) && /com\.apple\.mobilesafari/.test(launchTool.description)
      && /com\.apple\.Preferences/.test(launchTool.description),
    'Calendar / Safari / Settings ids are inline, so no bash lookup is needed',
  )
  step(
    'it points at build_run for the build-and-install case (no overlap)',
    /ios_sim_build_run/.test(launchTool.description),
    'launch = open an installed app; build_run = build one from source',
  )
  let emptyError = ''
  try {
    await launchTool.execute({ bundleId: '   ' }, {
      callId: 'launch', rootCallId: 'launch', name: 'ios_sim_launch_app', arguments: {}, signal: new AbortController().signal,
    })
  } catch (error) {
    emptyError = error instanceof Error ? error.message : String(error)
  }
  step(
    'a blank bundleId fails fast with an example, before touching any device',
    emptyError.includes('bundleId is required') && emptyError.includes('com.apple.mobilecal'),
    emptyError.slice(0, 120),
  )
}

// ── D. WP57: the missing verb (ios_sim_list_apps) + launch by name ─────────
// The session this closes, measured: "open a list app on the phone and like a
// post" — 377 s, aborted by the user. The agent guessed a stale bundle id,
// ios_sim_app_info failed, and with no tool that lists
// installed apps it shelled out: 25 bash calls averaging 6.6 s (165 s) over
// `xcrun devicectl device info apps`, `xcrun simctl listapps` and finally a
// grep through Xcode's DerivedData. devicectl was ERRORING at the time
// ("CoreDeviceService was unable to locate a device matching the requested
// device identifier … error 1011"), so the empty output read as "the app is not
// installed" and the agent went reading the user's unrelated source trees.
// Three defects, asserted below: a listing verb, a failed listing that can
// never look like an empty one, and launch-by-name.
{
  const SIM_UDID = 'F1B37F70-497C-4C1E-9C5C-87F4CC5448AC'
  const AMBIGUOUS_UDID = 'AAAAAAAA-0000-0000-0000-00000000AMBI'
  const UNBOOTED_UDID = 'BBBBBBBB-0000-0000-0000-00000000BOOT'
  const GARBLED_UDID = 'CCCCCCCC-0000-0000-0000-0000000GARBL'
  const EMPTY_UDID = 'DDDDDDDD-0000-0000-0000-00000000EMPT'
  const REAL_OK_UDID = '00000000-0000-0000-0000-0000000000B1'
  const REAL_UNREACHABLE_UDID = '00000000-0000-0000-0000-0000000000B2'
  const REAL_NOAPPS_UDID = '00000000-0000-0000-0000-0000000000B3'

  // Shaped exactly like the `xcrun simctl listapps` output captured on this Mac
  // (Xcode 26, iOS 26.0 runtime): a dict keyed by bundle id, nested
  // GroupContainers/SBAppTags blocks whose values must NOT be read as app
  // fields, no CFBundleShortVersionString anywhere, and — the detail that
  // decides whether a CJK query can ever match — non-ASCII display names
  // escaped as \Uxxxx (the fixture uses "\U793a\U4f8b" for 示例).
  const LISTAPPS_FIXTURE = [
    '{',
    '    "com.apple.mobilesafari" =     {',
    '        ApplicationType = System;',
    '        Bundle = "file:///Applications/MobileSafari.app/";',
    '        CFBundleDisplayName = Safari;',
    '        CFBundleExecutable = MobileSafari;',
    '        CFBundleIdentifier = "com.apple.mobilesafari";',
    '        CFBundleName = Safari;',
    '        CFBundleVersion = "8622.1.22.10.11";',
    '        GroupContainers =         {',
    '            "group.com.apple.Safari" = "file:///Users/x/Shared/AppGroup/1/";',
    '        };',
    '        Path = "/Applications/MobileSafari.app";',
    '        SBAppTags =         (',
    '        );',
    '    };',
    '    "com.example.feed" =     {',
    '        ApplicationType = User;',
    '        CFBundleDisplayName = "Example Feed";',
    '        CFBundleExecutable = ExampleFeed;',
    '        CFBundleIdentifier = "com.example.feed";',
    '        CFBundleName = ExampleFeed;',
    '        CFBundleVersion = "11.4";',
    '        GroupContainers =         {',
    '            "group.com.example.feed" = "file:///Users/x/Shared/AppGroup/2/";',
    '        };',
    '        Path = "/private/var/containers/Bundle/Application/2/ExampleFeed.app";',
    '        SBAppTags =         (',
    '        );',
    '    };',
    '    "com.example.localized" =     {',
    '        ApplicationType = User;',
    // Doubled here so the JS string carries the literal backslashes simctl prints.
    '        CFBundleDisplayName = "\\U793a\\U4f8b";',
    '        CFBundleIdentifier = "com.example.localized";',
    '        CFBundleName = ExampleLocalized;',
    '        CFBundleVersion = "20260116.1";',
    '        SBAppTags =         (',
    '        );',
    '    };',
    '}',
  ].join('\n')
  // Two display names sharing a substring: the ambiguity case must list both
  // candidates instead of launching a coin flip.
  const LISTAPPS_AMBIGUOUS = [
    '{',
    '    "com.example.webone" =     {',
    '        ApplicationType = User;',
    '        CFBundleDisplayName = "Web One";',
    '        CFBundleIdentifier = "com.example.webone";',
    '        CFBundleVersion = "1.0";',
    '    };',
    '    "com.example.webtwo" =     {',
    '        ApplicationType = User;',
    '        CFBundleDisplayName = "Web Two";',
    '        CFBundleIdentifier = "com.example.webtwo";',
    '        CFBundleVersion = "2.0";',
    '    };',
    '}',
  ].join('\n')

  // ── 1. simctl plist parsing ─────────────────────────────────────────────
  const parsed = parseSimctlListApps(LISTAPPS_FIXTURE, SIM_UDID)
  const app = id => parsed.find(entry => entry.bundleId === id)
  step(
    'simctl listapps: two user apps + one system app, CJK display name decoded',
    parsed.length === 3
      && app('com.example.feed')?.name === 'Example Feed' && app('com.example.feed')?.system === false
      && app('com.example.feed')?.version === '11.4'
      && app('com.example.localized')?.name === '示例' && app('com.example.localized')?.system === false
      && app('com.apple.mobilesafari')?.name === 'Safari' && app('com.apple.mobilesafari')?.system === true,
    parsed.map(entry => entry.bundleId + '=' + entry.name + (entry.system ? ' (system)' : '')).join(', '),
  )
  const userOnly = filterInstalledApps(parsed, {})
  const withSystem = filterInstalledApps(parsed, { includeSystem: true })
  step(
    'include_system false keeps only the user-installed apps',
    userOnly.length === 2 && userOnly.every(entry => entry.system === false)
      && withSystem.length === 3 && withSystem[withSystem.length - 1].bundleId === 'com.apple.mobilesafari',
    'user=[' + userOnly.map(entry => entry.name).join(', ') + '] all=' + withSystem.length,
  )

  // ── 4. the query matches a CJK name and a bundle-id substring ───────────
  const cjkHits = filterInstalledApps(parsed, { query: '示' })
  const idHits = filterInstalledApps(parsed, { query: 'EXAMPLE.FEED' })
  step(
    'query is a case-insensitive substring over BOTH the display name (CJK) and the bundle id',
    cjkHits.length === 1 && cjkHits[0].bundleId === 'com.example.localized'
      && idHits.length === 1 && idHits[0].name === 'Example Feed',
    'query "示" → ' + cjkHits[0]?.bundleId + '; query "EXAMPLE.FEED" → ' + idHits[0]?.bundleId,
  )

  // ── 3a. unparseable output is a FAILURE, not an empty device ────────────
  await expectThrow(
    'non-plist listapps output throws instead of returning count:0',
    async () => parseSimctlListApps('No devices are booted.\n', SIM_UDID),
    /could not parse the simctl listapps output[\s\S]*not the same as the device having no apps/,
  )
  step(
    'an EMPTY plist is still a legitimate zero-app listing',
    parseSimctlListApps('{\n}\n').length === 0,
    'a successful listing may report no apps; a failed one may not',
  )

  const appsDir = mkdtempSync(join(tmpdir(), 'dsh-ios-listapps-'))
  const devicesDoc = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
        { udid: SIM_UDID, name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
        { udid: AMBIGUOUS_UDID, name: 'iPhone Ambiguous', state: 'Booted', isAvailable: true },
        { udid: UNBOOTED_UDID, name: 'iPhone Shutdown', state: 'Shutdown', isAvailable: true },
        { udid: GARBLED_UDID, name: 'iPhone Garbled', state: 'Booted', isAvailable: true },
        { udid: EMPTY_UDID, name: 'iPhone Empty', state: 'Booted', isAvailable: true },
      ],
    },
  }
  const appsDoc = {
    info: { outcome: 'success' },
    result: {
      apps: [
        { bundleIdentifier: 'com.example.feed', name: 'Example Feed', version: '11.4', appType: 'User', builtByDeveloper: false },
        { bundleIdentifier: 'com.apple.Preferences', name: 'Settings', version: '1.0', appType: 'System', defaultApp: true },
      ],
    },
  }
  // The document devicectl wrote while the agent read its empty CLI output as
  // "the app is not installed" (com.apple.dt.CoreDeviceError 1011).
  const unreachableDoc = {
    info: { outcome: 'failed' },
    error: {
      code: 1011,
      domain: 'com.apple.dt.CoreDeviceError',
      userInfo: {
        NSLocalizedDescription: {
          string: 'CoreDeviceService was unable to locate a device matching the requested device identifier (00008150-000AFULL0000).',
        },
      },
    },
  }
  // Exit 0, outcome success, and NO result.apps array: nothing was enumerated.
  const noAppsDoc = { info: { outcome: 'success' }, result: {} }
  writeFileSync(join(appsDir, 'xcrun'), '#!/usr/bin/env node\n' + [
    "const { writeFileSync } = require('node:fs')",
    'const args = process.argv.slice(2)',
    'const writeJson = doc => {',
    "  const idx = args.indexOf('--json-output')",
    '  if (idx >= 0 && idx + 1 < args.length) writeFileSync(args[idx + 1], JSON.stringify(doc))',
    '}',
    "if (args[0] === 'simctl' && args[1] === 'list' && args[2] === 'devices') {",
    '  process.stdout.write(' + JSON.stringify(JSON.stringify(devicesDoc)) + ')',
    '  process.exit(0)',
    '}',
    "if (args[0] === 'simctl' && args[1] === 'listapps') {",
    '  if (args[2] === ' + JSON.stringify(UNBOOTED_UDID) + ') {',
    "    process.stderr.write('Invalid device: ' + args[2] + '\\n')",
    '    process.exit(2)',
    '  }',
    '  if (args[2] === ' + JSON.stringify(GARBLED_UDID) + ') {',
    "    process.stdout.write('No devices are booted.\\n')",
    '    process.exit(0)',
    '  }',
    '  if (args[2] === ' + JSON.stringify(EMPTY_UDID) + ') {',
    "    process.stdout.write('{}')",
    '    process.exit(0)',
    '  }',
    '  process.stdout.write(args[2] === ' + JSON.stringify(AMBIGUOUS_UDID) + ' ? ' + JSON.stringify(LISTAPPS_AMBIGUOUS) + ' : ' + JSON.stringify(LISTAPPS_FIXTURE) + ')',
    '  process.exit(0)',
    '}',
    "if (args[0] === 'simctl' && args[1] === 'launch') {",
    "  if (args[3] === 'com.example.missing') {",
    "    process.stderr.write('The request to open \\\"com.example.missing\\\" failed. No such application.\\n')",
    '    process.exit(4)',
    '  }',
    "  process.stdout.write(args[3] + ': 4242\\n')",
    '  process.exit(0)',
    '}',
    "if (args[0] === 'devicectl') {",
    "  const device = args[args.indexOf('--device') + 1]",
    '  if (device === ' + JSON.stringify(REAL_UNREACHABLE_UDID) + ') {',
    '    writeJson(' + JSON.stringify(unreachableDoc) + ')',
    "    process.stderr.write('ERROR: The specified device was not found.\\n')",
    '    process.exit(1)',
    '  }',
    '  if (device === ' + JSON.stringify(REAL_NOAPPS_UDID) + ') {',
    '    writeJson(' + JSON.stringify(noAppsDoc) + ')',
    '    process.exit(0)',
    '  }',
    '  writeJson(' + JSON.stringify(appsDoc) + ')',
    '  process.exit(0)',
    '}',
    'process.exit(1)',
    '',
  ].join('\n'), { mode: 0o755 })

  const previousPath = process.env.PATH
  process.env.PATH = appsDir + ':' + previousPath
  try {
    // ── 2. devicectl JSON mapping + the CoreDevice 1011 case ─────────────
    const realApps = await listPhysicalDeviceApps(REAL_OK_UDID)
    step(
      'devicectl result.apps[] maps to bundleId / name / version / system',
      realApps.length === 2
        && realApps[0].bundleId === 'com.example.feed' && realApps[0].name === 'Example Feed'
        && realApps[0].version === '11.4' && realApps[0].system === false
        && realApps[1].bundleId === 'com.apple.Preferences' && realApps[1].system === true,
      realApps.map(entry => entry.bundleId + (entry.system ? ' (system)' : '')).join(', '),
    )
    let unreachableMessage = 'no error was thrown'
    let unreachableValue
    try {
      unreachableValue = await listPhysicalDeviceApps(REAL_UNREACHABLE_UDID)
    } catch (error) {
      unreachableMessage = error instanceof Error ? error.message : String(error)
    }
    step(
      'CoreDevice 1011 THROWS "not reachable by CoreDevice" and never returns an empty list',
      unreachableValue === undefined
        && /not reachable by CoreDevice/.test(unreachableMessage)
        && /reconnect it over USB/.test(unreachableMessage)
        && /not the same as the app being missing/.test(unreachableMessage),
      unreachableMessage.slice(0, 200),
    )
    await expectThrow(
      'a success document with no result.apps array throws (nothing was enumerated)',
      () => listPhysicalDeviceApps(REAL_NOAPPS_UDID),
      /wrote no app list[\s\S]*not the same as the device having no apps/,
    )

    // ── 3b. a non-zero simctl exit throws ────────────────────────────────
    await expectThrow(
      'a non-zero simctl listapps exit throws instead of reporting count:0',
      () => listSimulatorApps(UNBOOTED_UDID),
      /could not list the apps installed on[\s\S]*must be BOOTED[\s\S]*failed listing is not an empty one/,
    )
    await expectThrow(
      'unparseable simctl listapps output throws through the listing helper too',
      () => listSimulatorApps(GARBLED_UDID),
      /could not parse the simctl listapps output/,
    )

    // ── 1b/5. the tools themselves, over the fake xcrun ──────────────────
    const frontmostChanges = []
    const appTools = createSimTools(new SimHostController(), {
      realDevices: {
        matches: async reference => reference === REAL_OK_UDID,
        resolve: async () => fakeRealDevice,
      },
      onFrontmostAppChanged: udid => frontmostChanges.push(udid),
    })
    const listedUser = await appTools.iosSimListApps.execute(
      { udid: SIM_UDID },
      makeExec('ios_sim_list_apps', { udid: SIM_UDID }),
    )
    const listedSafari = await appTools.iosSimListApps.execute(
      { udid: SIM_UDID, include_system: true, query: 'safari' },
      makeExec('ios_sim_list_apps', { udid: SIM_UDID, include_system: true, query: 'safari' }),
    )
    step(
      'ios_sim_list_apps reports device + count + apps, user-installed by default',
      listedUser.count === 2 && listedUser.apps.length === 2
        && listedUser.device.udid === SIM_UDID && listedUser.device.name === 'iPhone 17 Pro'
        && listedUser.apps.every(entry => entry.system === false)
        && listedSafari.count === 1 && listedSafari.apps[0].bundleId === 'com.apple.mobilesafari',
      'user=' + listedUser.count + ', query "safari" + include_system=' + listedSafari.count,
    )
    // WP58: a query that matches nothing must still hand the model the
    // installed names, "name (bundleId)", user apps first — so a Chinese user
    // asking for 日历 sees the closest thing instead of guessing again.
    const listedNoMatch = await appTools.iosSimListApps.execute(
      { udid: SIM_UDID, include_system: true, query: 'zzz-no-such-app' },
      makeExec('ios_sim_list_apps', { udid: SIM_UDID, include_system: true, query: 'zzz-no-such-app' }),
    )
    step(
      'ios_sim_list_apps no-match surfaces "name (bundleId)" candidates, user apps first',
      listedNoMatch.count === 0 && Array.isArray(listedNoMatch.candidates)
        && listedNoMatch.candidates.length === 3
        && listedNoMatch.candidates[0] === 'Example Feed (com.example.feed)'
        && listedNoMatch.candidates[1] === '示例 (com.example.localized)'
        && listedNoMatch.candidates[2] === 'Safari (com.apple.mobilesafari)',
      JSON.stringify(listedNoMatch.candidates),
    )
    // WP60: the SAME no-match must also say why, or count:0 gets read as "the
    // app is not installed". On a simulator localized names resolve, so the
    // hint says the listing was complete - plus the listed total (3 apps).
    step(
      'simulator no-match hint says the listing was complete and reports the listed total',
      typeof listedNoMatch.hint === 'string'
        && listedNoMatch.hint.includes('listing was complete')
        && listedNoMatch.hint.includes('reported 3 apps in total')
        && !listedNoMatch.hint.includes('base (usually English) name'),
      listedNoMatch.hint,
    )
    // An UNFILTERED empty listing keeps today's shape: no hint, because "the
    // device has no apps" is already a fact about the device, not a miss.
    const listedEmpty = await appTools.iosSimListApps.execute(
      { udid: EMPTY_UDID },
      makeExec('ios_sim_list_apps', { udid: EMPTY_UDID }),
    )
    step(
      'an unfiltered empty listing returns count:0 with NO hint (unchanged)',
      listedEmpty.count === 0 && listedEmpty.apps.length === 0
        && listedEmpty.hint === undefined && listedEmpty.candidates === undefined,
      `count=${listedEmpty.count} hint=${JSON.stringify(listedEmpty.hint)}`,
    )
    const launchedByName = await appTools.iosSimLaunchApp.execute(
      { udid: SIM_UDID, name: '示例' },
      makeExec('ios_sim_launch_app', { udid: SIM_UDID, name: '示例' }),
    )
    step(
      'ios_sim_launch_app name → the RESOLVED bundle id is what gets launched',
      launchedByName.bundleId === 'com.example.localized' && launchedByName.name === '示例'
        && launchedByName.launched === true && launchedByName.pid === 4242
        && frontmostChanges.at(-1) === SIM_UDID,
      'name "示例" → ' + launchedByName.bundleId + ' pid ' + launchedByName.pid,
    )
    step(
      'a successful launch emits the frontmost-app change used to invalidate depth memory',
      frontmostChanges.length === 1 && frontmostChanges[0] === SIM_UDID,
      `invalidated=${frontmostChanges.join(',')}`,
    )
    await expectThrow(
      'two name matches throw with the candidates as "name — bundleId" lines',
      () => appTools.iosSimLaunchApp.execute(
        { udid: AMBIGUOUS_UDID, name: 'web' },
        makeExec('ios_sim_launch_app', { udid: AMBIGUOUS_UDID, name: 'web' }),
      ),
      /2 installed apps match "web"[\s\S]*Web One — com\.example\.webone[\s\S]*Web Two — com\.example\.webtwo/,
    )
    await expectThrow(
      'no name match points at ios_sim_list_apps (never at the file system)',
      () => appTools.iosSimLaunchApp.execute(
        { udid: SIM_UDID, name: 'Missing App' },
        makeExec('ios_sim_launch_app', { udid: SIM_UDID, name: 'Missing App' }),
      ),
      /no installed app matches "Missing App"[\s\S]*run ios_sim_list_apps to see what is installed/,
    )
    let bothError
    try {
      await appTools.iosSimLaunchApp.execute(
        { udid: SIM_UDID, name: 'Example Feed', bundleId: 'com.example.missing' },
        makeExec('ios_sim_launch_app', { udid: SIM_UDID, name: 'Example Feed', bundleId: 'com.example.missing' }),
      )
    } catch (error) {
      bothError = error
    }
    step(
      'bundleId AND name together is a CODED argument error, not a precedence rule',
      bothError?.name === 'ToolArgsError' && bothError?.code === 'INVALID_ARGS'
        && /either bundleId or name, not both/.test(bothError?.message ?? ''),
      (bothError?.code ?? 'none') + ': ' + (bothError?.message ?? '').slice(0, 110),
    )
    // A failed launch must name the listing verb instead of leaving the caller
    // guessing which installed identifier differs from the requested one.
    await expectThrow(
      'a failed launch ends with "run ios_sim_list_apps to see what is installed"',
      () => appTools.iosSimLaunchApp.execute(
        { udid: SIM_UDID, bundleId: 'com.example.missing' },
        makeExec('ios_sim_launch_app', { udid: SIM_UDID, bundleId: 'com.example.missing' }),
      ),
      /could not launch com\.example\.missing[\s\S]*run ios_sim_list_apps to see what is installed$/,
    )
  } finally {
    process.env.PATH = previousPath
    try { rmSync(appsDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  // ── 5b. the pure resolver's tie-break, without a device ────────────────
  const twoWeb = [
    { bundleId: 'com.example.web', name: 'Web', system: false },
    { bundleId: 'com.example.webplus', name: 'Web Plus', system: false },
  ]
  step(
    'an EXACT display-name match wins over a longer substring match',
    resolveAppByName('t', twoWeb, 'web', 'Phone').bundleId === 'com.example.web',
    'exact first, then contains — the same rule ios_sim_tap_element uses',
  )

  // ── 6. the playbook states the rules that session violated ────────────
  step(
    'the playbook forbids guessing a third-party bundle id and names the listing verb',
    /Never guess a third-party bundle id/i.test(IOS_SKILL_CONTENT)
      && /ios_sim_list_apps/.test(IOS_SKILL_CONTENT)
      && /name/.test(IOS_SKILL_CONTENT),
    'Acting: pass a name or list the apps, never guess',
  )
  step(
    // The rule has to read as a RULE, not as trivia about one app: a playbook
    // that names a particular third-party app teaches its bundle id instead of
    // the habit, and ships one user's app list to everyone else.
    'the playbook contains no non-Apple bundle identifiers',
    nonAppleBundleIds(IOS_SKILL_CONTENT).length === 0,
    'only Apple\'s own ids may appear as examples; everything else is listed at runtime',
  )
  step(
    'the playbook draws the boundary at the device and rejects the empty-listing inference',
    /## Boundaries/.test(IOS_SKILL_CONTENT)
      && /never go looking for it in the user's source tree/.test(IOS_SKILL_CONTENT)
      && /DerivedData/.test(IOS_SKILL_CONTENT)
      && /is \*\*not\*\* proof an app is absent/.test(IOS_SKILL_CONTENT)
      && /not reachable by CoreDevice/.test(IOS_SKILL_CONTENT),
    'everything the task needs is on the device; read the error, do not infer',
  )
  step(
    'the playbook states the list/feed row rules without a non-Apple bundle identifier',
    /## Lists and feeds/.test(IOS_SKILL_CONTENT)
      && /ios_sim_ui_rows/.test(IOS_SKILL_CONTENT)
      && /ios_sim_tap_row/.test(IOS_SKILL_CONTENT)
      && /expect_count=\{key,delta\}/.test(IOS_SKILL_CONTENT)
      && /never probed/.test(IOS_SKILL_CONTENT)
      && /REFUSED before it happens/.test(IOS_SKILL_CONTENT)
      && nonAppleBundleIds(IOS_SKILL_CONTENT).length === 0,
    'rows + row-relative taps + count verification; probe taps are refused',
  )
  step(
    'the playbook states the three-case rule: shallow/filtered reads are never evidence of no-a11y',
    /NEVER evidence that an app lacks accessibility support/.test(IOS_SKILL_CONTENT)
      && /depth too shallow/.test(IOS_SKILL_CONTENT)
      && /output was filtered/.test(IOS_SKILL_CONTENT)
      && /DEEP, unfiltered read with no labels/.test(IOS_SKILL_CONTENT),
    'attribute an unlabeled read to depth / filter / genuinely-none',
  )
}

// ── E. WP58: localized display names + the no-match candidate list ────────
// The gap this closes, measured on a Chinese simulator: ios_sim_list_apps
// reports Apple's Calendar as "Calendar" (its base CFBundleDisplayName) while
// the screen and ios_sim_find_text both read 日历 — so a Chinese query for 日历
// matched nothing and launch-by-name failed. The localized string lives in
// <AppPath>/<lang>.lproj/InfoPlist.strings; the readers now shared in
// src/plist.ts decode binary plists (UTF-16BE values), XML, and OpenStep text.
// Everything below is static: temp dirs and pure functions, no device.
{
  // ── 1. the extracted plist module round-trips both encodings ─────────────
  const plistDir = mkdtempSync(join(tmpdir(), 'dsh-ios-plist-'))
  const textPath = join(plistDir, 'InfoPlist.strings')
  const binPath = join(plistDir, 'InfoPlist.bin.strings')
  writeFileSync(textPath, '"CFBundleDisplayName" = "日历";\n"CFBundleName" = "MobileCal";\n', 'utf8')
  const converted = spawnSync('plutil', ['-convert', 'binary1', '-o', binPath, textPath], { encoding: 'utf8' })
  if (converted.status === 0) {
    const binDict = readStrings(readFileSync(binPath))
    step(
      'plist: a BINARY .strings fixture round-trips (UTF-16BE values decoded)',
      binDict.CFBundleDisplayName === '日历' && binDict.CFBundleName === 'MobileCal',
      JSON.stringify(binDict),
    )
  } else {
    step('plist: plutil is available to build the binary fixture', 'SKIP', 'plutil not on PATH')
  }
  const textDict = parseStringsText('"CFBundleDisplayName" = "日历";\n"CFBundleName" = "MobileCal";')
  step(
    'plist: the OpenStep "key" = "value"; text form round-trips',
    textDict.CFBundleDisplayName === '日历' && textDict.CFBundleName === 'MobileCal',
    JSON.stringify(textDict),
  )
  rmSync(plistDir, { recursive: true, force: true })

  // ── 5. language resolution order ────────────────────────────────────────
  const candidates = lprojCandidates('zh-Hans-US')
  step(
    'lprojCandidates: zh-Hans-US → full tag, base, underscore zh_CN, Base, en',
    JSON.stringify(candidates) === JSON.stringify(['zh-Hans-US', 'zh-Hans', 'zh_CN', 'Base', 'en']),
    candidates.join(' → '),
  )

  // ── 2/3. a fake app bundle resolves through <lang>.lproj/InfoPlist.strings ─
  const appDir = mkdtempSync(join(tmpdir(), 'dsh-ios-lproj-'))
  const calApp = join(appDir, 'MobileCal.app')
  mkdirSync(join(calApp, 'zh-Hans.lproj'), { recursive: true })
  writeFileSync(join(calApp, 'zh-Hans.lproj', 'InfoPlist.strings'), '"CFBundleDisplayName" = "日历";\n', 'utf8')
  const bareApp = join(appDir, 'Bare.app')
  mkdirSync(bareApp, { recursive: true })
  const parsedWithPath = [
    { bundleId: 'com.apple.mobilecal', name: 'Calendar', system: true, appPath: calApp },
    { bundleId: 'com.example.bare', name: 'Bare', system: false, appPath: bareApp },
  ]
  const localized = await localizeSimApps(parsedWithPath, 'zh-Hans-US')
  const cal = localized.find(app => app.bundleId === 'com.apple.mobilecal')
  const bare = localized.find(app => app.bundleId === 'com.example.bare')
  step(
    'zh-Hans.lproj/InfoPlist.strings resolves the localized name (baseName kept)',
    cal?.name === '日历' && cal?.baseName === 'Calendar',
    JSON.stringify(cal),
  )
  step(
    'a bundle with no .lproj keeps its base name and does not throw',
    bare?.name === 'Bare' && bare?.baseName === undefined,
    JSON.stringify(bare),
  )
  step(
    'matching finds the localized name, the base name, AND the bundle id',
    filterInstalledApps(localized, { query: '日历', includeSystem: true }).some(app => app.bundleId === 'com.apple.mobilecal')
      && filterInstalledApps(localized, { query: 'Calendar', includeSystem: true }).some(app => app.bundleId === 'com.apple.mobilecal')
      && filterInstalledApps(localized, { query: 'mobilecal', includeSystem: true }).some(app => app.bundleId === 'com.apple.mobilecal'),
    '日历 / Calendar / mobilecal all → com.apple.mobilecal',
  )
  rmSync(appDir, { recursive: true, force: true })

  // ── 4. the no-match candidates: shape, ordering, and the 15-line cap ─────
  const many = [
    { bundleId: 'com.user.c', name: 'User C', system: false },
    { bundleId: 'com.user.a', name: 'User A', system: false },
    { bundleId: 'com.user.b', name: 'User B', system: false },
    ...Array.from({ length: 16 }, (_, index) => ({
      bundleId: 'com.sys.' + String(index).padStart(2, '0'),
      name: 'System ' + String(index).padStart(2, '0'),
      system: true,
    })),
  ]
  const capped = noMatchCandidateLines(many)
  step(
    'no-match candidates are "name (bundleId)", user apps first, capped at 15',
    capped.length === 15
      && capped[0] === 'User A (com.user.a)'
      && capped[2] === 'User C (com.user.c)'
      && capped[3] === 'System 00 (com.sys.00)',
    'cap=' + capped.length + ' first="' + capped[0] + '"',
  )
  let launchNoMatch = ''
  try {
    resolveAppByName('ios_sim_launch_app', localized, '不存在', 'iPhone 17 Pro')
  } catch (error) {
    launchNoMatch = error instanceof Error ? error.message : String(error)
  }
  step(
    'resolveAppByName no-match lists "name (bundleId)" candidates + the run-verb wording',
    launchNoMatch.includes('日历 (com.apple.mobilecal)')
      && launchNoMatch.includes('run ios_sim_list_apps to see what is installed')
      && launchNoMatch.includes('do not guess a bundle id')
      && launchNoMatch.includes('do not look for the app outside the device'),
    launchNoMatch.slice(0, 240),
  )
}

// ── F. WP59: devicectl-only tools skip the WDA gate; phone = base names ───
// Defect 1 was measured on the connected iPhone 17 Pro: ios_sim_list_apps on a
// phone went through resolveToolTarget, which threw "WebDriverAgent backend is
// not configured" even though listing only runs `xcrun devicectl` — WDA is
// irrelevant (351 ms / 274 apps with WDA merely PRESENT, never started).
// Defect 2: a phone cannot read <AppPath>/<lang>.lproj/InfoPlist.strings (the
// bundle lives on the device), so devicectl returns BASE names (Calendar,
// Photos, Settings, Alipay/支付宝, Amap/高德地图) and a CJK name lookup can
// never match — the tools must say so instead of guessing.
{
  // ── F1. a devicectl-only target resolves with NO wda; WDA-backed still throws ─
  const wdaLessRealDevices = {
    matches: async reference => reference === FAKE_REAL_UDID,
    resolve: async () => fakeRealDevice,
  }
  const realNoWda = await resolveToolTarget(host, undefined, wdaLessRealDevices, FAKE_REAL_UDID, undefined, { requiresWda: false })
  step(
    'devicectl-only resolveToolTarget reaches the devicectl path with no WDA backend',
    realNoWda.kind === 'real' && realNoWda.device.udid === FAKE_REAL_UDID,
    `kind=${realNoWda.kind} udid=${realNoWda.device.udid}`,
  )
  await expectThrow(
    'a WDA-backed target with no backend still throws the configured error',
    () => resolveToolTarget(host, undefined, wdaLessRealDevices, FAKE_REAL_UDID, undefined),
    /physical iOS device but the WebDriverAgent backend is not configured[\s\S]*ios_real_start_wda/,
  )

  // End-to-end: list_apps (devicectl-only) over a fake xcrun with NO wda, and
  // the WDA-backed screenshot with no backend must still refuse.
  const wdaLessDir = mkdtempSync(join(tmpdir(), 'dsh-ios-wp59-'))
  tempDirs.push(wdaLessDir)
  const wdaLessAppsDoc = {
    info: { outcome: 'success' },
    result: {
      apps: [
        { bundleIdentifier: 'com.example.feed', name: 'Example Feed', version: '11.4', appType: 'User', builtByDeveloper: false },
        { bundleIdentifier: 'com.apple.Preferences', name: 'Settings', version: '1.0', appType: 'System', defaultApp: true },
      ],
    },
  }
  writeFileSync(join(wdaLessDir, 'xcrun'), '#!/usr/bin/env node\n' + [
    "const { writeFileSync } = require('node:fs')",
    'const args = process.argv.slice(2)',
    "if (args[0] === 'devicectl') {",
    "  const idx = args.indexOf('--json-output')",
    '  if (idx >= 0 && idx + 1 < args.length) writeFileSync(args[idx + 1], ' + JSON.stringify(JSON.stringify(wdaLessAppsDoc)) + ')',
    '  process.exit(0)',
    '}',
    'process.exit(1)',
    '',
  ].join('\n'), { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = wdaLessDir + ':' + previousPath
  try {
    const wdaLessTools = createSimTools(host, { realDevices: wdaLessRealDevices })
    const wdaLessList = await wdaLessTools.iosSimListApps.execute(
      { udid: FAKE_REAL_UDID, include_system: true },
      makeExec('ios_sim_list_apps', { udid: FAKE_REAL_UDID, include_system: true }),
    )
    step(
      'ios_sim_list_apps on a phone works with NO wda backend (devicectl alone)',
      wdaLessList.count === 2 && wdaLessList.device.udid === FAKE_REAL_UDID
        && wdaLessList.apps[0].bundleId === 'com.example.feed'
        && wdaLessList.apps[1].bundleId === 'com.apple.Preferences',
      `count=${wdaLessList.count} device=${wdaLessList.device.udid}`,
    )
    // WP60: a phone query that matched nothing must still guide, or count:0 is
    // read as "not installed" (the 377 s detour). A phone reports base names
    // only, so a CJK label cannot match; the hint carries that plus the listed
    // total (2 apps).
    const phoneNoMatchList = await wdaLessTools.iosSimListApps.execute(
      { udid: FAKE_REAL_UDID, include_system: true, query: '不存在的应用' },
      makeExec('ios_sim_list_apps', { udid: FAKE_REAL_UDID, include_system: true, query: '不存在的应用' }),
    )
    step(
      'phone no-match returns count:0 PLUS a base-name hint carrying the listed total',
      phoneNoMatchList.count === 0 && typeof phoneNoMatchList.hint === 'string'
        && phoneNoMatchList.hint.includes('devicectl reports each app')
        && phoneNoMatchList.hint.includes('ios_sim_find_text + ios_sim_tap_text')
        && phoneNoMatchList.hint.includes('reported 2 apps in total')
        && !phoneNoMatchList.hint.includes('listing was complete'),
      phoneNoMatchList.hint,
    )
    await expectThrow(
      'ios_sim_screenshot on a phone with no backend still throws the configured error',
      () => wdaLessTools.iosSimScreenshot.execute({ udid: FAKE_REAL_UDID }, makeExec('ios_sim_screenshot', { udid: FAKE_REAL_UDID })),
      /physical iOS device but the WebDriverAgent backend is not configured[\s\S]*ios_real_start_wda/,
    )
  } finally {
    process.env.PATH = previousPath
  }

  // ── F2. phone no-match adds the base-name sentence; simulator does not ────
  const baseNameApps = [
    { bundleId: 'com.example.feed', name: 'Example Feed', system: false },
    { bundleId: 'com.apple.Preferences', name: 'Settings', system: true },
  ]
  let phoneNoMatch = ''
  try {
    resolveAppByName('ios_sim_launch_app', baseNameApps, '日历', 'Smoke Phone', { physical: true })
  } catch (error) {
    phoneNoMatch = error instanceof Error ? error.message : String(error)
  }
  step(
    'phone no-match adds the base-name sentence and keeps the candidates',
    /devicectl reports each app's base \(usually English\) name/.test(phoneNoMatch)
      && /ios_sim_find_text \+ ios_sim_tap_text/.test(phoneNoMatch)
      && phoneNoMatch.includes('Example Feed (com.example.feed)')
      && phoneNoMatch.includes('Settings (com.apple.Preferences)')
      && /do not guess a bundle id/.test(phoneNoMatch)
      && /do not look for the app outside the device/.test(phoneNoMatch),
    phoneNoMatch.slice(0, 200),
  )
  let simNoMatch = ''
  try {
    resolveAppByName('ios_sim_launch_app', baseNameApps, '日历', 'iPhone 17 Pro', { physical: false })
  } catch (error) {
    simNoMatch = error instanceof Error ? error.message : String(error)
  }
  step(
    'simulator no-match keeps the candidates but NOT the base-name sentence',
    simNoMatch.includes('Example Feed (com.example.feed)')
      && simNoMatch.includes('Settings (com.apple.Preferences)')
      && !/devicectl reports each app's base/.test(simNoMatch)
      && !/base \(usually English\) name/.test(simNoMatch),
    simNoMatch.slice(0, 200),
  )

  // ── F3. exact-name tie-break wins out of 36 substring matches ─────────────
  // The measured resolver selected the one exact display-name match out of 36
  // substring matches — that tie-break must survive.
  const thirtySix = [
    { bundleId: 'com.example.feed', name: 'Example', system: false },
    ...Array.from({ length: 35 }, (_, index) => ({
      bundleId: 'com.example.xylophone' + String(index).padStart(2, '0'),
      name: 'Xylophone ' + String(index).padStart(2, '0'),
      system: false,
    })),
  ]
  const tied = resolveAppByName('ios_sim_launch_app', thirtySix, 'Example', 'Smoke Phone')
  step(
    'exact-name tie-break resolves the exact display name out of 36 substring matches',
    tied.bundleId === 'com.example.feed' && tied.name === 'Example',
    `resolved ${tied.name} → ${tied.bundleId} (${thirtySix.length} substring matches)`,
  )

  // ── F4. the playbook states the simulator-vs-phone naming rule ────────────
  step(
    'the playbook states the simulator-vs-phone naming rule (localized vs base)',
    /on a \*\*simulator\*\*[\s\S]*on-screen \(localized\) name/i.test(IOS_SKILL_CONTENT)
      && /on a \*\*phone\*\*[\s\S]*base \(usually English\) name/i.test(IOS_SKILL_CONTENT)
      && /tap the icon/.test(IOS_SKILL_CONTENT)
      && /use the English name or the bundle id/.test(IOS_SKILL_CONTENT),
    'Acting: simulator = localized names; phone = base names',
  )
}

console.log('')
console.log(`${results.length} steps: ${results.filter(r => r.verdict === 'PASS').length} passed, ${results.filter(r => r.verdict === 'SKIP').length} skipped, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
