/**
 * WebDriverAgent accessibility-tree normalization — the real-device backend
 * of `ios_sim_ui_tree` / `ios_sim_tap_element`.
 *
 * WDA's `GET /source` returns the XCUITest accessibility tree as XML whose
 * elements look like:
 *
 *     <XCUIElementTypeButton type="XCUIElementTypeButton" name="UIA.Alarm.Button"
 *       label="无闹钟" value="无闹钟" enabled="true" visible="true" x="142" y="256"
 *       width="118" height="41" index="1" traits="Button">…
 *
 * This module normalizes that document into the SAME sanitized `AxeElement`
 * shape the AXe-backed simulator path produces (type/label/identifier/value/
 * frame/children, frames in device points), so `buildCompactTree`,
 * `capTreeToBytes` and `resolveTapTarget` in tool-uitree.ts operate
 * identically on both backends and the model sees one tree contract.
 *
 * Normalization rules (observed on the captured device fixture):
 * - type: the element tag (or its `type` attribute) with the
 *   `XCUIElementType` prefix stripped;
 * - label: the `label` attribute, else `name`;
 * - identifier: an explicit `identifier` attribute, else `name` when a
 *   DISTINCT `label` attribute also exists (WDA carries the
 *   accessibilityIdentifier in `name`; a developer-set identifier plus a
 *   human label is the instrumented-app case, while label-less wrappers keep
 *   their name only as label so inherited names cannot double-match);
 * - value: the `value` attribute, dropped when it duplicates label/name
 *   (WDA mirrors StaticText content into `value`);
 * - enabled/visible: WDA's per-element flags are kept as booleans
 *   (absent attributes stay undefined) — off-screen rows and disabled
 *   controls are exactly the silent mis-tap / dead-tap traps the tap/tree
 *   tools guard against;
 * - selected: WDA's `selected="true"|"false"` attribute is kept the same
 *   way, so which row of a list/picker is chosen is verifiable from the tree
 *   alone (the playbook forbids pixel-checking);
 * - frames stay in device points — the same space WDA `/wda/tap` uses, so
 *   element centers computed from the tree tap directly;
 * - exact-frame duplicate wrappers that add no accessibility information
 *   beyond their parent are collapsed into it (WDA trees interleave many
 *   same-frame container elements, which would otherwise surface as
 *   spurious tap-target ambiguity).
 * @module @zseven-w/dsh-ios/wda-uitree
 */

import {
  sanitizeAxeNode,
  type AxeElement,
  type RawAxeNode,
} from './uitree-backend.js'

/** One parsed XML element (attributes only; WDA emits no text content). */
export interface WdaXmlNode {
  /** Raw tag name, e.g. `XCUIElementTypeButton`. */
  tag: string
  attributes: Record<string, string>
  children: WdaXmlNode[]
}

interface XmlStartTag {
  kind: 'open'
  name: string
  attributes: Record<string, string>
  selfClosing: boolean
}

interface XmlEndTag {
  kind: 'close'
  name: string
}

type XmlTag = XmlStartTag | XmlEndTag

/** Decode the standard XML entities (plus numeric character references). */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
}

/** Scan one XML document into its tags, respecting quoted attribute values. */
function scanXmlTags(xml: string): XmlTag[] {
  const tags: XmlTag[] = []
  let index = 0
  for (;;) {
    const lt = xml.indexOf('<', index)
    if (lt < 0) break
    let cursor = lt + 1
    let quote = ''
    let end = -1
    while (cursor < xml.length) {
      const char = xml[cursor]
      if (quote !== '') {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        end = cursor
        break
      }
      cursor += 1
    }
    if (end < 0) break // Unterminated tag: stop at what we have.
    const inner = xml.slice(lt + 1, end).trim()
    index = end + 1
    if (inner === '' || inner.startsWith('?') || inner.startsWith('!')) continue
    if (inner.startsWith('/')) {
      tags.push({ kind: 'close', name: inner.slice(1).trim() })
      continue
    }
    let body = inner
    let selfClosing = false
    if (body.endsWith('/')) {
      selfClosing = true
      body = body.slice(0, -1).trimEnd()
    }
    const split = body.search(/\s/u)
    const name = split < 0 ? body : body.slice(0, split)
    const attributes = parseAttributes(split < 0 ? '' : body.slice(split))
    tags.push({ kind: 'open', name, attributes, selfClosing })
  }
  return tags
}

