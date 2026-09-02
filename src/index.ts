/**
 * @zseven-w/dsh-ios — build, run, and interact with a live iOS Simulator
 * stream inside a DeepSeek Harness conversation.
 *
 * Plugin lifecycle: one SimHostController owns the serve-sim stream for the
 * session; eight core model-facing tools (`ios_sim_devices`, `ios_sim_boot`,
 * `ios_sim_shutdown`, `ios_sim_screenshot`, `ios_sim_interact`,
 * `ios_sim_list_apps`, `ios_sim_launch_app`, `ios_sim_build_run`), the
 * explicit real-device starter (`ios_real_start_wda` — builds/launches
 * WebDriverAgent on a physical device), and the UI-tree pair
 * (`ios_sim_ui_tree`, `ios_sim_tap_element`) are registered through
 * `ctx.effect` so unloading the plugin unregisters them, and the returned
 * disposer stops the stream child and the keep-alive loop.
 *
 * On non-macOS hosts (or when serve-sim is unresolvable) the tools still
 * register but fail with a clear explanatory error — the same degradation
 * style as dsh-openpencil.
 * @module @zseven-w/dsh-ios
 */

import type { Context } from '@deepseek-ai/cordis'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import { SimHostController } from './sim-host.js'
import { WdaController } from './wda-host.js'
import { createSimTools, IOS_TOOL_NAMES } from './tools.js'
import {
  createSimOcrTools,
  createSimUiTools,
  invalidateWdaTreeDepthMemory,
  IOS_OCR_TOOL_NAMES,
  IOS_UI_TOOL_NAMES,
} from './tool-uitree.js'
import { createSimRowTools, IOS_ROW_TOOL_NAMES } from './tool-list-rows.js'
import { createSimLogTools } from './tool-logs.js'
import { createSimDebugTools, IOS_DEBUG_TOOL_NAMES } from './tool-debug.js'
import { createSimPreviewTools, IOS_PREVIEW_TOOL_NAMES } from './tool-preview.js'
import { registerIosSkill } from './skill.js'
import { installStreamRoutes } from './stream-routes.js'
import { disposeDevicectlChildren } from './devicectl.js'

export {
  SimHostController,
  resolveServeSimBinary,
  type ServeSimBinary,
  type ServeSimBinarySource,
  type SimHostOptions,
  type SimHostStatus,
  type SimStreamInfo,
} from './sim-host.js'
export {
  WdaClient,
  WdaController,
  WdaError,
  WdaHttpError,
  assembleIproxyArgs,
  assembleXcodebuildTestArgs,
  classifyWdaFailure,
  isInvalidSessionError,
  parseServerUrlHere,
  pickTunnelPort,
  probeWdaControlTunnel,
  probeWdaMjpegTunnel,
  resolveWdaTooling,
  resolveWdaSetting,
  wdaFailureDetail,
  type TunnelPortPick,
  type WdaBuildSettings,
  type WdaClientOptions,
  type WdaControl,
  type WdaDrag,
  type WdaFailureReason,
  type WdaHealth,
  type WdaOptions,
  type WdaRunningInfo,
  type WdaSettingResolution,
  type WdaSettingSource,
  type WdaStatus,
  type WdaTooling,
} from './wda-host.js'
export {
  SimStreamSource,
  WdaStreamSource,
  pngDimensionsFromBase64,
  type StreamControl,
  type StreamDrag,
  type StreamPoint,
  type StreamScreenshot,
  type StreamSource,
  type StreamSourceInfo,
  type StreamSourceKind,
  type StreamSourceStatus,
  type WdaControllerLike,
} from './stream-source.js'
export {
  SimctlError,
  bootDevice,
  bootedDevices,
  compareRuntimesDesc,
  getDevice,
  installApp,
  launchApp,
  listDevices,
  shutdownDevice,
  takeScreenshot,
  type SimulatorDevice,
} from './simctl.js'
export {
  assembleBuildArgs,
  buildFailureDetail,
  buildRun,
  destinationIdFor,
  detectProject,
  filterBuildOutput,
  findBuiltApp,
  listSchemes,
  packageNameFromManifest,
  projectSlug,
  readBundleIdentifier,
  resolveScheme,
  runXcodeBuild,
  DEVICE_SIGNING_HINT,
  type BuildDevice,
  type BuildInvocation,
  type BuildRunOptions,
  type BuildRunResult,
  type ProjectKind,
  type ProjectTarget,
} from './build-run.js'
/**
 * Physical-device tooling (`xcrun devicectl`): exported as a namespace so the
 * names don't collide with the simulator helpers from simctl.js above.
 */
