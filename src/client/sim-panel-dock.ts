/**
 * Self-contained DSH layout push used by the dsh-ios simulator panel host.
 *
 * Mirrors dsh-openpencil's `claimEditorWorkbenchDock` exactly: DSH's root is
 * an auto-width block, so a right margin shrinks its AppFrame grid instead of
 * covering the conversation. Ownership is recorded through a dedicated data
 * attribute and the exact inline-style values are restored on release, which
 * keeps this compatible with HMR and fail-closed around another plugin that
 * already owns the root margin (including openpencil's own workbench dock).
 */

export const IOS_SIM_PANEL_DOCK_ATTRIBUTE = 'dshIosSimulatorPanelDockOwner'

export interface SimulatorPanelDockLease {
  update: (width: number) => void
  release: () => void
}

function dockWidth(width: number): string {
  return `${Math.max(0, Math.round(width))}px`
}

/**
 * Reserve real layout space for the fixed right-hand simulator panel.
 *
 * @param root - the app root element (`#root`) the panel pushes over.
 * @param owner - stable lease owner id; a different owner holding the margin
 *   makes the claim fail (the surface falls back to its overlay variant).
 * @param initialWidth - panel width in px reserved through the root margin.
 * @param computedMarginRight - current computed margin-right (0 = unclaimed).
 * @returns the lease, or undefined when another owner holds the margin.
 */
export function claimSimulatorPanelDock(
  root: HTMLElement,
  owner: string,
  initialWidth: number,
  computedMarginRight = 0,
): SimulatorPanelDockLease | undefined {
  const existingOwner = root.dataset[IOS_SIM_PANEL_DOCK_ATTRIBUTE]
  if (existingOwner !== undefined && existingOwner !== owner) return undefined
  if (existingOwner === undefined && (
    root.style.marginRight.trim() !== ''
    || (Number.isFinite(computedMarginRight) && computedMarginRight > 0.5)
  )) return undefined

  const previousMarginRight = root.style.marginRight
  const previousMinWidth = root.style.minWidth
  root.dataset[IOS_SIM_PANEL_DOCK_ATTRIBUTE] = owner
  root.style.minWidth = '0'

  let released = false
  const update = (width: number): void => {
    if (released || root.dataset[IOS_SIM_PANEL_DOCK_ATTRIBUTE] !== owner) return
    root.style.marginRight = dockWidth(width)
  }
  const release = (): void => {
    if (released) return
    released = true
    if (root.dataset[IOS_SIM_PANEL_DOCK_ATTRIBUTE] !== owner) return
    root.style.marginRight = previousMarginRight
    root.style.minWidth = previousMinWidth
    delete root.dataset[IOS_SIM_PANEL_DOCK_ATTRIBUTE]
  }

  update(initialWidth)
  return { update, release }
}
