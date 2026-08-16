/**
 * Live simulator stream card (`ios_sim_boot`).
 *
 * Since the simulator display moved to the persistent right-side panel, this
 * card no longer renders any imagery: the conversation stream shows a compact
 * one-line summary (tool title, device name, status badge, "open in sidebar"
 * affordance) and clicking the row opens the panel via the existing row-click
 * trigger (see sim-panel-trigger.ts). `SimLiveFrame` stays exclusively for
 * the panel surface.
 *
 * While settled with a parseable `sim-stream` meta, the card still registers
 * its result as an openable source for the simulator panel.
 */

import { useMemo } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import {
  type SimFetcher,
  type SimWsFactory,
} from './protocol.js'
import { resolveSimMeta, type SimMetaSource } from './sim-meta-hydrate.js'
import { simCopy, type SimLocale } from './copy.js'
import { simResultTextOf } from './sim-result.js'
import { CARD_STYLES } from './card-styles.js'
import { useSimPanelSource, type SimulatorPanelSource } from './sim-panel-trigger.js'

/** Injectable surfaces every card accepts (tests, headless hosts). */
export interface SimCardOptions {
  fetcher?: SimFetcher
  wsFactory?: SimWsFactory
  colorScheme?: 'light' | 'dark'
  locale?: string
}

/**
 * Shared compact card chrome: a one-line-ish head with the tool title, the
 * device name, a status badge and the non-interactive "open in sidebar"
 * affordance (the row click itself opens the panel, so the cue never
 * swallows the gesture), plus an optional slim body for state copy/meta.
 */
export function simCardChrome({
  title,
  actionLabel,
  actionId,
  deviceLabel,
  badge,
  dataState,
  toolName,
  locale,
  openable,
  children,
  metaSource,
}: {
  title: string
  /** Small secondary action sub-label right after the title (启动/截图/交互/
   * 构建运行 · Boot/Screenshot/Interact/Build & Run). */
  actionLabel?: string
  /** Stable action id for the `data-sim-card-action` marker. */
  actionId?: string
  deviceLabel?: string
  badge?: React.ReactNode
  dataState: 'running' | 'live' | 'fallback' | 'error'
  toolName: string
  locale: SimLocale
  openable: boolean
  children?: React.ReactNode
  /** Origin of the card's meta; rendered as a data attr for debuggability. */
  metaSource?: SimMetaSource
}): React.JSX.Element {
  const copy = simCopy(locale)
  return (
    <section
      style={CARD_STYLES.card}
      data-tool={toolName}
      data-state={dataState}
      data-sim-card-kind="compact"
      {...(metaSource === undefined ? {} : { 'data-sim-meta-source': metaSource })}
    >
      <div style={CARD_STYLES.head}>
        <span style={CARD_STYLES.title}>{title}</span>
        {actionLabel !== undefined && actionLabel !== '' ? (
          <span style={CARD_STYLES.action} data-sim-card-action={actionId ?? 'action'}>{actionLabel}</span>
        ) : null}
        {deviceLabel !== undefined && deviceLabel !== '' ? (
          <span style={CARD_STYLES.headDevice}>{deviceLabel}</span>
        ) : null}
        {badge}
        {openable ? (
          <span style={CARD_STYLES.openInPanel} aria-hidden="true">
            <span aria-hidden="true">⤢</span>
            {copy.openInPanel}
          </span>
        ) : null}
      </div>
      {children !== undefined ? <div style={CARD_STYLES.body}>{children}</div> : null}
    </section>
  )
}

/** Compact device label: the human name, falling back to the udid. */
function deviceLabelOf(device: { udid?: string; name?: string } | undefined): string {
  if (device?.name !== undefined && device.name !== '') return device.name
  if (device?.udid !== undefined && device.udid !== '') return device.udid
  return ''
}

/**
 * Conversation card for `ios_sim_boot`. Running → "booting" state; settled
 * with the `sim-stream` meta → the compact live summary; anything else → a
 * defensive fallback that never throws. No `<img>`, no live frame: the
 * simulator display lives in the sidebar panel only.
 */
export function SimStreamCard(props: ToolCallViewProps & SimCardOptions): React.JSX.Element {
  const { block, toolName, callId, sessionId } = props
  const copy = simCopy(props.locale)
  const locale = props.locale === 'zh' ? 'zh' : 'en'
  const settled = 'kind' in block
  const error = settled && block.isError
  const resolved = settled && !error ? resolveSimMeta(toolName, block) : undefined
  const streamMeta = resolved?.meta.kind === 'sim-stream' ? resolved.meta : undefined
  const metaSource = streamMeta === undefined || resolved?.source !== 'hydrated' ? undefined : 'hydrated'
  const text = simResultTextOf(block)
  const panelSource = useMemo<SimulatorPanelSource | undefined>(() => streamMeta === undefined ? undefined : ({
    sessionId: String(sessionId ?? ''),
    callId,
    toolName,
    block,
  }), [block, callId, sessionId, streamMeta, toolName])
  useSimPanelSource(streamMeta !== undefined, panelSource)

  if (!settled) {
    return simCardChrome({
      title: copy.simulator,
      actionLabel: copy.actionBoot,
      actionId: 'boot',
      dataState: 'running',
      toolName,
      locale,
      openable: false,
      badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeRunning }}>{copy.booting}</span>,
      children: <div style={CARD_STYLES.loading} role="status"><span style={CARD_STYLES.muted}>{copy.booting}</span></div>,
    })
  }
  if (error) {
    return simCardChrome({
      title: copy.simulator,
      actionLabel: copy.actionBoot,
      actionId: 'boot',
      dataState: 'error',
      toolName,
      locale,
      openable: false,
      badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeError }}>{copy.unavailable}</span>,
      children: <p style={CARD_STYLES.muted}>{text ?? copy.toolFailed}</p>,
    })
  }
  if (streamMeta === undefined) {
    return simCardChrome({
      title: copy.simulator,
      actionLabel: copy.actionBoot,
      actionId: 'boot',
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
  return simCardChrome({
    title: copy.simulator,
    actionLabel: copy.actionBoot,
    actionId: 'boot',
    deviceLabel: deviceLabelOf(streamMeta.device),
    dataState: 'live',
    toolName,
    locale,
    openable: true,
    metaSource,
    badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeOk }}>{copy.live}</span>,
  })
}
