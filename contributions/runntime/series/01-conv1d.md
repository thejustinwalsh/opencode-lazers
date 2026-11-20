# feat(core): add depthwiseConv1d op and kernel

Branch `upstream/01-conv1d` (1 commit, `85bd12c`). Base in the stack: `upstream/main` (`087964a`, v0.3.0).

## Description

Adds `depthwiseConv1d(x, w, { kernelSize, padLeft?, padRight? })` to core: a channel-wise 1-D
convolution. Channel `c` of a time-major `x` `[T, C]` is correlated with its own row `w[c]` of a
channel-major weight `[C, K]`, with zero padding on either side and f32 accumulation. Output is
`[T + padLeft + padRight - K + 1, C]` in the input's dtype (f32 or f16).

Why: LFM3's short-convolution layers and the Omni audio encoder are depthwise. `conv1d` mixes
channels, and the existing grouped route cannot take a time-major `[T, C]` layout without a
transpose per layer. One dispatch, no layout change.

Touches: op in `graph/ops/conv/conv1d.ts`, `OpName`, dispatch spec in `gpu/dispatch/conv.ts` and
`registry.ts`, kernel `kernels/conv/depthwiseConv1d.ts`, the `core/index.ts` export.

## Introduces a breaking change?

- [ ] Yes
- [x] No

## Type of change

- [x] New feature (change which adds functionality)

## Public API added

`runntime/core` is not a published entry point (only `runntime/zoo` and `runntime/zoo/transformers`
are). Added to `core/index.ts`: `depthwiseConv1d`. It has a doc comment with shape, dtype, padding
rules and the errors it throws. No change to `runntime/zoo`.

## Testing instructions

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 58 files, 1246 tests, all pass
pnpm build
cd packages/runntime && pnpm exec vitest run --project gpu test/core
```

- Node: `test/core/graph/ops/conv/depthwiseConv1d.test.ts` checks the output shape and the three
  errors (kernel/weight mismatch, padding not below the kernel, padded input shorter than the kernel).
- GPU: `test/core/kernels/conv/depthwiseConv1d.gpu.test.ts` checks the kernel against a plain loop
  written from the definition (`sum over taps of x[t + tap - padLeft] * w[c, tap]`), for padding on
  the left, on the right, none, `1 x 1 x 1`, and f16 (inputs rounded to f16 first, `shader-f16`
  skip when absent).

## GPU tests run locally (upstream CI has no GPU)

MacBook Pro, Apple M2 Pro (16-core GPU), 32 GB, macOS 27.2. Playwright Chromium `chromium-1248`,
headless, `--enable-unsafe-webgpu`. Node v26.9.0, pnpm 11.10.0.

`pnpm exec vitest run --project gpu test/core`: 40 files, 1795 passed, 15 expected fail, 0 failed
(the expected failures are existing `it.fails` cases).

## Deliberately not included

- Weight loading for depthwise layers (state-dict hooks live with the models that use them).
- Quantized depthwise weights. The weight is f32 or f16 only.
- A benchmark: the op replaces a transpose-and-grouped-conv pair in models not yet in the tree, so
  there is no before/after on a model in `main` to report.

## Known limits

- The kernel does one output per `(t, c)` pair and loops over the taps. Fine for K up to the single
  digits used by the models that need it; no tiling for large K.
- No bias or activation epilogue.

## Related issues

None found upstream.

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly (doc comment on the export; the API page is generated)
- [x] My changes generate no new warnings

## Additional notes

Commit: `feat(core): add depthwiseConv1d op and kernel`.
