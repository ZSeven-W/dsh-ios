<h1 align="center">DSH iOS Simulator</h1>

<p align="center">
  <strong>A live, interactive iOS Simulator inside a DeepSeek Harness conversation.</strong><br />
  <sub>14 agent tools &bull; live MJPEG sidebar panel &bull; tap, drag, and press Home on the video &bull; SwiftUI preview hot reload</sub>
</p>

<p align="center">
  <a href="./README.md"><b>English</b></a> · <a href="./README.zh.md">简体中文</a>
</p>

<p align="center">
  <sub>Current plugin release: <code>0.1.0-rc.1</code> &bull; Tested with DSH <code>0.1.0-rc.6</code> &bull; rc: not published to npm yet — see <a href="#install-into-dsh">Install</a></sub>
</p>

<!-- Hero screenshot placeholder — the live "iOS 模拟器" sidebar panel beside a conversation with compact tool cards. Add the image here when available. -->

## Why DSH iOS Simulator

DSH iOS Simulator gives the agent a real iOS Simulator inside the conversation — and gives you the pixels. The agent can boot a device, build and run an Xcode project or Swift package, drive the UI, read unified logs, and inspect processes, backtraces, and leaks, while a live stream of the device renders in a persistent sidebar panel where you can tap, drag, rotate, and press Home directly on the video. No image blocks, no screen-recording files: visual bytes reach the UI only through signed, expiring URLs served by the DSH webserver.

| | |
| --- | --- |
| 🖥️ **Live simulator in the conversation** | A serve-sim MJPEG stream of the booted device, proxied through signed `/_dsh/dsh-ios/*` routes into a persistent right-side panel — the browser never touches serve-sim's port. |
| 🛠️ **14 agent tools** | Devices, boot/shutdown, screenshot, interact, build & run, unified logs, AXe-backed UI tree + tap-by-element, SwiftUI preview hot reload, processes, backtrace, leaks, app info. |
| 👆 **Interactive panel** | Tap and drag on the live video; Home / rotate / screenshot / refresh icon toolbar with hover tooltips; size modes (适应 · 50–125% · S/M/L); frame styles (无框 / 边框 / 真机框); drag-resize up to 960 px with double-click reset; landscape auto-widen. |
| 🔐 **Loopback-only transport** | serve-sim binds 127.0.0.1 in a dedicated port range; every route requires a loopback peer, a loopback `Host`, and Fetch-Metadata/Origin checks; HMAC capabilities expire within 10 minutes. |
| ⚡ **SwiftUI preview hot reload** | `ios_sim_preview` generates a disposable host app outside your package, builds your previews as a dylib, and hot-swaps edits into the running simulator without relaunching (~2–5 s). |
| 🧭 **Semantic UI automation** | `ios_sim_ui_tree` dumps the accessibility tree (AXe-backed); `ios_sim_tap_element` taps an element by label or identifier instead of guessed coordinates. |

## Tools

All 14 tools are registered on every host and return plain JSON — visual bytes reach the UI only through `presentationMeta` + signed routes, never as image blocks. On non-macOS hosts (or when serve-sim is unresolvable) the tools stay registered but fail with an explanatory error; the one exception is `ios_sim_preview` `status`, which truthfully reports `{ running: false }` on any host.

### Core simulator tools

| Tool | What it does | Key parameters |
| --- | --- | --- |
| `ios_sim_devices` | List the simulator devices available on this Mac (udid, name, runtime, state) and which are booted. | — |
| `ios_sim_boot` | Boot a device and start its live serve-sim stream; the stream stays alive for the conversation so the panel can show the simulator live. | `udid` (required — udid or device name) |
| `ios_sim_shutdown` | Shut a device down; stops the stream when it targets that device. | `udid` (required) |
| `ios_sim_screenshot` | Capture a PNG and return a small JSON summary (path, bytes, dimensions, device); the image renders in the card/panel, never as an image block. | `udid` (optional — streamed device, else first booted) |
| `ios_sim_interact` | Interact with the streamed simulator: tap at normalized 0..1 coordinates, type text (US keyboard), press a hardware button (`home`, `lock`, `volumeUp`…), or send a touch gesture; after the action settles (~300 ms) a fresh screenshot shows the effect. | `action` (required — `tap`/`type`/`button`/`gesture`), `x`/`y`, `text`, `name`, `json` |
| `ios_sim_build_run` | Build an `.xcodeproj`, `.xcworkspace`, or Swift package for the simulator, install the built `.app`, and launch it; on failure the result carries the filtered `xcodebuild` error tail. Takes minutes for a full build. | `projectPath` (required), `scheme`, `udid` (streamed → booted → newest-runtime iPhone, which is booted), `configuration` (default `Debug`) |

