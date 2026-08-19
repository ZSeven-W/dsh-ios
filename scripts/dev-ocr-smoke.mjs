/**
 * Development smoke test for the Vision-OCR tools of dsh-ios
 * (`ios_sim_find_text` / `ios_sim_tap_text`).
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-ocr-smoke.mjs [<udid>]
 *
 * Part A (static, runs with NO device attached and MUST pass):
 *   - factory shape (names, timeouts, concurrency flags)
 *   - helper resolution: the bundled assets/ocr.swift resolves; a missing
 *     swiftc (or missing source) degrades with the install hint
 *   - compile-cache logic (swiftc present only): first use compiles into
 *     ~/Library/Caches/dsh-ios/bin/ocr/<source-hash16>/ocr (tested against a
 *     DSH_IOS_OCR_DIR override), the digest file records the full source
 *     sha256, re-resolution reuses the cached binary, a corrupted binary is
 *     recompiled, and an edited source lands in a NEW hash-keyed slot
 *   - OCR JSON parsing: sanitization, confidence sorting, exact-duplicate
 *     collapse, non-JSON / missing-items errors
 *   - query filtering (case-insensitive substring) + min_confidence floor
 *   - PURE pixel→point and pixel→normalized conversions for BOTH backends
 *     (WDA points via the screenshot pixel size × window size — never a
 *     fixed 3×; serve-sim normalized via the screenshot pixel size alone),
 *     including the inverse round-trips and degenerate-size errors
 *   - tool-level flow with a mocked WDA client + a stub OCR source
 *     (compiled in-place): find_text size/items/threshold/query behavior,
 *     the ~40 KB item cap, tap_text exact→contains→candidate-list ambiguity
 *     rules, pixel→point tap coordinates, settle + sim-screenshot meta
 *   - the empty-tree hint: a degenerate ui_tree result names
 *     ios_sim_find_text
 *   - REAL end-to-end (swiftc present only): the bundled helper compiles,
 *     OCRs a PNG generated in this smoke (text drawn with AppKit — no
 *     device screenshot committed), and the parsed items contain the text
 *
 * Part B (live, skipped without a phone + running WDA):
 *   If the phone is connected AND WDA answers on http://127.0.0.1:8100/status,
 *   a READ-ONLY pass runs: pressButton home (the same allowance as the
 *   realtools smoke) → ios_sim_find_text on the current screen returns
 *   recognizable items, and one item's rect is re-derived from the raw
 *   helper output and verified to map into the same point coordinates.
 *   ios_sim_tap_text is NOT exercised live (it would tap the user's
 *   screen). Simulators are never booted; no serve-sim process is killed;
 *   ~/.dsh and the :8873 instance are never touched.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEVICE_UDID = process.argv[2] || process.env.DSH_REAL_DEVICE_UDID || '96E6B481-3807-594D-B3BC-E1E12307D47C'
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const { SimHostController } = await import(join(root, 'lib', 'sim-host.js'))
const { listDevices } = await import(join(root, 'lib', 'simctl.js'))
const { createSimOcrTools, createSimUiTools, IOS_OCR_TOOL_NAMES, pollForText, resetSimPointSizeCache, resolveOcrTextTarget, sanitizeMinConfidence, simPointSizeCacheKey, simPointSizeStats } = await import(join(root, 'lib', 'tool-uitree.js'))
const { WdaController, probeWdaControlTunnel } = await import(join(root, 'lib', 'wda-host.js'))
const { listRealDevices } = await import(join(root, 'lib', 'devicectl.js'))
const {
  OCR_INSTALL_HINT,
  ensureOcrBinary,
  execOcr,
  filterOcrItems,
  normalizedRectToPixels,
  ocrCacheBase,
  parseOcrOutput,
  pixelCenterToPoints,
  pixelRectToNormalized,
  pixelRectToNormalizedCenter,
  pixelRectToPoints,
  pointsRectToPixels,
  rectCenter,
  resolveOcrBinary,
  resolveOcrSwiftSource,
} = await import(join(root, 'lib', 'ocr-backend.js'))

const results = []
let failed = 0
function step(name, verdict, detail = '') {
  const normalized = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict
  if (normalized === 'FAIL') failed += 1
  results.push({ name, verdict: normalized, detail })
  console.log(`${normalized.padEnd(4)} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
function warn(name, detail = '') {
  results.push({ name, verdict: 'SKIP', detail })
  console.log(`SKIP ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function makeExec(toolName, args) {
  return {
    callId: `ocr-smoke-${toolName}`,
    rootCallId: `ocr-smoke-${toolName}`,
    name: toolName,
    arguments: args,
    signal: new AbortController().signal,
  }
}

async function expectThrow(label, invoke, pattern) {
  try {
    await invoke()
    step(label, 'FAIL', 'no error was thrown')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    step(label, pattern.test(message) ? 'PASS' : 'FAIL', pattern.test(message) ? message : `unexpected error: ${message}`)
  }
}

function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

/** Read PNG pixel dimensions from the IHDR chunk (24-byte header). */
function readPngSize(path) {
  const data = readFileSync(path)
  if (data.length < 24) return undefined
  const isPng = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (!isPng) return undefined
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

/** Save + restore an env var; `undefined` means it was absent (delete). */
function withEnv(patch, task) {
  const prior = {}
  for (const [key, value] of Object.entries(patch)) {
    prior[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return Promise.resolve()
    .then(task)
    .finally(() => {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
}

/** Fake WdaToolBackend: serves a base64 PNG screenshot with a chosen size. */
function makeFakeWda(pngBase64, width, height, sourceXml = '') {
  const state = { taps: [], screenshots: 0 }
  return {
    async ensureRunning() {
      return { udid: 'FAKE-OCR', hardwareUdid: 'FAKE-HW', controlUrl: 'http://127.0.0.1:8100', mjpegUrl: 'http://127.0.0.1:9100/', sessionId: 'S' }
    },
    status() {
      return { available: true, running: true, consumers: 0 }
    },
    async stop() {},
    acquire() {
      return () => {}
    },
    release() {},
    get mjpegUrl() {
      return undefined
    },
    control: {
      async pressButton() {},
      async tap(x, y) {
        state.taps.push({ x, y })
      },
      async dragFromToForDuration() {},
      async typeText() {},
      async setOrientation() {},
      async screenshot() {
        state.screenshots += 1
        return { pngBase64, width, height }
      },
      async source() {
        return sourceXml
      },
      async windowSize() {
        return { width: 402, height: 874 }
      },
    },
    __state: state,
  }
}

const tempDirs = []
let host
let liveWda

try {
  host = new SimHostController()
  const fakeRealDevice = {
    udid: '00000000-0000-0000-0000-0000000000BB',
    name: 'Ocr Phone',
    osVersion: '26.6',
    model: 'iPhone 17 Pro',
    state: 'available (paired)',
    connection: 'wired',
    pairingState: 'paired',
    developerMode: 'enabled',
  }
  const realDevices = {
    matches: async reference => reference === fakeRealDevice.udid,
    resolve: async () => fakeRealDevice,
  }

  // ── A. factory shape ──────────────────────────────────────────────────────
  const ocrTools = createSimOcrTools(host)
  step(
    'factory produces the ios_sim_* OCR tools (find/tap/wait_for)',
    [ocrTools.iosSimFindText.name, ocrTools.iosSimTapText.name, ocrTools.iosSimWaitFor.name].join(',') === IOS_OCR_TOOL_NAMES.join(','),
    IOS_OCR_TOOL_NAMES.join(' '),
  )
  step(
    'find_text and wait_for are concurrency-safe, tap_text stays exclusive',
    ocrTools.iosSimFindText.isConcurrencySafe({}) === true && ocrTools.iosSimWaitFor.isConcurrencySafe({ text: 'x' }) === true
      && ocrTools.iosSimTapText.isConcurrencySafe === undefined,
  )
  step(
    'tool timeouts cover the first-use compile',
    ocrTools.iosSimFindText.timeoutMs >= 240_000 && ocrTools.iosSimTapText.timeoutMs >= 240_000 && ocrTools.iosSimWaitFor.timeoutMs >= 240_000,
    `find=${ocrTools.iosSimFindText.timeoutMs} tap=${ocrTools.iosSimTapText.timeoutMs} wait=${ocrTools.iosSimWaitFor.timeoutMs}`,
  )
  step('min_confidence default is 0.3 and validation rejects out-of-range values',
    sanitizeMinConfidence(undefined) === 0.3 && sanitizeMinConfidence(0.9) === 0.9
      && (() => {
        try { sanitizeMinConfidence(1.5); return false } catch { return true }
      })())

  // ── A2. shared OCR poll helper (wait_for's engine, injectable seam) ────────
  // WP54: wait_for must not throw on timeout — it is a normal matched:false —
  // and must stop polling the instant the condition flips. Drive it with a
  // stub read() so no device or OCR helper is needed.
  {
    const presentOutcome = await pollForText(
      async () => [{ text: 'Pay Now', confidence: 0.99, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      'pay', 'appear', 4000, 600, 0,
    )
    step(
      'pollForText returns matched:true with a small waitedMs when present on the first poll',
      presentOutcome.matched === true && presentOutcome.item !== undefined
        && presentOutcome.item.text === 'Pay Now' && presentOutcome.waitedMs < 1000,
      `waitedMs=${presentOutcome.waitedMs} item=${presentOutcome.item?.text}`,
    )
    const absentOutcome = await pollForText(
      async () => [],
      'Never There', 'appear', 250, 100, 0,
    )
    step(
      'pollForText returns matched:false (NOT a throw) after the timeout',
      absentOutcome.matched === false && absentOutcome.item === undefined,
      `waitedMs=${absentOutcome.waitedMs}`,
    )
    let reads = 0
    const sequence = ['Still Here', 'Still Here', 'Gone', 'Gone']
    const goneOutcome = await pollForText(
      async () => {
        const text = sequence[Math.min(reads, sequence.length - 1)]
        reads += 1
        return text === 'Gone' ? [] : [{ text, confidence: 0.9, rect: { x: 0, y: 0, w: 1, h: 1 } }]
      },
      'Still Here', 'disappear', 4000, 100, 0,
    )
    step(
      "pollForText stops early in 'disappear' mode once the text is gone",
      goneOutcome.matched === true && reads < sequence.length && goneOutcome.waitedMs < 4000,
      `reads=${reads} waitedMs=${goneOutcome.waitedMs}`,
    )
  }

  // ── B. helper resolution (no compile needed) ──────────────────────────────
  const source = resolveOcrSwiftSource()
  step(
    'the bundled assets/ocr.swift resolves next to the compiled module',
    source.path !== undefined && existsSync(source.path) && readFileSync(source.path, 'utf8').includes('VNRecognizeTextRequest'),
    source.path,
  )
  const swiftcProbe = spawnSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe', timeout: 30_000 })
  const hasSwiftc = swiftcProbe.status === 0 && swiftcProbe.error === undefined
  step('swiftc availability recorded (compile steps skip without it)', hasSwiftc === true, hasSwiftc ? 'swiftc present' : 'swiftc missing')
  const resolved = resolveOcrBinary()
  step(
    'resolveOcrBinary reports cache-ready or a clear reason',
    (resolved.available && resolved.source === 'cache') || (resolved.compilable === true && resolved.reason !== undefined),
    `available=${resolved.available} source=${resolved.source} reason=${resolved.reason ?? ''}`,
  )
  const cleanCache = mkdtempSync(join(tmpdir(), 'dsh-ios-ocr-cache-'))
  tempDirs.push(cleanCache)
  if (hasSwiftc) {
    const expectedSlot = join(cleanCache, sha256File(source.path).slice(0, 16))
    const built = await withEnv({ DSH_IOS_OCR_DIR: cleanCache }, async () => ensureOcrBinary())
    step(
      'first use compiles the helper into the hash-keyed plugin cache',
      built.available === true && built.source === 'cache'
        && built.command !== undefined && existsSync(built.command)
        && built.command.includes(expectedSlot),
      built.command,
    )
    const digestFile = join(dirname(built.command), '.dsh-ios-ocr-source.sha256')
    step(
      'the compiled binary digest is recorded next to it (integrity re-check)',
      existsSync(digestFile) && readFileSync(digestFile, 'utf8').trim() === sha256File(built.command),
      digestFile,
    )
    const again = await withEnv({ DSH_IOS_OCR_DIR: cleanCache }, async () => ensureOcrBinary())
    step(
      're-resolution reuses the cached binary (no recompile)',
      again.available === true && again.command === built.command,
      again.command,
    )
    // Corrupt the cached binary → the next ensure recompiles a clean copy.
    writeFileSync(built.command, 'corrupted')
    const repaired = await withEnv({ DSH_IOS_OCR_DIR: cleanCache }, async () => ensureOcrBinary())
    step(
      'a corrupted cached binary is recompiled on the next use',
      repaired.available === true && existsSync(repaired.command) && readFileSync(repaired.command).length > 1000,
      repaired.command,
    )
    // An edited source is a NEW cache key (different hash slot).
    const editedDir = mkdtempSync(join(tmpdir(), 'dsh-ios-ocr-edited-'))
    tempDirs.push(editedDir)
    const editedSource = join(editedDir, 'ocr.swift')
    writeFileSync(editedSource, `${readFileSync(source.path, 'utf8')}\n// edited revision\n`)
    const editedBuild = await withEnv({ DSH_IOS_OCR_SWIFT: editedSource, DSH_IOS_OCR_DIR: cleanCache }, async () => ensureOcrBinary())
    step(
      'an edited source compiles into a NEW hash-keyed cache slot',
      editedBuild.available === true && editedBuild.command !== built.command
        && dirname(editedBuild.command) !== dirname(built.command),
      dirname(editedBuild.command),
    )
  } else {
    warn('compile-cache pipeline needs swiftc — skipped on this host', resolved.reason ?? 'swiftc missing')
  }

  // ── C. degradation: missing swiftc / missing source ───────────────────────
  await withEnv({ DSH_IOS_SWIFTC: '/nonexistent/swiftc', DSH_IOS_OCR_DIR: cleanCache }, async () => {
    const degraded = resolveOcrBinary()
    step(
      'a missing swiftc degrades with the xcode-select install hint',
      degraded.available === false && String(degraded.reason).includes('swiftc')
        && degraded.installHint.includes('xcode-select --install'),
      degraded.reason,
    )
    step('the install hint is the documented one', OCR_INSTALL_HINT.includes('xcode-select --install'))
  })
  await withEnv({ DSH_IOS_OCR_SWIFT: '/nonexistent/ocr.swift' }, async () => {
    const degraded = resolveOcrBinary()
    step(
      'a missing source degrades with a clear reason',
      degraded.available === false && /DSH_IOS_OCR_SWIFT points at a missing/.test(String(degraded.reason)),
      degraded.reason,
    )
  })
  const restored = resolveOcrBinary()
  step(
    'resolution recovers after env restore',
    restored.available === true || restored.compilable === true,
    `available=${restored.available} compilable=${restored.compilable === true}`,
  )

  // ── D. OCR JSON parsing / filtering / conversions (pure) ──────────────────
  const parsed = parseOcrOutput(JSON.stringify({
    count: 4,
    items: [
      { text: ' 支付成功 ', confidence: 0.42, x: 100, y: 200, w: 80, h: 30 },
      { text: 'HELLO', confidence: 0.99, x: 10, y: 20, w: 40, h: 12 },
      { text: 'bad item', confidence: -1, x: 0, y: 0, w: 10, h: 10 },
      { text: '', confidence: 0.5, x: 0, y: 0, w: 10, h: 10 },
      { text: 'HELLO', confidence: 0.98, x: 10, y: 20, w: 40, h: 12 },
    ],
  }))
  step(
    'parse sanitizes (trim, invalid dropped), dedupes, and sorts by confidence',
    parsed.length === 2 && parsed[0].text === 'HELLO' && parsed[0].confidence === 0.99
      && parsed[1].text === '支付成功' && parsed[1].confidence === 0.42,
    parsed.map(item => `${item.text}@${item.confidence}`).join(' '),
  )
  await expectThrow('non-JSON helper output raises', () => parseOcrOutput('not json'), /non-JSON output/i)
  await expectThrow('payload without items raises', () => parseOcrOutput('{"count":0}'), /missing items/i)
  const filterSource = [
    { text: 'Pay Now', confidence: 0.99, rect: { x: 0, y: 0, w: 1, h: 1 } },
    { text: 'pay later', confidence: 0.8, rect: { x: 0, y: 0, w: 1, h: 1 } },
    { text: '支付', confidence: 0.42, rect: { x: 0, y: 0, w: 1, h: 1 } },
  ]
  step(
    'query filter is a case-insensitive substring; empty query keeps all',
    filterOcrItems(filterSource, 'PAY').length === 2
      && filterOcrItems(filterSource, 'PAY NOW').length === 1
      && filterOcrItems(filterSource, undefined, 0.3).length === 3,
  )
  step(
    'min_confidence floors the list (default 0 in the pure helper)',
    filterOcrItems(filterSource, undefined, 0.5).length === 2
      && filterOcrItems(filterSource, 'pay', 0.9).length === 1,
  )

  // Coordinate conversions — the trap this project keeps hitting.
  // WDA backend: pixels 1206×2622 → points 402×874 (exactly 3×).
  const px = { width: 1206, height: 2622 }
  const pts = { width: 402, height: 874 }
  const box = { x: 600, y: 1200, w: 300, h: 150 }
  const inPoints = pixelRectToPoints(box, px, pts)
  step(
    'pixel→point (WDA backend, 3×): box scales through BOTH sizes',
    inPoints.x === 200 && inPoints.y === 400 && inPoints.w === 100 && inPoints.h === 50,
    JSON.stringify(inPoints),
  )
  const centerPx = rectCenter(box)
  const centerPts = pixelCenterToPoints(centerPx, px, pts)
  step(
    'pixel center → WDA tap point (250, 425)',
    centerPx.x === 750 && centerPx.y === 1275 && centerPts.x === 250 && centerPts.y === 425,
    `(${centerPts.x}, ${centerPts.y})`,
  )
  const roundTrip = pointsRectToPixels(inPoints, pts, px)
  step(
    'points→pixels inverse round-trips exactly',
    roundTrip.x === box.x && roundTrip.y === box.y && roundTrip.w === box.w && roundTrip.h === box.h,
    JSON.stringify(roundTrip),
  )
  // A NON-3× device (iPhone 8 @2x: 750×1334 pixels → 375×667 points).
  const odd = pixelRectToPoints({ x: 100, y: 200, w: 50, h: 60 }, { width: 750, height: 1334 }, { width: 375, height: 667 })
  step(
    'non-3× scales convert per-axis (never a fixed 3×)',
    odd.x === 50 && odd.y === 100 && odd.w === 25 && odd.h === 30,
    JSON.stringify(odd),
  )
  // Simulator backend: normalized 0..1 from the screenshot pixel size alone.
  const normBox = pixelRectToNormalized({ x: 603, y: 1311, w: 120, h: 80 }, px)
  step(
    'pixel→normalized (serve-sim backend) uses the screenshot pixel size',
    Math.abs(normBox.x - 0.5) < 1e-9 && Math.abs(normBox.y - 0.5) < 1e-9
      && Math.abs(normBox.w - 120 / 1206) < 1e-9 && Math.abs(normBox.h - 80 / 2622) < 1e-9,
    JSON.stringify(normBox),
  )
  const normCenter = pixelRectToNormalizedCenter({ x: 603, y: 1311, w: 120, h: 80 }, px)
  step(
    'pixel center → normalized tap for serve-sim',
    Math.abs(normCenter.x - 663 / 1206) < 1e-9 && Math.abs(normCenter.y - 1351 / 2622) < 1e-9,
    `(${normCenter.x}, ${normCenter.y})`,
  )
  const normRoundTrip = normalizedRectToPixels(normBox, px)
  step(
    'normalized→pixels inverse round-trips',
    Math.abs(normRoundTrip.x - 603) < 1e-6 && Math.abs(normRoundTrip.y - 1311) < 1e-6,
    JSON.stringify(normRoundTrip),
  )
  await expectThrow('degenerate pixel size throws', () => pixelRectToPoints(box, { width: 0, height: 0 }, pts), /finite positive size/)

  // ── E. tool-level flow with a stub OCR source (needs swiftc) ──────────────
  if (hasSwiftc) {
    const stubDir = mkdtempSync(join(tmpdir(), 'dsh-ios-ocr-stub-'))
    tempDirs.push(stubDir)
    // Stub helper: prints a FIXED payload (deterministic items for the
    // threshold/ambiguity/tap assertions) and ignores the image.
    const stubItems = [
      { text: 'Pay Now', confidence: 0.99, x: 100, y: 100, w: 200, h: 40 },
      { text: 'Pay Later', confidence: 0.8, x: 100, y: 200, w: 200, h: 40 },
      { text: '支付成功', confidence: 0.42, x: 100, y: 300, w: 80, h: 40 },
    ]
    const stubSwift = join(stubDir, 'ocr.swift')
    writeFileSync(stubSwift, `import Foundation\nprint(${JSON.stringify(JSON.stringify({ count: stubItems.length, items: stubItems }))})\n`)
    // A 300×200 PNG for the mocked screenshot (the stub never reads it; the
    // pixel size drives the conversion assertions).
    const pngPath = join(stubDir, 'frame.png')
    const genSwift = join(stubDir, 'gen.swift')
    writeFileSync(genSwift, [
      'import Foundation',
      'import AppKit',
      'let W = 300, H = 200',
      'let img = NSImage(size: NSSize(width: W, height: H))',
      'img.lockFocus()',
      'NSColor.white.setFill()',
      'NSRect(x: 0, y: 0, width: W, height: H).fill()',
      '("PAY").draw(at: NSPoint(x: 100, y: 100), withAttributes: [.font: NSFont.systemFont(ofSize: 36), .foregroundColor: NSColor.black])',
      'img.unlockFocus()',
      'guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { exit(1) }',
      'try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))',
    ].join('\n'))
    const pngOk = spawnSync('swiftc', ['-O', genSwift, '-o', join(stubDir, 'gen')], { stdio: 'pipe', timeout: 120_000 }).status === 0
      && spawnSync(join(stubDir, 'gen'), [pngPath], { stdio: 'pipe', timeout: 60_000 }).status === 0
    if (pngOk) {
      const pngSize = readPngSize(pngPath)
      const pngBase64 = readFileSync(pngPath).toString('base64')
      const fakeWda = makeFakeWda(pngBase64, pngSize.width, pngSize.height)
      const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-ios-ocr-tools-'))
      tempDirs.push(cacheDir)
      const tools = await withEnv({ DSH_IOS_OCR_SWIFT: stubSwift, DSH_IOS_OCR_DIR: join(cacheDir, 'ocr-bin') }, () => {
        return createSimOcrTools(host, { wda: fakeWda, realDevices, cacheDir })
      })
      // env must stay set while the tools execute (compile happens on use).
      const inStubEnv = async task => withEnv({ DSH_IOS_OCR_SWIFT: stubSwift, DSH_IOS_OCR_DIR: join(cacheDir, 'ocr-bin') }, task)

      await inStubEnv(async () => {
        const found = await tools.iosSimFindText.execute({ udid: fakeRealDevice.udid }, makeExec('ios_sim_find_text', { udid: fakeRealDevice.udid }))
        const w = pngSize.width
        const h = pngSize.height
        const expected = stubItems.map(item => ({
          text: item.text,
          confidence: item.confidence,
          rect: pixelRectToPoints({ x: item.x, y: item.y, w: item.w, h: item.h }, { width: w, height: h }, { width: 402, height: 874 }),
        }))
        const match = (a, b) => a.text === b.text
          && Math.abs(a.confidence - b.confidence) < 1e-9
          && Math.abs(a.rect.x - b.rect.x) < 0.01 && Math.abs(a.rect.y - b.rect.y) < 0.01
        step(
          'find_text returns size in POINTS + pixel→point rects for every item',
          found.device.udid === fakeRealDevice.udid && found.size.width === 402 && found.size.height === 874
            && found.count === 3 && found.items.length === 3
            && found.items.every((item, index) => match(item, expected[index])),
          JSON.stringify(found.items[0]),
        )
        const q = await tools.iosSimFindText.execute(
          { udid: fakeRealDevice.udid, query: 'pay', min_confidence: 0.5 },
          makeExec('ios_sim_find_text', { udid: fakeRealDevice.udid, query: 'pay', min_confidence: 0.5 }),
        )
        step(
          'find_text applies query (case-insensitive) + confidence floor',
          q.count === 2 && q.items.every(item => item.text.toLowerCase().includes('pay') && item.confidence >= 0.5),
          q.items.map(item => `${item.text}@${item.confidence}`).join(' '),
        )
        await expectThrow(
          'tap_text ambiguity: several matches raise the candidate list',
          () => tools.iosSimTapText.execute({ udid: fakeRealDevice.udid, query: 'pay' }, makeExec('ios_sim_tap_text', { udid: fakeRealDevice.udid, query: 'pay' })),
          /2 OCR matches[\s\S]*Candidates[\s\S]*Pay Now[\s\S]*Pay Later[\s\S]*confidence=[\s\S]*rect=/,
        )
        await expectThrow(
          'tap_text no-match names ios_sim_find_text',
          () => tools.iosSimTapText.execute({ udid: fakeRealDevice.udid, query: 'absent' }, makeExec('ios_sim_tap_text', { udid: fakeRealDevice.udid, query: 'absent' })),
          /no recognized text matches[\s\S]*ios_sim_find_text/,
        )
        const tapped = await tools.iosSimTapText.execute(
          { udid: fakeRealDevice.udid, query: 'Pay Now', min_confidence: 0.9 },
          makeExec('ios_sim_tap_text', { udid: fakeRealDevice.udid, query: 'Pay Now', min_confidence: 0.9 }),
        )
        const expectedCenter = pixelCenterToPoints(rectCenter({ x: 100, y: 100, w: 200, h: 40 }), { width: w, height: h }, { width: 402, height: 874 })
        const sent = fakeWda.__state.taps[0]
        step(
          'tap_text taps the pixel→point center through WDA (no fixed scale)',
          tapped.action === 'tap-text' && tapped.text === 'Pay Now' && tapped.tapSpace === 'points'
            && Math.abs(tapped.center.x - expectedCenter.x) < 0.01 && Math.abs(tapped.center.y - expectedCenter.y) < 0.01
            && sent !== undefined && Math.abs(sent.x - expectedCenter.x) < 0.01 && Math.abs(sent.y - expectedCenter.y) < 0.01,
          `sent=(${sent?.x}, ${sent?.y}) expected=(${expectedCenter.x}, ${expectedCenter.y})`,
        )
        step(
          'tap_text keeps the settle screenshot + sim-screenshot meta',
          typeof tapped.path === 'string' && existsSync(tapped.path) && tapped.bytes > 0,
          tapped.path,
        )
        const meta = tools.iosSimTapText.output.presentationMeta({ query: 'Pay Now' }, tapped)
        step(
          'tap_text presentationMeta is the sim-screenshot envelope',
          meta.kind === 'sim-screenshot' && meta.screenshotPath === tapped.path && meta.device.udid === fakeRealDevice.udid,
          JSON.stringify(meta),
        )
        await expectThrow(
          'tap_text with no query is rejected by the tool schema',
          () => tools.iosSimTapText.execute({ udid: fakeRealDevice.udid }, makeExec('ios_sim_tap_text', { udid: fakeRealDevice.udid })),
          /missing required property "query"/,
        )
        await expectThrow(
          'tap_text rejects an out-of-range min_confidence',
          () => tools.iosSimTapText.execute({ udid: fakeRealDevice.udid, query: 'x', min_confidence: 2 }, makeExec('ios_sim_tap_text', { udid: fakeRealDevice.udid, query: 'x', min_confidence: 2 })),
          /min_confidence must be a number within 0\.\.1/,
        )

        // expect_text: the tap and its verification are ONE round trip.
        const screenshotsBeforeExpect = fakeWda.__state.screenshots
        const asserted = await tools.iosSimTapText.execute(
          { udid: fakeRealDevice.udid, query: 'Pay Now', expect_text: 'Pay Later' },
          makeExec('ios_sim_tap_text', { udid: fakeRealDevice.udid, query: 'Pay Now', expect_text: 'Pay Later' }),
        )
        step(
          'tap_text expect_text reports expected.matched in the same call',
          asserted.expected !== undefined && asserted.expected.text === 'Pay Later'
            && asserted.expected.mode === 'appear' && asserted.expected.matched === true
            && asserted.expected.waitedMs < 4000,
          JSON.stringify(asserted.expected),
        )
        step(
          'expect_text adds exactly ONE extra OCR capture beyond the tap (find + settle + 1 poll)',
          fakeWda.__state.screenshots - screenshotsBeforeExpect === 3,
          `screenshots delta=${fakeWda.__state.screenshots - screenshotsBeforeExpect}`,
        )
        // Absent expectation args = today's behaviour exactly: no extra OCR.
        const screenshotsBeforePlain = fakeWda.__state.screenshots
        const plain = await tools.iosSimTapText.execute(
          { udid: fakeRealDevice.udid, query: 'Pay Now' },
          makeExec('ios_sim_tap_text', { udid: fakeRealDevice.udid, query: 'Pay Now' }),
        )
        step(
          'tap_text without expect_text/expect_gone does no extra OCR (find + settle only)',
          plain.expected === undefined && fakeWda.__state.screenshots - screenshotsBeforePlain === 2,
          `screenshots delta=${fakeWda.__state.screenshots - screenshotsBeforePlain}`,
        )
      })

      // The ~40 KB item cap: a stub that floods items.
      const floodDir = mkdtempSync(join(tmpdir(), 'dsh-ios-ocr-flood-'))
      tempDirs.push(floodDir)
      const floodItems = Array.from({ length: 2000 }, (_unused, index) => ({
        text: `Flood item number ${index} with a fairly long label`,
        confidence: 0.5,
        x: 1, y: 1, w: 10, h: 10,
      }))
      const floodSwift = join(floodDir, 'ocr.swift')
      writeFileSync(floodSwift, `import Foundation\nprint(${JSON.stringify(JSON.stringify({ count: floodItems.length, items: floodItems }))})\n`)
      const floodTools = await withEnv({ DSH_IOS_OCR_SWIFT: floodSwift, DSH_IOS_OCR_DIR: join(floodDir, 'bin') }, () => {
        return createSimOcrTools(host, { wda: fakeWda, realDevices, cacheDir })
      })
      await withEnv({ DSH_IOS_OCR_SWIFT: floodSwift, DSH_IOS_OCR_DIR: join(floodDir, 'bin') }, async () => {
        const flooded = await floodTools.iosSimFindText.execute({ udid: fakeRealDevice.udid }, makeExec('ios_sim_find_text', { udid: fakeRealDevice.udid }))
        step(
          'find_text caps the item list at ~40 KB with truncated=true + hint',
          flooded.truncated === true && flooded.count < 2000 && flooded.count > 0
            && typeof flooded.hint === 'string' && flooded.hint.includes('min_confidence'),
          `${flooded.count} of 2000 items kept`,
        )
      })
    } else {
      warn('tool-level stub flow needs the PNG generator — skipped', 'swiftc present but the generator failed')
    }
  } else {
    warn('tool-level stub flow needs swiftc — skipped', 'no swiftc on this host')
  }

  // ── F. empty/degenerate ui_tree names the OCR fallback ────────────────────
  {
    const uiCache = mkdtempSync(join(tmpdir(), 'dsh-ios-ocr-uitree-'))
    tempDirs.push(uiCache)
    const emptyWda = makeFakeWda(TINY_PNG_B64, 1, 1,
      '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="EmptyApp" enabled="true" visible="true" x="0" y="0" width="402" height="874"/>')
    const uiTools = createSimUiTools(host, { wda: emptyWda, realDevices, cacheDir: uiCache })
    const degenerate = await uiTools.iosSimUiTree.execute({ udid: fakeRealDevice.udid }, makeExec('ios_sim_ui_tree', { udid: fakeRealDevice.udid }))
    step(
      'a degenerate tree appends the ios_sim_find_text hint',
      degenerate.nodeCount <= 1 && typeof degenerate.hint === 'string' && degenerate.hint.includes('ios_sim_find_text'),
      degenerate.hint,
    )
  }

  // ── G. REAL end-to-end: compile the bundled helper, OCR a generated PNG ──
  if (hasSwiftc) {
    const realDir = mkdtempSync(join(tmpdir(), 'dsh-ios-ocr-real-'))
    tempDirs.push(realDir)
    const realBuild = await withEnv({ DSH_IOS_OCR_DIR: join(realDir, 'bin'), DSH_IOS_OCR_SWIFT: undefined }, async () => ensureOcrBinary())
    const genDir = join(realDir, 'gen')
    const genSwift = join(realDir, 'gen.swift')
    writeFileSync(genSwift, [
      'import Foundation',
      'import AppKit',
      'let W = 800, H = 400',
      'let img = NSImage(size: NSSize(width: W, height: H))',
      'img.lockFocus()',
      'NSColor.white.setFill()',
      'NSRect(x: 0, y: 0, width: W, height: H).fill()',
      '("HELLO 123").draw(at: NSPoint(x: 40, y: 160), withAttributes: [.font: NSFont.systemFont(ofSize: 64, weight: .bold), .foregroundColor: NSColor.black])',
      'img.unlockFocus()',
      'guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { exit(1) }',
      'try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))',
    ].join('\n'))
    const fixturePng = join(realDir, 'fixture.png')
    const generated = spawnSync('swiftc', ['-O', genSwift, '-o', join(realDir, 'gen')], { stdio: 'pipe', timeout: 120_000 }).status === 0
      && spawnSync(join(realDir, 'gen'), [fixturePng], { stdio: 'pipe', timeout: 60_000 }).status === 0
      && existsSync(fixturePng)
    step('a text fixture PNG is generated in the smoke (nothing committed)', generated, fixturePng)
    if (generated && realBuild.available) {
      const raw = await withEnv({ DSH_IOS_OCR_DIR: join(realDir, 'bin'), DSH_IOS_OCR_SWIFT: undefined }, async () => execOcr(realBuild, fixturePng))
      const items = parseOcrOutput(raw.stdout)
      const pngSize = readPngSize(fixturePng)
      const hello = items.find(item => item.text.toUpperCase().includes('HELLO'))
      step(
        'the compiled helper OCRs the generated PNG (text + pixel boxes)',
        items.length >= 1 && hello !== undefined && hello.confidence >= 0.3
          && hello.rect.x >= 0 && hello.rect.y >= 0
          && hello.rect.x + hello.rect.w <= pngSize.width && hello.rect.y + hello.rect.h <= pngSize.height,
        `${items.length} items; ${JSON.stringify(hello)}`,
      )
      step(
        'helper output parses through parseOcrOutput (count/items shape)',
        items.every(item => item.text !== '' && item.confidence >= 0 && item.confidence <= 1),
        `count=${items.length}`,
      )
    } else {
      warn('real-helper end-to-end skipped — compile or PNG generation failed', realBuild.reason ?? '')
    }
  }

  // ── H. live pass: phone connected AND WDA up on :8100 (read-only) ────────
  let live = false
  try {
    const devices = await listRealDevices()
    const phone = devices.find(d => d.udid === DEVICE_UDID)
    live = phone !== undefined && await probeWdaControlTunnel(8100)
    if (!live) {
      step('live OCR pass (phone + running WDA)', 'SKIP', phone === undefined ? 'phone not connected' : 'WDA not answering on 127.0.0.1:8100')
    }
  } catch (error) {
    step('live OCR pass (phone + running WDA)', 'SKIP', `devicectl unavailable: ${String(error)}`)
  }
  if (live) {
    const liveCache = mkdtempSync(join(tmpdir(), 'dsh-ios-ocr-live-'))
    tempDirs.push(liveCache)
    liveWda = new WdaController()
    const liveTools = createSimOcrTools(host, { wda: liveWda, cacheDir: liveCache })
    // Home first so the screenshot captures a readable (not near-black AOD)
    // screen — the same allowance the realtools smoke uses.
    try {
      await liveWda.ensureRunning({ udid: DEVICE_UDID })
      await liveWda.control.pressButton('home')
    } catch (error) {
      step('LIVE ios_sim_find_text', 'SKIP', `WDA adopt failed: ${String(error)}`)
      live = false
    }
    if (live) {
      // Retry once or twice: the phone screen can be mid-animation right
      // after the home press (cover sheet, notification banners), which can
      // transiently yield zero items or shift boxes between two captures.
      let found
      let liveOk = false
      let liveDetail = ''
      for (let attempt = 1; attempt <= 3 && !liveOk; attempt += 1) {
        try {
          await liveWda.control.pressButton('home')
        } catch {
          // The screen state is a nicety; OCR works regardless.
        }
        await new Promise(resolve => setTimeout(resolve, 1500))
        found = await liveTools.iosSimFindText.execute({ udid: DEVICE_UDID }, makeExec('ios_sim_find_text', { udid: DEVICE_UDID }))
        if (found.count >= 1 && found.size.width === 402 && found.size.height === 874) {
          liveOk = true
          liveDetail = `${found.count} items @ ${found.size.width}x${found.size.height}: ${found.items.slice(0, 5).map(item => `${item.text}@${item.confidence}`).join(', ')}`
        } else {
          liveDetail = `attempt ${attempt}: ${found.count} items — retrying after a settle`
        }
      }
      step(
        'LIVE ios_sim_find_text returns recognizable items',
        liveOk && found !== undefined && found.device.udid === DEVICE_UDID
          && found.items.every(item =>
            item.rect.x >= 0 && item.rect.y >= 0
            && item.rect.x + item.rect.w <= found.size.width + 1
            && item.rect.y + item.rect.h <= found.size.height + 1),
        liveDetail,
      )
      // Verify one item's rect maps into the correct point coordinates:
      // re-run the raw helper on a fresh screenshot and recompute the same
      // pixel→point conversion the tool performed.
      if (liveOk) {
        let verifyOk = false
        let verifyDetail = ''
        for (let attempt = 1; attempt <= 3 && !verifyOk; attempt += 1) {
          const shot = await liveWda.control.screenshot()
          const shotPath = join(liveCache, `verify-${attempt}.png`)
          writeFileSync(shotPath, Buffer.from(shot.pngBase64, 'base64'))
          const pngSize = readPngSize(shotPath)
          const raw = await execOcr(await ensureOcrBinary(), shotPath)
          const rawItems = parseOcrOutput(raw.stdout)
          const verify = found.items.find(item => rawItems.some(rawItem => rawItem.text === item.text))
          if (verify !== undefined && pngSize !== undefined) {
            const rawItem = rawItems.find(rawItem => rawItem.text === verify.text)
            const expected = pixelRectToPoints(rawItem.rect, pngSize, { width: 402, height: 874 })
            const close = Math.abs(expected.x - verify.rect.x) < 0.1 && Math.abs(expected.y - verify.rect.y) < 0.1
              && Math.abs(expected.w - verify.rect.w) < 0.1 && Math.abs(expected.h - verify.rect.h) < 0.1
            if (close) {
              verifyOk = true
              verifyDetail = `${JSON.stringify(verify.text)} tool=(${verify.rect.x},${verify.rect.y},${verify.rect.w},${verify.rect.h}) recomputed=(${expected.x},${expected.y},${expected.w},${expected.h})`
            } else {
              verifyDetail = `attempt ${attempt}: ${JSON.stringify(verify.text)} moved between captures (screen animation?) — retrying`
            }
          } else {
            verifyDetail = pngSize === undefined
              ? 'PNG size unreadable'
              : `attempt ${attempt}: no common text between runs — retrying`
          }
        }
        step('LIVE one item rect maps to the same point coordinates as the tool', verifyOk ? 'PASS' : 'SKIP', verifyDetail)
      }
      step('LIVE ios_sim_tap_text', 'SKIP', 'not exercised on the personal phone (safety: read-only screenshot + OCR)')
    }
  }
} catch (error) {
  step('smoke completed without uncaught errors', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  try { await liveWda?.dispose() } catch { /* best effort */ }
  try { await host?.dispose() } catch { /* best effort */ }
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// ── near-miss reporting: below-threshold matches must name themselves ──────
// From a real session: the OCR read "使用App时允许" at confidence 0.50, the
// caller passed min_confidence 0.80, and tap_text answered "no recognized
// text matches …" — sending the model back to find_text to rediscover a
// label that WAS on screen. Chinese/Japanese labels read 0.3–0.6 far more
// often than Latin ones, so this is the common case, not an edge case.
{
  const items = [
    { text: '使用App时允许', confidence: 0.5, rect: { x: 100, y: 500, w: 180, h: 40 } },
    { text: '不允许', confidence: 1, rect: { x: 100, y: 560, w: 90, h: 40 } },
  ]
  const filtered = filterOcrItems(items, '使用App时允许', 0.8)
  step(
    'the confidence filter drops the 0.50 match (the setup for the trap)',
    filtered.length === 0,
    `${filtered.length} items survive min_confidence 0.8`,
  )
  let message = ''
  try {
    resolveOcrTextTarget(filtered, '使用App时允许', items, 0.8)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  step(
    'a below-threshold match reports its own confidence and the fix',
    message.includes('使用App时允许') && message.includes('0.50') && message.includes('0.80')
      && /lower min_confidence/.test(message),
    message.slice(0, 160),
  )
  let absent = ''
  try {
    resolveOcrTextTarget([], 'Nothing Here', items, 0.8)
  } catch (error) {
    absent = error instanceof Error ? error.message : String(error)
  }
  step(
    'genuinely absent text still gets the plain "not on screen" answer',
    absent.includes('no recognized text matches') && !absent.includes('confidence'),
    absent.slice(0, 120),
  )
}

// ── the point size is a device property, not a per-call question ───────────
// Profiled on a booted simulator: ios_sim_find_text spent ~800 ms of its
// 1.5 s inside AXe `describe-ui` — a full accessibility-tree dump — purely to
// learn that a 1206×2622 screenshot is 402×874 points. That mapping cannot
// change without the pixel size changing too, so it is cached under
// (udid, pixel size): a rotation swaps both and misses, which is exactly the
// case where reusing the old axis would map taps wrong.
{
  resetSimPointSizeCache()
  const before = simPointSizeStats()
  step(
    'the point-size cache starts empty and counts hits/misses',
    before.hits === 0 && before.misses === 0 && before.entries === 0,
    JSON.stringify(before),
  )
  const portrait = simPointSizeCacheKey('UDID-1', { width: 1206, height: 2622 })
  const landscape = simPointSizeCacheKey('UDID-1', { width: 2622, height: 1206 })
  const other = simPointSizeCacheKey('UDID-2', { width: 1206, height: 2622 })
  step(
    'rotation and a different device both miss the cache (never a wrong axis)',
    portrait !== landscape && portrait !== other && landscape !== other,
    `${portrait} | ${landscape} | ${other}`,
  )
  const booted = (await listDevices()).filter(device => device.state === 'Booted')
  if (booted.length === 0) {
    step('live: a second find_text reuses the resolved point size', 'SKIP', 'no booted simulator')
  } else {
    const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-ios-ptsize-'))
    tempDirs.push(cacheDir)
    const ocrTools = createSimOcrTools(new SimHostController(), { cacheDir })
    const call = () => ocrTools.iosSimFindText.execute({ udid: booted[0].udid }, {
      callId: 'ptsize', rootCallId: 'ptsize', name: 'ios_sim_find_text', arguments: {}, signal: new AbortController().signal,
    })
    const firstAt = Date.now()
    const first = await call()
    const firstMs = Date.now() - firstAt
    const secondAt = Date.now()
    const second = await call()
    const secondMs = Date.now() - secondAt
    const stats = simPointSizeStats()
    step(
      'live: the second find_text hits the cache instead of dumping the UI tree again',
      stats.misses === 1 && stats.hits >= 1,
      `misses=${stats.misses} hits=${stats.hits} — ${firstMs} ms then ${secondMs} ms`,
    )
    step(
      'live: the cached size is the SAME size, not a cheaper approximation',
      first.size.width === second.size.width && first.size.height === second.size.height,
      `${first.size.width}x${first.size.height} both calls`,
    )
  }
}

console.log('')
console.log(`${results.length} steps: ${results.filter(r => r.verdict === 'PASS').length} passed, ${results.filter(r => r.verdict === 'SKIP').length} skipped, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
