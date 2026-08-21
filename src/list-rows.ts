/**
 * Row-level abstraction for list/feed apps (WP63).
 *
 * UIKit/SwiftUI lists aggregate a whole feed item into ONE accessibility
 * element (a Cell) whose label carries the entire summary — including its
 * counters ("57 回复。18 喜欢。592 次查看"). The per-control buttons (a
 * heart, a bookmark) are NOT separate child elements, so there is nothing to
 * match by label: the row itself is the unit. This module provides the three
 * pieces that make such screens operable without guessing absolute screen
 * coordinates or probing icon-only controls on a real account:
 *
 * 1. `detectListRows` — recognize repeated isomorphic rows (Cell-type
 *    elements, plus a generic same-shape fallback for apps whose rows carry
 *    a non-Cell type), each with index, frame, aggregated label.
 * 2. `parseCountsFromLabel` — parse the counters out of an aggregated label
 *    generically: a number followed by a classifier token (中文/English
 *    alike). No app vocabulary is hardcoded; only numeric units (万/亿/k/m/w)
 *    are understood as multipliers.
 * 3. `planRowTap` + `verifyCountChange` — operate at a RELATIVE position
 *    inside row N, then confirm the action by the target counter moving the
 *    expected ±1 — the only reliable confirmation a list app offers.
 *
 * Everything here is pure (no device, no WDA, no AXe) so the smoke can drive
 * it with fixtures. The tools in tool-list-rows.ts wire it to both backends
 * and add the real-device safety gates.
 *
 * @module @zseven-w/dsh-ios/list-rows
 */

import type { AxeElement } from './uitree-backend.js'

/** True when `frame` lies ENTIRELY outside the screen bounds (points) — the
 * same predicate tool-uitree.ts uses, kept local so this module stays pure. */
export function isRowOffscreenFrame(
  frame: { x: number; y: number; w: number; h: number },
  bounds: { width: number; height: number },
): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return false
  return frame.x + frame.w <= 0
    || frame.y + frame.h <= 0
    || frame.x >= bounds.width
    || frame.y >= bounds.height
}

/** Element types treated as one list row. */
const CELL_TYPES = new Set(['Cell', 'TableRow', 'CollectionCell', 'ListItem', 'Row'])

/** Element types that make a container INTERACTIVE — such an element is a
 * control (not a plain aggregated row), so the generic fallback skips it. */
const INTERACTIVE_TYPES = new Set([
  'Button', 'Link', 'Switch', 'TextField', 'SearchField', 'TextArea',
  'Tab', 'TabButton', 'Menu', 'MenuItem', 'MenuBarItem', 'Slider', 'Stepper',
  'Incrementor', 'PickerWheel', 'Handle', 'RadioButton', 'CheckBox',
  'DisclosureTriangle', 'PopUpButton', 'ComboBox', 'ScrollBar',
])

/** Minimum rows that make a repeated group "isomorphic" (repeated). */
export const MIN_REPEATED_ROWS = 2

/** Frame tolerance (points) for shape equality between sibling rows. */
const SHAPE_EPSILON = 2

/** Height bounds (points) for the generic non-Cell row fallback. */
const MIN_ROW_HEIGHT = 24
const MAX_ROW_HEIGHT = 600

/** Min screen-width fraction a fallback row must span (a full-width row). */
const MIN_ROW_WIDTH_FRACTION = 0.4

/** One counter parsed out of an aggregated row label. */
export interface RowCount {
  /** The classifier token exactly as it appears (e.g. "回复", "replies"). */
  key: string
  /** The parsed numeric value (multipliers 万/亿/k/m/w applied). */
  value: number
}

/** One detected list row. */
export interface ListRow {
  /** 0-based order among the visible rows, top-to-bottom (then left-right). */
  index: number
  /** Accessibility element type the row was recognized by. */
  type: string
  /** Frame in device points. */
  frame: { x: number; y: number; w: number; h: number }
  /**
   * Aggregated label: the row's own label plus any DISTINCT descendant
   * labels, joined with spaces. Feed cells carry the whole summary here.
   */
  label?: string
  /** Counters parsed from the label, in order of appearance. */
  counts: RowCount[]
  /** Shape-group id: rows sharing a group are isomorphic siblings. */
  group?: number
}

