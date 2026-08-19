/**
 * Shared plist readers — extracted from usbmux.ts so the app-listing code
 * (WP58) can read localized `.strings` files with the SAME binary/XML readers
 * the usbmuxd client already used, instead of carrying a second copy.
 *
 * The binary reader covers dict / string / int / array / bool / null — the
 * shapes the two callers actually read. .strings VALUES with non-ASCII
 * characters arrive as UTF-16BE strings (marker 0x6), so that encoding is
 * decoded here too: usbmuxd never sent one, but Calendar's zh_CN
 * InfoPlist.strings stores 日历 that way, and an ASCII-only reader would turn
 * it into garbage instead of a name a Chinese query can match.
 * @module @zseven-w/dsh-ios/plist
 */

/**
 * Read a big-endian unsigned integer at `pos`. Widths up to 16 bytes are
 * accepted because CoreFoundation's binary-plist writer occasionally emits a
 * 16-byte INT object (marker 0x14) for a small value — the simulator's
 * .GlobalPreferences.plist stores AppleLanguagesSchemaVersion = 5400 that way
 * — and rejecting it would make the whole language plist unreadable.
 */
function readBigEndianUInt(buffer: Buffer, pos: number, size: number): number {
  if (size < 1 || size > 16) throw new Error('dsh-ios: unsupported big-endian integer width')
  if (pos < 0 || pos + size > buffer.length) throw new Error('dsh-ios: big-endian integer out of range')
  // Offsets/lengths/small ints fit well within 2^53; a value that would not is
  // still rejected by the safe-integer check at each int call site.
  let value = 0
  for (let i = 0; i < size; i += 1) value = value * 256 + buffer[pos + i]
  return value
}

/** Read one big-endian INT object (marker byte + payload) at `pos`. */
function parsePlistIntObject(buffer: Buffer, pos: number): { value: number; end: number } {
  if (pos >= buffer.length) throw new Error('dsh-ios: plist int object out of range')
  const marker = buffer[pos]
  if ((marker >> 4) !== 0x1) throw new Error('dsh-ios: plist expected an int object')
  const width = 1 << (marker & 0x0f)
  return { value: readBigEndianUInt(buffer, pos + 1, width), end: pos + 1 + width }
}

/**
 * Parse a binary plist (`bplist00` …) into a JS value. Dict keys must be
 * strings; string objects are decoded as ASCII (marker 0x5) or UTF-16BE
 * (marker 0x6). Anything else — data/real/date/uid — is rejected, never
 * guessed, because the callers only read scalar/collection shapes.
 */
