import { useEffect, useRef, useState } from 'react'
import type { SimFetcher } from './protocol.js'
import type { SimLocale } from './copy.js'

type Action = 'status' | 'fold' | 'unfold' | 'half' | 'set' | 'portrait' | 'landscape'
interface Posture {
  supported: boolean; angle?: number; activeDisplay?: string; displayOrientation?: 'portrait' | 'landscape'
  displays?: Array<{ name: string; size?: number[] }>
}

async function request(fetcher: SimFetcher, device: string, action: Action, signal: AbortSignal, angle?: number): Promise<Posture> {
  signal.throwIfAborted()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = (): void => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(); reject(signal.reason ?? new Error('Hinge request cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('Duo request timed out; retry the connection. The device state is unconfirmed.'))
    }, action === 'status' ? 20_000 : 35_000)
  })
  try {
    return await Promise.race([cancelled, (async () => {
      const response = await fetcher('/_dsh/dsh-ios/hinge', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ device, action, ...(angle === undefined ? {} : { angle }) }),
      })
      const body = await response.json()
      if (!response.ok || body.ok !== true) throw new Error(typeof body.error === 'string' ? body.error : 'Hinge request failed')
      return body as Posture
    })()])
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}

export function SimHingeControls({ device, deviceName, locale, fetcher = fetch, onChanged, displaySize, measuredAngle, displayOrientation, ready }: {
  device: string; deviceName: string; locale: SimLocale; fetcher?: SimFetcher; onChanged?: () => void
  displaySize?: { width: number; height: number }
  measuredAngle?: number
  displayOrientation?: 'portrait' | 'landscape'
  ready?: boolean
}): React.JSX.Element | null {
  const [posture, setPosture] = useState<Posture>()
  const [angle, setAngle] = useState(90)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const current = useRef<AbortController>()
  const inFlight = useRef(false)
  const cancelPending = (): void => {
    current.current?.abort()
  }
  useEffect(() => {
    inFlight.current = false
    const controller = new AbortController()
    current.current = controller
    setBusy(true)
    setError('')
    setPosture(undefined)
    // Wait for the live session, then obtain one fresh readback. A recovered
    // stream must also recover controls after an earlier sensor/startup error.
    if (ready === false) return cancelPending
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const load = (attempt: number): void => { void request(fetcher, device, 'status', controller.signal).then(value => {
      if (!controller.signal.aborted) { setPosture(value); setError('') }
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setError(reason instanceof Error ? reason.message : String(reason))
      // Retry a cold sensor once; never keep a background polling loop.
      if (attempt === 0) retryTimer = setTimeout(() => {
        if (!controller.signal.aborted) { setBusy(true); load(1) }
      }, 1_000)
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) }) }
    load(0)
    return () => { clearTimeout(retryTimer); controller.abort(); cancelPending() }
  }, [device, fetcher, ready])

  const run = async (action: Action): Promise<void> => {
    if (busy || inFlight.current) return
    inFlight.current = true
    cancelPending()
    const controller = new AbortController()
    current.current = controller
    setBusy(true)
    setError('')
    try {
      const value = await request(fetcher, device, action, controller.signal, action === 'set' ? angle : undefined)
      if (controller.signal.aborted) return
      setPosture(value)
      if (action !== 'status') {
        onChanged?.()
        // The endpoint already verifies the fresh angle and display. The
        // actual streamed frameSize labels delayed panel switches; extra
        // serialized status reads would compete with the next preset click.
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason))
        // A failed display transition can still have changed the angle.
        // Keep the error, and show measured state instead of the last preset.
        if (action !== 'status' && measuredAngle === undefined) {
          void request(fetcher, device, 'status', controller.signal).then(latest => {
            if (!controller.signal.aborted) setPosture(latest)
          }).catch(() => { /* retain the last verified posture when readback also fails */ })
        }
      }
    } finally { if (!controller.signal.aborted) { inFlight.current = false; setBusy(false) } }
  }

  // Capability comes from the simulator type, so renamed Duos are supported.
  // A normal iPhone stays quiet; a known Duo still shows an actionable error.
  if (posture?.supported === false || (posture === undefined && !/\biPhone Duo\b/i.test(deviceName))) return null
  const livePosture = !busy && posture && measuredAngle !== undefined
    ? { ...posture, angle: measuredAngle } : posture
  return <HingeControlBody locale={locale} posture={livePosture} displaySize={displaySize} angle={angle} busy={busy} error={error} displayOrientation={displayOrientation ?? posture?.displayOrientation}
    onAngle={setAngle} onAction={action => { void run(action) }} />
}

