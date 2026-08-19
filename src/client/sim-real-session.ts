/**
 * Live-stream session for a PHYSICAL device (WDA over USB) — the real-device
 * counterpart of useSimStream. The panel binds this hook when the user picks
 * a phone in the device picker; the surface it feeds is the SAME
 * SimLiveFrameBody the simulator uses (phone frame, size modes, frame styles,
 * orientation counter-rotation all apply — it is a real stream now).
 *
 * Wire contract:
 * - `POST /_dsh/dsh-ios/real-device-status {device}` — read-only check. The
 *   panel consults it ON DEMAND (open + 重试/Retry) — there is NO unguarded
 *   polling and the state machine never spins: a not-ready answer lands on
 *   the info surface with the localized reason, and only the Retry button
 *   re-checks.
 * - `POST /_dsh/dsh-ios/real-start {device}` — the ONE route allowed to
 *   build/launch WDA (the explicit user gesture behind the panel's Start
 *   button). It answers 202 immediately (a cold build takes minutes) and
 *   the session enters the `starting` phase: poll real-device-status every
 *   ~3 s until ready (the live stream takes over), a terminal coded failure
 *   (localized reason), or an 8-minute cap (timeout copy + Retry/Start
 *   again). The poll dies on unmount and on every terminal state.
 * - `POST /_dsh/dsh-ios/grant {kind:'real-stream', device}` — mints
 *   `{streamUrl, expiresAt, orientation?}` for a device whose WDA is ALREADY
 *   running; a coded 409 (locked / untrusted / expired / unplugged / …) is
 *   localized through simRouteErrorTextOf.
 * - `POST /_dsh/dsh-ios/real-control {device, action}` — tap/drag/button/
 *   rotate. There is NO control WebSocket for WDA; each gesture is one POST.
 *
 * DRAG COALESCING (documented choice): WDA's REST surface exposes COMPLETE
 * gestures only (`/wda/tap`, `/wda/dragfromtoforduration`) — there is no
 * touch begin/move/end streaming channel like the simulator's ws relay.
 * Sending one drag POST per pointermove would issue a chain of separate
 * down-up drags (each cancels scroll momentum and the chain jitters), and a
 * drag that never ends cannot exist in the REST model. So the session
 * COALESCES each pointer gesture into ONE control action on pointer-up:
 * a still click → `tap`; a moved pointer → one `drag` from the pointer-down
 * anchor to the FINAL release point with the gesture's own duration (clamped
 * 0.05–2 s) — WDA animates that drag linearly from→to, which reproduces a
 * faithful slow drag or a quick flick. Pointer-move sampling is throttled to
 * ~50 ms (trailing-edge) for the gesture bookkeeping, so move storms only
 * cost one cheap ref write per 50 ms window; the release point itself is
 * always read from the final pointer event. `simRealGestureActionOf` encodes
 * the coalescing decision so the smoke asserts it without a browser.
 *
 * COORDINATE SPACE: the WDA MJPEG frame is PORTRAIT-sized regardless of the
 * device orientation (the XCTest screenshot buffer is native-orientation,
 * verified against the live device: 1206×2622 while PORTRAIT) — exactly the
 * simulator-framebuffer assumption the existing counter-rotation path makes.
 * The panel therefore counter-rotates the img via sim-orientation.ts off the
 * orientation the host reports. Unlike the simulator ws (whose serve-sim
 * gestures are portrait-framebuffer-normalized and need the inverse mapping
 * `simFramebufferPointOf`), WDA taps live in the CURRENT window space —
 * `WdaStreamSource` multiplies normalized coords by `GET /window/size`
 * (which follows the rotation) — so the displayed (counter-rotated) box
 * coordinates are passed STRAIGHT through, no inverse mapping.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import {
  nextSimRotateOrientation,
  normalizePointerPoint,
  postRealControl,
  requestRealDeviceStatus,
  requestRealStart,
  requestRealStreamGrant,
  simRealDeviceReasonTextOf,
  simRealGestureActionOf,
  simRouteErrorTextOf,
  type SimFetcher,
  type SimPoint,
  type SimRealDeviceStatus,
} from './protocol.js'

/** Trailing-edge sampling cadence for drag move bookkeeping (see above). */
export const SIM_REAL_DRAG_MOVE_SAMPLE_MS = 50

/** Poll cadence while a /real-start launch is in flight (sane ~3 s). */
export const SIM_REAL_START_POLL_INTERVAL_MS = 3_000