export * as devicectl from './devicectl.js'
export {
  filterInstalledApps,
  installedAppFromRealApp,
  listPhysicalDeviceApps,
  listSimulatorApps,
  lprojCandidates,
  localizeSimApps,
  noMatchCandidateLines,
  noMatchListingHint,
  parseSimctlListApps,
  resolveAppByName,
  simulatorLanguage,
  type InstalledApp,
  type SimAppWithPath,
} from './app-list.js'
export {
  createSimTools,
  IOS_TOOL_NAMES,
  type SimListAppsResult,
  type SimBootResult,
  type SimBuildRunResult,
  type SimDeviceInfo,
  type SimDevicesResult,
  type SimInteractArgs,
  type SimInteractResult,
  type SimScreenshotResult,
  type SimShutdownResult,
  type SimTools,
  type SimToolsOptions,
} from './tools.js'
export {
  DEEPEN_SNAPSHOT_DEPTH,
  buildTreeResult,
  createSimOcrTools,
  createSimUiTools,
  IOS_OCR_TOOL_NAMES,
  IOS_UI_TOOL_NAMES,
  OCR_DEFAULT_MIN_CONFIDENCE,
  capTreeToBytes,
  countNodes,
  hasLabeledNode,
  isOffscreenElement,
  isOffscreenFrame,
  pruneOffscreenTree,
  rawScreenBounds,
  resetSimPointSizeCache,
  resolveOcrTextTarget,
  simPointSizeCacheKey,
  simPointSizeStats,
  resolveTapTarget,
  sanitizeMinConfidence,
  wdaTree,
  type SimFindTextItem,
  type SimFindTextResult,
  type SimOcrTools,
  type SimTapElementResult,
  type SimTapTextResult,
  type SimUiTools,
  type SimUiToolsOptions,
  type SimUiTreeResult,
  type TreeSample,
  type UiTreeNode,
  type WdaTreeSample,
} from './tool-uitree.js'
export {
  OCR_INSTALL_HINT,
  ensureOcrBinary,
  execOcr,
  filterOcrItems,
  normalizedRectToPixels,
  ocrCacheBase,
  parseOcrOutput,
  pixelCenterToPoints,
  pixelRectToNormalized,
  pixelRectToNormalizedCenter,
  pixelRectToPoints,
  pointsRectToPixels,
  rectCenter,
  resolveOcrBinary,
  resolveOcrSwiftSource,
  type OcrBinary,
  type OcrBinarySource,
  type OcrItem,
  type OcrRect,
  type PixelSize,
} from './ocr-backend.js'
export {
  AXE_INSTALL_HINT,
  AXE_RELEASE_SHA256,
  AXE_RELEASE_URL,
  AXE_VERSION,
  ensureAxeBinary,
  execAxe,
  parseDescribeUi,
  resolveAxeBinary,
  sanitizeAxeNode,
  type AxeBinary,
  type AxeBinarySource,
  type AxeElement,
  type RawAxeNode,
} from './uitree-backend.js'
export {
  PreviewHostController,
  PREVIEW_HOST_BUNDLE_ID,
  type PreviewEntry,
  type PreviewHostOptions,
  type PreviewHostStatus,
  type PreviewReloadInfo,
  type PreviewStartOptions,
  type PreviewStartResult,
  type PreviewStopResult,
} from './preview-host.js'
export {
  createSimPreviewTools,
  IOS_PREVIEW_TOOL_NAMES,
  type SimPreviewArgs,
  type SimPreviewTools,
  type SimPreviewToolsOptions,
} from './tool-preview.js'
export {
  IOS_SKILL_CONTENT,
  IOS_SKILL_DESCRIPTION,
  IOS_SKILL_NAME,
  IOS_SKILL_WHEN_TO_USE,
  registerIosSkill,
} from './skill.js'
export {
  IOS_ROW_TOOL_NAMES,
  ROW_SNAPSHOT_DEPTH,
  createSimRowTools,
  type SimRowTools,
  type SimRowToolsOptions,
  type SimTapRowResult,
  type SimUiRowsResult,
} from './tool-list-rows.js'
export {
  MIN_REPEATED_ROWS,
  aggregateRowLabel,
  detectListRows,
  isRowOffscreenFrame,
  normalizeCountKey,
  parseCountsFromLabel,
  planRowTap,
  requireCountKey,
  rowCountFor,
  rowsStayedPut,
  sanitizeCountDelta,
  verifyCountChange,
  type CountCheckResult,
  type DetectRowsOptions,
  type DetectRowsResult,
  type ListRow,
  type RowCount,
  type RowTapPlan,
} from './list-rows.js'
export {
  APP_SWITCHER_DRAG_DURATION_S,
  APP_SWITCHER_FROM_Y,
  APP_SWITCHER_TO_Y,
} from './app-switcher.js'
export {
  DEVICE_ACTIONS,
  DEVICE_ACTION_PERMISSION_HINT,
  DEVICE_ACTION_SIMULATOR_HINT,
  DEVICE_ACTION_SPECS,
  deviceActionFailureHint,
  deviceActionSpec,
  isDeviceAction,
  runSimulatorDeviceAction,
  simulatorHomeKeystrokeScript,
  simulatorMenuItemScript,
  type DeviceAction,
  type DeviceActionSpec,
  type DeviceActionTransport,
} from './device-actions.js'
export {
  DEVICE_ACTION_ROUTE_PATH,
  DEVICES_ROUTE_PATH,
  GRANT_ROUTE_PATH,
  PLUGIN_ROUTE_PREFIX,
  REAL_START_ROUTE_PATH,
  SCREENSHOT_ROUTE_PREFIX,
  STREAM_ROUTE_PREFIX,
  SWITCH_DEVICE_ROUTE_PATH,
  StreamAccessController,
  StreamRoutes,
  TOKEN_TTL_MS,
  WS_ROUTE_PATH,
  installStreamRoutes,
  isLoopbackRemoteAddress,
  mountStreamRoutes,
  prepareStreamAccessKey,
  screenshotDir,
  stateRoot,
  type RealStartRecord,
  type StreamRouteMount,
} from './stream-routes.js'

