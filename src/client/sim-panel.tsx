/**
 * The persistent simulator panel body — device header, a compact top
 * toolbar (segmented size quick pill [Fit/适应] [100%] [S] [M] | divider |
 * an icon pill with Home/回到桌面 · Screenshot/截图 · Rotate/旋转 ·
 * Refresh/刷新 as stroke icons with hover tooltips — see sim-toolbar.tsx),
 * the phone-frame live stream (or screenshot), and the "● Live" indicator
 * (stream mode only; screenshot-mode panels hide the live/offline readout
 * entirely).
 *
 * The chrome follows the DSH theme with the exact tokens dsh-openpencil's
 * editor panel uses (`--dsw-alias-*` — see editor-panel.tsx there): the
 * panel background, header border, toolbar, captions and status text all
 * track the active light/dark theme through those variables, so the panel
 * looks native-light in light theme and native-dark in dark theme. Only the
 * phone bezel stays a literal dark device frame (the allowed exception).
 *
 * The display size is controlled by `SimPanelSizeMode` (sim-panel-size.ts):
 * fit (default) / percent / preset, selected with a compact dropdown in the
 * panel header AND one-tap quick buttons in the toolbar. Both controls
 * dispatch the same store transition (the store's `sizeMode` is the single
 * source of truth), so quick button and dropdown stay in sync. The frame
 * reports the stream/screenshot's natural pixel width up through
 * `onNaturalSize` so the percent mode can use the device's logical point
 * width (natural px / 3) as its 100% basis.
 *
 * Device rotation: the simulator framebuffer stays portrait-sized regardless
 * of orientation, so when serve-sim reports landscape_left/right the panel
 * counter-rotates the stream img (CSS transform, ~200ms transition) inside a
 * wrapper sized to the rotated bounding box, and the phone bezel follows as
 * a wide frame (screen axes swapped). In landscape, the size modes' "width"
 * semantics apply to the DISPLAYED (rotated) width — see sim-orientation.ts
 * and simPanelDisplayLogicalWidthOf. Screenshot-mode panels skip all of this
 * (simctl PNGs are already orientation-correct).
 *
 * Toolbar actions: Home sends the tag-4 button frame over the shared
 * control ws; Rotate advances the device orientation clockwise via the
 * tag-7 frame (serve-sim 0.1.45, tracked off the tag-130 config frame);
 * Screenshot POSTs `/_dsh/dsh-ios/capture` for a FRESH PNG of the current
 * device and opens the signed URL in a new tab with a transient 已截图
 * confirmation (see sim-panel-capture.ts); Refresh re-grants the stream.
 * Since WP21 they render as ICON buttons (inline stroke SVGs, see
 * sim-toolbar.tsx) grouped in one rounded pill container with hover/focus
 * tooltips, and the size quick buttons share the same pill language as a
 * borderless segmented group.
 *
 * `SimulatorPanel` is the connected surface (grant/stream sessions via the
 * shared hooks); `SimulatorPanelBody`, `SimPhoneFrame`, `SimLiveIndicator`,
 * `SimLiveFrameBody`, and `SimScreenshotFrameBody` are pure presentation the
 * dev-panel-smoke script server-renders phase by phase without a browser or
 * network. The same body renders inside the plugin-owned right panel host
 * (rc.6 fallback surface) and inside the per-tool `tool.details.toolview`
 * seat when a future DSH runtime declares it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { simCopy, type SimCopy, type SimLocale } from './copy.js'
import {
  IOS_SIM_CARD_TOOLS,
  type SimDeviceInfo,
  type SimFetcher,
  type SimScreenshotMeta,
  type SimStreamMeta,
  type SimWsFactory,
} from './protocol.js'
import { resolveSimMeta } from './sim-meta-hydrate.js'
import { SimLiveFrameBody } from './sim-live-frame.js'
import { useSimScreenshot } from './sim-screenshot-session.js'
import { useSimStream } from './sim-stream-session.js'
import { useSimCapture, type SimCapturePhase } from './sim-panel-capture.js'
import type { CompatibleToolDetailsViewProps } from './details-compat.js'
import {
  CARD_STYLES,
  PANEL_FALLBACK_STYLES,
  PANEL_LOADING_STYLES,
  PANEL_SCREENSHOT_IMAGE_STYLES,
} from './card-styles.js'
import {
  SIM_PANEL_DEVICE_SCALE,
  SIM_PANEL_QUICK_SIZE_OPTIONS,
  SIM_PANEL_SIZE_MODE_FIT,
  SIM_PANEL_SIZE_OPTIONS,
  simPanelFrameLayoutOf,
  simPanelFrameWidthOf,
  simPanelSizeModeIdOf,
  simPanelSizeModeOf,
  simPanelSnapPxOf,
  type SimPanelSizeMode,
} from './sim-panel-size.js'
import {
  SIM_FRAME_BEZEL_SHELL,
  SIM_FRAME_DEVICE_SHELL,
  SIM_FRAME_RADIUS_FALLBACK_PX,
  SIM_FRAME_SHELL_BORDER_PX,
  SIM_FRAME_STYLE_BEZEL,
  SIM_FRAME_STYLE_OPTIONS,
  simFrameStyleLabelOf,
  simPanelFrameRadiusFallbackOf,
  simPanelScreenBoxOf,
  simPanelScreenRadiusOf,
  simPanelScreenWidthOf,
  simPanelShellRadiusOf,
  type SimFrameStyle,
} from './sim-frame-style.js'
import {
  SIM_TOOLBAR_STYLES,
  SimSizeQuickSegment,
  SimToolbarIconButton,
} from './sim-toolbar.js'

/**
 * Panel chrome styles over the DSH theme tokens openpencil's editor panel
 * uses (no literal colors — the host's `--dsw-alias-*` variables resolve per
 * theme; the phone bezel below is the one deliberate dark device surface).
 * Exported so the static smoke can assert the token usage directly.
 */
