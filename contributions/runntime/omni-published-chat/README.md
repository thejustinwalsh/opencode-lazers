# ruNNtime LFM3-Omni published Q4_K_M chat contribution

This receipt retains ruNNtime's public text-only LFM3-Omni chat support for the
exact Liquid-published Q4_K_M GGUF. It keeps
`models.lfm3.LFM3_OMNI_2B.DEFAULT` on the original floating checkpoint and
exposes `Q4_K_M` as a separate choice. The chat loader uses the public
`createLfm3Chat` zoo API, caller-owned `RangeSource`, normal load options,
progress, warm-up and abort handling; the public example and source/license
instructions are in `apps/docs/src/content/docs/zoo/lfm3-chat.mdx` in the
retained patch.
This contribution does not implement audio or vision and does not redistribute
weights.

## Pinned source identity and license

The Liquid reference files are pinned to
[`LiquidAI/LFM3-Omni-2B-GGUF`](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/tree/3d29af2ad166f8299c2d820937e47dc0add20ffc)
revision `3d29af2ad166f8299c2d820937e47dc0add20ffc`. The text-only loader reads
the language model; the projector is retained as the matching reference input,
not loaded by chat.

| Artifact                        |         Bytes | SHA-256                                                            |
| ------------------------------- | ------------: | ------------------------------------------------------------------ |
| `LFM3-Omni-2B-Q4_K_M.gguf`      | 1,099,630,080 | `9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2` |
| `mmproj-LFM3-Omni-2B-Q8_0.gguf` |   506,842,528 | `8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1` |
| Pinned Liquid engine            |             — | `77821949412f5dd6d60e37f22415f0e71454e65f6a73928529c6fbec0f2cf2cb` |

The comparator is Liquid engine revision
`9c2fb176f4c222da394e8037d3c0d0837f70b978`, using the same GGUF files. Exact
payload and engine digests are retained in `evidence/source-hashes.log`. The
public loader parses the original GGUF directly and verifies its complete
language file; no floating prerequisite, substitute precision or converted
weight artifact is used.

The model weights are © Liquid AI, Inc. and are licensed under the
[LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/blob/3d29af2ad166f8299c2d820937e47dc0add20ffc/LICENSE).
Commercial use is limited to legal entities below the license's $10 million
annual-revenue threshold. The qualified non-profit exception is limited to
non-commercial or research use. Review the complete license for all terms. The
package's MIT license applies to runtime code, not model weights. The loader
fetches from Hugging Face; this contribution contains no model binaries.

## Independent and public-consumer behavior

The frozen fixture and pinned Liquid run cover 12 teacher-forced vectors. The
real-WebGPU native reference test passed with maximum cached/full-forward
probability error `1.043210406947992e-9` (budget `0.001`), maximum RMS
difference `2.279113543001851e-6`, maximum absolute difference
`2.288818359375e-5`, and minimum cosine similarity
`0.9999999999998085`. Per-vector token IDs and numerical differences are
preserved in `evidence/native-reference.log`; the full fixture is carried in
the patch as `liquid-reference.json`. The installed packed public consumer
streamed chat and matched the stable Liquid product answers `42`, `Paris`, and
`Blue`; its raw result is in `evidence/public-packed.log` and
`evidence/public-packed-vitest.json`.

The public consumer exercised caller-supplied range loading, progress and
warm-up, abort/cancellation, generation, reset/disposal and the public packed
package. A separate packed real-WebGPU run destroyed the device, observed the
lost session reject generation, disposed it without residual storage buffers,
then loaded and generated successfully from a fresh session. Recovery details
are in `evidence/recovery-packed.log` and
`evidence/recovery-packed-vitest.json`.

## Resource and latency observations

On the recorded packed public run:

- load plus warm-up: `222,673.8 ms`; first and second generations: `370.1 ms`
  and `136.5 ms`;
- GPU buffers after load: `1,535,385,996` bytes; sampled peak:
  `1,547,757,452` bytes;
- sampled peak JS heap: `1,828,364,533` bytes; host JS heap after load:
  `1,381,735,103` bytes;
- after disposal: zero model storage buffers; the TypeGPU root retained 197
  cache buffers totaling `514,896` bytes.

Device-loss recovery took `244,101.4 ms` for the first load and `248,315.3 ms`
for the fresh load; fresh generation took `644.7 ms`. Both lost and fresh
sessions disposed with zero storage buffers. The under-1-GB target was not met:
the sampled public chat peak was about 1.55 GB. These measurements are for the
text model only; chat did not load the projector, depthformer or codec, which
belong to the excluded audio implementation. No lower-memory or full-pair claim
is made.

## Checks and limitations

| Check                                            | Result                                                                            | Evidence                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| ruNNtime unit tests                              | 1,144 passed                                                                      | `evidence/unit.log`                                                        |
| Focused quant-kernel WebGPU tests                | 175 passed; 2 expected failures                                                   | `evidence/quant-kernels-gpu.log`                                           |
| Native-vs-Liquid teacher-forced WebGPU reference | 12 vectors passed                                                                 | `evidence/native-reference.log`                                            |
| Packed public chat consumer                      | Passed on real WebGPU                                                             | `evidence/public-packed-vitest.json`                                       |
| Packed device-loss/fresh-session recovery        | Passed on real WebGPU                                                             | `evidence/recovery-packed-vitest.json`                                     |
| Typecheck, lint and formatter                    | Passed                                                                            | `evidence/typecheck.log`, `evidence/lint.log`, `evidence/format-check.log` |
| Package and docs builds                          | Passed; package build emitted existing TypeGPU ambient-declaration parse warnings | `evidence/package-build.log`, `evidence/docs-build.log`                    |
| Exact source payload hashes                      | Match the pinned language, projector and engine                                   | `evidence/source-hashes.log`                                               |

The full sibling GPU suite is **not green**: 1,741 passed, 2 failed, 15 were
expected failures, and 9 were skipped. Both failures are the existing MiniLM
batch buffer-count assertions in `test/zoo/leaks.gpu.test.ts`; that file is
unchanged from the `e8a4604` base (`git diff --quiet e8a4604 b824c95 --
packages/runntime/test/zoo/leaks.gpu.test.ts` returned success). The full output
is retained in `evidence/full-gpu.log`. It is not presented as a passing suite.

The LAZERS formatter/linter/typecheck and contribution-verifier behavior checks
also passed: `bun run verify` and
`bun test scripts/verify-runntime-contribution.test.ts` (16 tests, 73
assertions). Their outputs are retained in `evidence/lazers-verify.log` and
`evidence/retention-tests.log`; successful patch reconstruction is retained in
`evidence/reconstruction-verify.log`.

## Reconstructable sibling contribution

The exact one-commit series is retained in `patches/0001-omni-published-chat.patch`.
`manifest.json` records repository, base commit/tree, commit parent, feature tip
and tree, patch SHA-256, and the retained passing-check digests. The patch
reconstructs from accepted LFM3 base-chat tip
`e8a4604d5d2603b20447c334ca0a6d6c5edc1374` to
`b824c956ad79a9273876d27c2ac1b09fc8fa19cc`; no remote PR, publication or merge
was made. Verify the scope, evidence and exact reconstructed trees with:

```sh
bun scripts/verify-runntime-contribution.ts --stage omni-published-chat
```
