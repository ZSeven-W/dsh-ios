/**
 * Simulator display size modes for the panel stage.
 *
 * The stream/screenshot display inside the panel's phone frame is sized by
 * one of three modes, chosen with a compact dropdown in the panel header:
 *
 * - `fit`    (DEFAULT): the frame fills the panel's content width, so
 *   dragging the panel's resize handle scales the simulator with it;
 * - `percent`: the user picks 50% / 75% / 100% / 125% of the device's
 *   LOGICAL point width. The logical width is the stream/screenshot image's
 *   natural pixel width divided by the device scale (≈ 3 — the natural px /
 *   device-scale relationship of the simulator frames); until the first
 *   frame reports its natural size the fallback 390pt (iPhone-ish) applies;
 * - `preset`: quick fixed sizes — S (240px), M (320px), L (420px). The
 *   preset value is the device's SHORT-side (portrait width) display size:
 *   portrait renders the preset px width, landscape scales it by the
 *   displayed width/height ratio (natural dims, 844/390 fallback) so the
 *   device keeps its physical size across the rotation — see the preset
 *   branch of `simPanelFrameWidthOf`.
 *
 * The percent basis follows the device ORIENTATION: the "width" semantics
 * always apply to the DISPLAYED (rotated) width, so a landscape device uses
 * its landscape logical width (natural height / scale) as the 100% basis —
 * see `simPanelDisplayLogicalWidthOf` and the rotation math in
 * sim-orientation.ts.
 *
 * Everything here is pure (no DOM, no React state), so the dev-panel-smoke
 * script exercises the mode transitions and the width computation directly.
 */

import { simOrientationLayoutOf, type SimOrientationLayout } from './sim-orientation.js'

/** Device scale: simulator frames ship at ~3× logical points (390pt → 1170px). */
export const SIM_PANEL_DEVICE_SCALE = 3
/** Logical-point fallback until a frame reports its natural pixel width. */
export const SIM_PANEL_FALLBACK_LOGICAL_WIDTH = 390
/** Logical-point fallback height for the frame's base 390×844 shape. */
export const SIM_PANEL_FALLBACK_LOGICAL_HEIGHT = 844

/** The size-mode state persisted in the panel store. */
export type SimPanelSizeMode =
  | { kind: 'fit' }
  | { kind: 'percent'; value: number }
  | { kind: 'preset'; width: number }

/** Shared default (stable identity — the store and panels all use it). */
export const SIM_PANEL_SIZE_MODE_FIT: SimPanelSizeMode = { kind: 'fit' }

/** The zoom percentages offered by the percent mode. */
export const SIM_PANEL_PERCENT_OPTIONS = [50, 75, 100, 125] as const

export interface SimPanelPresetOption {
  id: 'S' | 'M' | 'L'
  width: number
  labelEn: string
  labelZh: string
}

/**
 * The quick fixed widths of the preset mode. Each preset is the device's
 * SHORT-side (portrait width) display size — the dropdown/quick labels keep
 * the raw px (S · 240px) because the number refers to that short side, not
 * the frame width in every orientation. Portrait renders the preset px
 * width; landscape scales it by the displayed width/height ratio (e.g.
 * landscape S = 240 × 874/402 ≈ 522px) — see `simPanelFrameWidthOf`.
 */
export const SIM_PANEL_PRESET_OPTIONS: readonly SimPanelPresetOption[] = [
  { id: 'S', width: 240, labelEn: 'S · 240px', labelZh: 'S（240px）' },
  { id: 'M', width: 320, labelEn: 'M · 320px', labelZh: 'M（320px）' },
  { id: 'L', width: 420, labelEn: 'L · 420px', labelZh: 'L（420px）' },
]

export interface SimPanelSizeOption {
  id: string
  mode: SimPanelSizeMode
  labelEn: string
  labelZh: string
}

/** The dropdown's option roster (fit first, then percent, then presets). */
export const SIM_PANEL_SIZE_OPTIONS: readonly SimPanelSizeOption[] = [
  { id: 'fit', mode: SIM_PANEL_SIZE_MODE_FIT, labelEn: 'Fit to width', labelZh: '适应宽度' },
  ...SIM_PANEL_PERCENT_OPTIONS.map(value => ({
    id: `percent-${value}`,
    mode: { kind: 'percent', value } as SimPanelSizeMode,
    labelEn: `${value}%`,
    labelZh: `${value}%`,
  })),
  ...SIM_PANEL_PRESET_OPTIONS.map(preset => ({
    id: `preset-${preset.id}`,
    mode: { kind: 'preset', width: preset.width } as SimPanelSizeMode,
    labelEn: preset.labelEn,
    labelZh: preset.labelZh,
  })),
]

