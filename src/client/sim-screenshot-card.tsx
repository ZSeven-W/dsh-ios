/**
 * Screenshot card (`ios_sim_screenshot` and `ios_sim_interact`).
 *
 * The simulator display moved to the persistent right-side panel, so the
 * card no longer grants/renders the PNG inline: it renders the shared compact
 * one-line summary (tool title, device name, 完成 badge, "open in sidebar"
 * affordance) plus the durable caption's byte size/dimensions and the
 * 打开截图 (openFile) link. Clicking the row still opens the panel via the
 * row-click trigger. Settled meta-carrying results register as openable
 * sources for the panel, exactly as before.
 */

import { useMemo } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import {
  type SimScreenshotMeta,
} from './protocol.js'
import { resolveSimMeta } from './sim-meta-hydrate.js'
import { formatBytes, simCopy } from './copy.js'
import { simResultSummaryOf, simResultTextOf } from './sim-result.js'
import { CARD_STYLES } from './card-styles.js'
import type { SimCardOptions } from './sim-stream-card.js'
import { simCardChrome } from './sim-stream-card.js'
import { useSimPanelSource, type SimulatorPanelSource } from './sim-panel-trigger.js'

function deviceCaption(meta: SimScreenshotMeta): string {
  if (meta.device.name !== undefined && meta.device.name !== '') return meta.device.name
  if (meta.device.udid !== undefined && meta.device.udid !== '') return meta.device.udid
  return ''
}

/** Compact caption: byte size + pixel dimensions (the head carries the device). */
function screenshotCaption(bytes: number | undefined, width: number | undefined, height: number | undefined): React.ReactNode {
  const parts: React.ReactNode[] = []
  const size = formatBytes(bytes)
  if (size !== undefined) parts.push(size)
  if (width !== undefined && height !== undefined) parts.push(`${width}×${height}`)
  if (parts.length === 0) return null
  return parts.map((part, index) => (
    <span key={index}>{part}</span>
  ))
}

/**
 * Conversation card for `ios_sim_screenshot` / `ios_sim_interact`. Compact
 * summary row with the openFile (打开截图) link; never renders an `<img>`
 * and never throws.
 */
export function SimScreenshotCard(props: ToolCallViewProps & SimCardOptions): React.JSX.Element {
  const { block, toolName, openFile, callId, sessionId } = props
  const copy = simCopy(props.locale)
  const locale = props.locale === 'zh' ? 'zh' : 'en'
  const isInteract = toolName === 'ios_sim_interact'
  // The unified title is always "iOS 模拟器" / "iOS Simulator"; the action
  // sub-label (截图/交互 · Screenshot/Interact) keeps the card distinguishable.
  const actionLabel = isInteract ? copy.actionInteract : copy.actionScreenshot
  const actionId = isInteract ? 'interact' : 'screenshot'
  const settled = 'kind' in block
  const error = settled && block.isError
  const resolved = settled && !error ? resolveSimMeta(toolName, block) : undefined
  const screenshotMeta = resolved?.meta.kind === 'sim-screenshot' ? resolved.meta : undefined
  const metaSource = screenshotMeta === undefined || resolved?.source !== 'hydrated' ? undefined : 'hydrated'
  const summary = simResultSummaryOf(block)
  const text = simResultTextOf(block)
  const panelSource = useMemo<SimulatorPanelSource | undefined>(() => screenshotMeta === undefined ? undefined : ({
    sessionId: String(sessionId ?? ''),
    callId,
    toolName,
    block,
  }), [block, callId, sessionId, screenshotMeta, toolName])
  useSimPanelSource(screenshotMeta !== undefined, panelSource)

  if (!settled) {
    return simCardChrome({
      title: copy.simulator,
      actionLabel,
      actionId,
      dataState: 'running',
      toolName,
      locale,
      openable: false,
      badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeRunning }}>{copy.done}</span>,
      children: (
        <div style={CARD_STYLES.loading} role="status">
          <span style={CARD_STYLES.muted}>{isInteract ? copy.interacting : copy.captureScreenshot}</span>
        </div>
      ),
    })
  }
  if (error) {
    return simCardChrome({
      title: copy.simulator,
      actionLabel,
      actionId,
      dataState: 'error',
      toolName,
      locale,
      openable: false,
      badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeError }}>{copy.unavailable}</span>,
      children: <p style={CARD_STYLES.muted}>{text ?? copy.toolFailed}</p>,
    })
  }
  if (screenshotMeta === undefined) {
    return simCardChrome({
      title: copy.simulator,
      actionLabel,
      actionId,
      dataState: 'fallback',
      toolName,
      locale,
      openable: false,
      badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeError }}>{copy.unavailable}</span>,
      children: (
        <>
          <p style={CARD_STYLES.muted}>{copy.noPreview}</p>
          {text !== null ? <pre style={{ ...CARD_STYLES.pre, marginTop: 8 }}>{text}</pre> : null}
        </>
      ),
    })
  }
  const caption = screenshotCaption(summary?.bytes, summary?.width, summary?.height)
  return simCardChrome({
    title: copy.simulator,
    actionLabel,
    actionId,
    deviceLabel: deviceCaption(screenshotMeta),
    dataState: 'live',
    toolName,
    locale,
    openable: true,
    metaSource,
    badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeOk }}>{copy.done}</span>,
    children: caption !== null || openFile !== undefined ? (
      <div style={CARD_STYLES.meta}>
        {caption}
        {openFile !== undefined ? (
          <button type="button" style={CARD_STYLES.button} onClick={() => { openFile(screenshotMeta.path) }}>
            {copy.openScreenshot}
          </button>
        ) : null}
      </div>
    ) : undefined,
  })
}