/** Detected rows plus diagnostics for the tool output. */
export interface DetectRowsResult {
  rows: ListRow[]
  /** Number of distinct repeated shape groups (>= 2 rows each). */
  repeatedGroups: number
  /** Cell-shaped elements dropped because they were off-screen. */
  omittedOffscreen: number
  /** Recognized non-Cell rows (generic fallback) included in `rows`. */
  fallbackRows: number
}

/** Round a coordinate for output — negative zero never escapes (lossless JSON). */
function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded
}

/** Normalize a count key for comparison: lowercase Latin, collapse spaces. */
export function normalizeCountKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\u00a0/g, ' ')
}

/**
 * Numeric multipliers understood by the parser — numeric units only, NOT app
 * vocabulary. 万/亿 are Chinese magnitude units, k/m/w the Latin shorthand
 * (w = 万 as used in Chinese net-speak).
 */
const MULTIPLIERS: Record<string, number> = {
  万: 10_000,
  亿: 100_000_000,
  k: 1_000,
  K: 1_000,
  m: 1_000_000,
  M: 1_000_000,
  w: 10_000,
  W: 10_000,
}

/** Classifier-terminating characters: punctuation never belongs to a count
 * key, and neither do digits (they start the NEXT count). */
const TERMINATORS = '\\s,，.。:：;；!！?？…—\\-–%+*/()（）\\[\\]【】\'"“”·•~'

/** One parsed count: digits, optional multiplier, classifier token. The
 * (?!\d) guard drops "1A215"-style serial tokens where the "classifier" is
 * really the head of another number. */
const COUNT_REGEXP = new RegExp(
  // The class must cover every MULTIPLIERS key — `W` (net-speak 万) was
  // missing, so "3.2W 赞" parsed the W into the classifier instead of ×10000.
  `(\\d[\\d,]*(?:\\.\\d+)?)\\s*([万亿kmwKMW]?)\\s*([^\\d${TERMINATORS}]+)(?!\\d)`,
  'gu',
)

interface RawCountMatch {
  key: string
  value: number
}

/** Parse one label into (key, value) counter pairs. */
function scanCounts(label: string): RawCountMatch[] {
  const counts: RawCountMatch[] = []
  for (const match of label.matchAll(COUNT_REGEXP)) {
    const raw = match[1].replace(/,/g, '')
    const base = Number(raw)
    if (!Number.isFinite(base)) continue
    const multiplier = MULTIPLIERS[match[2]] ?? 1
    const key = normalizeCountKey(match[3])
    if (key === '') continue
    counts.push({ key, value: base * multiplier })
  }
  return counts
}

/**
 * Parse the counters out of an aggregated label: a number followed by a
 * classifier token, in 中文 or English ("57 回复。18 喜欢。592 次查看" →
 * 回复:57, 喜欢:18, 次查看:592; "57 replies. 18 likes. 592 views" → the same
 * shape). Purely generic: the classifier is whatever non-numeric token
 * follows the number, and only numeric units (万/亿/k/m/w) are multiplied
 * in. Keys round-trip: pass a key exactly as returned to
 * `verifyCountChange`.
 */
export function parseCountsFromLabel(label: string): RowCount[] {
  const counts: RowCount[] = []
  for (const scanned of scanCounts(label)) {
    const existing = counts.find(count => count.key === scanned.key)
    if (existing !== undefined) {
      // Same key twice in one label (a repeated phrase): keep the LAST value,
      // which is what a re-read would show.
      existing.value = scanned.value
      continue
    }
    counts.push({ key: scanned.key, value: scanned.value })
  }
  return counts
}

/** Find a counter by key (normalized comparison, as it round-trips). */
export function rowCountFor(row: ListRow, key: string): number | undefined {
  const needle = normalizeCountKey(key)
  return row.counts.find(count => count.key === needle)?.value
}

/**
 * Aggregate a row's label: its own label plus any DISTINCT descendant labels
 * (cells mirror child StaticTexts; deeper counters join in), space-joined.
 */
