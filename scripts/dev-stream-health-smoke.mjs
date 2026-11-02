import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const runtime = createRequire(require.resolve('react-dom/server'))
const React = runtime('react')
const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
const equalDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

// Execute the real bundled hook with a deterministic hook scheduler and clock.
// The assertions observe fetches, connection reports and cleanup, not source text.
function harness() {
  let cursor = 0, dirty = true, mounted = true, now = 0, nextId = 0, api, session
  const slots = [], effects = [], timers = new Map(), sockets = [], reports = [], grants = []
  const schedule = (fn, ms, repeat = false) => {
    const id = ++nextId
    timers.set(id, { fn, at: now + ms, ms, repeat })
    return id
  }
  const clear = id => timers.delete(id)
  const hooks = {
    ...React,
    useState(initial) {
      const i = cursor++
      slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      slots[i].set ??= value => {
        const next = typeof value === 'function' ? value(slots[i].value) : value
        if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true }
      }
      return [slots[i].value, slots[i].set]
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    useCallback(fn, deps) {
      const i = cursor++
      if (!equalDeps(slots[i]?.deps, deps)) slots[i] = { fn, deps }
      return slots[i].fn
    },
    useEffect(fn, deps) {
      const i = cursor++
      if (!equalDeps(slots[i]?.deps, deps)) {
        const old = slots[i]
        slots[i] = { deps, cleanup: old?.cleanup }
        effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn() })
      }
    },
  }
  const win = {
    location: { protocol: 'http:', host: 'localhost' },
    __ModuleLoader__: { load({ factory }) { api = factory(id => id === 'react' ? hooks : runtime(id)) } },
  }
  new Function('window', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', source)(
    win, (fn, ms) => schedule(fn, ms), clear, (fn, ms) => schedule(fn, ms, true), clear,
  )
  const fetcher = async (_url, init) => {
    grants.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({ ok: true, streamUrl: '/stream', wsUrl: '/ws' }) }
  }
  const wsFactory = () => {
    const listeners = new Map()
    const ws = {
      readyState: 0,
      addEventListener(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list) },
      emit(type, data) { for (const fn of listeners.get(type) ?? []) fn(data) },
      open() { this.readyState = 1; this.emit('open') },
      close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close') },
      sent: [],
      send(data) { this.sent.push(data) },
    }
    sockets.push(ws)
    return ws
  }
  const options = { meta: { kind: 'sim-stream', device: { udid: 'test-device' } },
    fetcher, wsFactory, unavailableCopy: 'unavailable', onConnectionChange: value => reports.push(value) }
  async function flush() {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
      if (dirty && mounted) {
        dirty = false; cursor = 0
        session = api.useSimStream(options)
        session.imgRef.current ??= { naturalWidth: 2007, naturalHeight: 2853, removeAttribute() {} }
        while (effects.length) effects.shift()()
      }
    }
  }
  return {
    grants, sockets, reports,
    get session() { return session },
    flush,
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry) break
        const [id, t] = entry
        now = t.at
        if (t.repeat) t.at += t.ms; else timers.delete(id)
        t.fn(); await flush()
      }
      now = end; await flush()
    },
    unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.() },
    get pendingTimers() { return timers.size },
  }
}

{
  const h = harness(); await h.flush(); h.sockets[0].open(); await h.flush()
  h.session.imgRef.current.naturalWidth = 0
  h.session.onFrameLoad(); await h.flush()
  assert.equal(h.session.videoReady, false, 'zero-size load cannot report a decoded frame')
  h.session.imgRef.current.naturalWidth = 2007
  h.session.onFrameLoad(); await h.flush()
  assert.equal(h.reports.at(-1), true)
  await h.advance(60_000)
  assert.equal(h.grants.length, 1, 'unchanged decoded screen is healthy')
  h.session.imgRef.current.naturalWidth = 0
  h.session.imgRef.current.naturalHeight = 0
  await h.advance(1500)
  assert.equal(h.reports.at(-1), false, 'discarded decoded image clears Live')
  await h.advance(500)
  assert.equal(h.grants.length, 2, 'silently discarded image re-grants with bounded retry')
  h.unmount(); assert.equal(h.pendingTimers, 0)
  console.log('PASS zero-size load rejected, discarded MJPEG recovered, static screen retained')
}

