/**
 * Client-side reconstruction of the dsh-ios presentationMeta for nested Code
 * Mode (PTC) tool calls.
 *
 * DSH projects `output.presentationMeta` into a settled tool result ONLY for
 * top-level calls (harness `packages/core/tools/src/index.ts`
 * `createSuccessResult`: `exec.parent === undefined`). In Code Mode the model
 * composes tools from a TypeScript program, so every `ios_sim_*` call is a
 * nested dispatch whose client block (persisted as `tool/code-dispatch`,
 * projected by the runtime's `ToolCallTree` into a `ToolResultNode`) carries
 * the FULL durable result JSON in `content` but no `meta` — without this
 * module the cards degrade to the no-preview fallback and never register a
 * panel source, so the sidebar panel and status capsule stay dead too.
 *
 * The plugin's presentationMeta is deliberately stable and fully derivable
 * from that durable result JSON:
 * - `ios_sim_boot`       → `{ kind:'sim-stream', device, streamRouteId }`
 *   (streamRouteId = `dsh-ios/stream/<device.udid>`)
 * - `ios_sim_screenshot` → `{ kind:'sim-screenshot', screenshotPath, path,
 *   device }` from `path` + `device`
 * - `ios_sim_interact`   → the same `sim-screenshot` envelope (the host uses
 *   one shared `screenshotMeta` projector for both tools)
 * - `ios_sim_build_run`  → `{ kind:'sim-build-run', device, bundleId,
 *   appPath }`
 * - `ios_real_start_wda` → `{ kind:'sim-real-start', device }` (the tool
 *   projects NO presentationMeta, so this is the only path for the panel to
 *   adopt the phone into real-device mode and show the WDA progress surface)
 *
 * Reconstructed screenshot paths are still validated as absolute paths here;
 * the host `/grant` route re-validates every path against the plugin cache
 * directory server-side (no symlink escape, cache-only), so rebuilding meta
 * client-side changes nothing about the trust boundary. Malformed, truncated,
 * or unexpected results resolve `null` (never a throw) and the cards keep
 * today's plain fallback UI.
 *
 * @module @zseven-w/dsh-ios/client/sim-meta-hydrate
 */

import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { IOS_SIM_CARD_TOOLS, parseSimMeta, type SimDeviceInfo, type SimMeta } from './protocol.js'

/** Where a card's presentation meta came from (debuggability only). */
export type SimMetaSource = 'meta' | 'hydrated'

/** The meta a card/panel should render plus its origin. */
export interface ResolvedSimMeta {
  meta: SimMeta
  source: SimMetaSource
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The screenshot/build paths the host emits are always POSIX absolute. */
function isPosixAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/')
}

/** Non-negative finite byte count (required by every screenshot result). */
function isByteCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Interact actions the tool schema allows (distinguishes interact results). */
const INTERACT_ACTIONS = new Set(['tap', 'type', 'button', 'gesture'])

/**
 * Parse the durable result's device record. The tool schema requires all four
 * string fields; the udid is mandatory here because `streamRouteId` derives
 * from it and every grant flow addresses the device by udid.
 */
function parseDevice(value: unknown): SimDeviceInfo | undefined {
  if (!isRecord(value)) return undefined
  const udid = nonEmptyString(value.udid)
  if (udid === undefined) return undefined
  const device: SimDeviceInfo = { udid }
  const name = nonEmptyString(value.name)
  const runtime = nonEmptyString(value.runtime)
  const state = nonEmptyString(value.state)
  if (name !== undefined) device.name = name
  if (runtime !== undefined) device.runtime = runtime
  if (state !== undefined) device.state = state
  return device
}

/** `ios_sim_boot` → the exact `sim-stream` envelope the host would project. */
function hydrateStreamMeta(value: unknown): SimMeta | null {
  if (!isRecord(value) || value.state !== 'booted' || value.streaming !== true) return null
  const device = parseDevice(value.device)
  if (device === undefined) return null
  return { kind: 'sim-stream', device, streamRouteId: `dsh-ios/stream/${device.udid}` }
}

