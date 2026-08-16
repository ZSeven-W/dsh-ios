/**
 * Page-stable owner for the plugin fallback simulator panel.
 *
 * Mirrors dsh-openpencil's `mountEditorWorkbenchHost`: the rc.6 runtime has
 * no per-tool details seat, so the plugin mounts its own imperative React
 * root on `document.body` and docks the panel as a fixed right-hand column
 * that stays visible while the conversation scrolls. A dock lease on the DSH
 * root's `margin-right` (see sim-panel-dock) pushes the AppFrame over so the
 * panel covers nothing; when the dock is unavailable (narrow viewport, root
 * missing, or another plugin owns the margin) the surface falls back to a
 * centered overlay. The left-edge handle drags the panel wider/narrower
 * (double-click resets to the default width), and while the stream runs in a
 * landscape orientation the panel auto-widens to a comfortable device-sized
 * width — restoring the user's portrait width when the device rotates back,
 * and never fighting a manual drag made during the landscape stint.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { SimulatorPanel, type SimPanelDisplayReport } from './sim-panel.js'
import { simCopy } from './copy.js'
import { claimSimulatorPanelDock, type SimulatorPanelDockLease } from './sim-panel-dock.js'
import {
  SIM_PANEL_FALLBACK_LOGICAL_HEIGHT,
  SIM_PANEL_FALLBACK_LOGICAL_WIDTH,
  SIM_PANEL_SIZE_MODE_FIT,
  simPanelSnapPxOf,
  type SimPanelSizeMode,
} from './sim-panel-size.js'
import { SIM_FRAME_STYLE_BEZEL, type SimFrameStyle } from './sim-frame-style.js'

export interface SimulatorPanelRequest {
  sessionId: string
  callId: string
  toolName: string
  block: ToolCallBlock
}

/** Stable identity of one request — reopening the same call is a no-op. */
export function simulatorPanelRequestKey(request: SimulatorPanelRequest): string {
  return `${request.sessionId}\n${request.callId}\n${request.toolName}`
}

type Listener = () => void

export interface SimulatorPanelStore {
  getSnapshot: () => SimulatorPanelRequest | undefined
  /** The display size mode, persisted in-memory for the host's lifetime. */
  getSizeMode: () => SimPanelSizeMode
  setSizeMode: (mode: SimPanelSizeMode) => void
  /** The frame shell mode, persisted in-memory for the host's lifetime. */
  getFrameStyle: () => SimFrameStyle
  setFrameStyle: (style: SimFrameStyle) => void
  subscribe: (listener: Listener) => () => void
  open: (request: SimulatorPanelRequest) => boolean
  close: () => void
}

