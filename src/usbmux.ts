/**
 * Minimal built-in usbmuxd client — replaces the `iproxy` dependency for the
 * WDA USB port forward.
 *
 * `iproxy` on this machine is a 2019 Homebrew build (`usbmuxd-flutter`) whose
 * whole usage is `iproxy <local> <device> <udid>` with no `--local`/`--network`
 * flags. When usbmuxd lists the SAME phone TWICE — once `ConnectionType=Network`
 * (Wi-Fi sync pairing) and once `ConnectionType=USB` — the legacy binary picks
 * the Network record and dies with `Error connecting to device!`, even though
 * the cable is fine. Speaking the usbmux protocol ourselves lets us pin the
 * USB record by device id, so a Wi-Fi-only pairing can never shadow the cable.
 *
 * Protocol (verified live against /var/run/usbmuxd on this machine):
 * - socket: AF_UNIX `/var/run/usbmuxd`;
 * - every message: a 16-byte LITTLE-ENDIAN header
 *   `[uint32 totalLength (header included), uint32 version=1, uint32 messageType=8, uint32 tag]`
 *   followed by a plist payload. We SEND XML plists; the daemon replies in
 *   KIND, and on this machine that is an XML plist (not binary) — so the
 *   reply reader handles BOTH, choosing by the first bytes, and the XML
 *   reader below covers the real path while the binary reader covers usbmuxd
 *   builds that answer `bplist00`;
 * - `ListDevices` → `DeviceList[]` of `{DeviceID, Properties}`;
 *   `Connect` → `{MessageType:'Result', Number:0}` and, on a zero result,
 *   the SAME socket becomes the raw byte tunnel (no further framing).
 * @module @zseven-w/dsh-ios/usbmux
 */

import { existsSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { parseBinaryPlist, parseXmlPlist } from './plist.js'

const USBMUX_SOCKET_PATH = '/var/run/usbmuxd'
const USBMUX_HEADER_BYTES = 16
const USBMUX_MESSAGE_TYPE_PLIST = 8
const USBMUX_VERSION = 1
const USBMUX_IO_TIMEOUT_MS = 10_000
/** Upper bound on one usbmuxd reply (a DeviceList is tiny); guards the reader. */
const USBMUX_MAX_MESSAGE_BYTES = 1024 * 1024

export interface UsbmuxDevice {
  deviceId: number
  udid: string
  connection: 'usb' | 'network'
}

/** Injectable device lister (the smoke drives resolution without a socket). */
export type UsbmuxLister = () => Promise<UsbmuxDevice[]>

export interface UsbmuxForwardOptions {
  udid: string
  devicePort: number
  localPort: number
  /** Bind host (default 127.0.0.1). */
  host?: string
}

export interface UsbmuxForward {
  readonly localPort: number
  readonly connections: number
  close(): Promise<void>
}

/** Why a WDA tunnel could not be established (drives the actionable text). */
export type UsbmuxTunnelFailure = 'usb-link-up' | 'network-only' | 'not-attached'

export interface UsbmuxHeader {
  totalLength: number
  version: number
  messageType: number
  tag: number
}

// ── header framing (little-endian, 4× uint32) ──────────────────────────────

export function encodeUsbmuxHeader(header: UsbmuxHeader): Buffer {
  const buffer = Buffer.alloc(USBMUX_HEADER_BYTES)
  buffer.writeUInt32LE(header.totalLength >>> 0, 0)
  buffer.writeUInt32LE(header.version >>> 0, 4)
  buffer.writeUInt32LE(header.messageType >>> 0, 8)
  buffer.writeUInt32LE(header.tag >>> 0, 12)
  return buffer
}

export function decodeUsbmuxHeader(buffer: Buffer): UsbmuxHeader {
  if (buffer.length < USBMUX_HEADER_BYTES) {
    throw new Error('dsh-ios: usbmux header is shorter than 16 bytes')
  }
  return {
    totalLength: buffer.readUInt32LE(0),
    version: buffer.readUInt32LE(4),
    messageType: buffer.readUInt32LE(8),
    tag: buffer.readUInt32LE(12),
  }
}

/**
 * The `PortNumber` usbmuxd expects is the port byte-swapped (big-endian as a
 * 16-bit int on a little-endian host — i.e. `htons`). 8100 → 0xA41F, 9100 → 0x8C23.
 */
export function swapPortByteOrder(port: number): number {
  return ((port << 8) | (port >> 8)) & 0xffff
}

// ── XML plist writer (we only ever SEND; strings/ints/bools) ───────────────

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function buildXmlPlist(dict: Record<string, unknown>): string {
  let body = ''
  for (const [key, value] of Object.entries(dict)) {
    body += `<key>${escapeXml(key)}</key>`
    if (typeof value === 'string') body += `<string>${escapeXml(value)}</string>`
    else if (typeof value === 'number') body += `<integer>${value}</integer>`
    else if (typeof value === 'boolean') body += value ? '<true/>' : '<false/>'
    else throw new Error(`dsh-ios: unsupported usbmux plist value for key "${key}"`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>`
}

/** Parse a usbmuxd plist reply in whichever encoding it arrived (binary OR XML). */
export function parseUsbmuxPlist(payload: Buffer): unknown {
  if (payload.toString('latin1', 0, 8) === 'bplist00') return parseBinaryPlist(payload)
  return parseXmlPlist(payload.toString('utf8'))
}

// ── socket plumbing ────────────────────────────────────────────────────────

function connectUsbmux(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(USBMUX_SOCKET_PATH)
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('error', onError)
      if (error !== undefined) reject(error)
      else resolve(socket)
    }
    const onConnect = (): void => finish(undefined)
    const onError = (error: Error): void => finish(error)
    const timer = setTimeout(() => {
      socket.destroy()
      finish(new Error(`dsh-ios: usbmuxd did not accept a connection on ${USBMUX_SOCKET_PATH} within ${USBMUX_IO_TIMEOUT_MS} ms`))
    }, USBMUX_IO_TIMEOUT_MS)
    timer.unref?.()
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

function sendUsbmuxMessage(socket: Socket, message: Record<string, unknown>): Promise<void> {
  const payload = Buffer.from(buildXmlPlist(message), 'utf8')
  const header = encodeUsbmuxHeader({
    totalLength: USBMUX_HEADER_BYTES + payload.length,
    version: USBMUX_VERSION,
    messageType: USBMUX_MESSAGE_TYPE_PLIST,
    tag: 0,
  })
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off('error', onError)
      reject(error)
    }
    socket.once('error', onError)
    socket.write(Buffer.concat([header, payload]), error => {
      socket.off('error', onError)
      // Node's write callback passes `null` (not `undefined`) on success.
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    })
  })
}

/** Read one framed usbmuxd message (header + payload), keeping any overflow. */
function readUsbmuxMessage(socket: Socket): Promise<{ header: UsbmuxHeader; payload: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0)
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      reject(error)
    }
    const succeed = (header: UsbmuxHeader, payload: Buffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      resolve({ header, payload })
    }
    const onData = (chunk: Buffer): void => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      if (buffer.length < USBMUX_HEADER_BYTES) return
      const header = decodeUsbmuxHeader(buffer)
      if (header.totalLength < USBMUX_HEADER_BYTES || header.totalLength > USBMUX_MAX_MESSAGE_BYTES) {
        fail(new Error(`dsh-ios: usbmuxd message length ${header.totalLength} is out of range`))
        return
      }
      if (buffer.length < header.totalLength) return
      const payload = buffer.subarray(USBMUX_HEADER_BYTES, header.totalLength)
      const leftover = buffer.subarray(header.totalLength)
      // Pause before unshifting so the remainder is re-emitted, not dropped,
      // when the caller pipes this socket as the raw device tunnel.
      socket.pause()
      if (leftover.length > 0) socket.unshift(leftover)
      succeed(header, payload)
    }
    const onError = (error: Error): void => fail(error)
    const onClose = (): void => fail(new Error('dsh-ios: usbmuxd closed the socket before replying'))
    const timer = setTimeout(() => {
      fail(new Error(`dsh-ios: usbmuxd did not reply within ${USBMUX_IO_TIMEOUT_MS} ms`))
    }, USBMUX_IO_TIMEOUT_MS)
    timer.unref?.()
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

async function readUsbmuxReply(socket: Socket): Promise<unknown> {
  const { header, payload } = await readUsbmuxMessage(socket)
  if (header.version !== USBMUX_VERSION) {
    throw new Error(`dsh-ios: usbmuxd spoke version ${header.version}, expected ${USBMUX_VERSION}`)
  }
  if (header.messageType !== USBMUX_MESSAGE_TYPE_PLIST) {
    throw new Error(`dsh-ios: usbmuxd message type ${header.messageType} is not a plist`)
  }
  return parseUsbmuxPlist(payload)
}

/** One usbmux request/response round-trip over a fresh socket. */
async function usbmuxRequest(message: Record<string, unknown>): Promise<unknown> {
  const socket = await connectUsbmux()
  try {
    await sendUsbmuxMessage(socket, message)
    return await readUsbmuxReply(socket)
  } finally {
    socket.destroy()
  }
}

// ── reply coercion (reject anything unexpected, never guess) ───────────────

function asDict(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`dsh-ios: usbmuxd ${what} is not a dict`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`dsh-ios: usbmuxd ${what} is not a string`)
  return value
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`dsh-ios: usbmuxd ${what} is not an integer`)
  }
  return value
}

function parseUsbmuxDevice(entry: unknown): UsbmuxDevice {
  const dict = asDict(entry, 'DeviceList entry')
  const deviceId = asNumber(dict.DeviceID, 'DeviceID')
  const properties = asDict(dict.Properties, 'Device properties')
  const connectionType = asString(properties.ConnectionType, 'ConnectionType')
  const connection = connectionType === 'USB' ? 'usb' : connectionType === 'Network' ? 'network' : undefined
  if (connection === undefined) {
    throw new Error(`dsh-ios: usbmuxd ConnectionType "${connectionType}" is neither USB nor Network`)
  }
  return { deviceId, udid: asString(properties.SerialNumber, 'SerialNumber'), connection }
}

// ── public API ─────────────────────────────────────────────────────────────

export function usbmuxAvailable(): boolean {
  return existsSync(USBMUX_SOCKET_PATH)
}

export async function listUsbmuxDevices(): Promise<UsbmuxDevice[]> {
  const reply = asDict(await usbmuxRequest({
    MessageType: 'ListDevices',
    ClientVersionString: 'dsh-ios',
    ProgName: 'dsh-ios',
    kLibUSBMuxVersion: 3,
  }), 'ListDevices reply')
  const deviceList = reply.DeviceList
  if (!Array.isArray(deviceList)) throw new Error('dsh-ios: usbmuxd ListDevices reply has no DeviceList array')
  return deviceList.map(parseUsbmuxDevice)
}

/** The USB record only: a phone present only as Network resolves undefined —
 * that is exactly the state that broke iproxy, so we refuse to forward it. */
export function pickUsbDeviceId(devices: UsbmuxDevice[], udid: string): number | undefined {
  for (const device of devices) {
    if (device.udid === udid && device.connection === 'usb') return device.deviceId
  }
  return undefined
}

export async function resolveUsbDeviceId(udid: string, list: UsbmuxLister = listUsbmuxDevices): Promise<number | undefined> {
  return pickUsbDeviceId(await list(), udid)
}

/** Classify why a tunnel cannot be established, from what usbmuxd lists. */
export async function classifyUsbmuxTunnelFailure(udid: string, list: UsbmuxLister = listUsbmuxDevices): Promise<UsbmuxTunnelFailure> {
  if (!usbmuxAvailable()) return 'not-attached'
  let devices: UsbmuxDevice[]
  try {
    devices = await list()
  } catch {
    return 'not-attached'
  }
  const mine = devices.filter(device => device.udid === udid)
  if (mine.some(device => device.connection === 'usb')) return 'usb-link-up'
  if (mine.some(device => device.connection === 'network')) return 'network-only'
  return 'not-attached'
}

/** One-sentence, actionable UI text for each distinguishable tunnel failure. */
export function usbmuxTunnelFailureDetail(kind: UsbmuxTunnelFailure): string {
  switch (kind) {
    case 'usb-link-up':
      return 'the USB link is up but the port forward failed — WebDriverAgent may not be listening yet; re-run'
    case 'network-only':
      return 'this phone is reachable over Wi-Fi only; WebDriverAgent needs the USB cable — plug it in (Wi-Fi sync pairing cannot carry the port forward)'
    case 'not-attached':
      return 'the phone is not attached over USB — connect a data-capable cable and unlock the device'
  }
}

async function connectUsbmuxDevice(deviceId: number, devicePort: number): Promise<Socket> {
  const socket = await connectUsbmux()
  try {
    await sendUsbmuxMessage(socket, {
      MessageType: 'Connect',
      DeviceID: deviceId,
      PortNumber: swapPortByteOrder(devicePort),
      ClientVersionString: 'dsh-ios',
      ProgName: 'dsh-ios',
      kLibUSBMuxVersion: 3,
    })
    const reply = asDict(await readUsbmuxReply(socket), 'Connect reply')
    if (reply.MessageType !== 'Result') {
      throw new Error(`dsh-ios: usbmuxd Connect reply is "${String(reply.MessageType)}", not Result`)
    }
    const number = asNumber(reply.Number, 'Connect result Number')
    if (number !== 0) {
      const reason = number === 2 ? 'device not connected' : number === 3 ? 'port refused' : 'unknown error'
      throw new Error(`dsh-ios: usbmuxd Connect to device ${deviceId} port ${devicePort} failed: ${reason} (code ${number})`)
    }
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/** Pipe one accepted TCP connection through one fresh usbmux Connect channel. */
async function pipeUsbmuxConnection(client: Socket, deviceId: number, devicePort: number): Promise<void> {
  let device: Socket
  try {
    device = await connectUsbmuxDevice(deviceId, devicePort)
  } catch {
    // Only THIS client connection failed — the listening server stays up.
    client.destroy()
    return
  }
  client.on('error', () => {})
  device.on('error', () => {})
  client.pipe(device)
  device.pipe(client)
  client.once('close', () => device.destroy())
  device.once('close', () => client.destroy())
}

/**
 * Bind a TCP server on 127.0.0.1:<localPort> and, per accepted connection,
 * open a FRESH usbmux Connect channel to the device port and pipe both ways.
 * One Connect socket per TCP connection — usbmux channels are never multiplexed.
 */
export async function createUsbmuxForward(options: UsbmuxForwardOptions): Promise<UsbmuxForward> {
  // Resolve the USB record by udid again so the caller never has to thread a
  // device id; a second ListDevices over AF_UNIX is microseconds.
  const deviceId = await resolveUsbDeviceId(options.udid)
  if (deviceId === undefined) {
    throw new Error(`dsh-ios: no USB record for ${options.udid} — cannot forward device port ${options.devicePort}`)
  }
  const host = options.host ?? '127.0.0.1'
  const localPort = options.localPort
  let connections = 0
  let closed = false
  const clients = new Set<Socket>()

  const server = createServer(client => {
    connections += 1
    clients.add(client)
    client.once('close', () => {
      connections -= 1
      clients.delete(client)
    })
    void pipeUsbmuxConnection(client, deviceId, options.devicePort)
  })
  server.unref()

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host, port: localPort })
  })

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const client of clients) client.destroy()
    clients.clear()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }

  return {
    get localPort(): number { return localPort },
    get connections(): number { return connections },
    close,
  }
}
