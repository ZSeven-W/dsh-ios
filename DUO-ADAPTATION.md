# iPhone Duo simulator support

## Requirements

- macOS on Apple silicon, Xcode 27.1+, and an installed iPhone Duo simulator runtime.
- `simctl` and `devicectl` selected from the same Xcode installation.
- The plugin's declared Node.js version and a compatible DSH host.

The plugin pins `serve-sim` to `0.1.49-beta.139.1`, which provides the native Duo control and framebuffer path used here. No standalone Simulator.app window is needed for the flat preview. Apple runtimes, device models, and 3D rendering assets are not distributed with this plugin. Physical hinges cannot be actuated.

## Controls and verification

The toolbar provides 0°, 90°, 180°, portrait, and landscape controls. The settings popover contains a fresh state read and an arbitrary angle input. `ios_sim_hinge` exposes the same operations to an agent.

A successful request requires a fresh CoreMotion angle and display metadata. Endpoint angles also require the expected inner/cover display with its backlight on. Orientation is based on the active display's dimensions, accounting for the inner panel's 90° native-axis offset. Unsupported devices and unconfirmed transitions produce errors. App orientation locks can prevent a requested rotation.

Panel requests reuse the authenticated live WebSocket. The relay binds requests to the capability's device, correlates replies, and preserves the same native verification used by HTTP and agent calls. Disconnects cancel pending requests. A silent response timeout retires the connection and triggers bounded preview reconnection; an operation with an unknown result is never automatically replayed.

The read-only angle helper separates guest startup from sample deadlines and expires after five minutes without requests. It does not poll in the background or cache angles. The accessibility worker similarly reuses session setup while obtaining a fresh hierarchy on every request, with a one-minute idle expiry.

## Active-display coordinates and preview

Screenshots, OCR, accessibility trees, and taps use the active display's current size, point scale, and rotation. Display changes invalidate an observation; stale coordinates are rejected instead of being applied to another panel. Posture mutations cancel older accessibility reads and serialize per device.

The preview uses flat native MJPEG. Stream configuration updates the framebuffer dimensions after a display switch even when the image does not emit another load event. Fit sizing preserves aspect ratio, and the expanded view provides more room for wide layouts. A WebSocket handshake alone does not mark video ready: a decoded frame is required. Missing frames and stalled upstream streams have bounded recovery.

AXe 1.8.0 is included as its unmodified, checksum-verified release archive to avoid repeated first-use downloads. The custom AX worker's source and build instructions are in `assets/ax-reader/`. The vendored components and licenses are documented in `THIRD_PARTY_NOTICES.md`. Custom AXe overrides retain their CLI path. The worker has universal macOS 15+ slices; only arm64 has been exercised on a live simulator.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
DSH_IOS_SMOKE_SKIP_SIM=1 pnpm test
pnpm run test:duo
```

The Duo fixture suite runs on macOS without booting a simulator. It covers angle/display verification, delayed guest startup, cancellation, device scope, stale coordinate rejection, orientation mapping, stream recovery, offline helper preparation, and bounded retries. A transport regression occupies all six HTTP slots and checks that verified hinge requests still complete over the live WebSocket. A separate hook regression checks that a silent connection timeout reconnects without replaying a mutation.

Local runtime validation on macOS 27.2 / Xcode 27.1 with an iPhone Duo iOS 27.1 simulator confirmed toolbar fold/unfold, 90°, and portrait/landscape handling. In the latest idle test, the angle helper was observed to exit, and the first fold after 360 seconds without a control request completed in 3.90 s; unfold completed in 2.17 s. A replacement control connection also confirmed 90°. These are individual measurements on that host, not latency guarantees or physical-device results.

The local runtime fixture checks were run with Node 24.3.0, below the package's declared minimum of 24.11.0; CI uses Node 24. No claim is made about Intel runtime behavior, every app's orientation behavior, or eliminating whole-host memory pressure. Native frame delivery was about 5 fps in earlier measurements and is not claimed to be fixed by the control transport change.

After updating an installed plugin, reload the DSH service and refresh existing preview pages to load the matching client bundle. If the DSH Web shell itself cannot load, diagnose its process, authentication, and browser connection separately from hinge state.
