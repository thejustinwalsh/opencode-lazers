# D1 safety correction

This correction fixes exceptional execution cleanup and captured-device uploads
on top of the accepted D1 reference branch. The original
`contributions/runntime/d1-reference/` evidence and manifest remain unchanged.

## Reconstructable sibling change

- Base: `735fbd94195a8c2a7c40a12aec6b86fa34ebd48c`
- Tip: `82250160386691dc36565ae59aa70545150f4e06`
- Ordered format patch: `patches/0001-d1-exceptional-cleanup.patch`
- `manifest.json` pins the base/tip trees and records SHA-256 digests for the
  patch and retained check outputs.

From the LAZERS workspace, run
`bun scripts/verify-runntime-contribution.ts --stage d1-safety-correction`.
The verifier checks commit ancestry and evidence digests, applies the patch to
the exact sibling base, and compares the reconstructed tree with the recorded
tip. No model binaries are retained.

## Verification

| Check                                               | Result                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter runntime test:unit`                  | 877 tests passed                                                                                                      |
| Core GPU executor regression suite                  | 70 tests passed, including rollback after partial evaluation failure                                                  |
| D1 correction qualification on real Chromium WebGPU | Passed: six frozen F32 reference cases and nine failure/recovery, disposal, root-capture, and fresh-device follow-ups |
| `pnpm --filter runntime typecheck`                  | Passed                                                                                                                |
| `pnpm lint`                                         | Passed                                                                                                                |
| `pnpm --filter runntime build`                      | Completed; existing TypeGPU declaration parse and deprecated `external` warnings are retained in `evidence/build.log` |

The six independent reference answers and processed input-token counts matched
exactly. Maximum probability error was
`0.0000017654551517365391` (budget `0.001`). Encoding, submission, partial
evaluation and readback failures recovered for a subsequent decision. Uploads
continued to use the original captured root after initialization changed during
loading and between decisions. A fresh-root D1 decision also matched its
reference.

## Healthy disposal observations

Allocation baselines were sampled before D1 creation. On the original root the
baseline was 4 live buffers / 108 bytes, including one shared 32-byte
`MAP_READ` staging buffer and one 12-byte uniform buffer. Repeated healthy
disposal settled active work, rejected queued and post-disposal work, and left
zero new D1-owned buffers without destroying the device. Another consumer of
the shared executor remained usable. New allocations retained outside decider
ownership were reported separately: 104 cached uniforms / 1,436 bytes and no
new shared staging buffers.

The fresh-root reference decision returned `yes` with 47 processed tokens.
Fresh-root disposal left zero new D1-owned buffers, no new staging buffers and
22 cached uniforms / 300 bytes. Neither device was destroyed to mask a leak.
The full timing, memory and per-decision report is in
`evidence/d1-correction-webgpu.log`; its Vitest result is retained in
`evidence/d1-correction-vitest.json`. GPU byte counts sum live `GPUBuffer.size`
snapshots and exclude driver-private allocations. Browser JS heap is sampled,
not a process-wide peak; user-agent memory was unavailable.

`bun run verify` and
`bun test scripts/verify-runntime-contribution.test.ts` pass in LAZERS. The
contribution verifier's regression tests also ensure the older D1-reference
stage keeps its original unit/GPU-only evidence contract.
