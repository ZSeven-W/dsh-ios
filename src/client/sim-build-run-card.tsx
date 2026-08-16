/**
 * Build & run card (`ios_sim_build_run`).
 *
 * The simulator display moved to the persistent right-side panel, so the
 * card no longer embeds the live stream. It renders the shared compact
 * summary (tool title, device name, 完成 badge, "open in sidebar"
 * affordance) with a slim meta line carrying the bundle id and the open-app
 * link; the panel's stream mode renders the live view for the device.
 * Running calls show a building state; errors and meta-less results fall
 * back to the defensive plain card. Settled results still register as
 * openable panel sources.
 */

import { useMemo } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { resolveSimMeta } from './sim-meta-hydrate.js'
import { simCopy } from './copy.js'
import { simResultTextOf } from './sim-result.js'
import { CARD_STYLES } from './card-styles.js'
import { simCardChrome, type SimCardOptions } from './sim-stream-card.js'
import { useSimPanelSource, type SimulatorPanelSource } from './sim-panel-trigger.js'

function buildRunDeviceLabel(device: { udid?: string; name?: string } | undefined): string {
  if (device?.name !== undefined && device.name !== '') return device.name
  if (device?.udid !== undefined && device.udid !== '') return device.udid
  return ''
}

export function SimBuildRunCard(props: ToolCallViewProps & SimCardOptions): React.JSX.Element {
  const { block, toolName, openFile, callId, sessionId } = props
  const copy = simCopy(props.locale)
  const locale = props.locale === 'zh' ? 'zh' : 'en'
  const settled = 'kind' in block
  const error = settled && block.isError
  const resolved = settled && !error ? resolveSimMeta(toolName, block) : undefined
  const buildMeta = resolved?.meta.kind === 'sim-build-run' ? resolved.meta : undefined
  const metaSource = buildMeta === undefined || resolved?.source !== 'hydrated' ? undefined : 'hydrated'
  const text = simResultTextOf(block)
  const panelSource = useMemo<SimulatorPanelSource | undefined>(() => buildMeta === undefined ? undefined : ({
    sessionId: String(sessionId ?? ''),
    callId,
    toolName,
    block,
  }), [block, callId, sessionId, buildMeta, toolName])
  useSimPanelSource(buildMeta !== undefined, panelSource)

  if (!settled) {
    return simCardChrome({
      title: copy.simulator,
      actionLabel: copy.actionBuildRun,
      actionId: 'build-run',
      dataState: 'running',
      toolName,
      locale,
      openable: false,
      badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeRunning }}>{copy.building}</span>,
      children: <div style={CARD_STYLES.loading} role="status"><span style={CARD_STYLES.muted}>{copy.building}</span></div>,
    })
  }
  if (error) {
    return simCardChrome({
      title: copy.simulator,
      actionLabel: copy.actionBuildRun,
      actionId: 'build-run',
      dataState: 'error',
      toolName,
      locale,
      openable: false,
      badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeError }}>{copy.unavailable}</span>,
      children: <p style={CARD_STYLES.muted}>{text ?? copy.toolFailed}</p>,
    })
  }
  if (buildMeta === undefined) {
    return simCardChrome({
      title: copy.simulator,
      actionLabel: copy.actionBuildRun,
      actionId: 'build-run',
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
  const hasMeta = buildMeta.bundleId !== undefined
    || (buildMeta.appPath !== undefined && openFile !== undefined)
  return simCardChrome({
    title: copy.simulator,
    actionLabel: copy.actionBuildRun,
    actionId: 'build-run',
    deviceLabel: buildRunDeviceLabel(buildMeta.device),
    dataState: 'live',
    toolName,
    locale,
    openable: true,
    metaSource,
    badge: <span style={{ ...CARD_STYLES.badge, ...CARD_STYLES.badgeOk }}>{copy.done}</span>,
    children: hasMeta ? (
      <>
        {buildMeta.bundleId !== undefined ? (
          <div style={CARD_STYLES.keyValue}>
            <span style={CARD_STYLES.key}>{copy.bundleId}</span>
            <span style={CARD_STYLES.value}>{buildMeta.bundleId}</span>
          </div>
        ) : null}
        {buildMeta.appPath !== undefined && openFile !== undefined ? (
          <div>
            <button type="button" style={CARD_STYLES.button} onClick={() => { openFile(buildMeta.appPath ?? '') }}>
              {copy.openApp}
            </button>
          </div>
        ) : null}
      </>
    ) : undefined,
  })
}
