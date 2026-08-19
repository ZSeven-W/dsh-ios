/**
 * Compact token-styled device picker for the simulator panel header.
 *
 * Replaces the static device-name subtitle in stream mode: the picker shows
 * the CURRENT streamed device and, when opened, lists the pickable
 * simulators from the read-only host route `POST /_dsh/dsh-ios/devices`,
 * grouped by runtime with booted devices marked ●. The list is fetched on
 * every open (focus precedes open) — no polling.
 *
 * Picking another device POSTs `/_dsh/dsh-ios/switch-device`
 * (`{ device: udid }`); while the request is in flight AND until the new
 * stream (seeded from the returned capability URLs) reaches the live phase,
 * the picker shows the transitional 切换中… / Switching… state. A failed
 * switch shows the error inline and the selection reverts automatically
 * (the panel meta never changed). A disabled "真机（即将支持）/ Real devices
 * (coming soon)" group sits at the bottom — the Phase A real-device work
 * will light it up; this module deliberately has NO real-device entries.
 *
 * Split like the other panel pieces for the static smoke:
 * `SimDevicePickerBody` is pure presentation (SSR-able with explicit
 * device lists and switching/error states), `SimDevicePicker` binds it to
 * the list-fetch-on-open behavior, and `createSimDeviceSwitchController` is
 * a pure, fetcher-injectable state machine the dev-panel-smoke script drives
 * with a mocked fetcher (no browser, no simulator). `simSwitchedStreamMetaOf`
 * builds the synthetic sim-stream meta the panel adopts after a switch —
 * the same capsule-style synthetic source `simSwitchedPanelRequestOf` (in
 * sim-panel-host.tsx) wraps for the store/registry.
 * @module @zseven-w/dsh-ios/client/sim-device-picker
 */

