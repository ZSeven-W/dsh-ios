/**
 * Model-facing UI-tree semantic interaction tools: `ios_sim_ui_tree` dumps
 * the frontmost app's accessibility element tree (labels, identifiers,
 * values, point-space frames) and `ios_sim_tap_element` taps an element by
 * identity — the agent reasons over real UI semantics instead of guessing
 * normalized coordinates.
 *
 * Both tools run through the AXe accessibility CLI resolved by
 * uitree-backend.ts (same toolchain XcodeBuildMCP's ui-automation tools
 * build on). They require only a booted simulator — no serve-sim stream —
 * and degrade with a clear install hint when the helper is unavailable.
 * The tap lands through AXe's HID tap at the element's center, then a
 * ~300 ms settle screenshot is captured with exactly the same summary and
 * presentationMeta shape as `ios_sim_interact`.
 * @module @zseven-w/dsh-ios/tool-uitree
 */

import {
  defineTool,
  type JsonValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { closeSync, mkdirSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SimHostController } from './sim-host.js'
import {
  bootedDevices,
  compareRuntimesDesc,
  getDevice,
  takeScreenshot,
  type SimulatorDevice,
} from './simctl.js'
import {
  AXE_INSTALL_HINT,
  describeUi,
  ensureAxeBinary,
  execAxe,
  type AxeElement,
  type AxeBinary,
} from './uitree-backend.js'
import type { SimDeviceInfo } from './tools.js'

/** Registered UI tool names, in registration order. */
export const IOS_UI_TOOL_NAMES = ['ios_sim_ui_tree', 'ios_sim_tap_element'] as const

/** Compact accessibility element as returned by the UI tools. */
export interface UiTreeNode {
  type: string
  label?: string
  identifier?: string
  value?: string
  /** Frame in device points: origin + size. */
  frame: { x: number; y: number; w: number; h: number }
  children: UiTreeNode[]
}

export interface SimUiTreeResult {
  /** Device screen dimensions in points (for normalized-coordinate math). */
  size: { width: number; height: number }
  device: SimDeviceInfo
  /** Number of elements in the returned (possibly pruned) tree. */
  nodeCount: number
  /** True when the tree was pruned to fit the output cap. */
  truncated?: boolean
  /** Guidance shown when truncated (use max_depth / filter). */
  hint?: string
  /** Compact element tree (recursive; JSON-object typed for the canonical value). */
  tree: Array<Record<string, JsonValue>>
}

export interface SimTapElementResult {
  action: 'tap-element'
  /** The tapped element (label/identifier/value/frame). */
  element: {
    type: string
    label?: string
    identifier?: string
    value?: string
    frame: { x: number; y: number; w: number; h: number }
    children: Array<Record<string, JsonValue>>
  }
  /** Tapped screen point in device points. */
  center: { x: number; y: number }
  path: string
  bytes: number
  width?: number
  height?: number
  device: SimDeviceInfo
}

export interface SimUiToolsOptions {
  /** Plugin-owned cache root for screenshots (default `<tmp>/dsh-ios`). */
  cacheDir?: string
}

/** The two ui-* tool definitions bound to one sim host controller. */
export interface SimUiTools {
  iosSimUiTree: ToolDefinition
  iosSimTapElement: ToolDefinition
}

/** Compact tree output cap: past this the deepest levels are pruned. */
const UI_TREE_CAP_BYTES = 40 * 1024

/** Settle delay after the tap, before the effect screenshot. */
const TAP_SETTLE_MS = 300

/** Error prefix required on non-macOS hosts. */
const SIMULATOR_UNAVAILABLE = 'iOS Simulator requires macOS with Xcode'

/** Element types treated as the interactive container of a match chain. */
const TAPPABLE_TYPES = new Set([
  'Button', 'Cell', 'Link', 'Switch', 'TextField', 'SearchField', 'TextArea',
  'Tab', 'TabButton', 'Menu', 'MenuItem', 'MenuBarItem', 'Slider', 'Stepper',
  'Incrementor', 'PickerWheel', 'Handle', 'RadioButton', 'CheckBox',
  'DisclosureTriangle', 'PopUpButton', 'ComboBox', 'ScrollBar', 'Window',
])

/** Tolerance (points) for frame containment checks. */
const FRAME_EPSILON = 1

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function renderJson(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Shared device object schema (mirrors tools.ts for a stable shape). */
const deviceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    udid: { type: 'string', required: true },
    name: { type: 'string', required: true },
    runtime: { type: 'string', required: true },
    state: { type: 'string', required: true },
  },
} as const