export function aggregateRowLabel(element: AxeElement): string | undefined {
  const parts: string[] = []
  const walk = (node: AxeElement): void => {
    if (node.label !== undefined && node.label.trim() !== '') {
      const trimmed = node.label.trim()
      if (!parts.includes(trimmed)) parts.push(trimmed)
    }
    for (const child of node.children) walk(child)
  }
  walk(element)
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** True when any descendant is an interactive control. */
function hasInteractiveDescendant(element: AxeElement): boolean {
  if (INTERACTIVE_TYPES.has(element.type)) return true
  return element.children.some(hasInteractiveDescendant)
}

interface FlatEntry {
  element: AxeElement
  depth: number
}

function flatten(roots: AxeElement[]): FlatEntry[] {
  const entries: FlatEntry[] = []
  const walk = (element: AxeElement, depth: number): void => {
    entries.push({ element, depth })
    for (const child of element.children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return entries
}

function sameFrame(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return Math.abs(a.x - b.x) <= SHAPE_EPSILON
    && Math.abs(a.y - b.y) <= SHAPE_EPSILON
    && Math.abs(a.w - b.w) <= SHAPE_EPSILON
    && Math.abs(a.h - b.h) <= SHAPE_EPSILON
}

/** Shape bucket: same type + width/height within tolerance = one group. */
function shapeKey(element: AxeElement): string {
  const widthBucket = Math.round(element.frame.w / 4) * 4
  const heightBucket = Math.round(element.frame.h / 4) * 4
  return `${element.type}:${widthBucket}x${heightBucket}`
}

export interface DetectRowsOptions {
  /** Screen bounds in points (off-screen candidates are dropped + counted). */
  bounds: { width: number; height: number }
  /** Minimum rows a shape group needs to count as "repeated" (default 2). */
  minRepeatedRows?: number
}

/**
 * Detect the visible rows of a list/feed screen.
 *
 * Pass 1 — the cell pass: every Cell-type element (Cell / TableRow /
 * CollectionCell / ListItem / Row) on-screen is a row.
 * Pass 2 — the generic fallback: non-Cell elements that span most of the
 * screen width, carry a label (own or descendants), contain NO interactive
 * child controls, and repeat the same type+size at least
 * `minRepeatedRows` times — SwiftUI feeds whose rows surface as `Other`/unnamed
 * containers. A single Cell still counts as a row; the generic pass needs the
 * repetition because without a cell type the shape pattern IS the evidence.
 *
 * Rows come back top-to-bottom (then left-to-right) with a 0-based index,
 * the aggregated label, the parsed counters, and a shape-group id for
 * isomorphic siblings. Off-screen candidates are dropped and counted.
 */
export function detectListRows(roots: AxeElement[], options: DetectRowsOptions): DetectRowsResult {
  const minRepeatedRows = options.minRepeatedRows ?? MIN_REPEATED_ROWS
  const entries = flatten(roots)
  const candidates = new Map<AxeElement, FlatEntry>()
  let omittedOffscreen = 0

  // Pass 1: Cell-type elements.
  for (const entry of entries) {
    if (!CELL_TYPES.has(entry.element.type)) continue
    if (isRowOffscreenFrame(entry.element.frame, options.bounds)) {
      omittedOffscreen += 1
      continue
    }
    // Same-frame duplicates (one element listed twice) collapse to the first.
    const duplicate = [...candidates.entries()].find(([element]) => sameFrame(element.frame, entry.element.frame))
    if (duplicate === undefined) candidates.set(entry.element, entry)
  }

  // Pass 2: generic repeated rows — non-Cell, non-interactive, labeled,
  // full-width, plausible height, and repeated at least minRepeatedRows times.
  const fallbackShapes = new Map<string, FlatEntry[]>()
  for (const entry of entries) {
    const element = entry.element
    if (CELL_TYPES.has(element.type) || INTERACTIVE_TYPES.has(element.type)) continue
    if (entry.depth === 0) continue // The app root itself is not a row.
    const { frame } = element
    if (frame.w < options.bounds.width * MIN_ROW_WIDTH_FRACTION) continue
    if (frame.h < MIN_ROW_HEIGHT || frame.h > MAX_ROW_HEIGHT) continue
    if (isRowOffscreenFrame(frame, options.bounds)) continue
    if (aggregateRowLabel(element) === undefined) continue
    if (hasInteractiveDescendant(element)) continue
    if (candidates.has(element)) continue
    const key = shapeKey(element)
    const group = fallbackShapes.get(key)
    if (group === undefined) fallbackShapes.set(key, [entry])
    else group.push(entry)
  }
  let fallbackRows = 0
  for (const group of fallbackShapes.values()) {
    if (group.length < minRepeatedRows) continue
    for (const entry of group) {
      const duplicate = [...candidates.entries()].find(([element]) => sameFrame(element.frame, entry.element.frame))
      if (duplicate === undefined) {
        candidates.set(entry.element, entry)
        fallbackRows += 1
      }
    }
  }

  // Order top-to-bottom, then left-to-right; assign indexes and shape groups.
  const ordered = [...candidates.keys()].sort((a, b) =>
    a.frame.y - b.frame.y || a.frame.x - b.frame.x)
  const groupIds = new Map<string, number>()
  let nextGroupId = 0
  const groupOf = (element: AxeElement): number | undefined => {
    const key = shapeKey(element)
    const existing = groupIds.get(key)
    if (existing !== undefined) return existing
    groupIds.set(key, nextGroupId)
    nextGroupId += 1
    return nextGroupId - 1
  }
  const rows: ListRow[] = ordered.map((element, index) => {
    const label = aggregateRowLabel(element)
    const bucket = groupOf(element)
    const siblings = ordered.filter(other => other !== element && shapeKey(other) === shapeKey(element)).length
    return {
      index,
      type: element.type,
      frame: {
        x: round2(element.frame.x),
        y: round2(element.frame.y),
        w: round2(element.frame.w),
        h: round2(element.frame.h),
      },
      ...(label === undefined ? {} : { label }),
      counts: label === undefined ? [] : parseCountsFromLabel(label),
      ...(siblings + 1 >= minRepeatedRows ? { group: bucket } : {}),
    }
  })
  const repeatedGroups = new Set(rows.filter(row => row.group !== undefined).map(row => row.group)).size
  return { rows, repeatedGroups, omittedOffscreen, fallbackRows }
}

/** A row-tap plan: absolute tap point plus the relative fractions it came from. */
export interface RowTapPlan {
  row: ListRow
  /** Relative position inside the row frame (0..1). */
  inRow: { x: number; y: number }
  /** Absolute device-point tap coordinates. */
  tap: { x: number; y: number }
}

function requireFraction(value: number, axis: 'x' | 'y'): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`ios_sim_tap_row: ${axis} must be a fraction within 0..1, got ${String(value)}`)
  }
}