/** Small external store deliberately not owned by any Tool card. */
export function createSimulatorPanelStore(): SimulatorPanelStore {
  let current: SimulatorPanelRequest | undefined
  let sizeMode: SimPanelSizeMode = SIM_PANEL_SIZE_MODE_FIT
  let frameStyle: SimFrameStyle = SIM_FRAME_STYLE_BEZEL
  const listeners = new Set<Listener>()
  const emit = (): void => { for (const listener of listeners) listener() }
  return {
    getSnapshot: () => current,
    getSizeMode: () => sizeMode,
    setSizeMode(mode) {
      if (sizeMode === mode) return
      sizeMode = mode
      emit()
    },
    getFrameStyle: () => frameStyle,
    setFrameStyle(style) {
      if (frameStyle === style) return
      frameStyle = style
      emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open(request) {
      current = request
      emit()
      return true
    },
    close() {
      if (current === undefined) return
      current = undefined
      emit()
    },
  }
}

let sharedPanelStore: SimulatorPanelStore | undefined

/**
 * The one plugin-wide panel store instance. The page-owned panel host
 * (`mountSimulatorPanelHost`) and the input-dock status capsule subscribe to
 * the SAME instance, so the capsule can read the panel's open/closed state
 * and open the panel itself. Created lazily so headless renders never touch
 * it; `createSimulatorPanelStore` stays exported for standalone tests.
 */
export function simulatorPanelStore(): SimulatorPanelStore {
  sharedPanelStore ??= createSimulatorPanelStore()
  return sharedPanelStore
}

export interface SimulatorPanelHostOptions {
  subscribeTheme: (listener: Listener) => () => unknown
  getColorScheme: () => 'light' | 'dark'
  subscribeLocale: (listener: Listener) => () => unknown
  getLocale: () => string
  document?: Document
}

export interface SimulatorPanelHost {
  open: (request: SimulatorPanelRequest) => boolean
  close: () => void
  dispose: () => void
}

// ── surface geometry (mirrors openpencil's workbench width policy) ──────────

export const SIMULATOR_PANEL_FULLSCREEN_BREAKPOINT = 760
export const SIMULATOR_PANEL_MIN_WIDTH = 320
export const SIMULATOR_PANEL_MAX_WIDTH = 960
export const SIMULATOR_PANEL_LEFT_CLEARANCE = 640
export const SIMULATOR_PANEL_DEFAULT_WIDTH = 380

export interface SimulatorPanelWidthBounds {
  min: number
  max: number
  initial: number
}

/** Keep useful DSH conversation space while allowing a large landscape canvas. */
export function simulatorPanelWidthBounds(viewportWidth: number): SimulatorPanelWidthBounds {
  const safeViewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0
  const available = Math.max(0, safeViewport - SIMULATOR_PANEL_LEFT_CLEARANCE)
  const max = Math.min(SIMULATOR_PANEL_MAX_WIDTH, Math.max(SIMULATOR_PANEL_MIN_WIDTH, available))
  const min = Math.min(SIMULATOR_PANEL_MIN_WIDTH, max)
  return { min, max, initial: Math.min(max, Math.max(min, SIMULATOR_PANEL_DEFAULT_WIDTH)) }
}

export function clampSimulatorPanelWidth(width: number, viewportWidth: number): number {
  const bounds = simulatorPanelWidthBounds(viewportWidth)
  const safeWidth = Number.isFinite(width) ? width : bounds.initial
  return Math.min(bounds.max, Math.max(bounds.min, safeWidth))
}

/** A left-edge drag grows the docked panel as the pointer moves left. */
export function resizedSimulatorPanelWidth(
  startWidth: number,
  startClientX: number,
  clientX: number,
  viewportWidth: number,
): number {
  return clampSimulatorPanelWidth(startWidth + startClientX - clientX, viewportWidth)
}

// ── landscape auto-widen (the stream's orientation drives the panel width) ──

/** Comfortable landscape display height the auto-widen target fits (px). */
export const SIMULATOR_PANEL_LANDSCAPE_HEIGHT_PX = 420

/** True for the ±90° orientations — the wide (landscape) panel stints. */
export function simulatorPanelOrientationIsLandscape(orientation: string | undefined): boolean {
  return orientation === 'landscape_left' || orientation === 'landscape_right'
}

/**
 * The comfortable landscape panel width: the width a landscape device screen
 * needs at ~420px of displayed height (natural height/natural width — the
 * axes swap in landscape), falling back to the 390×844 phone aspect while no
 * natural size is known, clamped into the live bounds and snapped to a whole
 * CSS px (the WP24 integer grid the frame math follows).
 */
export function simulatorPanelLandscapeTargetWidthOf(
  bounds: SimulatorPanelWidthBounds,
  naturalWidth: number | undefined,
  naturalHeight: number | undefined,
): number {
  const landscapeAspect = typeof naturalWidth === 'number' && typeof naturalHeight === 'number'
    && Number.isFinite(naturalWidth) && Number.isFinite(naturalHeight)
    && naturalWidth > 0 && naturalHeight > 0
    ? naturalHeight / naturalWidth
    : SIM_PANEL_FALLBACK_LOGICAL_HEIGHT / SIM_PANEL_FALLBACK_LOGICAL_WIDTH
  const needed = SIMULATOR_PANEL_LANDSCAPE_HEIGHT_PX * landscapeAspect
  return simPanelSnapPxOf(Math.min(bounds.max, Math.max(bounds.min, needed)))
}

/**
 * The panel width state machine behind the resize handle and the landscape
 * auto-widen. Pure (no DOM, no React) so the dev-panel-smoke script drives
 * it action by action:
 *
 * - `display` — the panel's stream report (orientation from the serve-sim
 *   tag-130 config frame + the natural framebuffer dims). Entering a
 *   landscape stint saves the current preferred width; leaving it restores
 *   that width; the stint boundary also clears the user-override flag.
 *   Rotations WITHIN a stint (left↔right, portrait↔upside-down) keep the
 *   flag — the user's choice wins for the rest of the stint.
 * - `manual-width` — a finished handle drag or a double-click reset. In a
 *   landscape stint it sets the user-override flag so the auto-widen never
 *   fights the user's explicit choice.
 */
export interface SimulatorPanelWidthState {
  /** The user's preferred width (last drag / reset / restored width). */
  preferred: number
  /** Width saved when entering a landscape stint (restored on return). */
  portraitWidth: number | undefined
  /** The stream's orientation from the panel's display report. */
  orientation: string | undefined
  /** Natural framebuffer dims (the landscape target's device aspect). */
  naturalWidth: number | undefined
  naturalHeight: number | undefined
  /** True once the user manually sized the panel during this landscape stint. */
  userOverrode: boolean
}

export type SimulatorPanelWidthAction =
  | { kind: 'display'; orientation: string | undefined; naturalWidth?: number; naturalHeight?: number }
  | { kind: 'manual-width'; width: number }

export function simulatorPanelWidthStateInitial(preferred: number): SimulatorPanelWidthState {
  return {
    preferred,
    portraitWidth: undefined,
    orientation: undefined,
    naturalWidth: undefined,
    naturalHeight: undefined,
    userOverrode: false,
  }
}

export function simulatorPanelWidthStateNext(
  state: SimulatorPanelWidthState,
  action: SimulatorPanelWidthAction,
): SimulatorPanelWidthState {
  switch (action.kind) {
    case 'display': {
      const wasLandscape = simulatorPanelOrientationIsLandscape(state.orientation)
      const isLandscape = simulatorPanelOrientationIsLandscape(action.orientation)
      const next = {
        ...state,
        orientation: action.orientation,
        naturalWidth: action.naturalWidth,
        naturalHeight: action.naturalHeight,
      }
      if (action.orientation === state.orientation) return next
      if (isLandscape && !wasLandscape) {
        // Entering a landscape stint: remember the portrait width, and let
        // the auto-widen speak again.
        return { ...next, portraitWidth: state.preferred, userOverrode: false }
      }
      if (!isLandscape && wasLandscape) {
        // Back to portrait: restore the width the stint started from.
        return { ...next, preferred: state.portraitWidth ?? state.preferred, userOverrode: false }
      }
      // Same-kind orientation (left↔right / portrait↔upside-down): the
      // stint continues, so a manual choice stays in charge.
      return next
    }
    case 'manual-width': {
      return {
        ...state,
        preferred: action.width,
        userOverrode: simulatorPanelOrientationIsLandscape(state.orientation)
          ? true
          : state.userOverrode,
      }
    }
  }
}

/**
 * The live panel width: the user's preference, auto-widened to the
 * comfortable landscape target while the stream is landscape and the user
 * has not manually sized the panel during this stint, then clamped into the
 * current viewport bounds.
 */
export function simulatorPanelEffectiveWidth(
  state: SimulatorPanelWidthState,
  viewportWidth: number,
): number {
  const landscape = simulatorPanelOrientationIsLandscape(state.orientation)
  if (!landscape || state.userOverrode) {
    return clampSimulatorPanelWidth(state.preferred, viewportWidth)
  }
  const target = simulatorPanelLandscapeTargetWidthOf(
    simulatorPanelWidthBounds(viewportWidth),
    state.naturalWidth,
    state.naturalHeight,
  )
  return clampSimulatorPanelWidth(Math.max(state.preferred, target), viewportWidth)
}

/**
 * Surface chrome over the DSH theme tokens openpencil's editor panel uses
 * (`--dsw-alias-*`) — the docked column and the overlay card follow the
 * active light/dark theme like the panel body itself. Only the overlay
 * scrim keeps a literal color (a dim over the page in both themes).
 */
const surfaceStyles: Record<string, CSSProperties> = {
  surface: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 1200,
    display: 'flex',
    flexDirection: 'column',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-base)',
    borderLeft: '1px solid var(--dsw-alias-border-l2)',
    boxShadow: '-12px 0 40px rgba(0,0,0,0.35)',
  },
  handle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: -6,
    width: 12,
    cursor: 'ew-resize',
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleBar: {
    width: 3,
    height: 32,
    borderRadius: 99,
    background: 'var(--dsw-alias-border-l2)',
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 1200,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    background: 'rgba(0,0,0,0.55)',
  },
  overlayCard: {
    maxWidth: '100%',
    maxHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: 12,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-base)',
    boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
  },
}

