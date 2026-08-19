/**
 * Shared live-stream session logic for the dsh-ios surfaces.
 *
 * The one stream/pointer engine behind the persistent right-side simulator
 * panel (and previously the inline card): POST `/_dsh/dsh-ios/grant`
 * `{ kind:'sim-stream', device }` → `<img src={streamUrl}>` (proxied MJPEG)
 * + control WebSocket at `wsUrl`. Pointer events encode serve-sim touch
 * frames (tag 3, normalized 0..1); pointer-down/up is a tap, dragging adds
 * `move` frames. The Home button is tag 4; Rotate advances the device
 * orientation clockwise via the tag-7 frame, tracking the orientation the
 * serve-sim config frames (tag 130) report.
 *
 * Failure policy: an initial grant failure (403/404) falls back with a
 * retry; a stream that dies after a successful grant — img error or ws
 * close, e.g. the ~10-minute token expiry — re-grants once automatically
 * before falling back. Retry re-grants, which restarts an idle device's
 * stream server-side per the `/grant` semantics. Unmount closes the
 * WebSocket and drops the img src.
 *
 * Device switch: a `seededGrant` (the switch-device response's fresh
 * capability URLs) is applied exactly once, on the grant cycle whose udid
 * matches the seed — the panel hands it over together with the new device
 * meta, so the swap closes the old stream and lands the new one without a
 * second round trip. Every later re-grant goes through `/grant` normally.
 *
 * `onConnectionChange` additionally observes the control WebSocket
 * open/close transitions so the panel can drive its "● Live" indicator.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import {
  nextSimRotateOrientation,
  normalizePointerPoint,
  openBrowserSimWebSocket,
  parseSimConfigFrame,
  requestStreamGrant,
  resolveWsUrl,
  simRouteErrorTextOf,
  simButtonFrame,
  simRotateFrame,
  simTouchFrame,
  WEB_SOCKET_OPEN,
  type SimFetcher,
  type SimPoint,
  type SimStreamMeta,
  type SimWebSocketLike,
  type SimWsFactory,
} from './protocol.js'
import { simFramebufferPointOf } from './sim-orientation.js'

export type SimStreamPhase = 'granting' | 'live' | 'fallback'

/**
 * Post-switch cold-boot settle watchdog tuning: after a device switch seeds
 * the stream, re-grant every 4s while neither the ws is open nor a frame has
 * drawn, up to 10 attempts (~40s — covers a simulator cold boot), then fall
 * back with the retry affordance. The tight cadence matters because a
 * cold-booting device refuses the relay outright (the ws upgrade fails in
 * under a second), so the first productive attempt should come quickly.
 * Exported for the smoke's assertions.
 */
export const SIM_SWITCH_SETTLE_INTERVAL_MS = 4000
export const SIM_SWITCH_SETTLE_ATTEMPTS = 10

/**
 * A pre-minted capability the stream session may adopt instead of POSTing
 * /grant: the device-switch flow hands over the switch-device response's
 * fresh URLs so the new stream lands without a second round trip. Applied
 * exactly once (the next grant cycle whose udid matches); later re-grants
 * (refresh, ws death, token expiry) go through /grant normally.
 */
export interface SimSeededGrant {
  udid: string
  streamUrl: string
  wsUrl: string
  expiresAt?: number
}

export interface SimStreamSessionOptions {
  /** Stream presentationMeta (absent only for a disabled session). */
  meta?: SimStreamMeta
  fetcher?: SimFetcher
  wsFactory?: SimWsFactory
  /** Static fallback message shown once the auto-retry budget is spent. */
  unavailableCopy: string
  /** Observes the control ws open/close transitions (the panel's Live dot). */
  onConnectionChange?: (open: boolean) => void
  /** When false the grant effect never runs (the panel owns one session per
   * render but only activates it for stream-mode results). Default true. */
  enabled?: boolean
  /** One-shot pre-minted capability (device switch) — see SimSeededGrant. */
  seededGrant?: SimSeededGrant
  /** Locale table (simCopy) used to localize route failure codes. */
  copy?: Record<string, string>
}

export interface SimStreamSession {
  phase: SimStreamPhase
  streamUrl: string | undefined
  failure: string
  /** True while the control WebSocket is open (panel "● Live" source). */
  wsOpen: boolean
  imgRef: RefObject<HTMLImageElement>
  /** The device orientation reported by the last serve-sim config frame. */
  orientation: string | undefined
  /** Manual refresh: clear the auto-retry budget and re-grant. */
  refresh: () => void
  /** One automatic re-grant (img error / ws close), then the fallback. */
  retryOnce: () => void
  sendHome: () => void
  /** Rotate to the next orientation in the clockwise cycle (ws tag 7). */
  sendRotate: () => void
  /** Pointer handlers over the stream surface (the panel's rotation wrapper
   * or the legacy card's img); events normalize against the element's
   * displayed bounds and inverse-map the orientation back to framebuffer
   * coordinates for the tag-3 touch frames. */
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
}

