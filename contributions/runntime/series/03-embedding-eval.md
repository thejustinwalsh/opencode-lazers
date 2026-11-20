# core: quantized CPU Embedding, evaluation rollback and upload lifetimes, grouped column broadcast

Branch `upstream/03-embedding-eval` (3 commits: `40ffbc9`, `a45a78e`, `bc06765`). Base in the stack:
`upstream/02b-gguf` (it needs only 2a's offsets; no GGUF code is used).

Three small, separable core changes that the LFM3 parts (4 to 6) and D1 (8) need. They are three
commits so they can be split into three pull requests if the maintainers prefer.

## Description

1. `feat(core): keep a quantized CPU embedding table quantized`
   A `device: 'cpu'` `Embedding` loads a quantized weight as ints, scales and optional offsets
   (`CpuParameter.quantizedData`) and dequantizes only the gathered rows. `loadStateDict` binds a
   quantized tensor to a `CpuParameter` (before: refused) and still refuses it for any other
   non-Linear, non-conv parameter, with upstream's message. A `gpu` table keeps upstream's
   dequantize-at-load, now including offsets. `Embedding.forward(ids, root?)` takes the root the
   gathered rows upload to (default: `defaultRoot()`). Why: the Omni audio embedding is large;
   dequantizing it at load would hold a full f32 copy of a quantized weight.
2. `fix(core): free upload and staging buffers on every evaluation path`
   A failed `evalValues` discards queued commands (`Executor.discard`), frees the outputs it
   acquired and marks the values it computed as released, so a retry fails loudly instead of binding
   freed buffers. `gatherRows` frees its index upload after the submit that reads it
   (`DispatchCtx.releaseAfterSubmit`; the executor also frees pending uploads on `trim` and
   `dispose`). `StagingLease.cancel()` frees a lease whose command buffer was never submitted.
   `ReadbackQueue` now rejects the request and rethrows when encoding fails (it used to swallow the
   error and return) and cancels its lease. The test helper counts buffers per device, so a destroyed
   device does not read as a leak. The upstream leak test `test/zoo/leaks.gpu.test.ts` (MiniLM) now
   expects two 40 B uploads instead of four: the two 20 B id and position uploads that used to leak
   go back after submit. That is a visible change to an upstream test, and an improvement.
3. `feat(core): broadcast one value per column group in add and mul`
   `add`/`mul` accept `[M, groups]` against `[M, N]` when `groups` divides `N`, repeating each value
   across `N / groups` consecutive columns (mode 4, one extra uniform field). Used for per-head
   gates without an expand.

## Introduces a breaking change?

- [ ] Yes
- [x] No

(Internal only: `Executor` gains an optional `discard`, `StagingLease` gains `cancel`, the
elementwise dispatch gains an attr, `Embedding.forward` an optional second argument.)

## Type of change

- [x] New feature (change which adds functionality)
- [x] Bug fix (change which fixes an issue): upload and staging leaks on failure paths

## Public API added

Core only: `CpuQuantizedData`, `CpuParameter.quantizedData`, `Embedding.forward(ids, root?)`.
The `Embedding` doc comment states the gpu/cpu difference.

## Testing instructions

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 60 files, 1272 tests
pnpm build
cd packages/runntime && pnpm exec vitest run --project gpu test/core test/zoo/leaks
```

New direct tests (these files had only indirect cover before):

- `test/core/graph/evalCore.test.ts` (Node): after a dispatch throws midway, `discard` is called once,
  every acquired buffer is released, computed values are released and a retry throws
  `evaluation failed before submission`.
- `test/core/gpu/buffers.gpu.test.ts`: `leaseStaging` reuses the shared buffer after `finish` or
  `cancel`, leases a transient buffer while the shared one is busy, destroys a transient on cancel,
  and a repeated cancel does not free a busy shared buffer.
- `test/core/gpu/readbackQueue.gpu.test.ts`: copies several values in the following submit (compared
  exactly with the uploaded data), takes one request at a time, rejects and rethrows when the build
  step throws, rejects a value stored in another layout without leasing, and frees the staging
  buffer when `queue.submit` throws.
- `test/core/gpu/eval.gpu.test.ts`: executor rollback after a partial evaluation with no leaked
  buffers after recovery; `gatherRows` is no longer listed as leaking.
- `test/core/nn/layers.test.ts`: a CPU table gathers `int * scale + offset` and a GPU table uploads
  the same values. `loadStateDict.test.ts`: a quantized tensor binds to a `CpuParameter`.
- `elementwise.test.ts` (attrs) and `elementwiseF32.gpu.test.ts` (per-head gates, exact compare).

## GPU tests run locally

M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium `chromium-1248`, headless, `--enable-unsafe-webgpu`;
Node v26.9.0, pnpm 11.10.0 (CI uses Node 24). `pnpm exec vitest run --project gpu test/core test/zoo/leaks`: 43 files, 1822 passed, 15
expected fail, 0 failed.

## Deliberately not included

- Any model or zoo change.
- A GPU-side `Embedding` that keeps its table quantized (see limits).

## Known limits

- **`Embedding` behaves differently by device, on purpose.** A `gpu` table dequantizes at load (the
  table is also the tied LM head, read as floats); a `cpu` table stays quantized and dequantizes the
  gathered rows. Reviewers may ask for one behaviour. Making the cpu table dequantize would turn the
  Omni audio embedding into a large f32 table; making the gpu table stay quantized needs a quantized
  gather kernel. Left as is and documented on the class.
- `releaseAfterSubmit` frees uploads on `queue.onSubmittedWorkDone`; a captured executor keeps them
  until dispose.

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly
- [x] My changes generate no new warnings

## Additional notes

Touches the areas of open issues #63 (pool), #66 and #68 (leak checks) and open PR #111 (leak tests).
