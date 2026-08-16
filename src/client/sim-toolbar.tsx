/**
 * The panel toolbar's icon cluster + segmented quick sizes (WP21 restyle).
 *
 * The four stream actions (Home/回到桌面 · Screenshot/截图 · Rotate/旋转 ·
 * Refresh/刷新) are ICON buttons grouped in ONE rounded pill container — the
 * dark pill cluster Simulator.app / serve-sim previews use (home / camera /
 * rotate icons sitting together). The icons are inline stroke SVGs in a 16×16
 * viewBox (stroke `currentColor`, width 1.5, round caps/joins), so the DSH
 * theme tokens color them through the button's `color` — no icon fonts, no
 * assets, no dependencies.
 *
 * Each icon button shows a small token-styled tooltip BELOW the button on
 * hover or keyboard focus (150ms show delay, instant hide). The codebase
 * styles via inline objects (no CSS pseudo-elements), so the hover/focus
 * state is explicit React state (onMouseEnter/Leave + onFocus/Blur) and the
 * tooltip is an absolutely-positioned label rendered off that state. The
 * label is the same localized string as the button's `aria-label` — the
 * tooltip is visual sugar only, a11y stays attribute-based.
 *
 * The size quick buttons (Fit/适应 · 100% · S · M) share the same visual
 * language as ONE borderless segmented pill group: a single outer border on
 * the container (same `--dsw-alias-bg-layer-1` + `--dsw-alias-border-l2`
 * pill recipe), borderless text segments with a subtle hover highlight, and
 * the ACTIVE segment marked by a stronger background FILL — never a
 * per-button border.
 *
 * Style tokens: the hover highlight uses `--dsw-alias-interactive-bg-hover`
 * and the active fill uses `--dsw-alias-interactive-bg-active` rather than
 * the raw layer ramp — in the LIGHT theme `bg-layer-1`/`bg-layer-2` resolve
 * to the same white, so the semantic interactive tokens are the only
 * layer-ish fills that read clearly in BOTH themes. The tooltip uses
 * `--dsw-alias-tooltip-bg` with the static near-white text color — the exact
 * recipe the host's own Tooltip.module.css uses.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { SimCopy } from './copy.js'

/** The four toolbar action ids (Home · Screenshot · Rotate · Refresh). */
export type SimToolbarActionId = 'home' | 'screenshot' | 'rotate' | 'refresh'

/** The action roster in the pill's render order. */
export const SIM_TOOLBAR_ACTION_IDS: readonly SimToolbarActionId[] = ['home', 'screenshot', 'rotate', 'refresh']

/** Localized label for one action — the button aria-label AND the tooltip text. */
export function simToolbarActionLabelOf(action: SimToolbarActionId, copy: SimCopy): string {
  switch (action) {
    case 'home': return copy.home
    case 'screenshot': return copy.screenshot
    case 'rotate': return copy.rotate
    case 'refresh': return copy.refresh
  }
}

/**
 * The icon set: minimal stroke paths in a 16×16 viewBox, drawn with
 * `stroke="currentColor"` / `fill="none"` / strokeWidth 1.5 / round caps —
 * exported so the static smoke can assert the set directly.
 *
 * - home: a house — roof stroke + walls;
 * - screenshot: a camera — body outline + lens circle;
 * - rotate: rotate-cw — one 270° arc with the top-right arrowhead;
 * - refresh: refresh-cw — two mirrored 180° arcs with both arrowheads.
 */
export const SIM_TOOLBAR_ICON_PATHS: Record<SimToolbarActionId, readonly string[]> = {
  home: [
    'M2.75 8 L8 2.75 L13.25 8',
    'M4.5 7.75 V13.25 H11.5 V7.75',
  ],
  screenshot: [
    'M2.75 5.25 H5.1 L6.4 3.5 H9.6 L10.9 5.25 H13.25 V12.25 H2.75 Z',
    'M8 6.25a2.5 2.5 0 1 0 .01 0',
  ],
  rotate: [
    'M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33',
    'M14 2v3.33h-3.33',
  ],
  refresh: [
    'M2 8a6 6 0 0 1 6-6c1.68 0 3.29.67 4.49 1.83L14 5.33',
    'M14 2v3.33h-3.33',
    'M14 8a6 6 0 0 1-6 6c-1.68 0-3.29-.67-4.49-1.83L2 10.67',
    'M5.33 10.67H2V14',
  ],
}

/** One inline stroke icon (16px, currentColor — the button's color token). */
export function SimToolbarIcon({ action }: { action: SimToolbarActionId }): React.JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable={false}
      data-sim-toolbar-icon={action}
    >
      {SIM_TOOLBAR_ICON_PATHS[action].map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  )
}

/**
 * Toolbar pill + button + tooltip + size-segment styles over the DSH theme
 * tokens (no literal colors — the vars resolve per light/dark theme).
 * Exported so the static smoke can assert the token usage directly.
 */
