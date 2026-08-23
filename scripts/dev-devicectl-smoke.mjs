/**
 * devicectl listing parser smoke test — a pure FIXTURE suite for the
 * physical-vs-simulator discrimination in `listRealDevices`.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-devicectl-smoke.mjs
 *
 * No devicectl call, no simulator, no USB device: the parsing functions are
 * fed recorded fixtures, so this runs identically on any host. It is the
 * regression guard for the bug where `xcrun devicectl list devices` started
 * listing simulators alongside physical devices, and the simulators were
 * routed into the real-device (WebDriverAgent) tool paths.
 *
 * Covered:
 *   - JSON: `hardwareProperties.reality === 'simulated'` is excluded
 *   - JSON: flat `properties['hardware.reality'] === 'simulated'` is excluded
 *   - JSON: `visibilityClass === 'simulators'` is excluded
 *   - JSON: `reality === 'physical'` is kept
 *   - JSON: a device with NO reality field is kept (the offline-iPad
 *     regression guard — "keep only physical" would silently drop it)
 *   - JSON: a mixed simulator + physical listing leaves only the physical
 *     devices, field-for-field intact (per-field spread contract)
 *   - text: a `Reality` column with value `simulated` drops the row and
 *     `physical` (or empty) keeps it, with column slicing intact
 *   - text: the recorded Xcode 26.6 header (Name / Hostname / Identifier /
 *     State / Model, no Reality column) parses EXACTLY as before the fix
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { parseDevicesText, parseJsonDevices } = await import(join(root, 'lib', 'devicectl.js'))

const results = []
function step(name, ok, detail = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  results.push({ name, ok })
  console.log(`${verdict} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Key-order-insensitive structural equality (fixture expectations). */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    return a.every((value, index) => deepEqual(value, b[index]))
  }
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) return false
  return aKeys.every(key => deepEqual(a[key], b[key]))
}

function check(name, actual, expected) {
  step(
    name,
    deepEqual(actual, expected),
    deepEqual(actual, expected) ? '' : `got ${JSON.stringify(actual)}`,
  )
}

function jsonDoc(devices) {
  return { info: { outcome: 'success', version: '518.33' }, result: { devices } }
}

// ── JSON fixtures, shaped on a real Xcode 26.6 capture ─────────────────────
// The connected iPhone reports reality === 'physical' AND
// visibilityClass === 'default'; the offline iPad reports NO reality field
// at all (it must survive the filter).
const physicalIphone = {
  identifier: '96E6B481-3807-594D-B3BC-E1E12307D47C',
  visibilityClass: 'default',
  connectionProperties: {
    pairingState: 'paired',
    transportType: 'localNetwork',
    tunnelState: 'connected',
  },
  deviceProperties: {
    name: 'Fini iPhone 17 Pro',
    osVersionNumber: '26.6',
    osBuildUpdate: '23G71',
    bootState: 'booted',
    developerModeStatus: 'enabled',
    ddiServicesAvailable: true,
  },
  hardwareProperties: {
    udid: '00008150-000A552A1A44401C',
    marketingName: 'iPhone 17 Pro',
    productType: 'iPhone18,1',
    platform: 'iOS',
    serialNumber: 'DR72YDJ5D4',
    reality: 'physical',
  },
}

const offlineIpad = {
  identifier: '5B625AA0-BFE5-5FDE-9443-6E1ABD535825',
  visibilityClass: 'default',
  connectionProperties: { pairingState: 'paired', tunnelState: 'unavailable' },
  deviceProperties: {
    name: 'Fini的iPad Pro',
    osVersionNumber: '26.3.1',
    osBuildUpdate: '23D8133',
    ddiServicesAvailable: false,
  },
  hardwareProperties: {
    udid: '00008027-000670542220802E',
    productType: 'iPad8,5',
    platform: 'iOS',
  },
}