/** Parse `name="value"` pairs out of a tag body remainder. */
function parseAttributes(rest: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  let index = 0
  while (index < rest.length) {
    while (index < rest.length && /\s/u.test(rest[index])) index += 1
    if (index >= rest.length) break
    const nameStart = index
    while (index < rest.length && !/\s/u.test(rest[index]) && rest[index] !== '=') index += 1
    const name = rest.slice(nameStart, index)
    while (index < rest.length && /\s/u.test(rest[index])) index += 1
    if (rest[index] !== '=') continue // Bare attribute (not emitted by WDA).
    index += 1
    while (index < rest.length && /\s/u.test(rest[index])) index += 1
    const quote = rest[index]
    if (quote !== '"' && quote !== "'") continue
    index += 1
    const valueStart = index
    while (index < rest.length && rest[index] !== quote) index += 1
    attributes[name] = decodeXmlEntities(rest.slice(valueStart, index))
    index += 1
  }
  return attributes
}

/**
 * Parse one WDA `source()` XML document into root elements. Malformed or
 * empty documents yield no roots; `wdaSourceToElements` raises for that.
 */
export function parseWdaXml(xml: string): WdaXmlNode[] {
  const roots: WdaXmlNode[] = []
  const stack: WdaXmlNode[] = []
  for (const tag of scanXmlTags(xml)) {
    if (tag.kind === 'open') {
      const node: WdaXmlNode = { tag: tag.name, attributes: tag.attributes, children: [] }
      if (stack.length === 0) roots.push(node)
      else stack[stack.length - 1].children.push(node)
      if (!tag.selfClosing) stack.push(node)
    } else {
      const matchIndex = stack.map(node => node.tag).lastIndexOf(tag.name)
      if (matchIndex >= 0) stack.length = matchIndex
    }
  }
  return roots
}

function stripXcuiPrefix(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const stripped = trimmed.startsWith('XCUIElementType') ? trimmed.slice('XCUIElementType'.length) : trimmed
  return stripped === '' ? undefined : stripped
}