/** Stable plugin name (the loader entry id in cordis.patch.yml). */
export const name = 'dsh-ios'

/** Services this plugin's root fiber requires. */
export const inject = ['tools']

/**
 * rc.2 source worktrees augmented the legacy `cordis` package name while the
 * published rc line augments `@deepseek-ai/cordis`. Keep this plugin's build
 * structural so the same source type-checks against both without changing its
 * runtime service contract.
 */
type HostContext = Context & {
  tools: ToolRegistry
}

/** Plugin entry: mount every model-facing contribution. */
export function apply(ctx: Context): () => Promise<void> {
  const hostCtx = ctx as HostContext
  const host = new SimHostController()
  // Real-device host (WebDriverAgent over USB): constructed up front so its
  // keep-alive can hold a runner alive; routes/panel land in the next phase.
  // Idle reaping is DISABLED for the real device on purpose. The generic
  // 5-minute default fits a simulator stream, where a restart costs seconds;
  // on a phone the runner is an `xcodebuild … test` build that costs MINUTES
  // and needs the device unlocked, so reaping it the moment the panel stops
  // streaming turns every later screenshot/tap into a multi-minute rebuild —
  // observed in testing as "WDA keeps dying". The runner is still reaped by
  // an explicit stop, by plugin disposal, and by the phone going away.
  const wda = new WdaController({ idleTimeoutMs: 0 })
  const tools = createSimTools(host, { wda, onFrontmostAppChanged: invalidateWdaTreeDepthMemory })
  const uiTools = createSimUiTools(host, { wda })
  const rowTools = createSimRowTools(host, { wda })
  const ocrTools = createSimOcrTools(host, { wda })
  const previewTools = createSimPreviewTools(host, { logger: line => ctx.logger.info(line) })
  // Keep the stream alive across crashes; an intentional stop (or the idle
  // timeout) is never fought.
  // serve-sim resolution is a silent 60x performance cliff: when the package
  // is not installed the host falls back to `npx -y serve-sim`, which pays a
  // fresh resolve on EVERY control call — measured 3.6–6.5 s per tap against
  // 57 ms for the installed bin, i.e. ~90% of an ios_sim_interact round trip
  // spent starting a package manager. It still works, so nothing ever failed
  // and nobody noticed for a whole session of agent-driven taps. Say it once,
  // loudly, with the fix.
  const serveSim = host.status()
  if (serveSim.serveSimSource === 'npx') {
    ctx.logger.warn(
      'dsh-ios: serve-sim is not installed — falling back to `npx -y serve-sim`, which adds ~3–6 s to '
      + 'EVERY simulator tap/type/gesture. Install it next to the plugin (pnpm add serve-sim) to get '
      + 'the ~50 ms path.',
    )
  }
  host.startKeepAlive()
  wda.startKeepAlive()

  const disposers: Array<() => void | Promise<void>> = []
  // The bundled playbook: what the tool descriptions cannot say, because it
  // is about the workflow BETWEEN the tools. A host without the skill service
  // simply does not advertise it.
  disposers.push(registerIosSkill(ctx))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimDevices), 'dsh-ios:ios_sim_devices'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimBoot), 'dsh-ios:ios_sim_boot'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimShutdown), 'dsh-ios:ios_sim_shutdown'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimScreenshot), 'dsh-ios:ios_sim_screenshot'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimInteract), 'dsh-ios:ios_sim_interact'))
  // WP57: ios_sim_list_apps + ios_sim_launch_app. The launch tool existed in
  // the factory but was never registered here, so "open the list app" had no verb
  // at all: one measured session answered it with 25 shell calls (6.6 s each,
  // 165 s of a 377 s run) around xcrun, then a grep of the user's source trees.
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimListApps), 'dsh-ios:ios_sim_list_apps'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimLaunchApp), 'dsh-ios:ios_sim_launch_app'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimBuildRun), 'dsh-ios:ios_sim_build_run'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosRealStartWda), 'dsh-ios:ios_real_start_wda'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(uiTools.iosSimUiTree), 'dsh-ios:ios_sim_ui_tree'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(uiTools.iosSimTapElement), 'dsh-ios:ios_sim_tap_element'))
  // WP63: list/feed row abstraction (ios_sim_ui_rows) + row-relative tap with
  // count-change verification and the real-device probe-guard (ios_sim_tap_row).
  disposers.push(ctx.effect(() => hostCtx.tools.register(rowTools.iosSimUiRows), 'dsh-ios:ios_sim_ui_rows'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(rowTools.iosSimTapRow), 'dsh-ios:ios_sim_tap_row'))
  disposers.push(ctx.effect(() => {
    const disposeFind = hostCtx.tools.register(ocrTools.iosSimFindText)
    const disposeTap = hostCtx.tools.register(ocrTools.iosSimTapText)
    // ios_sim_wait_for was created by the factory (and the skill playbook
    // tells the model to use it) but was never registered here — the exact
    // WP57 failure shape again: an advertised verb with no implementation
    // behind it.
    const disposeWait = hostCtx.tools.register(ocrTools.iosSimWaitFor)
    return () => {
      disposeWait()
      disposeTap()
      disposeFind()
    }
  }, 'dsh-ios:ios_sim_ocr'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(createSimLogTools(host).iosSimLogs), 'dsh-ios:ios_sim_logs'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(previewTools.iosSimPreview), 'dsh-ios:ios_sim_preview'))
  // Debugging & memory diagnostics (processes, batch backtrace, leaks, app
  // info): registered as one effect so the disposer also reaps any debug
  // child (lldb/leaks/sample) still running in its timeout/abort grace.
  const debugTools = createSimDebugTools(host)
  disposers.push(ctx.effect(() => {
    hostCtx.tools.register(debugTools.iosSimProcesses)
    hostCtx.tools.register(debugTools.iosSimBacktrace)
    hostCtx.tools.register(debugTools.iosSimLeaks)
    hostCtx.tools.register(debugTools.iosSimAppInfo)
    return () => debugTools.dispose()
  }, 'dsh-ios:debug-tools'))

  // Signed web routes (stream, screenshot, ws control, grant): mounted on the
  // optional webServer service; headless profiles skip them entirely.
  installStreamRoutes(ctx, host, wda)

  // The mounted-tool inventory must list what was actually registered:
  // ios_sim_logs and the four debug tools were mounted above but missing here.
  ctx.logger.info(`dsh-ios mounted (${IOS_TOOL_NAMES.join(' + ')} + ${IOS_UI_TOOL_NAMES.join(' + ')} + ${IOS_ROW_TOOL_NAMES.join(' + ')} + ${IOS_OCR_TOOL_NAMES.join(' + ')} + ios_sim_logs + ${IOS_PREVIEW_TOOL_NAMES.join(' + ')} + ${IOS_DEBUG_TOOL_NAMES.join(' + ')}; serve-sim: ${host.status().serveSimSource}; WDA: ${wda.status().available ? 'available' : `unavailable (${wda.tooling.reason ?? '?'})`})`)
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await previewTools.controller.dispose()
    await host.dispose()
    await wda.dispose()
    disposeDevicectlChildren()
  }
}
