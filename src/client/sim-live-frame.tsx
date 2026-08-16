/**
 * The live-stream frame consumed by the persistent right-side simulator
 * panel (the conversation cards are compact summaries with no imagery —
 * the panel is the only surface that shows the simulator).
 *
 * `SimLiveFrame` binds `useSimStream` (the single stream/pointer engine) to a
 * presentation; `SimLiveFrameBody` is the same presentation as a pure
 * component over an explicit session state, so the dev-panel-smoke script can
 * server-render the live and fallback phases without a network or a browser.
 *
 * The panel variant fills the panel's phone screen; the legacy `card`
 * variant (bordered media box) remains defined for compatibility but is no
 * longer mounted by the conversation cards.
 *
 * Landscape display fix: the stream framebuffer stays portrait-sized no
 * matter the device orientation, so the panel variant counter-rotates the
 * img via CSS inside a wrapper sized to the rotated bounding box (see
 * sim-orientation.ts). In the ±90° orientations the img's PRE-rotation box
 * is sized to the wrapper's SWAPPED dims and centered (left/top 50% +
 * translate(-50%,-50%)), so after the rotation it fills the wrapper
 * edge-to-edge — sizing the pre-rotation box to the wrapper itself would
 * leave the rotated stream scaled down in the bezel's center. Pointer events
 * land on the wrapper and are inverse-mapped back to framebuffer coordinates
 * by the stream session, so taps land correctly on the rotated content. The
 * card variant renders no imagery since WP9 and stays untouched.
 */

import type { PointerEvent as ReactPointerEvent, RefObject, SyntheticEvent } from 'react'
import { useSimStream, type SimStreamPhase } from './sim-stream-session.js'
import { simCopy, type SimLocale } from './copy.js'
import type { SimFetcher, SimStreamMeta, SimWsFactory } from './protocol.js'
import {
  simDisplayOrientationIdOf,
  type SimOrientationLayout,
} from './sim-orientation.js'
import { simPanelFrameLayoutOf } from './sim-panel-size.js'
import {
  CARD_STYLES,
  mediaFrameStyles,
  PANEL_FALLBACK_STYLES,
  PANEL_LOADING_STYLES,
  PANEL_STREAM_ROTATION_BOX_STYLES,
  PANEL_STREAM_ROTATION_IMG_FILL_STYLES,
  PANEL_STREAM_ROTATION_IMG_STYLES,
  PANEL_STREAM_STAGE_STYLES,
  panelStreamRotationImgSwappedStyles,
  STREAM_TOOLBAR_STYLES,
  streamImageStyles,
} from './card-styles.js'

/** The session fields the pure body renders from (subset of `useSimStream`). */
export interface SimLiveFrameSessionState {
  phase: SimStreamPhase
  streamUrl: string | undefined
  failure: string
  imgRef: RefObject<HTMLImageElement>
  refresh: () => void
  retryOnce: () => void
  sendHome: () => void
  /** Device orientation from the serve-sim config frames (tag 130). */
  orientation?: string | undefined
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
}

export interface SimLiveFrameBodyProps {
  meta: SimStreamMeta
  colorScheme: 'light' | 'dark'
  locale: SimLocale
  variant: 'card' | 'panel'
  session: SimLiveFrameSessionState
  /** Natural pixel width of the loaded stream (percent-size basis + rotation). */
  naturalWidth?: number
  /** Natural pixel height of the loaded stream (rotation bounding box). */
  naturalHeight?: number
  /** Reports the loaded stream's natural pixel size (percent/rotation basis). */
  onNaturalSize?: (width: number, height: number) => void
}

/**
 * Pure presentation of the live frame over an explicit session snapshot.
 * Exported for the static smoke: `phase: 'live' | 'fallback'` render without
 * any network, WebSocket, or browser surface.
 */
