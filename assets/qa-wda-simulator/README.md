# qa-wda-simulator assets

Reviewed, deterministic safety definitions for the simulator-only WDA runtime in
`src/wda-simulator-input.ts`.

## Safety patches

- `safety-patches.json` is the single machine-readable source for patch
  transforms. The runtime applies these only into a private copied WDA tree;
  the cached original under `~/Library/Caches/dsh-ios/wda/src` is never
  modified.
- `bindingIPAddress-unconditional-loopback` removes WDA's env-dependent
  default binding (`USE_IP` or nil/all-interfaces) and always returns
  `127.0.0.1`.
- `mjpeg-broadcaster-not-started` comments out WDA's screenshots broadcaster
  start. The simulator input runtime does not need a video stream, so it
  disables the broadcaster rather than relying on its default binding.

The reviewed upstream revision and source hashes are recorded in
[`source-version.json`](source-version.json). The runtime validates patch
anchors against the actual cached source before launching its private copy.