export const PANEL_STYLES: Record<string, CSSProperties> = {
  root: {
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-base)',
    fontFamily: 'inherit',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 'none',
    padding: '10px 12px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  titleCluster: {
    minWidth: 0,
    marginRight: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    overflow: 'hidden',
  },
  title: {
    fontSize: 14,
    lineHeight: '18px',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  subtitle: {
    fontSize: 12,
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sizeControl: {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
  },
  sizeSelect: {
    maxWidth: 108,
    minHeight: 26,
    padding: '2px 6px',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 12,
    lineHeight: 1.4,
  },
  frameStyleControl: {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    overflow: 'hidden',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l2)',
  },
  frameStyleButton: {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 24,
    padding: '2px 7px',
    border: 'none',
    borderRadius: 0,
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 12,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  },
  frameStyleButtonActive: {
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    fontWeight: 600,
  },
  closeButton: {
    flex: 'none',
    width: 26,
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 6,
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-layer-1)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 16,
    lineHeight: 1,
    padding: 0,
  },
  stage: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--dsw-alias-bg-base)',
  },
  toolbar: {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    padding: '4px 12px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  // The size quick group and the action icon pill (their borders,
  // backgrounds, hover/active fills and the tooltip bubble) live in
  // SIM_TOOLBAR_STYLES (sim-toolbar.tsx) — one shared pill recipe.
  toolbarDivider: {
    flex: 'none',
    alignSelf: 'stretch',
    width: 1,
    margin: '0 2px',
    background: 'var(--dsw-alias-border-l2)',
  },
  captureToast: {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 24,
    padding: '2px 8px',
    borderRadius: 99,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 12,
    lineHeight: 1.4,
  },
  unavailable: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    textAlign: 'center',
  },
}

/**
 * The phone bezel — the one deliberately dark device surface (a bezel is a
 * device frame, not a panel surround), exported so the smoke can allow-list
 * it. The screen inside stays black: it is the device display. The outer
 * corner radius is applied per render (screen radius + the 6px rim, see
 * `simPanelShellRadiusOf`) so the inset screen stays concentric at every
 * displayed size. The 1px border is part of the rim: the screen-width
 * derivation subtracts it together with the padding (`simPanelScreenWidthOf`
 * / `SIM_FRAME_SHELL_BORDER_PX`), so left/right rims measure pad+border.
 */
export const PHONE_BEZEL_STYLES: CSSProperties = {
  width: '100%',
  maxWidth: 300,
  margin: '0 auto',
  boxSizing: 'border-box',
  // Slim device rim: 6px on every side (was 9px), plus the 1px edge border.
  padding: SIM_FRAME_BEZEL_SHELL,
  background: '#0b0b0e',
  border: `${SIM_FRAME_SHELL_BORDER_PX}px solid rgba(255,255,255,0.08)`,
  boxShadow: '0 18px 50px rgba(0,0,0,0.5)',
}

/**
 * Frameless mode (无框): no shell at all. The wrapper is a bare sizing
 * element ONLY — no padding, no background, no border, no shadow, no clip:
 * the screen div below IS the content box and carries the proportional
 * corner clip directly, so no black layer can ever peek out around the
 * stream. The whole size-mode width goes to content.
 */
export const FRAMELESS_FRAME_STYLES: CSSProperties = {
  width: '100%',
  maxWidth: 300,
  margin: '0 auto',
  boxSizing: 'border-box',
  padding: 0,
}

/**
 * Device frame mode (真机框): a realistic CSS-only device shell modeled on
 * serve-sim's own preview page aesthetic — a thicker 16px shell with a
 * subtle dark metallic gradient, a 1px lighter inner edge highlight where
 * the shell meets the screen (inset box-shadow), and the slim bezel's soft
 * drop shadow. The outer corner radius is applied per render (screen radius
 * + the 16px shell — the same concentric relation the slim bezel keeps),
 * and the side-button nubs (see DEVICE_SIDE_BUTTONS) anchor to this
 * wrapper's relative positioning.
 */
export const DEVICE_FRAME_STYLES: CSSProperties = {
  width: '100%',
  maxWidth: 300,
  margin: '0 auto',
  boxSizing: 'border-box',
  position: 'relative',
  padding: SIM_FRAME_DEVICE_SHELL,
  background: 'linear-gradient(145deg, #2b2e35 0%, #101116 45%, #1c1e25 100%)',
  border: `${SIM_FRAME_SHELL_BORDER_PX}px solid rgba(0,0,0,0.6)`,
  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12), 0 18px 50px rgba(0,0,0,0.55)',
}

/** One side-button nub shared by all four buttons (color is the shell's
 * lighter metallic mid-tone, like a real frame's hardware accents). */
const DEVICE_SIDE_BUTTON_BASE: CSSProperties = {
  position: 'absolute',
  width: 3,
  borderRadius: 2,
  background: '#3a3d44',
  boxShadow: '0 1px 2px rgba(0,0,0,0.5)',
}

/**
 * The device frame's side-button nubs, positioned proportionally along the
 * frame's height (portrait proportions): a short mute switch and the two
 * volume buttons on the LEFT edge, the taller power button on the RIGHT —
 * each protruding ~2px past the shell edge. Buttons render only in portrait
 * (see SimPhoneFrame); in landscape the wide frame's edges correspond to
 * the device's top/bottom, and rotating the nubs to the new edges would
 * need a second rotated coordinate system for what is a purely decorative
 * detail, so they are omitted there.
 */