/** The plugin element type for a WDA tag + attributes (prefix stripped). */
export function wdaElementType(tag: string, attributes: Record<string, string>): string {
  const fromTag = stripXcuiPrefix(tag)
  if (fromTag !== undefined) return fromTag
  const typeAttr = attributes.type?.trim()
  if (typeAttr !== undefined && typeAttr !== '') return stripXcuiPrefix(typeAttr) ?? typeAttr
  return 'Element'
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Parse a WDA "true"/"false" attribute; anything else stays undefined. */
function wdaBoolean(value: string | undefined): boolean | undefined {
  const trimmed = optionalString(value)
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  return undefined
}

/**
 * Map one WDA XML element into the plugin's sanitized element shape through
 * the shared `sanitizeAxeNode` (so unknown/absent fields get the same
 * defaults as the AXe path).
 */
export function wdaXmlNodeToAxe(node: WdaXmlNode): AxeElement {
  const name = optionalString(node.attributes.name)
  const labelAttr = optionalString(node.attributes.label)
  const identifierAttr = optionalString(node.attributes.identifier)
  const label = labelAttr ?? name
  const identifier = identifierAttr ?? (labelAttr !== undefined && labelAttr !== name ? name : undefined)
  const valueAttr = optionalString(node.attributes.value)
  const value = valueAttr !== undefined && valueAttr !== label && valueAttr !== name ? valueAttr : undefined
  const children: AxeElement[] = node.children.map(wdaXmlNodeToAxe)
  const raw: RawAxeNode = {
    type: wdaElementType(node.tag, node.attributes),
    ...(label === undefined ? {} : { AXLabel: label }),
    ...(identifier === undefined ? {} : { AXUniqueId: identifier }),
    ...(value === undefined ? {} : { AXValue: value }),
    // WDA emits both flags per element; parse them so the compact node keeps
    // them (off-screen rows in long lists and disabled controls are the
    // silent mis-tap / dead-tap traps this layer guards against).
    ...(wdaBoolean(node.attributes.enabled) === undefined ? {} : { enabled: wdaBoolean(node.attributes.enabled) }),
    ...(wdaBoolean(node.attributes.visible) === undefined ? {} : { visible: wdaBoolean(node.attributes.visible) }),
    // WP60: selection state. WDA exposes selected="true"|"false" on picker
    // and table rows; it is the ONLY way to confirm which option in a list is
    // chosen without reading pixels. Emitted only when the attribute is
    // present, so absent stays "unknown" rather than invented false.
    ...(wdaBoolean(node.attributes.selected) === undefined ? {} : { selected: wdaBoolean(node.attributes.selected) }),
    frame: {
      x: finiteNumber(node.attributes.x) ?? 0,
      y: finiteNumber(node.attributes.y) ?? 0,
      width: finiteNumber(node.attributes.width) ?? 0,
      height: finiteNumber(node.attributes.height) ?? 0,
    },
    children,
  }
  return sanitizeAxeNode(raw)
}

/** Tolerance (points) for frame equality in the duplicate collapse. */
const FRAME_EPSILON = 1

function framesEqual(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return Math.abs(a.x - b.x) <= FRAME_EPSILON
    && Math.abs(a.y - b.y) <= FRAME_EPSILON
    && Math.abs(a.w - b.w) <= FRAME_EPSILON
    && Math.abs(a.h - b.h) <= FRAME_EPSILON
}

/** True when `child` carries no accessibility info beyond `parent`. */
function addsNoInfo(parent: AxeElement, child: AxeElement): boolean {
  return (child.label === undefined || child.label === parent.label)
    && (child.identifier === undefined || child.identifier === parent.identifier)
    && (child.value === undefined || child.value === parent.value)
    // A same-frame duplicate with DIFFERENT interactivity flags carries
    // information (a visible=true twin of a visible=false wrapper must not
    // be swallowed), so flag mismatches keep the child.
    && (child.enabled === undefined || child.enabled === parent.enabled)
    && (child.visible === undefined || child.visible === parent.visible)
    // Selection is the same kind of signal: a selected row mirroring an
    // unselected wrapper is a real difference, never a spurious duplicate.
    && (child.selected === undefined || child.selected === parent.selected)
}

/**
 * Collapse exact-frame duplicates that add nothing: a child sharing its
 * parent's frame (a transparent wrapper, or a StaticText mirroring its
 * button's label) is spliced into the parent so its children survive but the
 * duplicate itself cannot double-match in selector resolution. Same-frame
 * siblings are merged the same way.
 */
export function collapseFrameDuplicates(roots: AxeElement[]): AxeElement[] {
  const walk = (element: AxeElement): AxeElement => {
    const children: AxeElement[] = []
    for (const rawChild of element.children) {
      const child = walk(rawChild)
      const duplicate = children.find(kept =>
        framesEqual(kept.frame, child.frame) && addsNoInfo(kept, child))
      if (duplicate !== undefined) {
        duplicate.children.push(...child.children)
        continue
      }
      if (framesEqual(element.frame, child.frame) && addsNoInfo(element, child)) {
        children.push(...child.children)
        continue
      }
      children.push(child)
    }
    return { ...element, children }
  }
  return roots.map(walk)
}

/**
 * Normalize one WDA `source()` XML document into sanitized root elements
 * (the same shape `axe describe-ui` yields). Raises a clear error when the
 * document parses to no elements.
 */
export function wdaSourceToElements(xml: string): AxeElement[] {
  const roots = collapseFrameDuplicates(parseWdaXml(xml).map(wdaXmlNodeToAxe))
  if (roots.length === 0) {
    throw new Error('the WebDriverAgent source() payload contained no accessibility elements')
  }
  return roots
}