import { useCallback, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { simCopy, type SimLocale } from './copy.js'
import { SimSelect, type SimSelectGroup } from './sim-select.js'
import {
  requestSimDevices,
  requestSwitchDevice,
  simRealDeviceReady,
  simRouteErrorTextOf,
  type SimDeviceEntry,
  type SimRealDeviceEntry,
  type SimDeviceInfo,
  type SimFetcher,
  type SimStreamMeta,
  type SimSwitchResponse,
} from './protocol.js'

/** Picker chrome over the DSH theme tokens (token-styled pill, like the
 * panel's other compact header controls). Exported for the smoke's
 * token assertions. */
export const SIM_DEVICE_PICKER_STYLES: Record<string, CSSProperties> = {
  // In the single-row wrapping header the picker needs a real flex-basis:
  // `flex: 1 1 0` let it shrink to a sliver (its min-width:100 trigger then
  // overflowed onto the size control). With a 140px basis + 120px floor it
  // claims usable space on the shared line and WRAPS to the next line when
  // the panel narrows instead of collapsing.
  root: {
    minWidth: 120,
    flex: '1 1 140px',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  /** Width/flex tuning merged onto the shared SimSelect trigger recipe. */
  trigger: {
    maxWidth: 220,
    minWidth: 100,
    flex: 1,
  },
  switching: {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'nowrap',
  },
  spinner: {
    flex: 'none',
    width: 11,
    height: 11,
    display: 'inline-block',
    boxSizing: 'border-box',
    borderRadius: '50%',
    border: '2px solid var(--dsw-alias-border-l2)',
    borderTopColor: 'var(--dsw-alias-label-primary)',
    // Animated in the browser through the one plugin-owned keyframes rule
    // (see mountSimulatorPanelHost); static in SSR, which the smoke asserts.
    animation: 'dsh-ios-switch-spin 0.9s linear infinite',
  },
  error: {
    flex: 'none',
    maxWidth: 180,
    fontSize: 12,
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
}

/** The plugin-owned spinner keyframes (injected once by the panel host). */
export const SIM_DEVICE_PICKER_KEYFRAMES = '@keyframes dsh-ios-switch-spin{to{transform:rotate(360deg)}}'

/**
 * Human-friendly runtime label for one CoreSimulator runtime id, e.g.
 * `com.apple.CoreSimulator.SimRuntime.iOS-26-4` → `iOS 26.4`. Unrecognized
 * ids fall back to the raw runtime string.
 */
export function simRuntimeLabelOf(runtime: string): string {
  const match = /\.(iOS|watchOS|tvOS|xrOS|visionOS)-(\d+(?:-\d+)*)$/.exec(runtime)
  if (match === null) return runtime
  return `${match[1]} ${match[2]!.replace(/-/g, '.')}`
}

/** One runtime group for the picker (ordered as the listing provides them). */
export interface SimDeviceGroup {
  runtime: string
  label: string
  devices: SimDeviceEntry[]
}

/**
 * Group the listing by runtime, preserving the host's order (booted first,
 * then runtime descending — the client never re-sorts). When the current
 * device is missing from the listing (stale list, fetch failure, fresh
 * switch) it is injected into its runtime group so the select's value
 * always has a matching option and the picker keeps showing the device.
 */
export function simDeviceGroupsOf(
  devices: readonly SimDeviceEntry[],
  current?: SimDeviceInfo,
): SimDeviceGroup[] {
  const groups: SimDeviceGroup[] = []
  const byRuntime = new Map<string, SimDeviceEntry[]>()
  for (const device of devices) {
    const list = byRuntime.get(device.runtime)
    if (list === undefined) byRuntime.set(device.runtime, [device])
    else list.push(device)
  }
  for (const [runtime, list] of byRuntime) {
    groups.push({ runtime, label: simRuntimeLabelOf(runtime), devices: list })
  }
  const udid = current?.udid
  if (typeof udid !== 'string' || udid === '') return groups
  if (devices.some(device => device.udid === udid)) return groups
  const runtime = typeof current?.runtime === 'string' && current.runtime !== '' ? current.runtime : ''
  const entry: SimDeviceEntry = {
    udid,
    name: typeof current?.name === 'string' && current.name !== '' ? current.name : udid,
    runtime,
    state: typeof current?.state === 'string' ? current.state : '',
  }
  const existing = groups.find(group => group.runtime === runtime)
  if (existing !== undefined) existing.devices.unshift(entry)
  else groups.unshift({ runtime, label: simRuntimeLabelOf(runtime), devices: [entry] })
  return groups
}

/**
 * Real-device option values are namespaced so one `onSelect(value)` channel
 * carries both kinds without ambiguity: a bare udid switches the STREAM, a
 * prefixed one selects a phone the panel can only describe (no stream).
 */
export const REAL_DEVICE_VALUE_PREFIX = 'real:'

/** The real-device udid behind a picker value, or undefined for simulators. */
export function simRealDeviceUdidOf(value: string): string | undefined {
  return value.startsWith(REAL_DEVICE_VALUE_PREFIX)
    ? value.slice(REAL_DEVICE_VALUE_PREFIX.length)
    : undefined
}

/**
 * Build the SimSelect groups for the picker: one group per runtime (booted
 * devices marked ● and flagged for the smoke/a11y) plus the disabled
 * real-device placeholder group at the bottom — the Phase A real-device work
 * will light it up; this module deliberately has NO real-device entries.
 * Exported so the smoke can render `SimSelectMenu` with the exact groups.
 */
export function simDeviceSelectGroupsOf(
  devices: readonly SimDeviceEntry[],
  currentDevice: SimDeviceInfo | undefined,
  locale: SimLocale,
  realDevices: readonly SimRealDeviceEntry[] = [],
  currentRealUdid?: string,
  currentRealDevice?: SimRealDeviceEntry,
): SimSelectGroup[] {
  const copy = simCopy(locale)
  const selectGroups: SimSelectGroup[] = simDeviceGroupsOf(devices, currentDevice).map(group => ({
    id: group.runtime,
    label: group.label,
    dataAttrs: { 'data-sim-device-runtime-group': group.runtime },
    options: group.devices.map(device => {
      const booted = device.state === 'Booted'
      // Three readable states: the STREAMED device gets the same green the
      // panel's ● 实时 readout uses, other booted simulators get a muted dot
      // (running, just not on screen), shutdown ones get none.
      const streaming = device.udid === currentDevice?.udid
      const markerTone = streaming ? 'active' : booted ? 'idle' : undefined
      const state = streaming ? copy.deviceStreaming : booted ? copy.deviceBooted : device.state
      return {
        value: device.udid,
        label: device.name,
        markerTone,
        ariaLabel: markerTone === undefined ? device.name : `${device.name}, ${state}`,
        title: `${device.name} · ${group.label} · ${state}`,
        dataAttrs: {
          'data-sim-device-booted': booted ? 'true' : 'false',
          'data-sim-device-streaming': streaming ? 'true' : 'false',
        },
      }
    }),
  }))
  // Physical devices go FIRST: there are dozens of simulators, and a phone
  // the user just plugged in should not be a scroll away.
  // The listing is fetched only when the menu opens, so a panel that
  // auto-followed to a phone has none yet. Inject the current real device
  // the same way a missing current SIMULATOR is injected above — otherwise
  // the trigger has no matching option and falls back to rendering the raw
  // `real:<udid>` value instead of the device name.
  const known = currentRealUdid !== undefined
    && realDevices.some(entry => entry.udid === currentRealUdid)
  const effectiveReal: readonly SimRealDeviceEntry[] = known || currentRealDevice === undefined
    ? realDevices
    : [currentRealDevice, ...realDevices.filter(entry => entry.udid !== currentRealDevice.udid)]
  realDevices = effectiveReal
  if (realDevices.length === 0) {
    // Nothing plugged in (or no devicectl): keep the informative placeholder.
    selectGroups.unshift({
      id: 'real-devices',
      label: copy.realDevices,
      disabled: true,
      dataAttrs: { 'data-sim-real-devices-group': 'true' },
      options: [{ value: '', label: copy.realDevicesNone, disabled: true }],
    })
    return selectGroups
  }
  selectGroups.unshift({
    id: 'real-devices',
    label: copy.realDevices,
    dataAttrs: { 'data-sim-real-devices-group': 'true' },
    options: realDevices.map(device => {
      const ready = simRealDeviceReady(device)
      const picked = device.udid === currentRealUdid
      // A connected phone reads as "running" (hollow ring) — it is available
      // to the agent tools — and as the picked one when the panel shows it.
      // It never gets the filled live dot: nothing streams from a real
      // device until WebDriverAgent lands.
      const detail = [device.osVersion === undefined ? undefined : `iOS ${device.osVersion}`,
        ready ? copy.realDeviceConnected : copy.realDeviceUnavailable]
        .filter(part => part !== undefined).join(' · ')
      return {
        value: `${REAL_DEVICE_VALUE_PREFIX}${device.udid}`,
        label: device.name,
        ...(ready ? { markerTone: 'idle' as const } : {}),
        disabled: !ready,
        ariaLabel: `${device.name}, ${detail}`,
        title: `${device.name} · ${detail} · ${device.udid}`,
        dataAttrs: {
          'data-sim-real-device': device.udid,
          'data-sim-real-device-ready': ready ? 'true' : 'false',
          'data-sim-real-device-picked': picked ? 'true' : 'false',
        },
      }
    }),
  })
  return selectGroups
}

export interface SimDevicePickerBodyProps {
  /** Pickable simulators from the host listing (may be empty). */
  devices: readonly SimDeviceEntry[]
  /** Physical devices from `devicectl` (may be empty). Not streamable. */
  realDevices?: readonly SimRealDeviceEntry[]
  /** The picked real device, when the panel is in real-device mode. */
  currentRealUdid?: string
  /** Its full entry, so the trigger can name it before the list is fetched. */
  currentRealDevice?: SimRealDeviceEntry
  /** The current streamed device (select value + fallback option). */
  currentDevice?: SimDeviceInfo
  /** Transitional state: switch POST in flight or the new grant not yet live. */
  switching: boolean
  /** Inline switch-failure message (empty → hidden). */
  error: string
  locale: SimLocale
  onSelect: (udid: string) => void
  /** Fires when the picker opens/focuses — the list-refresh hook. */
  onOpen?: () => void
}

/**
 * Pure picker presentation: a token-styled `<select>` with one optgroup per
 * runtime (booted devices marked ● and flagged for the smoke/a11y), plus the
 * disabled real-device placeholder group at the bottom, the transitional
 * 切换中… / Switching… readout, and the inline switch error. SSR-safe — no
 * effects, no fetch.
 */
export function SimDevicePickerBody({
  devices,
  realDevices = [],
  currentRealUdid,
  currentRealDevice,
  currentDevice,
  switching,
  error,
  locale,
  onSelect,
  onOpen,
}: SimDevicePickerBodyProps): React.JSX.Element {
  const copy = simCopy(locale)
  const currentUdid = currentRealUdid !== undefined
    ? `${REAL_DEVICE_VALUE_PREFIX}${currentRealUdid}`
    : typeof currentDevice?.udid === 'string' ? currentDevice.udid : ''
  const selectGroups = simDeviceSelectGroupsOf(devices, currentDevice, locale, realDevices, currentRealUdid, currentRealDevice)
  return (
    <div style={SIM_DEVICE_PICKER_STYLES.root} data-sim-device-picker="true">
      <SimSelect
        value={currentUdid}
        groups={selectGroups}
        onChange={onSelect}
        onOpen={onOpen}
        disabled={switching}
        ariaLabel={copy.devicePicker}
        triggerStyle={SIM_DEVICE_PICKER_STYLES.trigger}
        dataAttrs={{
          'data-sim-device-picker-select': 'true',
          'data-sim-device-current': currentUdid,
          'data-sim-device-switching': switching ? 'true' : 'false',
        }}
      />
      {switching ? (
        <span
          style={SIM_DEVICE_PICKER_STYLES.switching}
          role="status"
          data-sim-device-switching-state="true"
        >
          <span style={SIM_DEVICE_PICKER_STYLES.spinner} aria-hidden="true" data-sim-device-spinner="true" />
          {copy.deviceSwitching}
        </span>
      ) : null}
      {!switching && error !== '' ? (
        <span style={SIM_DEVICE_PICKER_STYLES.error} role="alert" data-sim-device-error="true">
          {`${copy.switchFailed}: ${error}`}
        </span>
      ) : null}
    </div>
  )
}

export interface SimDevicePickerProps {
  /** The picked real device, when the panel is in real-device mode. */
  currentRealUdid?: string
  /** Its full entry, so the trigger can name it before the list is fetched. */
  currentRealDevice?: SimRealDeviceEntry
  fetcher?: SimFetcher
  /** The current streamed device (select value + fallback option). */
  currentDevice?: SimDeviceInfo
  /** Transitional state owned by the panel (switch in flight / grant pending). */
  switching: boolean
  /** Inline switch-failure message owned by the panel. */
  error: string
  locale: SimLocale
  onSelect: (udid: string) => void
}

/**
 * Connected picker: refreshes the device list from the host on every open
 * (focus precedes open — no polling, no fetch during render/SSR). A failed
 * listing keeps the previous/current-device-only state and is retried on the
 * next open.
 */
export function SimDevicePicker({
  fetcher,
  currentRealUdid,
  currentRealDevice,
  currentDevice,
  switching,
  error,
  locale,
  onSelect,
}: SimDevicePickerProps): React.JSX.Element {
  const [devices, setDevices] = useState<SimDeviceEntry[]>([])
  const [realDevices, setRealDevices] = useState<SimRealDeviceEntry[]>([])
  const inflightRef = useRef(false)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const onOpen = useCallback((): void => {
    if (inflightRef.current) return
    inflightRef.current = true
    void requestSimDevices(fetcherRef.current ?? fetch).then(listing => {
      inflightRef.current = false
      setDevices(listing.devices)
      setRealDevices(listing.realDevices)
    })
  }, [])
  return (
    <SimDevicePickerBody
      devices={devices}
      realDevices={realDevices}
      {...(currentRealUdid === undefined ? {} : { currentRealUdid })}
      {...(currentRealDevice === undefined ? {} : { currentRealDevice })}
      currentDevice={currentDevice}
      switching={switching}
      error={error}
      locale={locale}
      onSelect={onSelect}
      onOpen={onOpen}
    />
  )
}

/** Synthetic sim-stream meta for the switched device — the meta the panel
 * adopts after a switch (the same capsule-style synthetic source
 * `simSwitchedPanelRequestOf` wraps for the panel store/registry). */
export function simSwitchedStreamMetaOf(result: SimSwitchResponse): SimStreamMeta {
  const device: SimDeviceInfo = {
    udid: result.device,
    ...(typeof result.deviceName === 'string' && result.deviceName !== ''
      ? { name: result.deviceName }
      : {}),
  }
  return { kind: 'sim-stream', device }
}

export interface SimDeviceSwitchControllerOptions {
  /** Fetcher to POST the switch-device endpoint with (defaults to fetch). */
  fetcher?: SimFetcher
  /** Locale table used to localize the route's failure code (simCopy). */
  copy?: Record<string, string>
  /** Observes the transitional flag (true on pick, false on failure; on
   * success the panel clears it once the new stream goes live). */
  onSwitchingChange?: (switching: boolean) => void
  /** The parsed capability + device identity of a successful switch. */
  onSwitched: (result: SimSwitchResponse) => void
  /** The failure message of a rejected switch (409/5xx/parse failure). */
  onError: (message: string) => void
}

export interface SimDeviceSwitchController {
  /** POST the switch-device route for `udid`; false while one is in flight
   * (the client-side half of the no-concurrent-switches contract). */
  switchTo: (udid: string) => boolean
  dispose: () => void
}

/**
 * The pure device-switch state machine: POSTs `/_dsh/dsh-ios/switch-device`
 * `{ device }`, guards against concurrent switches, and reports the parsed
 * result or the failure. The dev-panel-smoke script drives it with a mocked
 * fetcher; the panel binds it to its seeded-grant flow.
 */
export function createSimDeviceSwitchController(
  options: SimDeviceSwitchControllerOptions,
): SimDeviceSwitchController {
  const fetcher = options.fetcher ?? fetch
  let inflight = false
  let disposed = false
  return {
    switchTo(udid) {
      if (disposed || inflight || udid === '') return false
      inflight = true
      options.onSwitchingChange?.(true)
      void requestSwitchDevice(fetcher, udid).then(result => {
        inflight = false
        if (disposed) return
        if (result.ok) {
          options.onSwitched(result.switched)
          // Switching stays true: the panel clears it when the stream seeded
          // from the returned capability reaches the live phase (or falls
          // back) — the spinner spans "old stream closes → new grant lands".
        } else {
          options.onError(simRouteErrorTextOf(result, options.copy ?? {}))
          options.onSwitchingChange?.(false)
        }
      })
      return true
    },
    dispose() {
      disposed = true
    },
  }
}
