/**
 * Simulator frame (bezel) styles for the panel's phone frame.
 *
 * Three user-selectable modes, persisted in the panel store alongside
 * `sizeMode` (default `bezel`, host-lifetime persistence):
 *
 * - `none`   (无框 / Frameless): no shell at all — the stream/screenshot is
 *   the screen itself: the screen box carries the proportional corner clip
 *   directly and NOTHING around it paints a background or border (no black
 *   layers — see FRAMELESS_FRAME_STYLES + simPhoneScreenStyles in
 *   sim-panel.tsx);
 * - `bezel`  (边框 / Bezel, DEFAULT): the slim 6px dark rim (the WP18 look —
 *   see PHONE_BEZEL_STYLES in sim-panel.tsx);
 * - `device` (真机框 / Device frame): a realistic CSS-only device shell
 *   modeled on serve-sim's own preview page — a ~16px dark metallic
 *   gradient shell, device-grade concentric corners, a 1px lighter inner
 *   edge highlight, and proportionally placed side-button nubs (portrait
 *   only — see SimPhoneFrame for the landscape note).
 *
 * Bezel and device shells also carry a 1px border per side (frameless has
 * none). The screen inside renders as the frame's content box exactly
 * (`width: 100%` + `box-sizing: border-box`, so its hairline border paints
 * INSIDE the box — see sim-panel.tsx); every derivation of the screen's px
 * size therefore subtracts BOTH the padding and the border via
 * `simPanelScreenWidthOf`, the single source of truth shared by the
 * measured-fit path, the percent/preset box, and the radius basis.
 * Subtracting only the padding left the screen 2px wider than the content
 * box and ate the right rim's border (left rim 6+1, right rim 5).
 *
 * Corner radii are PROPORTIONAL, like native Simulator.app: the screen's
 * corner follows the displayed screen box — radius = min(displayedW,
 * displayedH) × 55/390 (an iPhone-17-Pro-class display rounds its corners at
 * ≈55pt on a 390pt-wide screen). Portrait basis is the width; landscape
 * swaps to the displayed height (the device's physical short side either
 * way). Every shell derives its OUTER radius from the SAME screen radius
 * (outer = screen + shell pad), so the corners stay concentric at every
 * displayed size, in both orientations, in all three modes. SimPhoneFrame
 * tracks the displayed size live (deterministic px width math for
 * percent/preset; a ResizeObserver on the frame wrapper for fit/drag
 * resizes), and radius updates only touch style props — the stream img is
 * never remounted, so the stream does not reconnect on resize.
 *
 * The shell is the ONLY thing that changes between modes. The frame's outer
 * width semantics (fit/percent/preset), the screen's aspect-ratio math
 * (WP19's rotation layout), the stream fill math, and the pointer
 * normalization are all mode-independent — `SimPhoneFrame` computes them
 * once and layers the chosen shell around the screen.
 *
 * Everything here is pure (no React, no DOM), so the dev-panel-smoke script
 * can exercise the store transitions, the id parsing, and the shell metrics
 * directly.
 */

import type { SimCopy } from './copy.js'
import {
  SIM_PANEL_DEVICE_SCALE,
  simPanelFrameLayoutOf,
  simPanelFrameWidthOf,
  simPanelSnapPxOf,
  type SimPanelSizeMode,
} from './sim-panel-size.js'

/** The frame-style state persisted in the panel store. */
export type SimFrameStyle = 'none' | 'bezel' | 'device'

/** Shared default (stable identity — the store and panels all use it). */
export const SIM_FRAME_STYLE_BEZEL: SimFrameStyle = 'bezel'

/** The control's option roster (无框 / 边框 / 真机框 order). */
export const SIM_FRAME_STYLE_OPTIONS: readonly SimFrameStyle[] = ['none', 'bezel', 'device']

/** Defensive parse of a frame-style id; unknown ids fall back to bezel. */
export function simFrameStyleOf(id: string): SimFrameStyle {
  return SIM_FRAME_STYLE_OPTIONS.find(candidate => candidate === id) ?? SIM_FRAME_STYLE_BEZEL
}

/** User-facing label for one frame style (copy lives in copy.ts). */
export function simFrameStyleLabelOf(style: SimFrameStyle, copy: SimCopy): string {
  switch (style) {
    case 'none': return copy.frameStyleNone
    case 'bezel': return copy.frameStyleBezel
    case 'device': return copy.frameStyleDevice
  }
}

// ── shell metrics (the exact numbers the per-mode styles below use) ─────────

/** Slim bezel shell thickness on every side (the WP18 6px rim). */
export const SIM_FRAME_BEZEL_SHELL = 6
/** Device shell thickness on every side (the WP20 14–18px spec range). */
export const SIM_FRAME_DEVICE_SHELL = 16
/**
 * Shell border thickness on every side for the bordered modes (bezel +
 * device); frameless has no border. The CSS shells in sim-panel.tsx declare
 * their borders from this constant, and the screen-width derivation below
 * subtracts it together with the padding — the border is part of the rim,
 * so a screen sized without it overflows the content box into the right
 * padding/border and the left/right rims render uneven (WP27 fix).
 */
export const SIM_FRAME_SHELL_BORDER_PX = 1

/**
 * The native Simulator.app display-corner ratio: an iPhone-17-Pro-class
 * display rounds its corners at ≈55pt on a 390pt-wide screen (≈14.1% of the
 * displayed logical width). The panel's screen radius is proportional to the
 * DISPLAYED screen box, so it scales with the panel's drag-resize, every
 * size mode, and orientation flips — never a fixed px value.
 */