export function parseBinaryPlist(buffer: Buffer): unknown {
  if (buffer.length < 40) throw new Error('dsh-ios: data is too short to be a binary plist')
  if (buffer.toString('latin1', 0, 8) !== 'bplist00') throw new Error('dsh-ios: data is not a binary plist')
  const trailer = buffer.subarray(buffer.length - 32)
  const offsetIntSize = trailer[6]
  const objectRefSize = trailer[7]
  const objectCount = readBigEndianUInt(trailer, 8, 8)
  const topObject = readBigEndianUInt(trailer, 16, 8)
  const offsetTableOffset = readBigEndianUInt(trailer, 24, 8)
  if (offsetIntSize < 1 || offsetIntSize > 8 || objectRefSize < 1 || objectRefSize > 8) {
    throw new Error('dsh-ios: unsupported plist integer/ref widths')
  }
  if (offsetTableOffset + objectCount * offsetIntSize > buffer.length) {
    throw new Error('dsh-ios: plist offset table out of range')
  }
  const offsets: number[] = []
  for (let i = 0; i < objectCount; i += 1) {
    offsets.push(readBigEndianUInt(buffer, offsetTableOffset + i * offsetIntSize, offsetIntSize))
  }

  const parse = (ref: number): unknown => {
    if (!Number.isSafeInteger(ref) || ref < 0 || ref >= offsets.length) {
      throw new Error(`dsh-ios: plist object reference ${ref} out of range`)
    }
    const offset = offsets[ref]
    if (offset < 0 || offset >= buffer.length) throw new Error('dsh-ios: plist object offset out of range')
    const marker = buffer[offset]
    const type = marker >> 4
    const info = marker & 0x0f
    switch (type) {
      case 0x0:
        if (marker === 0x00) return null
        if (marker === 0x08) return false
        if (marker === 0x09) return true
        throw new Error(`dsh-ios: unsupported plist object 0x${marker.toString(16)}`)
      case 0x1: {
        const value = readBigEndianUInt(buffer, offset + 1, 1 << info)
        if (!Number.isSafeInteger(value)) throw new Error('dsh-ios: plist integer exceeds the safe range')
        return value
      }
      case 0x5: {
        // ASCII string (the plist spec's 7-bit string); keys and usbmuxd
        // fields are always ASCII, so no high bytes are expected here.
        let length = info
        let start = offset + 1
        if (info === 0x0f) {
          const parsed = parsePlistIntObject(buffer, offset + 1)
          length = parsed.value
          start = parsed.end
        }
        if (start + length > buffer.length) throw new Error('dsh-ios: plist string out of range')
        return buffer.toString('ascii', start, start + length)
      }
      case 0x6: {
        // UTF-16BE string: the encoding plutil picks for any non-ASCII value,
        // which is exactly what a localized display name (日历, 提醒事项, …) is.
        let length = info
        let start = offset + 1
        if (info === 0x0f) {
          const parsed = parsePlistIntObject(buffer, offset + 1)
          length = parsed.value
          start = parsed.end
        }
        if (start + length * 2 > buffer.length) throw new Error('dsh-ios: plist string out of range')
        let text = ''
        for (let i = 0; i < length; i += 1) {
          text += String.fromCharCode(buffer.readUInt16BE(start + i * 2))
        }
        return text
      }
      case 0xa: {
        let count = info
        let start = offset + 1
        if (info === 0x0f) {
          const parsed = parsePlistIntObject(buffer, offset + 1)
          count = parsed.value
          start = parsed.end
        }
        const result: unknown[] = []
        for (let i = 0; i < count; i += 1) {
          result.push(parse(readBigEndianUInt(buffer, start + i * objectRefSize, objectRefSize)))
        }
        return result
      }
      case 0xd: {
        let count = info
        let start = offset + 1
        if (info === 0x0f) {
          const parsed = parsePlistIntObject(buffer, offset + 1)
          count = parsed.value
          start = parsed.end
        }
        const keys: number[] = []
        for (let i = 0; i < count; i += 1) keys.push(readBigEndianUInt(buffer, start + i * objectRefSize, objectRefSize))
        const valueStart = start + count * objectRefSize
        const result: Record<string, unknown> = {}
        for (let i = 0; i < count; i += 1) {
          const key = parse(keys[i])
          if (typeof key !== 'string') throw new Error('dsh-ios: plist dict key is not a string')
          result[key] = parse(readBigEndianUInt(buffer, valueStart + i * objectRefSize, objectRefSize))
        }
        return result
      }
      case 0x4: {
        // data blob — the language plist carries opaque payloads
        // (com.apple.gms.availability.*); keep them as a Buffer so an
        // unexpected key does not abort the whole dict.
        let length = info
        let start = offset + 1
        if (info === 0x0f) {
          const parsed = parsePlistIntObject(buffer, offset + 1)
          length = parsed.value
          start = parsed.end
        }
        if (start + length > buffer.length) throw new Error('dsh-ios: plist data out of range')
        return buffer.subarray(start, start + length)
      }
      default:
        // real/date/uid never appear in the fields the callers read.
        throw new Error(`dsh-ios: unsupported plist object type 0x${type.toString(16)}`)
    }
  }

  return parse(topObject)
}

function decodeXmlEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/**
 * Recursive XML-plist reader for the elements the callers actually send/receive:
 * plist/dict/key/array/string/integer/data and true/false. Anything else is
 * rejected, never guessed.
 */
