/**
 * Compatibility boundary for DSH builds that declare a keyed per-tool details
 * seat (the Codex-style right details panel).
 *
 * The installed rc.6 runtime does NOT declare `tool.details.toolview` — its
 * tool package only declares `tool.call.toolview`, and the details column
 * body is the single-occupant `conversation.details.tool` seat (declared by
 * dsh-client-ui-conversation, "one occupant, so taking it means rendering
 * every tool's output"). Mirroring dsh-openpencil, this module keeps the
 * proposed additive contract local: at runtime `ctx.slots.inject()` simply
 * waits while the slot is absent, so on rc.6 the plugin's page-owned right
 * panel host (sim-panel-host) carries the surface instead. A future
 * supporting host activates the native seat without code changes, and the
 * panel host's row-click trigger steps aside when it sees the declaration.
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DetailsToolOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'tool.details.toolview': {
      kind: 'keyed'
      scope: 'session'
      owner: DetailsToolOwnerProps
    }
  }
}

/** Details props without importing a symbol absent from current DSH releases. */
export type CompatibleToolDetailsViewProps = PropsRuntime<'tool.details.toolview'>