### UI-tree tools (AXe-backed)

| Tool | What it does | Key parameters |
| --- | --- | --- |
| `ios_sim_ui_tree` | Dump the frontmost app's accessibility element tree (labels, identifiers, values, frames in device points) plus the screen size in points; output is capped at ~40 KB (deepest levels pruned, `truncated` + hint set). | `udid` (optional), `max_depth`, `filter` (case-insensitive substring over label/identifier/type) |
| `ios_sim_tap_element` | Tap an element by identity — exact match first, then case-insensitive substring over `identifier`/`label`; nested duplicates collapse to one target, ambiguous matches list every candidate. The tap lands on the element center via AXe HID, then a ~300 ms screenshot shows the effect. | `udid` (optional), `identifier`, `label` |

### Logs tool

| Tool | What it does | Key parameters |
| --- | --- | --- |
| `ios_sim_logs` | Read what a simulator app prints, from the device unified log: `snapshot` (`log show --last <duration>`, default 2m) or `follow` (bounded live capture for `duration_seconds`, default 10, max 60 — never a hanging stream). Output is capped at ~300 lines / 30 KB with a narrowing hint. | `udid` (optional), `mode` (`snapshot`/`follow`), `duration`, `duration_seconds`, `bundle_id`, `predicate` (raw NSPredicate, overrides `bundle_id`), `level` (`default`/`info`/`debug`), `grep` |

### Preview tool

| Tool | What it does | Key parameters |
| --- | --- | --- |
| `ios_sim_preview` | SwiftUI preview hot reload, live in the simulator: `start` (default) validates the package, generates a disposable host app in the plugin cache (never inside your package), builds the package as a dylib for the simulator, installs + launches the host, and watches the sources — every edit rebuilds and hot-swaps without relaunching (~2–5 s). Compiler errors keep the last good preview and surface through `status`; one session at a time. | `packagePath` (required for `start`), `udid`, `action` (`start`/`status`/`stop`), `previewFilter` (case-insensitive substring over preview names) |

### Debug tools

| Tool | What it does | Key parameters |
| --- | --- | --- |
| `ios_sim_processes` | List the running app processes of one simulator from its own launchd (host-visible pid, name, bundle id) — the pid source for backtrace/leaks. | `udid` (optional), `filter` (case-insensitive substring over name/bundle id) |
| `ios_sim_backtrace` | One-shot batch LLDB (attach → thread backtrace → detach, never interactive); output capped at ~200 lines, main thread first, target always verified resumed. When macOS denies the attach (Developer Mode off), degrades to Xcode's non-suspending `sample` engine and reports the enable hint. | `udid` (optional), `pid` / `bundle_id`, `all_threads` (default true) |
| `ios_sim_leaks` | Analyze leaks with Xcode's `leaks` tool: `summary` (leak count, total leaked bytes, top ~30 types) or `memgraph` (a `.memgraph` artifact to open in Xcode Instruments, never parsed here). The app is suspended while scanning and always resumed. | `udid` (optional), `pid` / `bundle_id`, `mode` (`summary`/`memgraph`) |
| `ios_sim_app_info` | Installed-app facts via `simctl appinfo` (with a `get_app_container` fallback): app bundle path, writable data container, and Info.plist values; `installed: false` for missing apps. | `udid` (optional), `bundle_id` (required) |

## Display surfaces