/**
 * Plan a tap at a RELATIVE position inside row `index` (from a FRESH row
 * detection). Safety by construction: the row is located in the current
 * screen state, its frame must be on-screen, and an out-of-range index
 * FAILS (it never clamps to the last row — the model must re-read
 * ios_sim_ui_rows, never guess).
 */
export function planRowTap(
  rows: readonly ListRow[],
  index: number,
  fractionX: number,
  fractionY: number,
  bounds: { width: number; height: number },
): RowTapPlan {
  requireFraction(fractionX, 'x')
  requireFraction(fractionY, 'y')
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
    throw new Error(
      `ios_sim_tap_row: row ${index} does not exist — the current screen has ${rows.length} visible row(s). `
      + 'Re-run ios_sim_ui_rows and tap a row index it actually reports; never tap a remembered position.',
    )
  }
  const row = rows[index]
  if (isRowOffscreenFrame(row.frame, bounds)) {
    throw new Error(
      `ios_sim_tap_row: row ${index} lies off-screen — scroll it into view first, then re-run `
      + 'ios_sim_ui_rows so the fresh tree re-locates it.',
    )
  }
  return {
    row,
    inRow: { x: fractionX, y: fractionY },
    tap: {
      x: round2(row.frame.x + fractionX * row.frame.w),
      y: round2(row.frame.y + fractionY * row.frame.h),
    },
  }
}

