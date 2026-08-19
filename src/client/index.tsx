/**
 * Browser presentation for the dsh-ios simulator tools.
 *
 * Registers `tool.call.toolview` slots for the four tools that emit visual
 * presentationMeta (`ios_sim_boot`, `ios_sim_screenshot`, `ios_sim_interact`,
 * `ios_sim_build_run`); `ios_sim_devices`/`ios_sim_shutdown` keep the default
 * generic card. Each registered view is wrapped in an error boundary so a
 * throwing slot component never takes down the conversation, and theme/locale
 * are synced through the host services exactly like dsh-openpencil.
 *
 * The simulator display lives ONLY in the persistent right-side panel
 * (Codex-style): the per-tool `tool.details.toolview` details seat is
 * registered through the same `ctx.slots.inject` guard dsh-openpencil uses,
 * so a future DSH runtime that declares it gets the native details surface
 * for free. The installed rc.6 runtime does NOT declare that seat (its
 * details column is the single-occupant `conversation.details.tool`), so on
 * rc.6 the plugin mounts its own page-owned right panel host (openpencil's
 * fallback-workbench mechanism) and opens it when the user clicks a
 * simulator tool row. The row-click trigger steps aside if the details seat
 * ever gets declared. Inline tool cards are compact one-line summaries
 * (title, device, badge, "open in sidebar" cue) with NO imagery.
 *
 * A stream-status capsule is registered in the `conversation.input.dock`
 * slot (openpencil's selection-chip seat): while the panel is closed and a
 * simulator stream is online it renders a small pill above the input box
 * that opens the panel for the streamed device.
 *
 * Nested Code Mode (PTC) calls never carry `presentationMeta` (the harness
 * projects it only for top-level calls). The cards and the panel instead
 * reconstruct the identical meta from the settled result's durable JSON text
 * via `sim-meta-hydrate.ts`; standard-mode sessions are untouched.
 */

import { useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { SimCardBoundary } from './card-boundary.js'
import { SimStreamCard, type SimCardOptions } from './sim-stream-card.js'
import { SimScreenshotCard } from './sim-screenshot-card.js'
import { SimBuildRunCard } from './sim-build-run-card.js'
import { SimRealStartCard } from './sim-real-start-card.js'
import { IOS_SIM_CARD_TOOLS } from './protocol.js'
import { SimulatorDetailsPanel } from './sim-panel.js'
import { mountSimulatorPanelHost, type SimulatorPanelHost } from './sim-panel-host.js'
import { installSimPanelRowTrigger, type SimulatorPanelSource } from './sim-panel-trigger.js'
import { SimStatusCapsule } from './sim-status-capsule.js'
import type { CompatibleToolDetailsViewProps } from './details-compat.js'

// Re-exported so the dev-card-smoke script reuses the card's exact wire
// helpers (grant bodies, ws frame encoding) from the built bundle.
export * from './protocol.js'
export { SimCardBoundary } from './card-boundary.js'
export { SimStreamCard, simCardChrome, type SimCardOptions } from './sim-stream-card.js'
export { SimScreenshotCard } from './sim-screenshot-card.js'
export { SimBuildRunCard } from './sim-build-run-card.js'
export { SimRealStartCard } from './sim-real-start-card.js'
export { simCopy, formatBytes, type SimLocale } from './copy.js'
export { simResultSummaryOf, simResultTextOf, type SimResultSummary } from './sim-result.js'
export {
  hydrateSimMeta,
  resolveSimMeta,
  type ResolvedSimMeta,
  type SimMetaSource,
} from './sim-meta-hydrate.js'
export { useSimStream, SIM_SWITCH_SETTLE_INTERVAL_MS, SIM_SWITCH_SETTLE_ATTEMPTS, type SimSeededGrant, type SimStreamPhase, type SimStreamSession } from './sim-stream-session.js'
export {
  useSimRealSession,
  SIM_REAL_DRAG_MOVE_SAMPLE_MS,
  SIM_REAL_READY_RECHECK_INTERVAL_MS,
  SIM_REAL_START_POLL_INTERVAL_MS,
  SIM_REAL_START_POLL_CAP_MS,
  SIM_REAL_START_TERMINAL_REASONS,
  type SimRealSession,
  type SimRealSessionOptions,
  type SimRealSessionPhase,
} from './sim-real-session.js'
export { useSimScreenshot, type SimScreenshotPhase, type SimScreenshotSession } from './sim-screenshot-session.js'
export { SimLiveFrame, SimLiveFrameBody, type SimLiveFrameSessionState } from './sim-live-frame.js'
export {
  SimSelect,
  SimSelectMenu,
  SIM_SELECT_STYLES,
  SIM_SELECT_ACTIVE_BG,
  SIM_SELECT_HOVER_BG,
  SIM_SELECT_MARKER_COLORS,
  type SimSelectGroup,
  type SimSelectOption,
  type SimSelectProps,
} from './sim-select.js'
export {
  createSimDeviceSwitchController,
  simDeviceGroupsOf,
  simDeviceSelectGroupsOf,
  simRealDeviceUdidOf,
  REAL_DEVICE_VALUE_PREFIX,
  simRuntimeLabelOf,
  simSwitchedStreamMetaOf,
  SimDevicePicker,
  SimDevicePickerBody,
  SIM_DEVICE_PICKER_KEYFRAMES,
  SIM_DEVICE_PICKER_STYLES,
  type SimDeviceGroup,
  type SimDevicePickerBodyProps,
  type SimDevicePickerProps,
  type SimDeviceSwitchController,
  type SimDeviceSwitchControllerOptions,
} from './sim-device-picker.js'
export {
  SimLiveIndicator,
  SimRealDevicePanel,
  SimFollowIndicator,
  REAL_DEVICE_STYLES,
  SIM_FOLLOW_INDICATOR_STYLES,
  SimPhoneFrame,
  SimScreenshotFrame,
  SimScreenshotFrameBody,
  SimulatorDetailsPanel,
  SimulatorPanel,
  SimulatorPanelBody,
  simPanelFrameStyles,
  simToolNameOf,
  DEVICE_FRAME_STYLES,
  FRAMELESS_FRAME_STYLES,
  PANEL_LIVE_INDICATOR_STYLES,
  PANEL_STYLES,
  PHONE_BEZEL_STYLES,
  type SimPanelDisplayReport,
  type SimPanelMode,
} from './sim-panel.js'
export {
  SIM_FRAME_BEZEL_SHELL,
  SIM_FRAME_DEVICE_SHELL,
  SIM_FRAME_RADIUS_FALLBACK_PX,
  SIM_FRAME_SCREEN_RADIUS_RATIO,
  SIM_FRAME_SHELL_BORDER_PX,
  SIM_FRAME_STYLE_BEZEL,
  SIM_FRAME_STYLE_OPTIONS,
  simFrameStyleLabelOf,
  simFrameStyleOf,
  simPanelFrameBorderPxOf,
  simPanelFrameInsetOf,
  simPanelFrameRadiusFallbackOf,
  simPanelScreenBoxOf,
  simPanelScreenRadiusOf,
  simPanelScreenWidthOf,
  simPanelShellPadOf,
  simPanelShellRadiusOf,
  type SimFrameStyle,
} from './sim-frame-style.js'
export {
  SIM_DEVICE_MENU_ACTIONS,
  SIM_DEVICE_MENU_ICON_PATHS,
  SIM_DEVICE_MENU_REAL_ACTIONS,
  SIM_DEVICE_MENU_STYLES,
  SimDeviceMenu,
  simDeviceActionLabelOf,
  type SimDeviceMenuAction,
} from './sim-device-menu.js'
export {
  SIM_TOOLBAR_ACTION_IDS,
  SIM_TOOLBAR_ICON_PATHS,
  SIM_TOOLBAR_STYLES,
  SIM_TOOLBAR_TOOLTIP_DELAY_MS,
  simToolbarActionLabelOf,
  SimSizeQuickSegment,
  SimToolbarIcon,
  SimToolbarIconButton,
  SimToolbarTooltip,
  type SimToolbarActionId,
} from './sim-toolbar.js'
export {
  claimSimulatorPanelDock,
  IOS_SIM_PANEL_DOCK_ATTRIBUTE,
  type SimulatorPanelDockLease,
} from './sim-panel-dock.js'
export {
  clampSimulatorPanelWidth,
  createSimulatorPanelStore,
  mountSimulatorPanelHost,
  resizedSimulatorPanelWidth,
  simulatorPanelEffectiveWidth,
  simulatorPanelLandscapeTargetWidthOf,
  simulatorPanelOrientationIsLandscape,
  simulatorPanelRequestKey,
  simulatorPanelStore,
  simulatorPanelWidthBounds,
  simulatorPanelWidthStateInitial,
  simulatorPanelWidthStateNext,
  simSwitchedPanelRequestOf,
  SIMULATOR_PANEL_DEFAULT_WIDTH,
  SIMULATOR_PANEL_FULLSCREEN_BREAKPOINT,
  SIMULATOR_PANEL_LANDSCAPE_HEIGHT_PX,
  SIMULATOR_PANEL_LEFT_CLEARANCE,
  SIMULATOR_PANEL_MAX_WIDTH,
  SIMULATOR_PANEL_MIN_WIDTH,
  type SimulatorPanelHost,
  type SimulatorPanelRequest,
  type SimulatorPanelStore,
  type SimulatorPanelWidthAction,
  type SimulatorPanelWidthBounds,
  type SimulatorPanelWidthState,
} from './sim-panel-host.js'
export {
  installSimPanelRowTrigger,
  registerSimPanelSource,
  resolveSimPanelSource,
  hasSimPanelSourceForSession,
  simPanelClickIsInteractive,
  simPanelClickRowCallIdOf,
  simPanelSourcesSnapshot,
  simPanelSourcesVersion,
  subscribeSimPanelSources,
  useSimPanelSource,
  SIM_PANEL_INTERACTIVE_SELECTOR,
  type SimulatorPanelSource,
} from './sim-panel-trigger.js'
export {
  SIM_PANEL_AUTO_OPEN_TOOLS,
  forgetSimPanelAutoOpenCall,
  rememberSimPanelAutoOpenCall,
  simPanelAutoOpenActivatedAt,
  simPanelAutoOpenKey,
  simPanelAutoOpenShouldOpen,
  takeSimPanelAutoOpenCall,
  type SimPanelAutoOpenDecision,
} from './sim-panel-auto-open.js'
export {
  SIM_PANEL_FOLLOW_DEBOUNCE_MS,
  simFollowNewestCandidateOf,
  simFollowStateInitial,
  simFollowStateNext,
  simFollowTargetOf,
  type SimFollowAction,
  type SimFollowCandidate,
  type SimFollowDecision,
  type SimFollowPending,
  type SimFollowState,
  type SimFollowTarget,
} from './sim-panel-follow.js'
export {
  SIM_PANEL_DEVICE_SCALE,
  SIM_PANEL_FALLBACK_LOGICAL_WIDTH,
  SIM_PANEL_FALLBACK_LOGICAL_HEIGHT,
  SIM_PANEL_PERCENT_OPTIONS,
  SIM_PANEL_PRESET_OPTIONS,
  SIM_PANEL_QUICK_SIZE_OPTIONS,
  SIM_PANEL_SIZE_MODE_FIT,
  SIM_PANEL_SIZE_OPTIONS,
  simDeviceLogicalWidthOf,
  simPanelDisplayLogicalWidthOf,
  simPanelFrameBaseSizeOf,
  simPanelFrameLayoutOf,
  simPanelFrameWidthOf,
  simPanelSizeModeIdOf,
  simPanelSizeModeOf,
  simPanelSnapPxOf,
  type SimPanelPresetOption,
  type SimPanelQuickSizeOption,
  type SimPanelSizeMode,
  type SimPanelSizeOption,
} from './sim-panel-size.js'
export {
  SIM_DISPLAY_ORIENTATIONS,
  simDisplayOrientationIdOf,
  simFramebufferPointOf,
  simOrientationLayoutOf,
  type SimDisplayOrientation,
  type SimOrientationLayout,
} from './sim-orientation.js'
export {
  createSimCaptureController,
  useSimCapture,
  SIM_CAPTURE_CONFIRM_MS,
  type SimCaptureController,
  type SimCaptureControllerOptions,
  type SimCapturePhase,
  type SimCaptureSession,
  type SimCaptureTimers,
} from './sim-panel-capture.js'
export {
  SimStatusCapsule,
  SimStatusCapsuleBody,
  createSimStatusPoller,
  SIM_STATUS_POLL_MS,
  SIM_STATUS_REFRESH_DEBOUNCE_MS,
  fetchSimStreamStatus,
  simStreamStatusRequestOf,
  type SimStatusCapsuleBodyProps,
  type SimStatusCapsuleProps,
  type SimStatusFetcher,
  type SimStatusPollTimers,
} from './sim-status-capsule.js'
export type { CompatibleToolDetailsViewProps } from './details-compat.js'

/** Required client services. */
export const inject = ['slots', 'theme', 'locale']

type SimCardComponent = (props: ToolCallViewProps & SimCardOptions) => React.JSX.Element

function subscribeThemeOf(ctx: ClientContext): (notify: () => void) => (() => boolean) {
  return notify => ctx.on('theme/change', notify)
}

function getColorSchemeOf(ctx: ClientContext): () => 'light' | 'dark' {
  return () => ctx.theme.getTheme().active.colorScheme
}

function subscribeLocaleOf(ctx: ClientContext): (notify: () => void) => (() => boolean) {
  return notify => ctx.on('locale/change', notify)
}

function getLocaleOf(ctx: ClientContext): () => string {
  return () => ctx.locale.getLocale().active
}

function hostSyncedCard(
  ctx: ClientContext,
  Card: SimCardComponent,
  autoOpen?: (source: SimulatorPanelSource) => void,
): (props: ToolCallViewProps) => React.JSX.Element {
  const subscribeTheme = subscribeThemeOf(ctx)
  const getColorScheme = getColorSchemeOf(ctx)
  const subscribeLocale = subscribeLocaleOf(ctx)
  const getLocale = getLocaleOf(ctx)

  const HostSyncedCard = (props: ToolCallViewProps): React.JSX.Element => {
    const colorScheme = useSyncExternalStore(subscribeTheme, getColorScheme, getColorScheme)
    const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    return (
      <SimCardBoundary>
        <Card {...props} colorScheme={colorScheme} locale={locale} autoOpen={autoOpen} />
      </SimCardBoundary>
    )
  }
  return HostSyncedCard
}

/** Register one `tool.call.toolview` slot per tool name (openpencil shape). */
function registerCard(
  ctx: ClientContext,
  toolName: string,
  Card: SimCardComponent,
  autoOpen?: (source: SimulatorPanelSource) => void,
): void {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: toolName },
    hostSyncedCard(ctx, Card, autoOpen),
  ))
}

