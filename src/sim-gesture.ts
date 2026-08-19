/**
 * Host-side gesture channel for the streamed simulator: serve-sim's WebSocket
 * control socket instead of its CLI.
 *
 * WP56 — why this module exists. Every multi-event simulator gesture used to
 * reach serve-sim through the `serve-sim gesture` CLI: ONE process per touch
 * event. A scroll is begin + 5 moves + end = 7 invocations, measured at 2.05 s
 * wall on a live simulator, with ~290 ms of stationary contact before the
 * first move ever landed. iOS does not read that as a swipe: scrolling
 * Calendar's month view that way opened the NEW EVENT sheet, because the OS
 * classified the slow press-and-drag as Calendar's drag-to-create gesture.
 * The SAME path pushed over serve-sim's WS touch channel at ~16 ms per frame
 * scrolls correctly (verified by hand: the month view moved 八月 → 九月 with
 * nothing created), because the finger now travels at a real flick's velocity.
 *
 * The socket is the same control channel the browser panel drives through the
 * relay (src/stream-routes.ts), and the frame layout is the host twin of
 * src/client/protocol.ts: a 1-byte tag followed by a UTF-8 JSON body — tag 3
 * touch `{type,x,y}` with normalized 0..1 coordinates, tag 4 button
 * `{button}`. Nothing here starts or adopts a stream: callers pass the
 * `wsUrl` of the live stream (`SimStreamInfo.wsUrl`) and fall back to the CLI
 * when there is none, since a tool call can arrive before the stream exists.
 * @module @zseven-w/dsh-ios/sim-gesture
 */

import { createRequire } from 'node:module'

// ── frame encoding (host twin of src/client/protocol.ts) ──────────────────────

/** serve-sim touch frame tag (`{type:'begin'|'move'|'end',x,y}`). */
export const SIM_TOUCH_TAG = 3

/** serve-sim hardware-button frame tag (`{button}`). */
export const SIM_BUTTON_TAG = 4

/**
 * One frame per display refresh: 16 ms is the cadence the hand-verified scroll
 * used, and it is what makes iOS see a flick (2.05 s over 7 CLI invocations
 * did not). Slower cadences reintroduce the press-and-drag misread.
 */
export const SIM_GESTURE_STEP_MS = 16

/**
 * Move frames a default scroll traces. 18 moves × 16 ms ≈ 288 ms of travel,
 * so a whole scroll lands in the 250–400 ms band a real flick occupies —
 * against 2.05 s for the CLI path it replaces.
 */
export const SIM_SCROLL_STEPS = 18

/** How long the control socket may take to open before the caller falls back. */
export const SIM_GESTURE_CONNECT_TIMEOUT_MS = 3_000

/** Bounded wait for the close handshake, so the socket never outlives the call. */
const SIM_GESTURE_CLOSE_TIMEOUT_MS = 250

/**
 * The vertical/horizontal band a traced gesture stays inside. The bottom
 * home-indicator strip swallows gestures that start inside it (~7% dead zone),
 * and the side edges host the back-swipe, so NO endpoint and no intermediate
 * point may leave 8%..92% of the travelling axis.
 */
export const SIM_GESTURE_BAND_MIN = 0.08
export const SIM_GESTURE_BAND_MAX = 0.92

/** Longest drag a `gesture` payload may request (serve-sim's own drag cap). */
const SIM_DRAG_MAX_MS = 2_000
/** Shortest drag that still reads as a deliberate gesture rather than a tap. */
const SIM_DRAG_MIN_MS = 100

