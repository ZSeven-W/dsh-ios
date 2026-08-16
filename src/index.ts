/**
 * @zseven-w/dsh-ios — build, run, and interact with a live iOS Simulator
 * stream inside a DeepSeek Harness conversation.
 *
 * Plugin lifecycle: one SimHostController owns the serve-sim stream for the
 * session; six core model-facing tools (`ios_sim_devices`, `ios_sim_boot`,
 * `ios_sim_shutdown`, `ios_sim_screenshot`, `ios_sim_interact`,
 * `ios_sim_build_run`) plus the UI-tree pair (`ios_sim_ui_tree`,
 * `ios_sim_tap_element`) are registered through `ctx.effect` so unloading
 * the plugin unregisters them, and the returned disposer stops the stream
 * child and the keep-alive loop.
 *
 * On non-macOS hosts (or when serve-sim is unresolvable) the tools still
 * register but fail with a clear explanatory error — the same degradation
 * style as dsh-openpencil.
 * @module @zseven-w/dsh-ios
 */

import type { Context } from '@deepseek-ai/cordis'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import { SimHostController } from './sim-host.js'
import { createSimTools, IOS_TOOL_NAMES } from './tools.js'
import { createSimUiTools, IOS_UI_TOOL_NAMES } from './tool-uitree.js'
import { createSimLogTools } from './tool-logs.js'
import { createSimDebugTools } from './tool-debug.js'
import { createSimPreviewTools, IOS_PREVIEW_TOOL_NAMES } from './tool-preview.js'
import { installStreamRoutes } from './stream-routes.js'

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
  detectProject,
  filterBuildOutput,
  findBuiltApp,
  listSchemes,
  packageNameFromManifest,
  projectSlug,
  readBundleIdentifier,
  resolveScheme,
  runXcodeBuild,
  type BuildInvocation,
  type BuildRunOptions,
  type BuildRunResult,
  type ProjectKind,
  type ProjectTarget,
} from './build-run.js'
export {
  createSimTools,
  IOS_TOOL_NAMES,
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
  createSimUiTools,
  IOS_UI_TOOL_NAMES,
  capTreeToBytes,
  resolveTapTarget,
  type SimTapElementResult,
  type SimUiTools,
  type SimUiToolsOptions,
  type SimUiTreeResult,
  type UiTreeNode,
} from './tool-uitree.js'
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
  GRANT_ROUTE_PATH,
  PLUGIN_ROUTE_PREFIX,
  SCREENSHOT_ROUTE_PREFIX,
  STREAM_ROUTE_PREFIX,
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
  const tools = createSimTools(host)
  const uiTools = createSimUiTools(host)
  const previewTools = createSimPreviewTools(host, { logger: line => ctx.logger.info(line) })
  // Keep the stream alive across crashes; an intentional stop (or the idle
  // timeout) is never fought.
  host.startKeepAlive()

  const disposers: Array<() => void | Promise<void>> = []
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimDevices), 'dsh-ios:ios_sim_devices'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimBoot), 'dsh-ios:ios_sim_boot'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimShutdown), 'dsh-ios:ios_sim_shutdown'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimScreenshot), 'dsh-ios:ios_sim_screenshot'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimInteract), 'dsh-ios:ios_sim_interact'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(tools.iosSimBuildRun), 'dsh-ios:ios_sim_build_run'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(uiTools.iosSimUiTree), 'dsh-ios:ios_sim_ui_tree'))
  disposers.push(ctx.effect(() => hostCtx.tools.register(uiTools.iosSimTapElement), 'dsh-ios:ios_sim_tap_element'))
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
  installStreamRoutes(ctx, host)

  ctx.logger.info(`dsh-ios mounted (${IOS_TOOL_NAMES.join(' + ')} + ${IOS_UI_TOOL_NAMES.join(' + ')} + ${IOS_PREVIEW_TOOL_NAMES.join(' + ')}; serve-sim: ${host.status().serveSimSource})`)
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await previewTools.controller.dispose()
    await host.dispose()
  }
}
