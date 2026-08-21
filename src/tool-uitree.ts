/**
 * Model-facing UI-tree semantic interaction tools: `ios_sim_ui_tree` dumps
 * the frontmost app's accessibility element tree (labels, identifiers,
 * values, enabled/visible flags, point-space frames) and
 * `ios_sim_tap_element` taps an element by identity — the agent reasons
 * over real UI semantics instead of guessing normalized coordinates.
 *
 * One tool, two backends:
 * - simulator: the AXe accessibility CLI resolved by uitree-backend.ts
 *   (same toolchain XcodeBuildMCP's ui-automation tools build on); requires
 *   only a booted simulator — no serve-sim stream — and degrades with a
 *   clear install hint when the helper is unavailable;
 * - physical device (WebDriverAgent): the WDA `source()` accessibility tree
 *   is normalized by wda-uitree.ts into the SAME compact element shape, so
 *   filter/max_depth/cap semantics and the selector-matching rules (exact
 *   identifier/label first, case-insensitive contains, nested-duplicate
 *   collapse, ambiguity → candidate list) are identical on both backends.
 *
 * Visibility/enabled safety (both backends):
 * - WDA marks scrolled-out / hidden elements `visible="false"` and greyed
 *   controls `enabled="false"`; AXe emits `enabled` and keeps off-screen
 *   elements in its dump (they are detected geometrically against the
 *   screen bounds). `ios_sim_tap_element` refuses to tap an element that is
 *   off-screen or disabled unless the caller explicitly opts into
 *   `allow_offscreen` (disabled stays refused), and `ios_sim_ui_tree`
 *   excludes off-screen elements by default, reporting how many were
 *   omitted.
 *
 * The tap lands at the element's center (AXe HID tap on simulators, WDA
 * `/wda/tap` on devices), then a ~300 ms settle screenshot is captured with
 * exactly the same summary and presentationMeta shape as `ios_sim_interact`.
 *
 * Vision OCR tools (`ios_sim_find_text` / `ios_sim_tap_text`) live in the
 * same factory: the plugin-compiled Vision helper (ocr-backend.ts) reads
 * text the accessibility tree cannot see (no-a11y apps, text baked into
 * images, badge counts) and returns pixel boxes that are converted to
 * device points (WDA taps) or normalized 0..1 (simulator serve-sim
 * control) through the screenshot's own pixel size — never a fixed scale.
 * @module @zseven-w/dsh-ios/tool-uitree
 */

import {
  defineTool,
  type JsonValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SimHostController } from './sim-host.js'
import {
  getDevice,
  takeScreenshot,
} from './simctl.js'
import {
  AXE_INSTALL_HINT,
  describeUi,
  ensureAxeBinary,
  execAxe,
  resolveAxeBinary,
  type AxeElement,
  type AxeBinary,
} from './uitree-backend.js'
import {
  ensureWdaRunning,
  realDeviceSummary,
  resolveToolTarget,
  type RealDeviceResolution,
  type SimDeviceInfo,
  type ToolTarget,
  type WdaToolBackend,
} from './tools.js'
import { wdaSourceToElements } from './wda-uitree.js'
import { WDA_DEFAULT_SNAPSHOT_DEPTH } from './wda-host.js'
import {
  ensureOcrBinary,
  execOcr,
  filterOcrItems,
  parseOcrOutput,
  pixelCenterToPoints,
  pixelRectToNormalizedCenter,
  pixelRectToPoints,
  rectCenter,
  type OcrItem,
  type OcrRect,
  type PixelSize,
} from './ocr-backend.js'
import type { StreamScreenshot } from './stream-source.js'
import { detectListRows } from './list-rows.js'
import {
  getRealDevice,
  matchesRealDevice,
  requireAvailable,
  type RealDevice,
} from './devicectl.js'

/** Registered UI tool names, in registration order. */
export const IOS_UI_TOOL_NAMES = ['ios_sim_ui_tree', 'ios_sim_tap_element'] as const

/** Registered Vision-OCR tool names, in registration order. */
export const IOS_OCR_TOOL_NAMES = ['ios_sim_find_text', 'ios_sim_tap_text', 'ios_sim_wait_for'] as const

/** Compact accessibility element as returned by the UI tools. */
export interface UiTreeNode {
  type: string
  label?: string
  identifier?: string
  value?: string
  /**
   * Interactivity flags when the backend reports them (WDA: both per
   * element; AXe: `enabled` only). Absent stays undefined.
   */
  visible?: boolean
  enabled?: boolean
  /**
   * Selection state when the backend reports it (WDA's `selected`, AXe's
   * equivalent trait) — which option in a list is chosen. Absent stays
   * undefined, never invented false (WP60).
   */
  selected?: boolean
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
  /**
   * Number of off-screen elements (visible=false or entirely outside the
   * screen bounds) excluded from the default output. Re-run with
   * include_offscreen=true to enumerate them.
   */
  omittedOffscreen: number
  /**
   * Depth the backend actually sampled. On a physical device this is the
   * WebDriverAgent snapshotMaxDepth the snapshot was taken at (the caller's
   * max_depth, the default cap, or the one deeper auto-retry); absent on the
   * simulator path, whose AXe dump is the full tree.
   */
  sampledDepth?: number
  /** True when a second, deeper snapshot replaced the default (see auto-deepen). */
  deepened?: boolean
  /** Snapshot depths attempted, in order (real device only). */
  depthsTried?: number[]
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
  /** Outcome assertion (expect_text/expect_gone), when requested. */
  expected?: OcrExpectationResult
  path: string
  bytes: number
  width?: number
  height?: number
  device: SimDeviceInfo
}

export interface SimUiToolsOptions {
  /** Plugin-owned cache root for screenshots (default `<tmp>/dsh-ios`). */
  cacheDir?: string
  /**
   * WebDriverAgent backend for physical devices (one tool, two backends).
   * When absent, real-device references still resolve but fail with a clear
   * "backend not configured" error instead of the old phase refusal.
   */
  wda?: WdaToolBackend
  /** Physical-device resolution override (tests); defaults to devicectl. */
  realDevices?: RealDeviceResolution
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
  return losslessNumber(Math.round(value * 100) / 100)
}

/**
 * Flatten negative zero. `Math.round(-0.2)` is `-0`, and `-0` does NOT survive
 * a JSON round trip (`stringify` writes `0`), so DSH's lossless boundary
 * rejects the WHOLE tool result rather than the one coordinate — the failure
 * mode that killed 4 of 7 ios_sim_ui_tree calls in a real session. Every
 * rounded coordinate this module emits goes through here. `value === 0` is
 * true for -0, so it costs one comparison.
 */
function losslessNumber(value: number): number {
  return value === 0 ? 0 : value
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
  if (element.visible !== undefined) node.visible = element.visible
  if (element.enabled !== undefined) node.enabled = element.enabled
  if (element.selected !== undefined) node.selected = element.selected
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

/**
 * Drop off-screen subtrees from a compact tree (default ui_tree output):
 * a node with `visible=false` or whose frame lies entirely outside the
 * screen bounds is removed together with its subtree (off-screen children
 * live in off-screen containers). Every dropped node is counted so the
 * result can report how many were omitted. Roots are always kept so the
 * tree stays anchored.
 */
export function pruneOffscreenTree(
  tree: UiTreeNode[],
  bounds: { width: number; height: number },
): { tree: UiTreeNode[]; omitted: number } {
  let omitted = 0
  const walk = (node: UiTreeNode, isRoot: boolean): UiTreeNode | undefined => {
    const children: UiTreeNode[] = []
    for (const child of node.children) {
      const kept = walk(child, false)
      if (kept !== undefined) children.push(kept)
    }
    const offscreen = node.visible === false || isOffscreenFrame(node.frame, bounds)
    if (offscreen && !isRoot) {
      omitted += 1 + children.length
      return undefined
    }
    node.children = children
    return node
  }
  const kept: UiTreeNode[] = []
  for (const root of tree) {
    const node = walk(root, true)
    if (node !== undefined) kept.push(node)
  }
  return { tree: kept, omitted }
}

/** True when the tree carries at least one labeled element. */
export function hasLabeledNode(tree: readonly UiTreeNode[]): boolean {
  for (const node of tree) {
    if (node.label !== undefined && node.label !== '') return true
    if (hasLabeledNode(node.children)) return true
  }
  return false
}

/** Count nodes of an already-built compact tree. */
export function countNodes(node: UiTreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0)
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

/** Unrounded screen bounds (points) across every app root. */
export function rawScreenBounds(roots: AxeElement[]): { width: number; height: number } {
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
  return { width, height }
}

/** True when `frame` lies ENTIRELY outside the screen bounds (points). */
export function isOffscreenFrame(
  frame: { x: number; y: number; w: number; h: number },
  bounds: { width: number; height: number },
): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return false
  // A zero-size frame at the origin (a phantom element) can never be
  // tapped, so it counts as off-screen too.
  return frame.x + frame.w <= 0
    || frame.y + frame.h <= 0
    || frame.x >= bounds.width
    || frame.y >= bounds.height
}

/**
 * Off-screen predicate shared by the tap gate and the tree pruning:
 * `visible === false` (WDA's authoritative flag) or a frame entirely
 * outside the screen bounds (covers the AXe backend, whose describe-ui
 * exposes no visibility flag but does list off-screen elements).
 */