{
 const h=harness();await h.flush();h.sockets[0].open();await h.flush()
 h.session.onFrameLoad();await h.flush();const count=h.reports.length
 for(let i=0;i<60;i++)h.session.onFrameLoad();await h.flush()
 assert.equal(h.reports.length,count,'decoded video frames must not repeatedly update the whole panel connection state')
 h.unmount();console.log('PASS continuous frames report readiness once per session')
}

{
  const h = harness(); await h.flush()
  assert.equal(h.grants.length, 1)
  h.sockets[0].open(); await h.flush()
  assert.equal(h.reports.at(-1), false, 'control socket alone must not report video live')
  h.session.onFrameLoad(); await h.flush()
  assert.equal(h.reports.at(-1), true, 'first decoded image and open controls report live')
  const bytes = new TextEncoder().encode(JSON.stringify({ width: 2007, height: 2853, orientation: 'landscape_left' }))
  h.sockets[0].emit('message', { data: Uint8Array.from([130, ...bytes]).buffer }); await h.flush()
  assert.deepEqual(h.session.frameSize, { width: 2007, height: 2853 })
  assert.equal(h.session.orientation, 'landscape_left')
  h.sockets[0].close(); h.session.retryOnce(); await h.flush()
  await h.advance(499); assert.equal(h.grants.length, 1)
  await h.advance(1); assert.equal(h.grants.length, 2, 'img/ws errors share one delayed retry')
  h.unmount(); assert.equal(h.pendingTimers, 0)
  console.log('PASS first-frame readiness, Duo size/config update, coalesced backoff, cleanup')
}
{
  const h = harness(); await h.flush()
  for (const delay of [500, 1000, 2000]) {
    h.sockets.at(-1).open(); await h.flush()
    await h.advance(12_000 + delay)
  }
  h.sockets.at(-1).open(); await h.flush()
  await h.advance(12_000)
  assert.equal(h.grants.length, 4, 'three automatic retries only')
  assert.equal(h.session.phase, 'fallback', 'connected WS with no video eventually exposes retry')
  assert.equal(h.reports.at(-1), false)
  h.unmount(); assert.equal(h.pendingTimers, 0)
  console.log('PASS open control socket with no video times out and exhausts bounded retry')
}
{
  const h = harness(); await h.flush()
  h.sockets[0].close(); await h.flush()
  h.unmount(); await h.advance(60_000)
  assert.equal(h.grants.length, 1, 'unmount must cancel scheduled reconnect')
  assert.equal(h.pendingTimers, 0)
  console.log('PASS unmount cancels reconnect and first-frame timers')
}

{
 const h=harness();await h.flush();const ws=h.sockets[0];ws.open();await h.flush()
 const pending=h.session.hingeFetcher('/_dsh/dsh-ios/hinge',{method:'POST',body:JSON.stringify({device:'test-device',action:'half'})})
 const text=new TextDecoder().decode(ws.sent[0]);const envelope=JSON.parse(text.slice('dsh-ios:hinge:v1:'.length))
 ws.emit('message',{data:new TextEncoder().encode('dsh-ios:hinge:v1:'+JSON.stringify({id:envelope.id,result:{ok:true,angle:90}})).buffer})
 assert.equal((await (await pending).json()).angle,90);assert.equal(h.grants.length,1,'hinge does not use another HTTP fetch')
 const lost=h.session.hingeFetcher('/_dsh/dsh-ios/hinge',{method:'POST',body:JSON.stringify({device:'test-device',action:'status'})})
 const rejected=assert.rejects(lost,/closed/);h.unmount();await rejected
 console.log('PASS real stream hook routes hinge over its existing WS and cancels on unmount')
}

{
 const h=harness();await h.flush();h.sockets[0].open();await h.flush();h.session.onFrameLoad();await h.flush()
 const p=h.session.hingeFetcher('/_dsh/dsh-ios/hinge',{method:'POST',body:JSON.stringify({device:'test-device',action:'half'})})
 const rejected=assert.rejects(p,/timed out/);await h.advance(33000);await rejected;await h.advance(500)
 assert.equal(h.grants.length,2,'silent hinge transport timeout re-grants the session')
 assert.equal(h.sockets[0].readyState,3,'old control socket retired')
 assert.equal(h.sockets[1].sent.length,0,'unknown mutation is never replayed')
 h.unmount();console.log('PASS silent control timeout reconnects preview without replaying mutation')
}