const DEVICE_SIDE_BUTTONS: readonly { id: string; side: 'left' | 'right'; style: CSSProperties }[] = [
  { id: 'mute', side: 'left', style: { ...DEVICE_SIDE_BUTTON_BASE, left: -2, top: '21%', height: 16 } },
  { id: 'volume-up', side: 'left', style: { ...DEVICE_SIDE_BUTTON_BASE, left: -2, top: '34%', height: 36 } },
  { id: 'volume-down', side: 'left', style: { ...DEVICE_SIDE_BUTTON_BASE, left: -2, top: '47%', height: 36 } },
  { id: 'power', side: 'right', style: { ...DEVICE_SIDE_BUTTON_BASE, right: -2, top: '36%', height: 52 } },
]

/**
 * The bezel with one size mode applied: the width comes from the pure
 * `simPanelFrameWidthOf` helper and the base max-width clamp is removed so
 * fit/percent/preset widths are exact (overflow scrolls the panel stage).
 * `frameStyle` picks the shell around the screen — the width computation is
 * identical for all three modes, so the size-mode geometry never changes,
 * only the rim around the screen does. `screenRadius` (the displayed
 * screen's corner radius, see sim-frame-style.ts) drives each shell's outer
 * radius; it defaults to the 390×844 fallback radius for standalone calls.
 *
 * Percent mode's basis follows the device ORIENTATION: `naturalHeight` +
 * `orientation` (the same pair SimPhoneFrame uses for the rotation math)
 * feed the displayed layout, so a landscape device's 100% is its landscape
 * logical width (natural height / 3), while portrait keeps the natural
 * width basis. Without them the pure function still degrades to the
 * orientation-free portrait basis (`simDeviceLogicalWidthOf`) — callers that
 * know the display must thread the orientation pair through, otherwise a
 * landscape 100% frame would collapse to the portrait fallback width.
 * Presets use the same displayed layout: the preset px is the device's
 * SHORT-side size, so landscape scales it by the displayed width/height
 * ratio (landscape S = 240 × 874/402 ≈ 522px, snapped — see
 * `simPanelFrameWidthOf`).
 *
 * Fit mode resolves `100%` against the stage's content box, which can be
 * FRACTIONAL after a panel drag-resize. `measuredFitWidth` (snapped to a
 * whole CSS px by SimPhoneFrame's ResizeObserver — see simPanelSnapPxOf)
 * replaces the `100%` once measured, so the frame's border-box lands on the
 * device-pixel grid and its left/right padding + border rims rasterize
 * symmetrically; the ≤0.5px remainder splits evenly under `margin: 0 auto`.
 */
export function simPanelFrameStyles(
  mode: SimPanelSizeMode,
  naturalWidth: number | undefined,
  frameStyle: SimFrameStyle = SIM_FRAME_STYLE_BEZEL,
  screenRadius: number = SIM_FRAME_RADIUS_FALLBACK_PX,
  measuredFitWidth?: number,
  naturalHeight?: number,
  orientation?: string,
): CSSProperties {
  const shell = frameStyle === 'none'
    ? FRAMELESS_FRAME_STYLES
    : frameStyle === 'device'
      ? { ...DEVICE_FRAME_STYLES, borderRadius: simPanelShellRadiusOf(frameStyle, screenRadius) }
      : { ...PHONE_BEZEL_STYLES, borderRadius: simPanelShellRadiusOf(frameStyle, screenRadius) }
  const layout = simPanelFrameLayoutOf(orientation, naturalWidth, naturalHeight)
  return {
    ...shell,
    width: mode.kind === 'fit' && measuredFitWidth !== undefined && measuredFitWidth > 0
      ? `${measuredFitWidth}px`
      : simPanelFrameWidthOf(
          mode,
          naturalWidth,
          layout.displayW / SIM_PANEL_DEVICE_SCALE,
          // Displayed width/height ratio: presets scale by it in landscape
          // (short-side semantics — landscape S = 240 × 874/402 ≈ 522px).
          layout.displayW / layout.displayH,
        ),
    maxWidth: 'none',
  }
}

const PHONE_SCREEN_STYLES: CSSProperties = {
  position: 'relative',
  // BORDER-BOX sizing: the screen's width:100% resolves against the frame's
  // CONTENT box, and the 1px hairline border below must paint INSIDE it —
  // with the default content-box sizing the border box grew 2px past the
  // content box, overflowed into the right padding/border and the right rim
  // measured 5px against the left's 7px (WP27 bezel-rim asymmetry). The
  // rendered screen box is therefore exactly frame − 2×(pad+border), the
  // same value `simPanelScreenWidthOf` derives for the radius basis.
  boxSizing: 'border-box',
  width: '100%',
  aspectRatio: '390 / 844',
  display: 'flex',
  flexDirection: 'column',
  // The screen corner radius is applied per render — proportional to the
  // DISPLAYED screen box (see SimPhoneFrame + sim-frame-style.ts); every
  // shell derives its outer radius from the same value, so the corners stay
  // concentric at any size and orientation.
  overflow: 'hidden',
  background: '#000',
  border: '1px solid rgba(255,255,255,0.06)',
}

/**
 * The inset screen for one frame style. Bezel and device keep the classic
 * screen (black device display, hairline edge highlight, proportional
 * radius concentric with the shell's outer radius). Frameless has NO black
 * layers at all: the background goes transparent and the border drops, so
 * the screen IS the bare content box and its radius IS the only rounding —
 * no rim can peek out around the stream by antialias/letterbox mismatch.
 */
function simPhoneScreenStyles(frameStyle: SimFrameStyle, screenRadius: number): CSSProperties {
  return frameStyle === 'none'
    ? { ...PHONE_SCREEN_STYLES, background: 'transparent', border: 'none', borderRadius: screenRadius }
    : { ...PHONE_SCREEN_STYLES, borderRadius: screenRadius }
}

