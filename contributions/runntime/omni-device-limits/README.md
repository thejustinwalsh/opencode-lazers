# ruNNtime device buffer limits contribution

The GPU device was requested with default limits, so tensors past 128 MiB (the
default `maxStorageBufferBindingSize`) were refused even on adapters that allow
far more. The device now requests the adapter's buffer limits
(`maxStorageBufferBindingSize`, `maxBufferSize`), clamped between the WebGPU
defaults and what the adapter reports; with no adapter the request is unchanged.

This is commit `22564df` of the fork branch `upstream/11-device-limits`
(0.3.0-based) cherry-picked onto the 0.2.0-based `lazers-omni-trim`, because a merge
of that branch would bring in 12 upstream commits and conflict in 27 paths.

## Identity

- Fork: `https://github.com/thejustinwalsh/runntime`, branch `lazers-omni-trim`.
- Base: `70ab1be9c16571b777b0321073e230e1873b1a4b` (release `lazers-omni-70ab1be`).
- Tip: `625c05e0834753302aef41a122e7121f6c6e3276`, `fix(core): request buffer limits so tensors past 128 MiB are not refused on capable adapters`.
- Release: `lazers-omni-625c05e`, asset
  `https://github.com/thejustinwalsh/runntime/releases/download/lazers-omni-625c05e/runntime-0.2.0-625c05e.tgz`
  (SHA-256 `fa28be5812ae81c507d9d88f63f49fefeb3ccfe772513c87495879f212e5c367`).

## Evidence

- Unit (61 files, 1199 tests; four added in `test/core/gpu/limits.test.ts`),
  typecheck, lint, format check, build and package listing.
- GPU, real WebGPU headless Chromium: `eval.gpu.test.ts` and `replayCache.gpu.test.ts`
  (72 tests) exercise the changed buffer creation path. No model-scale GPU run was made
  for this change.

Verify with `bun scripts/verify-runntime-contribution.ts --stage omni-device-limits`
(optionally `--repository <runntime checkout>`).