interface SimulatorPanelSurfaceProps {
  request: SimulatorPanelRequest
  colorScheme: 'light' | 'dark'
  locale: string
  sizeMode: SimPanelSizeMode
  onSizeModeChange: (mode: SimPanelSizeMode) => void
  frameStyle: SimFrameStyle
  onFrameStyleChange: (style: SimFrameStyle) => void
  onClose: () => void
}

/**
 * The fixed right-hand surface: docked when the layout lease is available,
 * a centered overlay otherwise. Resize drags the left edge; Escape closes.
 */
function SimulatorPanelSurface({
  request,
  colorScheme,
  locale,
  sizeMode,
  onSizeModeChange,
  frameStyle,
  onFrameStyleChange,
  onClose,
}: SimulatorPanelSurfaceProps): React.JSX.Element {
  const copy = simCopy(locale === 'zh' ? 'zh' : 'en')
  const surfaceRef = useRef<HTMLElement>(null)
  const dockOwnerId = useId()
  const dockLeaseRef = useRef<SimulatorPanelDockLease>()
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [dockUnavailable, setDockUnavailable] = useState(false)
  const [widthState, dispatchWidth] = useReducer(
    simulatorPanelWidthStateNext,
    simulatorPanelWidthBounds(window.innerWidth).initial,
    simulatorPanelWidthStateInitial,
  )
  const fullscreen = viewportWidth < SIMULATOR_PANEL_FULLSCREEN_BREAKPOINT || dockUnavailable
  const bounds = simulatorPanelWidthBounds(viewportWidth)
  const width = simulatorPanelEffectiveWidth(widthState, viewportWidth)

  const handleDisplayChange = useCallback((display: SimPanelDisplayReport): void => {
    dispatchWidth({
      kind: 'display',
      orientation: display.orientation,
      naturalWidth: display.naturalWidth,
      naturalHeight: display.naturalHeight,
    })
  }, [])

  useEffect(() => {
    const onResize = (): void => { setViewportWidth(window.innerWidth) }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  useLayoutEffect(() => {
    if (fullscreen) return
    const root = document.getElementById('root')
    if (root === null) {
      setDockUnavailable(true)
      return
    }
    const computedMarginRight = Number.parseFloat(window.getComputedStyle(root).marginRight)
    const lease = claimSimulatorPanelDock(root, dockOwnerId, width, computedMarginRight)
    if (lease === undefined) {
      setDockUnavailable(true)
      return
    }
    dockLeaseRef.current = lease
    return () => {
      if (dockLeaseRef.current === lease) dockLeaseRef.current = undefined
      lease.release()
    }
  }, [dockOwnerId, fullscreen, width])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const surface = surfaceRef.current
      const targetInside = event.target instanceof Node && surface?.contains(event.target) === true
      if (!targetInside && !fullscreen) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [fullscreen, onClose])

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (fullscreen) return
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    let liveWidth = width
    let appliedClientX = event.clientX
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    try { handle.setPointerCapture(pointerId) } catch { /* window listeners remain as a fallback */ }
    let stopped = false
    const applyWidth = (clientX: number): void => {
      liveWidth = resizedSimulatorPanelWidth(liveWidth, appliedClientX, clientX, window.innerWidth)
      appliedClientX = clientX
      if (surfaceRef.current !== null) surfaceRef.current.style.width = `${liveWidth}px`
      dockLeaseRef.current?.update(liveWidth)
    }
    const cleanup = (): void => {
      if (stopped) return
      stopped = true
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onEnd, true)
      window.removeEventListener('pointercancel', onCancel, true)
      window.removeEventListener('blur', onBlur)
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      } catch { /* capture may already have been released by the browser */ }
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
    const finish = (): void => {
      if (stopped) return
      cleanup()
      // A finished drag is the user's explicit width — in a landscape stint
      // it sets the override flag so the auto-widen never fights it.
      dispatchWidth({ kind: 'manual-width', width: liveWidth })
    }
    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      applyWidth(moveEvent.clientX)
    }
    const onEnd = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId === pointerId) finish()
    }
    const onCancel = (cancelEvent: PointerEvent): void => {
      if (cancelEvent.pointerId === pointerId) finish()
    }
    const onBlur = (): void => { finish() }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onEnd, true)
    window.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('blur', onBlur)
  }, [fullscreen, width])

  const panel = (
    <SimulatorPanel
      key={simulatorPanelRequestKey(request)}
      toolName={request.toolName}
      block={request.block}
      colorScheme={colorScheme}
      locale={locale === 'zh' ? 'zh' : 'en'}
      onClose={onClose}
      sizeMode={sizeMode}
      onSizeModeChange={onSizeModeChange}
      frameStyle={frameStyle}
      onFrameStyleChange={onFrameStyleChange}
      onDisplayChange={handleDisplayChange}
    />
  )

  if (fullscreen) {
    return (
      <div
        style={surfaceStyles.backdrop}
        role="presentation"
        data-simulator-panel-surface="overlay"
        onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
      >
        {/* The overlay fallback follows the same clamped width policy as the
            docked column (maxWidth keeps it on-screen in narrow viewports). */}
        <div style={{ ...surfaceStyles.overlayCard, width }} role="dialog" aria-modal="true" aria-label={copy.simulator}>
          {panel}
        </div>
      </div>
    )
  }

  return (
    <section
      ref={surfaceRef}
      style={{ ...surfaceStyles.surface, width }}
      data-simulator-panel-surface="docked"
      role="complementary"
      aria-label={copy.simulator}
    >
      <div
        style={surfaceStyles.handle}
        role="separator"
        aria-orientation="vertical"
        aria-label={copy.resizePanel}
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={Math.round(width)}
        onPointerDown={startResize}
        onDoubleClick={() => {
          // Double-click on the handle resets to the default width (the
          // openpencil nicety); in landscape it counts as a manual choice.
          dispatchWidth({ kind: 'manual-width', width: simulatorPanelWidthBounds(window.innerWidth).initial })
        }}
      >
        <span style={surfaceStyles.handleBar} aria-hidden="true" />
      </div>
      {panel}
    </section>
  )
}