/** Register one per-tool `tool.details.toolview` slot (openpencil shape). */
function registerDetailsPanel(
  ctx: ClientContext,
  toolName: string,
  onDetailsSlotDeclared: () => (() => void),
): void {
  ctx.slots.inject('tool.details.toolview', () => {
    const disposeRegistration = ctx.slots.register(
      { name: 'tool.details.toolview', key: toolName },
      hostSyncedDetailsPanel(ctx),
    )
    // A declaring runtime activates the native details seat: the rc.6
    // fallback (page-owned panel + row-click trigger) steps aside. Noop on
    // rc.6, where `inject` waits forever for a slot that never appears.
    const disposeFallback = onDetailsSlotDeclared()
    return [disposeRegistration, disposeFallback]
  })
}

function hostSyncedDetailsPanel(
  ctx: ClientContext,
): (props: CompatibleToolDetailsViewProps) => React.JSX.Element {
  const subscribeTheme = subscribeThemeOf(ctx)
  const getColorScheme = getColorSchemeOf(ctx)
  const subscribeLocale = subscribeLocaleOf(ctx)
  const getLocale = getLocaleOf(ctx)

  const HostSyncedDetailsPanel = (props: CompatibleToolDetailsViewProps): React.JSX.Element => {
    const colorScheme = useSyncExternalStore(subscribeTheme, getColorScheme, getColorScheme)
    const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    return (
      <SimCardBoundary>
        <SimulatorDetailsPanel {...props} colorScheme={colorScheme} locale={locale} />
      </SimCardBoundary>
    )
  }
  return HostSyncedDetailsPanel
}