/** Guard: UI tools need macOS (the AXe helper also enforces this). */
function assertMacHost(): void {
  if (process.platform !== 'darwin') {
    throw new Error(`${SIMULATOR_UNAVAILABLE} — this host runs ${process.platform}, so no simulator tools can run here`)
  }
}

/**
 * Resolve the device the UI tools should operate on: an explicit
 * udid/name wins, then the currently streamed device, then a booted
 * simulator. These tools never boot a device themselves (mirrors
 * ios_sim_screenshot): a clear boot hint is raised instead.
 */
async function resolveTargetDevice(host: SimHostController, reference?: string): Promise<SimulatorDevice> {
  if (reference !== undefined && reference.trim() !== '') return getDevice(reference)
  const status = host.status()
  if (status.running && status.device !== undefined) {
    try {
      return await getDevice(status.device)
    } catch {
      // Stream device vanished from simctl; fall through to booted devices.
    }
  }
  const booted = await bootedDevices()
  if (booted.length === 1) return booted[0]
  if (booted.length > 1) {
    const iphones = booted.filter(device => device.name.toLowerCase().startsWith('iphone'))
    const pool = iphones.length > 0 ? iphones : booted
    return pool.sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))[0]
  }
  throw new Error('No booted simulator and no live stream — call ios_sim_boot first (or `xcrun simctl boot <udid>`), then retry')
}

/** Resolve the AXe helper or throw the explanatory degradation error. */
async function requireAxeBinary(toolName: string): Promise<AxeBinary> {
  const binary = await ensureAxeBinary()
  if (!binary.available) {
    throw new Error(
      `${toolName}: the AXe accessibility helper is unavailable`
      + `${binary.reason === undefined ? '' : ` (${binary.reason})`}; ${binary.installHint}`,
    )
  }
  return binary
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Compact, rounded copy of one element for model output. */
function toUiTreeNode(element: AxeElement): UiTreeNode {
  const node: UiTreeNode = {
    type: element.type,
    frame: {
      x: round2(element.frame.x),
      y: round2(element.frame.y),
      w: round2(element.frame.w),
      h: round2(element.frame.h),
    },
    children: [],
  }
  if (element.label !== undefined) node.label = element.label
  if (element.identifier !== undefined) node.identifier = element.identifier
  if (element.value !== undefined) node.value = element.value
  return node
}

/** Case-insensitive substring match over label/identifier/type. */
function matchesFilter(element: AxeElement, filter: string): boolean {
  const needle = filter.toLowerCase()
  const haystacks = [element.type, element.label, element.identifier]
  return haystacks.some(value => value !== undefined && value.toLowerCase().includes(needle))
}

/**
 * Build the compact tree: optional case-insensitive substring filter (a
 * node survives when it or any descendant matches — ancestors of matches
 * are kept so the tree stays connected) and an optional nesting depth cap.
 */
function buildCompactTree(
  roots: AxeElement[],
  maxDepth?: number,
  filter?: string,
): { tree: UiTreeNode[]; count: number } {
  const needle = filter !== undefined && filter.trim() !== '' ? filter.trim().toLowerCase() : undefined
  let count = 0
  const walk = (element: AxeElement, depth: number): UiTreeNode | undefined => {
    const selfMatches = needle === undefined || matchesFilter(element, needle)
    const children: UiTreeNode[] = []
    if (maxDepth === undefined || depth < maxDepth) {
      for (const child of element.children) {
        const compact = walk(child, depth + 1)
        if (compact !== undefined) children.push(compact)
      }
    }
    if (!selfMatches && children.length === 0) return undefined
    const node = toUiTreeNode(element)
    node.children = children
    count += 1
    return node
  }
  const tree: UiTreeNode[] = []
  for (const root of roots) {
    const compact = walk(root, 0)
    if (compact !== undefined) tree.push(compact)
  }
  return { tree, count }
}

function treeDepth(nodes: readonly UiTreeNode[]): number {
  let depth = 0
  for (const node of nodes) {
    if (node.children.length > 0) depth = Math.max(depth, 1 + treeDepth(node.children))
  }
  return depth
}

function pruneDeepestLevel(nodes: UiTreeNode[]): void {
  const depth = treeDepth(nodes)
  if (depth === 0) return
  const pruneAt = (list: UiTreeNode[], level: number): void => {
    for (const node of list) {
      if (level === depth - 1) node.children = []
      else pruneAt(node.children, level + 1)
    }
  }
  pruneAt(nodes, 0)
}

function treeBytes(nodes: readonly UiTreeNode[]): number {
  return Buffer.byteLength(JSON.stringify(nodes), 'utf8')
}

/**
 * Fit a compact tree under `capBytes` by pruning the deepest levels first
 * (the same strategy hint `max_depth` offers interactively).
 */
export function capTreeToBytes(tree: UiTreeNode[], capBytes: number = UI_TREE_CAP_BYTES): { tree: UiTreeNode[]; truncated: boolean } {
  let truncated = treeBytes(tree) > capBytes
  while (treeBytes(tree) > capBytes && treeDepth(tree) > 0) {
    pruneDeepestLevel(tree)
  }
  if (!truncated) truncated = treeBytes(tree) > capBytes
  return { tree, truncated }
}

/** Screen bounds in points across every on-screen app root. */
function screenSize(roots: AxeElement[]): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const root of roots) {
    width = Math.max(width, root.frame.x + root.frame.w)
    height = Math.max(height, root.frame.y + root.frame.h)
  }
  if (width <= 0 || height <= 0) {
    const fallback = roots.length > 0 ? roots[0].frame : { w: 0, h: 0 }
    width = fallback.w
    height = fallback.h
  }
  return { width: round2(width), height: round2(height) }
}