export const SIM_FRAME_SCREEN_RADIUS_RATIO = 55 / 390

/**
 * The radius the SSR/first render uses before the frame is measured: the
 * 390×844 fallback display's rounded corner (390 × 55/390 = 55). Only the
 * fit mode needs it (its 100% width is unknown without the DOM);
 * percent/preset renders derive their radius exactly from props.
 */
export const SIM_FRAME_RADIUS_FALLBACK_PX = 55

/** Shell padding per mode: none → 0, bezel → 6, device → 16. */
export function simPanelShellPadOf(style: SimFrameStyle): number {
  switch (style) {
    case 'none': return 0
    case 'device': return SIM_FRAME_DEVICE_SHELL
    default: return SIM_FRAME_BEZEL_SHELL
  }
}

/** Shell border thickness per mode: none → 0, bezel → 1, device → 1. */
export function simPanelFrameBorderPxOf(style: SimFrameStyle): number {
  return style === 'none' ? 0 : SIM_FRAME_SHELL_BORDER_PX
}

/**
 * The shell's total per-side inset (padding + border) — the distance from
 * the frame's border-box edge to the screen box on every side. With the
 * screen rendering border-box at 100% width (see sim-panel.tsx), the
 * screen's rendered box is exactly frame width − 2×this inset, so each
 * left/right rim measures this many px: none → 0, bezel → 7, device → 17.
 */
export function simPanelFrameInsetOf(style: SimFrameStyle): number {
  return simPanelShellPadOf(style) + simPanelFrameBorderPxOf(style)
}

/**
 * The rendered screen width for a frame whose border-box width is known
 * (CSS px): frame width − 2×(padding + border) per mode, snapped to a whole
 * px BEFORE the subtraction (both operands stay on the device-pixel grid).
 * THE single source of truth for every screen-width derivation — the
 * measured fit path (the frame's ResizeObserver), the percent/preset box
 * (`simPanelScreenBoxOf`), and the WP22 radius basis all go through here,
 * so the visible screen box and its corner radius can never drift apart.
 */
export function simPanelScreenWidthOf(frameWidthCss: number, frameStyle: SimFrameStyle): number {
  return simPanelSnapPxOf(frameWidthCss) - 2 * simPanelFrameInsetOf(frameStyle)
}

function radiusSideOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The screen's corner radius for a known displayed screen box (CSS px,
 * rounded to 0.1): the device's physical corner follows the SHORT side —
 * radius = min(displayedW, displayedH) × 55/390. Portrait basis is the
 * width (390 → 55); landscape uses the displayed height (844×390 → 390 →
 * 55); 240 → 33.8.
 */
export function simPanelScreenRadiusOf(displayedW: number, displayedH: number): number {
  const side = Math.min(radiusSideOf(displayedW), radiusSideOf(displayedH))
  return Math.round(side * SIM_FRAME_SCREEN_RADIUS_RATIO * 10) / 10
}

/**
 * Concentric shell outer radius: screen radius + shell pad (none → +0, so
 * the frameless "shell" radius IS the screen's clip radius).
 */
export function simPanelShellRadiusOf(style: SimFrameStyle, screenRadius: number): number {
  return Math.round((radiusSideOf(screenRadius) + simPanelShellPadOf(style)) * 10) / 10
}

/**
 * The displayed screen box for the deterministic size modes (percent and
 * preset give exact px widths): frame width − 2×(shell padding + border)
 * wide, with the orientation's display aspect (the screen's aspect-ratio).
 * Returns undefined for fit, whose 100% width only the DOM knows —
 * SimPhoneFrame measures it via a ResizeObserver on the frame wrapper.
 */
export function simPanelScreenBoxOf(
  mode: SimPanelSizeMode,
  naturalWidth: number | undefined,
  naturalHeight: number | undefined,
  orientation: string | undefined,
  frameStyle: SimFrameStyle,
): { width: number; height: number } | undefined {
  const layout = simPanelFrameLayoutOf(orientation, naturalWidth, naturalHeight)
  const widthCss = simPanelFrameWidthOf(
    mode,
    naturalWidth,
    layout.displayW / SIM_PANEL_DEVICE_SCALE,
    layout.displayW / layout.displayH,
  )
  if (widthCss === '100%') return undefined
  // The screen width subtracts the shell's padding AND border (not just the
  // padding): the screen renders border-box at the content-box size, so
  // omitting the 1px border per side made the derived box 2px wider than
  // the rendered one and the right rim lost its border's px. Snap the frame
  // width first so both rims round identically at 2× DPR.
  const width = simPanelScreenWidthOf(Number.parseFloat(widthCss), frameStyle)
  if (!Number.isFinite(width) || width <= 0) return undefined
  return { width, height: width * layout.displayH / layout.displayW }
}

/**
 * The measured-radius fallback: the device's natural display corner at
 * logical scale (displayW/3 × displayH/3 → min side × ratio). Identical in
 * both orientations because the min side is the display's short side.
 */
export function simPanelFrameRadiusFallbackOf(
  orientation: string | undefined,
  naturalWidth: number | undefined,
  naturalHeight: number | undefined,
): number {
  const layout = simPanelFrameLayoutOf(orientation, naturalWidth, naturalHeight)
  return simPanelScreenRadiusOf(
    layout.displayW / SIM_PANEL_DEVICE_SCALE,
    layout.displayH / SIM_PANEL_DEVICE_SCALE,
  )
}
