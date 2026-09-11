/**
 * Compatibility boundary for the per-tool details/toolview contract.
 *
 * DSH 0.1.5 removed the rc.6-era keyed right-column details seat: neither
 * `tool.details.toolview` nor `DetailsToolOwnerProps` exists any more, and
 * the right bar (`rightbar.session`, declared by dsh-client-ui-layout and
 * occupied by the dockkit sidebar) exposes no per-tool keyed seat to
 * plugins. The actual 0.1.5 per-tool contract is `tool.call.toolview`
 * (keyed by wire tool name, session scope), declared by
 * `@deepseek-ai/dsh-client-ui-tool/client`. Its owner receives the call
 * identity, the frozen running-or-settled `ToolCallBlock`, the workspace
 * cwd/home, `openFile`, `loadImage`, and an optional `inspect` (see
 * `ToolCallOwnerProps` in that package's contract/slots.d.ts).
 *
 * The plugin registers its compact per-tool cards on that real seat
 * (index.tsx) and keeps the persistent simulator display on its own
 * page-owned panel host (sim-panel-host.tsx), because 0.1.5 declares no
 * native details-column seat for tool-specific surfaces.
 */

import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'

/**
 * The props one per-tool view receives from the 0.1.5 slot framework: the
 * composed props of the real `tool.call.toolview` seat (owner share plus
 * session standard props). Kept as a named alias so panel code states its
 * contract against the actual host instead of the removed rc.6 type.
 */
export type CompatibleToolDetailsViewProps = ToolCallViewProps
