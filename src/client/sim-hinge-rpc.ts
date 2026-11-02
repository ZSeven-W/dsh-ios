import type { SimFetcher, SimWebSocketLike } from './protocol.js'
import { decodeHingeWire, encodeHingeWire } from '../hinge-wire.js'

/** Reuse the live socket: long-lived HTTP video/SSE must not queue controls. */
export function createSimHingeRpc(socket: SimWebSocketLike, device: string, onTimeout?: () => void) {
  let sequence = 0, closed = false
  const pending = new Map<number, { finish: (error?: Error, value?: unknown) => void }>()
  const fetcher: SimFetcher = async (input, init) => {
    if (closed || socket.readyState !== 1) throw new Error('Duo control connection closed; reconnect the preview')
    if (String(input) !== '/_dsh/dsh-ios/hinge' || init?.method !== 'POST' || typeof init.body !== 'string') {
      throw new Error('Invalid Duo control request')
    }
    const body = JSON.parse(init.body) as Record<string, unknown>
    if (body.device !== device) throw new Error('Duo control request targets another device')
    const signal = init.signal
    signal?.throwIfAborted()
    if (pending.size) throw new Error('Duo control request already in progress')
    const id = ++sequence
    const result = await new Promise<unknown>((resolve, reject) => {
      const cancel = (): void => {
        try { if (socket.readyState === 1) socket.send(encodeHingeWire({ id, cancel: true })) } catch { /* disconnected */ }
      }
      const abort = (): void => { cancel(); finish(new Error('Duo control request cancelled')) }
      const timer = setTimeout(() => {
        cancel()
        finish(new Error('Duo control response timed out; reconnecting. Device state is unconfirmed'))
        closed = true
        onTimeout?.()
      }, body.action === 'status' ? 18_000 : 33_000)
      const finish = (error?: Error, value?: unknown): void => {
        if (!pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error); else resolve(value)
      }
      pending.set(id, { finish })
      signal?.addEventListener('abort', abort, { once: true })
      try { socket.send(encodeHingeWire({ id, action: body.action, angle: body.angle })) }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return {
    fetcher,
    receive(data: unknown): boolean {
      const reply = decodeHingeWire(data)
      if (!reply) return false
      if (typeof reply.id === 'number') pending.get(reply.id)?.finish(undefined, reply.result)
      return true
    },
    close(): void {
      closed = true
      for (const item of pending.values()) item.finish(new Error('Duo control connection closed; reconnect the preview'))
    },
  }
}
