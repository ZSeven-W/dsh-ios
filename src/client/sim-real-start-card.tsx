/**
 * Conversation card for `ios_real_start_wda` (start WebDriverAgent on a
 * physical device).
 *
 * The tool projects NO presentationMeta (renderJson only), so unlike the four
 * visual sim tools there is no host-projected envelope; `resolveSimMeta`
 * reconstructs a `sim-real-start` envelope from the durable result JSON. The
 * card is deliberately minimal — its real job is to (a) register the settled
 * result as an openable panel source and (b) auto-open the panel when the
 * START verb settles, so the panel's own not-ready/progress surface shows the
 * WDA build/launch state the user asked to watch. It never renders imagery.
 */

import { useEffect, useMemo } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { resolveSimMeta } from './sim-meta-hydrate.js'
import { simCopy } from './copy.js'
import { simResultTextOf } from './sim-result.js'
import { CARD_STYLES } from './card-styles.js'
import { simCardChrome, type SimCardOptions } from './sim-stream-card.js'
import { useSimPanelSource, type SimulatorPanelSource } from './sim-panel-trigger.js'
import {
  forgetSimPanelAutoOpenCall,
  rememberSimPanelAutoOpenCall,
  simPanelAutoOpenActivatedAt,
  simPanelAutoOpenKey,
  simPanelAutoOpenShouldOpen,
  takeSimPanelAutoOpenCall,
} from './sim-panel-auto-open.js'

/** Compact device label: the human name, falling back to the udid. */
function deviceLabelOf(device: { udid?: string; name?: string } | undefined): string {
  if (device?.name !== undefined && device.name !== '') return device.name
  if (device?.udid !== undefined && device.udid !== '') return device.udid
  return ''
}

/**
 * Conversation card for `ios_real_start_wda`. Running → "starting" state;
 * settled with a hydratable `sim-real-start` meta → the compact connected
 * summary; anything else → a defensive fallback. No live frame: the real
 * device's progress/live view lives in the sidebar panel only.
 */
export function SimRealStartCard(props: ToolCallViewProps & SimCardOptions): React.JSX.Element {
  const { block, toolName, callId, sessionId, autoOpen } = props
  const copy = simCopy(props.locale)
  const locale = props.locale === 'zh' ? 'zh' : 'en'
  const settled = 'kind' in block
  const running = !settled
  const error = settled && block.isError
  const resolved = settled && !error ? resolveSimMeta(toolName, block) : undefined
  const realMeta = resolved?.meta.kind === 'sim-real-start' ? resolved.meta : undefined
  const text = simResultTextOf(block)
  const panelSource = useMemo<SimulatorPanelSource | undefined>(() => realMeta === undefined ? undefined : ({
    sessionId: String(sessionId ?? ''),
    callId,
    toolName,
    block,
  }), [block, callId, sessionId, realMeta, toolName])
  useSimPanelSource(realMeta !== undefined, panelSource)

  // Same auto-open lifecycle as the boot card: arm while the tool runs,
  // forget on error, take exactly once on settle.
  const autoOpenSessionId = String(sessionId ?? '')
  const autoOpenKey = simPanelAutoOpenKey(autoOpenSessionId, callId)
  const autoOpenBlockTime = typeof block.time === 'number' && Number.isFinite(block.time) ? block.time : 0
  useEffect(() => {
    if (running && autoOpenBlockTime >= simPanelAutoOpenActivatedAt) {
      rememberSimPanelAutoOpenCall(autoOpenKey)
    } else if (error) {
      forgetSimPanelAutoOpenCall(autoOpenKey)
    }
  }, [autoOpenBlockTime, autoOpenKey, error, running])
  useEffect(() => {
    if (running || panelSource === undefined || autoOpen === undefined) return
    if (!simPanelAutoOpenShouldOpen({
      toolName,
      isError: error,
      blockTime: autoOpenBlockTime,
      sessionId: autoOpenSessionId,
      activatedAt: simPanelAutoOpenActivatedAt,
      currentSessionId: autoOpenSessionId,
    })) return
    if (!takeSimPanelAutoOpenCall(autoOpenKey)) return
    autoOpen(panelSource)
  }, [autoOpen, autoOpenBlockTime, autoOpenKey, autoOpenSessionId, error, panelSource, running, toolName])

  if (!settled) {
    return simCardChrome({
      title: copy.realStartAction,
      actionId: 'start-wda',
      dataState: 'running',
      toolName,
      locale,
      openable: false,
      badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeRunning }}>{copy.realDeviceConnecting}</span>,
      children: <div style={CARD_STYLES.loading} role="status"><span style={CARD_STYLES.muted}>{copy.realStartProgress}</span></div>,
    })
  }
  if (error) {
    return simCardChrome({
      title: copy.realStartAction,
      actionId: 'start-wda',
      dataState: 'error',
      toolName,
      locale,
      openable: false,
      badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeError }}>{copy.unavailable}</span>,
      children: <p style={CARD_STYLES.muted}>{text ?? copy.toolFailed}</p>,
    })
  }
  if (realMeta === undefined) {
    return simCardChrome({
      title: copy.realStartAction,
      actionId: 'start-wda',
      dataState: 'fallback',
      toolName,
      locale,
      openable: false,
      badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeError }}>{copy.unavailable}</span>,
      children: <p style={CARD_STYLES.muted}>{copy.noPreview}</p>,
    })
  }
  return simCardChrome({
    title: copy.realStartAction,
    actionId: 'start-wda',
    deviceLabel: deviceLabelOf(realMeta.device),
    dataState: 'live',
    toolName,
    locale,
    openable: true,
    metaSource: resolved?.source,
    badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeOk }}>{copy.realDeviceConnected}</span>,
  })
}
