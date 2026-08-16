/**
 * Development smoke test for the dsh-ios persistent simulator panel.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-panel-smoke.mjs
 *
 * Static (SSR) only — no browser, no network, no simulators. Loads the built
 * browser bundle (lib/client.js) in Node through the `window.__ModuleLoader__`
 * shim (same mechanism as dev-card-smoke.mjs) and `react-dom/server` renders
 * the panel components:
 *
 * - stream mode and screenshot mode connected panels (mocked grant fetcher
 *   that throws, so any network access during render fails loudly) →
 *   the loading/granting phase;
 * - the pure panel body composed with the shared live-frame body in the live
 *   and fallback phases (explicit session snapshots — no network needed);
 * - the pure screenshot-frame body in live and fallback phases.
 *
 * It also proves the restructured surfaces: the inline cards are compact
 * one-line summaries with NO imagery (the shared `SimLiveFrame` now belongs
 * to the panel alone), the Live/Offline indicator renders in stream mode
 * only (hidden for screenshot-mode panels), and the input-dock status
 * capsule renders null unless the panel is closed AND the stream is running
 * AND the CURRENT session has simulator sources registered (a brand-new
 * empty session shows no capsule and the status poll never starts — the
 * poll loop is exercised through the timer-injectable poller with fetcher
 * call counting). Panel store, dock lease, source registry, and click-routing
 * helpers are exercised as pure functions (no DOM).
 *
 * Theme contract: the panel chrome adopts dsh-openpencil's `--dsw-alias-*`
 * tokens. The smoke stubbed-renders the panel header/status in BOTH light and
 * dark scheme values and asserts the style objects reference the token vars
 * with no literal dark surround colors — the phone bezel is the one
 * allow-listed device surface.
 *
 * Size modes: the store's `sizeMode` transitions, the pure fit/percent/preset
 * width computation (natural px / 3 logical-point basis), the size dropdown
 * SSR (zh/en copy), and the display-size purity of tap normalization
 * (`normalizePointerPoint` over `getBoundingClientRect` bounds). The
 * percent × orientation THREADING is asserted through the full component
 * chain (SimulatorPanelBody → SimPhoneFrame → simPanelFrameStyles): with
 * natural 1206×2622 and orientation set, a mounted panel's frame must
 * render an explicit INLINE width of 874px landscape / 402px portrait at
 * 100% — the pure helpers alone hid the prop-threading regression where the
 * frame style ignored orientation and natural dims.
 *
 * Frame styles: the store's `frameStyle` transitions (default slim bezel,
 * host-lifetime persistence), the header segmented control (无框/边框/真机框
 * · Frameless/Bezel/Device frame, zh/en copy + aria-labels, store sync both
 * ways), and per-mode SSR shells with PROPORTIONAL corner radii (native
 * Simulator.app ratio: screen radius = min(displayedW, displayedH) × 55/390,
 * e.g. 390 → 55 · 240 → 33.8 · landscape 844×390 → 55; percent/preset
 * derived exactly from props, fit measured live by the frame's
 * ResizeObserver — radius updates are style-only and never remount the
 * stream img) — frameless (bare content: NO background/border layers
 * between the frame wrapper and the img, transparent allowlisted, the
 * screen box carries the clip), bezel (padding 6, dark rim, shell radius =
 * screen + 6), device (16px shell in the 14–18px range, dark metallic
 * gradient, shell radius = screen + 16, 1px inner edge highlight, portrait
 * side-button nubs). The WP19 size/rotation geometry stays identical in all
 * three modes (landscape fill spot-checked in device + frameless shells).
 *
 * Top toolbar: the compact toolbar row renders the size quick buttons
 * [Fit/适应] [100%] [S] [M] as ONE borderless segmented pill group (single
 * `--dsw-alias-bg-layer-1` + `--dsw-alias-border-l2` outer border, full
 * radius, borderless segments, ACTIVE segment = `--dsw-alias-interactive-bg-
 * active` background fill + aria-pressed) | divider | an action ICON pill
 * (inline stroke SVGs: Home/回到桌面 · Screenshot/截图 · Rotate/旋转 ·
 * Refresh/刷新) with hover/focus tooltips (150ms show delay, token-styled
 * bubble below the button, aria-label stays on the button) in both locales
 * and themes (token-only styles); the quick buttons and the header dropdown
 * dispatch the SAME store transitions and re-render from the same store
 * snapshot (sync both ways); Home/Refresh wiring stays on the stream
 * session handlers; Rotate's tag-7 frame encoding and the clockwise cycle
 * are asserted byte-for-byte like tap frames; and the 截图 capture
 * controller (POST body shape, window.open of the minted URL, busy → done →
 * auto-clear with fake timers) runs without a browser or network.
 *
 * Landscape display fix: the orientation→rotation/dimension math for all
 * four orientations (axes swap for the ±90° cases), the pointer
 * inverse-mapping back to framebuffer coordinates (all four orientations,
 * asymmetric 390×844 rect, corners + center), the SSR of the panel in a
 * landscape orientation state (rotation wrapper fills the screen area with
 * the swapped dims; the stream img's PRE-rotation box carries the SWAPPED
 * wrapper dims — width = wrapper height, height = wrapper width — centered
 * with the translate(-50%,-50%) leg composed into the counter-rotate
 * transform, so the rotated img fills the wrapper edge-to-edge; wide bezel),
 * and the fit/percent/preset width math against the rotated (displayed)
 * dimensions.
 *
 * Sub-pixel bezel symmetry: the fit-mode frame width resolves against the
 * stage's content box, which can be fractional after a drag-resize; a
 * fractional border-box rounds differently at each device-pixel edge at 2×
 * DPR, and `objectFit: contain` left the residual slack on ONE side, so one
 * bezel rim rendered a physical pixel thicker. The panel now (a) renders
 * the stream img with `objectFit: fill` — safe because the rotation wrapper
 * enforces the framebuffer aspect (see the WHY comment on
 * PANEL_STREAM_ROTATION_IMG_STYLES in card-styles.ts) — and (b) snaps every
 * computed/measured frame width to a whole CSS px (`simPanelSnapPxOf`)
 * before deriving radius/box values and before applying the fit frame's
 * measured width, so `margin: 0 auto` splits any remainder evenly and both
 * rims rasterize symmetrically. The screenshot img keeps `contain` (its box
 * aspect is not guaranteed — screenshot mode never reports a natural
 * height).
 *
 * WP27 rim symmetry + orientation-aware presets: the bezel/device shells
 * carry a 1px border per side that the old screen-width math never
 * subtracted (padding only), so the screen rendered 2px wider than the
 * frame's content box, overflowed into the right padding/border and the
 * right rim lost its border px (7px left / 5px right at the 348px fit
 * frame). The screen now renders border-box at 100% width and every
 * screen-width derivation (measured fit, percent, preset, WP22 radius
 * basis) goes through one helper (`simPanelScreenWidthOf`) that subtracts
 * 2×(padding + border) per mode, so rim left == rim right == pad+border in
 * all three frame modes (asserted SSR-computable from the style objects +
 * the derivation helper). Presets are now orientation-aware SHORT-side
 * sizes: portrait renders the preset px width, landscape scales it by the
 * displayed width/height ratio (natural dims, 844/390 fallback) — landscape
 * S = 240 × 874/402 ≈ 522px (snapped via simPanelSnapPxOf), and the
 * proportional radius follows the resulting rendered box in both
 * orientations. The 50/75/125 percent steps are verified at the component
 * level (explicit inline widths) in BOTH orientations post-WP26.
 *
 * Panel width policy: the surface geometry adopts dsh-openpencil's
 * `editorWorkbenchWidthBounds` shape verbatim (MIN 320 stays, MAX widened to
 * 960, 640px conversation clearance, preferred 380 default → `{min, max,
 * initial}` per viewport, drag + clamp helpers over it, the handle's
 * aria-valuemin/max report the LIVE bounds, double-click on the handle
 * resets to the bounds initial — asserted from source). A landscape
 * auto-widen state machine follows the stream's tag-130 orientation:
 * portrait→landscape widens to a comfortable device-aspect width
 * (~420px-tall screen, snapped to the WP24 integer grid and clamped to the
 * bounds) when the current width is below it, the pre-stint width is
 * remembered and restored on the way back, and a manual drag during the
 * stint sets a user-override flag (reset per stint) so the panel never
 * fights the user. The dock lease margin-right is re-asserted at the wider
 * widths and the overlay fallback uses the same clamp.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require2 = createRequire(import.meta.url)
const React = require2('react')
const { renderToString } = require2('react-dom/server')

/** Execute the built browser bundle in Node (dev-card-smoke shim). */
function loadClientExports() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const loaded = {}
  const browserWindow = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded[id] = factory(specifier => require2(specifier))
      },
    },
  }
  const evaluate = new Function('window', source)
  evaluate(browserWindow)
  const client = loaded['@zseven-w/dsh-ios']
  if (client === undefined) throw new Error('client bundle did not register @zseven-w/dsh-ios')
  return client
}

const CALL_ID = 'call-panel-smoke'

function settledBlock(toolName, meta, options = {}) {
  return {
    kind: 'tool-result',
    seq: 1,
    time: Date.now(),
    callId: CALL_ID,
    call: { name: toolName, argsRaw: '{}' },
    callTime: Date.now(),
    content: options.content ?? [],
    isError: options.isError ?? false,
    callView: null,
    resultView: null,
    subCalls: [],
    meta: options.meta !== undefined ? options.meta : meta,
  }
}

/** Fails the SSR test loudly if any component tries to fetch during render. */
function throwingFetcher() {
  throw new Error('a component attempted a network request during server rendering')
}

const noop = () => {}
const fakeImgRef = { current: null }

const BOOT_META = {
  kind: 'sim-stream',
  device: { udid: 'PANEL-BOOT-UDID', name: 'iPhone 17 Pro', runtime: 'iOS 26', state: 'Booted' },
  streamRouteId: 'dsh-ios/stream/PANEL-BOOT-UDID',
}
const SCREENSHOT_META = {
  kind: 'sim-screenshot',
  screenshotPath: '/tmp/dsh-ios/screenshots/panel-smoke.png',
  path: '/tmp/dsh-ios/screenshots/panel-smoke.png',
  device: { udid: 'PANEL-SHOT-UDID', name: 'iPhone 17 Pro', runtime: 'iOS 26', state: 'Booted' },
}
const BUILD_META = {
  kind: 'sim-build-run',
  device: { udid: 'PANEL-BUILD-UDID', name: 'iPhone 17 Pro', runtime: 'iOS 26', state: 'Booted' },
  bundleId: 'com.example.panel',
  appPath: '/tmp/dsh-ios/builds/panel.app',
}

function renderPanel(props) {
  return renderToString(React.createElement(client.SimulatorPanel, props))
}

function renderCard(component, props) {
  return renderToString(React.createElement(component, props))
}

