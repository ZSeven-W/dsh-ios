/**
 * Defensive readers for the settled ToolResultNode behind a card. The
 * presentationMeta is the primary contract, but the durable result text still
 * carries the model-facing summary (bytes, dimensions, action) the screenshot
 * card shows as its caption.
 */

import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'

export interface SimResultSummary {
  bytes?: number
  width?: number
  height?: number
  action?: string
  path?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Parse the first JSON text content block of a settled result, if any. */
export function simResultSummaryOf(block: ToolCallBlock): SimResultSummary | undefined {
  if (!('kind' in block) || block.kind !== 'tool-result' || block.isError) return undefined
  for (const item of block.content) {
    if (item.type !== 'text') continue
    let value: unknown
    try {
      value = JSON.parse(item.text)
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    const summary: SimResultSummary = {}
    const bytes = finiteNumber(value.bytes)
    const width = finiteNumber(value.width)
    const height = finiteNumber(value.height)
    const action = optionalString(value.action)
    const path = optionalString(value.path)
    if (bytes === undefined && width === undefined && height === undefined && action === undefined && path === undefined) continue
    if (bytes !== undefined) summary.bytes = bytes
    if (width !== undefined) summary.width = width
    if (height !== undefined) summary.height = height
    if (action !== undefined) summary.action = action
    if (path !== undefined) summary.path = path
    return summary
  }
  return undefined
}

/** Join the durable result text for the fallback disclosure. */
export function simResultTextOf(block: ToolCallBlock): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name}: ${block.error.code}`)
  }
  return parts.join('\n') || null
}