/**
 * Minimal CSS phone frame: rounded bezel, dark surround, inset screen —
 * plus the per-mode shells: `none` (bare content — the screen box itself
 * carries the proportional clip, with NO background/border layers around
 * it), `bezel` (slim 6px dark rim, DEFAULT), `device` (16px metallic
 * gradient shell with concentric corners, inner edge highlight, and
 * side-button nubs in portrait). Sized by the active `sizeMode`: fit fills
 * the stage width (the panel's drag-resize therefore scales the simulator),
 * percent/preset use the computed pixel width from `simPanelFrameWidthOf` —
 * against the DISPLAYED logical width, so in landscape the frame follows
 * the device as a wide frame (screen axes swapped via the orientation
 * layout). The width, aspect ratio, stream fill, and pointer mapping are
 * IDENTICAL across all three modes: only the shell around the screen
 * changes.
 *
 * Corner radii follow the native Simulator.app proportion (55/390 of the
 * displayed screen's short side). Percent/preset widths are deterministic
 * px values, so their radius derives from props exactly on every render
 * (SSR included — no measurement needed) — both through the same
 * `simPanelScreenWidthOf` screen-box derivation (frame width −
 * 2×(padding + border)), so the radius basis always matches the rendered
 * screen box. Presets are orientation-aware short-side sizes, and the
 * radius follows the resulting displayed box in both orientations. Fit
 * mode's 100% width is only known to the DOM: a mount-time measure plus a
 * ResizeObserver keeps two things live — (a) the measured screen radius,
 * and (b) the fit frame's SNAPPED integer width (see `simPanelSnapPxOf`):
 * the 100% width resolves against the stage's content box, which can be
 * fractional after a panel drag-resize, and a fractional border-box would
 * round differently at each device-pixel edge at 2× DPR — one bezel side
 * gains a physical pixel. The snapped width makes the frame's computed
 * width an integer, so `margin: 0 auto` splits the leftover evenly and
 * both rims render symmetrically. Radius updates are style-only: the
 * children (stream/screenshot img) are never remounted, so the stream
 * never reconnects on resize.
 */