export function SimLiveFrameBody({
  meta,
  colorScheme,
  locale,
  variant,
  session,
  naturalWidth,
  naturalHeight,
  onNaturalSize,
}: SimLiveFrameBodyProps): React.JSX.Element {
  const copy = simCopy(locale)
  const udid = meta.device.udid
  const {
    phase,
    streamUrl,
    failure,
    imgRef,
    refresh,
    retryOnce,
    sendHome,
    orientation,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  } = session
  const reportNaturalSize = (event: SyntheticEvent<HTMLImageElement>): void => {
    onNaturalSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
  }
  // The displayed bounding box for the stream img under the device
  // orientation (same base the panel's phone screen derives its axes from,
  // so the wrapper fills the screen exactly; the ±90° cases swap).
  const layout: SimOrientationLayout = simPanelFrameLayoutOf(orientation, naturalWidth, naturalHeight)
  // ±90°: the img's PRE-rotation box must carry the wrapper's SWAPPED dims
  // (width = wrapper height, height = wrapper width), centered, so the
  // counter-rotated img fills the wrapper exactly. An inset-0 box equal to
  // the wide wrapper would rotate into a small letterboxed island — the
  // pre-rotation box must already be portrait-shaped. 0°/180° keep the
  // wrapper-filling inset-0 box (180° rotates in place).
  const swapped = layout.rotationDeg === 90 || layout.rotationDeg === -90

  return (
    <div data-sim-live-frame={variant} data-sim-frame-state={phase}>
      {phase === 'granting' ? (
        variant === 'card' ? (
          <div style={CARD_STYLES.loading} role="status">
            <span style={CARD_STYLES.muted}>{copy.connecting}</span>
            {udid !== undefined ? <span style={CARD_STYLES.muted}>{udid}</span> : null}
          </div>
        ) : (
          <div style={PANEL_LOADING_STYLES} role="status">
            <span style={CARD_STYLES.muted}>{copy.connecting}</span>
            {udid !== undefined ? <span style={CARD_STYLES.muted}>{udid}</span> : null}
          </div>
        )
      ) : null}
      {phase === 'live' && streamUrl !== undefined ? (
        variant === 'card' ? (
          <div style={mediaFrameStyles(colorScheme)}>
            <img
              ref={imgRef}
              src={streamUrl}
              alt={copy.streamAlt}
              draggable={false}
              style={streamImageStyles()}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onLoad={reportNaturalSize}
              onError={() => { retryOnce() }}
            />
            <div style={STREAM_TOOLBAR_STYLES}>
              <button type="button" style={CARD_STYLES.primaryButton} onClick={sendHome}>{copy.home}</button>
              <button type="button" style={CARD_STYLES.primaryButton} onClick={refresh}>{copy.refresh}</button>
            </div>
          </div>
        ) : (
          <div style={PANEL_STREAM_STAGE_STYLES}>
            {/* The rotation wrapper: sized to the rotated bounding box (its
                aspect is the swapped base aspect), so the counter-rotated
                img below fills it edge-to-edge in every orientation. Pointer
                events land here — the wrapper's bounds ARE the displayed box
                the stream session inverse-maps back into framebuffer
                coordinates, so the mapping is independent of how the img is
                positioned inside. */}
            <div
              style={{
                ...PANEL_STREAM_ROTATION_BOX_STYLES,
                aspectRatio: `${layout.displayW} / ${layout.displayH}`,
              }}
              data-sim-live-rotation-box="true"
              data-sim-orientation={simDisplayOrientationIdOf(orientation)}
              data-sim-display-width={layout.displayW}
              data-sim-display-height={layout.displayH}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {/* ±90°: the pre-rotation box gets the wrapper's SWAPPED dims
                  and sits centered (left/top 50% + the translate leg), so
                  rotate(±90deg) about its center lands the rotated box
                  exactly on the wrapper. 0°/180°: inset-0 fill. The
                  transition animates transform only — box + wrapper change
                  together in one commit, never from stale sizes. */}
              <img
                ref={imgRef}
                src={streamUrl}
                alt={copy.streamAlt}
                draggable={false}
                style={{
                  ...PANEL_STREAM_ROTATION_IMG_STYLES,
                  ...(swapped
                    ? {
                        ...panelStreamRotationImgSwappedStyles(layout.displayW, layout.displayH),
                        transform: `translate(-50%, -50%) rotate(${layout.rotationDeg}deg)`,
                      }
                    : {
                        ...PANEL_STREAM_ROTATION_IMG_FILL_STYLES,
                        transform: `rotate(${layout.rotationDeg}deg)`,
                      }),
                }}
                data-sim-pre-rotation-width={swapped ? layout.displayH : layout.displayW}
                data-sim-pre-rotation-height={swapped ? layout.displayW : layout.displayH}
                onLoad={reportNaturalSize}
                onError={() => { retryOnce() }}
              />
            </div>
            {/* Home/Refresh/Rotate/Screenshot live in the panel's TOP toolbar
                (see sim-panel.tsx), so the stream stays full-bleed here. */}
          </div>
        )
      ) : null}
      {phase === 'fallback' ? (
        variant === 'card' ? (
          <div style={CARD_STYLES.fallback} role="alert">
            <strong style={CARD_STYLES.fallbackTitle}>{copy.streamUnavailable}</strong>
            {udid !== undefined ? <span style={CARD_STYLES.muted}>{udid}</span> : null}
            {failure !== '' ? <span style={CARD_STYLES.muted}>{failure}</span> : null}
            <button type="button" style={CARD_STYLES.primaryButton} onClick={refresh}>{copy.retry}</button>
          </div>
        ) : (
          <div style={PANEL_FALLBACK_STYLES} role="alert">
            <strong style={CARD_STYLES.fallbackTitle}>{copy.streamUnavailable}</strong>
            {udid !== undefined ? <span style={CARD_STYLES.muted}>{udid}</span> : null}
            {failure !== '' ? <span style={CARD_STYLES.muted}>{failure}</span> : null}
            <button type="button" style={CARD_STYLES.primaryButton} onClick={refresh}>{copy.retry}</button>
          </div>
        )
      ) : null}
    </div>
  )
}

export interface SimLiveFrameProps {
  meta: SimStreamMeta
  fetcher?: SimFetcher
  wsFactory?: SimWsFactory
  colorScheme: 'light' | 'dark'
  locale: SimLocale
  variant?: 'card' | 'panel'
  onConnectionChange?: (open: boolean) => void
  onNaturalSize?: (width: number, height: number) => void
}

/**
 * Hook-connected live frame: grant → stream img + control ws, with the card's
 * exact fallback/retry behavior. The inline card and the simulator panel both
 * render this component, so the shared stream/pointer engine is exercised by
 * both surfaces.
 */
export function SimLiveFrame({
  meta,
  fetcher,
  wsFactory,
  colorScheme,
  locale,
  variant = 'card',
  onConnectionChange,
  onNaturalSize,
}: SimLiveFrameProps): React.JSX.Element {
  const copy = simCopy(locale)
  const session = useSimStream({
    meta,
    fetcher,
    wsFactory,
    unavailableCopy: copy.streamUnavailable,
    onConnectionChange,
  })
  return (
    <SimLiveFrameBody
      meta={meta}
      colorScheme={colorScheme}
      locale={locale}
      variant={variant}
      session={session}
      onNaturalSize={onNaturalSize}
    />
  )
}

// Symbol-identity anchor: the dev-panel-smoke script asserts that the card and
// the panel share this one module (SimLiveFrame.sharedStreamHook === useSimStream).
Object.assign(SimLiveFrame, { sharedStreamHook: useSimStream })
