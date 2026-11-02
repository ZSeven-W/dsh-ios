/** Plugin RPC envelope; never forwarded to the native HID protocol. */
const prefix = 'dsh-ios:hinge:v1:'
export function encodeHingeWire(value: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(prefix + JSON.stringify(value))
}
export function decodeHingeWire(data: unknown): Record<string, unknown> | undefined {
  const text = typeof data === 'string' ? data
    : data instanceof ArrayBuffer ? new TextDecoder().decode(data)
      : data instanceof Uint8Array ? new TextDecoder().decode(data) : ''
  if (!text.startsWith(prefix)) return undefined
  if (text.length > 16_384) return {}
  try {
    const value: unknown = JSON.parse(text.slice(prefix.length))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : {}
  } catch { return {} }
}