/**
 * The device's logical point width for the percent-mode basis: the frame's
 * natural pixel width divided by the device scale, falling back to 390pt
 * while no natural size is known yet.
 */
export function simDeviceLogicalWidthOf(naturalWidth: number | undefined): number {
  return typeof naturalWidth === 'number' && Number.isFinite(naturalWidth) && naturalWidth > 0
    ? naturalWidth / SIM_PANEL_DEVICE_SCALE
    : SIM_PANEL_FALLBACK_LOGICAL_WIDTH
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The frame's base (framebuffer) size in pixels for the rotation math:
 * the reported natural dims when known, otherwise the logical 390×844
 * fallback shape at device scale. When only the width is known the height
 * keeps the 390:844 phone aspect.
 */
export function simPanelFrameBaseSizeOf(
  naturalWidth: number | undefined,
  naturalHeight: number | undefined,
): { baseW: number; baseH: number } {
  const fallbackW = SIM_PANEL_FALLBACK_LOGICAL_WIDTH * SIM_PANEL_DEVICE_SCALE
  const baseW = positiveOr(naturalWidth, fallbackW)
  // Unknown height: keep the 390:844 phone aspect off the (possibly
  // fallback) width — 1170 × 844/390 = 2532 exactly when the width itself
  // fell back, so this single expression covers both unknown cases.
  const baseH = positiveOr(naturalHeight, Math.round(baseW * SIM_PANEL_FALLBACK_LOGICAL_HEIGHT / SIM_PANEL_FALLBACK_LOGICAL_WIDTH))
  return { baseW, baseH }
}

/**
 * The display layout for the panel frame: the orientation's CSS rotation
 * and rotated bounding box over the frame's base size (natural dims when
 * reported, the 390×844 fallback otherwise). The ±90° cases swap the axes,
 * which is what makes the bezel follow the sideways device as a wide frame.
 */
export function simPanelFrameLayoutOf(
  orientation: string | undefined,
  naturalWidth: number | undefined,
  naturalHeight: number | undefined,
): SimOrientationLayout {
  const { baseW, baseH } = simPanelFrameBaseSizeOf(naturalWidth, naturalHeight)
  return simOrientationLayoutOf(orientation, baseW, baseH)
}

/**
 * The device's logical width of the DISPLAYED (rotated) frame — the
 * percent-mode basis: displayW / device scale, so a landscape device uses
 * its landscape logical width (natural height / 3) while portrait keeps the
 * existing natural-width basis. Falls back to 390pt portrait / 844pt
 * landscape while no natural size is known.
 */
export function simPanelDisplayLogicalWidthOf(
  orientation: string | undefined,
  naturalWidth: number | undefined,
  naturalHeight: number | undefined,
): number {
  return simPanelFrameLayoutOf(orientation, naturalWidth, naturalHeight).displayW / SIM_PANEL_DEVICE_SCALE
}

/**
 * The phone-frame CSS width one size mode applies: `100%` for fit (the
 * panel's drag-resize therefore scales the simulator), `base × value%`
 * for percent (base = the DISPLAYED logical width when supplied, otherwise
 * the natural portrait logical width), and the orientation-aware preset
 * width (below). In landscape, "width" semantics apply to the displayed
 * (rotated) width — pass `simPanelDisplayLogicalWidthOf(...)` as the basis
 * and the displayed layout's width/height ratio as `displayedAspect`
 * (displayW / displayH of `simPanelFrameLayoutOf`), so presets scale with
 * the orientation too.
 */
export function simPanelFrameWidthOf(
  mode: SimPanelSizeMode,
  naturalWidth: number | undefined,
  displayedLogicalWidth?: number,
  displayedAspect?: number,
): string {
  switch (mode.kind) {
    case 'fit': return '100%'
    case 'percent': {
      const base = typeof displayedLogicalWidth === 'number'
        && Number.isFinite(displayedLogicalWidth)
        && displayedLogicalWidth > 0
        ? displayedLogicalWidth
        : simDeviceLogicalWidthOf(naturalWidth)
      return `${Math.round(base * mode.value / 100)}px`
    }
    case 'preset': {
      // Presets are orientation-aware SHORT-side sizes (see
      // SIM_PANEL_PRESET_OPTIONS): the preset px is the device's portrait
      // (short-side) frame width. A landscape (±90°) display swaps the
      // axes, so its displayed aspect is > 1 — scale the preset by the
      // displayed width/height ratio (natural dims, 844/390 fallback) so
      // the device keeps its physical size across the rotation (landscape
      // S = 240 × 874/402 ≈ 522px), snapped to the WP24 integer grid. No
      // aspect info (portrait, unknown dims) → the fixed preset width.
      const aspect = typeof displayedAspect === 'number' && Number.isFinite(displayedAspect) && displayedAspect > 1
        ? displayedAspect
        : 0
      return aspect > 0 ? `${simPanelSnapPxOf(mode.width * aspect)}px` : `${mode.width}px`
    }
  }
}

/**
 * Snaps a measured/computed CSS px value to a whole pixel (Math.round).
 *
 * The frame and screen boxes split their border/padding evenly between the
 * left and right rims, so a FRACTIONAL width rounds differently at each
 * device-pixel edge at 2× DPR — one side of the bezel ends up a physical
 * pixel thicker than the other. Round the width BEFORE deriving radius/box
 * values (and before applying the fit-mode frame width itself, see
 * SimPhoneFrame's ResizeObserver in sim-panel.tsx) so both rims rasterize
 * symmetrically; the ≤0.5px remainder then splits evenly under
 * `margin: 0 auto`. Non-positive/garbage input snaps to 0 (callers treat it
 * as "unmeasured").
 */
export function simPanelSnapPxOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** Stable option id for one size mode (the dropdown's `value`). */
export function simPanelSizeModeIdOf(mode: SimPanelSizeMode): string {
  switch (mode.kind) {
    case 'fit': return 'fit'
    case 'percent': return `percent-${mode.value}`
    case 'preset': {
      const preset = SIM_PANEL_PRESET_OPTIONS.find(option => option.width === mode.width)
      return preset !== undefined ? `preset-${preset.id}` : `preset-${mode.width}`
    }
  }
}

/** Defensive parse of a dropdown id; unknown ids fall back to fit. */
export function simPanelSizeModeOf(id: string): SimPanelSizeMode {
  const option = SIM_PANEL_SIZE_OPTIONS.find(candidate => candidate.id === id)
  return option?.mode ?? SIM_PANEL_SIZE_MODE_FIT
}

export interface SimPanelQuickSizeOption {
  /** Dropdown option id this quick button maps to (shared truth). */
  id: string
  /** The exact size mode dispatched to the store — the same object the
   * dropdown's option carries, so both controls stay in sync by id. */
  mode: SimPanelSizeMode
  quickEn: string
  quickZh: string
}

function simPanelQuickLabel(id: string): { en: string; zh: string } {
  switch (id) {
    case 'fit': return { en: 'Fit', zh: '适应' }
    case 'percent-100': return { en: '100%', zh: '100%' }
    case 'preset-S': return { en: 'S', zh: 'S' }
    case 'preset-M': return { en: 'M', zh: 'M' }
  }
  throw new RangeError(`dsh-ios: unknown quick size option ${id}`)
}

/**
 * The toolbar's one-tap quick sizes: the most-used modes promoted out of the
 * dropdown as segmented buttons — [Fit/适应] [100%] [S] [M]. Each entry is
 * derived from the DROPDOWN roster (`SIM_PANEL_SIZE_OPTIONS`), so pressing a
 * quick button dispatches the exact mode the dropdown selects and both stay
 * in sync against the store's single `sizeMode` truth.
 */
export const SIM_PANEL_QUICK_SIZE_OPTIONS: readonly SimPanelQuickSizeOption[] = (
  ['fit', 'percent-100', 'preset-S', 'preset-M'] as const
).map(id => {
  const option = SIM_PANEL_SIZE_OPTIONS.find(candidate => candidate.id === id)
  if (option === undefined) throw new RangeError(`dsh-ios: quick size ${id} is missing from the dropdown roster`)
  const label = simPanelQuickLabel(id)
  return { id, mode: option.mode, quickEn: label.en, quickZh: label.zh }
})
