# ruNNtime LFM3-Omni base chat contribution

This contribution adds a text-only `createLfm3Chat` session to the public
`runntime/zoo` entry point. It uses Liquid AI's original floating LFM3-Omni-2B
checkpoint, streams stable decoded text, and is independent of the D1 Q8 path.
The audio and vision towers are not loaded.

## Source and conversion

- Model and tokenizer: [`LiquidAI/LFM3-Omni-2B`, revision
  `21d75123f86c1f7ffb4bef1ea202710c4e7ebe67`](https://huggingface.co/LiquidAI/LFM3-Omni-2B/tree/21d75123f86c1f7ffb4bef1ea202710c4e7ebe67).
- Safetensors model file: 4,333,941,640 bytes; SHA-256
  `76c0ec2c3e27832fb19f886d5eb0afe37f03c5c32c4a796a7ce08cef119d2763`.
- Tokenizer JSON: 17,908,634 bytes; SHA-256
  `41927bd314d17d7d7fadb44e10cd0919f7b71528d7741596d8cbd15c6945ec44`.
- The checkpoint's BF16 text tensors are decoded to F32; row permutations,
  reshapes, and tied-head row sharding change layout only. No quantized,
  ONNX, or WASM model is used, and no model weights are retained here.
- Header/schema inspection mapped all 302 retained text tensors to 302 model
  parameters, with no missing or unexpected names. The canonical descriptor
  SHA-256 is `07aa44d62744036e6b515a5d7bfa8c0b7b1a97667cf404f243804b8b8c16df09`;
  the parameter schema SHA-256 is
  `92a6e61e3b1a6d74c9f382227bdc75ab5b82ef56915de16223d296a8129b2cd1`. This
  header inspection did not read tensor payloads; the packed public-consumer
  run did load the original text tensor payloads. Details are in
  `evidence/checkpoint-header-conversion.json`.

The model weights are © Liquid AI, Inc. under the
[LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-Omni-2B/blob/21d75123f86c1f7ffb4bef1ea202710c4e7ebe67/LICENSE).
The license permits commercial use only for legal entities that do not exceed
its annual revenue threshold of $10 million. The qualified-nonprofit exception
applies to non-commercial or research use. Consult the complete license for all
terms. The ruNNtime package's MIT license applies to runtime code, not the
weights. The loader fetches weights from Hugging Face; the contribution does not
redistribute them.

## Observed behavior and resources

The installed packed package consumer loaded the pinned checkpoint over a
caller-provided `RangeSource`, completed progress accounting and default
warm-up, streamed text, and exercised aborted/invalid load, cancellation,
reset, and disposal. On the recorded public run:

- load plus warm-up: 150,210.8 ms;
- first and second generation: 564.5 ms and 374.6 ms;
- original text tensors loaded: 3,981,891,072 bytes;
- live GPU buffers after load: 6,924,665,212 bytes; sampled peak:
  6,937,036,664 bytes;
- sampled peak JS heap: 3,263,427,909 bytes; heap after load:
  2,022,848,560 bytes.

After session disposal the test observed no model storage buffers. The
TypeGPU root retained 156 non-storage cache buffers totaling 514,232 bytes;
these are not attributed to the session. A separate packed device-destruction
run rejected the lost session and loaded a fresh session on a new device. It
measured 144,599.6 ms for the first load, 144,099.5 ms for the fresh load and
2,529.8 ms for a fresh generation; both disposed sessions had zero remaining
storage buffers. See `evidence/public-packed.log` and
`evidence/recovery-packed.log` for the raw test output.

Native cached decode and full-forward generation agreed for three successive
greedy prefixes. The maximum probability error was `8.894506542400649e-8`
(budget `0.001`). This is native cache parity only, not Liquid-reference
qualification.

## Checks and outstanding qualification

| Check                                     | Result                                                     | Evidence                               |
| ----------------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| Typecheck                                 | Passed                                                     | `evidence/typecheck.log`               |
| Unit tests                                | 1,128 passed                                               | `evidence/unit.log`                    |
| Focused operator WebGPU tests             | 66 passed                                                  | `evidence/operator-gpu.log`            |
| Package build                             | Passed; TypeGPU emitted ambient-declaration parse warnings | `evidence/package-build.log`           |
| Docs build                                | Passed                                                     | `evidence/docs-build.log`              |
| Installed packed public consumer          | Passed on real WebGPU                                      | `evidence/public-packed-vitest.json`   |
| Packed device-loss/fresh-session recovery | Passed on real WebGPU                                      | `evidence/recovery-packed-vitest.json` |
| Native cached/full-forward parity         | Passed; max probability error `8.89e-8`                    | `evidence/cache-parity-vitest.json`    |

The LAZERS retention verifier's `bun run verify` and its 11 focused behavior
tests passed; receipts are `evidence/lazers-verify.log` and
`evidence/contribution-verifier-tests.log`.

The full sibling GPU suite is not green: 1,738 tests passed, 2 failed, 15
expected failures and 7 skipped. Both failures are in the existing MiniLM batch
buffer-count expectations, which expected two 20-byte buffers that were not
present. The full output is retained in `evidence/full-gpu.log`; no unrelated
leak test was changed.

No frozen independent teacher-forced vectors or Architect-reviewed expected
product answers from Liquid's pinned engine were supplied in the assigned
artifact or found in the repository. They have not been synthesized from this
implementation. The required Liquid parity and stable product-answer checks
remain unverified pending Architect-supplied fixtures or an arranged
qualification. The pinned Liquid WebGPU engine is recorded in
`.agents/docs/webgpu-api.md` at revision
`9c2fb176f4c222da394e8037d3c0d0837f70b978`, SHA-256
`77821949412f5dd6d60e37f22415f0e71454e65f6a73928529c6fbec0f2cf2cb`.

## Retained sibling patch

`manifest.json` records the exact sibling repository base/tree, feature commit
and tree, ordered patch digest, and evidence receipt digests. The contribution
verifier replays the complete patch series against base
`f394a74fdaf1b78625039ee8a39bfe95ba5548ac` and compares the reconstructed
tree. The retained series reconstructed one patch to tree
`eb321ec29ac1a7550c3fd3c26cd813f1cea9bcd1`; the run is recorded in
`evidence/reconstruction-verify.log`. The patch contains source and tests only,
not model data.
