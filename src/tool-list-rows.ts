/**
 * List/feed row tools (WP63): `ios_sim_ui_rows` and `ios_sim_tap_row`.
 *
 * List/feed apps aggregate each item into ONE accessibility element whose
 * label carries the whole summary and all its counters ("57 回复。18 喜欢。
 * 592 次查看") — there are NO per-control child buttons to match, and the
 * row elements themselves only appear at a DEEP snapshot depth (measured on
 * a physical device: max_depth 60, ~476 KB / 13–22 s per snapshot; at the
 * default depth the cells are simply not there).
 *
 * `ios_sim_ui_rows` turns that deep tree into rows: index, frame, the
 * aggregated label, and the counters parsed GENERICALLY from the label
 * (number + classifier token, 中文/English; no app vocabulary is hardcoded —
 * see list-rows.ts).
 * `ios_sim_tap_row` taps at a RELATIVE position inside row N (fractions of
 * the row frame) instead of guessing absolute screen coordinates, and can
 * verify the action the only reliable way a list app offers: the target
 * counter moving the expected ±1 (`expect_count`).
 *
 * Real-device safety gate (WP63): a tap is planned from a FRESH tree read,
 * an out-of-range row index fails instead of clamping, a `expect_count` key
 * that the row's counters do not contain is refused BEFORE any tap (that is
 * exactly the probe-click failure mode on a real account), and verification
 * reports unverified-with-reason instead of guessing.
 *
 * @module @zseven-w/dsh-ios/tool-list-rows
 */

import {
  defineTool,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import type { SimHostController } from './sim-host.js'
import {
  describeUi,
  ensureAxeBinary,
  execAxe,
  type AxeElement,
} from './uitree-backend.js'
import {
  hasLabeledNode,
  OCR_FALLBACK_HINT,
  wdaTree,
  type TreeSample,
} from './tool-uitree.js'
import {
  ensureWdaRunning,
  realDeviceSummary,
  resolveToolTarget,
  type RealDeviceResolution,
  type SimDeviceInfo,
  type ToolTarget,
  type WdaToolBackend,
} from './tools.js'
import {
  getRealDevice,
  matchesRealDevice,
} from './devicectl.js'
import {
  detectListRows,
  planRowTap,
  requireCountKey,
  sanitizeCountDelta,
  verifyCountChange,
  type CountCheckResult,
  type ListRow,
} from './list-rows.js'

/** Registered list-row tool names, in registration order. */
export const IOS_ROW_TOOL_NAMES = ['ios_sim_ui_rows', 'ios_sim_tap_row'] as const

/**
 * Snapshot depth the row tools sample at by default on a physical device.
 * Measured: feed rows are aggregated cells that only surface at max_depth 60
 * (~476 KB / 13–22 s per snapshot, WDA serves requests serially). The
 * default is therefore the deep one — the row tools exist for the screens
 * that NEED depth — and the tool descriptions state the cost so the model
 * keeps cheap observers first.
 */
export const ROW_SNAPSHOT_DEPTH = 60

/** Settle delay before the post-action verification re-read. */
const TAP_VERIFY_SETTLE_MS = 800

/** Error prefix required on non-macOS hosts. */
const SIMULATOR_UNAVAILABLE = 'iOS Simulator requires macOS with Xcode'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded
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

function renderJson(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
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

const frameSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
    w: { type: 'number', required: true },
    h: { type: 'number', required: true },
  },
} as const

const rowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', required: true },
    type: { type: 'string', required: true },
    frame: { ...frameSchema, required: true },
    label: { type: 'string' },
    counts: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          value: { type: 'number', required: true },
        },
      },
    },
    group: { type: 'integer' },
  },
} as const

/** Guard: row tools need macOS (the AXe helper also enforces this). */
function assertMacHost(): void {
  if (process.platform !== 'darwin') {
    throw new Error(`${SIMULATOR_UNAVAILABLE} — this host runs ${process.platform}, so no simulator tools can run here`)
  }
}

/** Resolve the AXe helper or throw the explanatory degradation error. */
async function requireAxeBinary(toolName: string) {
  const binary = await ensureAxeBinary()
  if (!binary.available) {
    throw new Error(
      `${toolName}: the AXe accessibility helper is unavailable`
      + `${binary.reason === undefined ? '' : ` (${binary.reason})`}; ${binary.installHint}`,
    )
  }
  return binary
}