/**
 * The one live-stream engine shared by the inline card and the panel. Every
 * field is derived state — no rendering lives here, so either surface can
 * frame it however it likes.
 */
export function useSimStream(options: SimStreamSessionOptions): SimStreamSession {
  const { meta, fetcher, wsFactory, unavailableCopy, onConnectionChange, enabled = true, seededGrant, copy } = options
  const udid = meta?.device?.udid
  const [phase, setPhase] = useState<SimStreamPhase>('granting')
  const [grant, setGrant] = useState<{ streamUrl: string }>()
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [wsOpen, setWsOpen] = useState(false)
  const [orientation, setOrientation] = useState<string>()
  const autoRetriedRef = useRef(false)
  const generationRef = useRef(0)
  const wsRef = useRef<SimWebSocketLike>()
  const imgRef = useRef<HTMLImageElement>(null)
  const pointerRef = useRef<{ id: number }>()
  const orientationRef = useRef<string>()
  const connectionRef = useRef(onConnectionChange)
  connectionRef.current = onConnectionChange
  const copyRef = useRef<Record<string, string>>(copy ?? {})
  copyRef.current = copy ?? {}
  /** The seeded grant object already applied (one-shot consumption). */
  const consumedSeedRef = useRef<SimSeededGrant>()
  /** Cold-boot settle budget for the device-switch flow. It must SURVIVE the
   * re-grant cycles it triggers: each re-grant re-runs the connect effect,
   * whose cleanup clears only the TIMER (settleTimerRef) — the attempt
   * budget lives here and is cleared only when the ws opens / a frame
   * arrives, when the budget is exhausted, or when a new switch reseeds. */
  const switchSettleRef = useRef<{ attemptsLeft: number }>()
  const settleTimerRef = useRef<ReturnType<typeof setInterval>>()
  const makeWs = wsFactory ?? openBrowserSimWebSocket

  const clearSettleTimer = useCallback((): void => {
    if (settleTimerRef.current !== undefined) {
      clearInterval(settleTimerRef.current)
      settleTimerRef.current = undefined
    }
  }, [])

  const reportConnection = useCallback((open: boolean): void => {
    setWsOpen(open)
    connectionRef.current?.(open)
    // The ws opening proves the stream settled: retire the switch watchdog.
    if (open && switchSettleRef.current !== undefined) {
      switchSettleRef.current = undefined
      clearSettleTimer()
    }
  }, [clearSettleTimer])

  /** One automatic re-grant, then the static fallback. */
  const autoReGrant = useCallback((): void => {
    // A switch stint owns the retry cadence. A cold-booting device closes
    // the relay again within ~1s of every attempt, so letting this path run
    // during a stint burned the one-shot budget and dropped to the fallback
    // in under two seconds — before the settle timer's first tick. The timer
    // re-grants on its own schedule and declares the fallback itself once
    // the budget is spent, so a ws death here is simply reported (the
    // indicator goes gray) and left to it.
    if (switchSettleRef.current !== undefined) return
    if (autoRetriedRef.current) {
      setFailure(unavailableCopy)
      setPhase('fallback')
    } else {
      autoRetriedRef.current = true
      setAttempt(current => current + 1)
    }
  }, [unavailableCopy])

  /** Arm the settle timer for the current connect cycle. No-ops unless a
   * switch budget is active. Each tick: settled (ws open OR a frame drawn)
   * → retire; budget left → spend one attempt and re-grant (the effect
   * re-run restarts this timer); exhausted → explicit fallback so the user
   * sees 重试 instead of a stale black frame. */
  const startSettleTimer = useCallback((): void => {
    if (switchSettleRef.current === undefined) return
    clearSettleTimer()
    const tick = (): void => {
      const settle = switchSettleRef.current
      if (settle === undefined) {
        clearSettleTimer()
        return
      }
      const ws = wsRef.current
      const img = imgRef.current
      const wsLive = ws !== undefined && ws.readyState === WEB_SOCKET_OPEN
      const frameLive = img !== null && img.naturalWidth > 0
      if (wsLive || frameLive) {
        switchSettleRef.current = undefined
        clearSettleTimer()
        return
      }
      if (settle.attemptsLeft > 0) {
        settle.attemptsLeft -= 1
        autoRetriedRef.current = false
        setAttempt(current => current + 1)
      } else {
        switchSettleRef.current = undefined
        clearSettleTimer()
        setFailure(unavailableCopy)
        setPhase('fallback')
      }
    }
    settleTimerRef.current = setInterval(tick, SIM_SWITCH_SETTLE_INTERVAL_MS)
  }, [clearSettleTimer, unavailableCopy])

  /** Manual refresh: clear the auto-retry budget and re-grant. */
  const refresh = useCallback((): void => {
    autoRetriedRef.current = false
    setFailure('')
    setAttempt(current => current + 1)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const generation = generationRef.current + 1
    generationRef.current = generation
    let disposed = false
    let ws: SimWebSocketLike | undefined
    setPhase('granting')
    setGrant(undefined)
    setFailure('')
    reportConnection(false)

    const cleanup = (): void => {
      disposed = true
      generationRef.current += 1
      wsRef.current = undefined
      try {
        ws?.close()
      } catch {
        // already closed
      }
      imgRef.current?.removeAttribute('src')
      // Clear only the TIMER — the switch settle budget (switchSettleRef)
      // must survive the effect re-run its own re-grant causes.
      clearSettleTimer()
      reportConnection(false)
    }

    const openWs = (wsUrl: string): void => {
      try {
        ws = makeWs(resolveWsUrl(wsUrl, window.location))
        wsRef.current = ws
      } catch (error) {
        // A WebSocket constructor that throws still leaves the img live;
        // interactions just stay disabled until the next grant.
        setFailure(error instanceof Error ? error.message : String(error))
        return
      }
      ws.addEventListener('open', () => {
        if (disposed) return
        reportConnection(true)
      })
      ws.addEventListener('close', () => {
        reportConnection(false)
        if (disposed) return
        disposed = true
        autoReGrant()
      })
      // serve-sim broadcasts screen config (tag 130, includes the device
      // orientation) on connect and after a rotation — track it so the
      // toolbar's Rotate button can advance the clockwise cycle.
      ws.addEventListener('message', (event: unknown) => {
        const config = parseSimConfigFrame((event as { data?: unknown } | undefined)?.data)
        if (config === undefined) return
        orientationRef.current = config.orientation
        setOrientation(config.orientation)
      })
      // The browser fires 'close' after 'error'; the close handler above is
      // the single re-grant trigger (spec: ws close → one automatic re-grant).
      ws.addEventListener('error', () => {})
    }

    // One-shot seeded capability (the device-switch flow): apply it exactly
    // once, on the grant cycle whose udid matches the seed. Later re-grants
    // go through /grant normally (a stale seeded token must never be reused).
    const seed = seededGrant
    if (seed !== undefined && seed !== consumedSeedRef.current && seed.udid === udid) {
      consumedSeedRef.current = seed
      switchSettleRef.current = { attemptsLeft: SIM_SWITCH_SETTLE_ATTEMPTS }
      setGrant({ streamUrl: seed.streamUrl })
      setPhase('live')
      openWs(seed.wsUrl)
      startSettleTimer()
      return cleanup
    }

    void requestStreamGrant(fetcher ?? fetch, { device: udid === undefined ? {} : { udid } }).then(result => {
      if (disposed || generation !== generationRef.current) return
      if (!result.ok) {
        // Initial grant failure (403/404/unavailable host) → static fallback.
        setFailure(simRouteErrorTextOf(result, copyRef.current))
        setPhase('fallback')
        return
      }
      setGrant(result.grant)
      setPhase('live')
      openWs(result.grant.wsUrl)
      // A watchdog-triggered re-grant lands here: keep watching until the
      // stream actually settles (no-op when no switch budget is active).
      startSettleTimer()
    })

    return cleanup
  }, [attempt, udid, autoReGrant, enabled, fetcher, makeWs, reportConnection, seededGrant, startSettleTimer])

  const sendFrame = useCallback((frame: Uint8Array): void => {
    const ws = wsRef.current
    if (ws === undefined || ws.readyState !== WEB_SOCKET_OPEN) return
    try {
      ws.send(frame)
    } catch {
      // The ws close handler owns the re-grant; a send failure is swallowed.
    }
  }, [])

  const sendHome = useCallback((): void => {
    sendFrame(simButtonFrame('home'))
  }, [sendFrame])

  const sendRotate = useCallback((): void => {
    sendFrame(simRotateFrame(nextSimRotateOrientation(orientationRef.current)))
  }, [sendFrame])

  /**
   * One pointer event → a framebuffer-normalized touch point: normalize
   * against the element's DISPLAYED bounds, then invert the CSS counter-
   * rotation so the tag-3 frames address the portrait framebuffer the
   * server streams (e.g. the displayed top-left of a landscape_left frame
   * is the framebuffer's top-right corner).
   */
  const pointOf = (event: ReactPointerEvent<HTMLElement>): SimPoint => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const displayed = normalizePointerPoint(event, bounds)
    return simFramebufferPointOf(orientationRef.current, displayed)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    const point = pointOf(event)
    pointerRef.current = { id: event.pointerId }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // capture is best-effort
    }
    sendFrame(simTouchFrame('begin', point.x, point.y))
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = pointerRef.current
    if (active === undefined || active.id !== event.pointerId) return
    const point = pointOf(event)
    sendFrame(simTouchFrame('move', point.x, point.y))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = pointerRef.current
    if (active === undefined || active.id !== event.pointerId) return
    pointerRef.current = undefined
    const point = pointOf(event)
    sendFrame(simTouchFrame('end', point.x, point.y))
  }

  return {
    phase,
    streamUrl: grant?.streamUrl,
    failure,
    wsOpen,
    orientation,
    imgRef,
    refresh,
    retryOnce: autoReGrant,
    sendHome,
    sendRotate,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
