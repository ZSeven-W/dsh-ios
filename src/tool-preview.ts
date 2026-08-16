/**
 * The `ios_sim_preview` tool: live SwiftUI preview hot reload in the
 * simulator. Wraps PreviewHostController so the model gets one lifecycle
 * tool (start/status/stop) whose start result carries the `sim-stream`
 * presentation envelope the panel already renders live.
 *
 * Degradation mirrors the other ios_sim_* tools: the tool always registers,
 * but start/stop throw a clear explanatory error on non-macOS hosts or when
 * the serve-sim stream binary is unavailable (status degrades to
 * `{ running: false }`, which is truthful on any host).
 * @module @zseven-w/dsh-ios/tool-preview
 */

import {
  defineTool,
  type JsonValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PreviewHostController,
  type PreviewHostStatus,
  type PreviewStartResult,
  type PreviewStopResult,
} from './preview-host.js'
import type { SimHostController } from './sim-host.js'

/** Registered tool names, in registration order. */
export const IOS_PREVIEW_TOOL_NAMES = ['ios_sim_preview'] as const

export interface SimPreviewToolsOptions {
  /** Plugin-owned cache root for the generated host app + dylib builds. */
  cacheDir?: string
  /** One-line progress logger (the cordis logger in production). */
  logger?: (line: string) => void
}

export interface SimPreviewArgs {
  packagePath?: string
  udid?: string
  action?: 'start' | 'status' | 'stop'
  previewFilter?: string
}

/** The tool definition plus the controller the plugin must dispose. */
export interface SimPreviewTools {
  iosSimPreview: ToolDefinition
  /** Dispose on plugin unload so watchers/host apps never leak. */
  controller: PreviewHostController
}

function renderJson(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Create the `ios_sim_preview` tool bound to one sim host controller. */
export function createSimPreviewTools(host: SimHostController, options: SimPreviewToolsOptions = {}): SimPreviewTools {
  const controller = new PreviewHostController({
    host,
    cacheDir: options.cacheDir ?? join(tmpdir(), 'dsh-ios'),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })

  const iosSimPreview = defineTool({
    name: 'ios_sim_preview',
    description: 'Show SwiftUI previews from a Swift package LIVE in the iOS Simulator with hot reload. '
      + 'action "start" (default) validates the package, generates a disposable preview-host app in a plugin cache '
      + '(never inside the package), builds the package as a dylib for the simulator, installs+launches the host, '
      + 'and starts watching the package sources — every edit rebuilds the dylib and hot-swaps it into the running '
      + 'host WITHOUT relaunching (~2-5 s, live in the simulator panel). Compiler errors never kill the session: '
      + 'the host keeps the last good preview and action "status" returns the error tail. '
      + 'Supports #Preview { … } and struct X_Previews: PreviewProvider declarations (preview types must be '
      + 'internal or public). Only ONE preview session can run at a time. '
      + 'action "status" reports the session (generations, previews, reload timings, errors). '
      + 'action "stop" terminates the host app, stops watching, and releases the stream.',
    parameters: {
      packagePath: {
        type: 'string',
        description: 'Absolute path to a Swift package directory (contains Package.swift) whose SwiftUI previews '
          + 'should be shown. Required for action "start"; ignored by "status"/"stop".',
      },
      udid: {
        type: 'string',
        description: 'Target simulator udid or device name. Defaults to the currently streamed device, else a '
          + 'booted simulator, else the newest-runtime iPhone (which is booted).',
      },
      action: {
        type: 'string',
        enum: ['start', 'status', 'stop'],
        description: 'What to do. Default "start".',
      },
      previewFilter: {
        type: 'string',
        description: 'Case-insensitive substring matched against preview names (#Preview labels or '
          + 'PreviewProvider struct names) when several previews exist; matching previews are paged in the host.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          running: { type: 'boolean', required: true },
          mode: { type: 'string' },
          state: { type: 'string' },
          device: {
            type: 'object',
            additionalProperties: false,
            properties: {
              udid: { type: 'string', required: true },
              name: { type: 'string', required: true },
              runtime: { type: 'string', required: true },
              state: { type: 'string', required: true },
            },
          },
          host: {
            type: 'object',
            additionalProperties: false,
            properties: {
              bundleId: { type: 'string', required: true },
              pid: { type: 'string' },
              terminated: { type: 'boolean' },
            },
          },
          package: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              name: { type: 'string', required: true },
            },
          },
          watching: { type: 'boolean' },
          generation: { type: 'integer' },
          loadedGeneration: { type: 'integer' },
          previews: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
              },
            },
          },
          reloads: { type: 'integer' },
          lastReload: {
            type: 'object',
            additionalProperties: false,
            properties: {
              generation: { type: 'integer', required: true },
              buildMs: { type: 'integer', required: true },
              totalMs: { type: 'integer', required: true },
            },
          },
          lastBuildError: { type: 'array', items: { type: 'string' } },
          lastRuntimeError: { type: 'string' },
          startedAt: { type: 'integer' },
        },
      },
      render: renderJson,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const result = value as unknown as { device?: { udid?: string }; watching?: boolean }
        if (result.device !== undefined && result.device.udid !== undefined && result.watching === true) {
          return {
            kind: 'sim-stream',
            device: { ...result.device },
            streamRouteId: `dsh-ios/stream/${result.device.udid}`,
          }
        }
        return null
      },
    },
    timeoutMs: 900_000,
    isConcurrencySafe: (args: SimPreviewArgs) => (args.action ?? 'start') === 'status',
    async execute(args: SimPreviewArgs, exec): Promise<PreviewStartResult | PreviewHostStatus | PreviewStopResult> {
      const action = args.action ?? 'start'
      if (action === 'status') return controller.status()
      if (action === 'stop') return controller.stop(exec.signal)
      if (args.packagePath === undefined || args.packagePath.trim() === '') {
        throw new Error('ios_sim_preview: action "start" requires packagePath — an absolute path to a Swift package directory (contains Package.swift)')
      }
      return controller.start({
        packagePath: args.packagePath,
        ...(args.udid === undefined ? {} : { udid: args.udid }),
        ...(args.previewFilter === undefined ? {} : { previewFilter: args.previewFilter }),
        signal: exec.signal,
      })
    },
    presentCall: (args: SimPreviewArgs) => {
      if (args.action === 'status') return { card: 'generic', title: 'Preview session status', kind: 'execute' }
      if (args.action === 'stop') return { card: 'generic', title: 'Stop preview session', kind: 'execute' }
      return {
        card: 'generic',
        title: `Live-preview ${args.packagePath ?? '(missing packagePath)'}`,
        kind: 'execute',
        locations: args.packagePath === undefined ? [] : [{ path: args.packagePath }],
      }
    },
  })

  return { iosSimPreview, controller }
}