export const SIM_TOOLBAR_STYLES: Record<string, CSSProperties> = {
  /** The rounded pill container the four icon buttons sit in (serve-sim
   * preview cluster look): layer-1 fill, single l2 border, full radius. */
  actionPill: {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 2,
    borderRadius: 999,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  /** Borderless 28px icon square; `position: relative` anchors the tooltip. */
  iconButton: {
    position: 'relative',
    flex: 'none',
    width: 28,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    border: 'none',
    borderRadius: 7,
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
  },
  /** Hover/focus highlight: subtle layer fill + primary label color. */
  iconButtonHover: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)',
  },
  /** The small tooltip bubble below the button (host Tooltip.module.css
   * recipe: tooltip-bg + static near-white text, rounded, no pointer). */
  tooltip: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 20,
    padding: '3px 7px',
    borderRadius: 8,
    background: 'var(--dsw-alias-tooltip-bg)',
    // Static near-white on purpose: the alias bg flips with the theme, the
    // text must stay readable on it in both schemes (host recipe).
    color: 'var(--dsw-static-neutral-bluish-00)',
    fontSize: 12,
    lineHeight: '16px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  },
  /** The segmented pill the size quick buttons sit in — the SAME pill
   * treatment as the icon cluster (one outer border, no per-button border). */
  sizeQuickGroup: {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 2,
    borderRadius: 999,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  /** Borderless text segment (~28px tall with the pill's 2px padding). */
  sizeQuickSegment: {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 24,
    padding: '0 10px',
    border: 'none',
    borderRadius: 999,
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 12,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  },
  /** Segment hover: the same subtle highlight the icon buttons use. */
  sizeQuickSegmentHover: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)',
  },
  /** ACTIVE segment: stronger background FILL (semantic active token —
   * reads clearly in light AND dark, unlike the raw layer ramp), no border. */
  sizeQuickSegmentActive: {
    background: 'var(--dsw-alias-interactive-bg-active)',
    color: 'var(--dsw-alias-label-primary)',
    fontWeight: 600,
  },
}

/** Tooltip show delay (nice-to-have ~150ms). */
export const SIM_TOOLBAR_TOOLTIP_DELAY_MS = 150

/** The pure tooltip bubble (exported for the static smoke). */
export function SimToolbarTooltip({ label }: { label: string }): React.JSX.Element {
  return (
    <span
      style={SIM_TOOLBAR_STYLES.tooltip}
      role="tooltip"
      aria-hidden="true"
      data-sim-toolbar-tooltip="true"
    >
      {label}
    </span>
  )
}

export interface SimToolbarIconButtonProps {
  /** Which icon to draw (also the `data-sim-toolbar-action` id). */
  action: SimToolbarActionId
  /** Localized aria-label AND tooltip text (copy.home etc.). */
  label: string
  onClick?: () => void
  /**
   * Tooltip-open override for the static smoke: when provided it wins over
   * the internal hover/focus state (absent → the button's own state).
   */
  tooltipOpen?: boolean
}

/**
 * One toolbar action as an icon button: borderless 28px square inside the
 * pill, hover/focus highlight, and the tooltip below it. The tooltip opens
 * after the 150ms delay on mouseenter/focus and closes immediately on
 * mouseleave/blur; the button keeps its `aria-label` regardless.
 */
export function SimToolbarIconButton({
  action,
  label,
  onClick,
  tooltipOpen,
}: SimToolbarIconButtonProps): React.JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const cancelOpenTimer = useCallback((): void => {
    if (openTimerRef.current !== undefined) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = undefined
    }
  }, [])
  const scheduleOpen = useCallback((): void => {
    cancelOpenTimer()
    openTimerRef.current = setTimeout(() => { setInternalOpen(true) }, SIM_TOOLBAR_TOOLTIP_DELAY_MS)
  }, [cancelOpenTimer])
  const close = useCallback((): void => {
    cancelOpenTimer()
    setInternalOpen(false)
    setHovered(false)
  }, [cancelOpenTimer])
  useEffect(() => () => { cancelOpenTimer() }, [cancelOpenTimer])

  const open = tooltipOpen ?? internalOpen
  const buttonStyle = hovered
    ? { ...SIM_TOOLBAR_STYLES.iconButton, ...SIM_TOOLBAR_STYLES.iconButtonHover }
    : SIM_TOOLBAR_STYLES.iconButton
  return (
    <button
      type="button"
      style={buttonStyle}
      onClick={onClick}
      onMouseEnter={() => { setHovered(true); scheduleOpen() }}
      onMouseLeave={close}
      onFocus={() => { setHovered(true); scheduleOpen() }}
      onBlur={close}
      aria-label={label}
      data-sim-toolbar-action={action}
    >
      <SimToolbarIcon action={action} />
      {open ? <SimToolbarTooltip label={label} /> : null}
    </button>
  )
}

export interface SimSizeQuickSegmentProps {
  /** Quick option id (fit / percent-100 / preset-S / preset-M). */
  id: string
  /** Rendered text label (localized by the caller). */
  label: string
  /** Full localized aria-label (copy.sizeQuickFit etc.). */
  ariaLabel: string
  /** title attribute (localized size-mode caption). */
  title: string
  /** Active state mirrors the store's sizeMode (aria-pressed + fill). */
  active: boolean
  onClick?: () => void
}

/**
 * One size quick button as a borderless text segment of the segmented pill
 * group: hover = subtle highlight, ACTIVE = stronger background fill. The
 * active fill wins over the hover highlight so the pressed segment never
 * lightens under the cursor.
 */
export function SimSizeQuickSegment({
  id,
  label,
  ariaLabel,
  title,
  active,
  onClick,
}: SimSizeQuickSegmentProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  let style = SIM_TOOLBAR_STYLES.sizeQuickSegment
  if (hovered) style = { ...style, ...SIM_TOOLBAR_STYLES.sizeQuickSegmentHover }
  if (active) style = { ...style, ...SIM_TOOLBAR_STYLES.sizeQuickSegmentActive }
  return (
    <button
      type="button"
      style={style}
      aria-pressed={active}
      aria-label={ariaLabel}
      title={title}
      data-sim-size-quick={id}
      data-sim-size-quick-active={active ? 'true' : 'false'}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      {label}
    </button>
  )
}