const simViaHardwareReality = {
  identifier: '11111111-2222-3333-4444-5555555555AA',
  visibilityClass: 'default',
  connectionProperties: { pairingState: 'paired', transportType: 'localNetwork', tunnelState: 'connected' },
  deviceProperties: { name: 'iPhone 17 Pro', osVersionNumber: '26.6', osBuildUpdate: '23G71', bootState: 'booted', developerModeStatus: 'enabled' },
  hardwareProperties: { udid: '00008150-SIM01', marketingName: 'iPhone 17 Pro', productType: 'iPhone18,1', platform: 'iOS', reality: 'simulated' },
}

const simViaFlatReality = {
  identifier: '22222222-3333-4444-5555-6666666666BB',
  visibilityClass: 'default',
  connectionProperties: { pairingState: 'paired', tunnelState: 'connected' },
  deviceProperties: { name: 'iPad Pro Sim' },
  hardwareProperties: { platform: 'iOS', productType: 'iPad8,5' },
  properties: { 'hardware.reality': 'simulated' },
}

const simViaVisibilityClass = {
  identifier: '33333333-4444-5555-6666-7777777777CC',
  connectionProperties: { pairingState: 'unpaired', tunnelState: 'connected' },
  deviceProperties: { name: 'iPhone SE Sim' },
  hardwareProperties: { platform: 'iOS', productType: 'iPhone12,8' },
  visibilityClass: 'simulators',
}

const physicalIphoneExpected = {
  udid: '96E6B481-3807-594D-B3BC-E1E12307D47C',
  hardwareUdid: '00008150-000A552A1A44401C',
  name: 'Fini iPhone 17 Pro',
  osVersion: '26.6',
  build: '23G71',
  bootState: 'booted',
  ddiServicesAvailable: true,
  model: 'iPhone 17 Pro',
  productType: 'iPhone18,1',
  platform: 'iOS',
  serialNumber: 'DR72YDJ5D4',
  state: 'available (paired)',
  connection: 'unknown',
  pairingState: 'paired',
  tunnelState: 'connected',
  developerMode: 'enabled',
}

const offlineIpadExpected = {
  udid: '5B625AA0-BFE5-5FDE-9443-6E1ABD535825',
  hardwareUdid: '00008027-000670542220802E',
  name: 'Fini的iPad Pro',
  osVersion: '26.3.1',
  build: '23D8133',
  productType: 'iPad8,5',
  platform: 'iOS',
  state: 'unavailable',
  connection: 'unknown',
  pairingState: 'paired',
  tunnelState: 'unavailable',
  developerMode: 'unknown',
}

// ── 1-3. each explicit simulator verdict excludes the entry ────────────────
check(
  'json: hardwareProperties.reality "simulated" excluded',
  parseJsonDevices(jsonDoc([simViaHardwareReality])),
  [],
)
check(
  'json: flat properties["hardware.reality"] "simulated" excluded',
  parseJsonDevices(jsonDoc([simViaFlatReality])),
  [],
)
check(
  'json: visibilityClass "simulators" excluded',
  parseJsonDevices(jsonDoc([simViaVisibilityClass])),
  [],
)

// ── 4. reality "physical" is kept, field for field ─────────────────────────
check(
  'json: reality "physical" kept (iPhone, field-for-field)',
  parseJsonDevices(jsonDoc([physicalIphone])),
  [physicalIphoneExpected],
)

// ── 5. the offline iPad: NO reality field, still kept ──────────────────────
check(
  'json: device without any reality field kept (offline iPad)',
  parseJsonDevices(jsonDoc([offlineIpad])),
  [offlineIpadExpected],
)

// ── 6. mixed listing: only the physical devices remain ─────────────────────
check(
  'json: mixed simulator + physical listing leaves only physical devices',
  parseJsonDevices(jsonDoc([simViaHardwareReality, physicalIphone, simViaFlatReality, offlineIpad, simViaVisibilityClass])),
  [physicalIphoneExpected, offlineIpadExpected],
)

// ── text fallback fixtures ─────────────────────────────────────────────────