/**
 * The probe-guard: before a row tap may carry a count-change expectation, the
 * row's parsed counters MUST contain the target key. A missing key means the
 * tap target cannot be identified — the call refuses BEFORE any tap instead of
 * "tapping to see what happens" on a real account (WP63).
 */
export function requireCountKey(row: ListRow, key: string): number {
  const value = rowCountFor(row, key)
  if (value === undefined) {
    const shown = row.counts.length === 0
      ? 'the row label carries no counters at all'
      : `the row label parses to: ${row.counts.map(count => `${count.key}=${count.value}`).join(', ')}`
    throw new Error(
      `ios_sim_tap_row: cannot verify a ${JSON.stringify(key)} change — ${shown}. `
      + 'Re-run ios_sim_ui_rows and use one of the counter keys it actually reports; '
      + 'a tap on a control that cannot be identified is refused, never probed.',
    )
  }
  return value
}

/** Outcome of a count-change verification after a row action. */
export interface CountCheckResult {
  /** The expected counter key (normalized). */
  key: string
  /** The expected delta (+1 or -1). */
  delta: 1 | -1
  /** Value parsed before the action (absent = key was missing). */
  before?: number
  /** Value parsed after the action (absent = key missing on re-read). */
  after?: number
  /** True when after - before equals delta exactly. */
  verified: boolean
  /** True when the counter moved AT ALL (even in the wrong direction). */
  changed: boolean
  /** Why the check could not be a plain verified=true. */
  reason?: string
}

/** Acceptable deltas: exactly ±1 (a single toggle on a real account, nothing else). */
export function sanitizeCountDelta(delta: number): 1 | -1 {
  if (delta !== 1 && delta !== -1) {
    throw new Error(`ios_sim_tap_row: expect_count.delta must be +1 or -1 (a single toggle), got ${String(delta)}`)
  }
  return delta
}

/** True when the re-read row plausibly still IS the row that was tapped:
 * its frame stayed put (a moved list or a pushed screen means the counters
 * cannot be compared). */
export function rowsStayedPut(before: ListRow, after: ListRow): boolean {
  const driftY = Math.abs(after.frame.y - before.frame.y)
  const driftX = Math.abs(after.frame.x - before.frame.x)
  return driftY <= Math.max(8, before.frame.h * 0.25)
    && driftX <= Math.max(8, before.frame.w * 0.25)
}

/**
 * Compare the target counter between the before- and after- snapshots of the
 * same row. `verified` is true ONLY when both parses found the key and the
 * value moved exactly by `delta`. Everything else is reported as a reason,
 * never guessed: a missing before-key, a missing after-key (label changed),
 * a moved row, or a counter that changed by the wrong amount.
 */
export function verifyCountChange(before: ListRow, after: ListRow, key: string, delta: 1 | -1): CountCheckResult {
  const normalized = normalizeCountKey(key)
  const beforeValue = rowCountFor(before, normalized)
  const afterValue = rowCountFor(after, normalized)
  if (beforeValue === undefined) {
    return { key: normalized, delta, after: afterValue, verified: false, changed: afterValue !== undefined, reason: 'the key was absent from the before label' }
  }
  if (afterValue === undefined) {
    return { key: normalized, delta, before: beforeValue, verified: false, changed: false, reason: 'the key is absent from the re-read label (the row text changed)' }
  }
  if (!rowsStayedPut(before, after)) {
    return { key: normalized, delta, before: beforeValue, after: afterValue, verified: false, changed: afterValue !== beforeValue, reason: 'the row moved after the action, so the counters are not comparable' }
  }
  const moved = afterValue - beforeValue
  return {
    key: normalized,
    delta,
    before: beforeValue,
    after: afterValue,
    verified: moved === delta,
    changed: moved !== 0,
    ...(moved === delta ? {} : { reason: `the counter moved by ${moved}, not the expected ${delta > 0 ? '+' : ''}${delta}` }),
  }
}