/** One tree sample plus the point size, whatever backend took it. */
interface RowTreeSample extends TreeSample {
  roots: AxeElement[]
  size: { width: number; height: number }
  device: SimDeviceInfo
}

/** One backend-neutral deep tree read for the row tools (no re-resolution). */
async function readTreeForTarget(
  tool: string,
  target: ToolTarget,
  wda: WdaToolBackend | undefined,
  maxDepth: number | undefined,
  signal?: AbortSignal,
): Promise<RowTreeSample> {
  if (target.kind === 'real') {
    await ensureWdaRunning(tool, wda!, target.device)
    const sample = await wdaTree(wda!, target.device, maxDepth ?? ROW_SNAPSHOT_DEPTH)
    let size = screenSize(sample.roots)
    try {
      size = await wda!.control.windowSize()
    } catch {
      // screenSize(roots) fallback stays.
    }
    return {
      ...sample,
      roots: sample.roots,
      size,
      device: realDeviceSummary(target.device),
    }
  }
  const binary = await requireAxeBinary(tool)
  let roots: AxeElement[]
  try {
    roots = await describeUi(binary, target.device.udid, signal)
  } catch (error) {
    throw new Error(`${tool}: could not read the accessibility tree of ${target.device.name} (${target.device.udid}): ${errorMessage(error)}`)
  }
  return {
    roots,
    size: screenSize(roots),
    device: { udid: target.device.udid, name: target.device.name, runtime: target.device.runtime, state: target.device.state },
  }
}

/** Compact output copy of one detected row (the output-schema shape). */
function toOutputRow(row: ListRow): {
  index: number
  type: string
  frame: { x: number; y: number; w: number; h: number }
  label?: string
  counts: Array<{ key: string; value: number }>
  group?: number
} {
  return {
    index: row.index,
    type: row.type,
    frame: { x: row.frame.x, y: row.frame.y, w: row.frame.w, h: row.frame.h },
    ...(row.label === undefined ? {} : { label: row.label }),
    counts: row.counts.map(count => ({ key: count.key, value: round2(count.value) })),
    ...(row.group === undefined ? {} : { group: row.group }),
  }
}

/** One row in the output schema (shared by both tools). */
export type SimRowOutput = ReturnType<typeof toOutputRow>

/** No-rows guidance, calibrated to the WP63 three cases: depth, filter, or
 * genuinely nothing — never a blanket "the app has no accessibility" claim
 * from a shallow read. */
function noRowsHint(sample: RowTreeSample): string {
  const depthPart = sample.sampledDepth
  if (depthPart !== undefined && depthPart < ROW_SNAPSHOT_DEPTH) {
    // Case (a): depth insufficient. Rows are deep cells; a shallow snapshot
    // saying "no rows" is a property of the DEPTH, not of the app.
    return `No rows found at the depth sampled (${depthPart}) — list/feed rows are aggregated cells that typically only appear at depth ${ROW_SNAPSHOT_DEPTH} or deeper. Re-run with max_depth=${ROW_SNAPSHOT_DEPTH} (or higher) before concluding the screen has no rows.`
  }
  if (!hasLabeledNode(sample.roots)) {
    // Case (c): a DEEP sample with no labeled elements at all. Only now is an
    // absence of accessibility information a fair reading.
    return OCR_FALLBACK_HINT
  }
  // Case (b)/neutral: a deep tree WITH labels but no repeated isomorphic rows
  // — a property of this screen (a detail page, a form), not of the app.
  return 'No repeated rows detected in a DEEP tree: the current screen may not be a scrollable list, '
    + 'or its rows use a shape this pass does not recognize. The labeled elements are still in '
    + 'ios_sim_ui_tree — drive those with ios_sim_tap_element instead.'
}

export interface SimUiRowsResult {
  device: SimDeviceInfo
  size: { width: number; height: number }
  rowCount: number
  repeatedGroups: number
  omittedOffscreen: number
  sampledDepth?: number
  deepened?: boolean
  depthsTried?: number[]
  rows: SimRowOutput[]
  hint?: string
  note?: string
}