/**
 * How often a panel parked on the not-ready surface re-checks whether WDA
 * came back by itself (host restart + adoption, an unlock, a build landing).
 * Slow on purpose: this is a background self-heal, not a progress poll.
 */
export const SIM_REAL_READY_RECHECK_INTERVAL_MS = 8_000

/** Generous total wait for a cold WDA build before giving up (~8 min). */
export const SIM_REAL_START_POLL_CAP_MS = 8 * 60_000

/**
 * WDA failure reasons that END the start polling: the launch has settled
 * badly and the localized reason belongs on the info surface. `device-locked`
 * is deliberately ABSENT — a locked phone does not fail the launch; WDA
 * keeps waiting and recovers by itself, so the poll keeps going and only
 * shows the lock hint.
 */
export const SIM_REAL_START_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'cert-untrusted',
  'profile-expired',
  'device-unplugged',
  'build-failed',
  'launch-timeout',
  'tunnel-failed',
  'wda-not-ready',
  'unavailable',
])

export type SimRealSessionPhase = 'checking' | 'starting' | 'granting' | 'live' | 'not-ready'

export interface SimRealSessionOptions {
  /** The picked physical device (absent → the session stays idle). */
  udid: string | undefined
  fetcher?: SimFetcher
  /** Locale table (simCopy) used to localize route failure codes. */
  copy?: Record<string, string>
  /** Observes the live stream state (the panel's ● Live dot + frame flag). */
  onLiveChange?: (live: boolean) => void
  /** When false the check/grant effect never runs. Default true. */
  enabled?: boolean
}

export interface SimRealSession {
  phase: SimRealSessionPhase
  streamUrl: string | undefined
  /** The last WDA status snapshot (drives the info surface). */
  status: SimRealDeviceStatus | undefined
  /** Localized, actionable reason text for the not-ready state. */
  failure: string
  /** Host-side detail line (English) for the not-ready state. */
  failureDetail: string
  /** The device orientation in the panel display vocabulary. */
  orientation: string | undefined
  /** Extra line during the starting phase (e.g. the locked-phone hint). */
  startHint: string
  imgRef: RefObject<HTMLImageElement>
  /** Manual re-check (the info surface's 重试 button and the toolbar 刷新). */
  refresh: () => void
  /**
   * The explicit user gesture: POST /real-start, then poll the status route
   * on the bounded cadence until ready / terminal failure / the time cap.
   */
  start: () => void
  /** One automatic re-check (img error), then the not-ready surface. */
  retryOnce: () => void
  sendHome: () => void
  /** Advance the WDA orientation cycle; the response updates `orientation`. */
  sendRotate: () => void
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
}

/**
 * The one live real-device session engine: status → grant → `<img>` stream,
 * with REST control POSTs and the coalesced pointer gestures above.
 */