- **Sidebar panel — “iOS 模拟器”.** The live view lives in a persistent right-hand panel (a fixed dock that pushes the conversation aside, or a centered overlay on narrow viewports). It renders the live MJPEG stream and accepts click-to-tap and drag-to-gesture directly on the video, with an icon toolbar (Home, screenshot, rotate, refresh) whose buttons carry hover tooltips. Size controls offer **适应** (fit to panel width), **50–125%** zoom of the device's logical width, and **S / M / L** presets that size the device's short side (portrait width; landscape scales so the device keeps its physical size). Frame styles are **无框 / 边框 / 真机框** (frameless / bezel / realistic device shell) with a proportional corner radius. When the device rotates to landscape the panel auto-widens to a comfortable size and restores your width when it rotates back — a manual drag during the stint always wins. The left-edge handle drags the panel wider/narrower (max 960 px; double-click resets to the default width).
- **Compact conversation cards.** Tool results render as one-line cards with no inline imagery: the unified **“iOS 模拟器”** title, an action sub-label (Boot / Screenshot / Interact / Build &amp; Run), the device name, a status badge, and an “open in sidebar” cue. Clicking the row opens the panel; clicks on buttons, links, or the live frame itself never trigger it.
- **Status capsule above the input.** While the panel is closed and a stream is online, a small green-dot pill (`<device> · 实时`) appears above the composer and opens the panel when clicked. It is session-gated: it renders and polls only while the current conversation has mounted simulator results, and stops when you switch to a session without them.
- **Standard mode and Code Mode.** Standard sessions use the host-projected `presentationMeta`. Nested Code Mode (PTC) dispatches never carry meta, so the client reconstructs the identical meta from the durable result JSON — the panel, the cards, and the capsule work in both modes.

## Security