/** Pure surface, also used for SSR acceptance checks. */
export function HingeControlBody({ locale, posture, displaySize, angle, busy, error, onAngle, onAction, displayOrientation }: {
  locale: SimLocale; posture?: Posture; angle: number; busy: boolean; error: string;
  displaySize?: { width: number; height: number }
  displayOrientation?: 'portrait' | 'landscape'
  onAngle: (angle: number) => void; onAction: (action: Action) => void
}): React.JSX.Element {
  const zh = locale === 'zh'
  const valid = Number.isFinite(angle) && angle >= 0 && angle <= 180
  // The streamed config can finish switching after the hinge readback.
  // Label the screen actually being previewed, using measured panel sizes.
  const previewDisplay = displaySize === undefined ? undefined : posture?.displays?.find(d =>
    d.size?.[0] === displaySize.width && d.size?.[1] === displaySize.height)?.name
  const display = previewDisplay ?? posture?.activeDisplay
  const panel = display === 'LCD' ? (zh ? '外屏' : 'Cover')
    : display === 'LCD-1' ? (zh ? '内屏' : 'Inner') : display
  const [expanded, setExpanded] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { if (error) setExpanded(true) }, [error])
  useEffect(() => {
    if (!expanded) return
    const dismiss = (event: PointerEvent): void => {
      if (root.current?.contains(event.target as Node) !== true) setExpanded(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setExpanded(false)
        root.current?.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [expanded])
  const status = busy ? (zh ? '正在读取或调整设备…' : 'Reading or adjusting device…')
    : posture?.angle !== undefined ? `${panel} · ${posture.angle}° · ${zh ? '实时画面' : 'Live screen'}`
      : (zh ? '铰链状态未确认' : 'Hinge state unconfirmed')
  return (
    <div ref={root} className="dsh-hinge" aria-label={zh ? '铰链控制' : 'Hinge controls'} aria-busy={busy}
      data-sim-hinge-toolbar="true"
      style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto',
        flexShrink: 0, padding: 2, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', fontSize: 12, lineHeight: '16px' }}>
      <style>{`.dsh-hinge button{border:0;border-radius:4px;padding:4px 8px;min-height:28px;color:inherit;background:transparent;font:inherit;cursor:pointer;white-space:nowrap}.dsh-hinge button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-hinge button:active{transform:scale(.98)}.dsh-hinge button:focus-visible,.dsh-hinge input:focus-visible{outline:2px solid currentColor;outline-offset:2px}.dsh-hinge button:disabled{opacity:.5;cursor:default}`}</style>
      <div role="group" aria-label={zh ? '折叠与展开' : 'Fold and unfold'} style={{ display: 'flex', gap: 2 }}>
        {(['fold', 'half', 'unfold'] as const).map((action, i) => {
          const label = (zh ? ['折叠 0°', '半展开 90°', '展开 180°'] : ['Fold 0°', 'Half 90°', 'Unfold 180°'])[i]
          return <button key={action} type="button" aria-label={label} title={label}
            aria-pressed={posture?.angle === [0, 90, 180][i]}
            style={{ background: posture?.angle === [0, 90, 180][i]
              ? 'var(--dsw-alias-interactive-bg-active)' : undefined }}
            disabled={busy || posture?.supported !== true}
            onClick={() => { setExpanded(false); onAction(action) }}>
            {[0, 90, 180][i]}°
          </button>
        })}
      </div>
      <div role="group" aria-label={zh ? '屏幕方向' : 'Screen orientation'} style={{ display: 'flex', gap: 2, marginLeft: 4 }}>
        {(['portrait', 'landscape'] as const).map(direction => {
          const label = direction === 'portrait' ? (zh ? '竖屏' : 'Portrait') : (zh ? '横屏' : 'Landscape')
          return <button key={direction} type="button" aria-label={label} title={label}
            data-sim-display-orientation={direction} aria-pressed={displayOrientation === direction}
            style={{ background: displayOrientation === direction ? 'var(--dsw-alias-interactive-bg-active)' : undefined }}
            disabled={busy || posture?.supported !== true}
            onClick={() => { setExpanded(false); onAction(direction) }}>{label}</button>
        })}
      </div>
      {error && <button type="button" disabled={busy} onClick={() => onAction('status')}
        title={error}>{zh ? '重试连接' : 'Retry connection'}</button>}
      <button type="button" aria-label={zh ? '铰链设置' : 'Hinge settings'} aria-haspopup="dialog"
        aria-expanded={expanded} title={error || status} onClick={() => setExpanded(value => !value)}>
        {posture?.angle !== undefined && ![0, 90, 180].includes(posture.angle) ? `${posture.angle}° ` : ''}
        <span aria-hidden="true">{error ? '!' : '⋯'}</span>
      </button>
      <div role="dialog" aria-label={zh ? '铰链设置' : 'Hinge settings'} hidden={!expanded}
        style={{ display: expanded ? 'block' : 'none', position: 'absolute', right: 0, top: 'calc(100% + 8px)',
          zIndex: 40, width: 240, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', padding: 12,
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-1)', boxShadow: '0 8px 24px rgba(0,0,0,.18)',
          fontSize: 14, lineHeight: '20px', maxHeight: '60vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div role="status" aria-live="polite" title={display} style={{ flex: 1 }}>{status}</div>
          <button type="button" aria-label={zh ? '关闭铰链设置' : 'Close hinge settings'}
            onClick={() => setExpanded(false)}>×</button>
        </div>
        <button type="button" disabled={busy} onClick={() => onAction('status')}
          style={{ marginTop: 8 }}>{zh ? '读取状态' : 'Read status'}</button>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <label>{zh ? '角度 ' : 'Angle '}<input type="number" min={0} max={180} step={1}
            value={Number.isNaN(angle) ? '' : angle} disabled={busy}
            onChange={event => onAngle(event.currentTarget.valueAsNumber)}
            style={{ width: 64, padding: 4, borderRadius: 4, font: 'inherit', color: 'inherit',
              background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)' }} />°</label>
          <button type="button" disabled={busy || !valid || posture?.supported !== true}
            onClick={() => onAction('set')}>{zh ? '设置角度' : 'Set angle'}</button>
        </div>
        <div style={{ marginTop: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '16px' }}>
          {zh ? '直接显示模拟器的活动屏幕，折叠和横竖屏控制均作用于真实模拟器。' : 'Shows the active simulator screen. Fold and orientation controls operate the simulator.'}
        </div>
        {error ? <div role="alert" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>{error}</div> : null}
      </div>
    </div>
  )
}