export interface SimTapRowResult {
  action: 'tap-row'
  row: SimRowOutput
  /** Relative position inside the row frame (0..1) that was tapped. */
  inRow: { x: number; y: number }
  /** Absolute tap point in device points. */
  tap: { x: number; y: number }
  device: SimDeviceInfo
  sampledDepth?: number
  deepened?: boolean
  depthsTried?: number[]
  /** Count-change verification, when expect_count was given. */
  countCheck?: CountCheckResult
  note?: string
}

export interface SimRowToolsOptions {
  wda?: WdaToolBackend
  realDevices?: RealDeviceResolution
}

export interface SimRowTools {
  iosSimUiRows: ToolDefinition
  iosSimTapRow: ToolDefinition
}

/** Create the two `ios_sim_ui_rows` / `ios_sim_tap_row` tool definitions. */
export function createSimRowTools(host: SimHostController, options: SimRowToolsOptions = {}): SimRowTools {
  const wda = options.wda
  const realDevices: RealDeviceResolution = options.realDevices ?? { matches: matchesRealDevice, resolve: getRealDevice }

  const iosSimUiRows = defineTool({
    name: 'ios_sim_ui_rows',
    description: 'Read the visible list/feed rows of the frontmost app as ROWS instead of a raw tree: '
      + 'each row (index, frame in points, aggregated label, and the counters parsed out of that label — '
      + 'number + classifier, e.g. "57 回复" → 回复=57, in 中文 or English) on a booted iOS Simulator (AXe) '
      + 'or a USB-connected physical iOS device (WebDriverAgent; pass its udid from ios_sim_devices.realDevices). '
      + 'List apps aggregate one whole item into a single Cell whose label carries the summary AND its counters; '
      + 'the per-control buttons are NOT child elements, so ios_sim_tap_row taps INSIDE a row at a relative '
      + 'position (see its expect_count). Rows only surface at a DEEP snapshot: on a physical device the default '
      + 'max_depth is 60, which costs ~15–25 s / ~0.5 MB per call (WDA serves requests serially) — keep cheap '
      + 'observers (ios_sim_find_text / ios_sim_ui_tree) first and reach for this tool only for list work. '
      + 'Counters are parsed heuristically from labels: keys round-trip, so pass a key EXACTLY as returned to '
      + 'ios_sim_tap_row.expect_count. When no rows are found the result says WHY (depth too shallow / this is '
      + 'not a list screen / genuinely no accessibility information after a DEEP read) — a shallow read is never '
      + 'reported as "the app has no accessibility information". Off-screen rows are excluded and counted as '
      + 'omittedOffscreen.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name, or a physical-device udid/name from '
          + 'ios_sim_devices.realDevices (WebDriverAgent must be running for the device). Defaults to '
          + 'the currently streamed device, else the first booted simulator.',
      },
      max_depth: {
        type: 'integer',
        description: `Maximum WebDriverAgent snapshotMaxDepth on a physical device (default ${ROW_SNAPSHOT_DEPTH} — list rows only surface that deep; each snapshot costs ~15–25 s). Simulators always read the full tree, so max_depth is ignored there.`,
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
          rowCount: { type: 'integer', required: true },
          repeatedGroups: { type: 'integer', required: true },
          omittedOffscreen: { type: 'integer', required: true },
          sampledDepth: { type: 'integer' },
          deepened: { type: 'boolean' },
          depthsTried: { type: 'array', items: { type: 'integer' } },
          rows: { type: 'array', required: true, items: rowSchema },
          hint: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: renderJson,
    },
    timeoutMs: 420_000,
    isConcurrencySafe: () => true,
    async execute(args: { udid?: string; max_depth?: number }, exec) {
      assertMacHost()
      const target = await resolveToolTarget(host, wda, realDevices, args.udid, exec.signal)
      const sample = await readTreeForTarget('ios_sim_ui_rows', target, wda, args.max_depth, exec.signal)
      const detected = detectListRows(sample.roots, { bounds: sample.size })
      const rows = detected.rows.map(toOutputRow)
      return {
        device: sample.device,
        size: sample.size,
        rowCount: detected.rows.length,
        repeatedGroups: detected.repeatedGroups,
        omittedOffscreen: detected.omittedOffscreen,
        ...(sample.sampledDepth === undefined ? {} : { sampledDepth: sample.sampledDepth }),
        ...(sample.deepened === true ? { deepened: true } : {}),
        ...(sample.depthsTried === undefined ? {} : { depthsTried: sample.depthsTried }),
        rows,
        ...(rows.length === 0 ? { hint: noRowsHint(sample) } : {}),
        note: 'Counters are parsed heuristically from row labels (number + classifier token); '
          + 'keys round-trip — pass a key exactly as listed to ios_sim_tap_row.expect_count.',
      } satisfies SimUiRowsResult
    },
    presentCall: (args: { udid?: string }) => ({
      card: 'generic',
      title: args.udid === undefined ? 'Read list rows' : `Read list rows of ${args.udid}`,
      kind: 'execute',
    }),
  })

  const iosSimTapRow = defineTool({
    name: 'ios_sim_tap_row',
    description: 'Tap at a RELATIVE position inside one visible list row (reported by ios_sim_ui_rows: a '
      + '0-based row index, x/y as fractions of that row\'s frame — 0 = left/top edge, 1 = right/bottom — '
      + 'default 0.5 = row center) on a booted iOS Simulator (AXe) or a USB-connected physical iOS device '
      + '(WebDriverAgent; pass its udid). This is the list-app way to reach per-item controls that are NOT '
      + 'separate accessibility elements (icon-only like/bookmark buttons live inside the row): the row frame '
      + 'comes from a FRESH tree read, so no absolute screen coordinates are guessed. Safety gate: the row is '
      + 're-located in the current tree and an out-of-range index FAILS (never clamps); a tap on a REAL device '
      + 'has real consequences — with expect_count={key,delta} the tool verifies the action by re-reading the '
      + 'row label and checking the counter moved exactly delta (+1 or -1); if the key is not among the row\'s '
      + 'parsed counters the tap is REFUSED before it happens (never probe a control to discover what it does). '
      + 'Without expect_count the tap still happens (an explicit row-relative position IS the identification) '
      + 'but nothing is verified — prefer expect_count whenever the row label carries counters. On a physical '
      + 'device each deep snapshot costs ~15–25 s (max_depth 60 by default). The verified count change is the '
      + 'confirmation — do not screenshot-and-compare pixels.',
    parameters: {
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name, or a physical-device udid/name from '
          + 'ios_sim_devices.realDevices (WebDriverAgent must be running for the device). Defaults to '
          + 'the currently streamed device, else the first booted simulator.',
      },
      row: {
        type: 'integer',
        required: true,
        description: '0-based row index exactly as reported by ios_sim_ui_rows. Out-of-range FAILS — re-run '
          + 'ios_sim_ui_rows, never tap a remembered position.',
      },
      x: {
        type: 'number',
        description: 'Horizontal position inside the row frame as a fraction 0..1 (0 = left edge, 1 = right '
          + 'edge). Default 0.5 (center). E.g. a right-side action button is often near 0.9.',
      },
      y: {
        type: 'number',
        description: 'Vertical position inside the row frame as a fraction 0..1 (0 = top, 1 = bottom). '
          + 'Default 0.5 (center).',
      },
      max_depth: {
        type: 'integer',
        description: `Maximum WebDriverAgent snapshotMaxDepth on a physical device (default ${ROW_SNAPSHOT_DEPTH} — rows only surface that deep). Simulators read the full tree.`,
      },
      expect_count: {
        type: 'object',
        additionalProperties: false,
        description: 'Verify the action by the target counter moving exactly delta: {key: "<counter key from '
          + 'ios_sim_ui_rows.counts>", delta: +1 | -1}. After the tap the row label is re-read and the check '
          + 'is reported as countCheck.verified — the only reliable confirmation a list app offers. The tap is '
          + 'REFUSED before it happens when key is not among the row\'s parsed counters (an unidentifiable '
          + 'control is never probed).',
        properties: {
          key: { type: 'string', required: true, description: 'Counter key exactly as ios_sim_ui_rows listed it.' },
          delta: { type: 'integer', required: true, description: 'Expected change: +1 or -1 (a single toggle).' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, const: 'tap-row' },
          row: { ...rowSchema, required: true },
          inRow: {
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
          device: { ...deviceSchema, required: true },
          sampledDepth: { type: 'integer' },
          deepened: { type: 'boolean' },
          depthsTried: { type: 'array', items: { type: 'integer' } },
          countCheck: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string', required: true },
              delta: { type: 'integer', required: true },
              before: { type: 'number' },
              after: { type: 'number' },
              verified: { type: 'boolean', required: true },
              changed: { type: 'boolean', required: true },
              reason: { type: 'string' },
            },
          },
          note: { type: 'string' },
        },
      },
      render: renderJson,
    },
    timeoutMs: 420_000,
    async execute(args: {
      udid?: string
      row: number
      x?: number
      y?: number
      max_depth?: number
      expect_count?: { key: string; delta: number }
    }, exec) {
      assertMacHost()
      if (!Number.isInteger(args.row) || args.row < 0) {
        throw new Error('ios_sim_tap_row: row must be a 0-based row index from ios_sim_ui_rows (an integer >= 0)')
      }
      const fractionX = args.x ?? 0.5
      const fractionY = args.y ?? 0.5
      const expectation = args.expect_count === undefined
        ? undefined
        : {
            key: (args.expect_count.key ?? '').trim(),
            delta: sanitizeCountDelta(args.expect_count.delta ?? 0),
          }
      if (expectation !== undefined && expectation.key === '') {
        throw new Error('ios_sim_tap_row: expect_count.key is required (the counter key exactly as ios_sim_ui_rows listed it)')
      }
      const target = await resolveToolTarget(host, wda, realDevices, args.udid, exec.signal)
      const sample = await readTreeForTarget('ios_sim_tap_row', target, wda, args.max_depth, exec.signal)
      const beforeRows = detectListRows(sample.roots, { bounds: sample.size }).rows
      const plan = planRowTap(beforeRows, args.row, fractionX, fractionY, sample.size)
      const beforeValue = expectation === undefined ? undefined : requireCountKey(plan.row, expectation.key)

      // Tap the FRESH frame — the row was just re-located in the current tree.
      if (target.kind === 'real') {
        try {
          await wda!.control.tap(plan.tap.x, plan.tap.y)
        } catch (error) {
          throw new Error(`ios_sim_tap_row: WebDriverAgent tap at (${plan.tap.x}, ${plan.tap.y}) failed: ${errorMessage(error)}`)
        }
      } else {
        const binary = await requireAxeBinary('ios_sim_tap_row')
        try {
          await execAxe(binary, ['tap', '-x', String(plan.tap.x), '-y', String(plan.tap.y), '--udid', target.device.udid], 60_000, exec.signal)
        } catch (error) {
          throw new Error(`ios_sim_tap_row: AXe tap at (${plan.tap.x}, ${plan.tap.y}) failed: ${errorMessage(error)}`)
        }
      }

      let countCheck: CountCheckResult | undefined
      if (expectation !== undefined) {
        await sleep(TAP_VERIFY_SETTLE_MS)
        const afterSample = await readTreeForTarget('ios_sim_tap_row', target, wda, args.max_depth, exec.signal)
        const afterRows = detectListRows(afterSample.roots, { bounds: afterSample.size }).rows
        const afterRow = afterRows.find(row => row.index === plan.row.index)
        countCheck = afterRow === undefined
          ? {
              key: expectation.key,
              delta: expectation.delta,
              before: beforeValue,
              verified: false,
              changed: false,
              reason: 'the re-read tree no longer contains the row (the screen changed)',
            }
          : verifyCountChange(plan.row, afterRow, expectation.key, expectation.delta)
      }

      return {
        action: 'tap-row',
        row: toOutputRow(plan.row),
        inRow: plan.inRow,
        tap: plan.tap,
        device: sample.device,
        ...(sample.sampledDepth === undefined ? {} : { sampledDepth: sample.sampledDepth }),
        ...(sample.deepened === true ? { deepened: true } : {}),
        ...(sample.depthsTried === undefined ? {} : { depthsTried: sample.depthsTried }),
        ...(countCheck === undefined ? {} : { countCheck }),
        ...(expectation === undefined
          ? { note: 'No expect_count was given, so nothing was verified — re-run ios_sim_ui_rows and compare the row counters if confirmation matters.' }
          : {}),
      } satisfies SimTapRowResult
    },
    presentCall: (args: { row: number; x?: number; y?: number }) => ({
      card: 'generic',
      title: `Tap row ${args.row} of list`,
      kind: 'execute',
      rawInput: {
        row: args.row,
        x: args.x ?? 0.5,
        y: args.y ?? 0.5,
      },
    }),
  })

  return { iosSimUiRows, iosSimTapRow }
}
