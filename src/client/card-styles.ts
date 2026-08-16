/**
 * Inline styles for the dsh-ios cards. Same mechanism as dsh-openpencil:
 * plain inline style objects over the host's `--ui-*` CSS variables, so the
 * cards track the active theme without a CSS framework.
 */

import type { CSSProperties } from 'react'

const BORDER = 'var(--ui-border, rgba(128,128,128,0.35))'
const MUTED = 'var(--ui-text-muted, #888)'
const ACCENT = 'var(--ui-accent, #0ea5e9)'

export const CARD_STYLES: Record<string, CSSProperties> = {
  card: {
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    overflow: 'hidden',
    background: 'var(--ui-card-bg, transparent)',
    fontFamily: 'inherit',
    color: 'var(--ui-text, inherit)',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    borderBottom: '1px solid var(--ui-border, rgba(128,128,128,0.2))',
  },
  title: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** Small secondary action sub-label right after the title (启动/截图/交互/
   * 构建运行 · Boot/Screenshot/Interact/Build & Run) — distinguishes which
   * action a card belongs to under the unified "iOS 模拟器" title. */
  action: {
    flex: 'none',
    fontSize: 11,
    fontWeight: 400,
    color: MUTED,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headDevice: {
    fontSize: 12,
    fontWeight: 400,
    color: MUTED,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** Non-interactive "opens the sidebar" cue — the row click itself opens
   * the panel, so this must NOT swallow the click (no button/link roles). */
  openInPanel: {
    marginLeft: 'auto',
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: ACCENT,
    whiteSpace: 'nowrap',
  },
  badge: {
    fontSize: 11,
    padding: '1px 8px',
    borderRadius: 99,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  badgeOk: { background: 'rgba(34,197,94,0.15)', color: '#16a34a' },
  badgeError: { background: 'rgba(239,68,68,0.15)', color: '#dc2626' },
  badgeRunning: { background: 'rgba(100,116,139,0.15)', color: '#64748b' },
  body: { padding: '4px 10px 8px' },
  meta: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 6,
    fontSize: 12,
    color: MUTED,
  },
  muted: { fontSize: 12, color: MUTED },
  pre: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    fontSize: 12,
    margin: 0,
    maxHeight: '24em',
    overflow: 'auto',
  },
  button: {
    color: ACCENT,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    font: 'inherit',
    fontSize: 12,
  },
  primaryButton: {
    border: `1px solid ${ACCENT}`,
    borderRadius: 6,
    color: ACCENT,
    background: 'transparent',
    padding: '4px 9px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 12,
  },
  loading: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' },
  fallback: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 6,
    padding: '12px',
    borderRadius: 6,
    border: '1px solid var(--ui-border, rgba(128,128,128,0.25))',
    background: 'rgba(128,128,128,0.06)',
    fontSize: 12,
  },
  fallbackTitle: { fontSize: 13, fontWeight: 600 },
  keyValue: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12 },
  key: { color: MUTED },
  value: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
}

/** The stream/screenshot frame: dark console-like backdrop in both schemes. */
export function mediaFrameStyles(_colorScheme: 'light' | 'dark'): CSSProperties {
  return {
    maxHeight: 420,
    overflow: 'hidden',
    borderRadius: 8,
    border: '1px solid var(--ui-border, rgba(128,128,128,0.25))',
    background: 'var(--ui-media-bg, #16161a)',
    display: 'flex',
    flexDirection: 'column',
  }
}

export function streamImageStyles(): CSSProperties {
  return {
    display: 'block',
    maxWidth: '100%',
    maxHeight: 420,
    margin: '0 auto',
    objectFit: 'contain',
    userSelect: 'none',
    touchAction: 'none',
    cursor: 'crosshair',
    background: 'var(--ui-media-bg, #16161a)',
  }
}

export const STREAM_TOOLBAR_STYLES: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderTop: '1px solid var(--ui-border, rgba(128,128,128,0.2))',
}

export const SCREENSHOT_IMAGE_STYLES: CSSProperties = {
  display: 'block',
  maxWidth: '100%',
  maxHeight: 420,
  margin: '0 auto',
  objectFit: 'contain',
  borderRadius: 8,
  border: '1px solid var(--ui-border, rgba(128,128,128,0.25))',
  background: 'var(--ui-media-bg, #16161a)',
}

/**
 * Panel-variant styles for the shared live frame: the stream fills the phone
 * screen provided by the panel (no card chrome), so the frame is a full-bleed
 * column. The panel's actions live in the panel chrome's own top toolbar
 * (see sim-panel.tsx), not inside the frame.
 *
 * The stage carries NO background of its own: the phone screen div provides
 * the backdrop (black in bezel/device, transparent in frameless — see
 * simPhoneScreenStyles in sim-panel.tsx), so frameless mode never leaks a
 * dark layer between the frame wrapper and the stream img.
 */
export const PANEL_STREAM_STAGE_STYLES: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  minHeight: 0,
  overflow: 'hidden',
}

/**
 * The rotation wrapper inside the panel's phone screen: it is sized to the
 * rotated bounding box via its `aspectRatio` (set per orientation by the
 * live-frame body — the ±90° orientations swap the axes), so the counter-
 * rotated img inside (whose pre-rotation box is sized per orientation, see
 * PANEL_STREAM_ROTATION_IMG_STYLES) fills it edge-to-edge. Pointer events
 * land on this box: its bounds are the DISPLAYED box the stream session
 * inverse-maps back into framebuffer coordinates.
 */
