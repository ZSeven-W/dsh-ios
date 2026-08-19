/**
 * Auto-follow: the open simulator panel re-targets to the agent's NEWEST
 * settled tool result instead of staying on the device it happened to be
 * opened for.
 *
 * The motivating bug: an agent asked to debug a REAL phone started the
 * simulator stream AND `ios_real_start_wda`, then captured screenshots from
 * both — the panel kept streaming the simulator while every subsequent tool
 * result targeted the phone. The panel source registry
 * (`sim-panel-trigger.ts`) already carries every settled result of the four
 * visual sim tools (boot / screenshot / interact / build_run) with its
 * sessionId and device, so the follow engine below is a pure state machine
 * driven off that registry:
 *
 * - `simFollowNewestCandidateOf` scans a source snapshot for the newest
 *   settled result of the CURRENT session with a device udid.
 * - `simFollowStateNext` runs the follow/override lifecycle: a candidate
 *   whose device differs from the panel's current device arms a debounce
 *   window (`SIM_PANEL_FOLLOW_DEBOUNCE_MS`); when the target stays the
 *   newest for the whole window a decision is emitted; a manual pick from
 *   the panel's device picker sets the user-override flag (decisions stand
 *   down for the rest of the panel session, the same precedence as the
 *   landscape auto-widen override in sim-panel-host.tsx); the panel header's
 *   resume affordance clears it. No decision is emitted while a switch is
 *   already in flight — the settle event releases an aged pending target.
 * - `simFollowTargetOf` classifies a decided udid against the host's device
 *   listing: a simulator udid re-targets the stream through the existing
 *   switch-device path, a READY real-device udid hands the panel its
 *   `SimRealDeviceEntry` (real-device mode: live view when WDA is ready,
 *   the not-ready info surface otherwise). A udid the host cannot address
 *   at all (unknown, or an unavailable phone) resolves `undefined` and the
 *   panel stays put — requirement: never yank the user's live view for a
 *   device nothing can be done with.
 *
 * Pure — no React, no DOM, no network. The dev-panel-smoke script drives
 * `simFollowStateNext` action by action like the width state machine.
 */

import { resolveSimMeta } from './sim-meta-hydrate.js'
import {
  simRealDeviceReady,
  type SimDeviceListing,
  type SimRealDeviceEntry,
} from './protocol.js'
import type { SimulatorPanelSource } from './sim-panel-trigger.js'

/**
 * The debounce window a NEWEST target must stay stable for before the panel
 * re-targets (~1.5–2 s). An agent alternating between two devices
 * (screenshot sim → screenshot phone → …) re-arms the window on every
 * result, so the panel never ping-pongs.
 */
export const SIM_PANEL_FOLLOW_DEBOUNCE_MS = 1600

/** One settled, in-session result the follow engine may follow. */
export interface SimFollowCandidate {
  udid: string
  /** The result's own timestamp (`ToolCallBlock.time`), for newest-wins. */
  time: number
}

/**
 * The newest settled source of the given session whose meta resolves to a
 * device udid, or undefined. Error results and results without a device are
 * skipped — the engine only follows results the panel can actually address.
 */
export function simFollowNewestCandidateOf(
  sources: readonly SimulatorPanelSource[],
  sessionId: string,
): SimFollowCandidate | undefined {
  if (sessionId === '') return undefined
  let best: SimFollowCandidate | undefined
  for (const source of sources) {
    if (source.sessionId !== sessionId) continue
    if ('kind' in source.block && source.block.kind === 'tool-result' && source.block.isError) continue
    const meta = resolveSimMeta(source.toolName, source.block)?.meta
    const udid = meta?.device?.udid
    if (typeof udid !== 'string' || udid === '') continue
    const time = typeof source.block.time === 'number' && Number.isFinite(source.block.time)
      ? source.block.time
      : 0
    if (best === undefined || time > best.time) best = { udid, time }
  }
  return best
}

/** A decided udid classified against the host's device listing. */
export type SimFollowTarget =
  | { kind: 'simulator'; udid: string }
  | { kind: 'real'; udid: string; entry: SimRealDeviceEntry }

/**
 * Classify a follow decision's udid against the host's listing. A simulator
 * udid re-targets the stream; a READY physical device activates real-device
 * mode. Anything else — an unknown udid, a listing that does not carry it,
 * an unavailable phone — resolves undefined: the panel cannot address it,
 * so the follow stays put.
 */
export function simFollowTargetOf(
  udid: string,
  listing: SimDeviceListing,
): SimFollowTarget | undefined {
  if (udid === '') return undefined
  for (const device of listing.devices) {
    if (device.udid === udid) return { kind: 'simulator', udid }
  }
  for (const entry of listing.realDevices) {
    if (entry.udid !== udid) continue
    if (!simRealDeviceReady(entry)) return undefined
    return { kind: 'real', udid, entry }
  }
  return undefined
}

