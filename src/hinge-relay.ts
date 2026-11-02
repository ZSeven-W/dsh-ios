import { decodeHingeWire, encodeHingeWire } from './hinge-wire.js'
import { hingeTargetAngle, runStreamHingeAction, type HingeArgs } from './hinge.js'
import { listDevices } from './simctl.js'
import type { SimHostController } from './sim-host.js'

/** Bound to the device in the verified stream capability, never a client UDID. */
export function createHingeRelay(host: SimHostController, device: string, send: (data: Uint8Array) => void) {
  let closed = false
  let active: { id: number; controller: AbortController } | undefined
  const reply = (id: number, result: unknown): void => {
    if (!closed) { try { send(encodeHingeWire({ id, result })) } catch { /* peer closed */ } }
  }
  return {
    receive(data: unknown): boolean {
      const value = decodeHingeWire(data)
      if (!value) return false
      if (closed || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) return true
      const id = value.id as number
      if (value.cancel === true) {
        if (active?.id === id) active.controller.abort()
        return true
      }
      if (active) { reply(id, { ok: false, error: 'Duo control request already in progress' }); return true }
      const controller = new AbortController()
      active = { id, controller }
      void (async () => {
        const args = { action: value.action, angle: value.angle } as HingeArgs
        const timer = setTimeout(() => controller.abort(new Error('Duo device operation timed out; state is unconfirmed')),
          args.action === 'status' ? 16_000 : 30_000)
        try {
          hingeTargetAngle(args)
          const target = (await listDevices(controller.signal)).find(d => d.udid === device)
          controller.signal.throwIfAborted()
          if (!target) throw new Error('Duo simulator is unavailable')
          const result = await runStreamHingeAction(host, target, args, controller.signal)
          controller.signal.throwIfAborted()
          reply(id, { ok: true, ...result })
        } catch (error) {
          const reason = controller.signal.reason ?? error
          reply(id, { ok: false, error: reason instanceof Error ? reason.message : String(reason) })
        } finally { clearTimeout(timer); if (active?.id === id) active = undefined }
      })()
      return true
    },
    close(): void { closed = true; active?.controller.abort() },
  }
}