interface SimulatorPanelHostViewProps {
  store: SimulatorPanelStore
  subscribeTheme: SimulatorPanelHostOptions['subscribeTheme']
  getColorScheme: SimulatorPanelHostOptions['getColorScheme']
  subscribeLocale: SimulatorPanelHostOptions['subscribeLocale']
  getLocale: SimulatorPanelHostOptions['getLocale']
  close: () => void
}

function SimulatorPanelHostView({
  store,
  subscribeTheme,
  getColorScheme,
  subscribeLocale,
  getLocale,
  close,
}: SimulatorPanelHostViewProps): React.JSX.Element | null {
  const request = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const sizeMode = useSyncExternalStore(store.subscribe, store.getSizeMode, store.getSizeMode)
  const frameStyle = useSyncExternalStore(store.subscribe, store.getFrameStyle, store.getFrameStyle)
  const colorScheme = useSyncExternalStore(subscribeTheme, getColorScheme, getColorScheme)
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  if (request === undefined) return null
  return (
    <SimulatorPanelSurface
      request={request}
      colorScheme={colorScheme}
      locale={locale}
      sizeMode={sizeMode}
      onSizeModeChange={store.setSizeMode}
      frameStyle={frameStyle}
      onFrameStyleChange={store.setFrameStyle}
      onClose={close}
    />
  )
}

