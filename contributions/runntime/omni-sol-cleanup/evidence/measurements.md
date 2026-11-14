# Measurements and bounded-load / fused-readback notes

## Source identities (unchanged, pinned)

- Language: `LFM3-Omni-2B-Q4_K_M.gguf`, 1,099,630,080 B,
  SHA-256 `9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2`
- Projector: `mmproj-LFM3-Omni-2B-Q8_0.gguf`, 506,842,528 B,
  SHA-256 `8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1`
- Reference engine revision `9c2fb176f4c222da394e8037d3c0d0837f70b978` retained from
  `omni-published-audio/partial-manifest.json`.

## Retained baseline (audio series, real Chromium WebGPU)

- Run 27 packed installed-package consumer (native self-ASR checks): both
  frozen clips exact, finite nonempty streamed 24 kHz speech, cancellation
  recovery passed, disposal with no live storage buffers (518,496 B root-cache
  retained in that run; 519,028 B in the projector-qualification run — normal
  TypeGPU root-cache retention). The generated-speech leg ran native self-ASR:
  there is no pinned-Liquid recovery assertion on run 27 (absent, not failed).
  Same-file pinned-Liquid failures of generated speech are retained separately
  as runs 9 and 14 (public pair) and runs 20, 21 and 23 (Liquid's own speech)
  in the audio receipt.
- Load/warm-up 27,011.4 ms; sampled peak GPU 1,825,200,572 B (~1.82 GB, above the
  1 GB optimization target); cumulative source reads 3,456,883,176 B (full-file
  hash plus one payload read per chunk, plus the tiny pre-validation header read
  in `openAudioProjector`).
- Run 26 is the only Liquid-to-Liquid same-file speech evidence: both frozen
  clips and both Liquid-generated 24 kHz requests transcribed to exact expected
  words after required 16 kHz resampling.
- Run 30 (pinned Liquid operator reference): 69,632-value encoder comparison,
  exact 12 depth-code IDs, 1,920 codec PCM samples — all passed.
- Pending from the audio receipt (unchanged here): independent same-file Liquid
  full-vocabulary logits/probabilities, learned attention/convolution and
  full-vocabulary depth logits, multi-seed/natural-speech generalization,
  perceptual equivalence, Desktop playback, heap/OS-resident memory.

## Loader (finding 4)

No loader byte change in this series. `sharedTensorParts` (introduced in
`f31f725`) shares one `source.read(begin, end)` across Q4_K's 3 parts
(ints/scales/offsets) and Q6_K/Q8_0's 2 parts (ints/scales). The retained
audio-series `gguf.test.ts` (unit, passing) asserts one payload read per chunk
besides the full-file hash pass. File verification
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

## Fused readback (finding 7): evaluated and rejected

An earlier revision of this series fused the logits (+hidden) readback into the
eval's own submit (`readbackManyOnSubmit` before `evalValues`: 1 submit + 1
batched map instead of 1 submit + separate maps). Review showed this is unsafe:
when graph collection, allocation or dispatch throws pre-submit, the shared
`ReadbackQueue` entry is never consumed or rejected, and the next request fails
with `a readback is already queued`. Only `toArrayFused` rejects its own
pending entry when its own eval fails. The fused patch is therefore dropped and
the separate-submit path restored (eval, then `toArray`): a failed eval
recovers without poisoning the queue. Cache targets ride the same eval and stay
materialized; uploads and step values keep their release paths; no
`core/gpu/eval.ts` or `readbackQueue.ts` change was needed, preserving all
existing callers.

Regression evidence: `fused-readback-recovery.gpu.test.ts` forces a pre-submit
eval failure through the fused queue and proves a genuinely pending successor
readback proceeds (without the core rejection the successor would fail as
already queued); `model-lifecycle.gpu.test.ts` proves a synchronous graph
failure still exposes and destroys all 5 uploads; `test/zoo/tasks/audio/speak.test.ts`
drives the real `speak` wiring (faked IO boundaries) through stream-only
early-break cancellation with no unhandled rejection and a successful reuse;
`session.test.ts` covers same-session failure-then-success at the chat session
level. No fused-readback timing is claimed; any future fusion attempt must
first demonstrate pre-submit failure recovery with dispatch/pipeline counts on
the exact pair.