export function parseXmlPlist(xml: string): unknown {
  let i = 0
  const len = xml.length
  const ws = (): void => {
    while (i < len && (xml[i] === ' ' || xml[i] === '\t' || xml[i] === '\n' || xml[i] === '\r')) i += 1
  }
  const readName = (): string => {
    const start = i
    while (i < len && /[A-Za-z0-9_.-]/.test(xml[i])) i += 1
    if (i === start) throw new Error('dsh-ios: empty tag name in XML plist')
    return xml.slice(start, i)
  }
  const readText = (): string => {
    const start = i
    while (i < len && xml[i] !== '<') i += 1
    return decodeXmlEntities(xml.slice(start, i))
  }
  /** Consume the open tag's attributes/`>`; returns true when self-closing. */
  const skipTagEnd = (): boolean => {
    while (i < len) {
      const ch = xml[i]
      if (ch === '>') { i += 1; return false }
      if (ch === '/' && xml[i + 1] === '>') { i += 2; return true }
      i += 1
    }
    throw new Error('dsh-ios: unterminated tag in XML plist')
  }

  const parseElement = (): unknown => {
    ws()
    if (xml[i] !== '<') throw new Error('dsh-ios: expected an element in XML plist')
    i += 1
    const name = readName()
    if (skipTagEnd()) {
      if (name === 'true') return true
      if (name === 'false') return false
      throw new Error(`dsh-ios: unexpected self-closing plist element <${name}/>`)
    }
    if (name === 'plist') {
      const value = parseElement()
      ws()
      if (!xml.startsWith('</plist>', i)) throw new Error('dsh-ios: expected </plist> in XML plist')
      i += 8
      return value
    }
    if (name === 'dict') {
      const result: Record<string, unknown> = {}
      for (;;) {
        ws()
        if (xml.startsWith('</dict>', i)) { i += 7; return result }
        if (!xml.startsWith('<key>', i)) throw new Error('dsh-ios: expected <key> in plist dict')
        i += 5
        const key = readText()
        if (!xml.startsWith('</key>', i)) throw new Error('dsh-ios: expected </key> in plist dict')
        i += 6
        result[key] = parseElement()
      }
    }
    if (name === 'array') {
      const result: unknown[] = []
      for (;;) {
        ws()
        if (xml.startsWith('</array>', i)) { i += 8; return result }
        result.push(parseElement())
      }
    }
    if (name === 'string') {
      const text = readText()
      if (!xml.startsWith('</string>', i)) throw new Error('dsh-ios: expected </string> in XML plist')
      i += 9
      return text
    }
    if (name === 'integer') {
      const text = readText().trim()
      if (!xml.startsWith('</integer>', i)) throw new Error('dsh-ios: expected </integer> in XML plist')
      i += 10
      const value = Number(text)
      if (!Number.isSafeInteger(value)) throw new Error('dsh-ios: plist integer is not a safe integer')
      return value
    }
    if (name === 'data') {
      // base64 blobs the callers never read; keep them as their text so an
      // unexpected key does not abort the whole document.
      const text = readText()
      if (!xml.startsWith('</data>', i)) throw new Error('dsh-ios: expected </data> in XML plist')
      i += 7
      return text
    }
    throw new Error(`dsh-ios: unsupported plist element <${name}>`)
  }

  // Skip the XML declaration and DOCTYPE prolog, then parse the root element.
  ws()
  if (xml.startsWith('<?xml', i)) {
    const end = xml.indexOf('?>', i)
    if (end === -1) throw new Error('dsh-ios: unterminated XML declaration')
    i = end + 2
  }
  ws()
  if (xml.startsWith('<!DOCTYPE', i) || xml.startsWith('<!doctype', i)) {
    const end = xml.indexOf('>', i)
    if (end === -1) throw new Error('dsh-ios: unterminated DOCTYPE')
    i = end + 1
  }
  const value = parseElement()
  ws()
  if (i < len) throw new Error('dsh-ios: trailing content after XML plist')
  return value
}

/** Decode a byte buffer to text, honouring a UTF-8/UTF-16 BOM. */
function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le')
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const text = bytes.toString('utf8')
  return text.startsWith('\uFEFF') ? text.slice(1) : text
}

/** Resolve one OpenStep .strings escape (\\, \", \n, \t, \r, \Uxxxx). */
function decodeStringsEscape(raw: string): string {
  return raw.replace(/\\(U[0-9a-fA-F]{4}|u[0-9a-fA-F]{4}|.)/g, (_match, escape: string) => {
    if (escape.length === 5 && (escape[0] === 'U' || escape[0] === 'u')) {
      return String.fromCharCode(Number.parseInt(escape.slice(1), 16))
    }
    if (escape === 'n') return '\n'
    if (escape === 't') return '\t'
    if (escape === 'r') return '\r'
    return escape
  })
}

/**
 * Parse an OpenStep-format .strings document — the `"key" = "value";` text
 * form some bundles ship (as UTF-8 or UTF-16) instead of a plist. Comments are
 * dropped so a key inside one never pairs; anything unparseable simply yields
 * whatever pairs were read (never throws — an unreadable .strings is "no
 * localized name" to the caller).
 */
export function parseStringsText(text: string): Record<string, string> {
  const clean = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  const result: Record<string, string> = {}
  const pair = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g
  let match: RegExpExecArray | null
  while ((match = pair.exec(clean)) !== null) {
    result[decodeStringsEscape(match[1])] = decodeStringsEscape(match[2])
  }
  return result
}

/** Coerce a parsed plist value into a string→string map (skipping non-strings). */
function stringsFromValue(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') result[key] = entry
    }
  }
  return result
}

/** Parse a plist file's bytes in either binary or XML form. */
export function parsePlist(bytes: Buffer): unknown {
  if (bytes.length >= 8 && bytes.toString('latin1', 0, 8) === 'bplist00') return parseBinaryPlist(bytes)
  return parseXmlPlist(decodeText(bytes))
}

/**
 * Read a .strings file in any of its three encodings — binary plist, XML
 * plist, or OpenStep text — and return its string→string map. Unreadable
 * bytes are an empty map, never an error, so the caller can treat "no name"
 * and "no file" identically.
 */
export function readStrings(bytes: Buffer): Record<string, string> {
  try {
    if (bytes.length >= 8 && bytes.toString('latin1', 0, 8) === 'bplist00') {
      return stringsFromValue(parseBinaryPlist(bytes))
    }
    const text = decodeText(bytes)
    if (/^\s*(<\?xml|<!DOCTYPE|<plist)/.test(text)) {
      return stringsFromValue(parseXmlPlist(text))
    }
    return parseStringsText(text)
  } catch {
    return {}
  }
}
