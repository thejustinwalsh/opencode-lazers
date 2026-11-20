# feat(core): matmulQuantW takes per-group offsets

Branch `upstream/02a-quant-offsets` (1 commit, `13949d5`). Base in the stack: `upstream/01-conv1d`
(it only needs `upstream/main`; the stack order is for linear review, and `depthwiseConv1d` is not used here).

This is the first half of the table's part 2 (GGUF reader and offsets). It is split because the
offsets touch `matmulQuantTiled`, the kernel other open pull requests also touch (#124, #127, #131).

## Description

A quantized weight can carry one extra f32 value per group beside its scale, so asymmetric formats
dequantize as `int * scale + offset`. Q4_K, the format in Liquid's published GGUF files, stores a
minimum per group of 32.

- `matmul(a, w, { scales, offsets, bits, groupSize })`: `offsets` is an f32 value shaped like `scales`.
  The plain (`matmulQuantW`) and tiled kernels add `offset * sum(x over the group)` / the per-group
  offset in the tile store. Without `offsets` the kernels compile as before (`hasOffset` is a pipeline
  constant, so there is no cost on the symmetric path).
- `QuantTensor.offsets?()`, accepted by `quantTensor()`. `permuteRows`, `splitRows`, `splitCols`,
  `concatRows`, `scaleWeight` and `dequantize` carry offsets with their groups.
- `Linear` loads `<prefix>.weightOffset` next to `weightScale` when the weight has offsets and passes
  it to `matmul`.
- Fix found while merging with v0.3.0: upstream's `dequantize` ignored offsets, so a Q4_K weight
  sent through it (the conv fallback, a GPU `Embedding`) silently lost them. It now adds them.

## Introduces a breaking change?

- [ ] Yes
- [x] No

`MatmulQuantCfg` gains a required `hasOffset` and the `matmulQuantW` op attrs gain a `hasOffset`
slot (position 4). Both are internal.

## Type of change

- [x] New feature (change which adds functionality)

## Public API added

Core only (not a published entry): `MatmulOpts.offsets`, `QuantTensor.offsets`, `Linear.weightOffset`,
`quantTensor({ offsets })`. Doc comments added on each.

## Testing instructions

```sh
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 58 files, 1249 tests
pnpm build
cd packages/runntime && pnpm exec vitest run --project gpu test/core
```

- GPU, plain route: `matmulQuantW.gpu.test.ts` case "Q4 affine minima" (`m=1, k=32, n=32`, groups of 32).
- GPU, tiled route: `matmulQuantTiled.gpu.test.ts` "applies Q4_K affine minima through the tiled
  route" (`m=32, k=32, n=2048`, so `m >= 32` and `m * n >= 48 * 1024`). Both compare with a CPU
  `q * scale + offset` dequantization (`test/core/kernels/matmul/quantW.ts`, offsets drawn from a
  seeded generator), not with the kernel's own helpers.
- Node: `transforms.test.ts` (`permuteRows` keeps offsets aligned; `dequantize` adds them:
  ints `[1, 2, 3, 4]`, scales `[1, 2]`, offsets `[10, 20]` give `[11, 12, 26, 28]`), `layers.test.ts`
  (`Linear` adds `weightOffset` in `[group, out]` order and passes it to the matmul), `matmul.test.ts`
  (attrs).
- The refusal of offsets together with a custom scale layout has a GPU case too (below).

## GPU tests run locally

M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium `chromium-1248`, headless.
`pnpm exec vitest run --project gpu test/core`: 40 files, 1799 passed, 15 expected fail, 0 failed.

## Deliberately not included

- GGUF parsing (next part). Nothing in this part reads Q4_K bytes; the tests build offsets directly.
- Offsets on the conv path. `conv1d` quantized weights take no offsets.
- Offsets in other quantW consumers. Only the two quantW matmul kernels (`matmulQuantW` for small m or
  expert views, `matmulQuantTiled` for large m) take them; `moeQuantW` and the conv route do not.

## Known limits

- Offsets are read in the default `[K / groupSize, N]` layout only. The tiled kernel accepts a custom
  `scaleAt` (the conv loader uses one); combining it with `hasOffset` throws at pipeline creation
  (`matmulQuantTiled: offsets are read in the default scale layout only`, covered by a GPU test)
  instead of reading the wrong buffer. Nothing in `main` combines the two.
- The matmul adds the offset in f32 before rounding to the store type, as the scale multiply does.
- This will conflict with open pull requests that edit `matmulQuantTiled.ts` and the `layers.ts` load
  path (#124 FusedLinear, #127, #131). The prefetching tiled kernel in v0.3.0 reads the offsets in the same two places
  as the scale.

## Related issues

None. Overlaps the areas of #124, #127, #131 (not blocking).

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly
- [x] My changes generate no new warnings

## Additional notes

`conv.ts` passes `hasOffset: 0` for the quantized conv route (a conv has no offsets).
Commit: `feat(core): matmulQuantW takes per-group offsets`.
