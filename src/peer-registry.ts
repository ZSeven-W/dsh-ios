/**
 * Optional in-process peer discovery between `@zseven-w/dsh-ios` and
 * `@zseven-w/dsh-xcode`.
 *
 * Neither plugin imports or depends on the other. Both inspect the same
 * versioned `Symbol.for(...)` slot on `globalThis` and unregister on dispose,
 * so installing either plugin alone works identically while installing both
 * unlocks live cross-plugin status and smart preview/diagnostics routing.
 *
 * @module @zseven-w/dsh-ios/peer-registry
 */

export const APPLE_PEER_SYMBOL = Symbol.for('zseven.dsh.apple.peer.v1')

export interface IosPeerStreamedDevice {
  udid: string
  name: string
  runtime?: string
  kind: 'simulator' | 'physical'
}

export interface IosPeerSnapshot {
  version: string
  online: boolean
  streamedDevice: IosPeerStreamedDevice | null
  serveSimSource: string
  wdaAvailable: boolean
}

export interface XcodePeerWindow {
  tabIdentifier: string
  workspacePath?: string
  name?: string
}

export interface XcodePeerSnapshot {
  version: string
  connected: boolean
  mcpbridgeAvailable: boolean
  xcodeVersion?: string
  xcodeBuild?: string
  xcodePid?: number
  openWindows: XcodePeerWindow[]
}

export interface ApplePeerRegistry {
  ios?: () => IosPeerSnapshot
  xcode?: () => XcodePeerSnapshot
}

function registry(): ApplePeerRegistry {
  const host = globalThis as Record<symbol, unknown>
  const existing = host[APPLE_PEER_SYMBOL]
  if (typeof existing === 'object' && existing !== null) {
    return existing as ApplePeerRegistry
  }
  const created: ApplePeerRegistry = {}
  host[APPLE_PEER_SYMBOL] = created
  return created
}

export function registerIosPeer(getter: () => IosPeerSnapshot): () => void {
  const reg = registry()
  reg.ios = getter
  return () => {
    if (reg.ios === getter) delete reg.ios
  }
}

export function registerXcodePeer(getter: () => XcodePeerSnapshot): () => void {
  const reg = registry()
  reg.xcode = getter
  return () => {
    if (reg.xcode === getter) delete reg.xcode
  }
}

export function readIosPeer(): IosPeerSnapshot | null {
  try {
    return registry().ios?.() ?? null
  } catch {
    return null
  }
}

export function readXcodePeer(): XcodePeerSnapshot | null {
  try {
    return registry().xcode?.() ?? null
  } catch {
    return null
  }
}