/** Normalized 0..1 point of the simulator screen — serve-sim's own space. */
export interface SimGesturePoint {
  x: number
  y: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Encode one serve-sim control frame: `[tag byte][utf-8 JSON]`. Byte-identical
 * to `encodeSimControlFrame` in src/client/protocol.ts — the panel and the
 * tools must put the same bytes on the same socket.
 */
export function encodeSimControlFrame(tag: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(1 + json.length)
  frame[0] = tag
  json.copy(frame, 1)
  return frame
}

/** One touch frame (tag 3) at normalized 0..1 coordinates. */
export function encodeSimTouchFrame(type: 'begin' | 'move' | 'end', x: number, y: number): Buffer {
  return encodeSimControlFrame(SIM_TOUCH_TAG, { type, x: clamp01(x), y: clamp01(y) })
}

/** One hardware-button frame (tag 4), e.g. `home`. */
export function encodeSimButtonFrame(name: string): Buffer {
  return encodeSimControlFrame(SIM_BUTTON_TAG, { button: name })
}

// ── pure geometry ─────────────────────────────────────────────────────────────

/** A scroll request in the tool's own terms (direction names the CONTENT). */
export interface SimScrollRequest {
  direction: 'up' | 'down' | 'left' | 'right'
  /** Fraction of the travelling axis the finger covers, 0..1. */
  amount: number
  /** Anchor the gesture starts from, normalized 0..1. */
  anchorX: number
  anchorY: number
  /** Move frames between begin and end (default `SIM_SCROLL_STEPS`). */
  steps?: number
}

/** Clamp one axis into the system-gesture-free band. */
function clampBand(value: number): number {
  return Math.min(SIM_GESTURE_BAND_MAX, Math.max(SIM_GESTURE_BAND_MIN, value))
}

/**
 * Round to 1/10000 of the screen: far below a physical pixel (0.04 pt on a
 * 402 pt-wide phone) but it keeps the JSON bodies short and the traced points
 * exactly comparable in tests.
 */
function quantize(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * Trace `steps` move frames from `from` to `to`. The interpolation is LINEAR
 * on purpose: constant velocity means the last two frames carry the flick
 * velocity iOS extrapolates momentum from — an eased tail would land as a
 * slow drag that stops dead.
 */
function tracePoints(from: SimGesturePoint, to: SimGesturePoint, steps: number): SimGesturePoint[] {
  const points: SimGesturePoint[] = [{ x: quantize(from.x), y: quantize(from.y) }]
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps
    points.push({
      x: quantize(from.x + (to.x - from.x) * ratio),
      y: quantize(from.y + (to.y - from.y) * ratio),
    })
  }
  return points
}

function normalizeSteps(steps: number | undefined, fallback: number): number {
  if (steps === undefined) return fallback
  if (!Number.isFinite(steps) || steps < 1) {
    throw new RangeError(`dsh-ios: a gesture path needs at least 1 move frame, got ${String(steps)}`)
  }
  return Math.floor(steps)
}

/**
 * The normalized finger path of one scroll — PURE, so the geometry is testable
 * without a socket and the WS path cannot drift from the CLI/WDA paths that
 * take its endpoints.
 *
 * Two conventions collide on "which way is down", so the direction names the
 * CONTENT: `down` reveals content further down the page, which is the finger
 * moving UP (a smaller y). Both endpoints AND every traced point stay inside
 * the 8%..92% band, so no frame can land in the home-indicator strip or on a
 * side edge where the system swallows the gesture.
 */
export function simScrollPath(request: SimScrollRequest): SimGesturePoint[] {
  const { direction, amount, anchorX, anchorY } = request
  const vertical = direction === 'up' || direction === 'down'
  const anchor = vertical ? anchorY : anchorX
  // 'down' = content down = finger up = negative y delta; same sign rule on x.
  const delta = (direction === 'down' || direction === 'right' ? -1 : 1) * amount
  // Clamp the anchor FIRST so neither endpoint can leave the band, then clamp
  // the far end: a linear path between two in-band points stays in the band.
  const from = clampBand(anchor)
  const to = clampBand(from + delta)
  const steps = normalizeSteps(request.steps, SIM_SCROLL_STEPS)
  return vertical
    ? tracePoints({ x: anchorX, y: from }, { x: anchorX, y: to }, steps)
    : tracePoints({ x: from, y: anchorY }, { x: to, y: anchorY }, steps)
}

/** A drag path as an `ios_sim_interact action=gesture` payload describes it. */
export interface SimDragRequest {
  fromX: number
  fromY: number
  toX: number
  toY: number
  /** Requested duration in SECONDS (default 0.3), clamped to 0.1..2 s. */
  duration?: number
}

/**
 * The normalized finger path of one drag. The requested duration decides the
 * POINT COUNT, not a dwell: the cadence stays at one frame per 16 ms (a real
 * finger's sampling rate), so a 0.3 s drag traces ~19 frames and the gesture
 * takes the time it asked for instead of the 2 s the CLI path needed.
 */
export function simDragPath(request: SimDragRequest, stepMs = SIM_GESTURE_STEP_MS): SimGesturePoint[] {
  const durationMs = Math.min(
    SIM_DRAG_MAX_MS,
    Math.max(SIM_DRAG_MIN_MS, Math.round((request.duration ?? 0.3) * 1_000)),
  )
  const steps = Math.max(2, Math.round(durationMs / Math.max(1, stepMs)))
  return tracePoints(
    { x: clamp01(request.fromX), y: clamp01(request.fromY) },
    { x: clamp01(request.toX), y: clamp01(request.toY) },
    steps,
  )
}

/**
 * Recognize a `gesture` payload that describes a DRAG PATH (the same
 * normalized from/to shape the physical-device path documents) as opposed to
 * one raw serve-sim touch frame (`{type,x,y}`). A drag needs the WS channel
 * for the same reason a scroll does; a single frame is a single event and the
 * CLI is fine for it.
 */
export function simDragRequestOf(payload: unknown): SimDragRequest | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const normalized = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
  const fromX = normalized(record.fromX)
  const fromY = normalized(record.fromY)
  const toX = normalized(record.toX)
  const toY = normalized(record.toY)
  if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) return undefined
  const duration = typeof record.duration === 'number' && Number.isFinite(record.duration) ? record.duration : undefined
  return { fromX, fromY, toX, toY, ...(duration === undefined ? {} : { duration }) }
}

