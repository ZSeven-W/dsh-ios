/**
 * Pure display-rotation math for the live-stream panel frame.
 *
 * The iOS Simulator framebuffer behind the MJPEG stream stays PORTRAIT-sized
 * (e.g. 1170×2532) regardless of the device orientation, so when serve-sim
 * reports `landscape_left` / `landscape_right` the app content arrives drawn
 * sideways inside the portrait buffer. The panel counter-rotates the stream
 * img via CSS so the content reads upright, and the phone bezel follows
 * (a wide frame with the screen axes swapped).
 *
 * Everything here is pure (no DOM, no React), so the dev-panel-smoke script
 * exercises the rotation/bounding-box math and the pointer inverse mapping
 * directly from the built bundle.
 *
 * Rotation convention (CSS degrees, positive = clockwise), verified LIVE
 * against serve-sim 0.1.45 + iOS 26.4 (the initial ∓ guess rendered content
 * upside down — trust the on-device check, not the naming):
 * - `landscape_left`  → img counter-rotated by +90°;
 * - `landscape_right` → -90°;
 * - `portrait_upside_down` → 180°.
 * The ±90° cases swap the displayed axes (displayW = baseH, displayH = baseW).
 */

import { SIM_ROTATE_ORIENTATIONS, type SimRotateOrientation, type SimPoint } from './protocol.js'

/** The display's orientation vocabulary (the serve-sim tag-7 rotation set). */
export type SimDisplayOrientation = SimRotateOrientation

/** All display orientations (same roster as the wire's rotation frames). */
export const SIM_DISPLAY_ORIENTATIONS: readonly string[] = SIM_ROTATE_ORIENTATIONS

/**
 * The CSS rotation + rotated bounding box for one device orientation, given
 * the frame's base (framebuffer) width/height in the same units.
 */
export interface SimOrientationLayout {
  /** CSS rotation to apply to the stream img (deg; negative = counter-clockwise). */
  rotationDeg: number
  /** Width of the DISPLAYED (rotated) bounding box. */
  displayW: number
  /** Height of the DISPLAYED (rotated) bounding box. */
  displayH: number
}

/**
 * Map one device orientation to the display transform for a base w×h frame:
 * the ±90° cases swap the axes, 180° keeps them, and anything unknown
 * (undefined/malformed) degrades to the portrait identity.
 */
export function simOrientationLayoutOf(
  orientation: string | undefined,
  baseW: number,
  baseH: number,
): SimOrientationLayout {
  switch (orientation) {
    case 'landscape_left':
      return { rotationDeg: 90, displayW: baseH, displayH: baseW }
    case 'landscape_right':
      return { rotationDeg: -90, displayW: baseH, displayH: baseW }
    case 'portrait_upside_down':
      return { rotationDeg: 180, displayW: baseW, displayH: baseH }
    default:
      return { rotationDeg: 0, displayW: baseW, displayH: baseH }
  }
}

/** The known display orientation id (unknown/garbage → 'portrait'). */
export function simDisplayOrientationIdOf(orientation: string | undefined): SimDisplayOrientation {
  return SIM_DISPLAY_ORIENTATIONS.includes(orientation ?? '')
    ? orientation as SimDisplayOrientation
    : 'portrait'
}

/**
 * The exact inverse of the CSS counter-rotation: convert a point normalized
 * to the DISPLAYED (rotated) box — what `normalizePointerPoint` yields for a
 * pointer event over the rotated wrapper — back into framebuffer-normalized
 * coordinates for the serve-sim touch frames (tag 3).
 *
 * The mapping is derived from rotating the base rect about its center:
 * - `landscape_left` (img rotate 90°):  fb = (dy, 1 - dx)
 * - `landscape_right` (img rotate -90°): fb = (1 - dy, dx)
 * - `portrait_upside_down` (rotate 180°): fb = (1 - dx, 1 - dy)
 * - `portrait`/unknown: identity.
 * Asymmetric sizes drop out — the function works in the unit square, exactly
 * like the wire's normalized touch coordinates.
 */
export function simFramebufferPointOf(
  orientation: string | undefined,
  displayed: SimPoint,
): SimPoint {
  switch (orientation) {
    case 'landscape_left':
      return { x: displayed.y, y: 1 - displayed.x }
    case 'landscape_right':
      return { x: 1 - displayed.y, y: displayed.x }
    case 'portrait_upside_down':
      return { x: 1 - displayed.x, y: 1 - displayed.y }
    default:
      return { x: displayed.x, y: displayed.y }
  }
}
