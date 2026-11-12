# Upstream composition verification

**Ready for integration within the requested D1/upstream composition scope.**
Both already-launched GPU commands completed with exit 0. No integration blocker
was found; build and shader warnings and expected-failure cases remain explicit.

## Scope and identity

Review only of `/private/tmp/lazers-runntime-handoff.GSDeio/runntime`:

- Merge: `fd28773ca30facdaf6e56d8e9fba06e242ff623d`
- Tree: `1c98121e4200cc8f76ab126e68987e244032d3e5`
- D1 correction parent: `82250160386691dc36565ae59aa70545150f4e06`
- Pinned upstream parent: `79cb8b564c8aec92474ecdedd8101557497e1c6b`

`review-provenance.log` retains both-parent diffs, exact parent trees,
tool versions and initial Git status. No source or Git history was changed.
No model binaries are included in this evidence directory. The requested package
build regenerates its ordinary ignored `dist` outputs.

## Source review

No integration defect found in the automatic merge of
`packages/runntime/src/core/nn/layers.ts` and
`packages/runntime/src/core/gpu/dispatch/shape.ts`:

- Relative to upstream, `layers.ts` changes only the optional `TgpuRoot` argument
  on `Embedding` and its CPU-table upload via `tensor(root ?? defaultRoot(), ...)`.
  GPU-resident embedding gathers remain graph operations. The upstream quantized
  `Linear` implementation is retained: quant kind detection, tile/group validation,
  packed-word retyping, f32 scale parameter and transpose, adjacent scale binding,
  and quantized matmul options (bias/addend/activation included).
- Relative to the D1 parent, upstream's grouped `gatherRowsFrom` attrs, pipeline
  configuration and kernel signature are present. This is separate from the
  array-ID `gatherRows` path. Relative to upstream, that latter path retains
  `releaseAfterSubmit(idx)` after successful handle creation and immediate index
  destruction on encoding failure; its nonmemoized behavior remains intact.
- The D1 decider/model, explicit-root tensor overload, executor/readback cleanup,
  evaluation rollback and dispatch cleanup interface are unchanged from the D1
  correction parent (empty diff retained in provenance). `createD1Decider` captures
  the root before loading and passes it to weight loading and decision uploads,
  including CPU embeddings. Question/image cleanup waits for submitted work,
  releases outputs/uploads and trims; load failure and idempotent disposal retain
  owned-resource teardown without destroying the shared device.
- Upstream `LazyTensor`'s quant variant is accommodated by the retained upstream
  loader/Linear path. D1's existing derived F32 transforms remain the float path;
  this review does not claim qualification of a quantized D1 checkpoint.

## Checks

`checks.json` and `gpu-checks.json` retain exact argv, environment, UTC timestamps
and exit codes. Every command ran in the runntime repository above, with its
existing lockfile/dependencies and configuration; no dependency installation.

- `pnpm --filter runntime typecheck`: passed.
- `pnpm --filter runntime build`: passed. Deprecated `external` and TypeGPU ambient
  declaration parse warnings are retained in `build.log`; this is not a warning-free
  build. The prior correction build also documents this warning class.
- `pnpm --filter runntime test:unit`: 44 files / 1,112 tests passed, covering D1
  prompts plus upstream layers, grouped shape ops, loader, quant packing,
  safetensors and transforms.
- A separate verbose focused-unit run passed (8 files / 418 tests) for layers, state-dict loading,
  modules, shape ops, quant packing, safetensors, transforms and D1 prompts;
  exact arguments/results are in `focused-unit-check.json` and
  `focused-unit.log`.
- Focused real-Chromium WebGPU run exited 0: 5 files passed, 291 tests passed
  and 2 expected failures (293 total). This includes executor partial-failure
  rollback, upstream quantized Linear/kernel paths and grouped row gathers.
  Existing implicit-conversion warnings remain in `focused-gpu.log`.
- Real D1 correction qualification exited 0 at `2026-11-12T02:16:43.093725+00:00`:
  1 test passed, 2 other qualification modes intentionally skipped. Test duration
  was 228,520 ms (229.91 s runner duration). Native background completion reported
  both GPU exit codes as 0; the final receipts are in `gpu-checks.json`.

## Final real-GPU observations

`d1-correction-webgpu.log`, `d1-correction-vitest.json` and extracted
`d1-measurements.json` retain the completed real-Chromium WebGPU result.
Six frozen reference cases and nine failure/recovery/root/disposal follow-up
decisions passed (15 total). All recorded answers, processed-token counts and
probability arrays exactly match the prior correction run (`d1-comparison.json`).
Maximum absolute reference probability error is `0.0000017654551517365391`,
below the `0.001` budget. Loaded/progress bytes agree at `1,899,868,164`.

Root reinitialization during loading and between decisions retained the captured
device. Encoding, queue submission, partial evaluation and readback failure
recovery passed. Healthy repeated disposal left zero newly retained D1-owned
buffers and no new shared staging buffers, without destroying either device;
another shared-executor consumer remained usable. The fresh-root decision matched
`yes` with 47 tokens and its disposal also left zero newly retained D1-owned
buffers and no new shared staging buffers.

Shared uniform caches are explicitly excluded from D1 ownership, not hidden:
104 new uniforms / 1,516 bytes on the original root and 22 / 316 bytes in the
fresh-root follow-up. Prior correction values were 1,436 and 300 bytes
respectively; upstream adds 80 and 16 bytes while buffer counts remain unchanged.
GPU byte measurements are live `GPUBuffer.size` snapshots, not driver-private
memory. Host memory is sampled browser memory, not a process-wide peak.

`post-check-source-status.log` confirms clean tracked/untracked status, no staged
or unstaged diff and the same merged commit/tree after all checks. No GPU launch
limitation occurred. This readiness conclusion uses final receipts, not partial
logs; the already-launched commands were not restarted or duplicated.

## Prior evidence and launch policy

Inspected both prior contribution manifests, the correction README and retained
GPU output; all referenced prior check-file SHA-256 digests match
(`prior-evidence-digests.json`). Prior logs remain unchanged.

Loaded `/Users/tjw/.codex/skills/portless-dev-servers/SKILL.md` before GPU launch.
The existing Vitest browser-mode / Playwright test harness is browser automation
infrastructure, excluded by the skill's scope rule; its supported one-shot
workflow was used unchanged. No project application/preview server was launched,
no HTTP fallback was introduced, and no driving service or production Desktop was
restarted/reloaded. No profiling was armed. Existing browser/cache configuration
was reused without retaining model data here.

The real D1 test pins `LiquidAI/d1-omni-600M` revision
`02b55d7076f15129e59ab3f94783f32c4b088674`, reads the existing frozen input/token
corpus and applies a maximum absolute probability-error budget of `0.001`.
This is not a whole-upstream feature or performance qualification, nor a
quantized-D1 or multimodal-reference qualification.