export function isOffscreenElement(
  element: { visible?: boolean; frame: { x: number; y: number; w: number; h: number } },
  bounds: { width: number; height: number },
): boolean {
  if (element.visible === false) return true
  return isOffscreenFrame(element.frame, bounds)
}

/** Flattened element used for selector resolution (full-precision frames). */
interface FlatElement {
  type: string
  label?: string
  identifier?: string
  value?: string
  visible?: boolean
  enabled?: boolean
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
    if (element.visible !== undefined) entry.visible = element.visible
    if (element.enabled !== undefined) entry.enabled = element.enabled
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
  // The false flags are the ones that matter (why a candidate was skipped
  // or why it cannot be tapped); true is the normal state and stays implicit.
  const flags = `${element.visible === false ? ' visible=false' : ''}${element.enabled === false ? ' enabled=false' : ''}`
  const frame = `frame={x:${round2(element.frame.x)},y:${round2(element.frame.y)},w:${round2(element.frame.w)},h:${round2(element.frame.h)}}`
  return `${index}) type=${element.type}${label}${identifier}${flags} ${frame}`
}

/** Actionable refusal when every selector match is off-screen/disabled. */
function tapGateFailure(
  representatives: FlatElement[],
  bounds: { width: number; height: number },
  wanted: string,
  allowOffscreen: boolean,
): never {
  const offscreen = representatives.filter(element => isOffscreenElement(element, bounds))
  const disabled = representatives.filter(element => element.enabled === false)
  const hint = allowOffscreen ? ' (allow_offscreen=true bypasses only the off-screen check — disabled stays refused)' : ''
  if (offscreen.length > 0 && disabled.length > 0) {
    throw new Error(
      `ios_sim_tap_element: ${wanted} matched ${representatives.length} element(s) that are off-screen or disabled`
      + ` — scroll the off-screen ones into view first and enable the disabled ones${hint}`,
    )
  }
  if (offscreen.length > 0) {
    const noun = representatives.length === 1
      ? 'matched an off-screen element'
      : `matched ${representatives.length} off-screen elements`
    throw new Error(
      `ios_sim_tap_element: ${wanted} ${noun} — scroll it into view first, then retry`
      + `; pass allow_offscreen=true to tap the recorded coordinates anyway${hint}`,
    )
  }
  const noun = representatives.length === 1 ? 'matched a disabled element' : `matched ${representatives.length} disabled elements`
  throw new Error(
    `ios_sim_tap_element: ${wanted} ${noun} — the control is disabled, so a tap would do nothing; enable it first${hint}`,
  )
}

/**
 * Resolve one accessibility element from a selector. Exact (case-sensitive)
 * equality wins; otherwise case-insensitive substring. Nested duplicates
 * (a UIKit row mirrors its label onto child text) collapse to one chain —
 * the chain's outermost tappable container (or its deepest element when
 * nothing is tappable) is the tap target.
 *
 * Safety gate: matches that are off-screen (visible=false, or entirely
 * outside the screen bounds — the AXe backend has no visibility flag) or
 * disabled (enabled=false) are NOT tappable by default. When every match
 * fails the gate the resolver throws an actionable error naming the fix;
 * `allow_offscreen` (default false) skips only the off-screen half —
 * disabled elements always refuse. Distinct elements that all match (after
 * the gate) raise an ambiguity error listing every candidate with label,
 * frame, and the false flags so the model sees why a candidate was skipped.
 */
