/** Coordinate native AX requests with posture changes, including panel actions.
 * No observations are cached. Mutations cancel old reads before taking the slot. */
interface Slot { tail: Promise<unknown>; reads: Set<AbortController> }
const slots = new Map<string, Slot>()
function slotOf(udid: string): Slot {
  let slot = slots.get(udid)
  if (!slot) { slot = { tail: Promise.resolve(), reads: new Set() }; slots.set(udid, slot) }
  return slot
}
function enqueue<T>(udid: string, slot: Slot, action: () => Promise<T>): Promise<T> {
  const task = slot.tail.catch(() => {}).then(action)
  slot.tail = task
  return task.finally(() => { if (slot.tail === task) slots.delete(udid) })
}
export function withSimDeviceRead<T>(udid: string, signal: AbortSignal | undefined,
  action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  const slot = slotOf(udid), cancel = new AbortController()
  const combined = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal
  slot.reads.add(cancel)
  return enqueue(udid, slot, async () => {
    combined.throwIfAborted()
    try { return await action(combined) }
    catch (error) { combined.throwIfAborted(); throw error }
  }).finally(() => { slot.reads.delete(cancel) })
}
export function withSimDeviceMutation<T>(udid: string, signal: AbortSignal | undefined,
  action: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  const slot = slotOf(udid)
  for (const read of slot.reads) read.abort(new DOMException(
    'Duo posture is changing; retry the accessibility read after the fold completes', 'AbortError'))
  return enqueue(udid, slot, async () => { signal?.throwIfAborted(); return action() })
}