const results = []
function step(name, ok, detail = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  results.push({ name, ok })
  console.log(`${verdict} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

let client
try {
  client = loadClientExports()
  step('client bundle loads through the module-loader shim', true, 'lib/client.js evaluated in Node')

  // ═══════════════════════════════════════════════════════════════════════════
  // Shared stream engine: symbol identity + both surfaces mount it
  // ═══════════════════════════════════════════════════════════════════════════
  step(
    'shared live-frame hook identity (SimLiveFrame.sharedStreamHook === useSimStream)',
    typeof client.useSimStream === 'function'
      && typeof client.SimLiveFrame === 'function'
      && client.SimLiveFrame.sharedStreamHook === client.useSimStream,
    'one module object for both surfaces',
  )

  const bootCardHtml = renderCard(client.SimStreamCard, {
    callId: CALL_ID,
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', BOOT_META),
    openFile: () => {},
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'inline card renders the compact summary with NO imagery',
    bootCardHtml.includes('data-sim-card-kind="compact"')
      && bootCardHtml.includes('data-state="live"')
      && bootCardHtml.includes('iPhone 17 Pro')
      && bootCardHtml.includes('Open in sidebar')
      && bootCardHtml.includes('>live<')
      && !bootCardHtml.includes('data-sim-live-frame')
      && !bootCardHtml.includes('<img'),
    'SimStreamCard dropped SimLiveFrame/imagery (panel-only display)',
  )
  step(
    'inline card keeps its tool markers for the row-click trigger',
    bootCardHtml.includes('data-tool="ios_sim_boot"')
      && bootCardHtml.includes('data-state="live"')
      && bootCardHtml.includes('iOS Simulator')
      && bootCardHtml.includes('>Boot<')
      && !bootCardHtml.includes('Connecting to the live stream…'),
    'compact card markers intact (unified title + Boot action sub-label)',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Connected panel SSR — loading/granting phase, stream mode
  // ═══════════════════════════════════════════════════════════════════════════
  const streamPanelHtml = renderPanel({
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', BOOT_META),
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
    onClose: noop,
  })
  step(
    'panel stream mode renders the loading phase without exceptions',
    streamPanelHtml.includes('data-sim-panel="true"')
      && streamPanelHtml.includes('data-sim-mode="stream"'),
    `${streamPanelHtml.length} html chars`,
  )
  step(
    'panel header shows device name + udid',
    streamPanelHtml.includes('iPhone 17 Pro') && streamPanelHtml.includes('PANEL-BOOT-UDID'),
    'device · udid header line',
  )
  step(
    'panel header shows the unified title for every opening tool (boot/screenshot/interact/build-run)',
    ['ios_sim_boot', 'ios_sim_screenshot', 'ios_sim_interact', 'ios_sim_build_run'].every(toolName => {
      const html = renderPanel({
        toolName,
        block: settledBlock(toolName, toolName === 'ios_sim_build_run' ? BUILD_META : SCREENSHOT_META),
        fetcher: throwingFetcher,
        locale: 'en',
        colorScheme: 'dark',
      })
      return html.includes('iOS Simulator') && html.includes('aria-label="iOS Simulator"')
    }),
    'the panel is iOS Simulator-only; the per-tool titles are gone from the header',
  )
  step(
    'panel mounts the shared live frame (panel variant)',
    streamPanelHtml.includes('data-sim-live-frame="panel"')
      && streamPanelHtml.includes('Connecting to the live stream…'),
    'SimLiveFrame panel variant',
  )
  step(
    'panel renders the phone frame + offline indicator while granting',
    streamPanelHtml.includes('data-sim-phone-frame="true"')
      && streamPanelHtml.includes('data-sim-live-indicator="offline"')
      && streamPanelHtml.includes('#9ca3af')
      && streamPanelHtml.includes('Offline'),
    'gray dot + Offline',
  )
  step(
    'panel close button renders with the close aria-label',
    streamPanelHtml.includes('data-sim-panel-close="true"') && streamPanelHtml.includes('Close simulator panel'),
    'user can close the panel',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Connected panel SSR — loading phase, screenshot mode (screenshot + interact)
  // ═══════════════════════════════════════════════════════════════════════════
  const screenshotPanelHtml = renderPanel({
    toolName: 'ios_sim_screenshot',
    block: settledBlock('ios_sim_screenshot', SCREENSHOT_META),
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'panel screenshot mode renders the loading phase',
    screenshotPanelHtml.includes('data-sim-mode="screenshot"')
      && screenshotPanelHtml.includes('data-sim-screenshot-frame="panel"')
      && screenshotPanelHtml.includes('Loading screenshot…')
      && screenshotPanelHtml.includes('PANEL-SHOT-UDID'),
    `${screenshotPanelHtml.length} html chars`,
  )
  step(
    'screenshot mode hides the live/offline indicator entirely',
    !screenshotPanelHtml.includes('data-sim-live-indicator')
      && !screenshotPanelHtml.includes('Offline'),
    'the ● Live/Offline readout only makes sense for the stream mode',
  )

  const buildPanelHtml = renderPanel({
    toolName: 'ios_sim_build_run',
    block: settledBlock('ios_sim_build_run', BUILD_META),
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'panel build-run mode derives the live stream from build meta',
    buildPanelHtml.includes('data-sim-mode="stream"')
      && buildPanelHtml.includes('data-sim-live-frame="panel"')
      && buildPanelHtml.includes('iOS Simulator'),
    `${buildPanelHtml.length} html chars`,
  )
  step(
    'stream-mode panel keeps the offline indicator while granting',
    buildPanelHtml.includes('data-sim-live-indicator="offline"') && buildPanelHtml.includes('Offline'),
    'gray dot while no ws is open (stream mode only)',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Connected panel SSR — nested Code Mode (PTC) blocks hydrate their meta
  // ═══════════════════════════════════════════════════════════════════════════
  // rc.6 projects a nested code-mode sub-call as a ToolResultNode with the
  // FULL durable result JSON in `content` and NO `meta` field (verified in
  // the installed dsh-client-ui-conversation bundle's `childResult`). The
  // panel must reconstruct the meta from that result text so the sidebar
  // keeps working in PTC sessions.
  const PTC_PANEL_DEVICE = { udid: 'PTC-PANEL-UDID', name: 'iPhone 17 Pro', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', state: 'Booted' }
  const PTC_PANEL_SHOT_PATH = '/tmp/dsh-ios/screenshots/screenshot-PTC-PANEL-UDID-18.png'
  const PTC_PANEL_CONTENT = {
    boot: [{ type: 'text', text: JSON.stringify({ device: PTC_PANEL_DEVICE, state: 'booted', streaming: true }) }],
    screenshot: [{ type: 'text', text: JSON.stringify({ path: PTC_PANEL_SHOT_PATH, bytes: 2894051, width: 1206, height: 2622, device: PTC_PANEL_DEVICE }) }],
    buildRun: [{
      type: 'text',
      text: JSON.stringify({
        device: PTC_PANEL_DEVICE,
        state: 'launched',
        bundleId: 'com.example.ptcpanel',
        pid: '12345',
        appPath: '/tmp/dsh-ios/builds/ptc/DerivedData/Build/Products/Debug-iphonesimulator/PTC.app',
        // Platform-neutral fixture path: never touched on disk, only hydrated
        // into the panel meta (keeps the static smoke host-agnostic for CI).
        projectPath: '/tmp/dsh-ios/builds/ptc',
        scheme: 'PTC',
        configuration: 'Debug',
      }),
    }],
  }

  const ptcStreamPanelHtml = renderPanel({
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', undefined, { content: PTC_PANEL_CONTENT.boot }),
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
    onClose: noop,
  })
  step(
    'PTC boot panel hydrates stream mode from the result text',
    ptcStreamPanelHtml.includes('data-sim-panel="true"')
      && ptcStreamPanelHtml.includes('data-sim-mode="stream"')
      && ptcStreamPanelHtml.includes('PTC-PANEL-UDID')
      && ptcStreamPanelHtml.includes('data-sim-live-frame="panel"')
      && ptcStreamPanelHtml.includes('data-sim-live-indicator="offline"'),
    `${ptcStreamPanelHtml.length} html chars, hydrated meta`,
  )
  const ptcShotPanelHtml = renderPanel({
    toolName: 'ios_sim_screenshot',
    block: settledBlock('ios_sim_screenshot', undefined, { content: PTC_PANEL_CONTENT.screenshot }),
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'PTC screenshot panel hydrates screenshot mode from the result text',
    ptcShotPanelHtml.includes('data-sim-mode="screenshot"')
      && ptcShotPanelHtml.includes('data-sim-screenshot-frame="panel"')
      && ptcShotPanelHtml.includes('Loading screenshot…')
      && ptcShotPanelHtml.includes('PTC-PANEL-UDID'),
    `${ptcShotPanelHtml.length} html chars, hydrated meta`,
  )
  const ptcBuildPanelHtml = renderPanel({
    toolName: 'ios_sim_build_run',
    block: settledBlock('ios_sim_build_run', undefined, { content: PTC_PANEL_CONTENT.buildRun }),
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'PTC build-run panel hydrates the stream from the build result text',
    ptcBuildPanelHtml.includes('data-sim-mode="stream"')
      && ptcBuildPanelHtml.includes('data-sim-live-frame="panel"')
      && ptcBuildPanelHtml.includes('iOS Simulator')
      && ptcBuildPanelHtml.includes('PTC-PANEL-UDID'),
    `${ptcBuildPanelHtml.length} html chars, hydrated meta`,
  )
  const ptcBrokenPanelHtml = renderPanel({
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', undefined, { content: [] }),
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'PTC panel without a valid result keeps the unavailable mode',
    ptcBrokenPanelHtml.includes('data-sim-mode="unavailable"')
      && ptcBrokenPanelHtml.includes('No live view is available for this result.'),
    `${ptcBrokenPanelHtml.length} html chars, fallback kept`,
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Pure panel body — live-frame phase (explicit session snapshot)
  // ═══════════════════════════════════════════════════════════════════════════
  const liveSession = {
    phase: 'live',
    streamUrl: '/_dsh/dsh-ios/stream/mock',
    failure: '',
    imgRef: fakeImgRef,
    refresh: noop,
    retryOnce: noop,
    sendHome: noop,
    onPointerDown: noop,
    onPointerMove: noop,
    onPointerUp: noop,
  }
  const liveFrameElement = React.createElement(client.SimLiveFrameBody, {
    meta: BOOT_META,
    colorScheme: 'dark',
    locale: 'en',
    variant: 'panel',
    session: liveSession,
  })
  const livePanelHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: true,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    onHome: noop,
    onScreenshot: noop,
    onRotate: noop,
    onRefresh: noop,
    children: liveFrameElement,
  }))
  step(
    'live-frame phase renders the stream img inside the phone frame',
    livePanelHtml.includes('data-sim-frame-state="live"')
      && livePanelHtml.includes('src="/_dsh/dsh-ios/stream/mock"')
      && livePanelHtml.includes('data-sim-phone-frame="true"'),
    `${livePanelHtml.length} html chars`,
  )
  step(
    'live phase renders Home + Refresh ICON buttons in the TOP toolbar and green ● Live indicator',
    livePanelHtml.includes('data-sim-panel-toolbar="true"')
      && livePanelHtml.includes('data-sim-toolbar-actions="true"')
      && livePanelHtml.includes('data-sim-toolbar-action="home"')
      && livePanelHtml.includes('aria-label="Home"')
      && livePanelHtml.includes('data-sim-toolbar-action="refresh"')
      && livePanelHtml.includes('aria-label="Refresh"')
      && livePanelHtml.includes('<svg')
      && livePanelHtml.includes('data-sim-live-indicator="live"')
      && livePanelHtml.includes('#22c55e')
      && livePanelHtml.includes('>Live<'),
    'green dot + Live when the ws is open; Home/Refresh moved up from the frame',
  )
  step(
    'the live frame body itself is now button-free (toolbar lives in the panel chrome)',
    !renderToString(liveFrameElement).includes('<button'),
    'no Home/Refresh duplicates inside the phone screen',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Pure panel body — fallback phase (explicit session snapshot)
  // ═══════════════════════════════════════════════════════════════════════════
  const fallbackSession = {
    ...liveSession,
    phase: 'fallback',
    streamUrl: undefined,
    failure: 'grant endpoint returned HTTP 409',
  }
  const fallbackPanelHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'light',
    locale: 'en',
    onClose: noop,
    children: React.createElement(client.SimLiveFrameBody, {
      meta: BOOT_META,
      colorScheme: 'light',
      locale: 'en',
      variant: 'panel',
      session: fallbackSession,
    }),
  }))
  step(
    'fallback phase renders the retry surface (idle-stopped stream case)',
    fallbackPanelHtml.includes('data-sim-frame-state="fallback"')
      && fallbackPanelHtml.includes('role="alert"')
      && fallbackPanelHtml.includes('stream not available')
      && fallbackPanelHtml.includes('grant endpoint returned HTTP 409')
      && fallbackPanelHtml.includes('>Retry<'),
    `${fallbackPanelHtml.length} html chars`,
  )
  step(
    'fallback phase keeps the indicator gray (Offline)',
    fallbackPanelHtml.includes('data-sim-live-indicator="offline"') && fallbackPanelHtml.includes('Offline'),
    'gray dot while no ws is open',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Pure screenshot-frame body — live + fallback phases
  // ═══════════════════════════════════════════════════════════════════════════
  const shotLiveHtml = renderToString(React.createElement(client.SimScreenshotFrameBody, {
    meta: SCREENSHOT_META,
    locale: 'en',
    phase: 'live',
    screenshotUrl: '/_dsh/dsh-ios/screenshots/mock.png',
    failure: '',
    refresh: noop,
    imgRef: fakeImgRef,
  }))
  step(
    'screenshot live phase renders the static PNG inside the frame',
    shotLiveHtml.includes('src="/_dsh/dsh-ios/screenshots/mock.png"')
      && shotLiveHtml.includes('data-sim-frame-state="live"'),
    `${shotLiveHtml.length} html chars`,
  )
  const shotFallbackHtml = renderToString(React.createElement(client.SimScreenshotFrameBody, {
    meta: SCREENSHOT_META,
    locale: 'en',
    phase: 'fallback',
    screenshotUrl: undefined,
    failure: 'grant endpoint returned HTTP 404',
    refresh: noop,
    imgRef: fakeImgRef,
  }))
  step(
    'screenshot fallback phase renders alert + retry',
    shotFallbackHtml.includes('role="alert"')
      && shotFallbackHtml.includes('screenshot not available')
      && shotFallbackHtml.includes('>Retry<'),
    `${shotFallbackHtml.length} html chars`,
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Locale + theme awareness
  // ═══════════════════════════════════════════════════════════════════════════
  const zhPanelHtml = renderPanel({
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', BOOT_META),
    fetcher: throwingFetcher,
    locale: 'zh',
    colorScheme: 'light',
  })
  step(
    'panel copy follows the locale (zh)',
    zhPanelHtml.includes('iOS 模拟器')
      && zhPanelHtml.includes('正在连接实时画面')
      && zhPanelHtml.includes('离线')
      && zhPanelHtml.includes('data-sim-color-scheme="light"'),
    `${zhPanelHtml.length} html chars`,
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Future details-seat renderer (no onClose — the native column owns it)
  // ═══════════════════════════════════════════════════════════════════════════
  const detailsHtml = renderToString(React.createElement(client.SimulatorDetailsPanel, {
    block: settledBlock('ios_sim_boot', BOOT_META),
    cwd: '/workspace',
    sessionId: 'session-smoke',
    colorScheme: 'dark',
    locale: 'en',
  }))
  step(
    'details-seat renderer draws the panel body without its own close button',
    detailsHtml.includes('data-sim-panel="true"')
      && detailsHtml.includes('data-sim-mode="stream"')
      && detailsHtml.includes('iOS Simulator')
      && !detailsHtml.includes('data-sim-panel-close="true"'),
    `${detailsHtml.length} html chars`,
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Panel store, dock lease, source registry, click routing (pure, no DOM)
  // ═══════════════════════════════════════════════════════════════════════════
  const store = client.createSimulatorPanelStore()
  const request = { sessionId: 's1', callId: 'c1', toolName: 'ios_sim_boot', block: settledBlock('ios_sim_boot', BOOT_META) }
  store.open(request)
  step(
    'panel store open exposes the request snapshot',
    store.getSnapshot() === request,
    'getSnapshot returns the open request',
  )
  const replacement = { ...request, toolName: 'ios_sim_interact' }
  store.open(replacement)
  step(
    'panel store open replaces the current request',
    store.getSnapshot() === replacement
      && client.simulatorPanelRequestKey(replacement) !== client.simulatorPanelRequestKey(request),
    'new request wins',
  )
  store.close()
  step(
    'panel store close clears the snapshot',
    store.getSnapshot() === undefined,
    'panel closed',
  )

  const fakeRoot = { style: { marginRight: '', minWidth: '' }, dataset: {} }
  const lease = client.claimSimulatorPanelDock(fakeRoot, 'owner-a', 380, 0)
  step(
    'dock lease claims the root margin and min-width',
    lease !== undefined
      && fakeRoot.style.marginRight === '380px'
      && fakeRoot.style.minWidth === '0'
      && fakeRoot.dataset[client.IOS_SIM_PANEL_DOCK_ATTRIBUTE] === 'owner-a',
    'margin-right 380px reserved',
  )
  lease.update(412)
  step(
    'dock lease update resizes the reserved margin',
    fakeRoot.style.marginRight === '412px',
    'margin-right 412px',
  )
  lease.update(960)
  step(
    'dock lease update follows the widened panel bounds (960px reserve)',
    fakeRoot.style.marginRight === '960px',
    'margin-right 960px — the relaxed MAX flows through the lease unchanged',
  )
  const conflicting = client.claimSimulatorPanelDock(fakeRoot, 'owner-b', 500, 380)
  step(
    'dock claim fails while another owner holds the margin',
    conflicting === undefined && fakeRoot.style.marginRight === '960px',
    'second owner rejected',
  )
  lease.release()
  step(
    'dock lease release restores the root styles',
    fakeRoot.style.marginRight === ''
      && fakeRoot.style.minWidth === ''
      && fakeRoot.dataset[client.IOS_SIM_PANEL_DOCK_ATTRIBUTE] === undefined,
    'exact previous values restored',
  )

  const source = { sessionId: 's1', callId: 'c2', toolName: 'ios_sim_boot', block: settledBlock('ios_sim_boot', BOOT_META) }
  const unregister = client.registerSimPanelSource(source)
  step(
    'source registry resolves a registered card result',
    client.resolveSimPanelSource('c2') === source,
    'round-trip by callId',
  )
  unregister()
  step(
    'source registry unregisters on disposal',
    client.resolveSimPanelSource('c2') === undefined,
    'entry removed',
  )

  const fakeRow = { dataset: { chatCallId: 'c2' } }
  const rowTarget = { closest: selector => selector === '[data-chat-call-id]' ? fakeRow : null }
  step(
    'click routing finds the tool-row call id',
    client.simPanelClickRowCallIdOf(rowTarget) === 'c2',
    'closest([data-chat-call-id]) → dataset.chatCallId',
  )
  const interactiveTarget = { closest: selector => selector === client.SIM_PANEL_INTERACTIVE_SELECTOR ? fakeRow : null }
  step(
    'clicks on interactive elements never open the panel',
    client.simPanelClickIsInteractive(interactiveTarget) === true,
    'button/link/frame/panel clicks blocked',
  )
  const liveFrameTarget = { closest: selector => selector.includes('[data-sim-live-frame][data-sim-frame-state="live"]') ? fakeRow : null }
  step(
    'taps on the card\u2019s live stream are interaction, not panel-open',
    client.simPanelClickIsInteractive(liveFrameTarget) === true,
    'live-phase frame blocks the row-click trigger',
  )
  const grantingTarget = { closest: selector => selector === '[data-chat-call-id]' ? fakeRow : null }
  step(
    'clicks on a granting/fallback frame body still open the panel',
    client.simPanelClickIsInteractive(grantingTarget) === false
      && client.simPanelClickRowCallIdOf(grantingTarget) === 'c2',
    'non-live frame phases route to the call row',
  )
  step(
    'trigger installer is exported for the browser host',
    typeof client.installSimPanelRowTrigger === 'function'
      && typeof client.mountSimulatorPanelHost === 'function'
      && typeof client.useSimPanelSource === 'function',
    'apply wires these behind a document guard',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Status capsule (conversation.input.dock): session gate + render matrix
  // ═══════════════════════════════════════════════════════════════════════════
  const capsuleRunningStatus = { running: true, device: 'CAPSULE-UDID', deviceName: 'iPhone 17 Pro' }
  const capsuleIdleStatus = { running: false }

  const capsuleLiveHtml = renderToString(React.createElement(client.SimStatusCapsuleBody, {
    status: capsuleRunningStatus,
    panelOpen: false,
    hasSimSources: true,
    locale: 'zh',
    onOpen: noop,
  }))
  step(
    'capsule renders the pill while running + panel closed + session has sources (zh)',
    capsuleLiveHtml.includes('data-sim-status-capsule="live"')
      && capsuleLiveHtml.includes('data-sim-status-device="CAPSULE-UDID"')
      && capsuleLiveHtml.includes('iPhone 17 Pro')
      && capsuleLiveHtml.includes('实时')
      && capsuleLiveHtml.includes('aria-label="打开模拟器面板"'),
    `${capsuleLiveHtml.length} html chars`,
  )
  step(
    'capsule renders nothing in a session with NO sources (running + closed)',
    renderToString(React.createElement(client.SimStatusCapsuleBody, {
      status: capsuleRunningStatus,
      panelOpen: false,
      hasSimSources: false,
      locale: 'zh',
      onOpen: noop,
    })) === '',
    'new empty session → no capsule even though the global stream runs',
  )
  step(
    'capsule renders nothing while the panel is open',
    renderToString(React.createElement(client.SimStatusCapsuleBody, {
      status: capsuleRunningStatus,
      panelOpen: true,
      hasSimSources: true,
      locale: 'zh',
      onOpen: noop,
    })) === '',
    'panel open → null',
  )
  step(
    'capsule renders nothing while the stream is not running',
    renderToString(React.createElement(client.SimStatusCapsuleBody, {
      status: capsuleIdleStatus,
      panelOpen: false,
      hasSimSources: true,
      locale: 'zh',
      onOpen: noop,
    })) === ''
      && renderToString(React.createElement(client.SimStatusCapsuleBody, {
        status: undefined,
        panelOpen: false,
        hasSimSources: true,
        locale: 'zh',
        onOpen: noop,
      })) === '',
    'idle/unknown status → null',
  )

  // Registry-driven session gate: sources carry their card's sessionId; the
  // gate counts only sources belonging to the CURRENT session, and cards
  // unregister on unmount (session switch).
  const gateSource = { sessionId: 'session-capsule', callId: 'c-gate', toolName: 'ios_sim_boot', block: settledBlock('ios_sim_boot', BOOT_META) }
  step(
    'session gate is closed before any source registers',
    client.hasSimPanelSourceForSession('session-capsule') === false
      && client.hasSimPanelSourceForSession('session-other') === false
      && client.hasSimPanelSourceForSession('') === false,
    'empty registry / empty session id → no capsule context',
  )
  const unregisterGateSource = client.registerSimPanelSource(gateSource)
  step(
    'sources in the current session open the gate (unrelated sessions stay closed)',
    client.hasSimPanelSourceForSession('session-capsule') === true
      && client.hasSimPanelSourceForSession('session-other') === false,
    'sessionId tagging at registration gates per session',
  )
  unregisterGateSource()
  step(
    'sources unregister on card unmount → gate closes again (session switch)',
    client.hasSimPanelSourceForSession('session-capsule') === false,
    'switching to an unrelated session hides the capsule',
  )

  // Click wiring: the pill's onClick opens the WP8 panel store with a
  // synthetic sim-stream source for the streamed device, tagged with the
  // session the capsule was clicked in.
  const capsuleStore = client.createSimulatorPanelStore()
  const capsuleTree = client.SimStatusCapsuleBody({
    status: capsuleRunningStatus,
    panelOpen: false,
    hasSimSources: true,
    locale: 'en',
    onOpen: () => { capsuleStore.open(client.simStreamStatusRequestOf(capsuleRunningStatus, 'session-capsule')) },
  })
  const pillButton = capsuleTree !== null ? capsuleTree.props.children : null
  step(
    'capsule pill carries an onClick handler',
    pillButton !== null && pillButton.type === 'button' && typeof pillButton.props.onClick === 'function',
    'pure body wires onOpen onto the pill button',
  )
  pillButton.props.onClick()
  const openedRequest = capsuleStore.getSnapshot()
  step(
    'capsule click opens the WP8 store with the streamed device + session',
    openedRequest !== undefined
      && openedRequest.toolName === 'ios_sim_boot'
      && openedRequest.sessionId === 'session-capsule'
      && openedRequest.block.kind === 'tool-result'
      && openedRequest.block.meta.kind === 'sim-stream'
      && openedRequest.block.meta.device.udid === 'CAPSULE-UDID'
      && openedRequest.block.meta.device.name === 'iPhone 17 Pro',
    `panel open via store: ${openedRequest?.callId ?? '(none)'}`,
  )
  const capsulePanelHtml = renderPanel({
    toolName: openedRequest.toolName,
    block: openedRequest.block,
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  step(
    'the capsule-built source drives the panel stream mode',
    capsulePanelHtml.includes('data-sim-mode="stream"')
      && capsulePanelHtml.includes('data-sim-live-frame="panel"')
      && capsulePanelHtml.includes('iPhone 17 Pro')
      && capsulePanelHtml.includes('iOS Simulator'),
    'the panel grant flow takes over from the synthetic sim-stream block',
  )

  // Connected capsule: no fetch during render; status undefined → null.
  const connectedCapsuleHtml = renderToString(React.createElement(client.SimStatusCapsule, {
    store: capsuleStore,
    fetchStatus: () => { throw new Error('a capsule attempted a network request during server rendering') },
    locale: 'en',
  }))
  step(
    'connected capsule SSR renders null and performs no network',
    connectedCapsuleHtml === ''
      && typeof client.SimStatusCapsule === 'function'
      && client.SIM_STATUS_POLL_MS === 5000,
    'polling lives in effects, never in render',
  )

  // The poll loop, driven with a fake clock: the fetcher is never called
  // while the capsule is gated off (no sources in the current session), an
  // enabling gate starts an immediate poll, and registry refreshes debounce.
  const pollCalls = []
  let lastPollStatus
  const pollTimers = {
    intervals: [],
    timeouts: [],
    setInterval(fn, ms) { const handle = { kind: 'interval', fn, ms, cleared: false }; this.intervals.push(handle); return handle },
    clearInterval(handle) { handle.cleared = true },
    setTimeout(fn, ms) { const handle = { kind: 'timeout', fn, ms, cleared: false }; this.timeouts.push(handle); return handle },
    clearTimeout(handle) { handle.cleared = true },
  }
  const flushPollMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0))
  const poller = client.createSimStatusPoller({
    fetchStatus: async () => {
      pollCalls.push('fetch')
      return { running: true, device: 'POLL-UDID' }
    },
    pollIntervalMs: 5000,
    onStatus: status => { lastPollStatus = status },
    timers: pollTimers,
  })
  poller.refreshSoon()
  step(
    'status poll never starts while the session has no sources (gate off)',
    pollCalls.length === 0
      && pollTimers.intervals.length === 0
      && pollTimers.timeouts.length === 0,
    'disabled poller schedules nothing and fetches nothing',
  )
  poller.setEnabled(true)
  await flushPollMicrotasks()
  step(
    'gating on (sources landed) starts an immediate poll',
    pollCalls.length === 1
      && pollTimers.intervals.length === 1
      && lastPollStatus !== undefined
      && lastPollStatus.device === 'POLL-UDID',
    `fetcher calls=${pollCalls.length}`,
  )
  poller.setEnabled(false)
  poller.setEnabled(true)
  await flushPollMicrotasks()
  step(
    're-gating polls again (panel open/close or session switch)',
    pollCalls.length === 2
      && pollTimers.intervals.filter(handle => !handle.cleared).length === 1,
    `fetcher calls=${pollCalls.length}`,
  )
  poller.refreshSoon()
  poller.refreshSoon()
  step(
    'registry refreshes debounce to one scheduled poll',
    pollTimers.timeouts.filter(handle => !handle.cleared).length === 1,
    `scheduled timeouts=${pollTimers.timeouts.filter(handle => !handle.cleared).length}`,
  )
  poller.dispose()
  step(
    'poller disposal clears the interval and the debounce',
    pollTimers.intervals.every(handle => handle.cleared)
      && pollTimers.timeouts.every(handle => handle.cleared),
    'no timers survive the capsule unmount',
  )

  // Status fetcher contract: POST {} (or {device}) to the status route.
  const capturedStatusCalls = []
  const statusFetcherStub = async (input, init) => {
    capturedStatusCalls.push({ input, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, running: true, device: 'S-UDID', deviceName: 'iPhone 17 Pro' }),
    }
  }
  const statusSnapshot = await client.requestSimStatus(statusFetcherStub, {})
  step(
    'status request POSTs {} to the status route and parses the snapshot',
    capturedStatusCalls.length === 1
      && capturedStatusCalls[0].input === '/_dsh/dsh-ios/status'
      && capturedStatusCalls[0].init.method === 'POST'
      && capturedStatusCalls[0].init.credentials === 'same-origin'
      && JSON.stringify(JSON.parse(capturedStatusCalls[0].init.body)) === '{}'
      && statusSnapshot.running === true
      && statusSnapshot.device === 'S-UDID'
      && statusSnapshot.deviceName === 'iPhone 17 Pro',
    JSON.stringify(statusSnapshot),
  )
  const statusFiltered = await client.requestSimStatus(statusFetcherStub, { device: 'S-UDID' })
  step(
    'status request supports the {device} filter',
    JSON.parse(capturedStatusCalls[1].init.body).device === 'S-UDID' && statusFiltered.running === true,
    JSON.stringify(JSON.parse(capturedStatusCalls[1].init.body)),
  )
  const failedStatus = await client.requestSimStatus(async () => {
    throw new Error('status endpoint offline')
  }, {})
  step(
    'status request failure degrades to running:false',
    failedStatus.running === false && failedStatus.device === undefined,
    JSON.stringify(failedStatus),
  )

  // Source-registry subscription (the capsule's immediate refresh trigger).
  let sourceEvents = 0
  const unsubscribeSources = client.subscribeSimPanelSources(() => { sourceEvents += 1 })
  const capsuleSource = { sessionId: 's1', callId: 'c-capsule', toolName: 'ios_sim_boot', block: settledBlock('ios_sim_boot', BOOT_META) }
  const unregisterCapsuleSource = client.registerSimPanelSource(capsuleSource)
  step(
    'source registry notifies subscribers when a tool result lands',
    sourceEvents >= 1,
    `events=${sourceEvents}`,
  )
  unregisterCapsuleSource()
  step(
    'source unregistration notifies subscribers too',
    sourceEvents >= 2,
    `events=${sourceEvents}`,
  )
  unsubscribeSources()
  step(
    'subscription disposal stops notifications',
    (() => {
      const before = sourceEvents
      client.registerSimPanelSource(capsuleSource)()
      return sourceEvents === before
    })(),
    'listener removed',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Theme contract: panel chrome follows dsh-openpencil's `--dsw-alias-*`
  // tokens in BOTH light and dark schemes (no literal dark surrounds outside
  // the device bezel). Asserted on the exported style objects AND on the
  // stubbed SSR output.
  // ═══════════════════════════════════════════════════════════════════════════
  const LITERAL_COLOR_ALLOWLIST = new Set([
    '#0b0b0e',                 // phone bezel (the allowed device surface)
    '#000',                    // phone screen (device display)
    'rgba(255,255,255,0.08)',  // bezel edge highlight
    'rgba(255,255,255,0.06)',  // screen edge highlight
    'rgba(0,0,0,0.5)',         // bezel drop shadow
    '#22c55e',                 // live dot (state color — dot stays green/gray)
    '#9ca3af',                 // offline dot
    'rgba(34,197,94,0.8)',     // live dot glow
  ])
  function literalColorOffenders(style) {
    const offenders = []
    if (style === undefined || style === null) return offenders
    for (const [key, value] of Object.entries(style)) {
      if (typeof value !== 'string') continue
      const text = value.replace(/\s+/g, ' ').trim()
      if (LITERAL_COLOR_ALLOWLIST.has(text)) continue
      if (/#[0-9a-fA-F]{3,8}\b/.test(text) || /\brgba?\(/.test(text)) {
        offenders.push(`${key}: ${value}`)
      }
    }
    return offenders
  }
  function styleUsesToken(style, token) {
    if (style === undefined || style === null) return false
    return Object.values(style).some(value => typeof value === 'string' && value.includes(token))
  }
  const panelChromeOffenders = [
    ...literalColorOffenders(client.PANEL_STYLES.root),
    ...literalColorOffenders(client.PANEL_STYLES.header),
    ...literalColorOffenders(client.PANEL_STYLES.title),
    ...literalColorOffenders(client.PANEL_STYLES.subtitle),
    ...literalColorOffenders(client.PANEL_STYLES.closeButton),
    ...literalColorOffenders(client.PANEL_STYLES.sizeSelect),
    ...literalColorOffenders(client.PANEL_STYLES.frameStyleControl),
    ...literalColorOffenders(client.PANEL_STYLES.frameStyleButton),
    ...literalColorOffenders(client.PANEL_STYLES.frameStyleButtonActive),
    ...literalColorOffenders(client.PANEL_STYLES.stage),
    ...literalColorOffenders(client.PANEL_STYLES.toolbar),
    ...literalColorOffenders(client.PANEL_STYLES.toolbarDivider),
    ...literalColorOffenders(client.PANEL_STYLES.captureToast),
    ...literalColorOffenders(client.PANEL_LIVE_INDICATOR_STYLES),
    ...literalColorOffenders(client.SIM_TOOLBAR_STYLES.actionPill),
    ...literalColorOffenders(client.SIM_TOOLBAR_STYLES.iconButton),
    ...literalColorOffenders(client.SIM_TOOLBAR_STYLES.iconButtonHover),
    ...literalColorOffenders(client.SIM_TOOLBAR_STYLES.tooltip),
    ...literalColorOffenders(client.SIM_TOOLBAR_STYLES.sizeQuickGroup),
    ...literalColorOffenders(client.SIM_TOOLBAR_STYLES.sizeQuickSegment),
    ...literalColorOffenders(client.SIM_TOOLBAR_STYLES.sizeQuickSegmentHover),
    ...literalColorOffenders(client.SIM_TOOLBAR_STYLES.sizeQuickSegmentActive),
  ]
  step(
    'panel chrome style objects carry NO literal colors (token-only, bezel excepted)',
    panelChromeOffenders.length === 0
      && styleUsesToken(client.PANEL_STYLES.root, 'var(--dsw-alias-bg-base)')
      && styleUsesToken(client.PANEL_STYLES.root, 'var(--dsw-alias-label-primary)')
      && styleUsesToken(client.PANEL_STYLES.header, 'var(--dsw-alias-border-l2)')
      && styleUsesToken(client.PANEL_STYLES.subtitle, 'var(--dsw-alias-label-secondary)')
      && styleUsesToken(client.PANEL_STYLES.toolbar, 'var(--dsw-alias-border-l2)')
      && styleUsesToken(client.PANEL_STYLES.toolbarDivider, 'var(--dsw-alias-border-l2)')
      && styleUsesToken(client.PANEL_STYLES.captureToast, 'var(--dsw-alias-label-secondary)')
      && styleUsesToken(client.PANEL_STYLES.frameStyleControl, 'var(--dsw-alias-border-l2)')
      && styleUsesToken(client.PANEL_STYLES.frameStyleButton, 'var(--dsw-alias-label-secondary)')
      && styleUsesToken(client.PANEL_STYLES.frameStyleButtonActive, 'var(--dsw-alias-bg-layer-1)')
      && styleUsesToken(client.PANEL_LIVE_INDICATOR_STYLES, 'var(--dsw-alias-label-secondary)')
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.actionPill, 'var(--dsw-alias-bg-layer-1)')
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.actionPill, 'var(--dsw-alias-border-l2)')
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.iconButton, 'var(--dsw-alias-label-secondary)')
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.iconButtonHover, 'var(--dsw-alias-interactive-bg-hover)')
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.tooltip, 'var(--dsw-alias-tooltip-bg)')
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.sizeQuickGroup, 'var(--dsw-alias-bg-layer-1)')
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.sizeQuickGroup, 'var(--dsw-alias-border-l2)')
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.sizeQuickSegmentActive, 'var(--dsw-alias-interactive-bg-active)'),
    panelChromeOffenders.length === 0
      ? 'same tokens dsh-openpencil editor-panel.tsx uses'
      : `offenders: ${panelChromeOffenders.join(' | ')}`,
  )
  step(
    'phone bezel keeps its literal dark device frame (the allowed exception)',
    client.PHONE_BEZEL_STYLES.background === '#0b0b0e'
      && client.PHONE_BEZEL_STYLES.padding === 6
      && !Object.prototype.hasOwnProperty.call(client.PHONE_BEZEL_STYLES, 'borderRadius')
      && client.simPanelShellRadiusOf('bezel', 55) === 61,
    'bezel stays a device bezel in both themes; slim 6px rim, outer radius = screen radius + 6',
  )

  const themePanelHtmlLight = renderPanel({
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', BOOT_META),
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'light',
  })
  const themePanelHtmlDark = renderPanel({
    toolName: 'ios_sim_boot',
    block: settledBlock('ios_sim_boot', BOOT_META),
    fetcher: throwingFetcher,
    locale: 'en',
    colorScheme: 'dark',
  })
  const headerTagOf = html => html.match(/<div[^>]*data-sim-panel-header="true"[^>]*>/)?.[0] ?? ''
  const statusTagOf = html => html.match(/<div[^>]*data-sim-live-indicator="(?:live|offline)"[^>]*>/)?.[0] ?? ''
  const styleAttrOf = tag => tag.match(/style="([^"]*)"/)?.[1] ?? ''
  const rootTagOf = html => html.match(/<section[^>]*data-sim-panel="true"[^>]*>/)?.[0] ?? ''
  const darkSurroundLeak = html => /#17171a|#16161a|#0e0e11|#1a1a1d/.test(html)
  step(
    'light-theme SSR: header/status reference the DSH tokens, no dark surround',
    themePanelHtmlLight.includes('data-sim-color-scheme="light"')
      && styleAttrOf(rootTagOf(themePanelHtmlLight)).includes('--dsw-alias-bg-base')
      && styleAttrOf(headerTagOf(themePanelHtmlLight)).includes('--dsw-alias-border-l2')
      && styleAttrOf(statusTagOf(themePanelHtmlLight)).includes('--dsw-alias-label-secondary')
      && !darkSurroundLeak(headerTagOf(themePanelHtmlLight))
      && !darkSurroundLeak(statusTagOf(themePanelHtmlLight)),
    'token vars resolve per theme; no literal dark surrounds in header/status',
  )
  step(
    'dark-theme SSR: header/status reference the same DSH tokens',
    themePanelHtmlDark.includes('data-sim-color-scheme="dark"')
      && styleAttrOf(rootTagOf(themePanelHtmlDark)).includes('--dsw-alias-bg-base')
      && styleAttrOf(headerTagOf(themePanelHtmlDark)).includes('--dsw-alias-border-l2')
      && styleAttrOf(statusTagOf(themePanelHtmlDark)).includes('--dsw-alias-label-secondary')
      && !darkSurroundLeak(headerTagOf(themePanelHtmlDark))
      && !darkSurroundLeak(statusTagOf(themePanelHtmlDark)),
    'one token set serves both schemes (theme change is a host CSS-variable flip)',
  )
  step(
    'status line keeps only the dot in literal state colors',
    themePanelHtmlLight.includes('#9ca3af')
      && (styleAttrOf(statusTagOf(themePanelHtmlLight)).includes('#9ca3af') === false),
    'dot green/gray; the “● 实时 / 离线” text color comes from the theme token',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Size modes: store transitions, pure style computation, dropdown SSR
  // ═══════════════════════════════════════════════════════════════════════════
  const sizeStore = client.createSimulatorPanelStore()
  step(
    'panel store size mode defaults to fit',
    sizeStore.getSizeMode() === client.SIM_PANEL_SIZE_MODE_FIT
      && sizeStore.getSizeMode().kind === 'fit',
    '{kind:"fit"} out of the box',
  )
  sizeStore.setSizeMode({ kind: 'percent', value: 75 })
  step(
    'store transition fit → percent 75',
    sizeStore.getSizeMode().kind === 'percent' && sizeStore.getSizeMode().value === 75,
    'setSizeMode emits the new snapshot',
  )
  sizeStore.setSizeMode({ kind: 'preset', width: 320 })
  step(
    'store transition percent → preset M (320px)',
    sizeStore.getSizeMode().kind === 'preset' && sizeStore.getSizeMode().width === 320,
    'quick fixed widths selectable',
  )
  sizeStore.open({ sessionId: 's-size', callId: 'c-size', toolName: 'ios_sim_boot', block: settledBlock('ios_sim_boot', BOOT_META) })
  sizeStore.close()
  step(
    'size mode persists in-memory per panel host across open/close',
    sizeStore.getSizeMode().kind === 'preset' && sizeStore.getSizeMode().width === 320,
    'host-lifetime persistence (not reset by close)',
  )

  step(
    'fit mode: frame width is 100% (panel drag-resize scales the simulator)',
    client.simPanelFrameWidthOf({ kind: 'fit' }, undefined) === '100%'
      && client.simPanelFrameWidthOf({ kind: 'fit' }, 1170) === '100%',
    'fit ignores the natural size by design',
  )
  step(
    'percent basis: natural px / 3 = logical points (390 fallback while unknown)',
    client.simDeviceLogicalWidthOf(1170) === 390
      && client.simDeviceLogicalWidthOf(undefined) === 390
      && client.simDeviceLogicalWidthOf(0) === 390,
    'naturalWidth/3; unknown → 390pt',
  )
  step(
    'percent widths scale the logical point size',
    client.simPanelFrameWidthOf({ kind: 'percent', value: 100 }, 1170) === '390px'
      && client.simPanelFrameWidthOf({ kind: 'percent', value: 50 }, 1170) === '195px'
      && client.simPanelFrameWidthOf({ kind: 'percent', value: 125 }, 1170) === '488px'
      && client.simPanelFrameWidthOf({ kind: 'percent', value: 75 }, undefined) === '293px',
    '50% / 75% / 100% / 125% of 390pt',
  )
  step(
    'preset widths are the quick fixed sizes',
    client.simPanelFrameWidthOf({ kind: 'preset', width: 240 }, undefined) === '240px'
      && client.simPanelFrameWidthOf({ kind: 'preset', width: 320 }, undefined) === '320px'
      && client.simPanelFrameWidthOf({ kind: 'preset', width: 420 }, undefined) === '420px',
    'S 240 / M 320 / L 420',
  )
  step(
    'size-mode ids round-trip through the dropdown values',
    client.simPanelSizeModeIdOf(client.SIM_PANEL_SIZE_MODE_FIT) === 'fit'
      && client.simPanelSizeModeIdOf({ kind: 'percent', value: 50 }) === 'percent-50'
      && client.simPanelSizeModeIdOf({ kind: 'preset', width: 320 }) === 'preset-M'
      && client.simPanelSizeModeOf('percent-75').value === 75
      && client.simPanelSizeModeOf('preset-L').width === 420
      && client.simPanelSizeModeOf('garbage').kind === 'fit',
    'unknown ids fall back to fit',
  )

  const presetBodyHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    sizeMode: { kind: 'preset', width: 240 },
    children: null,
  }))
  step(
    'preset size mode sizes the phone frame to the fixed width',
    presetBodyHtml.includes('data-sim-phone-width="240px"')
      && presetBodyHtml.includes('data-sim-panel-size-mode="true"')
      && presetBodyHtml.includes('>Fit to width<')
      && presetBodyHtml.includes('>S · 240px<'),
    'S preset rendered + dropdown with the full roster',
  )
  const percentBodyHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'light',
    locale: 'zh',
    onClose: noop,
    sizeMode: { kind: 'percent', value: 100 },
    naturalWidth: 1170,
    children: null,
  }))
  step(
    'percent size mode uses the reported natural width (zh copy)',
    percentBodyHtml.includes('data-sim-phone-width="390px"')
      && percentBodyHtml.includes('>适应宽度<')
      && percentBodyHtml.includes('>M（320px）<'),
    '100% of 1170px/3 = 390px; zh labels in the dropdown',
  )
  const fitBodyHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    children: null,
  }))
  step(
    'fit is the default size mode (no sizeMode prop → 100% frame)',
    fitBodyHtml.includes('data-sim-phone-width="100%"')
      && fitBodyHtml.includes('data-sim-panel-size-mode="true"'),
    'DEFAULT: simulator scales to the panel content width',
  )

  // ── Sub-pixel symmetry: integer width snapping + fill stream img ───────
  step(
    'simPanelSnapPxOf snaps measured widths to whole CSS px (fractional → integer frame width)',
    client.simPanelSnapPxOf(336.4) === 336
      && client.simPanelSnapPxOf(336.6) === 337
      && client.simPanelSnapPxOf(347.5) === 348
      && client.simPanelSnapPxOf(390) === 390
      && client.simPanelSnapPxOf(0) === 0
      && client.simPanelSnapPxOf(-12) === 0
      && client.simPanelSnapPxOf(Number.NaN) === 0,
    'fractional ResizeObserver/rect measurements round BEFORE radius/box math so both rims rasterize symmetrically',
  )
  step(
    'fit frame style applies the snapped measured width once the DOM reports one',
    client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'bezel', 55).width === '100%'
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'bezel', 55, 347).width === '347px'
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'none', 55, 0).width === '100%'
      && client.simPanelFrameStyles({ kind: 'percent', value: 50 }, 1170, 'bezel', 55, 347).width === '195px'
      && client.simPanelFrameStyles({ kind: 'preset', width: 240 }, undefined, 'bezel', 55, 347).width === '240px',
    'SSR keeps 100%; the measured whole-px width replaces it at runtime; percent/preset ignore the measurement',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Frame styles (无框/边框/真机框): store transitions, per-mode SSR shells,
  // header segmented control (copy + sync both ways), WP19 geometry parity
  // ═══════════════════════════════════════════════════════════════════════════
  const frameStyleFrameTagOf = html => html.match(/<div[^>]*data-sim-phone-frame="true"[^>]*>/)?.[0] ?? ''
  const frameStyleScreenTagOf = html => html.match(/<div[^>]*data-sim-phone-screen="true"[^>]*>/)?.[0] ?? ''
  const frameStyleRotationBoxTagOf = html => html.match(/<div[^>]*data-sim-live-rotation-box="true"[^>]*>/)?.[0] ?? ''

  const frameStore = client.createSimulatorPanelStore()
  step(
    'panel store frame style defaults to the slim bezel',
    frameStore.getFrameStyle() === 'bezel'
      && frameStore.getFrameStyle() === client.SIM_FRAME_STYLE_BEZEL,
    'bezel out of the box (today\u2019s 6px rim)',
  )
  frameStore.setFrameStyle('none')
  step(
    'store transition bezel → none',
    frameStore.getFrameStyle() === 'none',
    'setFrameStyle emits the new snapshot',
  )
  frameStore.setFrameStyle('device')
  frameStore.open({ sessionId: 's-frame', callId: 'c-frame', toolName: 'ios_sim_boot', block: settledBlock('ios_sim_boot', BOOT_META) })
  frameStore.close()
  step(
    'frame style persists in-memory per panel host across open/close',
    frameStore.getFrameStyle() === 'device',
    'host-lifetime persistence (not reset by close), exactly like sizeMode',
  )
  step(
    'frame-style roster + defensive id parse (unknown → bezel)',
    JSON.stringify(client.SIM_FRAME_STYLE_OPTIONS) === JSON.stringify(['none', 'bezel', 'device'])
      && client.simFrameStyleOf('none') === 'none'
      && client.simFrameStyleOf('bezel') === 'bezel'
      && client.simFrameStyleOf('device') === 'device'
      && client.simFrameStyleOf('garbage') === 'bezel',
    '无框 / 边框 / 真机框 order drives the control',
  )
  step(
    'simPanelFrameStyles picks the shell per frame style without touching the width',
    !Object.prototype.hasOwnProperty.call(client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'none', 55), 'borderRadius')
      && !Object.prototype.hasOwnProperty.call(client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'none', 55), 'background')
      && !Object.prototype.hasOwnProperty.call(client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'none', 55), 'border')
      && !Object.prototype.hasOwnProperty.call(client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'none', 55), 'boxShadow')
      && !Object.prototype.hasOwnProperty.call(client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'none', 55), 'overflow')
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'none', 55).padding === 0
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'bezel', 55).padding === 6
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'device', 55).padding === 16
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'bezel', 55).borderRadius === 61
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'device', 55).borderRadius === 71
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'none', 55).width === '100%'
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'bezel', 55).width === '100%'
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'device', 55).width === '100%'
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'device', 55).maxWidth === 'none'
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined).background === '#0b0b0e',
    'one width computation, three shells (2-arg call keeps the bezel default + fallback radius)',
  )

  // ── percent × orientation threading (the live-reproduced size bug) ──────
  // The pure width helpers knew the displayed (rotated) basis all along; the
  // regression was in the component wiring — simPanelFrameStyles received
  // only naturalWidth, so the RENDERED frame width ignored orientation and
  // naturalHeight (portrait-basis 402px / no-dims fallback 390px / stale
  // '100%' instead of the landscape 874px). These steps go through the
  // full SimulatorPanelBody → SimPhoneFrame → simPanelFrameStyles chain and
  // assert the frame's INLINE width (its last `width:` declaration — the
  // base shell keeps its own width:100%, the mode width overrides it).
  const lastWidthDeclOf = style => {
    const widthDecls = style.split(';').map(decl => decl.trim()).filter(decl => decl.startsWith('width:'))
    return widthDecls.length > 0 ? widthDecls[widthDecls.length - 1] : ''
  }
  const panelHtmlOf = ({ orientation, naturalWidth, naturalHeight, sizeMode }) =>
    renderToString(React.createElement(client.SimulatorPanelBody, {
      title: 'iOS Simulator',
      device: BOOT_META.device,
      mode: 'stream',
      liveOpen: false,
      colorScheme: 'dark',
      locale: 'en',
      onClose: noop,
      orientation,
      naturalWidth,
      naturalHeight,
      sizeMode,
      children: null,
    }))
  step(
    'simPanelFrameStyles percent basis follows the threaded orientation + natural dims (pure)',
    client.simPanelFrameStyles({ kind: 'percent', value: 100 }, 1206, 'bezel', 55, undefined, 2622, 'landscape_left').width === '874px'
      && client.simPanelFrameStyles({ kind: 'percent', value: 100 }, 1206, 'bezel', 55, undefined, 2622, 'portrait').width === '402px'
      && client.simPanelFrameStyles({ kind: 'percent', value: 100 }, 1206, 'bezel', 55, 347, 2622, 'landscape_left').width === '874px'
      && client.simPanelFrameStyles({ kind: 'percent', value: 100 }, undefined, 'bezel', 55, undefined, undefined, 'landscape_left').width === '844px'
      && client.simPanelFrameStyles({ kind: 'percent', value: 100 }, undefined, 'bezel', 55, undefined, undefined, 'portrait').width === '390px'
      && client.simPanelFrameStyles({ kind: 'fit' }, undefined, 'bezel', 55, undefined, 2622, 'landscape_left').width === '100%'
      && client.simPanelFrameStyles({ kind: 'preset', width: 240 }, 1206, 'bezel', 55, undefined, 2622, 'landscape_left').width === '522px'
      && client.simPanelFrameStyles({ kind: 'preset', width: 240 }, 1206, 'bezel', 55, undefined, 2622, 'portrait').width === '240px',
    '874px landscape · 402px portrait · no-dims fallback 844/390 · fit unchanged · landscape preset S = 522px (short side × 874/402, snapped) · percent ignores the fit measurement',
  )
  const percentLandscapeHtml = panelHtmlOf({
    orientation: 'landscape_left',
    naturalWidth: 1206,
    naturalHeight: 2622,
    sizeMode: { kind: 'percent', value: 100 },
  })
  step(
    'PANEL component chain: landscape 100% renders an EXPLICIT 874px inline frame width',
    percentLandscapeHtml.includes('data-sim-phone-width="874px"')
      && lastWidthDeclOf(styleAttrOf(frameStyleFrameTagOf(percentLandscapeHtml))) === 'width:874px',
    'naturalHeight/3 = 874px beats the old portrait-basis/fallback width — the orchestrator\u2019s live repro',
  )
  const percentPortraitHtml = panelHtmlOf({
    orientation: 'portrait',
    naturalWidth: 1206,
    naturalHeight: 2622,
    sizeMode: { kind: 'percent', value: 100 },
  })
  step(
    'PANEL component chain: portrait 100% renders an EXPLICIT 402px inline frame width',
    percentPortraitHtml.includes('data-sim-phone-width="402px"')
      && lastWidthDeclOf(styleAttrOf(frameStyleFrameTagOf(percentPortraitHtml))) === 'width:402px',
    'naturalWidth/3 = 402px — natural dims reach the percent branch (NOT the 390 fallback)',
  )
  const fitLandscapeHtml = panelHtmlOf({
    orientation: 'landscape_left',
    naturalWidth: 1206,
    naturalHeight: 2622,
    sizeMode: { kind: 'fit' },
  })
  step(
    'PANEL component chain: fit mode landscape keeps the inline width at 100%',
    fitLandscapeHtml.includes('data-sim-phone-width="100%"')
      && lastWidthDeclOf(styleAttrOf(frameStyleFrameTagOf(fitLandscapeHtml))) === 'width:100%',
    'fit is unchanged — only the percent branch gained the orientation basis',
  )
  const fallbackLandscapeHtml = panelHtmlOf({
    orientation: 'landscape_left',
    sizeMode: { kind: 'percent', value: 100 },
  })
  step(
    'PANEL component chain: no natural dims yet → landscape 100% renders the 844px fallback inline width',
    fallbackLandscapeHtml.includes('data-sim-phone-width="844px"')
      && lastWidthDeclOf(styleAttrOf(frameStyleFrameTagOf(fallbackLandscapeHtml))) === 'width:844px',
    'the 390×844 fallback shape swaps axes for the ±90° orientations',
  )
  const fallbackPortraitHtml = panelHtmlOf({
    orientation: 'portrait',
    sizeMode: { kind: 'percent', value: 100 },
  })
  step(
    'PANEL component chain: no natural dims yet → portrait 100% renders the 390px fallback inline width',
    fallbackPortraitHtml.includes('data-sim-phone-width="390px"')
      && lastWidthDeclOf(styleAttrOf(frameStyleFrameTagOf(fallbackPortraitHtml))) === 'width:390px',
    'the pre-natural-size portrait basis is unchanged',
  )

  // ── percent 50/75/125 explicit widths in BOTH orientations (post-WP26) ──
  // All four zoom steps share the SAME percent branch; assert the rendered
  // INLINE frame width per value × orientation at the component level (the
  // WP26 chain above proved 100%: landscape 874px / portrait 402px for the
  // 1206×2622 device). Landscape basis = natural height / 3 (874pt),
  // portrait basis = natural width / 3 (402pt).
  const percentExpectedWidths = {
    portrait: { 50: 201, 75: 302, 125: 503 },
    landscape_left: { 50: 437, 75: 656, 125: 1093 },
  }
  for (const [orientation, byValue] of Object.entries(percentExpectedWidths)) {
    for (const [value, widthPx] of Object.entries(byValue)) {
      const html = panelHtmlOf({
        orientation,
        naturalWidth: 1206,
        naturalHeight: 2622,
        sizeMode: { kind: 'percent', value: Number(value) },
      })
      step(
        `percent ${value}% ${orientation} renders the explicit ${widthPx}px inline frame width`,
        html.includes(`data-sim-phone-width="${widthPx}px"`)
          && lastWidthDeclOf(styleAttrOf(frameStyleFrameTagOf(html))) === `width:${widthPx}px`,
        `${orientation === 'portrait' ? '402pt' : '874pt'} displayed basis × ${value}%${orientation === 'landscape_left' && value === '50' ? ' — the orchestrator repro width (437px)' : ''}`,
      )
    }
  }

  // ── orientation-aware presets: short-side sizes scale in landscape ───────
  // The preset value is the device's SHORT-side (portrait width) display
  // size; landscape scales it by the displayed width/height ratio (natural
  // dims, 844/390 fallback) so the device keeps its physical size across
  // the rotation — landscape S = 240 × 874/402 ≈ 522px, snapped.
  const presetLandscapeHtml = panelHtmlOf({
    orientation: 'landscape_left',
    naturalWidth: 1206,
    naturalHeight: 2622,
    sizeMode: { kind: 'preset', width: 240 },
  })
  step(
    'PANEL component chain: landscape preset S renders 522px (240 × 874/402, snapped)',
    presetLandscapeHtml.includes('data-sim-phone-width="522px"')
      && lastWidthDeclOf(styleAttrOf(frameStyleFrameTagOf(presetLandscapeHtml))) === 'width:522px',
    'the preset is the SHORT-side size; the frame follows the displayed aspect in landscape',
  )
  const presetPortraitHtml = panelHtmlOf({
    orientation: 'portrait',
    naturalWidth: 1206,
    naturalHeight: 2622,
    sizeMode: { kind: 'preset', width: 240 },
  })
  step(
    'PANEL component chain: portrait preset S keeps the fixed 240px width',
    presetPortraitHtml.includes('data-sim-phone-width="240px"')
      && lastWidthDeclOf(styleAttrOf(frameStyleFrameTagOf(presetPortraitHtml))) === 'width:240px',
    'portrait width = preset; landscape width = preset × displayedW/displayedH',
  )
  const presetLandscapeScreenBox = client.simPanelScreenBoxOf({ kind: 'preset', width: 240 }, 1206, 2622, 'landscape_left', 'bezel')
  const presetPortraitScreenBox = client.simPanelScreenBoxOf({ kind: 'preset', width: 240 }, 1206, 2622, 'portrait', 'bezel')
  step(
    'preset radius follows the actual rendered box in BOTH orientations (min side × 55/390)',
    client.simPanelScreenRadiusOf(presetLandscapeScreenBox.width, presetLandscapeScreenBox.height) === 33
      && presetLandscapeHtml.includes('data-sim-screen-radius="33"')
      && client.simPanelScreenRadiusOf(presetPortraitScreenBox.width, presetPortraitScreenBox.height) === 31.9
      && presetPortraitHtml.includes('data-sim-screen-radius="31.9"'),
    `landscape box ${presetLandscapeScreenBox.width}×${presetLandscapeScreenBox.height.toFixed(1)} → 33 · portrait box ${presetPortraitScreenBox.width}×${presetPortraitScreenBox.height.toFixed(1)} → 31.9 — the short-side min IS the preset, minus the shell inset`,
  )
  step(
    'preset dropdown labels keep the SHORT-side px (S · 240px — unchanged copy)',
    presetLandscapeHtml.includes('>S · 240px<')
      && readFileSync(join(root, 'src', 'client', 'sim-panel-size.ts'), 'utf8').includes('SHORT-side'),
    'the label refers to the device\u2019s short side, not the landscape frame width',
  )

  // ── proportional radius math: pure, no DOM ──────────────────────────────
  step(
    'screen radius is proportional: min(displayedW, displayedH) × 55/390',
    client.SIM_FRAME_SCREEN_RADIUS_RATIO === 55 / 390
      && client.simPanelScreenRadiusOf(390, 844) === 55
      && client.simPanelScreenRadiusOf(240, 240 * 844 / 390) === 33.8
      && client.simPanelScreenRadiusOf(844, 390) === 55
      && client.simPanelScreenRadiusOf(1170, 2532) === 165,
    '390 → 55 · 240 → 33.8 · landscape 844×390 uses the height side → 55',
  )
  step(
    'shell radii stay concentric in every mode: shell = screen + shell pad',
    client.simPanelShellRadiusOf('none', 55) === 55
      && client.simPanelShellRadiusOf('bezel', 55) === 61
      && client.simPanelShellRadiusOf('device', 55) === 71
      && client.simPanelShellPadOf('none') === 0
      && client.simPanelShellPadOf('bezel') === 6
      && client.simPanelShellPadOf('device') === 16
      && client.SIM_FRAME_BEZEL_SHELL === 6
      && client.SIM_FRAME_DEVICE_SHELL === 16
      && client.SIM_FRAME_RADIUS_FALLBACK_PX === 55,
    'frameless +0 · bezel +6 · device +16 — the corners never drift apart',
  )
  step(
    'screen box derivation: percent/preset px modes are exact, fit defers to live measurement',
    JSON.stringify(client.simPanelScreenBoxOf({ kind: 'percent', value: 100 }, 1170, 2532, 'portrait', 'none'))
      === JSON.stringify({ width: 390, height: 390 * 2532 / 1170 })
      && JSON.stringify(client.simPanelScreenBoxOf({ kind: 'preset', width: 240 }, undefined, undefined, 'portrait', 'bezel'))
        === JSON.stringify({ width: 226, height: 226 * 844 / 390 })
      && JSON.stringify(client.simPanelScreenBoxOf({ kind: 'percent', value: 100 }, 1170, 2532, 'landscape_left', 'none'))
        === JSON.stringify({ width: 844, height: 844 * 1170 / 2532 })
      && client.simPanelScreenBoxOf({ kind: 'fit' }, undefined, undefined, 'portrait', 'none') === undefined
      && client.simPanelFrameRadiusFallbackOf('portrait', undefined, undefined) === 55
      && client.simPanelFrameRadiusFallbackOf('landscape_left', undefined, undefined) === 55,
    'fit (100% width) has no SSR width — the ResizeObserver measures it live',
  )

  // ── WP27 rim symmetry: the shell border joins the padding in the rim ──────
  // The bezel/device shells carry a 1px border per side (frameless: none).
  // The screen renders border-box at 100% width, so its rendered box is
  // frame − 2×(padding + border) and each left/right rim measures
  // padding + border. Every derivation goes through `simPanelScreenWidthOf`
  // (single source of truth) — the old padding-only math made the screen
  // 2px wider than the content box and the right rim lost its border px
  // (left 7px, right 5px at the 348px fit frame).
  step(
    'frame-style border metric: none → 0, bezel → 1, device → 1 (one shared constant)',
    client.SIM_FRAME_SHELL_BORDER_PX === 1
      && client.simPanelFrameBorderPxOf('none') === 0
      && client.simPanelFrameBorderPxOf('bezel') === 1
      && client.simPanelFrameBorderPxOf('device') === 1,
    'bezel + device shell borders declare from SIM_FRAME_SHELL_BORDER_PX',
  )
  step(
    'rim per mode = padding + border (none 0 · bezel 7 · device 17)',
    ['none', 'bezel', 'device'].every(style =>
      client.simPanelFrameInsetOf(style) === client.simPanelShellPadOf(style) + client.simPanelFrameBorderPxOf(style))
      && client.simPanelFrameInsetOf('none') === 0
      && client.simPanelFrameInsetOf('bezel') === 7
      && client.simPanelFrameInsetOf('device') === 17,
    'rim left == rim right == pad+border for all three frame modes',
  )
  step(
    'screen width derivation subtracts 2×(pad+border) in every mode (the WP27 fix)',
    client.simPanelScreenWidthOf(348, 'none') === 348
      && client.simPanelScreenWidthOf(348, 'bezel') === 334
      && client.simPanelScreenWidthOf(348, 'device') === 314
      && client.simPanelScreenWidthOf(348.4, 'bezel') === 334
      && client.simPanelScreenWidthOf(348.6, 'bezel') === 335,
    '348 frame: frameless 348 · bezel 334 (6+1 rims) · device 314 (16+1 rims); the frame width snaps to the integer grid first',
  )
  step(
    'percent/preset screen boxes use the same border-aware derivation',
    JSON.stringify(client.simPanelScreenBoxOf({ kind: 'percent', value: 100 }, 1170, 2532, 'portrait', 'bezel'))
      === JSON.stringify({ width: 376, height: 376 * 2532 / 1170 })
      && JSON.stringify(client.simPanelScreenBoxOf({ kind: 'preset', width: 240 }, undefined, undefined, 'portrait', 'device'))
        === JSON.stringify({ width: 206, height: 206 * 844 / 390 })
      && JSON.stringify(client.simPanelScreenBoxOf({ kind: 'percent', value: 100 }, 1170, 2532, 'landscape_left', 'bezel'))
        === JSON.stringify({ width: 830, height: 830 * 1170 / 2532 }),
    'bezel percent 390 − 14 = 376 · device preset 240 − 34 = 206 · bezel landscape 844 − 14 = 830',
  )
  step(
    'the CSS shells declare pad/border from the frame-style metrics (single source of truth)',
    client.PHONE_BEZEL_STYLES.padding === client.simPanelShellPadOf('bezel')
      && client.DEVICE_FRAME_STYLES.padding === client.simPanelShellPadOf('device')
      && client.PHONE_BEZEL_STYLES.border === `${client.SIM_FRAME_SHELL_BORDER_PX}px solid rgba(255,255,255,0.08)`
      && client.DEVICE_FRAME_STYLES.border === `${client.SIM_FRAME_SHELL_BORDER_PX}px solid rgba(0,0,0,0.6)`
      && client.PHONE_BEZEL_STYLES.boxSizing === 'border-box'
      && client.DEVICE_FRAME_STYLES.boxSizing === 'border-box',
    'a future padding/border tweak touches the metric + the two CSS strings together',
  )
  step(
    'rim symmetry is SSR-computable: frame = padding + border, screen = border-box 100% (frame − 2×rim)',
    (() => {
      const modes = [
        ['none', 0, 0],
        ['bezel', 6, 1],
        ['device', 16, 1],
      ]
      return modes.every(([style, pad, border]) => {
        const html = renderToString(React.createElement(client.SimulatorPanelBody, {
          title: 'iOS Simulator',
          device: BOOT_META.device,
          mode: 'stream',
          liveOpen: false,
          colorScheme: 'dark',
          locale: 'en',
          onClose: noop,
          frameStyle: style,
          sizeMode: { kind: 'preset', width: 240 },
          children: null,
        }))
        const frameStyleAttr = styleAttrOf(frameStyleFrameTagOf(html))
        const screenStyleAttr = styleAttrOf(frameStyleScreenTagOf(html))
        const rim = pad + border
        return frameStyleAttr.includes(pad === 0 ? 'padding:0' : `padding:${pad}px`)
          && (border === 0
            ? !frameStyleAttr.includes('border:')
            : frameStyleAttr.includes(`border:${border}px`))
          && screenStyleAttr.includes('box-sizing:border-box')
          && screenStyleAttr.includes('width:100%')
          && client.simPanelScreenWidthOf(240, style) === 240 - 2 * rim
      })
    })(),
    'left/right rims = pad+border at fractional AND integer panel widths (the frame width is snapped, the screen is exactly the content box)',
  )

  // ── frameless SSR: bare content, proportional clip, NO black layers ─────
  const framelessLiveHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    frameStyle: 'none',
    sizeMode: { kind: 'percent', value: 100 },
    naturalWidth: 1170,
    naturalHeight: 2532,
    children: React.createElement(client.SimLiveFrameBody, {
      meta: BOOT_META,
      colorScheme: 'dark',
      locale: 'en',
      variant: 'panel',
      naturalWidth: 1170,
      naturalHeight: 2532,
      session: liveSession,
    }),
  }))
  const framelessFrameStyle = styleAttrOf(frameStyleFrameTagOf(framelessLiveHtml))
  step(
    'frameless SSR: the wrapper is a bare sizing element (no radius, no clip, no rim)',
    framelessLiveHtml.includes('data-sim-phone-frame-style="none"')
      && framelessLiveHtml.includes('data-sim-phone-width="390px"')
      && !framelessFrameStyle.includes('border-radius')
      && !framelessFrameStyle.includes('overflow')
      && !framelessFrameStyle.includes('background')
      && !framelessFrameStyle.includes('border:')
      && !framelessFrameStyle.includes('box-shadow')
      && !framelessFrameStyle.includes('padding:6px'),
    'the whole size-mode width reaches the content; the screen below is the clip',
  )
  step(
    'frameless SSR: the screen IS the content box — proportional 55px clip at 390px, transparent, no border',
    styleAttrOf(frameStyleScreenTagOf(framelessLiveHtml)).includes('border-radius:55px')
      && styleAttrOf(frameStyleScreenTagOf(framelessLiveHtml)).includes('background:transparent')
      && styleAttrOf(frameStyleScreenTagOf(framelessLiveHtml)).includes('border:none')
      && styleAttrOf(frameStyleScreenTagOf(framelessLiveHtml)).includes('overflow:hidden')
      && frameStyleScreenTagOf(framelessLiveHtml).includes('data-sim-screen-radius="55"')
      && frameStyleFrameTagOf(framelessLiveHtml).includes('data-sim-shell-radius="55"'),
    '390px displayed screen × 55/390 = 55px — the clip is the only rounding',
  )
  step(
    'frameless SSR: NO element between the frame wrapper and the img carries a background/border',
    (() => {
      const start = framelessLiveHtml.indexOf('data-sim-phone-frame="true"')
      const end = framelessLiveHtml.indexOf('<img')
      if (start < 0 || end < 0 || end <= start) return false
      const slice = framelessLiveHtml.slice(start, end)
      const offenders = []
      for (const match of slice.matchAll(/style="([^"]*)"/g)) {
        for (const decl of match[1].split(';')) {
          const colon = decl.indexOf(':')
          if (colon < 0) continue
          const prop = decl.slice(0, colon).trim()
          const value = decl.slice(colon + 1).trim()
          if (prop === 'background' && value !== 'transparent') offenders.push(decl)
          if (prop === 'border' && value !== 'none') offenders.push(decl)
          if (/#[0-9a-fA-F]{3,8}|rgba?\(/.test(decl)) offenders.push(decl)
        }
      }
      return offenders.length === 0
    })()
      && !framelessLiveHtml.includes('ui-media-bg')
      && !framelessLiveHtml.includes('#16161a')
      && !framelessLiveHtml.includes('background:#000'),
    'transparent backgrounds allowlisted only; no dark layer can peek around the stream',
  )
  const framelessPresetSHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    frameStyle: 'none',
    sizeMode: { kind: 'preset', width: 240 },
    children: null,
  }))
  step(
    'frameless SSR: the radius scales with the displayed size (S preset 240px → 33.8px clip)',
    framelessPresetSHtml.includes('data-sim-phone-width="240px"')
      && styleAttrOf(frameStyleScreenTagOf(framelessPresetSHtml)).includes('border-radius:33.8px')
      && styleAttrOf(frameStyleScreenTagOf(framelessPresetSHtml)).includes('background:transparent')
      && !styleAttrOf(frameStyleScreenTagOf(framelessPresetSHtml)).includes('background:#000'),
    '240 × 55/390 = 33.8 — same proportion at every preset',
  )

  // ── bezel SSR: today's slim rim unchanged when the prop is absent ────────
  const bezelBodyHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    children: null,
  }))
  step(
    'default body SSR keeps the slim bezel (no frameStyle prop → bezel)',
    bezelBodyHtml.includes('data-sim-phone-frame-style="bezel"')
      && styleAttrOf(frameStyleFrameTagOf(bezelBodyHtml)).includes('padding:6px')
      && styleAttrOf(frameStyleFrameTagOf(bezelBodyHtml)).includes('border-radius:61px')
      && styleAttrOf(frameStyleFrameTagOf(bezelBodyHtml)).includes('background:#0b0b0e')
      && styleAttrOf(frameStyleScreenTagOf(bezelBodyHtml)).includes('border-radius:55px')
      && styleAttrOf(frameStyleScreenTagOf(bezelBodyHtml)).includes('background:#000'),
    'WP18 look untouched (padding 6, dark rim); fit SSR radius = fallback 55 → shell 61 = screen + 6',
  )

  // ── device SSR: 16px metallic shell, concentric radii, button nubs ───────
  const deviceBodyHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    frameStyle: 'device',
    children: null,
  }))
  step(
    'device SSR: ~16px shell (14–18px range) with the dark metallic gradient',
    deviceBodyHtml.includes('data-sim-phone-frame-style="device"')
      && styleAttrOf(frameStyleFrameTagOf(deviceBodyHtml)).includes('padding:16px')
      && styleAttrOf(frameStyleFrameTagOf(deviceBodyHtml)).includes('background:linear-gradient(145deg, #2b2e35 0%, #101116 45%, #1c1e25 100%)')
      && styleAttrOf(frameStyleFrameTagOf(deviceBodyHtml)).includes('border:1px solid rgba(0,0,0,0.6)'),
    'serve-sim-preview-style device shell',
  )
  step(
    'device SSR: concentric corners (shell 71 = screen 55 + 16) + 1px inner edge highlight',
    styleAttrOf(frameStyleFrameTagOf(deviceBodyHtml)).includes('border-radius:71px')
      && styleAttrOf(frameStyleFrameTagOf(deviceBodyHtml)).includes('box-shadow:inset 0 0 0 1px rgba(255,255,255,0.12), 0 18px 50px rgba(0,0,0,0.55)')
      && styleAttrOf(frameStyleScreenTagOf(deviceBodyHtml)).includes('border-radius:55px')
      && client.simPanelShellRadiusOf('device', 55) === 71
      && client.SIM_FRAME_DEVICE_SHELL === 16,
    'outer radius tracks the screen radius + shell thickness at every size',
  )
  step(
    'rendered radii stay concentric per mode (shell − screen = shell pad)',
    (() => {
      const parseRadius = tag => Number((tag.match(/border-radius:([\d.]+)px/) ?? [])[1])
      const bezelShell = parseRadius(styleAttrOf(frameStyleFrameTagOf(bezelBodyHtml)))
      const bezelScreen = parseRadius(styleAttrOf(frameStyleScreenTagOf(bezelBodyHtml)))
      const deviceShell = parseRadius(styleAttrOf(frameStyleFrameTagOf(deviceBodyHtml)))
      const deviceScreen = parseRadius(styleAttrOf(frameStyleScreenTagOf(deviceBodyHtml)))
      return Math.abs(bezelShell - bezelScreen - 6) < 1e-9
        && Math.abs(deviceShell - deviceScreen - 16) < 1e-9
        && Math.abs(bezelScreen - 55) < 1e-9
        && Math.abs(deviceScreen - 55) < 1e-9
    })(),
    'bezel 61 − 55 = 6 · device 71 − 55 = 16',
  )
  const deviceButtonCounts = ['mute', 'volume-up', 'volume-down', 'power'].map(id =>
    (deviceBodyHtml.match(new RegExp(`data-sim-device-button="${id}"`, 'g')) ?? []).length)
  step(
    'device SSR: portrait shows 3 left-edge + 1 right-edge button nubs',
    deviceButtonCounts.every(count => count === 1)
      && deviceBodyHtml.includes('data-sim-device-side="left"')
      && deviceBodyHtml.includes('data-sim-device-side="right"'),
    'mute + volume up/down on the left edge, power on the right',
  )

  // ── header segmented control: zh/en copy + store sync both ways ──────────
  const frameControlZhHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS 模拟器',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'light',
    locale: 'zh',
    onClose: noop,
    frameStyle: 'device',
    children: null,
  }))
  step(
    'frame-style segmented control renders next to the size dropdown with zh copy + aria-labels',
    frameControlZhHtml.includes('data-sim-frame-style-control="true"')
      && frameControlZhHtml.includes('>无框<')
      && frameControlZhHtml.includes('>边框<')
      && frameControlZhHtml.includes('>真机框<')
      && frameControlZhHtml.includes('aria-label="模拟器边框样式"')
      && frameControlZhHtml.includes('aria-label="模拟器边框样式: 无框"')
      && frameControlZhHtml.includes('aria-label="模拟器边框样式: 边框"')
      && frameControlZhHtml.includes('aria-label="模拟器边框样式: 真机框"')
      && frameControlZhHtml.includes('data-sim-panel-size-mode="true"'),
    '无框 / 边框 / 真机框 segmented buttons beside the size dropdown',
  )
  step(
    'frame-style control mirrors the active frameStyle (device pressed, zh)',
    frameControlZhHtml.includes('data-sim-frame-style="device" data-sim-frame-style-active="true"')
      && frameControlZhHtml.includes('data-sim-frame-style="none" data-sim-frame-style-active="false"')
      && frameControlZhHtml.includes('aria-pressed="true"'),
    'active flag derives from the frameStyle prop, not the click',
  )
  const frameControlEnHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    frameStyle: 'none',
    children: null,
  }))
  step(
    'frame-style control copy follows the locale (en)',
    frameControlEnHtml.includes('>Frameless<')
      && frameControlEnHtml.includes('>Bezel<')
      && frameControlEnHtml.includes('>Device frame<')
      && frameControlEnHtml.includes('aria-label="Simulator frame style: Frameless"')
      && frameControlEnHtml.includes('aria-label="Simulator frame style: Bezel"')
      && frameControlEnHtml.includes('aria-label="Simulator frame style: Device frame"')
      && frameControlEnHtml.includes('data-sim-frame-style="none" data-sim-frame-style-active="true"'),
    'Frameless / Bezel / Device frame + active frameless',
  )
  step(
    'frame-style copy labels resolve through simFrameStyleLabelOf (zh/en)',
    client.simFrameStyleLabelOf('none', client.simCopy('zh')) === '无框'
      && client.simFrameStyleLabelOf('bezel', client.simCopy('zh')) === '边框'
      && client.simFrameStyleLabelOf('device', client.simCopy('zh')) === '真机框'
      && client.simFrameStyleLabelOf('none', client.simCopy('en')) === 'Frameless'
      && client.simFrameStyleLabelOf('bezel', client.simCopy('en')) === 'Bezel'
      && client.simFrameStyleLabelOf('device', client.simCopy('en')) === 'Device frame',
    'labels come from the shared copy table',
  )

  const frameSyncStore = client.createSimulatorPanelStore()
  const frameSyncCalls = []
  const frameSyncSpy = style => { frameSyncCalls.push(style); frameSyncStore.setFrameStyle(style) }
  const findFrameStyleButton = (tree, id) => {
    const header = tree.props.children.find(child => child !== null && typeof child === 'object' && child.props?.['data-sim-panel-header'] === 'true')
    const control = header.props.children.find(child => child !== null && typeof child === 'object' && child.props?.['data-sim-frame-style-control'] === 'true')
    return control.props.children.find(child => child !== null && typeof child === 'object' && child.props?.['data-sim-frame-style'] === id)
  }
  const frameSyncTree = client.SimulatorPanelBody({
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    frameStyle: frameSyncStore.getFrameStyle(),
    onFrameStyleChange: frameSyncSpy,
    children: null,
  })
  findFrameStyleButton(frameSyncTree, 'device').props.onClick()
  step(
    'frame-style button [Device frame] dispatches the store transition',
    frameSyncStore.getFrameStyle() === 'device'
      && frameSyncCalls.length === 1
      && frameSyncCalls[0] === 'device',
    `store=${frameSyncStore.getFrameStyle()}`,
  )
  const frameSyncedTree = client.SimulatorPanelBody({
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    frameStyle: frameSyncStore.getFrameStyle(),
    onFrameStyleChange: frameSyncSpy,
    children: null,
  })
  step(
    'the frame-style control re-renders from the same store snapshot (sync both ways)',
    findFrameStyleButton(frameSyncedTree, 'device').props['data-sim-frame-style-active'] === 'true'
      && findFrameStyleButton(frameSyncedTree, 'none').props['data-sim-frame-style-active'] === 'false'
      && findFrameStyleButton(frameSyncedTree, 'device').props['aria-pressed'] === true,
    'host-owned store field flows back into the segmented control',
  )

  // ── WP19 geometry parity: landscape fill spot-checks in device + frameless ─
  const landscapeFrameChildren = React.createElement(client.SimLiveFrameBody, {
    meta: BOOT_META,
    colorScheme: 'dark',
    locale: 'en',
    variant: 'panel',
    naturalWidth: 1170,
    naturalHeight: 2532,
    session: { ...liveSession, orientation: 'landscape_left' },
  })
  const landscapeDeviceHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: true,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    orientation: 'landscape_left',
    naturalWidth: 1170,
    naturalHeight: 2532,
    sizeMode: { kind: 'percent', value: 100 },
    frameStyle: 'device',
    children: landscapeFrameChildren,
  }))
  const landscapeDeviceScreenBox = client.simPanelScreenBoxOf({ kind: 'percent', value: 100 }, 1170, 2532, 'landscape_left', 'device')
  const landscapeDeviceRadius = client.simPanelScreenRadiusOf(landscapeDeviceScreenBox.width, landscapeDeviceScreenBox.height)
  step(
    'device frame landscape: WP19 fill math unchanged (wide shell, swapped axes, 844px percent basis)',
    landscapeDeviceHtml.includes('data-sim-phone-width="844px"')
      && styleAttrOf(frameStyleScreenTagOf(landscapeDeviceHtml)).includes('aspect-ratio:2532 / 1170')
      && frameStyleRotationBoxTagOf(landscapeDeviceHtml).includes('data-sim-display-width="2532"')
      && styleAttrOf(frameStyleRotationBoxTagOf(landscapeDeviceHtml)).includes('aspect-ratio:2532 / 1170')
      && styleAttrOf(frameStyleRotationBoxTagOf(landscapeDeviceHtml)).includes('width:100%')
      && styleAttrOf(frameStyleFrameTagOf(landscapeDeviceHtml)).includes('padding:16px')
      && styleAttrOf(frameStyleFrameTagOf(landscapeDeviceHtml)).includes(`border-radius:${client.simPanelShellRadiusOf('device', landscapeDeviceRadius)}px`)
      && styleAttrOf(frameStyleScreenTagOf(landscapeDeviceHtml)).includes(`border-radius:${landscapeDeviceRadius}px`)
      && !landscapeDeviceHtml.includes('data-sim-device-button'),
    `same 2532×1170 fill inside the device shell (screen ${landscapeDeviceRadius} + 16 shell); side nubs omitted in landscape`,
  )
  const landscapeFramelessHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: true,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    orientation: 'landscape_left',
    naturalWidth: 1170,
    naturalHeight: 2532,
    sizeMode: { kind: 'percent', value: 100 },
    frameStyle: 'none',
    children: landscapeFrameChildren,
  }))
  const landscapeFramelessRadius = client.simPanelScreenRadiusOf(844, 844 * 1170 / 2532)
  step(
    'frameless landscape: WP19 fill math unchanged, bare proportional clip (no shell at all)',
    landscapeFramelessHtml.includes('data-sim-phone-width="844px"')
      && styleAttrOf(frameStyleScreenTagOf(landscapeFramelessHtml)).includes('aspect-ratio:2532 / 1170')
      && styleAttrOf(frameStyleRotationBoxTagOf(landscapeFramelessHtml)).includes('width:100%')
      && styleAttrOf(frameStyleScreenTagOf(landscapeFramelessHtml)).includes(`border-radius:${landscapeFramelessRadius}px`)
      && styleAttrOf(frameStyleScreenTagOf(landscapeFramelessHtml)).includes('background:transparent')
      && !styleAttrOf(frameStyleFrameTagOf(landscapeFramelessHtml)).includes('border-radius')
      && !styleAttrOf(frameStyleFrameTagOf(landscapeFramelessHtml)).includes('background:#0b0b0e')
      && !styleAttrOf(frameStyleFrameTagOf(landscapeFramelessHtml)).includes('padding:6px')
      && !landscapeFramelessHtml.includes('data-sim-device-button'),
    `same 2532×1170 fill with the ${landscapeFramelessRadius}px clip only (844×390 → min side 390)`,
  )
  const framelessShotHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'screenshot',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    frameStyle: 'none',
    children: React.createElement(client.SimScreenshotFrameBody, {
      meta: SCREENSHOT_META,
      locale: 'en',
      phase: 'live',
      screenshotUrl: '/_dsh/dsh-ios/screenshots/mock.png',
      failure: '',
      refresh: noop,
      imgRef: fakeImgRef,
    }),
  }))
  step(
    'screenshot-mode panels get the same three frame modes (shared SimPhoneFrame)',
    renderToString(React.createElement(client.SimulatorPanelBody, {
      title: 'iOS Simulator',
      device: BOOT_META.device,
      mode: 'screenshot',
      liveOpen: false,
      colorScheme: 'dark',
      locale: 'en',
      frameStyle: 'device',
      children: React.createElement(client.SimScreenshotFrameBody, {
        meta: SCREENSHOT_META,
        locale: 'en',
        phase: 'live',
        screenshotUrl: '/_dsh/dsh-ios/screenshots/mock.png',
        failure: '',
        refresh: noop,
        imgRef: fakeImgRef,
      }),
    })).includes('data-sim-phone-frame-style="device"')
      && framelessShotHtml.includes('data-sim-phone-frame-style="none"'),
    'the static PNG renders inside the same per-mode shell',
  )
  step(
    'frameless screenshot mode has NO background/border layers between the frame wrapper and the img either',
    (() => {
      const start = framelessShotHtml.indexOf('data-sim-phone-frame="true"')
      const end = framelessShotHtml.indexOf('<img')
      if (start < 0 || end < 0 || end <= start) return false
      const slice = framelessShotHtml.slice(start, end)
      const offenders = []
      for (const match of slice.matchAll(/style="([^"]*)"/g)) {
        for (const decl of match[1].split(';')) {
          const colon = decl.indexOf(':')
          if (colon < 0) continue
          const prop = decl.slice(0, colon).trim()
          const value = decl.slice(colon + 1).trim()
          if (prop === 'background' && value !== 'transparent') offenders.push(decl)
          if (prop === 'border' && value !== 'none') offenders.push(decl)
          if (/#[0-9a-fA-F]{3,8}|rgba?\(/.test(decl)) offenders.push(decl)
        }
      }
      return offenders.length === 0
    })()
      && !framelessShotHtml.includes('ui-media-bg')
      && !framelessShotHtml.includes('background:#000')
      && styleAttrOf(frameStyleScreenTagOf(framelessShotHtml)).includes('background:transparent')
      && styleAttrOf(frameStyleScreenTagOf(framelessShotHtml)).includes('border-radius:55px'),
    'the screenshot img letterbox also shows the bare panel, never a dark fill',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Top toolbar: segmented size quick pill | divider | action ICON pill
  // (Home · Screenshot · Rotate · Refresh) with hover tooltips
  // ═══════════════════════════════════════════════════════════════════════════
  const toolbarEnHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    sizeMode: { kind: 'preset', width: 240 },
    onHome: noop,
    onScreenshot: noop,
    onRotate: noop,
    onRefresh: noop,
    children: null,
  }))
  const headerIndex = toolbarEnHtml.indexOf('data-sim-panel-header="true"')
  const toolbarIndex = toolbarEnHtml.indexOf('data-sim-panel-toolbar="true"')
  const stageIndex = toolbarEnHtml.indexOf('data-sim-panel-stage="true"')
  step(
    'top toolbar renders below the header, above the stage (single row, wrap allowed)',
    toolbarIndex > headerIndex && stageIndex > toolbarIndex,
    `header@${headerIndex} toolbar@${toolbarIndex} stage@${stageIndex}`,
  )
  step(
    'toolbar renders the four quick size buttons with labels + aria-labels (en)',
    ['fit', 'percent-100', 'preset-S', 'preset-M'].every(id => toolbarEnHtml.includes(`data-sim-size-quick="${id}"`))
      && toolbarEnHtml.includes('>Fit<') && toolbarEnHtml.includes('>100%<')
      && toolbarEnHtml.includes('>S<') && toolbarEnHtml.includes('>M<')
      && toolbarEnHtml.includes('aria-label="Fit to panel width"')
      && toolbarEnHtml.includes('aria-label="Display at 100%"')
      && toolbarEnHtml.includes('aria-label="Small size (S, 240px)"')
      && toolbarEnHtml.includes('aria-label="Medium size (M, 320px)"'),
    '[Fit] [100%] [S] [M] segmented quick sizes',
  )
  step(
    'the active quick button mirrors the sizeMode (preset S 240px)',
    toolbarEnHtml.includes('data-sim-size-quick="preset-S" data-sim-size-quick-active="true"')
      && toolbarEnHtml.includes('data-sim-size-quick="fit" data-sim-size-quick-active="false"')
      && toolbarEnHtml.includes('aria-pressed="true"'),
    'active flag derives from the size mode, not the click',
  )
  const sizeQuickGroupTagOf = html => html.match(/<div[^>]*data-sim-size-quick-group="true"[^>]*>/)?.[0] ?? ''
  step(
    'size quick buttons render as ONE segmented pill group (single outer border, full radius)',
    styleAttrOf(sizeQuickGroupTagOf(toolbarEnHtml)).includes('border:1px solid var(--dsw-alias-border-l2)')
      && styleAttrOf(sizeQuickGroupTagOf(toolbarEnHtml)).includes('background:var(--dsw-alias-bg-layer-1)')
      && styleAttrOf(sizeQuickGroupTagOf(toolbarEnHtml)).includes('border-radius:999px')
      && styleAttrOf(sizeQuickGroupTagOf(toolbarEnHtml)).includes('padding:2px'),
    'group border only — no per-segment borders (same pill recipe as the icon cluster)',
  )
  const sizeSegmentTagOf = html => html.match(/<button[^>]*data-sim-size-quick="[^"]+"[^>]*>/)?.[0] ?? ''
  const activeSegmentHtml = renderToString(React.createElement(client.SimSizeQuickSegment, {
    id: 'preset-M',
    label: 'M',
    ariaLabel: 'Medium size (M, 320px)',
    title: 'Simulator display size',
    active: true,
    onClick: noop,
  }))
  const idleSegmentHtml = renderToString(React.createElement(client.SimSizeQuickSegment, {
    id: 'fit',
    label: 'Fit',
    ariaLabel: 'Fit to panel width',
    title: 'Simulator display size',
    active: false,
    onClick: noop,
  }))
  step(
    'segments are borderless text buttons; the ACTIVE segment is a stronger background FILL',
    styleAttrOf(sizeSegmentTagOf(idleSegmentHtml)).includes('border:none')
      && !styleAttrOf(sizeSegmentTagOf(idleSegmentHtml)).includes('border:1px')
      && styleAttrOf(sizeSegmentTagOf(activeSegmentHtml)).includes('border:none')
      && !styleAttrOf(sizeSegmentTagOf(activeSegmentHtml)).includes('border:1px')
      && styleAttrOf(sizeSegmentTagOf(activeSegmentHtml)).includes('--dsw-alias-interactive-bg-active')
      && !styleAttrOf(sizeSegmentTagOf(idleSegmentHtml)).includes('--dsw-alias-interactive-bg-active')
      && activeSegmentHtml.includes('aria-pressed="true"')
      && idleSegmentHtml.includes('aria-pressed="false"')
      && activeSegmentHtml.includes('data-sim-size-quick-active="true"')
      && idleSegmentHtml.includes('data-sim-size-quick-active="false"')
      && activeSegmentHtml.includes('>M<'),
    'active = filled background + aria-pressed, inactive = transparent (no borders anywhere)',
  )
  step(
    'segment hover is the same subtle layer highlight as the icon buttons',
    styleUsesToken(client.SIM_TOOLBAR_STYLES.sizeQuickSegmentHover, 'var(--dsw-alias-interactive-bg-hover)')
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.sizeQuickSegmentHover, 'var(--dsw-alias-label-primary)')
      && !Object.prototype.hasOwnProperty.call(client.SIM_TOOLBAR_STYLES.sizeQuickSegmentHover, 'border'),
    'hover = highlight fill, no border appears',
  )
  step(
    'action buttons Home · Screenshot · Rotate · Refresh render as icons with aria-labels',
    ['home', 'screenshot', 'rotate', 'refresh'].every(id => toolbarEnHtml.includes(`data-sim-toolbar-action="${id}"`))
      && toolbarEnHtml.includes('aria-label="Home"')
      && toolbarEnHtml.includes('aria-label="Screenshot"')
      && toolbarEnHtml.includes('aria-label="Rotate"')
      && toolbarEnHtml.includes('aria-label="Refresh"')
      && toolbarEnHtml.includes('data-sim-toolbar-divider="true"'),
    'divider separates the quick sizes from the action pill',
  )
  const actionPillTagOf = html => html.match(/<div[^>]*data-sim-toolbar-actions="true"[^>]*>/)?.[0] ?? ''
  step(
    'action pill: one rounded container (bg layer-1 + border-l2, full radius) holding the four buttons',
    toolbarEnHtml.includes('data-sim-toolbar-actions="true"')
      && styleAttrOf(actionPillTagOf(toolbarEnHtml)).includes('border:1px solid var(--dsw-alias-border-l2)')
      && styleAttrOf(actionPillTagOf(toolbarEnHtml)).includes('background:var(--dsw-alias-bg-layer-1)')
      && styleAttrOf(actionPillTagOf(toolbarEnHtml)).includes('border-radius:999px')
      && ['home', 'screenshot', 'rotate', 'refresh'].every(id =>
        toolbarEnHtml.indexOf('data-sim-toolbar-actions="true"') < toolbarEnHtml.indexOf(`data-sim-toolbar-action="${id}"`)),
    'the serve-sim-preview pill cluster look',
  )
  step(
    'every action button contains an inline stroke <svg> (no icon fonts, no assets)',
    ['home', 'screenshot', 'rotate', 'refresh'].every(id => {
      const buttonStart = toolbarEnHtml.indexOf(`data-sim-toolbar-action="${id}"`)
      const buttonEnd = toolbarEnHtml.indexOf('</button>', buttonStart)
      const inner = toolbarEnHtml.slice(buttonStart, buttonEnd)
      return inner.includes('<svg') && inner.includes(`data-sim-toolbar-icon="${id}"`)
        && inner.includes('stroke="currentColor"') && inner.includes('viewBox="0 0 16 16"')
    }),
    '16px currentColor stroke icons inside each button',
  )
  step(
    'icon set: the four stroke path sets (house/camera/rotate-arrow/refresh-arrows) are drawn inline',
    JSON.stringify(Object.keys(client.SIM_TOOLBAR_ICON_PATHS)) === JSON.stringify(['home', 'screenshot', 'rotate', 'refresh'])
      && client.SIM_TOOLBAR_ICON_PATHS.home.length === 2
      && client.SIM_TOOLBAR_ICON_PATHS.screenshot.length === 2
      && client.SIM_TOOLBAR_ICON_PATHS.rotate.length === 2
      && client.SIM_TOOLBAR_ICON_PATHS.refresh.length === 4
      && Object.values(client.SIM_TOOLBAR_ICON_PATHS).flat().every(d => typeof d === 'string' && d.length > 0),
    'minimal stroke paths, consistent 16×16 viewBox + currentColor',
  )
  step(
    'icon buttons are borderless 28px squares with rounded corners (hover = highlight fill)',
    client.SIM_TOOLBAR_STYLES.iconButton.width === 28
      && client.SIM_TOOLBAR_STYLES.iconButton.height === 28
      && client.SIM_TOOLBAR_STYLES.iconButton.border === 'none'
      && client.SIM_TOOLBAR_STYLES.iconButton.borderRadius === 7
      && client.SIM_TOOLBAR_STYLES.iconButton.background === 'transparent'
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.iconButtonHover, 'var(--dsw-alias-interactive-bg-hover)')
      && styleUsesToken(client.SIM_TOOLBAR_STYLES.iconButtonHover, 'var(--dsw-alias-label-primary)')
      && !Object.prototype.hasOwnProperty.call(client.SIM_TOOLBAR_STYLES.iconButtonHover, 'border'),
    'no per-button borders; the pill carries the single outer border',
  )

  // Tooltip: pure subcomponent SSR + the icon button's controlled open state
  // + the hover/focus wiring that drives it.
  const tooltipTagOf = html => html.match(/<span[^>]*data-sim-toolbar-tooltip="true"[^>]*>/)?.[0] ?? ''
  const tooltipOpenHtml = renderToString(React.createElement(client.SimToolbarIconButton, {
    action: 'home',
    label: 'Home',
    onClick: noop,
    tooltipOpen: true,
  }))
  const tooltipClosedHtml = renderToString(React.createElement(client.SimToolbarIconButton, {
    action: 'home',
    label: 'Home',
    onClick: noop,
  }))
  step(
    'icon button tooltip renders only in the open state (controlled override)',
    tooltipOpenHtml.includes('data-sim-toolbar-tooltip="true"')
      && tooltipOpenHtml.includes('role="tooltip"')
      && tooltipOpenHtml.includes('>Home<')
      && !tooltipClosedHtml.includes('data-sim-toolbar-tooltip')
      && tooltipClosedHtml.includes('aria-label="Home"')
      && tooltipClosedHtml.includes('data-sim-toolbar-action="home"'),
    'tooltip is visual sugar; aria-label stays on the button',
  )
  step(
    'tooltip is token-styled: tooltip-bg + static near-white text, absolute below the button',
    styleAttrOf(tooltipTagOf(tooltipOpenHtml)).includes('--dsw-alias-tooltip-bg')
      && styleAttrOf(tooltipTagOf(tooltipOpenHtml)).includes('--dsw-static-neutral-bluish-00')
      && styleAttrOf(tooltipTagOf(tooltipOpenHtml)).includes('position:absolute')
      && styleAttrOf(tooltipTagOf(tooltipOpenHtml)).includes('pointer-events:none'),
    'the host Tooltip.module.css bubble recipe',
  )
  const tooltipZhHtml = renderToString(React.createElement(client.SimToolbarTooltip, { label: '回到桌面' }))
  step(
    'tooltip label is the localized action label (zh/en)',
    tooltipZhHtml.includes('>回到桌面<')
      && tooltipZhHtml.includes('data-sim-toolbar-tooltip="true"')
      && client.simToolbarActionLabelOf('home', client.simCopy('zh')) === '回到桌面'
      && client.simToolbarActionLabelOf('screenshot', client.simCopy('zh')) === '截图'
      && client.simToolbarActionLabelOf('rotate', client.simCopy('en')) === 'Rotate'
      && client.simToolbarActionLabelOf('refresh', client.simCopy('en')) === 'Refresh',
    'tooltip text = the button aria-label string',
  )
  const tooltipButtonTree = React.createElement(client.SimToolbarIconButton, { action: 'home', label: 'Home', onClick: noop })
  step(
    'tooltip opens on the hover/focus state path (150ms show delay, instant hide)',
    tooltipButtonTree.type === client.SimToolbarIconButton
      && client.SIM_TOOLBAR_TOOLTIP_DELAY_MS === 150
      && ['onMouseEnter', 'onFocus', 'onMouseLeave', 'onBlur'].every(event =>
        readFileSync(join(root, 'src', 'client', 'sim-toolbar.tsx'), 'utf8').includes(`${event}=`)),
    'mouseenter/leave + focus/blur drive the same open state',
  )

  step(
    'toolbar order: quick sizes | divider | action pill (Home · Screenshot · Rotate · Refresh)',
    ['data-sim-size-quick-group="true"', 'data-sim-toolbar-divider="true"', 'data-sim-toolbar-actions="true"', 'data-sim-toolbar-action="home"', 'data-sim-toolbar-action="screenshot"', 'data-sim-toolbar-action="rotate"', 'data-sim-toolbar-action="refresh"']
      .every((marker, index, markers) => index === 0 || toolbarEnHtml.indexOf(marker) > toolbarEnHtml.indexOf(markers[index - 1])),
    'specified layout order',
  )

  const toolbarZhHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS 模拟器',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'light',
    locale: 'zh',
    onClose: noop,
    sizeMode: client.SIM_PANEL_SIZE_MODE_FIT,
    onHome: noop,
    onScreenshot: noop,
    onRotate: noop,
    onRefresh: noop,
    captureState: 'done',
    children: null,
  }))
  step(
    'toolbar copy follows the locale (zh)',
    toolbarZhHtml.includes('>适应<') && toolbarZhHtml.includes('>100%<')
      && toolbarZhHtml.includes('data-sim-size-quick="preset-S"') && toolbarZhHtml.includes('>S<')
      && toolbarZhHtml.includes('>M<')
      && toolbarZhHtml.includes('aria-label="适应面板宽度"')
      && toolbarZhHtml.includes('aria-label="回到桌面"')
      && toolbarZhHtml.includes('aria-label="截图"')
      && toolbarZhHtml.includes('aria-label="旋转"')
      && toolbarZhHtml.includes('aria-label="刷新"')
      && toolbarZhHtml.includes('aria-label="模拟器工具栏"'),
    '适应 / 100% / S / M quick buttons + zh action labels',
  )
  step(
    'capture confirmation renders the transient 已截图 toast (token-styled, role=status)',
    toolbarZhHtml.includes('data-sim-capture-state="done"')
      && toolbarZhHtml.includes('>已截图<')
      && toolbarZhHtml.includes('role="status"'),
    'done phase shows the inline confirmation in the toolbar',
  )
  const toolbarBusyHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onScreenshot: noop,
    captureState: 'busy',
    children: null,
  }))
  step(
    'busy capture phase shows the Capturing… toast instead',
    toolbarBusyHtml.includes('data-sim-capture-state="busy"')
      && toolbarBusyHtml.includes('>Capturing…<')
      && !toolbarBusyHtml.includes('>Captured<'),
    'busy → done → auto-clear states',
  )

  const toolbarTagOf = html => html.match(/<div[^>]*data-sim-panel-toolbar="true"[^>]*>/)?.[0] ?? ''
  const toolbarLightHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'light',
    locale: 'en',
    onHome: noop,
    onScreenshot: noop,
    onRotate: noop,
    onRefresh: noop,
    children: null,
  }))
  const toolbarDarkHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onHome: noop,
    onScreenshot: noop,
    onRotate: noop,
    onRefresh: noop,
    children: null,
  }))
  step(
    'toolbar SSR references the DSH tokens in both themes (no literal colors)',
    styleAttrOf(toolbarTagOf(toolbarLightHtml)).includes('--dsw-alias-border-l2')
      && styleAttrOf(toolbarTagOf(toolbarDarkHtml)).includes('--dsw-alias-border-l2')
      && !darkSurroundLeak(toolbarTagOf(toolbarLightHtml))
      && !darkSurroundLeak(toolbarTagOf(toolbarDarkHtml))
      && !literalColorOffenders(client.PANEL_STYLES.toolbar).length,
    'one --dsw-alias-* token set serves both schemes',
  )
  step(
    'both pills (size quick group + action icon cluster) keep the token pill recipe in light AND dark',
    ['toolbarLightHtml', 'toolbarDarkHtml'].every(htmlName => {
      const html = htmlName === 'toolbarLightHtml' ? toolbarLightHtml : toolbarDarkHtml
      const pill = styleAttrOf(actionPillTagOf(html))
      const group = styleAttrOf(sizeQuickGroupTagOf(html))
      return pill.includes('border:1px solid var(--dsw-alias-border-l2)')
        && pill.includes('background:var(--dsw-alias-bg-layer-1)')
        && group.includes('border:1px solid var(--dsw-alias-border-l2)')
        && group.includes('background:var(--dsw-alias-bg-layer-1)')
        && !darkSurroundLeak(actionPillTagOf(html))
        && !darkSurroundLeak(sizeQuickGroupTagOf(html))
    }),
    'the pill cluster resolves per theme through the vars — no literal surrounds',
  )

  // Quick buttons and the dropdown share ONE truth: the store's sizeMode.
  // Clicking either control dispatches the same store transition, and both
  // re-render from the same snapshot (sync both ways).
  const syncStore = client.createSimulatorPanelStore()
  const syncCalls = []
  const syncSpy = mode => { syncCalls.push(mode); syncStore.setSizeMode(mode) }
  const syncTree = client.SimulatorPanelBody({
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    sizeMode: syncStore.getSizeMode(),
    onSizeModeChange: syncSpy,
    onHome: noop,
    onScreenshot: noop,
    onRotate: noop,
    onRefresh: noop,
    children: null,
  })
  const findQuickButton = (tree, id) => {
    const toolbar = tree.props.children.find(child => child !== null && typeof child === 'object' && child.props?.['data-sim-panel-toolbar'] === 'true')
    const group = toolbar.props.children.find(child => child !== null && typeof child === 'object' && child.props?.['data-sim-size-quick-group'] === 'true')
    return group.props.children.find(child => child !== null && typeof child === 'object' && child.type === client.SimSizeQuickSegment && child.props.id === id)
  }
  const findActionButton = (tree, id) => {
    const toolbar = tree.props.children.find(child => child !== null && typeof child === 'object' && child.props?.['data-sim-panel-toolbar'] === 'true')
    const pill = toolbar.props.children.find(child => child !== null && typeof child === 'object' && child.props?.['data-sim-toolbar-actions'] === 'true')
    return pill.props.children.find(child => child !== null && typeof child === 'object' && child.type === client.SimToolbarIconButton && child.props.action === id)
  }
  const findSelect = (tree) => {
    const header = tree.props.children.find(child => child !== null && typeof child === 'object' && child.props?.['data-sim-panel-header'] === 'true')
    const sizeControl = header.props.children.find(child => child !== null && typeof child === 'object' && child.type === 'div' && child.props?.children !== null && child.props?.children?.type === 'select')
    return sizeControl.props.children
  }
  findQuickButton(syncTree, 'percent-100').props.onClick()
  step(
    'quick button [100%] dispatches the store transition (percent 100)',
    client.simPanelSizeModeIdOf(syncStore.getSizeMode()) === 'percent-100'
      && syncCalls.length === 1
      && client.simPanelSizeModeIdOf(syncCalls[0]) === 'percent-100',
    `store=${JSON.stringify(syncStore.getSizeMode())}`,
  )
  const dropdownTree = client.SimulatorPanelBody({
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    sizeMode: syncStore.getSizeMode(),
    onSizeModeChange: syncSpy,
    children: null,
  })
  findSelect(dropdownTree).props.onChange({ currentTarget: { value: 'preset-M' } })
  step(
    'dropdown change dispatches the same store transition (preset M 320px)',
    client.simPanelSizeModeIdOf(syncStore.getSizeMode()) === 'preset-M'
      && syncCalls.length === 2,
    `store=${JSON.stringify(syncStore.getSizeMode())}`,
  )
  const syncedTree = client.SimulatorPanelBody({
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    sizeMode: syncStore.getSizeMode(),
    onSizeModeChange: syncSpy,
    children: null,
  })
  step(
    'both controls re-render from the same store snapshot (sync both ways)',
    findQuickButton(syncedTree, 'preset-M').props.active === true
      && findQuickButton(syncedTree, 'fit').props.active === false
      && findSelect(syncedTree).props.value === 'preset-M',
    'quick button active state and dropdown value agree on preset-M',
  )

  // Home / refresh wiring stays on the stream session's own handlers.
  const wiringCalls = []
  const wiringTree = client.SimulatorPanelBody({
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onHome: () => wiringCalls.push('home'),
    onScreenshot: () => wiringCalls.push('screenshot'),
    onRotate: () => wiringCalls.push('rotate'),
    onRefresh: () => wiringCalls.push('refresh'),
    children: null,
  })
  for (const id of ['home', 'screenshot', 'rotate', 'refresh']) {
    const button = findActionButton(wiringTree, id)
    if (typeof button?.props.onClick !== 'function') throw new Error(`toolbar action ${id} has no onClick`)
    button.props.onClick()
  }
  step(
    'Home · Screenshot · Rotate · Refresh icon buttons all carry onClick handlers',
    JSON.stringify(wiringCalls) === JSON.stringify(['home', 'screenshot', 'rotate', 'refresh']),
    `wired=${wiringCalls.join(',')}`,
  )
  const wiringPillTree = findActionButton(wiringTree, 'home')
  step(
    'the pill contains exactly the four action buttons (Home · Screenshot · Rotate · Refresh)',
    (() => {
      const toolbar = wiringTree.props.children.find(child => child !== null && typeof child === 'object' && child.props?.['data-sim-panel-toolbar'] === 'true')
      const pill = toolbar.props.children.find(child => child !== null && typeof child === 'object' && child.props?.['data-sim-toolbar-actions'] === 'true')
      const ids = pill.props.children
        .filter(child => child !== null && typeof child === 'object' && child.type === client.SimToolbarIconButton)
        .map(child => child.props.action)
      return JSON.stringify(ids) === JSON.stringify(['home', 'screenshot', 'rotate', 'refresh'])
    })() && wiringPillTree.props.label === 'Home',
    'four icon buttons, no extras, in the specified order',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Rotate wire encoding (serve-sim ws tag 7, same [tag][json] layout as tap)
  // ═══════════════════════════════════════════════════════════════════════════
  const rotateFrame = client.simRotateFrame('landscape_left')
  step(
    'rotate frame is [tag 7][utf-8 JSON {orientation}]',
    client.SIM_ROTATE_TAG === 7
      && rotateFrame[0] === 7
      && JSON.parse(Buffer.from(rotateFrame.subarray(1)).toString('utf8')).orientation === 'landscape_left',
    `frame[0]=${rotateFrame[0]} payload=${Buffer.from(rotateFrame.subarray(1)).toString()}`,
  )
  step(
    'rotation cycle advances clockwise (unknown → portrait → landscape_left)',
    client.nextSimRotateOrientation(undefined) === 'landscape_left'
      && client.nextSimRotateOrientation('portrait') === 'landscape_left'
      && client.nextSimRotateOrientation('landscape_left') === 'portrait_upside_down'
      && client.nextSimRotateOrientation('portrait_upside_down') === 'landscape_right'
      && client.nextSimRotateOrientation('landscape_right') === 'portrait'
      && client.nextSimRotateOrientation('garbage') === 'landscape_left',
    'portrait → landscape_left → portrait_upside_down → landscape_right → portrait',
  )
  const configFrame = Buffer.concat([
    Buffer.from([client.SIM_CONFIG_TAG]),
    Buffer.from(JSON.stringify({ width: 2532, height: 1170, orientation: 'landscape_left' })),
  ])
  step(
    'serve-sim config frames (tag 130) parse into the device orientation',
    client.parseSimConfigFrame(configFrame)?.orientation === 'landscape_left'
      && client.parseSimConfigFrame(configFrame)?.width === 2532
      && client.parseSimConfigFrame(Buffer.from([3, 1])) === undefined
      && client.parseSimConfigFrame(Buffer.concat([Buffer.from([130]), Buffer.from('{oops')])) === undefined
      && client.parseSimConfigFrame('not a frame') === undefined,
    'the toolbar derives its next rotation from the reported orientation',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Landscape display fix: orientation → rotation/dimensions, pointer
  // inverse-mapping, rotated SSR, and size-mode width math against the
  // displayed (rotated) dimensions.
  // ═══════════════════════════════════════════════════════════════════════════
  const layoutOf = (orientation, baseW, baseH) => JSON.stringify(client.simOrientationLayoutOf(orientation, baseW, baseH))
  const layoutPortrait = layoutOf('portrait', 390, 844)
  step(
    'orientation→layout math: rotation + rotated bounding box for all four orientations',
    layoutPortrait === JSON.stringify({ rotationDeg: 0, displayW: 390, displayH: 844 })
      && layoutOf('landscape_left', 390, 844) === JSON.stringify({ rotationDeg: 90, displayW: 844, displayH: 390 })
      && layoutOf('portrait_upside_down', 390, 844) === JSON.stringify({ rotationDeg: 180, displayW: 390, displayH: 844 })
      && layoutOf('landscape_right', 390, 844) === JSON.stringify({ rotationDeg: -90, displayW: 844, displayH: 390 }),
    'axes swap for the ±90° cases; 180° keeps axes; asymmetric 390×844 base',
  )
  step(
    'orientation→layout math: unknown orientations degrade to the portrait identity',
    layoutOf(undefined, 390, 844) === layoutPortrait
      && layoutOf('garbage', 390, 844) === layoutPortrait
      && client.simDisplayOrientationIdOf(undefined) === 'portrait'
      && client.simDisplayOrientationIdOf('landscape_right') === 'landscape_right',
    'never throws, never rotates unknown states',
  )
  step(
    'frame base size: natural px dims win; 390×844@3× fallback otherwise',
    JSON.stringify(client.simPanelFrameBaseSizeOf(1170, 2532)) === JSON.stringify({ baseW: 1170, baseH: 2532 })
      && JSON.stringify(client.simPanelFrameBaseSizeOf(undefined, undefined)) === JSON.stringify({ baseW: 1170, baseH: 2532 })
      && client.simPanelFrameBaseSizeOf(1170, undefined).baseH === 2532,
    'fallback 390×844 logical × device scale 3',
  )
  step(
    'displayed logical width follows the orientation (landscape = natural height / 3)',
    client.simPanelDisplayLogicalWidthOf('portrait', 1170, 2532) === 390
      && client.simPanelDisplayLogicalWidthOf('portrait_upside_down', 1170, 2532) === 390
      && client.simPanelDisplayLogicalWidthOf('landscape_left', 1170, 2532) === 844
      && client.simPanelDisplayLogicalWidthOf('landscape_right', 1170, 2532) === 844
      && client.simPanelDisplayLogicalWidthOf('landscape_left', undefined, undefined) === 844
      && client.simPanelDisplayLogicalWidthOf('portrait', undefined, undefined) === 390,
    '844pt landscape / 390pt portrait basis (fallback included)',
  )
  step(
    'percent widths scale the DISPLAYED (rotated) width in landscape',
    client.simPanelFrameWidthOf({ kind: 'percent', value: 100 }, 1170, 844) === '844px'
      && client.simPanelFrameWidthOf({ kind: 'percent', value: 50 }, 1170, 844) === '422px'
      && client.simPanelFrameWidthOf({ kind: 'percent', value: 125 }, 1170, 844) === '1055px'
      && client.simPanelFrameWidthOf({ kind: 'percent', value: 75 }, undefined, 844) === '633px',
    'landscape 100% = 844px wide bezel; the percent basis is the displayed width',
  )
  step(
    'fit width is rotation-agnostic; presets stay fixed WITHOUT the displayed aspect (portrait default)',
    client.simPanelFrameWidthOf({ kind: 'fit' }, 1170, 844) === '100%'
      && client.simPanelFrameWidthOf({ kind: 'preset', width: 240 }, 1170, 844) === '240px'
      && client.simPanelFrameWidthOf({ kind: 'preset', width: 320 }, undefined, 844) === '320px',
    'fit fills the stage; the orientation-aware preset scale only kicks in when the displayed aspect is threaded',
  )
  step(
    'preset widths scale by the displayed aspect in landscape (short-side semantics, snapped)',
    client.simPanelFrameWidthOf({ kind: 'preset', width: 240 }, 1206, 874, 2622 / 1206) === '522px'
      && client.simPanelFrameWidthOf({ kind: 'preset', width: 320 }, 1206, 874, 2622 / 1206) === '696px'
      && client.simPanelFrameWidthOf({ kind: 'preset', width: 420 }, 1206, 874, 2622 / 1206) === '913px'
      && client.simPanelFrameWidthOf({ kind: 'preset', width: 240 }, undefined, 844, 844 / 390) === '519px'
      && client.simPanelFrameWidthOf({ kind: 'preset', width: 320 }, undefined, 844, 844 / 390) === '693px'
      && client.simPanelFrameWidthOf({ kind: 'preset', width: 420 }, undefined, 844, 844 / 390) === '909px',
    'S 240 → 522 · M 320 → 696 · L 420 → 913 at the 402×874pt display (874/402 aspect); fallback 844/390 → 519 / 693 / 909',
  )

  // Pointer inverse-mapping: the displayed (rotated) unit square → the
  // framebuffer unit square. The stream img is counter-rotated by
  // rotationDeg about its center, so the inverse is derived from the same
  // transform; every orientation is asserted at an asymmetric 390×844 rect
  // with all four corners and the center.
  const fbPoint = (orientation, x, y) => JSON.stringify(client.simFramebufferPointOf(orientation, { x, y }))
  const pt = (x, y) => JSON.stringify({ x, y })
  const inverseCorners = {
    portrait: { '0,0': '0,0', '1,0': '1,0', '1,1': '1,1', '0,1': '0,1' },
    landscape_left: { '0,0': '0,1', '1,0': '0,0', '1,1': '1,0', '0,1': '1,1' },
    landscape_right: { '0,0': '1,0', '1,0': '1,1', '1,1': '0,1', '0,1': '0,0' },
    portrait_upside_down: { '0,0': '1,1', '1,0': '0,1', '1,1': '0,0', '0,1': '1,0' },
  }
  const cornerNames = ['0,0', '1,0', '1,1', '0,1']
  const cornerTests = ['portrait', 'landscape_left', 'landscape_right', 'portrait_upside_down'].every(orientation =>
    cornerNames.every(name => fbPoint(orientation, Number(name[0]), Number(name[2])) === pt(
      Number(inverseCorners[orientation][name][0]),
      Number(inverseCorners[orientation][name][2]),
    )))
  step(
    'pointer inverse-mapping: every orientation maps all four displayed corners to the correct framebuffer corners',
    cornerTests,
    'e.g. landscape_left: the displayed top-left is the framebuffer top-right (content drawn sideways)',
  )
  step(
    'pointer inverse-mapping: the displayed top-left corner hits the right framebuffer corner',
    fbPoint('landscape_left', 0, 0) === pt(0, 1)
      && fbPoint('landscape_right', 0, 0) === pt(1, 0)
      && fbPoint('portrait_upside_down', 0, 0) === pt(1, 1)
      && fbPoint('portrait', 0, 0) === pt(0, 0),
    'tapping the top-left of rotated content lands on the framebuffer corner that renders there',
  )
  step(
    'pointer inverse-mapping: the displayed center stays the framebuffer center',
    ['portrait', 'landscape_left', 'landscape_right', 'portrait_upside_down'].every(orientation =>
      fbPoint(orientation, 0.5, 0.5) === pt(0.5, 0.5)),
    'the rotation pivot is the center, so the center point is fixed',
  )
  step(
    'pointer inverse-mapping: the inverse is exact (round-trips with the CSS rotation)',
    (() => {
      // Forward map implied by the CSS rotate(rotationDeg) about center:
      // for landscape_left (+90°): displayed = (1 - fy, fx); the inverse
      // must bring any framebuffer point back exactly.
      const forward = {
        portrait: (fx, fy) => [fx, fy],
        landscape_left: (fx, fy) => [1 - fy, fx],
        landscape_right: (fx, fy) => [fy, 1 - fx],
        portrait_upside_down: (fx, fy) => [1 - fx, 1 - fy],
      }
      const samples = [[0.1, 0.9], [0.25, 0.25], [0.5, 0.5], [0.9, 0.1], [0.333, 0.667]]
      return Object.keys(forward).every(orientation =>
        samples.every(([fx, fy]) => {
          const [dx, dy] = forward[orientation](fx, fy)
          const back = client.simFramebufferPointOf(orientation, { x: dx, y: dy })
          return Math.abs(back.x - fx) < 1e-9 && Math.abs(back.y - fy) < 1e-9
        }))
    })(),
    'simFramebufferPointOf is the exact inverse of the applied CSS rotation',
  )

  // SSR in a landscape orientation state: the rotation wrapper fills the
  // screen area with the swapped dimensions, the img's pre-rotation box
  // carries the SWAPPED wrapper dims (centered) so its counter-rotated
  // bounding box exactly fills the wrapper, and the bezel becomes a wide
  // frame (swapped screen axes + displayed-width basis).
  const landscapePanelHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: true,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    orientation: 'landscape_left',
    naturalWidth: 1170,
    naturalHeight: 2532,
    sizeMode: { kind: 'percent', value: 100 },
    onHome: noop,
    onScreenshot: noop,
    onRotate: noop,
    onRefresh: noop,
    children: React.createElement(client.SimLiveFrameBody, {
      meta: BOOT_META,
      colorScheme: 'dark',
      locale: 'en',
      variant: 'panel',
      naturalWidth: 1170,
      naturalHeight: 2532,
      session: { ...liveSession, orientation: 'landscape_left' },
    }),
  }))
  const rotationBoxTagOf = html => html.match(/<div[^>]*data-sim-live-rotation-box="true"[^>]*>/)?.[0] ?? ''
  const streamImgTagOf = html => html.match(/<img[^>]*src="\/_dsh\/dsh-ios\/stream\/mock"[^>]*>/)?.[0] ?? ''
  const phoneFrameTagOf = html => html.match(/<div[^>]*data-sim-phone-frame="true"[^>]*>/)?.[0] ?? ''
  const phoneScreenTagOf = html => html.match(/<div[^>]*data-sim-phone-screen="true"[^>]*>/)?.[0] ?? ''
  step(
    'landscape SSR: the rotation wrapper fills the screen area (100% width) with the swapped dimensions + orientation id',
    landscapePanelHtml.includes('data-sim-orientation="landscape_left"')
      && rotationBoxTagOf(landscapePanelHtml).includes('data-sim-display-width="2532"')
      && rotationBoxTagOf(landscapePanelHtml).includes('data-sim-display-height="1170"')
      && rotationBoxTagOf(landscapePanelHtml).includes('aspect-ratio:2532 / 1170')
      && styleAttrOf(rotationBoxTagOf(landscapePanelHtml)).includes('width:100%'),
    '1170×2532 framebuffer → 2532×1170 displayed box spanning the screen width',
  )
  step(
    'landscape SSR: the stream img pre-rotation box carries the SWAPPED wrapper dims (width=wrapperH, height=wrapperW)',
    styleAttrOf(streamImgTagOf(landscapePanelHtml)).includes('left:50%')
      && styleAttrOf(streamImgTagOf(landscapePanelHtml)).includes('top:50%')
      // 100 × displayH/displayW = 100 × 1170/2532 → the wrapper's HEIGHT.
      && styleAttrOf(streamImgTagOf(landscapePanelHtml)).includes('width:46.2085%')
      // 100 × displayW/displayH = 100 × 2532/1170 → the wrapper's WIDTH.
      && styleAttrOf(streamImgTagOf(landscapePanelHtml)).includes('height:216.4103%')
      && streamImgTagOf(landscapePanelHtml).includes('data-sim-pre-rotation-width="1170"')
      && streamImgTagOf(landscapePanelHtml).includes('data-sim-pre-rotation-height="2532"'),
    '1170×2532 pre-rotation box centered in the 2532×1170 wrapper — after rotate(90deg) it exactly fills the wrapper (no scaled-down island)',
  )
  step(
    'landscape SSR: the centering translate composes with the counter-rotation in the img transform (200ms transform-only transition)',
    styleAttrOf(streamImgTagOf(landscapePanelHtml)).includes('transform:translate(-50%, -50%) rotate(90deg)')
      && styleAttrOf(streamImgTagOf(landscapePanelHtml)).includes('transform-origin:center')
      && styleAttrOf(streamImgTagOf(landscapePanelHtml)).includes('transition:transform 200ms'),
    styleAttrOf(streamImgTagOf(landscapePanelHtml)),
  )
  step(
    'landscape SSR: the phone bezel follows as a wide frame and the percent width uses the displayed basis',
    styleAttrOf(phoneScreenTagOf(landscapePanelHtml)).includes('aspect-ratio:2532 / 1170')
      && landscapePanelHtml.includes('data-sim-phone-aspect="2532 / 1170"')
      && landscapePanelHtml.includes('data-sim-phone-width="844px"'),
    'wide bezel; 100% of the displayed 844pt width',
  )
  step(
    'landscape SSR: screenshot-style chrome is untouched by rotation (no rotation on the panel outside the stream box)',
    landscapePanelHtml.includes('data-sim-live-indicator="live"')
      && landscapePanelHtml.includes('data-sim-toolbar-action="rotate"')
      && landscapePanelHtml.includes('aria-label="Rotate"'),
    'toolbar icon pill/live dot render as in portrait',
  )

  const upsideDownPanelHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    orientation: 'portrait_upside_down',
    naturalWidth: 1170,
    naturalHeight: 2532,
    children: React.createElement(client.SimLiveFrameBody, {
      meta: BOOT_META,
      colorScheme: 'dark',
      locale: 'en',
      variant: 'panel',
      naturalWidth: 1170,
      naturalHeight: 2532,
      session: { ...liveSession, orientation: 'portrait_upside_down' },
    }),
  }))
  step(
    'portrait_upside_down SSR: rotate(180deg) with axes unchanged (inset-0 fill keeps its box)',
    upsideDownPanelHtml.includes('data-sim-orientation="portrait_upside_down"')
      && rotationBoxTagOf(upsideDownPanelHtml).includes('data-sim-display-width="1170"')
      && rotationBoxTagOf(upsideDownPanelHtml).includes('data-sim-display-height="2532"')
      && styleAttrOf(streamImgTagOf(upsideDownPanelHtml)).includes('transform:rotate(180deg)')
      && styleAttrOf(streamImgTagOf(upsideDownPanelHtml)).includes('inset:0')
      && !styleAttrOf(streamImgTagOf(upsideDownPanelHtml)).includes('translate(')
      && styleAttrOf(phoneScreenTagOf(upsideDownPanelHtml)).includes('aspect-ratio:1170 / 2532'),
    '180° keeps the portrait bounding box; only the img transform changes',
  )
  const portraitPanelHtml = renderToString(React.createElement(client.SimulatorPanelBody, {
    title: 'iOS Simulator',
    device: BOOT_META.device,
    mode: 'stream',
    liveOpen: false,
    colorScheme: 'dark',
    locale: 'en',
    onClose: noop,
    naturalWidth: 1170,
    naturalHeight: 2532,
    children: React.createElement(client.SimLiveFrameBody, {
      meta: BOOT_META,
      colorScheme: 'dark',
      locale: 'en',
      variant: 'panel',
      naturalWidth: 1170,
      naturalHeight: 2532,
      session: liveSession,
    }),
  }))
  step(
    'portrait SSR: identity rotation, portrait dims, and the classic 390px percent basis',
    portraitPanelHtml.includes('data-sim-orientation="portrait"')
      && rotationBoxTagOf(portraitPanelHtml).includes('data-sim-display-width="1170"')
      && rotationBoxTagOf(portraitPanelHtml).includes('data-sim-display-height="2532"')
      && styleAttrOf(streamImgTagOf(portraitPanelHtml)).includes('transform:rotate(0deg)')
      && styleAttrOf(streamImgTagOf(portraitPanelHtml)).includes('inset:0')
      && styleAttrOf(streamImgTagOf(portraitPanelHtml)).includes('width:100%')
      && styleAttrOf(streamImgTagOf(portraitPanelHtml)).includes('height:100%')
      && !styleAttrOf(streamImgTagOf(portraitPanelHtml)).includes('translate(')
      && streamImgTagOf(portraitPanelHtml).includes('data-sim-pre-rotation-width="1170"')
      && streamImgTagOf(portraitPanelHtml).includes('data-sim-pre-rotation-height="2532"')
      && portraitPanelHtml.includes('data-sim-phone-width="100%"'),
    'portrait rendering is unchanged (inset-0 fill, no translate; fit default: 100% frame width)',
  )
  step(
    'stream img renders object-fit:FILL in every orientation — the rotation wrapper enforces the framebuffer aspect, so fill absorbs sub-pixel slack symmetrically',
    styleAttrOf(streamImgTagOf(portraitPanelHtml)).includes('object-fit:fill')
      && styleAttrOf(streamImgTagOf(landscapePanelHtml)).includes('object-fit:fill')
      && styleAttrOf(streamImgTagOf(upsideDownPanelHtml)).includes('object-fit:fill'),
    'box aspect = naturalW/naturalH (wrapper aspect-ratio + WP19 swapped-box math), so fill == contain minus the one-sided sub-pixel bar — see the WHY comment on PANEL_STREAM_ROTATION_IMG_STYLES in card-styles.ts',
  )

  // The fake Dynamic Island is gone: iOS renders its own island inside the
  // framebuffer, so the CSS notch would double it (two stacked black blobs in
  // the screenshot). The old notch span was the only absolutely-positioned
  // 72×16 pill inside the phone screen (border-radius 99, top 8) — its exact
  // SSR fingerprint must be absent in BOTH portrait and landscape, and the
  // bezel must be the slim 6px rim (shell radius = screen radius + 6, so the
  // corners stay concentric at every displayed size).
  const ISLAND_PILL_FINGERPRINT = 'width:72px;height:16px;border-radius:99px'
  step(
    'no fake Dynamic Island / notch renders in portrait AND landscape SSR',
    !portraitPanelHtml.includes(ISLAND_PILL_FINGERPRINT)
      && !landscapePanelHtml.includes(ISLAND_PILL_FINGERPRINT)
      && !portraitPanelHtml.includes('border-radius:99px')
      && !landscapePanelHtml.includes('border-radius:99px'),
    'the frame is a plain rounded rim — nothing drawn over the screen',
  )
  const landscapeBezelScreenBox = client.simPanelScreenBoxOf({ kind: 'percent', value: 100 }, 1170, 2532, 'landscape_left', 'bezel')
  const landscapeBezelRadius = client.simPanelScreenRadiusOf(landscapeBezelScreenBox.width, landscapeBezelScreenBox.height)
  step(
    'slim bezel: 6px rim padding + concentric shell radius in portrait AND landscape SSR',
    styleAttrOf(phoneFrameTagOf(portraitPanelHtml)).includes('padding:6px')
      && styleAttrOf(phoneFrameTagOf(portraitPanelHtml)).includes(`border-radius:${client.simPanelShellRadiusOf('bezel', 55)}px`)
      && styleAttrOf(phoneFrameTagOf(landscapePanelHtml)).includes('padding:6px')
      && styleAttrOf(phoneFrameTagOf(landscapePanelHtml)).includes(`border-radius:${client.simPanelShellRadiusOf('bezel', landscapeBezelRadius)}px`),
    `thin device rim; portrait fit shell 55 + 6 = 61, landscape shell ${landscapeBezelRadius} + 6`,
  )
  const screenshotLiveRotationHtml = renderToString(React.createElement(client.SimScreenshotFrameBody, {
    meta: SCREENSHOT_META,
    locale: 'en',
    phase: 'live',
    screenshotUrl: '/_dsh/dsh-ios/screenshots/mock.png',
    failure: '',
    refresh: noop,
    imgRef: fakeImgRef,
  }))
  step(
    'screenshot-mode body stays rotation-free (simctl PNGs are orientation-correct)',
    screenshotLiveRotationHtml.includes('<img')
      && !screenshotLiveRotationHtml.includes('data-sim-live-rotation-box')
      && !screenshotLiveRotationHtml.includes('transform:rotate'),
    'no rotation wrapper or transform in the screenshot frame',
  )
  step(
    'screenshot img KEEPS object-fit:contain — its box aspect is not wrapper-enforced',
    screenshotLiveRotationHtml.includes('object-fit:contain'),
    'screenshot mode never reports a natural height, so the box aspect follows the 390:844 fallback shape and only matches 390:844-ratio devices; fill would stretch the rest (see the comment on PANEL_SCREENSHOT_IMAGE_STYLES in card-styles.ts)',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // 截图 capture controller: POST body shape, window.open, transient toast
  // ═══════════════════════════════════════════════════════════════════════════
  const captureCalls = []
  const openedWindows = []
  const captureFakeTimers = {
    timeouts: [],
    setTimeout(fn, ms) {
      const handle = { kind: 'capture-timeout', fn: null, ms, cleared: false }
      handle.fn = () => { handle.cleared = true; fn() }
      this.timeouts.push(handle)
      return handle
    },
    clearTimeout(handle) { if (handle !== undefined) handle.cleared = true },
  }
  const captureFetcher = async (input, init) => {
    captureCalls.push({ input, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, screenshotUrl: '/_dsh/dsh-ios/screenshot/token', path: '/tmp/dsh-ios/screenshots/capture-smoke.png', bytes: 2048 }),
    }
  }
  const captureOptionsRef = {
    current: {
      fetcher: captureFetcher,
      openWindow: (url, target) => { openedWindows.push({ url, target }) },
      autoHideMs: 2000,
      timers: captureFakeTimers,
    },
  }
  const captureController = client.createSimCaptureController(captureOptionsRef)
  step(
    'capture controller starts idle',
    captureController.getPhase() === 'idle',
    'no capture before the click',
  )
  const capturePromise = captureController.capture('CAPTURE-SMOKE-UDID')
  step(
    'capture click → busy phase immediately',
    captureController.getPhase() === 'busy',
    'POST in flight shows the Capturing… toast',
  )
  const captureOk = await capturePromise
  step(
    'capture POSTs {device} to /_dsh/dsh-ios/capture (same-origin JSON)',
    captureOk === true
      && captureCalls.length === 1
      && captureCalls[0].input === '/_dsh/dsh-ios/capture'
      && captureCalls[0].init.method === 'POST'
      && captureCalls[0].init.credentials === 'same-origin'
      && captureCalls[0].init.headers['content-type'] === 'application/json'
      && JSON.stringify(JSON.parse(captureCalls[0].init.body)) === JSON.stringify({ device: 'CAPTURE-SMOKE-UDID' }),
    `body=${captureCalls[0].init.body}`,
  )
  step(
    'success → done phase and window.open(screenshotUrl, "_blank")',
    captureController.getPhase() === 'done'
      && openedWindows.length === 1
      && openedWindows[0].url === '/_dsh/dsh-ios/screenshot/token'
      && openedWindows[0].target === '_blank',
    'the minted relative screenshot URL opens in a new tab',
  )
  const hideTimer = captureFakeTimers.timeouts[0]
  step(
    'confirmation auto-hides after ~2s (timer-injectable)',
    hideTimer !== undefined && hideTimer.ms === 2000 && !hideTimer.cleared,
    `scheduled ${hideTimer?.ms}ms`,
  )
  hideTimer.fn()
  step(
    'auto-hide timer clears the confirmation back to idle',
    captureController.getPhase() === 'idle',
    '已截图 toast transient, ~2s',
  )
  const captureFailFetcher = async (input, init) => {
    captureCalls.push({ input, init })
    return {
      ok: false,
      status: 409,
      json: async () => ({ ok: false, error: 'the simulator is not booted; boot it before capturing a screenshot' }),
    }
  }
  captureOptionsRef.current.fetcher = captureFailFetcher
  const captureFail = await captureController.capture()
  step(
    'capture failure degrades to idle with NO window.open',
    captureFail === false
      && captureController.getPhase() === 'idle'
      && openedWindows.length === 1
      && JSON.stringify(JSON.parse(captureCalls[1].init.body)) === '{}',
    'no device → {} body; no popup on failure',
  )
  captureController.dispose()
  step(
    'capture controller disposal stops notifications and timers',
    captureFakeTimers.timeouts.every(handle => handle.cleared)
      && captureController.getPhase() === 'idle',
    'controller clean',
  )

  // Tap normalization purity: normalizePointerPoint maps getBoundingClientRect
  // bounds to 0..1, so the SAME relative tap lands identically at any
  // displayed size (fit resize, percent zoom, or presets).
  const pointSmall = client.normalizePointerPoint({ clientX: 150, clientY: 320 }, { left: 0, top: 0, width: 300, height: 640 })
  const pointLarge = client.normalizePointerPoint({ clientX: 550, clientY: 1010 }, { left: 100, top: 50, width: 900, height: 1920 })
  const pointOffset = client.normalizePointerPoint({ clientX: 40, clientY: 25 }, { left: 20, top: 10, width: 100, height: 60 })
  step(
    'tap normalization is pure w.r.t. displayed size',
    pointSmall.x === 0.5 && pointSmall.y === 0.5
      && pointLarge.x === pointSmall.x && pointLarge.y === pointSmall.y
      && pointOffset.x === 0.2 && pointOffset.y === 0.25,
    'same relative point → same 0..1 coordinates at any frame size',
  )
  const degenerate = client.normalizePointerPoint({ clientX: 0, clientY: 0 }, { left: 0, top: 0, width: 0, height: 0 })
  step(
    'tap normalization guards zero-size bounds',
    degenerate.x === 0 && degenerate.y === 0,
    'never divides by zero, clamped to the unit square',
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Panel width policy: openpencil-shape width bounds + landscape auto-widen
  // state machine (pure — no DOM, driven action by action like the store).
  // ═══════════════════════════════════════════════════════════════════════════
  const widthBoundsOf = viewport => client.simulatorPanelWidthBounds(viewport)
  step(
    'width bounds adopt the openpencil shape (available = viewport − 640 clearance)',
    JSON.stringify(widthBoundsOf(2000)) === JSON.stringify({ min: 320, max: 960, initial: 380 })
      && JSON.stringify(widthBoundsOf(1400)) === JSON.stringify({ min: 320, max: 760, initial: 380 })
      && JSON.stringify(widthBoundsOf(1920)) === JSON.stringify({ min: 320, max: 960, initial: 380 }),
    'viewport 2000 → max 960 · 1400 → 760 · preferred 380 stays the initial',
  )
  step(
    'width bounds min guard path (available below MIN clamps everything to 320)',
    JSON.stringify(widthBoundsOf(900)) === JSON.stringify({ min: 320, max: 320, initial: 320 })
      && JSON.stringify(widthBoundsOf(700)) === JSON.stringify({ min: 320, max: 320, initial: 320 })
      && JSON.stringify(widthBoundsOf(0)) === JSON.stringify({ min: 320, max: 320, initial: 320 })
      && JSON.stringify(widthBoundsOf(Number.NaN)) === JSON.stringify({ min: 320, max: 320, initial: 320 }),
    'viewport − 640 < 320 → max=min=initial=320 (never negative, never NaN)',
  )
  step(
    'initial clamps into [min, max] at every viewport (never above max, never below min)',
    [500, 640, 900, 960, 1024, 1400, 2000, 3000].every(viewport => {
      const bounds = widthBoundsOf(viewport)
      return bounds.initial >= bounds.min
        && bounds.initial <= bounds.max
        && bounds.min <= bounds.max
        && bounds.max <= client.SIMULATOR_PANEL_MAX_WIDTH
        && bounds.max >= client.SIMULATOR_PANEL_MIN_WIDTH
    }) && widthBoundsOf(1024).max === 384 && widthBoundsOf(1024).initial === 380,
    '1024 → max 384, initial stays 380; every bound lies inside the contract range',
  )
  step(
    'panel width helpers clamp into the contract range (MAX now 960)',
    client.clampSimulatorPanelWidth(9999, 1600) === 960
      && client.clampSimulatorPanelWidth(9999, 1600) === client.SIMULATOR_PANEL_MAX_WIDTH
      && client.clampSimulatorPanelWidth(1, 1600) === 320
      && client.clampSimulatorPanelWidth(1, 1600) === client.SIMULATOR_PANEL_MIN_WIDTH
      && client.resizedSimulatorPanelWidth(380, 500, 440, 1600) === 440,
    'min/max respected; left-edge drag grows the panel',
  )

  step(
    'landscape auto-widen target: min(needed at ~420px display height, max), snapped to whole px',
    client.simulatorPanelLandscapeTargetWidthOf(widthBoundsOf(2000), undefined, undefined) === 909
      && client.simulatorPanelLandscapeTargetWidthOf(widthBoundsOf(2000), 1170, 2532) === 909
      && client.simulatorPanelLandscapeTargetWidthOf(widthBoundsOf(1400), 1170, 2532) === 760
      && client.simulatorPanelLandscapeTargetWidthOf(widthBoundsOf(900), 1170, 2532) === 320
      && Number.isInteger(client.simulatorPanelLandscapeTargetWidthOf(widthBoundsOf(2000), 834, 1194)),
    '420 × 844/390 = 909 (fallback and 1170×2532 agree); 1400-viewport bounds cap 760; min guard 320; always integer (WP24 snap)',
  )
  step(
    'orientation predicate: ±90° are landscape stints, everything else portrait',
    client.simulatorPanelOrientationIsLandscape('landscape_left') === true
      && client.simulatorPanelOrientationIsLandscape('landscape_right') === true
      && client.simulatorPanelOrientationIsLandscape('portrait') === false
      && client.simulatorPanelOrientationIsLandscape('portrait_upside_down') === false
      && client.simulatorPanelOrientationIsLandscape(undefined) === false
      && client.simulatorPanelOrientationIsLandscape('garbage') === false,
    'the serve-sim tag-7 orientation roster',
  )

  const widthStateInitial = client.simulatorPanelWidthStateInitial(380)
  step(
    'auto-widen state starts in portrait with no saved width and no override',
    widthStateInitial.preferred === 380
      && widthStateInitial.portraitWidth === undefined
      && widthStateInitial.userOverrode === false
      && client.simulatorPanelEffectiveWidth(widthStateInitial, 1600) === 380,
    'effective width = the preferred 380 in portrait',
  )
  const landscapeReport = { kind: 'display', orientation: 'landscape_left', naturalWidth: 1170, naturalHeight: 2532 }
  const portraitReport = { kind: 'display', orientation: 'portrait', naturalWidth: 1170, naturalHeight: 2532 }
  const widened = client.simulatorPanelWidthStateNext(widthStateInitial, landscapeReport)
  step(
    'portrait → landscape expands to the comfortable target when below it',
    widened.preferred === 380
      && widened.portraitWidth === 380
      && widened.userOverrode === false
      && client.simulatorPanelEffectiveWidth(widened, 1600) === 909,
    '380 preferred < 909 target → effective 909; the portrait width is remembered',
  )
  const alreadyWide = client.simulatorPanelWidthStateNext(client.simulatorPanelWidthStateInitial(960), landscapeReport)
  step(
    'portrait → landscape never shrinks a width already above the target',
    client.simulatorPanelEffectiveWidth(alreadyWide, 1600) === 960,
    'preferred 960 ≥ 909 target → stays 960',
  )
  const overridden = client.simulatorPanelWidthStateNext(widened, { kind: 'manual-width', width: 700 })
  step(
    'a manual drag during the landscape stint overrides the auto-widen for the rest of the stint',
    overridden.preferred === 700
      && overridden.userOverrode === true
      && client.simulatorPanelEffectiveWidth(overridden, 1600) === 700,
    'user chose 700 — the 909 target does not fight it',
  )
  const sameStintRotation = client.simulatorPanelWidthStateNext(overridden, {
    kind: 'display', orientation: 'landscape_right', naturalWidth: 1170, naturalHeight: 2532,
  })
  step(
    'rotating left↔right within a landscape stint keeps the user\u2019s override',
    sameStintRotation.userOverrode === true
      && client.simulatorPanelEffectiveWidth(sameStintRotation, 1600) === 700,
    'same stint — the manual 700 still wins',
  )
  const restored = client.simulatorPanelWidthStateNext(overridden, portraitReport)
  step(
    'landscape → portrait restores the pre-stint width and clears the override',
    restored.preferred === 380
      && restored.userOverrode === false
      && client.simulatorPanelEffectiveWidth(restored, 1600) === 380,
    'the remembered 380 comes back; a future stint auto-widens again',
  )
  const again = client.simulatorPanelWidthStateNext(restored, landscapeReport)
  step(
    'a fresh landscape stint auto-widens again (override flag reset on the orientation change)',
    again.portraitWidth === 380
      && again.userOverrode === false
      && client.simulatorPanelEffectiveWidth(again, 1600) === 909,
    'override lifetime = one landscape stint',
  )
  const sameReport = client.simulatorPanelWidthStateNext(widened, landscapeReport)
  step(
    're-reporting the same orientation keeps the stint state (only the dims update)',
    sameReport.portraitWidth === 380
      && sameReport.userOverrode === false
      && sameReport.naturalWidth === 1170
      && sameReport.naturalHeight === 2532,
    'no spurious save/restore on identical reports',
  )
  step(
    'effective width stays inside the live viewport bounds in every stint',
    client.simulatorPanelEffectiveWidth(widened, 1400) === 760
      && client.simulatorPanelEffectiveWidth(widened, 900) === 320
      && client.simulatorPanelEffectiveWidth(overridden, 900) === 320,
    'auto-widen target and manual widths are clamped to the viewport (760 / 320 guard)',
  )

  // Double-click reset + live aria bounds + overlay clamp are asserted from
  // the source (the docked surface needs a browser window to render).
  const hostSource = readFileSync(join(root, 'src', 'client', 'sim-panel-host.tsx'), 'utf8')
  step(
    'double-click on the resize handle resets to the bounds initial (openpencil nicety)',
    hostSource.includes('onDoubleClick')
      && hostSource.includes('simulatorPanelWidthBounds(window.innerWidth).initial')
      && hostSource.includes("kind: 'manual-width'"),
    'the handle\u2019s double-click dispatches the initial width',
  )
  step(
    'aria-valuemin/max on the handle follow the LIVE viewport bounds',
    hostSource.includes('aria-valuemin={bounds.min}')
      && hostSource.includes('aria-valuemax={bounds.max}')
      && hostSource.includes('aria-valuenow={Math.round(width)}'),
    'no hard-coded constants on the separator',
  )
  step(
    'the overlay fallback card applies the same clamped width',
    hostSource.includes('...surfaceStyles.overlayCard, width')
      && !hostSource.includes('width: 412'),
    'the fixed 412px overlay card is gone — the clamp policy covers both surfaces',
  )
} catch (error) {
  step('panel smoke completed without uncaught errors', false, error instanceof Error ? error.message : String(error))
  console.error(error)
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