- The browser never talks to serve-sim's port. Every byte crosses the DSH webserver origin through plugin-owned `/_dsh/dsh-ios/*` routes: `/stream/<token>` (MJPEG proxy), `/screenshot/<token>` (cached PNG), `/ws?token=…` (HID control relay), plus `/grant`, `/capture`, and `/status` endpoints.
- Tokens are HMAC-SHA256 capabilities (`base64url(payload).base64url(mac)`) expiring within 10 minutes, signed with a per-DSH-home key (`<DSH_HOME>/cache/dsh-ios/stream-access.key`, 0600, created atomically).
- Every route applies a loopback/trusted transport fence before any capability is consulted: loopback peer address, loopback `Host` (DNS-rebinding rejected), and Fetch-Metadata/Origin checks. The screenshot route serves only files inside the plugin cache directory (symbolic links refused, `realpath` containment).
- serve-sim runs as a foreground child on loopback only, in a dedicated port range (3181–3244), so a user's own serve-sim on port 3100 is never touched; `--host` is never used.
- **Orphan adoption/reclaim** — if a previous DSH host was killed ungracefully and its serve-sim helper survived, the same device is adopted (the orphan's handshake is authoritative); a stale helper squatting on a slot for a different device is reclaimed via `serve-sim -k` and relaunched once.
- **Keep-alive + idle stop** — a crashed stream restarts in the background (~5 s delay); with zero consumers the stream stops automatically after 5 minutes. Intentional stops are never fought.

## Requirements

- **macOS with full Xcode** — not just Command Line Tools. `xcodebuild`, `xcrun simctl`, and the simulator runtimes all ship with Xcode.
- **At least one iOS Simulator runtime** installed in Xcode.
- **DSH ≥ 0.1.0-rc.6 with the web bundle** for the panel. Headless profiles work too: all 14 tools function normally, just without the live view.
- **Non-macOS hosts**: the plugin loads and all 14 tools register, but every call returns an explanatory error (`iOS Simulator requires macOS with Xcode …`).
- **serve-sim** ships as an npm dependency of this plugin, so it resolves locally on real installs; the `npx -y serve-sim` fallback covers development trees (first use needs network).
- **AXe** (optional — only `ios_sim_ui_tree` / `ios_sim_tap_element` need it): `brew install cameroncooke/axe/axe`, or let the plugin auto-download the pinned release (v1.8.0, SHA-256 verified) into `~/Library/Caches/dsh-ios/bin`. `DSH_IOS_AXE_BIN` overrides resolution; `DSH_IOS_AXE_OFFLINE=1` disables the download.
- **lldb attach** needs macOS Developer Mode: run `sudo DevToolsSecurity -enable` once. Until then `ios_sim_backtrace` uses Xcode's `sample` engine (non-suspending) and `ios_sim_leaks` degrades with the enable hint.

## Install into DSH

```sh
dsh plugin --profile <name> add @zseven-w/dsh-ios
dsh web
```

> **rc note** — `0.1.0-rc.1` is not published to npm yet. Until then, install the packed tarball:
>
> ```sh
> npm pack                                   # in this repository → dsh-ios-0.1.0-rc.1.tgz
> dsh plugin --profile <name> add /path/to/dsh-ios-0.1.0-rc.1.tgz
> dsh web
> ```

## Quick start

A typical first conversation:

1. **Discover devices** — “List the available simulators.” → `ios_sim_devices`.
2. **Boot** — “Boot the iPhone 17 Pro.” → `ios_sim_boot`. The stream starts and the **“iOS 模拟器” panel** opens: the device is live in the sidebar. (Click any simulator card row, or the status pill above the input, to reopen it.)
3. **Tap on the video** — tap or drag directly on the panel; or let the agent drive the UI: “Open Settings, then tap General.” → `ios_sim_interact` (or `ios_sim_ui_tree` + `ios_sim_tap_element` for identity-based taps).
4. **Build &amp; run your app** — “Build and run /path/to/MyApp.xcodeproj.” → `ios_sim_build_run`. A full build takes minutes; when it lands, the app launches on the simulator and you watch it live in the panel.
5. **Preview hot reload** — “Show the SwiftUI previews of /path/to/MyPackage.” → `ios_sim_preview start`. Edit a source file and the preview hot-swaps in the running simulator within ~2–5 s — no relaunch.

## Troubleshooting

- **Backtrace uses `sample` instead of lldb, or leaks complains about restricted inspection** — macOS Developer Mode is off. Run `sudo DevToolsSecurity -enable` once and retry. The tools degrade cleanly until then: `ios_sim_backtrace` falls back to Xcode's `sample` (symbolized, non-suspending) and `ios_sim_leaks` reports the enable hint.
- **`ios_sim_ui_tree` / `ios_sim_tap_element` need AXe** — install it with `brew install cameroncooke/axe/axe`, or let the plugin download the pinned release on first use (needs network to github.com). The error message always carries the full install hint; `DSH_IOS_AXE_BIN=/path/to/axe` overrides resolution.
- **`ios_sim_leaks` on iOS 26.2 simulators** — on iOS 26.2 runtimes, Xcode's `leaks` can fail to inspect simulator processes with fatal diagnostics such as `Failed to get DYLD info` or minimal-corpse errors, even with Developer Mode enabled. The tool degrades cleanly: you get the raw diagnostic, the target is always verified resumed, and nothing hangs. There is no plugin-side fix — when it bites, try `mode: "memgraph"` or a different runtime.
- **The stream stops by itself** — that is the idle policy, not a crash: with zero consumers (panel closed, no cards mounted, no route active) the stream stops after 5 minutes and restarts on the next tool call or panel open. A crashed stream restarts in the background within ~5 seconds.

## Development

```sh
pnpm install
pnpm run build      # host tsc + client bundle → lib/
pnpm run typecheck
```

The `scripts/` smoke tests exercise the built `lib/` (macOS only for the parts that boot a simulator; set `DSH_IOS_SMOKE_SKIP_SIM=1` to skip those parts):

| Script | What it covers |
| --- | --- |
| `node scripts/dev-smoke.mjs` | Sim host: binary resolution, stream launch, control, keep-alive, dispose. |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | The six core tools against a real simulator (plus a real build with `--full-build`). |
| `node scripts/dev-routes-smoke.mjs` | Signed web routes: grant, stream proxy, screenshot, ws relay, fences, expiry. |
| `node scripts/dev-card-smoke.mjs` | Client cards: static SSR (no `<img>`), status/capture contract, live-ish network part. |
| `node scripts/dev-panel-smoke.mjs` | Panel components, size modes, frame styles, dock/trigger/capsule logic (static only). |
| `node scripts/dev-logs-smoke.mjs` | `ios_sim_logs` snapshot/follow, filters, caps, process reaping. |
| `node scripts/dev-uitree-smoke.mjs` | UI-tree tools: AXe resolution/download pipeline, selectors, real-simulator tree + tap. |
| `node scripts/dev-debug-smoke.mjs` | Debug tools: processes, backtrace (lldb + sample), leaks, app info. |
| `node scripts/dev-preview-smoke.mjs` | Preview hot reload: start, edit → hot-swap without relaunch, error recovery, stop. |
| `node scripts/dev-orphan-smoke.mjs` | Orphaned serve-sim adoption/reclaim after an ungraceful host kill. |

## Credits &amp; License

- [serve-sim](https://github.com/EvanBacon/serve-sim) — Evan Bacon — the simulator streaming engine (Apache-2.0; bundled runtime dependency).
- [AXe](https://github.com/cameroncooke/AXe) — Cameron Cooke — the accessibility CLI behind the UI-tree tools (MIT).
- Architecture inspired by Codex's “Build iOS Apps” plugin; the SwiftUI preview engine is a clean-room reimplementation of the publicly documented approach — no Codex code is copied.
- See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for the full notices.

**License**: MIT