/** Flattened element used for selector resolution (full-precision frames). */
interface FlatElement {
  type: string
  label?: string
  identifier?: string
  value?: string
  frame: { x: number; y: number; w: number; h: number }
  depth: number
}

function flattenElements(roots: AxeElement[]): FlatElement[] {
  const flat: FlatElement[] = []
  const walk = (element: AxeElement, depth: number): void => {
    const entry: FlatElement = { type: element.type, frame: element.frame, depth }
    if (element.label !== undefined) entry.label = element.label
    if (element.identifier !== undefined) entry.identifier = element.identifier
    if (element.value !== undefined) entry.value = element.value
    flat.push(entry)
    for (const child of element.children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return flat
}

/** True when `outer` (approximately) contains `inner`, points space. */
function containsFrame(outer: { x: number; y: number; w: number; h: number }, inner: { x: number; y: number; w: number; h: number }): boolean {
  return outer.x <= inner.x + FRAME_EPSILON
    && outer.y <= inner.y + FRAME_EPSILON
    && outer.x + outer.w >= inner.x + inner.w - FRAME_EPSILON
    && outer.y + outer.h >= inner.y + inner.h - FRAME_EPSILON
}

function sameFrame(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return containsFrame(a, b) && containsFrame(b, a)
}

interface ResolvedTarget {
  element: FlatElement
  /** Which selector field(s) resolved the element. */
  matchedBy: 'exact' | 'contains'
}

function describeCandidate(element: FlatElement, index: number): string {
  const label = element.label === undefined ? '' : ` label=${JSON.stringify(element.label)}`
  const identifier = element.identifier === undefined ? '' : ` identifier=${JSON.stringify(element.identifier)}`
  const frame = `frame={x:${round2(element.frame.x)},y:${round2(element.frame.y)},w:${round2(element.frame.w)},h:${round2(element.frame.h)}}`
  return `${index}) type=${element.type}${label}${identifier} ${frame}`
}

/**
 * Resolve one accessibility element from a selector. Exact (case-sensitive)
 * equality wins; otherwise case-insensitive substring. Nested duplicates
 * (a UIKit row mirrors its label onto child text) collapse to one chain —
 * the chain's outermost tappable container (or its deepest element when
 * nothing is tappable) is the tap target. Distinct elements that all match
 * raise an ambiguity error listing every candidate with label + frame.
 */
export function resolveTapTarget(
  roots: AxeElement[],
  selector: { identifier?: string; label?: string },
): ResolvedTarget {
  const identifier = selector.identifier !== undefined && selector.identifier.trim() !== '' ? selector.identifier.trim() : undefined
  const label = selector.label !== undefined && selector.label.trim() !== '' ? selector.label.trim() : undefined
  if (identifier === undefined && label === undefined) {
    throw new Error('ios_sim_tap_element requires an element selector: identifier and/or label')
  }
  const fields: Array<'identifier' | 'label'> = []
  if (identifier !== undefined) fields.push('identifier')
  if (label !== undefined) fields.push('label')
  const flat = flattenElements(roots)
  const matchesField = (element: FlatElement, field: 'identifier' | 'label', value: string, mode: 'exact' | 'contains'): boolean => {
    const actual = field === 'identifier' ? element.identifier : element.label
    if (actual === undefined) return false
    return mode === 'exact' ? actual === value : actual.toLowerCase().includes(value.toLowerCase())
  }
  const matches = (mode: 'exact' | 'contains'): FlatElement[] => flat.filter(element =>
    fields.every(field => matchesField(element, field, field === 'identifier' ? identifier! : label!, mode)),
  )
  let candidates = matches('exact')
  let matchedBy: 'exact' | 'contains' = 'exact'
  if (candidates.length === 0) {
    candidates = matches('contains')
    matchedBy = 'contains'
  }
  if (candidates.length === 0) {
    const wanted = fields.map(field => `${field}=${field === 'identifier' ? identifier : label}`).join(' and ')
    throw new Error(
      `ios_sim_tap_element: no accessibility element matches ${wanted} on the current screen — run ios_sim_ui_tree to inspect the visible elements`,
    )
  }
  // Drop exact frame duplicates (accessibility sometimes lists one element
  // twice with identical frames).
  const unique = candidates.filter((element, index) => !candidates.slice(0, index).some(other => sameFrame(element.frame, other.frame) && element.type === other.type))
  // Group containment chains: an ancestor that mirrors the label of its
  // descendant is the same row, not an ambiguity.
  const chains: FlatElement[][] = []
  for (const element of unique) {
    const chain = chains.find(group => group.some(other =>
      !sameFrame(element.frame, other.frame) && (containsFrame(element.frame, other.frame) || containsFrame(other.frame, element.frame)),
    ))
    if (chain === undefined) chains.push([element])
    else chain.push(element)
  }
  const representatives = chains.map(chain => {
    const tappable = chain.filter(element => TAPPABLE_TYPES.has(element.type))
    if (tappable.length > 0) {
      // Outermost tappable of the chain: not contained in another tappable.
      const outer = tappable.find(element => !tappable.some(other =>
        other !== element && containsFrame(other.frame, element.frame) && !sameFrame(other.frame, element.frame),
      ))
      return outer ?? tappable[0]
    }
    // No tappable container: use the deepest (most specific) element.
    return chain.reduce((deepest, element) => (element.depth > deepest.depth ? element : deepest), chain[0])
  })
  if (representatives.length > 1) {
    const wanted = fields.map(field => `${field} ${JSON.stringify(field === 'identifier' ? identifier : label)}`).join(' and ')
    const shown = representatives.slice(0, 8)
    const more = representatives.length - shown.length
    throw new Error(
      `ios_sim_tap_element: ${representatives.length} elements match ${wanted} — use a more specific selector `
      + `(exact label, identifier, or ios_sim_ui_tree to disambiguate). Candidates:\n`
      + shown.map((element, index) => `  ${describeCandidate(element, index + 1)}`).join('\n')
      + (more > 0 ? `\n  …and ${more} more` : ''),
    )
  }
  return { element: representatives[0], matchedBy }
}

/** Center of an element frame in points, rounded to one decimal. */
function frameCenter(frame: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return {
    x: Math.round((frame.x + frame.w / 2) * 10) / 10,
    y: Math.round((frame.y + frame.h / 2) * 10) / 10,
  }
}

/**
 * Stable per-device screenshot paths (same layout as the core tools):
 * `<cacheDir>/screenshots/screenshot-<udid>-<n>.png`.
 */
class ScreenshotStore {
  readonly #root: string
  #next = new Map<string, number>()

  constructor(cacheDir: string) {
    this.#root = join(cacheDir, 'screenshots')
  }

  nextPath(udid: string): string {
    mkdirSync(this.#root, { recursive: true })
    const safe = udid.replace(/[^A-Za-z0-9_-]/g, '_')
    let next = this.#next.get(safe)
    if (next === undefined) {
      next = 0
      const prefix = `screenshot-${safe}-`
      for (const entry of readdirSync(this.#root)) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.png')) continue
        const index = Number(entry.slice(prefix.length, -4))
        if (Number.isInteger(index) && index >= next) next = index + 1
      }
    }
    const path = join(this.#root, `screenshot-${safe}-${next}.png`)
    this.#next.set(safe, next + 1)
    return path
  }
}

/** Read PNG dimensions from the IHDR chunk (best effort, 24-byte header). */
function readPngSize(path: string): { width: number; height: number } | undefined {
  try {
    const fd = openSync(path, 'r')
    try {
      const header = Buffer.alloc(24)
      if (readSync(fd, header, 0, 24, 0) !== 24) return undefined
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const isPng = header.subarray(0, 8).equals(pngSignature)
      const isIhdr = header.subarray(12, 16).toString('ascii') === 'IHDR'
      if (!isPng || !isIhdr) return undefined
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

interface ScreenshotCapture {
  path: string
  bytes: number
  width?: number
  height?: number
  device: SimDeviceInfo
}

/** Screenshot summary, same shape as ios_sim_screenshot / ios_sim_interact. */
async function captureScreenshot(
  store: ScreenshotStore,
  udid: string,
  signal?: AbortSignal,
): Promise<ScreenshotCapture> {
  const device = await getDevice(udid)
  const path = store.nextPath(device.udid)
  await takeScreenshot(device.udid, path, signal)
  const bytes = statSync(path).size
  const size = readPngSize(path)
  return {
    path,
    bytes,
    ...(size === undefined ? {} : { width: size.width, height: size.height }),
    device: { udid: device.udid, name: device.name, runtime: device.runtime, state: device.state },
  }
}

/** Screenshot presentation envelope — identical to the interact tools'. */
function screenshotMeta(value: unknown): JsonValue {
  const result = value as unknown as SimTapElementResult
  return {
    kind: 'sim-screenshot',
    screenshotPath: result.path,
    path: result.path,
    device: { ...result.device },
  }
}

/** Create the two `ios_sim_ui_*` tool definitions bound to one controller. */
export function createSimUiTools(host: SimHostController, options: SimUiToolsOptions = {}): SimUiTools {
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'dsh-ios')
  const screenshots = new ScreenshotStore(cacheDir)

  const iosSimUiTree = defineTool({
    name: 'ios_sim_ui_tree',
    description: 'Dump the accessibility element tree of the frontmost app on a booted iOS Simulator '
      + '(labels, identifiers, values, and frames in device points). Use this to find elements by '
      + 'identity and then tap them with ios_sim_tap_element instead of guessing normalized coordinates. '
      + 'The result includes the device screen size in points so positions can be reasoned about. '
      + 'Output is capped at ~40 KB: when exceeded, the deepest levels are pruned and truncated=true is '
      + 'set — narrow with max_depth or filter in that case.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name. Defaults to the currently streamed '
          + 'device, else the first booted simulator.',
      },
      max_depth: {
        type: 'integer',
        description: 'Maximum tree nesting depth to include (0 = root only). Useful to shrink large trees.',
      },
      filter: {
        type: 'string',
        description: 'Case-insensitive substring matched against element label, identifier, or type. '
          + 'Matching elements and their ancestors are kept, everything else is pruned.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          size: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
            },
          },
          device: { ...deviceSchema, required: true },
          nodeCount: { type: 'integer', required: true },
          truncated: { type: 'boolean' },
          hint: { type: 'string' },
          tree: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: renderJson,
    },
    timeoutMs: 240_000,
    isConcurrencySafe: () => true,
    async execute(args: { udid?: string; max_depth?: number; filter?: string }, exec) {
      assertMacHost()
      const device = await resolveTargetDevice(host, args.udid)
      const binary = await requireAxeBinary('ios_sim_ui_tree')
      let roots: AxeElement[]
      try {
        roots = await describeUi(binary, device.udid, exec.signal)
      } catch (error) {
        throw new Error(`ios_sim_ui_tree: could not read the accessibility tree of ${device.name} (${device.udid}): ${errorMessage(error)}`)
      }
      const built = buildCompactTree(roots, args.max_depth, args.filter)
      const capped = capTreeToBytes(built.tree)
      const result: SimUiTreeResult = {
        size: screenSize(roots),
        device: { udid: device.udid, name: device.name, runtime: device.runtime, state: device.state },
        nodeCount: capped.tree.reduce((count, node) => count + countNodes(node), 0),
        ...(capped.truncated
          ? {
            truncated: true,
            hint: 'The tree exceeded the 40 KB output cap and its deepest levels were pruned. '
              + 'Re-run with max_depth or filter to narrow the subtree.',
          }
          : {}),
        tree: capped.tree as unknown as Array<Record<string, JsonValue>>,
      }
      return result
    },
    presentCall: (args: { udid?: string }) => ({
      card: 'generic',
      title: args.udid === undefined ? 'Inspect simulator UI tree' : `Inspect UI tree of ${args.udid}`,
      kind: 'execute',
    }),
  })

  const iosSimTapElement = defineTool({
    name: 'ios_sim_tap_element',
    description: 'Tap an accessibility element on a booted iOS Simulator by identity (identifier and/or '
      + 'label) instead of raw coordinates. The selector matches exactly first, then case-insensitively '
      + 'as a substring. Nested duplicates (a row mirroring its label onto child text) collapse to one '
      + 'target; if several distinct elements still match, the error lists every candidate with its '
      + 'label and frame. The tap lands on the element center through the AXe HID helper, then after '
      + '~300 ms a fresh screenshot is captured with the same summary shape as ios_sim_interact, so the '
      + 'effect is visible. Requires the AXe helper (auto-downloaded on first use; '
      + `manual alternative: ${AXE_INSTALL_HINT.split(';')[0]}).`,
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name. Defaults to the currently streamed '
          + 'device, else the first booted simulator.',
      },
      identifier: {
        type: 'string',
        description: 'Accessibility identifier (AXUniqueId) to match, e.g. "com.apple.settings.general". '
          + 'Exact match first, then case-insensitive substring.',
      },
      label: {
        type: 'string',
        description: 'Accessibility label (AXLabel) to match, e.g. "General". '
          + 'Exact match first, then case-insensitive substring.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, const: 'tap-element' },
          element: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              type: { type: 'string', required: true },
              label: { type: 'string' },
              identifier: { type: 'string' },
              value: { type: 'string' },
              frame: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  x: { type: 'number', required: true },
                  y: { type: 'number', required: true },
                  w: { type: 'number', required: true },
                  h: { type: 'number', required: true },
                },
              },
              children: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            },
          },
          center: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
            },
          },
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer' },
          height: { type: 'integer' },
          device: { ...deviceSchema, required: true },
        },
      },
      render: renderJson,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => screenshotMeta(value),
    },
    timeoutMs: 240_000,
    async execute(args: { udid?: string; identifier?: string; label?: string }, exec) {
      assertMacHost()
      const device = await resolveTargetDevice(host, args.udid)
      const binary = await requireAxeBinary('ios_sim_tap_element')
      let roots: AxeElement[]
      try {
        roots = await describeUi(binary, device.udid, exec.signal)
      } catch (error) {
        throw new Error(`ios_sim_tap_element: could not read the accessibility tree of ${device.name} (${device.udid}): ${errorMessage(error)}`)
      }
      const { element } = resolveTapTarget(roots, { identifier: args.identifier, label: args.label })
      const center = frameCenter(element.frame)
      try {
        await execAxe(binary, ['tap', '-x', String(center.x), '-y', String(center.y), '--udid', device.udid], 60_000, exec.signal)
      } catch (error) {
        throw new Error(`ios_sim_tap_element: AXe tap at (${center.x}, ${center.y}) failed: ${errorMessage(error)}`)
      }
      await sleep(TAP_SETTLE_MS)
      const screenshot = await captureScreenshot(screenshots, device.udid, exec.signal)
      const tapped: SimTapElementResult['element'] = {
        type: element.type,
        ...(element.label === undefined ? {} : { label: element.label }),
        ...(element.identifier === undefined ? {} : { identifier: element.identifier }),
        ...(element.value === undefined ? {} : { value: element.value }),
        frame: {
          x: round2(element.frame.x),
          y: round2(element.frame.y),
          w: round2(element.frame.w),
          h: round2(element.frame.h),
        },
        children: [],
      }
      return {
        action: 'tap-element',
        element: tapped,
        center,
        ...screenshot,
      } satisfies SimTapElementResult
    },
    presentCall: (args: { identifier?: string; label?: string }) => ({
      card: 'generic',
      title: `Tap element ${args.label ?? args.identifier ?? ''}`,
      kind: 'execute',
      rawInput: {
        ...(args.identifier === undefined ? {} : { identifier: args.identifier }),
        ...(args.label === undefined ? {} : { label: args.label }),
      },
    }),
  })

  return {
    iosSimUiTree,
    iosSimTapElement,
  }
}

/** Count nodes of an already-built compact tree. */
function countNodes(node: UiTreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0)
}
