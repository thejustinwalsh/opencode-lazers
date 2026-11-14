# Measurements and bounded-load / fused-readback notes

## Source identities (unchanged, pinned)

- Language: `LFM3-Omni-2B-Q4_K_M.gguf`, 1,099,630,080 B,
  SHA-256 `9f8d30e9d4fd7a9349d586077988229b3ca0a0e4ad730897563d1eccc9893e2`
- Projector: `mmproj-LFM3-Omni-2B-Q8_0.gguf`, 506,842,528 B,
  SHA-256 `8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1`
- Reference engine revision `9c2fb176f4c222da394e8037d3c0aa4d3dfbeca560` retained from
  `omni-published-audio/partial-manifest.json`.

## Retained baseline (audio series, real Chromium WebGPU)

- Run 27 packed installed-package consumer: both frozen clips exact, finite
  nonempty streamed 24 kHz speech, cancellation recovery passed, disposal with
  no live storage buffers (518,496 B root-cache retained in that run; 519,028 B
  in the projector-qualification run — normal TypeGPU root-cache retention).
- Load/warm-up 27,011.4 ms; sampled peak GPU 1,825,200,572 B (~1.82 GB, above the
  1 GB optimization target); cumulative source reads 3,456,883,176 B (full-file
  hash plus one payload read per chunk, plus the tiny pre-validation header read
  in `openAudioProjector`).
- Run 26 (pinned same-file Liquid): both frozen clips and both Liquid-generated
  24 kHz requests transcribed to exact expected words after required 16 kHz
  resampling.
- Run 30 (pinned Liquid operator reference): 69,632-value encoder comparison,
  exact 12 depth-code IDs, 1,920 codec PCM samples — all passed.
- Pending from the audio receipt (unchanged here): independent same-file Liquid
  full-vocabulary logits/probabilities, learned attention/convolution and
  full-vocabulary depth logits, multi-seed/natural-speech generalization,
  perceptual equivalence, Desktop playback, heap/OS-resident memory.

## Loader (finding 4)

No loader byte change in this series. `sharedTensorParts` (introduced in
`f31f725`) shares one `source.read(begin, end)` across Q4_K's 3 parts
(ints/scales/offsets) and Q6_K/Q8_0's 2 parts (ints/scales). Focused tests assert
one payload read per chunk besides the full-file hash pass. File verification
(full-file SHA-256 before any tensor decode), `onBytes`/`onProgress` reporting,
`throwIfAborted` at hash chunks and before/after decode, and short-read errors
are untouched. After all parts consume the shared decode, `pending` is cleared
and the source `Uint8Array` is unreferenced; per-part arrays are retained only by
their callers. The extra `parseGgufHeader` in `openAudioProjector` is a few-KB
header re-read to validate the projector config before loading the backbone;
payload bytes are still read once per tensor through the shared path. New cold-
load time and host temporary-peak isolation require a GPU run with the same
pair and are pending; the run-27 numbers above remain the comparison point.

## Dispatch savings (static, CPU-verifiable)

Per LFM3 text forward, with 24 layers (11 attention, 13 conv):

- Q/K grouped RMSNorm: removes 2 reshapes around each of Q and K per attention
  layer = 4/layer × 11 = 44 dispatches.
- Post-norm residual: `add(norm(op), residual)` becomes
  `rmsNorm(op, scale, eps, { residual })`; same for post-FFN = 2/layer × 24 = 48
  dispatches.
- Packed MLP: `[w1, w3, silu, mul, w2]` (5) becomes `[w13, swigluChunk, w2]` (3)
  = 2/layer × 24 = 48 dispatches.
- Total ≈ 140 fewer dispatches per forward, plus fewer pipeline variants from
  the stable depthwise key. Pipeline/dispatch counts on GPU and the separate
  fused-readback effect are pending measurement; this note does not claim them.

Small-M and tiled quantized matmul routes, affine-f16 rounding, mixed-format V
handling and D1 asymmetric convolution are unchanged (no edits to
`matmul*.ts`, `quantCommon.ts`, D1 trunk or Higgs/Moonshine paths).

## Fused readback (finding 7)

Before: `evalValues([logits, hidden?, ...cache])` (1 submit) then
`toArray(logits)` + `toArray(hidden?)` (separate maps).
After: `readbackManyOnSubmit([logits, hidden?])` before the same `evalValues`,
then one awaited batched map. Cache values ride the same eval. Submit failures
reject the pending copy through `ReadbackQueue.submit`; dispatch-time throws
before submit surface as a queued-readback error on the next request (fail-fast,
same as existing `mobilenet`/`depthart` fused callers) rather than silent
corruption. `pending.catch(() => undefined)` mirrors `toArrayFused` so the
eval-failure path never emits an unhandled rejection; awaiting the pending still
observes the outcome. No change to `core/gpu/eval.ts` or `readbackQueue.ts` was
required, preserving all existing callers. Independent GPU timing with and
without fusion, with dispatch/pipeline counts, is pending and must use the same
pair and harness; this series retains the safe path regardless of that timing.