export function SimPhoneFrame({
  children,
  sizeMode = SIM_PANEL_SIZE_MODE_FIT,
  naturalWidth,
  naturalHeight,
  orientation,
  frameStyle = SIM_FRAME_STYLE_BEZEL,
}: {
  children: ReactNode
  sizeMode?: SimPanelSizeMode
  naturalWidth?: number
  /** Natural pixel height of the current stream frame (rotation base). */
  naturalHeight?: number
  /** Device orientation from the serve-sim config frames (tag 130). */
  orientation?: string
  /** Frame shell mode (defaults to the slim bezel). */
  frameStyle?: SimFrameStyle
}): React.JSX.Element {
  const layout = simPanelFrameLayoutOf(orientation, naturalWidth, naturalHeight)
  const width = simPanelFrameWidthOf(
    sizeMode,
    naturalWidth,
    layout.displayW / SIM_PANEL_DEVICE_SCALE,
    // Displayed width/height ratio: orientation-aware presets scale by it
    // in landscape (short-side semantics — landscape S ≈ 522px for the
    // 402×874pt display).
    layout.displayW / layout.displayH,
  )
  // The ±90° orientations make the frame a wide (landscape) shell. The
  // device side buttons are positioned for the portrait proportions; in
  // landscape the frame's left/right edges become the device's top/bottom,
  // so the nubs are omitted there (rotating them onto the correct edges
  // would need a second rotated coordinate system for a purely decorative
  // detail).
  const landscape = layout.rotationDeg === 90 || layout.rotationDeg === -90
  const frameRef = useRef<HTMLDivElement | null>(null)
  // Fit mode's 100% width resolves against the STAGE's content box, which
  // can be fractional (the panel drag-resize width is not an integer
  // multiple of the screen aspect); the measure below snaps it to a whole
  // CSS px and applies it as the frame's explicit border-box width so the
  // screen box, the rotation wrapper and the img box all land on integer
  // pixels — the 6px left/right rims then rasterize symmetrically at 2×
  // DPR instead of one side gaining a physical pixel. The ≤0.5px remainder
  // splits evenly under `margin: 0 auto`.
  const [fitWidth, setFitWidth] = useState<number>()
  // The measured screen radius (fit mode only — see below). Initialized to
  // the device's natural display corner; the mount measure + ResizeObserver
  // below keep it live without ever touching the stream img.
  const [measuredRadius, setMeasuredRadius] = useState<number>(() =>
    simPanelFrameRadiusFallbackOf(orientation, naturalWidth, naturalHeight))
  useEffect(() => {
    const node = frameRef.current
    if (node === null) return
    // The frame sits directly inside the panel stage; its fit width is the
    // stage's content box width (what `width: 100%` resolves against —
    // clientWidth/contentRect both exclude the stage's padding and any
    // vertical scrollbar).
    const stage = node.parentElement
    const measure = (): void => {
      // The frame's border box minus the shell's padding AND border is the
      // screen box in every shell mode (the screen renders border-box at
      // 100% width) — derived through the same `simPanelScreenWidthOf`
      // helper the percent/preset modes use, so the measured radius basis
      // and the visible screen box can never drift apart (the old
      // padding-only math ate the right rim's border px). The box is
      // snapped to whole CSS px before the radius math (WP22) so the radius
      // follows the same integer grid the rims do.
      const rect = node.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setMeasuredRadius(simPanelScreenRadiusOf(
          simPanelScreenWidthOf(rect.width, frameStyle),
          simPanelScreenWidthOf(rect.height, frameStyle),
        ))
      }
      if (stage !== null) {
        const stageComputed = getComputedStyle(stage)
        const stagePadX = Number.parseFloat(stageComputed.paddingLeft) + Number.parseFloat(stageComputed.paddingRight)
        const stageBorderX = Number.parseFloat(stageComputed.borderLeftWidth) + Number.parseFloat(stageComputed.borderRightWidth)
        const stageContentW = stage.clientWidth - stagePadX - stageBorderX
        if (stageContentW > 0) setFitWidth(simPanelSnapPxOf(stageContentW))
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    // Observe BOTH: the stage drives the fit width on panel drag-resize
    // (after the snapped px width replaces `100%`, the frame no longer
    // tracks the stage on its own), and the frame re-measures the screen
    // box for the radius once the snapped width lands.
    observer.observe(node)
    if (stage !== null) observer.observe(stage)
    return () => { observer.disconnect() }
  }, [frameStyle])
  // Percent/preset modes have an exact px width: derive the radius from
  // props (deterministic SSR + instant on size-mode/orientation changes).
  // Fit falls back to the measured value.
  const screenBox = simPanelScreenBoxOf(sizeMode, naturalWidth, naturalHeight, orientation, frameStyle)
  const screenRadius = screenBox !== undefined
    ? simPanelScreenRadiusOf(screenBox.width, screenBox.height)
    : measuredRadius
  const shellRadius = simPanelShellRadiusOf(frameStyle, screenRadius)
  return (
    <div
      ref={frameRef}
      style={simPanelFrameStyles(sizeMode, naturalWidth, frameStyle, screenRadius, fitWidth, naturalHeight, orientation)}
      data-sim-phone-frame="true"
      data-sim-phone-frame-style={frameStyle}
      data-sim-phone-width={width}
      data-sim-shell-radius={shellRadius}
    >
      {frameStyle === 'device' && !landscape ? DEVICE_SIDE_BUTTONS.map(button => (
        <span
          key={button.id}
          style={button.style}
          aria-hidden="true"
          data-sim-device-button={button.id}
          data-sim-device-side={button.side}
        />
      )) : null}
      <div
        style={{ ...simPhoneScreenStyles(frameStyle, screenRadius), aspectRatio: `${layout.displayW} / ${layout.displayH}` }}
        data-sim-phone-screen="true"
        data-sim-phone-aspect={`${layout.displayW} / ${layout.displayH}`}
        data-sim-screen-radius={screenRadius}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * "● Live" / gray "Offline" readout under the frame. The text color follows
 * the theme token; only the dot keeps its literal green/gray state colors.
 * Exported for the smoke's token assertions.
 */
export const PANEL_LIVE_INDICATOR_STYLES: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '4px 12px 12px',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

export function SimLiveIndicator({ open, locale }: { open: boolean; locale: SimLocale }): React.JSX.Element {
  const copy = simCopy(locale)
  return (
    <div
      style={PANEL_LIVE_INDICATOR_STYLES}
      role="status"
      data-sim-live-indicator={open ? 'live' : 'offline'}
    >
      <span
        aria-hidden="true"
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: open ? '#22c55e' : '#9ca3af',
          ...(open ? { boxShadow: '0 0 8px rgba(34,197,94,0.8)' } : {}),
        }}
      />
      <span>{open ? copy.panelLive : copy.offline}</span>
    </div>
  )
}

export type SimPanelMode = 'stream' | 'screenshot' | 'unavailable'

/** aria-label for one quick-size button (full copy per size, both locales). */
function simQuickSizeAriaLabel(id: string, copy: SimCopy): string {
  switch (id) {
    case 'fit': return copy.sizeQuickFit
    case 'percent-100': return copy.sizeQuickPercent100
    case 'preset-S': return copy.sizeQuickS
    case 'preset-M': return copy.sizeQuickM
  }
  return copy.sizeMode
}

export interface SimulatorPanelBodyProps {
  title: string
  device: SimDeviceInfo | undefined
  mode: SimPanelMode
  liveOpen: boolean
  colorScheme: 'light' | 'dark'
  locale: SimLocale
  onClose?: () => void
  children: ReactNode
  /** Active display size mode (defaults to fit — see sim-panel-size.ts). */
  sizeMode?: SimPanelSizeMode
  /** Natural pixel width of the current stream/screenshot frame (percent basis). */
  naturalWidth?: number
  /** Natural pixel height of the current stream frame (rotation base; the
   * screenshot mode leaves it undefined — no rotation there). */
  naturalHeight?: number
  /** Device orientation from the serve-sim config frames (tag 130); the phone
   * frame swaps its screen axes for the ±90° orientations. */
  orientation?: string
  /** Size-mode dropdown change (absent → the dropdown still renders, inert). */
  onSizeModeChange?: (mode: SimPanelSizeMode) => void
  /** Active frame shell mode (defaults to the slim bezel — see
   * sim-frame-style.ts); the header's segmented control mirrors it. */
  frameStyle?: SimFrameStyle
  /** Frame-style control change (absent → the control still renders, inert). */
  onFrameStyleChange?: (style: SimFrameStyle) => void
  /** Toolbar actions — each button renders only when its handler is present
   * (Home/Rotate/Refresh are stream-session actions; Screenshot both modes). */
  onHome?: () => void
  onRotate?: () => void
  onScreenshot?: () => void
  onRefresh?: () => void
  /** Screenshot capture confirmation state (busy/done toast in the toolbar). */
  captureState?: SimCapturePhase
}

/** Pure panel chrome: header (device name + udid + size-mode dropdown +
 * frame-style segmented control), the compact top toolbar (segmented size
 * quick pill | icon pill with Home · Screenshot · Rotate · Refresh icons +
 * hover tooltips), the size-aware phone frame, and the Live dot. */
export function SimulatorPanelBody({
  title,
  device,
  mode,
  liveOpen,
  colorScheme,
  locale,
  onClose,
  children,
  sizeMode = SIM_PANEL_SIZE_MODE_FIT,
  naturalWidth,
  naturalHeight,
  orientation,
  onSizeModeChange,
  frameStyle = SIM_FRAME_STYLE_BEZEL,
  onFrameStyleChange,
  onHome,
  onRotate,
  onScreenshot,
  onRefresh,
  captureState = 'idle',
}: SimulatorPanelBodyProps): React.JSX.Element {
  const copy = simCopy(locale)
  const deviceParts = [device?.name, device?.udid].filter((part): part is string => part !== undefined && part !== '')
  const deviceLabel = deviceParts.join(' · ')
  const activeSizeModeId = simPanelSizeModeIdOf(sizeMode)
  return (
    <section
      style={PANEL_STYLES.root}
      data-sim-panel="true"
      data-sim-mode={mode}
      data-sim-color-scheme={colorScheme}
      role="complementary"
      aria-label={copy.simulator}
    >
      <div style={PANEL_STYLES.header} data-sim-panel-header="true">
        <div style={PANEL_STYLES.titleCluster}>
          <span style={PANEL_STYLES.title}>{title}</span>
          {deviceLabel !== '' ? <span style={PANEL_STYLES.subtitle}>{deviceLabel}</span> : null}
        </div>
        <div style={PANEL_STYLES.sizeControl}>
          <select
            style={PANEL_STYLES.sizeSelect}
            value={activeSizeModeId}
            onChange={event => { onSizeModeChange?.(simPanelSizeModeOf(event.currentTarget.value)) }}
            aria-label={copy.sizeMode}
            title={copy.sizeMode}
            data-sim-panel-size-mode="true"
          >
            {SIM_PANEL_SIZE_OPTIONS.map(option => (
              <option key={option.id} value={option.id}>
                {locale === 'zh' ? option.labelZh : option.labelEn}
              </option>
            ))}
          </select>
        </div>
        <div
          style={PANEL_STYLES.frameStyleControl}
          role="group"
          aria-label={copy.frameStyle}
          title={copy.frameStyle}
          data-sim-frame-style-control="true"
        >
          {SIM_FRAME_STYLE_OPTIONS.map(id => {
            const active = frameStyle === id
            const label = simFrameStyleLabelOf(id, copy)
            return (
              <button
                key={id}
                type="button"
                style={active
                  ? { ...PANEL_STYLES.frameStyleButton, ...PANEL_STYLES.frameStyleButtonActive }
                  : PANEL_STYLES.frameStyleButton}
                aria-pressed={active}
                aria-label={`${copy.frameStyle}: ${label}`}
                title={`${copy.frameStyle}: ${label}`}
                data-sim-frame-style={id}
                data-sim-frame-style-active={active ? 'true' : 'false'}
                onClick={() => { onFrameStyleChange?.(id) }}
              >
                {label}
              </button>
            )
          })}
        </div>
        {onClose !== undefined ? (
          <button
            type="button"
            style={PANEL_STYLES.closeButton}
            onClick={onClose}
            aria-label={copy.closePanel}
            data-sim-panel-close="true"
          >
            ×
          </button>
        ) : null}
      </div>
      <div
        style={PANEL_STYLES.toolbar}
        data-sim-panel-toolbar="true"
        role="toolbar"
        aria-label={copy.toolbar}
      >
        <div style={SIM_TOOLBAR_STYLES.sizeQuickGroup} role="group" aria-label={copy.sizeMode} data-sim-size-quick-group="true">
          {SIM_PANEL_QUICK_SIZE_OPTIONS.map(option => {
            const active = activeSizeModeId === option.id
            return (
              <SimSizeQuickSegment
                key={option.id}
                id={option.id}
                label={locale === 'zh' ? option.quickZh : option.quickEn}
                ariaLabel={simQuickSizeAriaLabel(option.id, copy)}
                title={copy.sizeMode}
                active={active}
                onClick={() => { onSizeModeChange?.(option.mode) }}
              />
            )
          })}
        </div>
        <span style={PANEL_STYLES.toolbarDivider} aria-hidden="true" data-sim-toolbar-divider="true" />
        <div style={SIM_TOOLBAR_STYLES.actionPill} data-sim-toolbar-actions="true">
          {onHome !== undefined ? (
            <SimToolbarIconButton action="home" label={copy.home} onClick={onHome} />
          ) : null}
          {onScreenshot !== undefined ? (
            <SimToolbarIconButton action="screenshot" label={copy.screenshot} onClick={onScreenshot} />
          ) : null}
          {captureState !== 'idle' ? (
            <span style={PANEL_STYLES.captureToast} role="status" data-sim-capture-state={captureState}>
              {captureState === 'done' ? copy.captured : copy.capturing}
            </span>
          ) : null}
          {onRotate !== undefined ? (
            <SimToolbarIconButton action="rotate" label={copy.rotate} onClick={onRotate} />
          ) : null}
          {onRefresh !== undefined ? (
            <SimToolbarIconButton action="refresh" label={copy.refresh} onClick={onRefresh} />
          ) : null}
        </div>
      </div>
      <div style={PANEL_STYLES.stage} data-sim-panel-stage="true">
        <SimPhoneFrame
          sizeMode={sizeMode}
          naturalWidth={naturalWidth}
          naturalHeight={naturalHeight}
          orientation={orientation}
          frameStyle={frameStyle}
        >
          {children}
        </SimPhoneFrame>
      </div>
      {/* The ● Live / Offline readout only makes sense for the live stream
          mode; screenshot-mode panels hide it entirely (WP8 leftover). */}
      {mode === 'stream' ? <SimLiveIndicator open={liveOpen} locale={locale} /> : null}
    </section>
  )
}

export interface SimScreenshotFrameBodyProps {
  meta: SimScreenshotMeta
  locale: SimLocale
  phase: 'granting' | 'live' | 'fallback'
  screenshotUrl: string | undefined
  failure: string
  refresh: () => void
  imgRef: RefObject<HTMLImageElement>
  /** Reports the loaded PNG's natural pixel width (percent-size basis). */
  onNaturalSize?: (width: number) => void
}

/** Pure screenshot-mode body (static PNG inside the phone screen). */
export function SimScreenshotFrameBody({
  meta,
  locale,
  phase,
  screenshotUrl,
  failure,
  refresh,
  imgRef,
  onNaturalSize,
}: SimScreenshotFrameBodyProps): React.JSX.Element {
  const copy = simCopy(locale)
  const udid = meta.device.udid
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' }} data-sim-screenshot-frame="panel" data-sim-frame-state={phase}>
      {phase === 'granting' ? (
        <div style={PANEL_LOADING_STYLES} role="status">
          <span style={CARD_STYLES.muted}>{copy.connectingScreenshot}</span>
          {udid !== undefined ? <span style={CARD_STYLES.muted}>{udid}</span> : null}
        </div>
      ) : null}
      {phase === 'live' && screenshotUrl !== undefined ? (
        <img
          ref={imgRef}
          src={screenshotUrl}
          alt={copy.screenshotAlt}
          draggable={false}
          style={PANEL_SCREENSHOT_IMAGE_STYLES}
          onLoad={event => { onNaturalSize?.(event.currentTarget.naturalWidth) }}
        />
      ) : null}
      {phase === 'fallback' ? (
        <div style={PANEL_FALLBACK_STYLES} role="alert">
          <strong style={CARD_STYLES.fallbackTitle}>{copy.screenshotUnavailable}</strong>
          {udid !== undefined ? <span style={CARD_STYLES.muted}>{udid}</span> : null}
          {failure !== '' ? <span style={CARD_STYLES.muted}>{failure}</span> : null}
          <button type="button" style={CARD_STYLES.primaryButton} onClick={refresh}>{copy.retry}</button>
        </div>
      ) : null}
    </div>
  )
}

