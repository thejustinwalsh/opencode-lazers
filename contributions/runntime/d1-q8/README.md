# D1 Omni 600M native Q8 zoo contribution

This contribution adds the public text-only D1 decision loader to ruNNtime's
`runntime/zoo` API. It accepts the original F32 checkpoint or a locally
converted native Q8 safetensors file through the shared `RangeSource` and
`LoadOptions` contracts. The exported `models.d1.D1_OMNI_600M` entries pin the
Liquid tokenizer and calibration; Q8 weights are deliberately not hosted.

The ruNNtime change is retained as an ordered patch against composed base
`fd28773ca30facdaf6e56d8e9fba06e242ff623d` (tree
`1c98121e4200cc8f76ab126e68987e244032d3e5`). `manifest.json` records the real
sibling commit, tree, patch digest and check evidence. No model weights are
included in the repository or this contribution.

## Reproduce the text-only artifact

Fetch the original Liquid checkpoint and tokenizer from revision
`02b55d7076f15129e59ab3f94783f32c4b088674`, then run the converter supplied by
this ruNNtime tree:

```sh
curl -L --fail \
  'https://huggingface.co/LiquidAI/d1-omni-600M/resolve/02b55d7076f15129e59ab3f94783f32c4b088674/model.safetensors' \
  -o model.safetensors
cd tools/python
uv sync
uv run runntime quantize ../model.safetensors ../d1-omni-600m-text-q8.safetensors \
  --bits 8 --group-size 32 --drop 'audio.*' --drop 'vision.*'
shasum -a 256 ../d1-omni-600m-text-q8.safetensors
```

The output is runntime's symmetric int8 format v1 with groups of 32 inputs.
The converter's default exclusions and its dimension checks leave the token
embedding and width-one scorer in supported float formats. The two drop patterns
remove audio and vision tensors. The original, tokenizer and output digests,
byte counts, command and repeat-conversion result are in
`evidence/provenance.json` and `evidence/conversion-hashes.txt`;
`evidence/conversion.log` retains the tensor-by-tensor conversion record.

The D1 weights are © Liquid AI, Inc. under the LFM Open License v1.0, including
its commercial-use terms. The package's MIT license applies to runtime code,
not to the model weights or their derivatives. The original and converted
weights remain outside Git and are not redistributed by ruNNtime.

## Reproduce the packaged public consumer

After building the package, run the opt-in consumer test with local files. It
packs ruNNtime, installs the tarball into a temporary consumer, loads its public
`runntime/zoo` entry with a caller `RangeSource`, and exercises default warm-up,
progress, abort cleanup, malformed-file errors, overflow and disposal on real
Chromium WebGPU:

```sh
D1_Q8_MODEL_PATH=/path/to/d1-omni-600m-text-q8.safetensors \
D1_Q8_TOKENIZER_PATH=/path/to/tokenizer.json \
D1_Q8_ARTIFACT_SHA256=<sha256> \
D1_Q8_VITEST_REPORT=/path/to/qualification.json \
node packages/runntime/test/zoo/d1/packed-consumer.mjs
```

The packaged run and its JSON test receipt are retained in
`evidence/package.log` and `evidence/q8-packed-vitest.json`; the emitted
`D1_Q8_QUALIFICATION` report is normalized to `evidence/q8-measurements.json`.

## Quality and resource results

The public packaged Q8 runner passed all six frozen Liquid cases, including
reversed named-choice order and a rubric. It preserved all processed token
counts and exact clear-margin answers. Maximum per-option probability error
against F32 was `0.007052843893842697` (limit `0.04`); normalized rubric score
error was `0.0028722852213202144` (limit `0.05`). The Q8-only ONNX comparison
is reported separately in `evidence/onnx-comparison.json`: maximum native-Q8
versus ONNX-Q8 probability difference was `0.01161249956699828`. ONNX is a
parity reference, not the ruNNtime artifact format or an acceptance threshold.

The native Q8 package loaded `620432388` weight bytes across 266 tensors from
the `620464044`-byte artifact. The real-device peak live-buffer sum was
`371192740` bytes; sampled browser JS heap was `1232617010` bytes. The RangeSource
used HTTP 206 range delivery. It received `1266157224` bytes across the tested
aborted partial load and the successful load, so that number includes refetched
bytes. GPU measurements sum live `GPUBuffer.size` values and exclude
driver-private allocations; browser heap is sampled rather than a process-wide
peak.

After the Q8 transforms were added, the original F32 checkpoint also passed the
six-case pinned Liquid corpus on the composed source tree. Maximum probability
error was `0.0000017654551517365391` (limit `0.001`), with exact answers and
token counts. The F32 receipt and measurements are in
`evidence/f32-current-webgpu.log` and `evidence/f32-current-measurements.json`.
The earlier post-composition D1 lifecycle and reference checks remain in
`../upstream-composition/`.

## Checks

- `pnpm typecheck` and `pnpm lint` passed.
- `pnpm --filter runntime test:unit`: 47 files, 1,117 tests passed.
- `pnpm --filter runntime build` and `pnpm build:docs` passed.
- Focused real-Chromium quantized operator run: five files, 291 passed and two
  expected failures; see `evidence/operator-gpu.log`.
- The packed public Q8 consumer passed, including malformed artifact handling,
  explicit overflow, abort cleanup and post-disposal behavior.
- Python conversion tests: 31 passed; Ruff, formatting and Pyright passed.

The build retains upstream warnings: deprecated `external` config and TypeGPU
ambient-declaration parser warnings. WebGPU kernel implicit-conversion warnings
also remain; the checks exited successfully. Full logs and receipts are retained
in `evidence/` and digested by `manifest.json`.