export const PANEL_STREAM_ROTATION_BOX_STYLES: CSSProperties = {
  position: 'relative',
  width: '100%',
  flex: 'none',
  touchAction: 'none',
  cursor: 'crosshair',
}

/**
 * The stream img inside the rotation wrapper — the props shared by every
 * orientation: absolutely positioned, `fill` (NOT `contain` — see the WHY
 * below), and a transform-ONLY 200ms transition so an orientation change
 * animates instead of snapping. The transition stays scoped to `transform`
 * on purpose: the box position/size and the wrapper's aspect ratio change
 * in the same React commit, so animating the box too would start from stale
 * pre-commit sizes and jank.
 *
 * WHY `objectFit: 'fill'` is safe here (do not "fix" it back to `contain`):
 * the rotation wrapper's `aspectRatio` IS the framebuffer's aspect —
 * `displayW / displayH` = naturalW / naturalH, and the WP19 landscape math
 * sizes the pre-rotation box to the same ratio — so the img's box can never
 * deviate from the stream's aspect. `fill` and `contain` therefore draw the
 * exact same picture, except that `contain` resolves any sub-pixel
 * box/device-pixel mismatch by leaving the slack on ONE side; at 2× DPR
 * that one-sided hair paints the adjacent bezel rim a physical pixel
 * thicker on that side (the reported left/right rim asymmetry). `fill`
 * stretches the img edge-to-edge into the box, so residual fractional slack
 * distributes symmetrically and both rims stay even.
 *
 * No background of its own: the screen's backdrop (black under a shell,
 * transparent in frameless — see simPhoneScreenStyles in sim-panel.tsx)
 * shows through wherever a letterbox could appear, so frameless mode stays
 * bare.
 *
 * The PRE-rotation box position/size is orientation-dependent and is
 * composed in sim-live-frame.tsx:
 * - portrait / 180°: `PANEL_STREAM_ROTATION_IMG_FILL_STYLES` — inset 0, the
 *   pre-rotation box IS the wrapper box (180° rotates in place);
 * - ±90°: `panelStreamRotationImgSwappedStyles` — the pre-rotation box
 *   carries the SWAPPED wrapper dims (width = wrapper height, height =
 *   wrapper width), centered at left/top 50%, so the counter-rotated img's
 *   bounding box is exactly the wrapper and the stream fills the phone
 *   screen edge-to-edge (no scaled-down island in the bezel's center).
 */
export const PANEL_STREAM_ROTATION_IMG_STYLES: CSSProperties = {
  position: 'absolute',
  objectFit: 'fill',
  userSelect: 'none',
  touchAction: 'none',
  transformOrigin: 'center',
  transition: 'transform 200ms ease',
}

/**
 * Portrait / 180° fill: the pre-rotation box IS the wrapper box, so the
 * stream fills it exactly — the byte-identical style set the portrait img
 * has always carried (inset 0 + full width/height).
 */
export const PANEL_STREAM_ROTATION_IMG_FILL_STYLES: CSSProperties = {
  inset: 0,
  width: '100%',
  height: '100%',
}

/**
 * The ±90° PRE-rotation box: width = wrapper HEIGHT, height = wrapper WIDTH
 * (the swapped displayed dims, expressed as percentages of the wrapper's own
 * width/height), anchored at the wrapper's center by left/top 50% — the
 * `translate(-50%, -50%)` leg of the img's transform then centers the box
 * before the rotation. After rotate(±90deg) about the box center the rotated
 * bounding box is exactly displayW × displayH = the wrapper, so the stream
 * fills it edge-to-edge with zero layout letterboxing.
 *
 * Percent math: wrapperH = wrapperW × displayH/displayW (the wrapper's
 * aspect-ratio is displayW/displayH), so
 *   width  = displayH/displayW × wrapperW = wrapperH,
 *   height = displayW/displayH × wrapperH = wrapperW.
 */
export function panelStreamRotationImgSwappedStyles(displayW: number, displayH: number): CSSProperties {
  return {
    left: '50%',
    top: '50%',
    width: `${(100 * displayH / displayW).toFixed(4)}%`,
    height: `${(100 * displayW / displayH).toFixed(4)}%`,
  }
}

/**
 * The panel's screenshot img: fills the phone screen. `contain` STAYS here
 * (unlike the stream img above): this img does NOT live inside the
 * aspect-enforcing rotation wrapper, so its box aspect is not guaranteed —
 * screenshot mode never reports a natural HEIGHT, so the phone screen's
 * aspect derives from the 390:844 fallback shape and matches the PNG only
 * for 390:844-ratio devices. `fill` would stretch any other device's
 * screenshot; `contain` preserves it, and the snapped integer frame width
 * keeps the horizontal slack symmetric anyway. No background of its own —
 * letterbox bars show the screen's backdrop (black under a shell,
 * transparent in frameless — see simPhoneScreenStyles in sim-panel.tsx), so
 * frameless mode stays bare.
 */
export const PANEL_SCREENSHOT_IMAGE_STYLES: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'contain',
}

/** Centered loading / fallback bodies inside the phone screen. */
export const PANEL_LOADING_STYLES: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 16,
  textAlign: 'center',
}

export const PANEL_FALLBACK_STYLES: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 16,
  textAlign: 'center',
  fontSize: 12,
}