export function resolveTapTarget(
  roots: AxeElement[],
  selector: { identifier?: string; label?: string },
  options: { allowOffscreen?: boolean; sampledDepth?: number } = {},
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
    const listRedirect = options.sampledDepth !== undefined
      && options.sampledDepth >= DEEPEN_SNAPSHOT_DEPTH
      && hasRepeatedAggregatedRows(roots, rawScreenBounds(roots))
    throw new Error(
      listRedirect
        ? `ios_sim_tap_element: no accessibility element matches ${wanted} on the current screen — ${LIST_ROW_REDIRECT_HINT}`
        : `ios_sim_tap_element: no accessibility element matches ${wanted} on the current screen — run ios_sim_ui_tree to inspect the visible elements`,
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
  const wanted = fields.map(field => `${field} ${JSON.stringify(field === 'identifier' ? identifier : label)}`).join(' and ')
  const bounds = rawScreenBounds(roots)
  const allowOffscreen = options.allowOffscreen === true
  const viable = representatives.filter(element =>
    element.enabled !== false && (allowOffscreen || !isOffscreenElement(element, bounds)),
  )
  if (viable.length === 0) {
    tapGateFailure(representatives, bounds, wanted, allowOffscreen)
  }
  if (viable.length > 1) {
    const skipped = representatives.filter(element => !viable.includes(element))
    const skippedSentence = skipped.length > 0
      ? ` (${skipped.length} skipped: off-screen or disabled)`
      : ''
    const shown = representatives.slice(0, 8)
    const more = representatives.length - shown.length
    throw new Error(
      `ios_sim_tap_element: ${representatives.length} elements match ${wanted}${skippedSentence} — use a more specific selector `
      + `(exact label, identifier, or ios_sim_ui_tree to disambiguate). Candidates:\n`
      + shown.map((element, index) => `  ${describeCandidate(element, index + 1)}`).join('\n')
      + (more > 0 ? `\n  …and ${more} more` : ''),
    )
  }
  return { element: viable[0], matchedBy }
}

/** Center of an element frame in points, rounded to one decimal. */
function frameCenter(frame: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return {
    x: losslessNumber(Math.round((frame.x + frame.w / 2) * 10) / 10),
    y: losslessNumber(Math.round((frame.y + frame.h / 2) * 10) / 10),
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
    // Three independent counters share this directory (tools.ts's twin store
    // and the panel capture route) — skip names that already exist on disk so
    // a later writer can never overwrite a capture whose signed URL is live.
    let path = join(this.#root, `screenshot-${safe}-${next}.png`)
    while (existsSync(path)) {
      next += 1
      path = join(this.#root, `screenshot-${safe}-${next}.png`)
    }
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

/**
 * WDA screenshot for a physical device, written into the SAME cache layout
 * (`<cacheDir>/screenshots/screenshot-<udid>-<n>.png`) so the signed
 * screenshot URL + presentationMeta flow works unchanged.
 */
async function captureWdaScreenshot(
  tool: string,
  store: ScreenshotStore,
  wda: WdaToolBackend,
  device: RealDevice,
): Promise<ScreenshotCapture> {
  let shot: StreamScreenshot
  try {
    shot = await wda.control.screenshot()
  } catch (error) {
    throw new Error(`${tool}: the WebDriverAgent screenshot failed: ${errorMessage(error)}`)
  }
  const path = store.nextPath(device.udid)
  try {
    writeFileSync(path, Buffer.from(shot.pngBase64, 'base64'))
  } catch (error) {
    throw new Error(`${tool}: could not write the screenshot to ${path}: ${errorMessage(error)}`)
  }
  const bytes = statSync(path).size
  const size = readPngSize(path)
    ?? (shot.width !== undefined && shot.height !== undefined ? { width: shot.width, height: shot.height } : undefined)
  return {
    path,
    bytes,
    ...(size === undefined ? {} : { width: size.width, height: size.height }),
    device: realDeviceSummary(device),
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

/**
 * Depth used for the ONE automatic deeper retry when the default cap yields
 * no labeled nodes. 40, not 50: the 50-depth snapshot measured 32.6 s /
 * 751 KB on a busy list app and blocks every other WDA call queued behind it (WDA
 * serves requests SERIALLY), while 40 reaches the labeled controls that the
 * 15-depth default cap hides. A second retry would double that serialized
 * cost, so it never runs.
 */
export const DEEPEN_SNAPSHOT_DEPTH = 40

/**
 * Last depth that returned labeled content for each physical device. This is
 * deliberately process-local and only a starting hint: explicit max_depth
 * always wins, and the existing one-step auto-deepen ladder still decides
 * whether a second snapshot is needed.
 */
const satisfactoryDepthByUdid = new Map<string, number>()

/** Forget a device's depth hint when a known app launch changes the foreground. */
export function invalidateWdaTreeDepthMemory(udid: string): void {
  satisfactoryDepthByUdid.delete(udid)
}

/** Test/diagnostic view of one remembered depth. */
export function rememberedWdaTreeDepth(udid: string): number | undefined {
  return satisfactoryDepthByUdid.get(udid)
}

/** Clear every hint (smoke isolation) or just one device. */
export function resetWdaTreeDepthMemory(udid?: string): void {
  if (udid === undefined) satisfactoryDepthByUdid.clear()
  else satisfactoryDepthByUdid.delete(udid)
}

/** One real-device snapshot: the normalized tree plus how it was taken. */
export interface WdaTreeSample extends TreeSample {
  roots: AxeElement[]
}

/** Dump the WDA accessibility tree of one physical device (normalized shape). */
export async function wdaTree(
  wda: WdaToolBackend,
  device: RealDevice,
  maxDepth?: number,
): Promise<WdaTreeSample> {
  // Push the depth cap into WDA's snapshot BEFORE WDA walks the tree: an
  // uncapped /source on a busy app costs 32.6 s / 751 KB (WDA default 50)
  // versus 1.9 s / 12 KB at 15. The caller's explicit max_depth wins; an
  // absent one gets the default cap. An older WDA may reject the setting —
  // swallow that and take the (uncapped) snapshot rather than failing the tool.
  const depthsTried: number[] = []
  const snapshotAt = async (depth: number): Promise<AxeElement[]> => {
    try {
      await wda.control.setSnapshotDepth(depth)
    } catch {
      // Older WDA without /appium/settings: the snapshot still works, just uncapped.
    }
    depthsTried.push(depth)
    let xml: string
    try {
      xml = await wda.control.source()
    } catch (error) {
      throw new Error(`the WebDriverAgent source() failed for ${device.name}: ${errorMessage(error)}`)
    }
    try {
      return wdaSourceToElements(xml)
    } catch (error) {
      throw new Error(`could not normalize the accessibility tree of ${device.name}: ${errorMessage(error)}`)
    }
  }

  const satisfactory = (roots: AxeElement[], depth: number): boolean => {
    const ok = hasLabeledNode(roots)
    // A deliberately tiny explicit read is not a useful future default. The
    // memory accelerates deep reads; it never lowers the established cap.
    if (ok && depth >= WDA_DEFAULT_SNAPSHOT_DEPTH) {
      satisfactoryDepthByUdid.set(device.udid, depth)
    }
    return ok
  }

  // An explicit max_depth is a deliberate budget the caller chose, so never
  // deepen past it — they asked for a shallow (cheap) snapshot. Only the
  // IMPLICIT starting hint gets one automatic deeper retry.
  if (maxDepth !== undefined) {
    const roots = await snapshotAt(maxDepth)
    satisfactory(roots, maxDepth)
    return { roots, sampledDepth: maxDepth, deepened: false, depthsTried }
  }
  const startingDepth = satisfactoryDepthByUdid.get(device.udid) ?? WDA_DEFAULT_SNAPSHOT_DEPTH
  const first = await snapshotAt(startingDepth)
  if (satisfactory(first, startingDepth) || startingDepth >= DEEPEN_SNAPSHOT_DEPTH) {
    return { roots: first, sampledDepth: startingDepth, deepened: false, depthsTried }
  }
  // WP62: the starting cap saw only container chrome, so a bare tree here
  // means "look deeper", not "the app has no accessibility info". Retry ONCE
  // and report both depths tried.
  const deeper = await snapshotAt(DEEPEN_SNAPSHOT_DEPTH)
  satisfactory(deeper, DEEPEN_SNAPSHOT_DEPTH)
  return { roots: deeper, sampledDepth: DEEPEN_SNAPSHOT_DEPTH, deepened: true, depthsTried }
}

/**
 * The case-(c) hint: appended ONLY when the tree was sampled DEEP enough,
 * unfiltered and uncapped, that an absence of labels really does mean the
 * app exposes little accessibility information (WP62/WP63). A shallow,
 * filtered, or output-capped read must never produce this: its missing
 * labels are a property of what was SAMPLED, not of the app.
 */
export const OCR_FALLBACK_HINT = 'The accessibility tree is empty or degenerate (no labeled elements), so the app '
  + 'exposes little or no accessibility information — run ios_sim_find_text to OCR the screen instead.'

/** A deep no-match on repeated rows is structural, not a reason to search labels again. */
export const LIST_ROW_REDIRECT_HINT = 'This looks like a list; the control you seek lives inside an aggregated row — '
  + 'run ios_sim_ui_rows to inspect the rows, then use ios_sim_tap_row to operate inside one.'

/** True when the unfiltered tree contains a repeated list/feed row pattern. */
export function hasRepeatedAggregatedRows(
  roots: AxeElement[],
  size: { width: number; height: number },
): boolean {
  const detected = detectListRows(roots, { bounds: size })
  if (detected.repeatedGroups === 0) return false
  const rawRows: AxeElement[] = []
  const collect = (element: AxeElement): void => {
    if (detected.rows.some(row => row.type === element.type && sameFrame(row.frame, element.frame))) {
      rawRows.push(element)
    }
    for (const child of element.children) collect(child)
  }
  for (const root of roots) collect(root)
  const hasControlDescendant = (element: AxeElement): boolean => element.children.some(child =>
    TAPPABLE_TYPES.has(child.type) || hasControlDescendant(child))
  const aggregatedByGroup = new Map<number, number>()
  for (const row of detected.rows) {
    if (row.group === undefined) continue
    const raw = rawRows.find(element => row.type === element.type && sameFrame(row.frame, element.frame))
    if (raw === undefined || hasControlDescendant(raw)) continue
    aggregatedByGroup.set(row.group, (aggregatedByGroup.get(row.group) ?? 0) + 1)
  }
  return [...aggregatedByGroup.values()].some(count => count >= 2)
}

/** Depth info a backend reports alongside the tree it dumped. */
export interface TreeSample {
  /** Depth actually sampled (real-device snapshotMaxDepth); absent = full tree. */
  sampledDepth?: number
  /** True when a deeper retry replaced the default-depth snapshot. */
  deepened?: boolean
  /** Depths attempted, in order. */
  depthsTried?: number[]
}

/** Case (a): a filter matched nothing — a property of the filter + depth, never of the app. */
function filterMissHint(filter: string, sampledDepth: number | undefined): string {
  const depthPart = sampledDepth === undefined
    ? 'the tree that was returned'
    : `the depth sampled (depth ${sampledDepth})`
  return `The filter ${JSON.stringify(filter)} matched nothing at ${depthPart}. `
    + 'A filter miss says nothing about the app — only that no matching element lies within what was '
    + 'sampled. Re-run WITHOUT a filter (or with a larger max_depth) to see what is actually there.'
}

/** Case (a): the shallow snapshot shows only container chrome, so look deeper first. */
function shallowUnlabeledHint(sampledDepth: number): string {
  return `The depth sampled (${sampledDepth}) shows only container chrome for this app — its labeled `
    + `controls live deeper. Re-run with a larger max_depth (e.g. ${DEEPEN_SNAPSHOT_DEPTH}) to see them.`
}

/** Case (b): the output cap pruned the deepest levels, so the missing labels
 * may be a pruning artifact — never an app property. */
function capPrunedUnlabeledHint(): string {
  return 'The tree was pruned to fit the output cap, so the surviving levels carry no labels — the labeled '
    + 'elements may sit in the levels that were dropped. Re-run with a smaller max_depth or a filter to '
    + 'narrow the subtree before concluding anything about the app.'
}

/** Case (b): every labeled element lay off-screen and was excluded, so the
 * visible tree carries none — a filtering artifact, never an app property. */
function offscreenOnlyUnlabeledHint(omitted: number): string {
  return `The visible tree carries no labels — every labeled element is among the ${omitted} off-screen `
    + 'element(s) excluded from the output. Scroll the screen or re-run with include_offscreen=true before '
    + 'concluding anything about the app.'
}

/**
 * Shared ui_tree result assembly: compact build (filter/max_depth) →
 * off-screen pruning (unless include_offscreen) → ~40 KB cap → count,
 * omitted-off-screen count, the sampled-depth report, and a hint computed from
 * what was actually SAMPLED (filter miss / shallow / deep) — never a blanket
 * "the app has no accessibility information" claim.
 */
export function buildTreeResult(
  roots: AxeElement[],
  size: { width: number; height: number },
  device: SimDeviceInfo,
  args: { max_depth?: number; filter?: string; include_offscreen?: boolean },
  sample: TreeSample = {},
): SimUiTreeResult {
  const built = buildCompactTree(roots, args.max_depth, args.filter)
  const pruned = args.include_offscreen === true
    ? { tree: built.tree, omitted: 0 }
    : pruneOffscreenTree(built.tree, size)
  const capped = capTreeToBytes(pruned.tree)
  const nodeCount = capped.tree.reduce((count, node) => count + countNodes(node), 0)
  const hints: string[] = []
  if (capped.truncated) {
    hints.push('The tree exceeded the 40 KB output cap and its deepest levels were pruned. '
      + 'Re-run with max_depth or filter to narrow the subtree.')
  }
  const filterText = args.filter !== undefined ? args.filter.trim() : ''
  const filterMiss = filterText !== '' && built.count === 0
  if (filterMiss) {
    // A filter miss is answered from what was SAMPLED, not with a claim that
    // the app has no accessibility information (WP62): the labels may simply
    // sit below the depth sampled, or behind the filter.
    const repeatedRows = sample.sampledDepth !== undefined
      && sample.sampledDepth >= DEEPEN_SNAPSHOT_DEPTH
      && hasRepeatedAggregatedRows(roots, size)
    hints.push(repeatedRows ? LIST_ROW_REDIRECT_HINT : filterMissHint(filterText, sample.sampledDepth))
  } else if (!hasLabeledNode(capped.tree)) {
    // WP63: an unlabeled read (empty, degenerate, or chrome-only) must be
    // attributed to ONE of three causes — and the "app exposes little or no
    // accessibility information" claim is allowed ONLY for case (c).
    //   (a) depth insufficient → deepen advice (a shallow read can never
    //       conclude anything about the app's accessibility support);
    //   (b) the OUTPUT was filtered — the 40 KB cap dropped levels, or every
    //       labeled element was off-screen and excluded;
    //   (c) a deep, unfiltered, uncapped read still has no labels.
    const sampledDepth = sample.sampledDepth
    const shallowSample = sampledDepth !== undefined && sampledDepth < DEEPEN_SNAPSHOT_DEPTH
    if (shallowSample) {
      // (a): the depth cap hides the labels, so the first move is to look
      // deeper — OCR is the LAST resort, not the first suggestion.
      hints.push(shallowUnlabeledHint(sampledDepth))
    } else if (capped.truncated) {
      // (b): pruning may have dropped the labeled levels.
      hints.push(capPrunedUnlabeledHint())
    } else if (pruned.omitted > 0) {
      // (b): the labels exist, but off-screen (and were excluded).
      hints.push(offscreenOnlyUnlabeledHint(pruned.omitted))
    } else {
      // (c): only now is "no accessibility info" a fair reading.
      hints.push(OCR_FALLBACK_HINT)
    }
  }
  return {
    size: { width: round2(size.width), height: round2(size.height) },
    device,
    nodeCount,
    omittedOffscreen: pruned.omitted,
    ...(sample.sampledDepth === undefined ? {} : { sampledDepth: sample.sampledDepth }),
    ...(sample.deepened === true ? { deepened: true } : {}),
    ...(sample.depthsTried === undefined ? {} : { depthsTried: sample.depthsTried }),
    ...(capped.truncated ? { truncated: true } : {}),
    ...(hints.length > 0 ? { hint: hints.join(' ') } : {}),
    tree: capped.tree as unknown as Array<Record<string, JsonValue>>,
  }
}

/** Create the two `ios_sim_ui_*` tool definitions bound to one controller. */
export function createSimUiTools(host: SimHostController, options: SimUiToolsOptions = {}): SimUiTools {
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'dsh-ios')
  const screenshots = new ScreenshotStore(cacheDir)
  const wda = options.wda
  const realDevices: RealDeviceResolution = options.realDevices ?? { matches: matchesRealDevice, resolve: getRealDevice }

  const iosSimUiTree = defineTool({
    name: 'ios_sim_ui_tree',
    description: 'Dump the accessibility element tree of the frontmost app on a booted iOS Simulator '
      + '(AXe helper) or of a USB-connected physical iOS device (WebDriverAgent; pass its udid from '
      + 'ios_sim_devices.realDevices) — labels, identifiers, values, enabled/visible flags, a selected '
      + 'flag, and frames in device points. Use this to find elements by identity and then tap them with '
      + 'ios_sim_tap_element instead of guessing normalized coordinates. A node carries selected=true '
      + '(and only when the backend reports it — never an invented false) on whichever option in a list '
      + 'or picker is currently chosen, which is how you confirm a choice without reading a screenshot. '
      + 'Off-screen elements '
      + '(visible=false, e.g. rows scrolled out of view) are EXCLUDED by default and reported as '
      + 'omittedOffscreen — pass include_offscreen=true to enumerate them. The result includes the '
      + 'device screen size in points so positions can be reasoned about. On a physical device the '
      + 'snapshot is depth-capped by default (an uncapped snapshot of a busy app costs ~30 s and '
      + 'blocks every other device call) — pass max_depth to raise or lower that cap. Output is '
      + 'capped at ~40 KB: when exceeded, the deepest levels are pruned and truncated=true is set — '
      + 'narrow with max_depth or filter in that case. On a physical device the result reports '
      + 'sampledDepth (the snapshot depth actually used). An unlabeled read is attributed to ONE of '
      + 'three causes, never blanket-blamed on the app: (a) depth too shallow — re-run deeper; (b) the '
      + 'output was filtered — a filter matched nothing, the 40 KB cap pruned levels, or every labeled '
      + 'element was off-screen and excluded; (c) a DEEP, unfiltered, uncapped read still has no labels — '
      + 'only this points at ios_sim_find_text with "little or no accessibility information". The tool '
      + 'auto-deepens ONCE (default cap → 40) when the first snapshot has no labels. List/feed rows are '
      + 'aggregated cells without per-control children: row-internal controls such as like, bookmark, or '
      + 'share cannot be found by label. Use ios_sim_ui_rows to enumerate them and ios_sim_tap_row to operate '
      + 'inside a row.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name, or a physical-device udid/name from '
          + 'ios_sim_devices.realDevices (WebDriverAgent must be running for the device). Defaults to '
          + 'the currently streamed device, else the first booted simulator.',
      },
      max_depth: {
        type: 'integer',
        description: 'Maximum tree nesting depth to include (0 = root only). Useful to shrink large trees. '
          + 'On a physical device this also sets the WebDriverAgent snapshotMaxDepth (raises or lowers the '
          + 'depth cap; an uncapped snapshot of a busy app costs ~30 s).',
      },
      filter: {
        type: 'string',
        description: 'Case-insensitive substring matched against element label, identifier, or type. '
          + 'Matching elements and their ancestors are kept, everything else is pruned.',
      },
      include_offscreen: {
        type: 'boolean',
        description: 'Include off-screen elements (visible=false or frames outside the screen bounds) '
          + 'in the output. Default false: they are excluded (noise and a tap trap) and reported as '
          + 'omittedOffscreen.',
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
          omittedOffscreen: { type: 'integer', required: true },
          sampledDepth: { type: 'integer' },
          deepened: { type: 'boolean' },
          depthsTried: { type: 'array', items: { type: 'integer' } },
          truncated: { type: 'boolean' },
          hint: { type: 'string' },
          tree: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: renderJson,
    },
    timeoutMs: 420_000,
    isConcurrencySafe: () => true,
    async execute(args: { udid?: string; max_depth?: number; filter?: string; include_offscreen?: boolean }, exec) {
      assertMacHost()
      const target = await resolveToolTarget(host, wda, realDevices, args.udid, exec.signal)
      if (target.kind === 'real') {
        await ensureWdaRunning('ios_sim_ui_tree', wda!, target.device)
        const sample = await wdaTree(wda!, target.device, args.max_depth)
        // The device's point size from WDA (the same space element frames and
        // /wda/tap use); fall back to the largest root frame when the window
        // query fails.
        let size = screenSize(sample.roots)
        try {
          size = await wda!.control.windowSize()
        } catch {
          // screenSize(roots) fallback stays.
        }
        return buildTreeResult(sample.roots, size, realDeviceSummary(target.device), args, sample)
      }
      const binary = await requireAxeBinary('ios_sim_ui_tree')
      let roots: AxeElement[]
      try {
        roots = await describeUi(binary, target.device.udid, exec.signal)
      } catch (error) {
        throw new Error(`ios_sim_ui_tree: could not read the accessibility tree of ${target.device.name} (${target.device.udid}): ${errorMessage(error)}`)
      }
      return buildTreeResult(roots, screenSize(roots), {
        udid: target.device.udid,
        name: target.device.name,
        runtime: target.device.runtime,
        state: target.device.state,
      }, args)
    },
    presentCall: (args: { udid?: string }) => ({
      card: 'generic',
      title: args.udid === undefined ? 'Inspect simulator UI tree' : `Inspect UI tree of ${args.udid}`,
      kind: 'execute',
    }),
  })

  const iosSimTapElement = defineTool({
    name: 'ios_sim_tap_element',
    description: 'Tap an accessibility element on a booted iOS Simulator (AXe) or on a USB-connected '
      + 'physical iOS device (WebDriverAgent; pass its udid from ios_sim_devices.realDevices) by '
      + 'identity (identifier and/or label) instead of raw coordinates. The selector matches exactly '
      + 'first, then case-insensitively as a substring. Nested duplicates (a row mirroring its label '
      + 'onto child text) collapse to one target; if several distinct elements still match, the error '
      + 'lists every candidate with its label, frame, and visible/enabled flags. Only visible and '
      + 'enabled elements are matched by default: when the only match is off-screen or disabled the '
      + 'tool fails with an actionable message instead of tapping dead coordinates (allow_offscreen=true '
      + 'taps off-screen elements anyway; disabled elements always refuse). The tap lands on the '
      + 'element center, then after ~300 ms a fresh screenshot is captured with the same summary shape '
      + 'as ios_sim_interact, so the effect is visible. To CONFIRM the tap landed, pass expect_text (a label '
      + 'that should appear) or expect_gone (one that should disappear) — the tool polls the screen OCR and '
      + 'reports expected.matched in the same call. Do NOT screenshot-and-compare pixels to check whether a '
      + 'tap worked; use these assertions instead. Simulators require the AXe helper '
      + `(auto-downloaded on first use; manual alternative: ${AXE_INSTALL_HINT.split(';')[0]}).`,
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name, or a physical-device udid/name from '
          + 'ios_sim_devices.realDevices (WebDriverAgent must be running for the device). Defaults to '
          + 'the currently streamed device, else the first booted simulator.',
      },
      identifier: {
        type: 'string',
        description: 'Accessibility identifier to match, e.g. "com.apple.settings.general". '
          + 'Exact match first, then case-insensitive substring.',
      },
      label: {
        type: 'string',
        description: 'Accessibility label to match, e.g. "General". '
          + 'Exact match first, then case-insensitive substring.',
      },
      allow_offscreen: {
        type: 'boolean',
        description: 'Allow tapping an element that is off-screen (visible=false or outside the screen '
          + 'bounds) — the tap lands at the recorded coordinates whatever is displayed there. Default '
          + 'false: such a match fails with a scroll-it-into-view error. Disabled elements are always '
          + 'refused, regardless of this flag.',
      },
      expect_text: {
        type: 'string',
        description: 'Optional text that should APPEAR after the tap. The tool polls screen OCR for up to '
          + '~4 s and reports expected.matched — one round trip instead of tap + screenshot + manual compare.',
      },
      expect_gone: {
        type: 'string',
        description: 'Optional text that should DISAPPEAR after the tap. Mutually exclusive with '
          + 'expect_text; reported as expected.matched (true = the text is gone).',
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
          expected: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              mode: { type: 'string', required: true, enum: ['appear', 'disappear'] },
              matched: { type: 'boolean', required: true },
              waitedMs: { type: 'integer', required: true },
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
    timeoutMs: 420_000,
    async execute(args: { udid?: string; identifier?: string; label?: string; allow_offscreen?: boolean; expect_text?: string; expect_gone?: string }, exec) {
      assertMacHost()
      const target = await resolveToolTarget(host, wda, realDevices, args.udid, exec.signal)
      const selector = { identifier: args.identifier, label: args.label }
      const gate = { allowOffscreen: args.allow_offscreen === true }
      const expectation = tapExpectation(args)
      if (target.kind === 'real') {
        await ensureWdaRunning('ios_sim_tap_element', wda!, target.device)
        const sample = await wdaTree(wda!, target.device)
        const roots = sample.roots
        // SAME matching rules as the simulator path: exact identifier/label
        // first, then case-insensitive contains, nested-duplicate collapse,
        // off-screen/disabled gate, ambiguity → candidate list error.
        const { element } = resolveTapTarget(roots, selector, { ...gate, sampledDepth: sample.sampledDepth })
        const center = frameCenter(element.frame)
        try {
          // Element frames from the WDA tree are in device points — the same
          // absolute space WDA /wda/tap consumes, so the center taps directly.
          await wda!.control.tap(center.x, center.y)
        } catch (error) {
          throw new Error(`ios_sim_tap_element: WebDriverAgent tap at (${center.x}, ${center.y}) failed: ${errorMessage(error)}`)
        }
        await sleep(TAP_SETTLE_MS)
        const screenshot = await captureWdaScreenshot('ios_sim_tap_element', screenshots, wda!, target.device)
        const expected = expectation === undefined
          ? undefined
          : await runTapExpectation('ios_sim_tap_element', target, screenshots, wda, expectation.text, expectation.mode, exec.signal)
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
          ...(expected === undefined ? {} : { expected }),
        } satisfies SimTapElementResult
      }
      const binary = await requireAxeBinary('ios_sim_tap_element')
      let roots: AxeElement[]
      try {
        roots = await describeUi(binary, target.device.udid, exec.signal)
      } catch (error) {
        throw new Error(`ios_sim_tap_element: could not read the accessibility tree of ${target.device.name} (${target.device.udid}): ${errorMessage(error)}`)
      }
      const { element } = resolveTapTarget(roots, selector, gate)
      const center = frameCenter(element.frame)
      try {
        await execAxe(binary, ['tap', '-x', String(center.x), '-y', String(center.y), '--udid', target.device.udid], 60_000, exec.signal)
      } catch (error) {
        throw new Error(`ios_sim_tap_element: AXe tap at (${center.x}, ${center.y}) failed: ${errorMessage(error)}`)
      }
      await sleep(TAP_SETTLE_MS)
      const screenshot = await captureScreenshot(screenshots, target.device.udid, exec.signal)
      const expected = expectation === undefined
        ? undefined
        : await runTapExpectation('ios_sim_tap_element', target, screenshots, wda, expectation.text, expectation.mode, exec.signal)
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
        ...(expected === undefined ? {} : { expected }),
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

/** One `ios_sim_find_text` result item (rect in device points). */
export interface SimFindTextItem {
  text: string
  confidence: number
  rect: { x: number; y: number; w: number; h: number }
}

export interface SimFindTextResult {
  device: SimDeviceInfo
  /** Screen dimensions in POINTS (pixels when the point size cannot be resolved — see note). */
  size: { width: number; height: number }
  /** Number of items in the returned (possibly capped) list. */
  count: number
  items: SimFindTextItem[]
  /** True when low-confidence items were dropped to fit the output cap. */
  truncated?: boolean
  /** Guidance shown when truncated (narrow with query / min_confidence). */
  hint?: string
  /** Degradation note (e.g. point size unavailable → pixel geometry). */
  note?: string
}

export interface SimTapTextResult {
  action: 'tap-text'
  text: string
  confidence: number
  /** Tapped text box in device points. */
  rect: { x: number; y: number; w: number; h: number }
  /** Tapped screen point in device points. */
  center: { x: number; y: number }
  /** Coordinates actually sent to the control backend. */
  tap: { x: number; y: number }
  /** Space of `tap`: normalized 0..1 (simulator serve-sim) or points (WDA). */
  tapSpace: 'normalized' | 'points'
  /** Outcome assertion (expect_text/expect_gone), when requested. */
  expected?: OcrExpectationResult
  path: string
  bytes: number
  width?: number
  height?: number
  device: SimDeviceInfo
}

/** The optional post-tap outcome assertion (expect_text / expect_gone). */
export interface OcrExpectationResult {
  text: string
  mode: 'appear' | 'disappear'
  matched: boolean
  waitedMs: number
}

/** One matched OCR item in device points, as `ios_sim_wait_for` reports it. */
export interface SimWaitForItem {
  text: string
  confidence: number
  rect: { x: number; y: number; w: number; h: number }
}

/** `ios_sim_wait_for` result: a timeout is a normal `matched:false`, never a throw. */
export interface SimWaitForResult {
  device: SimDeviceInfo
  matched: boolean
  waitedMs: number
  text: string
  mode: 'appear' | 'disappear'
  /** The matched OCR item (appear mode) in device points. */
  item?: SimWaitForItem
}

export interface SimOcrTools {
  iosSimFindText: ToolDefinition
  iosSimTapText: ToolDefinition
  iosSimWaitFor: ToolDefinition
}

/** Default minimum OCR confidence (0.3 — the prototype's useful floor). */
export const OCR_DEFAULT_MIN_CONFIDENCE = 0.3

/** Validate/parse the optional min_confidence argument. */
export function sanitizeMinConfidence(value: number | undefined): number {
  if (value === undefined) return OCR_DEFAULT_MIN_CONFIDENCE
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('min_confidence must be a number within 0..1')
  }
  return value
}

function roundPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: round2(point.x), y: round2(point.y) }
}

function roundRect(rect: OcrRect): OcrRect {
  return { x: round2(rect.x), y: round2(rect.y), w: round2(rect.w), h: round2(rect.h) }
}

/** A captured frame plus everything needed to map pixel boxes to taps. */
interface OcrFrame {
  path: string
  bytes: number
  pixelSize: PixelSize
  pointSize: PixelSize
  device: SimDeviceInfo
  note?: string
}

/** Screenshot pixel size is REQUIRED for OCR coordinate math. */
function requirePixelSize(shot: ScreenshotCapture, tool: string): PixelSize {
  if (typeof shot.width !== 'number' || typeof shot.height !== 'number' || shot.width <= 0 || shot.height <= 0) {
    throw new Error(`${tool}: could not determine the screenshot pixel size of ${shot.device.name} (unreadable PNG header)`)
  }
  return { width: shot.width, height: shot.height }
}

/**
 * Simulator point size via the existing logical-size helper: the AXe
 * describe-ui app root frame (the same `screenSize` ui_tree uses). This is
 * a best-effort probe (resolution-only, no download): when AXe is missing
 * or the dump fails, geometry degrades to image pixels with a clear note —
 * OCR keeps working even though the accessibility layer is unavailable.
 */
/**
 * Point size per (device, pixel size). The mapping is a DEVICE PROPERTY — a
 * 1206×2622 iPhone 17 Pro screenshot is always 402×874 points — but resolving
 * it costs a full AXe `describe-ui` dump of the whole accessibility tree,
 * measured at ~800 ms of a 1.5 s `ios_sim_find_text`. Every OCR call was
 * paying for an entire UI tree it then threw away. The pixel size is part of
 * the key, so a rotation (which swaps both) misses and re-resolves instead of
 * mapping taps through the wrong axis.
 */
const simPointSizeCache = new Map<string, PixelSize>()
const simPointSizeCounters = { hits: 0, misses: 0 }

/** Cache key: the same device at the same pixel size has the same point size. */
export function simPointSizeCacheKey(udid: string, pixelSize: PixelSize): string {
  return `${udid}:${pixelSize.width}x${pixelSize.height}`
}

/** Hit/miss counters + a reset, so the smoke can assert the cache without timing. */
export function simPointSizeStats(): { hits: number; misses: number; entries: number } {
  return { ...simPointSizeCounters, entries: simPointSizeCache.size }
}

export function resetSimPointSizeCache(): void {
  simPointSizeCache.clear()
  simPointSizeCounters.hits = 0
  simPointSizeCounters.misses = 0
}

async function simPointSize(
  udid: string,
  pixelSize: PixelSize,
  signal?: AbortSignal,
): Promise<{ size: PixelSize; note?: string }> {
  const cacheKey = simPointSizeCacheKey(udid, pixelSize)
  const cached = simPointSizeCache.get(cacheKey)
  if (cached !== undefined) {
    simPointSizeCounters.hits += 1
    return { size: cached }
  }
  simPointSizeCounters.misses += 1
  try {
    const binary = resolveAxeBinary()
    if (binary.available && binary.command !== undefined) {
      const roots = await describeUi(binary, udid, signal)
      const size = screenSize(roots)
      if (size.width > 0 && size.height > 0) {
        // Only a RESOLVED size is cached: the pixel-space degradation below is
        // a fallback for a missing helper, and caching it would make one bad
        // moment permanent for the rest of the session.
        simPointSizeCache.set(cacheKey, size)
        return { size }
      }
    }
  } catch {
    // Fall through to the pixel-space degradation.
  }
  return {
    size: { width: pixelSize.width, height: pixelSize.height },
    note: 'the simulator point size could not be resolved (AXe helper unavailable or describe-ui failed) — '
      + 'size and rects are reported in image pixels instead of points',
  }
}

/** Capture one frame for OCR: simctl for simulators, WDA for devices. */
async function captureOcrFrame(
  tool: string,
  target: ToolTarget,
  screenshots: ScreenshotStore,
  wda: WdaToolBackend | undefined,
  signal?: AbortSignal,
): Promise<OcrFrame> {
  if (target.kind === 'real') {
    await ensureWdaRunning(tool, wda!, target.device)
    const shot = await captureWdaScreenshot(tool, screenshots, wda!, target.device)
    const pixelSize = requirePixelSize(shot, tool)
    let pointSize: PixelSize
    try {
      pointSize = await wda!.control.windowSize()
    } catch (error) {
      throw new Error(`${tool}: could not read the window size of ${target.device.name}: ${errorMessage(error)}`)
    }
    return { path: shot.path, bytes: shot.bytes, pixelSize, pointSize, device: shot.device }
  }
  const shot = await captureScreenshot(screenshots, target.device.udid, signal)
  const pixelSize = requirePixelSize(shot, tool)
  const resolved = await simPointSize(target.device.udid, pixelSize, signal)
  return {
    path: shot.path,
    bytes: shot.bytes,
    pixelSize,
    pointSize: resolved.size,
    device: shot.device,
    ...(resolved.note === undefined ? {} : { note: resolved.note }),
  }
}

/** Resolve the compiled Vision helper and OCR one PNG into parsed items. */
async function runOcr(tool: string, imagePath: string, deviceName: string, signal?: AbortSignal): Promise<OcrItem[]> {
  const binary = await ensureOcrBinary()
  if (!binary.available) {
    throw new Error(
      `${tool}: the Vision OCR helper is unavailable`
      + `${binary.reason === undefined ? '' : ` (${binary.reason})`}; ${binary.installHint}`,
    )
  }
  try {
    return parseOcrOutput((await execOcr(binary, imagePath, signal)).stdout)
  } catch (error) {
    throw new Error(`${tool}: OCR failed for ${deviceName}: ${errorMessage(error)}`)
  }
}

/** One capture+OCR round trip: items plus the sizes for rect mapping. */
interface OcrSnapshot {
  items: OcrItem[]
  pixelSize: PixelSize
  pointSize: PixelSize
  device: SimDeviceInfo
}

/** Shared capture+OCR pipeline (`ios_sim_find_text`'s, reused by wait/tap). */
async function readOcrOnce(
  tool: string,
  target: ToolTarget,
  screenshots: ScreenshotStore,
  wda: WdaToolBackend | undefined,
  signal?: AbortSignal,
): Promise<OcrSnapshot> {
  const frame = await captureOcrFrame(tool, target, screenshots, wda, signal)
  const items = await runOcr(tool, frame.path, frame.device.name, signal)
  return { items, pixelSize: frame.pixelSize, pointSize: frame.pointSize, device: frame.device }
}

/** True when any OCR item matches the text (exact first, then contains). */
function ocrTextPresent(items: readonly OcrItem[], text: string): OcrItem | undefined {
  const exact = items.find(item => item.text === text)
  if (exact !== undefined) return exact
  const needle = text.toLowerCase()
  return items.find(item => item.text.toLowerCase().includes(needle))
}

/** One poll cycle's answer, shared by wait_for and the tap expectations. */
export interface OcrPollOutcome {
  matched: boolean
  waitedMs: number
  /** The matched OCR item in PIXELS; callers convert to points. */
  item?: OcrItem
}

/** Poll interval budgets (ms) per backend — a real device's capture+OCR round
 * trip costs more (find_text ~1.2 s, ui_tree ~2.6 s), so it polls half as
 * often instead of hammering WDA. */
const OCR_POLL_INTERVAL_SIM_MS = 600
const OCR_POLL_INTERVAL_REAL_MS = 1200

/**
 * Poll the OCR path until `text` appears or disappears (or the budget runs
 * out). One shared helper for `ios_sim_wait_for` and the tap tools'
 * `expect_text` / `expect_gone` assertions — a timeout is a normal
 * `matched: false`, never a throw. `read` is the injectable capture+OCR seam
 * (the tools pass a closure over `readOcrOnce`; tests pass a stub).
 */
export async function pollForText(
  read: () => Promise<readonly OcrItem[]>,
  text: string,
  mode: 'appear' | 'disappear',
  timeoutMs: number,
  intervalMs: number,
  minConfidence: number,
  signal?: AbortSignal,
): Promise<OcrPollOutcome> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  for (;;) {
    const items = filterOcrItems(await read(), text, minConfidence)
    const present = ocrTextPresent(items, text)
    const matched = mode === 'appear' ? present !== undefined : present === undefined
    const waitedMs = Date.now() - startedAt
    if (matched) {
      return mode === 'appear' && present !== undefined
        ? { matched: true, waitedMs, item: present }
        : { matched: true, waitedMs }
    }
    if (signal?.aborted === true || Date.now() >= deadline) {
      return { matched: false, waitedMs }
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  }
}

/** Convert a matched OCR item into the wait_for result shape (points). */
function waitForItem(item: OcrItem, snapshot: OcrSnapshot): SimWaitForItem {
  return {
    text: item.text,
    confidence: round2(item.confidence),
    rect: roundRect(pixelRectToPoints(item.rect, snapshot.pixelSize, snapshot.pointSize)),
  }
}

/**
 * Poll budget (ms) for a tap tool's `expect_text` / `expect_gone` assertion:
 * one OCR round trip on a real device already costs ~1.2 s, so 4000 ms allows
 * a couple of polls without turning a tap into another full wait_for.
 */
const TAP_EXPECTATION_BUDGET_MS = 4000

/** The tap tools' post-settle outcome assertion, via the shared poll helper. */
async function runTapExpectation(
  tool: string,
  target: ToolTarget,
  screenshots: ScreenshotStore,
  wda: WdaToolBackend | undefined,
  text: string,
  mode: 'appear' | 'disappear',
  signal?: AbortSignal,
): Promise<OcrExpectationResult> {
  const intervalMs = target.kind === 'real' ? OCR_POLL_INTERVAL_REAL_MS : OCR_POLL_INTERVAL_SIM_MS
  const outcome = await pollForText(
    () => readOcrOnce(tool, target, screenshots, wda, signal).then(snapshot => snapshot.items),
    text,
    mode,
    TAP_EXPECTATION_BUDGET_MS,
    intervalMs,
    0,
    signal,
  )
  return { text, mode, matched: outcome.matched, waitedMs: outcome.waitedMs }
}

/** Which expectation the tap args carry, or undefined when absent. */
function tapExpectation(args: { expect_text?: string; expect_gone?: string }): { text: string; mode: 'appear' | 'disappear' } | undefined {
  const expectText = typeof args.expect_text === 'string' && args.expect_text.trim() !== '' ? args.expect_text.trim() : undefined
  const expectGone = typeof args.expect_gone === 'string' && args.expect_gone.trim() !== '' ? args.expect_gone.trim() : undefined
  if (expectText !== undefined && expectGone !== undefined) {
    throw new Error('pass expect_text OR expect_gone, not both — they assert opposite outcomes')
  }
  if (expectText !== undefined) return { text: expectText, mode: 'appear' }
  if (expectGone !== undefined) return { text: expectGone, mode: 'disappear' }
  return undefined
}

/**
 * Resolve one OCR text target with the SAME rules as tap_element: exact
 * (case-sensitive) equality first, then case-insensitive contains; several
 * distinct matches raise a candidate-list error (text + confidence + rect).
 */
export function resolveOcrTextTarget(
  items: readonly OcrItem[],
  query: string,
  /** Every OCR item BEFORE the confidence filter, for the near-miss report. */
  unfiltered: readonly OcrItem[] = items,
  minConfidence = 0,
): { item: OcrItem; matchedBy: 'exact' | 'contains' } {
  const matches = (pool: readonly OcrItem[], mode: 'exact' | 'contains'): OcrItem[] => mode === 'exact'
    ? pool.filter(item => item.text === query)
    : pool.filter(item => item.text.toLowerCase().includes(query.toLowerCase()))
  let pool = matches(items, 'exact')
  let matchedBy: 'exact' | 'contains' = 'exact'
  if (pool.length === 0) {
    pool = matches(items, 'contains')
    matchedBy = 'contains'
  }
  if (pool.length === 0) {
    // "Not on screen" and "on screen but you filtered it out" are different
    // problems with different fixes, and the OCR reads Chinese/Japanese text
    // at 0.3–0.6 far more often than Latin text — a caller who raised
    // min_confidence silently loses exactly the labels they were aiming at.
    // Name the near miss and its confidence instead of sending them back to
    // find_text to rediscover it.
    const nearMiss = [...matches(unfiltered, 'exact'), ...matches(unfiltered, 'contains')]
      .filter(item => item.confidence < minConfidence)
      .sort((a, b) => b.confidence - a.confidence)[0]
    if (nearMiss !== undefined) {
      throw new Error(
        `ios_sim_tap_text: ${JSON.stringify(nearMiss.text)} IS on the current screen, but its OCR `
        + `confidence ${nearMiss.confidence.toFixed(2)} is below min_confidence ${minConfidence.toFixed(2)} — `
        + 'pass a lower min_confidence (CJK labels commonly read 0.3–0.6) or tap it by identifier '
        + 'with ios_sim_tap_element',
      )
    }
    throw new Error(
      `ios_sim_tap_text: no recognized text matches ${JSON.stringify(query)} on the current screen — `
      + 'run ios_sim_find_text to see everything the OCR read',
    )
  }
  const unique = pool.filter((item, index) => !pool.slice(0, index).some(other =>
    other.text === item.text
    && other.rect.x === item.rect.x && other.rect.y === item.rect.y
    && other.rect.w === item.rect.w && other.rect.h === item.rect.h))
  if (unique.length > 1) {
    const shown = unique.slice(0, 8)
    const more = unique.length - shown.length
    throw new Error(
      `ios_sim_tap_text: ${unique.length} OCR matches for ${JSON.stringify(query)} — use a more specific query, `
      + 'or raise min_confidence to drop weak matches. Candidates:\n'
      + shown.map((item, index) =>
        `  ${index + 1}) text=${JSON.stringify(item.text)} confidence=${round2(item.confidence)} `
        + `rect={x:${round2(item.rect.x)},y:${round2(item.rect.y)},w:${round2(item.rect.w)},h:${round2(item.rect.h)}}`).join('\n')
      + (more > 0 ? `\n  …and ${more} more` : ''),
    )
  }
  return { item: unique[0], matchedBy }
}

/** Cap the OCR item list (~40 KB): drop the lowest-confidence tail first. */
function capOcrItems(items: SimFindTextItem[]): { items: SimFindTextItem[]; truncated: boolean } {
  const bytes = (list: SimFindTextItem[]): number => Buffer.byteLength(JSON.stringify(list), 'utf8')
  if (bytes(items) <= UI_TREE_CAP_BYTES) return { items, truncated: false }
  const kept = [...items]
  while (bytes(kept) > UI_TREE_CAP_BYTES && kept.length > 1) kept.pop()
  return { items: kept, truncated: true }
}

/** Create the two Vision-OCR tool definitions bound to one controller. */
export function createSimOcrTools(host: SimHostController, options: SimUiToolsOptions = {}): SimOcrTools {
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'dsh-ios')
  const screenshots = new ScreenshotStore(cacheDir)
  const wda = options.wda
  const realDevices: RealDeviceResolution = options.realDevices ?? { matches: matchesRealDevice, resolve: getRealDevice }

  const iosSimFindText = defineTool({
    name: 'ios_sim_find_text',
    description: 'OCR the CURRENT screen of a booted iOS Simulator or a USB-connected physical iOS device '
      + '(pass its udid from ios_sim_devices.realDevices) with the plugin-compiled Vision helper '
      + '(accurate recognition, zh-Hans + en-US, compiled with swiftc on first use into '
      + '~/Library/Caches/dsh-ios/bin/ocr). Use this when the accessibility tree is empty or degenerate, '
      + 'for text rendered as graphics (badge counts, prices baked into images), or to independently '
      + 'verify what is on screen. Captures a fresh screenshot, then returns {device, size in device '
      + 'points, items:[{text, confidence, rect}]} — rects are device-point boxes (origin top-left), '
      + 'so they can be tapped via ios_sim_tap_text or reasoned about directly. Items are '
      + 'confidence-sorted and the list is capped at ~40 KB (truncated=true drops the lowest-confidence '
      + 'tail — narrow with query or raise min_confidence). Icon-only controls carry no OCR text; for list '
      + 'rows use ios_sim_ui_rows.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name, or a physical-device udid/name from '
          + 'ios_sim_devices.realDevices (WebDriverAgent must be running for the device). Defaults to '
          + 'the currently streamed device, else the first booted simulator.',
      },
      query: {
        type: 'string',
        description: 'Optional case-insensitive substring filter on the recognized text (e.g. "支付" or '
          + '"Payment"). Omit to return every item above min_confidence.',
      },
      min_confidence: {
        type: 'number',
        description: 'Minimum recognition confidence 0..1 to include (default 0.3). Raise it to drop '
          + 'noise, lower it to catch faint text.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          size: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
            },
          },
          count: { type: 'integer', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                confidence: { type: 'number', required: true },
                rect: {
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
              },
            },
          },
          truncated: { type: 'boolean' },
          hint: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: renderJson,
    },
    timeoutMs: 420_000,
    isConcurrencySafe: () => true,
    async execute(args: { udid?: string; query?: string; min_confidence?: number }, exec) {
      assertMacHost()
      const minConfidence = sanitizeMinConfidence(args.min_confidence)
      const target = await resolveToolTarget(host, wda, realDevices, args.udid, exec.signal)
      const frame = await captureOcrFrame('ios_sim_find_text', target, screenshots, wda, exec.signal)
      const items = await runOcr('ios_sim_find_text', frame.path, frame.device.name, exec.signal)
      const filtered = filterOcrItems(items, args.query, minConfidence)
      const converted = filtered.map(item => ({
        text: item.text,
        confidence: round2(item.confidence),
        rect: roundRect(pixelRectToPoints(item.rect, frame.pixelSize, frame.pointSize)),
      }))
      const capped = capOcrItems(converted)
      return {
        device: frame.device,
        size: { width: round2(frame.pointSize.width), height: round2(frame.pointSize.height) },
        count: capped.items.length,
        items: capped.items,
        ...(capped.truncated
          ? {
            truncated: true,
            hint: 'The OCR item list exceeded the 40 KB output cap and the lowest-confidence items were '
              + 'dropped. Narrow with query or raise min_confidence.',
          }
          : {}),
        ...(frame.note === undefined ? {} : { note: frame.note }),
      } satisfies SimFindTextResult
    },
    presentCall: (args: { query?: string }) => ({
      card: 'generic',
      title: args.query === undefined ? 'Find text on screen' : `Find text "${args.query}" on screen`,
      kind: 'execute',
      rawInput: args.query === undefined ? {} : { query: args.query },
    }),
  })

  const iosSimWaitFor = defineTool({
    name: 'ios_sim_wait_for',
    description: 'Wait until text appears or disappears on a booted iOS Simulator or USB-connected physical '
      + 'device (pass its udid from ios_sim_devices.realDevices), polling the OCR path (the same '
      + 'capture+OCR pipeline ios_sim_find_text uses) until the condition holds or timeout_ms expires. '
      + 'A timeout is a normal matched:false answer, never an error — use it to gate an action on a '
      + 'condition without looping ios_sim_find_text yourself (that loop is several extra OCR round trips '
      + 'that each cost ~1.2 s on a real device). mode "appear" waits for the text to show up; mode '
      + '"disappear" waits for it to be gone. On a match, item carries the OCR text/confidence/rect in '
      + 'device points.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name, or a physical-device udid/name from '
          + 'ios_sim_devices.realDevices (WebDriverAgent must be running for the device). Defaults to '
          + 'the currently streamed device, else the first booted simulator.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Text to wait for (case-insensitive substring).',
      },
      mode: {
        type: 'string',
        enum: ['appear', 'disappear'],
        description: 'Wait for the text to appear (default) or disappear.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'How long to poll before giving up, in milliseconds (default 8000, capped at 60000).',
      },
      min_confidence: {
        type: 'number',
        description: 'Minimum recognition confidence 0..1 for a match (default 0.3).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          matched: { type: 'boolean', required: true },
          waitedMs: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          mode: { type: 'string', required: true, enum: ['appear', 'disappear'] },
          item: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              confidence: { type: 'number', required: true },
              rect: {
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
            },
          },
        },
      },
      render: renderJson,
    },
    timeoutMs: 420_000,
    isConcurrencySafe: () => true,
    async execute(args: { udid?: string; text?: string; mode?: 'appear' | 'disappear'; timeout_ms?: number; min_confidence?: number }, exec) {
      assertMacHost()
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (text === '') {
        throw new Error('ios_sim_wait_for requires a non-empty text to wait for')
      }
      const mode = args.mode === 'disappear' ? 'disappear' : 'appear'
      const timeoutMs = Math.min(60_000, Math.max(0, typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) ? args.timeout_ms : 8000))
      const minConfidence = sanitizeMinConfidence(args.min_confidence)
      const target = await resolveToolTarget(host, wda, realDevices, args.udid, exec.signal)
      const intervalMs = target.kind === 'real' ? OCR_POLL_INTERVAL_REAL_MS : OCR_POLL_INTERVAL_SIM_MS
      // Resolve the device summary once (readOcrOnce returns it too, but the
      // timeout path never guarantees a poll ran — resolve up front so the
      // result always carries the device even on a zero-budget wait).
      const device: SimDeviceInfo = target.kind === 'real'
        ? realDeviceSummary(target.device)
        : (() => {
          const d = target.device
          return { udid: d.udid, name: d.name, runtime: d.runtime, state: d.state }
        })()
      let lastSnapshot: OcrSnapshot | undefined
      const outcome = await pollForText(
        async () => {
          lastSnapshot = await readOcrOnce('ios_sim_wait_for', target, screenshots, wda, exec.signal)
          return lastSnapshot.items
        },
        text,
        mode,
        timeoutMs,
        intervalMs,
        minConfidence,
        exec.signal,
      )
      return {
        device,
        matched: outcome.matched,
        waitedMs: outcome.waitedMs,
        text,
        mode,
        ...(outcome.item !== undefined && lastSnapshot !== undefined
          ? { item: waitForItem(outcome.item, lastSnapshot) }
          : {}),
      } satisfies SimWaitForResult
    },
    presentCall: (args: { text?: string; mode?: string }) => ({
      card: 'generic',
      title: `Wait for text ${JSON.stringify(args.text ?? '')} to ${args.mode === 'disappear' ? 'disappear' : 'appear'}`,
      kind: 'execute',
      rawInput: args.text === undefined ? {} : { text: args.text, mode: args.mode ?? 'appear' },
    }),
  })

  const iosSimTapText = defineTool({
    name: 'ios_sim_tap_text',
    description: 'OCR the CURRENT screen and tap the center of the best text match — the same exact → '
      + 'case-insensitive-contains → candidate-list ambiguity rules as ios_sim_tap_element, for text '
      + 'the accessibility tree cannot see (no-a11y apps, badge counts, text baked into images). '
      + 'On a REAL device every tap has real consequences (posts, likes, purchases, messages, shares): '
      + 'NEVER tap an unidentified control to find out what it does — if a control cannot be identified, '
      + 'STOP and report what you see instead of guessing coordinates. '
      + 'Targets a USB-connected physical iOS device through WebDriverAgent (pass its udid; tap lands '
      + 'at absolute device points) or the currently STREAMED simulator (tap is sent normalized 0..1 '
      + 'through the serve-sim control — call ios_sim_boot first). OCR boxes are image pixels and are '
      + 'converted through the screenshot pixel size and the device point size (WDA windowSize(); never '
      + 'a fixed 3× scale). After ~300 ms a fresh screenshot is captured with the same summary shape as '
      + 'ios_sim_interact. To CONFIRM the tap landed, pass expect_text (text that should appear) or '
      + 'expect_gone (text that should disappear) — the tool polls screen OCR and reports expected.matched '
      + 'in the same call, so a tap and its verification are ONE round trip. Do NOT screenshot-and-compare '
      + 'pixels to check whether a tap worked; use these assertions instead. Requires the plugin-compiled '
      + 'Vision helper (swiftc on first use).',
    parameters: {
      udid: {
        type: 'string',
        description: 'Physical-device udid or name (from ios_sim_devices.realDevices) to tap through '
          + 'WebDriverAgent (run ios_real_start_wda first if WDA is not running). Omit to tap on the '
          + 'currently streamed simulator (serve-sim control, normalized coordinates).',
      },
      query: {
        type: 'string',
        required: true,
        description: 'Text to tap, e.g. "支付成功" or "Continue". Case-sensitive exact match first, then '
          + 'case-insensitive substring; several distinct matches raise a candidate-list error.',
      },
      min_confidence: {
        type: 'number',
        description: 'Minimum recognition confidence 0..1 for a match (default 0.3).',
      },
      expect_text: {
        type: 'string',
        description: 'Optional text that should APPEAR after the tap. The tool polls screen OCR for up to '
          + '~4 s and reports expected.matched — one round trip instead of tap + screenshot + manual compare.',
      },
      expect_gone: {
        type: 'string',
        description: 'Optional text that should DISAPPEAR after the tap. Mutually exclusive with '
          + 'expect_text; reported as expected.matched (true = the text is gone).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, const: 'tap-text' },
          text: { type: 'string', required: true },
          confidence: { type: 'number', required: true },
          rect: {
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
          center: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
            },
          },
          tap: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
            },
          },
          tapSpace: { type: 'string', required: true, enum: ['normalized', 'points'] },
          expected: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              mode: { type: 'string', required: true, enum: ['appear', 'disappear'] },
              matched: { type: 'boolean', required: true },
              waitedMs: { type: 'integer', required: true },
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
    timeoutMs: 420_000,
    async execute(args: { udid?: string; query?: string; min_confidence?: number; expect_text?: string; expect_gone?: string }, exec) {
      assertMacHost()
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') {
        throw new Error('ios_sim_tap_text requires a non-empty query (exact match first, then case-insensitive contains)')
      }
      const minConfidence = sanitizeMinConfidence(args.min_confidence)
      const expectation = tapExpectation(args)
      const reference = args.udid?.trim() ?? ''
      if (reference !== '' && await realDevices.matches(reference, exec.signal)) {
        if (wda === undefined) {
          throw new Error(
            `"${reference}" is a physical iOS device but the WebDriverAgent backend is not configured — `
            + 'the plugin wires it automatically',
          )
        }
        const device = await realDevices.resolve(reference, exec.signal)
        requireAvailable(device)
        await ensureWdaRunning('ios_sim_tap_text', wda, device)
        const shot = await captureWdaScreenshot('ios_sim_tap_text', screenshots, wda, device)
        const pixelSize = requirePixelSize(shot, 'ios_sim_tap_text')
        let pointSize: PixelSize
        try {
          pointSize = await wda.control.windowSize()
        } catch (error) {
          throw new Error(`ios_sim_tap_text: could not read the window size of ${device.name}: ${errorMessage(error)}`)
        }
        const items = await runOcr('ios_sim_tap_text', shot.path, device.name, exec.signal)
        const { item } = resolveOcrTextTarget(filterOcrItems(items, query, minConfidence), query, items, minConfidence)
        // Pixel box → device points through the screenshot pixel size and
        // WDA's window size; /wda/tap consumes absolute points.
        const center = roundPoint(pixelCenterToPoints(rectCenter(item.rect), pixelSize, pointSize))
        try {
          await wda.control.tap(center.x, center.y)
        } catch (error) {
          throw new Error(`ios_sim_tap_text: WebDriverAgent tap at (${center.x}, ${center.y}) failed: ${errorMessage(error)}`)
        }
        await sleep(TAP_SETTLE_MS)
        const screenshot = await captureWdaScreenshot('ios_sim_tap_text', screenshots, wda, device)
        const expected = expectation === undefined
          ? undefined
          : await runTapExpectation('ios_sim_tap_text', { kind: 'real', device }, screenshots, wda, expectation.text, expectation.mode, exec.signal)
        return {
          action: 'tap-text',
          text: item.text,
          confidence: round2(item.confidence),
          rect: roundRect(pixelRectToPoints(item.rect, pixelSize, pointSize)),
          center,
          tap: center,
          tapSpace: 'points',
          ...screenshot,
          ...(expected === undefined ? {} : { expected }),
        } satisfies SimTapTextResult
      }
      // Simulator: the serve-sim control path consumes normalized 0..1, so
      // the live stream is required (the same contract as ios_sim_interact).
      const status = host.status()
      if (!status.running || status.device === undefined) {
        throw new Error('ios_sim_tap_text: no simulator is being streamed — call ios_sim_boot first, then tap text on the live view')
      }
      const shot = await captureScreenshot(screenshots, status.device, exec.signal)
      const pixelSize = requirePixelSize(shot, 'ios_sim_tap_text')
      const resolved = await simPointSize(status.device, pixelSize, exec.signal)
      const items = await runOcr('ios_sim_tap_text', shot.path, shot.device.name, exec.signal)
      const { item } = resolveOcrTextTarget(filterOcrItems(items, query, minConfidence), query, items, minConfidence)
      // Pixel box → normalized 0..1 through the screenshot's own pixel size
      // (the serve-sim control multiplies by the live logical size itself).
      const normalizedCenter = pixelRectToNormalizedCenter(item.rect, pixelSize)
      const tap = {
        x: losslessNumber(Math.round(normalizedCenter.x * 10_000) / 10_000),
        y: losslessNumber(Math.round(normalizedCenter.y * 10_000) / 10_000),
      }
      try {
        await host.control(['tap', '-d', status.device, String(tap.x), String(tap.y)])
      } catch (error) {
        throw new Error(`ios_sim_tap_text: serve-sim tap at (${tap.x}, ${tap.y}) failed: ${errorMessage(error)}`)
      }
      await sleep(TAP_SETTLE_MS)
      const screenshot = await captureScreenshot(screenshots, status.device, exec.signal)
      const center = roundPoint(pixelCenterToPoints(rectCenter(item.rect), pixelSize, resolved.size))
      const expectationTarget: ToolTarget = { kind: 'simulator', device: await getDevice(status.device) }
      const expected = expectation === undefined
        ? undefined
        : await runTapExpectation('ios_sim_tap_text', expectationTarget, screenshots, wda, expectation.text, expectation.mode, exec.signal)
      return {
        action: 'tap-text',
        text: item.text,
        confidence: round2(item.confidence),
        rect: roundRect(pixelRectToPoints(item.rect, pixelSize, resolved.size)),
        center,
        tap,
        tapSpace: 'normalized',
        ...screenshot,
        ...(expected === undefined ? {} : { expected }),
      } satisfies SimTapTextResult
    },
    presentCall: (args: { query?: string }) => ({
      card: 'generic',
      title: `Tap text ${JSON.stringify(args.query ?? '')}`,
      kind: 'execute',
      rawInput: args.query === undefined ? {} : { query: args.query },
    }),
  })

  return {
    iosSimFindText,
    iosSimTapText,
    iosSimWaitFor,
  }
}