let nextHostId = 0

/**
 * Mount one imperative React root for the whole plugin panel (mirrors
 * openpencil's `mountEditorWorkbenchHost`). Safe to call only in a browser;
 * the options surface lets a headless embed (none today) pass its own
 * document.
 */
export function mountSimulatorPanelHost(options: SimulatorPanelHostOptions): SimulatorPanelHost {
  const ownerDocument = options.document ?? document
  const hostId = `dsh-ios-simulator-panel-${++nextHostId}`
  const container = ownerDocument.createElement('div')
  container.dataset.simulatorPanelHost = hostId
  ownerDocument.body.append(container)
  let root: Root | undefined = createRoot(container)
  let destroyed = false
  // Shared with the input-dock capsule: it reads the open state to hide
  // itself and calls `open` when the user clicks the status pill.
  const store = simulatorPanelStore()
  const close = (): void => { store.close() }

  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    // Drop any open request so a later remount (plugin reload) starts closed.
    store.close()
    root?.unmount()
    root = undefined
    container.remove()
  }

  root.render(
    <SimulatorPanelHostView
      store={store}
      subscribeTheme={options.subscribeTheme}
      getColorScheme={options.getColorScheme}
      subscribeLocale={options.subscribeLocale}
      getLocale={options.getLocale}
      close={close}
    />,
  )

  return {
    open(request) {
      if (destroyed) return false
      return store.open(request)
    },
    close() {
      if (destroyed) return
      close()
    },
    dispose() {
      destroy()
    },
  }
}