// Verbatim Xcode 26.6 output (devicectl 518.33): Name / Hostname /
// Identifier / State / Model — no Reality column. Frozen so a future change
// to this legacy path cannot slip through silently. Name stops at Hostname:
// that column bounds the slice even though it is never emitted, the same
// rule the Reality column follows.
const textXcode26 = [
"Name                 Hostname                              Identifier                             State         Model                     ",
"------------------   -----------------------------------   ------------------------------------   -----------   --------------------------",
"Fini iPhone 17 Pro   Fini-iPhone-17-Pro.coredevice.local   96E6B481-3807-594D-B3BC-E1E12307D47C   connected     iPhone 17 Pro (iPhone18,1)",
"Fini的iPad Pro        FinideiPad-Pro.coredevice.local       5B625AA0-BFE5-5FDE-9443-6E1ABD535825   unavailable   iPad8,5                   ",
].join('\n')

const textXcode26Expected = [
  {
    udid: '96E6B481-3807-594D-B3BC-E1E12307D47C',
    name: 'Fini iPhone 17 Pro',
    state: 'connected',
    connection: 'unknown',
    pairingState: 'unknown',
    developerMode: 'unknown',
    model: 'iPhone 17 Pro (iPhone18,1)',
  },
  {
    udid: '5B625AA0-BFE5-5FDE-9443-6E1ABD535825',
    name: 'Fini的iPad Pro',
    state: 'unavailable',
    connection: 'unknown',
    pairingState: 'unknown',
    developerMode: 'unknown',
    model: 'iPad8,5',
  },
]

check(
  'text: Xcode 26.6 header without Reality column parses exactly as pre-fix',
  parseDevicesText(textXcode26),
  textXcode26Expected,
)

// Synthetic newer-format table with the Reality column BETWEEN State and
// Model — the boundary list must stop State's slice at Reality and Model's
// slice at its own column, with no value bleeding across columns.
const widths = [21, 36, 38, 12, 11, 25]
const headerCells = ['Name', 'Hostname', 'Identifier', 'State', 'Reality', 'Model']
const table = rows => [
  headerCells.map((cell, i) => cell.padEnd(widths[i])).join(''),
  widths.map(width => '-'.repeat(width)).join(''),
  ...rows.map(row => row.map((cell, i) => cell.padEnd(widths[i])).join('')),
].join('\n')

const realityRows = [
  ['iPhone Sim', 'iPhone-Sim.coredevice.local', '11111111-2222-3333-4444-555555555555', 'connected', 'simulated', 'iPhone 17 Pro (iPhone18,1)'],
  ['My iPhone', 'My-iPhone.coredevice.local', 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', 'connected', 'physical', 'iPhone 17 Pro (iPhone18,1)'],
  ['iPad Sim', 'iPad-Sim.coredevice.local', 'BBBBBBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF', 'shutdown', '', 'iPad8,5'],
]
// Hostname bounds the Name slice without being emitted, so the name is just
// the Name cell — the same rule that keeps Reality out of State and Model.
const nameOf = (name) => name

const parsedReality = parseDevicesText(table(realityRows))
step('text: Reality column drops the "simulated" row', parsedReality.length === 2, JSON.stringify(parsedReality.map(device => device.udid)))
step(
  'text: simulator udid absent from the result',
  parsedReality.every(device => device.udid !== '11111111-2222-3333-4444-555555555555'),
  '',
)
check(
  'text: Reality "physical" row kept with clean column slices',
  parsedReality[0],
  {
    udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    name: nameOf('My iPhone'),
    state: 'connected',
    connection: 'unknown',
    pairingState: 'unknown',
    developerMode: 'unknown',
    model: 'iPhone 17 Pro (iPhone18,1)',
  },
)
check(
  'text: empty Reality value keeps the row (only explicit "simulated" drops)',
  parsedReality[1],
  {
    udid: 'BBBBBBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF',
    name: nameOf('iPad Sim'),
    state: 'shutdown',
    connection: 'unknown',
    pairingState: 'unknown',
    developerMode: 'unknown',
    model: 'iPad8,5',
  },
)
step(
  'text: no Reality text bleeds into State/Model of kept rows',
  parsedReality.every(device =>
    !device.state.includes('simulated') && !device.state.includes('physical')
    && !(device.model ?? '').includes('simulated') && !(device.model ?? '').includes('physical')),
  JSON.stringify(parsedReality),
)

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