/** Cross-version minimum for the session-scoped input-dock seat. */
interface CompatibleInputDockProps {
  sessionId: string
}

function hostSyncedStatusCapsule(
  ctx: ClientContext,
): (props: CompatibleInputDockProps) => React.JSX.Element {
  const subscribeLocale = subscribeLocaleOf(ctx)
  const getLocale = getLocaleOf(ctx)
  const HostSyncedStatusCapsule = (props: CompatibleInputDockProps): React.JSX.Element => {
    const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    // The dock seat is session-scoped: the framework-resolved sessionId is
    // the capsule's gate — it renders/polls only while THIS session has
    // simulator sources registered (see sim-status-capsule.tsx).
    return <SimStatusCapsule locale={locale === 'zh' ? 'zh' : 'en'} sessionId={String(props.sessionId)} />
  }
  return HostSyncedStatusCapsule
}

const PANEL_TOOLS = [
  IOS_SIM_CARD_TOOLS.boot,
  IOS_SIM_CARD_TOOLS.buildRun,
  IOS_SIM_CARD_TOOLS.interact,
  IOS_SIM_CARD_TOOLS.screenshot,
] as const

/** Register canonical views plus the resident simulator panel surfaces. */
export function apply(ctx: ClientContext): void {
  // rc.6 fallback surface: a page-owned right panel host (openpencil's
  // fallback-workbench mechanism) opened by clicking a simulator tool row.
  // Declared up front so the START cards can be handed the auto-open callback
  // that resolves through it.
  let panelHost: SimulatorPanelHost | undefined
  let rowTriggerDispose: (() => void) | undefined
  const detailsSlotDeclared = (): boolean => ctx.slots.spec('tool.details.toolview') !== undefined

  // Auto-open: a settled START verb opens the panel once. openIfIdle (not
  // open) so a settle never replaces an already-open panel.
  const autoOpenSource = (source: SimulatorPanelSource): void => {
    panelHost?.openIfIdle(source)
  }

  registerCard(ctx, IOS_SIM_CARD_TOOLS.boot, SimStreamCard, autoOpenSource)
  registerCard(ctx, IOS_SIM_CARD_TOOLS.screenshot, SimScreenshotCard)
  registerCard(ctx, IOS_SIM_CARD_TOOLS.interact, SimScreenshotCard)
  registerCard(ctx, IOS_SIM_CARD_TOOLS.buildRun, SimBuildRunCard)
  registerCard(ctx, IOS_SIM_CARD_TOOLS.realStart, SimRealStartCard, autoOpenSource)

  const stepFallbackAside = (): (() => void) => {
    rowTriggerDispose?.()
    rowTriggerDispose = undefined
    panelHost?.close()
    return () => {}
  }

  // Per-tool details seat (Codex-style right panel). `slots.inject` waits
  // while the slot is undeclared — rc.6 never declares it, so this degrades
  // silently and the page-owned host below carries the surface instead.
  for (const toolName of PANEL_TOOLS) {
    registerDetailsPanel(ctx, toolName, stepFallbackAside)
  }

  // Stream-status capsule in the composer input dock (openpencil's
  // selection-chip seat, same `ctx.slots.inject` guard and entry shape):
  // a small pill above the input box while a stream is online and the panel
  // is closed. Clicking it opens the panel for the streamed device.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'dsh-ios-status', order: 40 },
    hostSyncedStatusCapsule(ctx),
  ))

  if (typeof document !== 'undefined') {
    ctx.effect(() => {
      panelHost = mountSimulatorPanelHost({
        subscribeTheme: subscribeThemeOf(ctx),
        getColorScheme: getColorSchemeOf(ctx),
        subscribeLocale: subscribeLocaleOf(ctx),
        getLocale: getLocaleOf(ctx),
      })
      if (!detailsSlotDeclared()) {
        rowTriggerDispose = installSimPanelRowTrigger(document, source => panelHost?.open(source) ?? false)
      }
      return () => {
        rowTriggerDispose?.()
        rowTriggerDispose = undefined
        panelHost?.dispose()
        panelHost = undefined
      }
    }, 'dsh-ios: simulator panel host')
  }
}