/** One emitted re-target request (consumed by the panel's commit path). */
export interface SimFollowDecision {
  /** Monotonic per-machine sequence (the consumer removes by it). */
  seq: number
  /** The decided device udid (flavor resolved at commit via the listing). */
  udid: string
}

/** The armed debounce window for the newest differing target. */
export interface SimFollowPending {
  udid: string
  /** The candidate result's timestamp — only newer results re-arm. */
  version: number
  /** `now + SIM_PANEL_FOLLOW_DEBOUNCE_MS` — the earliest decision time. */
  deadline: number
}

export interface SimFollowState {
  /** The device the panel currently shows (auto-follow ignores it). */
  currentUdid: string | undefined
  /** True once the user picked from the picker — auto-follow stands down. */
  userOverrode: boolean
  /** The armed debounce window, if any. */
  pending: SimFollowPending | undefined
  /** True while a follow-triggered switch is in flight (no decisions). */
  inflight: boolean
  /** Monotonic decision sequence counter. */
  nextSeq: number
  /** Emitted, not-yet-consumed decisions (oldest first). */
  decisions: SimFollowDecision[]
}

export type SimFollowAction =
  /** A newer settled result for the current session (udid + timestamp). */
  | { kind: 'result'; udid: string; version: number; now: number }
  /** The debounce timer fired. */
  | { kind: 'tick'; now: number }
  /** The user picked a device from the panel's picker (override on). */
  | { kind: 'manual-pick'; udid: string }
  /** The header's resume affordance re-enables following. */
  | { kind: 'resume-follow' }
  /** A follow-triggered stream switch started (decisions pause). */
  | { kind: 'switch-start' }
  /** The switch settled; `udid` names the applied device (absent = failed). */
  | { kind: 'switch-settled'; udid?: string; now: number }
  /** The commit path consumed one decision. */
  | { kind: 'consume'; seq: number }

export function simFollowStateInitial(currentUdid: string | undefined): SimFollowState {
  return {
    currentUdid,
    userOverrode: false,
    pending: undefined,
    inflight: false,
    nextSeq: 1,
    decisions: [],
  }
}

function emitDecision(state: SimFollowState, udid: string): SimFollowState {
  return {
    ...state,
    pending: undefined,
    decisions: [...state.decisions, { seq: state.nextSeq, udid }],
    nextSeq: state.nextSeq + 1,
  }
}

/**
 * The pure follow/override state machine. `now` is injected (Date.now in the
 * panel, explicit values in the smoke) so the debounce is fully
 * deterministic. A `result` never re-targets by itself — only an aged
 * `tick` (or a `switch-settled` that releases an already-aged pending)
 * emits a decision, and only while following is active and no switch is in
 * flight.
 */
export function simFollowStateNext(
  state: SimFollowState,
  action: SimFollowAction,
): SimFollowState {
  switch (action.kind) {
    case 'result': {
      // The user's manual pick wins: later results never re-target.
      if (state.userOverrode) return state
      // The panel already shows this device (or the udid is empty): nothing
      // to follow — an equal result also cancels any armed window.
      if (action.udid === '' || action.udid === state.currentUdid) {
        return state.pending === undefined ? state : { ...state, pending: undefined }
      }
      // Only NEWER results re-arm: an out-of-order or repeated candidate
      // must not push the window out.
      if (state.pending !== undefined && action.version <= state.pending.version) return state
      return {
        ...state,
        pending: {
          udid: action.udid,
          version: action.version,
          deadline: action.now + SIM_PANEL_FOLLOW_DEBOUNCE_MS,
        },
      }
    }
    case 'tick': {
      if (state.userOverrode || state.inflight || state.pending === undefined) return state
      if (action.now < state.pending.deadline) return state
      return emitDecision(state, state.pending.udid)
    }
    case 'manual-pick': {
      // The user acted: auto-follow stands down for the rest of the panel
      // session (same precedence as the landscape auto-widen override). The
      // pick also re-bases the current device and drops any not-yet-applied
      // decision — the user's explicit choice supersedes it.
      return {
        ...state,
        currentUdid: action.udid === '' ? state.currentUdid : action.udid,
        userOverrode: true,
        pending: undefined,
        decisions: [],
      }
    }
    case 'resume-follow': {
      // The header's one-click resume: following is active again from the
      // NEXT new result (a stale armed window was dropped by the pick).
      return { ...state, userOverrode: false }
    }
    case 'switch-start': {
      return { ...state, inflight: true }
    }
    case 'switch-settled': {
      const base: SimFollowState = {
        ...state,
        inflight: false,
        ...(typeof action.udid === 'string' && action.udid !== ''
          ? { currentUdid: action.udid }
          : {}),
      }
      // A target that aged through the whole switch stint is still the
      // newest stable result — release it now that the flight is over.
      if (base.userOverrode || base.pending === undefined || base.pending.deadline > action.now) {
        return base
      }
      return emitDecision(base, base.pending.udid)
    }
    case 'consume': {
      return { ...state, decisions: state.decisions.filter(decision => decision.seq !== action.seq) }
    }
  }
}