export interface SimScreenshotFrameProps {
  meta: SimScreenshotMeta
  fetcher?: SimFetcher
  locale: SimLocale
  onNaturalSize?: (width: number) => void
}

/** Connected screenshot-mode frame: grant → static PNG inside the phone screen. */
export function SimScreenshotFrame({ meta, fetcher, locale, onNaturalSize }: SimScreenshotFrameProps): React.JSX.Element {
  const copy = simCopy(locale)
  const session = useSimScreenshot({ meta, fetcher, unavailableCopy: copy.screenshotUnavailable })
  return (
    <SimScreenshotFrameBody
      meta={meta}
      locale={locale}
      phase={session.phase}
      screenshotUrl={session.screenshotUrl}
      failure={session.failure}
      refresh={session.refresh}
      imgRef={session.imgRef}
      onNaturalSize={onNaturalSize}
    />
  )
}

/** Tool name the panel modes derive from (defensive over both block forms). */
export function simToolNameOf(block: ToolCallBlock): string {
  return 'kind' in block ? (block.call?.name ?? '') : block.name
}

export interface SimulatorPanelProps {
  toolName: string
  block: ToolCallBlock
  fetcher?: SimFetcher
  wsFactory?: SimWsFactory
  colorScheme: 'light' | 'dark'
  locale: SimLocale
  onClose?: () => void
  /** Controlled size mode (the panel host owns it via the panel store). */
  sizeMode?: SimPanelSizeMode
  /** Controlled size-mode change (absent → internal state, fit default). */
  onSizeModeChange?: (mode: SimPanelSizeMode) => void
  /** Controlled frame shell mode (the panel host owns it via the panel
   * store; absent → internal state, slim bezel default). */
  frameStyle?: SimFrameStyle
  /** Controlled frame-style change (absent → internal state). */
  onFrameStyleChange?: (style: SimFrameStyle) => void
  /** Stream display report for the panel host (orientation + natural size) —
   * the host's landscape auto-widen listens to it. */
  onDisplayChange?: (display: SimPanelDisplayReport) => void
}