/** `ios_sim_screenshot` / `ios_sim_interact` → the `sim-screenshot` envelope. */
function hydrateScreenshotMeta(value: unknown, interact: boolean): SimMeta | null {
  if (!isRecord(value)) return null
  if (interact) {
    const action = value.action
    if (typeof action !== 'string' || !INTERACT_ACTIONS.has(action)) return null
  }
  const path = isPosixAbsolutePath(value.path) ? value.path : undefined
  if (path === undefined || !isByteCount(value.bytes)) return null
  const device = parseDevice(value.device)
  if (device === undefined) return null
  return { kind: 'sim-screenshot', screenshotPath: path, path, device }
}

/** `ios_sim_build_run` → the exact `sim-build-run` envelope. */
function hydrateBuildRunMeta(value: unknown): SimMeta | null {
  if (!isRecord(value) || value.state !== 'launched') return null
  const bundleId = nonEmptyString(value.bundleId)
  const appPath = isPosixAbsolutePath(value.appPath) ? value.appPath : undefined
  if (bundleId === undefined || appPath === undefined) return null
  const device = parseDevice(value.device)
  if (device === undefined) return null
  return { kind: 'sim-build-run', device, bundleId, appPath }
}

/**
 * `ios_real_start_wda` → the `sim-real-start` envelope. The tool has NO
 * projected presentationMeta (renderJson only), so this is the ONE path for
 * the panel to learn the phone's udid and adopt it into real-device mode.
 * `ready` must be true for a settled success (the schema pins it), which also
 * keeps an error/partial result from ever hydrating.
 */
function hydrateRealStartMeta(value: unknown): SimMeta | null {
  if (!isRecord(value) || value.ready !== true) return null
  const device = parseDevice(value.device)
  if (device === undefined) return null
  return { kind: 'sim-real-start', device }
}

/** Rebuild the meta for one settled, non-error tool result (or null). */
function hydrateSimMetaValue(toolName: string, value: Record<string, unknown>): SimMeta | null {
  if (toolName === IOS_SIM_CARD_TOOLS.boot) return hydrateStreamMeta(value)
  if (toolName === IOS_SIM_CARD_TOOLS.screenshot || toolName === IOS_SIM_CARD_TOOLS.interact) {
    return hydrateScreenshotMeta(value, toolName === IOS_SIM_CARD_TOOLS.interact)
  }
  if (toolName === IOS_SIM_CARD_TOOLS.buildRun) return hydrateBuildRunMeta(value)
  if (toolName === IOS_SIM_CARD_TOOLS.realStart) return hydrateRealStartMeta(value)
  return null
}

/**
 * Rebuild the exact presentationMeta from a settled tool result's durable
 * JSON text (the first text content block that parses as a JSON object).
 * Resolves `null` — never throws — when the result cannot be validated, in
 * which case the cards keep today's plain fallback UI.
 */
export function hydrateSimMeta(toolName: string, block: ToolCallBlock): SimMeta | null {
  if (!('kind' in block) || block.kind !== 'tool-result' || block.isError) return null
  for (const item of block.content) {
    if (item.type !== 'text') continue
    let value: unknown
    try {
      value = JSON.parse(item.text)
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    const hydrated = hydrateSimMetaValue(toolName, value)
    if (hydrated !== null) return hydrated
  }
  return null
}

/**
 * The single meta resolution every card and the simulator panel share: the
 * host-projected `presentationMeta` always wins (standard-mode sessions are
 * untouched), and a nested Code Mode result reconstructs the same meta from
 * its durable JSON text. Unsettled/error results resolve `undefined`.
 */
export function resolveSimMeta(toolName: string, block: ToolCallBlock): ResolvedSimMeta | undefined {
  if (!('kind' in block) || block.kind !== 'tool-result' || block.isError) return undefined
  const projected = parseSimMeta(block.meta)
  if (projected !== undefined) return { meta: projected, source: 'meta' }
  const hydrated = hydrateSimMeta(toolName, block)
  return hydrated === null ? undefined : { meta: hydrated, source: 'hydrated' }
}