export function useSimRealSession(options: SimRealSessionOptions): SimRealSession {
  const { udid, fetcher, copy, onLiveChange, enabled = true } = options
  const [phase, setPhase] = useState<SimRealSessionPhase>('checking')
  const [streamUrl, setStreamUrl] = useState<string>()
  const [status, setStatus] = useState<SimRealDeviceStatus>()
  const [failure, setFailure] = useState('')
  const [failureDetail, setFailureDetail] = useState('')
  const [orientation, setOrientation] = useState<string>()
  const [startHint, setStartHint] = useState('')
  const [attempt, setAttempt] = useState(0)
  const generationRef = useRef(0)
  const autoRetriedRef = useRef(false)
  /** True from the Start click until the /real-start POST settles into the
   * poll phase (also the double-click guard). */
  const startingRef = useRef(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const pointerRef = useRef<{ id: number; start: SimPoint; latest: SimPoint; startAt: number; sampledAt: number }>()
  const orientationRef = useRef<string>()
  const liveRef = useRef(onLiveChange)
  liveRef.current = onLiveChange
  const copyRef = useRef<Record<string, string>>(copy ?? {})
  copyRef.current = copy ?? {}

  const reportLive = useCallback((live: boolean): void => {
    liveRef.current?.(live)
  }, [])

  const adoptOrientation = useCallback((value: string | undefined): void => {
    if (value === undefined || value === '') return
    orientationRef.current = value
    setOrientation(value)
  }, [])

  const refresh = useCallback((): void => {
    autoRetriedRef.current = false
    setFailure('')
    setFailureDetail('')
    setAttempt(current => current + 1)
  }, [])

  /** One automatic re-check (stream img error), then the not-ready surface. */
  const retryOnce = useCallback((): void => {
    if (autoRetriedRef.current) {
      setPhase('not-ready')
      reportLive(false)
      return
    }
    autoRetriedRef.current = true
    setAttempt(current => current + 1)
  }, [reportLive])

  /**
   * The Start WebDriverAgent button: POST /real-start (the explicit user
   * gesture — the one route allowed to build), then hand over to the
   * bounded poll below. A coded refusal lands straight back on the
   * not-ready surface with the localized reason.
   */
  const start = useCallback((): void => {
    if (udid === undefined || udid === '') return
    if (startingRef.current) return
    startingRef.current = true
    autoRetriedRef.current = false
    setFailure('')
    setFailureDetail('')
    setStartHint('')
    void (async () => {
      const result = await requestRealStart(fetcher ?? fetch, udid)
      if (!startingRef.current) return
      if (!result.ok) {
        startingRef.current = false
        setFailure(simRouteErrorTextOf(result, copyRef.current))
        setFailureDetail('')
        setPhase('not-ready')
        reportLive(false)
        return
      }
      if (result.start.state === 'running') {
        // WDA was already up (or adopted): the normal check→grant engine
        // takes over from a fresh status read.
        startingRef.current = false
        setAttempt(current => current + 1)
        return
      }
      // 202 accepted: a build is in flight — poll until it settles.
      setPhase('starting')
      reportLive(false)
    })()
  }, [udid, fetcher, reportLive])

  useEffect(() => {
    if (!enabled || udid === undefined || udid === '') return
    const generation = generationRef.current + 1
    generationRef.current = generation
    let disposed = false
    startingRef.current = false
    setPhase('checking')
    setStreamUrl(undefined)
    setFailure('')
    setFailureDetail('')
    setStartHint('')
    reportLive(false)

    void (async () => {
      // 1. Read-only status check — never starts anything.
      const current = await requestRealDeviceStatus(fetcher ?? fetch, { device: udid })
      if (disposed || generation !== generationRef.current) return
      setStatus(current)
      adoptOrientation(current.orientation)
      if (!current.ready) {
        setFailure(simRealDeviceReasonTextOf(current.reason, false, copyRef.current))
        setFailureDetail(current.detail ?? '')
        setPhase('not-ready')
        reportLive(false)
        return
      }
      // 2. WDA is up: mint the stream capability (never boots/builds).
      setPhase('granting')
      const granted = await requestRealStreamGrant(fetcher ?? fetch, udid)
      if (disposed || generation !== generationRef.current) return
      if (!granted.ok) {
        setFailure(simRouteErrorTextOf(granted, copyRef.current))
        setFailureDetail(current.detail ?? '')
        setPhase('not-ready')
        reportLive(false)
        return
      }
      adoptOrientation(granted.grant.orientation)
      setStreamUrl(granted.grant.streamUrl)
      setPhase('live')
      reportLive(true)
    })()

    return () => {
      disposed = true
      generationRef.current += 1
      imgRef.current?.removeAttribute('src')
      reportLive(false)
    }
  }, [attempt, udid, enabled, fetcher, adoptOrientation, reportLive])

  /**
   * Bounded progress poll while a /real-start launch is in flight: every
   * ~3 s read the status route. `ready` hands over to the check→grant
   * engine above (attempt bump); a terminal coded failure (or the 8-minute
   * cap) lands on the not-ready surface with the localized reason;
   * `device-locked` is non-terminal — show the unlock hint and keep
   * waiting. The interval dies on unmount and on every terminal state, so
   * it can never spin forever.
   */
  useEffect(() => {
    if (!enabled || udid === undefined || udid === '' || phase !== 'starting') return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = Date.now() + SIM_REAL_START_POLL_CAP_MS
    const poll = async (): Promise<void> => {
      const current = await requestRealDeviceStatus(fetcher ?? fetch, { device: udid })
      if (disposed) return
      setStatus(current)
      adoptOrientation(current.orientation)
      if (current.ready) {
        startingRef.current = false
        setStartHint('')
        // The normal check→grant engine takes over.
        setAttempt(attemptCurrent => attemptCurrent + 1)
        return
      }
      const reason = current.reason
      if (reason !== undefined && SIM_REAL_START_TERMINAL_REASONS.has(reason)) {
        startingRef.current = false
        setStartHint('')
        setFailure(simRealDeviceReasonTextOf(reason, false, copyRef.current))
        setFailureDetail(current.detail ?? '')
        setPhase('not-ready')
        reportLive(false)
        return
      }
      setStartHint(reason === 'device-locked' ? (copyRef.current.realStartLockedHint ?? '') : '')
      if (Date.now() >= deadline) {
        startingRef.current = false
        setStartHint('')
        setFailure(copyRef.current.realStartTimeout ?? '')
        setFailureDetail('')
        setPhase('not-ready')
        reportLive(false)
        return
      }
      timer = setTimeout(() => { void poll() }, SIM_REAL_START_POLL_INTERVAL_MS)
    }
    void poll()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [phase, udid, enabled, fetcher, adoptOrientation, reportLive])

  /**
   * Self-heal while parked on the not-ready surface. The check→grant engine
   * above runs ONCE per attempt, so a panel that opened a second too early
   * used to sit on "WebDriverAgent is not running" forever — even though the
   * common cases fix themselves within seconds: the host restarts and adopts
   * the WDA already running on the phone, a locked device is unlocked, an
   * in-flight build lands. This slow re-check (one cheap loopback POST every
   * ~8 s, never while live/starting) notices and hands over to the engine by
   * bumping the attempt. Failures are ignored: it is a background retry, not
   * a state the user is waiting on.
   */
  useEffect(() => {
    if (!enabled || udid === undefined || udid === '' || phase !== 'not-ready') return
    let disposed = false
    const timer = setInterval(() => {
      void requestRealDeviceStatus(fetcher ?? fetch, { device: udid })
        .then(current => {
          if (disposed || !current.ready) return
          setAttempt(attemptCurrent => attemptCurrent + 1)
        })
        .catch(() => undefined)
    }, SIM_REAL_READY_RECHECK_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [phase, udid, enabled, fetcher])

  const control = useCallback((action: Parameters<typeof postRealControl>[2]): void => {
    if (udid === undefined || udid === '') return
    void postRealControl(fetcher ?? fetch, udid, action).then(result => {
      if (result.ok) adoptOrientation(result.result.orientation)
      // Control failures are non-fatal: the img error path re-checks status
      // when the stream itself dies; a single refused tap/drag stays silent.
    })
  }, [udid, fetcher, adoptOrientation])

  const sendHome = useCallback((): void => {
    control({ kind: 'button', name: 'home' })
  }, [control])

  const sendRotate = useCallback((): void => {
    void (async () => {
      const result = await (async () => {
        if (udid === undefined || udid === '') return
        return postRealControl(fetcher ?? fetch, udid, { kind: 'rotate' })
      })()
      if (result === undefined) return
      if (result.ok) {
        adoptOrientation(result.result.orientation)
      } else {
        // The route refused (e.g. WDA died mid-session): advance locally so
        // the display stays consistent until the next status check lands.
        adoptOrientation(nextSimRotateOrientation(orientationRef.current))
      }
    })()
  }, [udid, fetcher, adoptOrientation])

  /**
   * One pointer event → normalized coordinates of the DISPLAYED box. No
   * orientation inverse-mapping here (unlike the simulator ws): WDA taps
   * live in the current window space, which the counter-rotated display
   * box addresses directly — see the module's COORDINATE SPACE note.
   */
  const pointOf = (event: ReactPointerEvent<HTMLElement>): SimPoint => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return normalizePointerPoint(event, bounds)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    const point = pointOf(event)
    pointerRef.current = {
      id: event.pointerId,
      start: point,
      latest: point,
      startAt: Date.now(),
      sampledAt: Date.now(),
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // capture is best-effort
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = pointerRef.current
    if (active === undefined || active.id !== event.pointerId) return
    // ~50 ms trailing-edge sample: refresh the gesture's latest point at a
    // bounded cadence (move storms cost one point-normalization per window).
    const now = Date.now()
    if (now - active.sampledAt < SIM_REAL_DRAG_MOVE_SAMPLE_MS) return
    active.sampledAt = now
    active.latest = pointOf(event)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = pointerRef.current
    if (active === undefined || active.id !== event.pointerId) return
    pointerRef.current = undefined
    // The final event is authoritative; the sampled latest point is the
    // fallback for a release that lands without usable coordinates.
    const final = pointOf(event)
    const end = Number.isFinite(final.x) && Number.isFinite(final.y) ? final : active.latest
    const action = simRealGestureActionOf(active.start, end, Date.now() - active.startAt)
    control(action)
  }

  return {
    phase,
    streamUrl,
    status,
    failure,
    failureDetail,
    orientation,
    startHint,
    imgRef,
    refresh,
    start,
    retryOnce,
    sendHome,
    sendRotate,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