// ── the socket ────────────────────────────────────────────────────────────────

/** Structural face of the `ws` client this module uses (see loadWs). */
interface SimWsClientLike {
  readonly readyState: number
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  once(event: 'open', listener: () => void): unknown
  once(event: 'close', listener: () => void): unknown
  // ws calls the write callback node-style: `null` on success, never undefined.
  send(data: Buffer, callback?: (error?: Error | null) => void): void
  close(): void
  terminate(): void
}

interface SimWsModuleLike {
  WebSocket: {
    new (url: string, options?: { perMessageDeflate?: boolean }): SimWsClientLike
    readonly CLOSED: number
  }
}

const requireWs = createRequire(import.meta.url)

/**
 * Load `ws` lazily from the plugin's node_modules (the harness connection
 * package ships it — src/stream-routes.ts resolves it the same way). Lazy so a
 * headless profile that never gestures never touches the package.
 */
function loadWs(): SimWsModuleLike {
  return requireWs('ws') as SimWsModuleLike
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/**
 * Every failure of this module reads the same way: it names the serve-sim
 * stream control socket and says the CLI path is still available, because the
 * one caller (ios_sim_interact) is expected to fall back rather than fail.
 */
function gestureUnavailable(wsUrl: string, detail: string): Error {
  return new Error(
    `dsh-ios: the serve-sim stream gesture channel (${wsUrl === '' ? 'no wsUrl — no live serve-sim stream' : wsUrl}) `
    + `is unavailable — ${detail}; send the gesture through the serve-sim CLI instead `
    + '(one process per touch event, ~2 s per scroll) or boot the stream first with ios_sim_boot',
  )
}

function requireGesturePath(points: readonly SimGesturePoint[]): SimGesturePoint[] {
  const list: readonly SimGesturePoint[] = Array.isArray(points) ? points : []
  if (list.length < 2) {
    throw new RangeError(
      `dsh-ios: a gesture path needs at least 2 points (begin + one move), got ${list.length} `
      + '— a single point is a tap, which the serve-sim CLI already delivers in one event',
    )
  }
  return list.map((point, index) => {
    if (typeof point?.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new RangeError(`dsh-ios: gesture point ${index} must carry finite normalized x/y, got ${JSON.stringify(point)}`)
    }
    return { x: clamp01(point.x), y: clamp01(point.y) }
  })
}

export interface SimGestureOptions {
  /** Delay between consecutive move frames (default `SIM_GESTURE_STEP_MS`). */
  stepMs?: number
  /** Budget for the socket to open (default `SIM_GESTURE_CONNECT_TIMEOUT_MS`). */
  connectTimeoutMs?: number
}

/** What one traced gesture actually did — measured, not budgeted. */
export interface SimGestureReport {
  /** Frames written: 1 begin + `moves` moves + 1 end. */
  frames: number
  moves: number
  /** Wall time from connect to the flushed `end` frame, in ms. */
  elapsedMs: number
  stepMs: number
  wsUrl: string
}

/**
 * Trace one gesture over ONE serve-sim control socket: `begin` at the first
 * point, a `move` per subsequent point spaced by `stepMs`, then `end` where
 * the path stopped (lifting at the last point is what leaves iOS a flick
 * velocity to extrapolate). The socket is opened, used and closed inside this
 * call — a default 19-point scroll takes ~300 ms end to end, against 2.05 s
 * for the 7-process CLI path it replaces.
 *
 * Rejects (never silently degrades) when there is no wsUrl, the socket refuses
 * to open, or it closes mid-gesture: the caller falls back to the CLI, so a
 * lost socket must be loud rather than a lost gesture.
 */
export async function sendSimGesture(
  wsUrl: string,
  points: readonly SimGesturePoint[],
  options: SimGestureOptions = {},
): Promise<SimGestureReport> {
  const url = typeof wsUrl === 'string' ? wsUrl.trim() : ''
  if (!/^wss?:\/\//.test(url)) {
    throw gestureUnavailable(url, 'the stream reports its control-socket url (SimStreamInfo.wsUrl) only while serve-sim is running')
  }
  const path = requireGesturePath(points)
  const stepMs = options.stepMs ?? SIM_GESTURE_STEP_MS
  if (!Number.isFinite(stepMs) || stepMs < 0) {
    throw new RangeError(`dsh-ios: gesture stepMs must be a non-negative number of milliseconds, got ${String(stepMs)}`)
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? SIM_GESTURE_CONNECT_TIMEOUT_MS
  const { WebSocket } = loadWs()
  const socket = new WebSocket(url, { perMessageDeflate: false })
  // The socket's own failures arrive asynchronously; latch the first one and
  // check it between frames so a half-sent gesture rejects instead of hanging.
  let broken: string | undefined
  let finished = false
  socket.on('error', error => {
    broken ??= `the control socket errored (${errorMessage(error)})`
  })
  socket.on('close', (code, reason) => {
    if (finished) return
    const detail = reason.length > 0 ? ` ${reason.toString('utf8')}` : ''
    broken ??= `the control socket closed before the gesture finished (code ${code}${detail})`
  })
  const started = Date.now()
  try {
    await openSocket(socket, connectTimeoutMs, url, () => broken)
    for (const [index, point] of path.entries()) {
      if (broken !== undefined) throw gestureUnavailable(url, broken)
      if (index > 0 && stepMs > 0) await sleep(stepMs)
      socket.send(encodeSimTouchFrame(index === 0 ? 'begin' : 'move', point.x, point.y))
    }
    if (broken !== undefined) throw gestureUnavailable(url, broken)
    // Await only the LAST frame's write: ws writes in submission order, so
    // flushing the 'end' frame proves the whole path reached the socket before
    // the close handshake can drop it.
    await new Promise<void>((resolve, reject) => {
      const last = path[path.length - 1]
      socket.send(encodeSimTouchFrame('end', last.x, last.y), error => {
        if (error === undefined || error === null) resolve()
        else reject(gestureUnavailable(url, `the end frame could not be written (${errorMessage(error)})`))
      })
    })
    const elapsedMs = Date.now() - started
    finished = true
    return { frames: path.length + 1, moves: path.length - 1, elapsedMs, stepMs, wsUrl: url }
  } finally {
    finished = true
    await closeSocket(socket, WebSocket.CLOSED)
  }
}

function openSocket(
  socket: SimWsClientLike,
  timeoutMs: number,
  url: string,
  broken: () => string | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(gestureUnavailable(url, broken() ?? `the control socket did not open within ${timeoutMs} ms`))
    }, timeoutMs)
    socket.once('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })
    socket.once('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(gestureUnavailable(url, broken() ?? 'the control socket closed before it opened'))
    })
  })
}

/**
 * Close inside the call and WAIT (briefly) for the handshake: the caller's
 * next act is a screenshot, and a socket still draining behind it would keep
 * a serve-sim consumer alive for no reason. `terminate` is the backstop.
 */
function closeSocket(socket: SimWsClientLike, closedState: number): Promise<void> {
  if (socket.readyState === closedState) return Promise.resolve()
  return new Promise<void>(resolve => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      socket.terminate()
      done()
    }, SIM_GESTURE_CLOSE_TIMEOUT_MS)
    socket.once('close', done)
    try {
      socket.close()
    } catch {
      socket.terminate()
      done()
    }
  })
}