/** One display report for the panel host: the stream's orientation (tag-130
 * config frame) and the natural framebuffer dims it derives the landscape
 * auto-widen target aspect from. Non-stream modes report all-undefined. */
export interface SimPanelDisplayReport {
  orientation: string | undefined
  naturalWidth: number | undefined
  naturalHeight: number | undefined
}

/**
 * The connected panel: resolves the tool result's presentationMeta (or, for
 * nested Code Mode calls, reconstructs it from the durable result text) and
 * renders the live stream (boot / build-run) or the static screenshot
 * (screenshot / interact) inside the phone frame, tracking the control ws for
 * the Live dot.
 * Tracks the frame's natural pixel size so the percent size mode can scale
 * by the device's logical point size, and forwards the stream session's
 * orientation (serve-sim tag-130 config) so the phone frame and the stream
 * img counter-rotate in landscape. The top toolbar actions (Home, 截图,
 * Rotate, Refresh) are wired to the shared stream session and the capture
 * controller — the body stays pure presentation.
 */
export function SimulatorPanel({
  toolName,
  block,
  fetcher,
  wsFactory,
  colorScheme,
  locale,
  onClose,
  sizeMode,
  onSizeModeChange,
  frameStyle,
  onFrameStyleChange,
  onDisplayChange,
}: SimulatorPanelProps): React.JSX.Element {
  const copy = simCopy(locale)
  const [liveOpen, setLiveOpen] = useState(false)
  const [naturalWidth, setNaturalWidth] = useState<number>()
  const [naturalHeight, setNaturalHeight] = useState<number>()
  // Internal size-mode state for surfaces without a controlling store
  // (the per-tool details seat); the panel host passes a controlled mode.
  const [internalSizeMode, setInternalSizeMode] = useState<SimPanelSizeMode>(SIM_PANEL_SIZE_MODE_FIT)
  const activeSizeMode = sizeMode ?? internalSizeMode
  const handleSizeModeChange = onSizeModeChange ?? setInternalSizeMode
  // Same controlled-prop pattern for the frame shell: internal state (slim
  // bezel default) for the details seat, host-owned store field otherwise.
  const [internalFrameStyle, setInternalFrameStyle] = useState<SimFrameStyle>(SIM_FRAME_STYLE_BEZEL)
  const activeFrameStyle = frameStyle ?? internalFrameStyle
  const handleFrameStyleChange = onFrameStyleChange ?? setInternalFrameStyle
  const settled = 'kind' in block
  const resolved = settled && !block.isError ? resolveSimMeta(toolName, block) : undefined
  const meta = resolved?.meta
  const streamMeta: SimStreamMeta | undefined = meta?.kind === 'sim-stream'
    ? meta
    : meta?.kind === 'sim-build-run'
      ? { kind: 'sim-stream', device: meta.device }
      : undefined
  const screenshotMeta: SimScreenshotMeta | undefined = meta?.kind === 'sim-screenshot' ? meta : undefined
  const mode: SimPanelMode = streamMeta !== undefined
    ? 'stream'
    : screenshotMeta !== undefined
      ? 'screenshot'
      : 'unavailable'
  // The plugin only serves the iOS Simulator: the header title is the
  // unified "iOS 模拟器" / "iOS Simulator" regardless of which tool opened
  // the panel (boot/screenshot/interact/build_run). The device subtitle
  // below keeps the identity.
  const title = copy.simulator

  // The stream session lives HERE (not inside the frame) so the top toolbar
  // can reach sendHome/sendRotate/refresh. It stays dormant for non-stream
  // panels — one unconditional hook keeps the hook order stable.
  const streamSession = useSimStream({
    meta: streamMeta,
    fetcher,
    wsFactory,
    unavailableCopy: copy.streamUnavailable,
    onConnectionChange: setLiveOpen,
    enabled: streamMeta !== undefined,
  })
  const capture = useSimCapture({ fetcher })
  const captureDevice = meta?.device?.udid
  const onScreenshot = useCallback((): void => {
    capture.capture(captureDevice)
  }, [capture, captureDevice])

  // Report the stream display (orientation + natural size) up to the panel
  // host so its landscape auto-widen can follow the device; non-stream
  // panels report an all-undefined display.
  useEffect(() => {
    if (onDisplayChange === undefined) return
    onDisplayChange(mode === 'stream'
      ? { orientation: streamSession.orientation, naturalWidth, naturalHeight }
      : { orientation: undefined, naturalWidth: undefined, naturalHeight: undefined })
  }, [mode, naturalWidth, naturalHeight, onDisplayChange, streamSession.orientation])

  return (
    <SimulatorPanelBody
      title={title}
      device={meta?.device}
      mode={mode}
      liveOpen={liveOpen}
      colorScheme={colorScheme}
      locale={locale}
      onClose={onClose}
      sizeMode={activeSizeMode}
      naturalWidth={naturalWidth}
      naturalHeight={naturalHeight}
      orientation={mode === 'stream' ? streamSession.orientation : undefined}
      onSizeModeChange={handleSizeModeChange}
      frameStyle={activeFrameStyle}
      onFrameStyleChange={handleFrameStyleChange}
      onHome={mode === 'stream' ? streamSession.sendHome : undefined}
      onRotate={mode === 'stream' ? streamSession.sendRotate : undefined}
      onRefresh={mode === 'stream' ? streamSession.refresh : undefined}
      onScreenshot={meta === undefined ? undefined : onScreenshot}
      captureState={capture.phase}
    >
      {streamMeta !== undefined ? (
        <SimLiveFrameBody
          meta={streamMeta}
          colorScheme={colorScheme}
          locale={locale}
          variant="panel"
          session={streamSession}
          naturalWidth={naturalWidth}
          naturalHeight={naturalHeight}
          onNaturalSize={(width, height) => {
            setNaturalWidth(width)
            setNaturalHeight(height)
          }}
        />
      ) : screenshotMeta !== undefined ? (
        <SimScreenshotFrame meta={screenshotMeta} fetcher={fetcher} locale={locale} onNaturalSize={setNaturalWidth} />
      ) : (
        <div style={PANEL_STYLES.unavailable} role="status">
          <span style={CARD_STYLES.muted}>{copy.noPreview}</span>
        </div>
      )}
    </SimulatorPanelBody>
  )
}

export interface SimulatorDetailsPanelProps {
  block: ToolCallBlock
  colorScheme: 'light' | 'dark'
  locale: string
}

/**
 * Per-tool details-seat renderer for DSH runtimes that declare
 * `tool.details.toolview` (absent in rc.6 — registration is guarded by
 * `ctx.slots.inject`, exactly like dsh-openpencil). The native details column
 * supplies its own header and close control, so the panel body renders
 * without `onClose`.
 */
export function SimulatorDetailsPanel({ block, colorScheme, locale }: SimulatorDetailsPanelProps & CompatibleToolDetailsViewProps): React.JSX.Element {
  const toolName = simToolNameOf(block) || IOS_SIM_CARD_TOOLS.boot
  return (
    <SimulatorPanel
      toolName={toolName}
      block={block}
      colorScheme={colorScheme}
      locale={locale === 'zh' ? 'zh' : 'en'}
    />
  )
}
