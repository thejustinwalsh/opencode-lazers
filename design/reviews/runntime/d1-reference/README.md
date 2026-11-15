# D1 600M text qualification

The frozen six-case corpus and token IDs compare the ruNNtime D1 branch with
Liquid Transformers F32 at revision
`02b55d7076f15129e59ab3f94783f32c4b088674`. Both the original branch and the
repaired branch passed all cases on real WebGPU: stable answers and processed
token counts matched exactly, and the largest probability error was
`0.0000017654551517365391` (budget `0.001`).

| Measurement                    |                                     Original branch |                                                                                  Repaired branch |
| ------------------------------ | --------------------------------------------------: | -----------------------------------------------------------------------------------------------: |
| Successful load                |                                          149,964 ms |                                                                                       129,700 ms |
| Loaded weights                 |                                     1,899,868,164 B |                                                                                  1,899,868,164 B |
| Peak live GPU buffers          |                                     1,672,492,620 B |                                                                                  1,630,639,556 B |
| Sampled browser JS heap        |                                     2,735,638,902 B |                                                                                  2,736,314,070 B |
| Peak user-agent memory         |                                             unknown |                                                                                          unknown |
| Decision latency, six cases    |         576.6 / 41.6 / 47.3 / 41.2 / 63.0 / 53.9 ms |                                                      565.3 / 42.6 / 42.7 / 40.9 / 62.4 / 52.2 ms |
| Release observation            | 25.2 ms; 41,854,536 B remain in the shared executor | 37.6 ms after active work/device loss; old-device allocations are released by device destruction |
| Fresh-device recovery          |                                                   — |                                          127,587 ms load; 503.7 ms decision; exact answer/tokens |
| Fresh recovery decider release |                                                   — |                                                         34.2 ms; zero new tracked buffers remain |

The host figure is a browser `performance.memory` sample, not a process-wide
peak. User-agent-specific memory was unavailable. GPU figures sum live
`GPUBuffer.size` snapshots and exclude driver-private allocations. The
post-device-loss count is not attributed to the decider because destroying the
device releases all of its resources. Per-case probabilities, errors, and
measurement notes are in `baseline-measurements.json` and
`repaired-measurements.json`; full test output and Vitest reports are retained
beside them.

## Retained checks and patches

- `prompt-unit.log`: 3 prompt packing/overflow tests passed.
- `executor-gpu.log`: 69 GPU executor tests passed, including gather-upload
  cleanup.
- `baseline-webgpu.log` and `repaired-webgpu.log`: original and repaired
  reference/lifetime qualifications passed on Chromium WebGPU.
- `typecheck.log`: ruNNtime package typecheck passed.
- `patches/` and `manifest.json`: two actual sibling commits, complete ordered
  format patches, evidence digests, and exact base/tree reconstruction data.

Base: `68f3a12506bada2c9ac6cb3629426f3e06a56349`.
Tip: `735fbd94195a8c2a7c40a12aec6b86fa34ebd48c`.
No model weights are retained.
