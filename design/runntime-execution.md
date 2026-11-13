# Liquid zoo implementation and Desktop qualification

This executes [the migration outcomes](runntime-migration.md), not a replacement
of them. Starting checkouts are LAZERS `34e00c324288955c491308fe50a024c79514cec1`
and sibling `../runntime` at `68f3a12506bada2c9ac6cb3629426f3e06a56349`.
The fork is `thejustinwalsh/runntime`. Preserve its existing D1 commits.

## Integration and evidence

Use shared, serial LAZERS tasks. The authorized external implementation workspace
is the actual sibling ruNNtime checkout, not the production project. Each
producer task names its permitted sibling paths separately: LAZERS' relative
`writeScope` cannot express or enforce those external permissions. Do not bypass
host permission denials. Retain real ruNNtime commits as ordered format patches
and a commit/tree/digest/check manifest under `contributions/runntime/` in the
LAZERS task artifact. Checks must reconstruct the series against its exact base
and compare the resulting tree; hashes or a manifest alone do not prove behavior.
Keep model binaries out of Git. Architect reviews the actual sibling diff and
callers as well as the retained series before integration.

Revised product decision: production and Desktop qualification use quantized
artifacts only. Regular Omni uses the exact published Liquid Q4_K_M model and
Q8_0 projector pinned in the manifest; verified native conversion from those
files is permitted. Floating checkpoints are offline references, not a producer
or Desktop prerequisite. Preserve all prior D1 Q8 and LFM3 commits and receipts;
runtime acceptance alone does not establish independent model qualification.

Prioritize the revised public Omni zoo loader and its chat/transcription/speech
qualification, without a D1 Desktop prerequisite. D1 quantized public zoo/Desktop
remains a separate branch. Combine both for upstream contribution qualification.
The authorized sibling checkout and GPU/Desktop remain exclusive resources;
independent LAZERS-only work may overlap where scopes and native resources allow.
Dependent producer manifests name their predecessor tip. Architect owns composition
and conflicts; workers do not chase a moving integration base.

After the original branch qualification, Architect integrates reviewed upstream
main `79cb8b564c8aec92474ecdedd8101557497e1c6b` (19 upstream-side commits;
diverged history) while preserving D1 work. Later tasks reuse its native
`runntime.quant` safetensors, quant-aware Linear and Python quantizer instead of
inventing a parallel format. Replacement plans preserve the running D1 Q8 attempt;
the paused original plan is not their prerequisite. After its running producer
finishes, review/integrate that exact artifact before retiring the superseded
waiting nodes. Recheck relevant reference behavior after
composition. Public APIs may load caller-provided RangeSource artifacts generated
locally; uploading derivative weights is not authorized by this plan.

## D1 text safety and reference qualification

Make the branch's text decider safe to exercise before public exposure. Establish
pinned Liquid 600M/reference vectors for yes/no, ordered named choice and rubric
probabilities, calibration and actual processed input tokens. Fix owned executor,
output/readback/upload and partial-load cleanup, serialization/disposal races and
explicit overflow rather than silent truncation. Cover rejected readback,
reinitialization and device loss; do not dispose a shared executor belonging to
another model. Run the real branch on WebGPU and retain timings, memory and
device-release observations. This increment does not switch LAZERS routes.

## D1 Q8 public zoo

Deliver a reproducible text-only 600M Q8 ruNNtime artifact and public loader using
`runntime/zoo`, existing RangeSource/LoadOptions and reusable quant kernels.
Preserve checkpoint transforms, special tokens, ordering and temperatures; the
ONNX Q8 export is a parity reference, not an artifact format. Validate packed
weight schema/scales and independent operator/model vectors. Keep incompatible
narrow layers unquantized where necessary. Measure loaded weights and transient
buffers, not merely file size. Consider Q4 only after measured Q8 qualification
and only for a material benefit. Include provenance, exact terms/attribution,
examples, unit/GPU tests and consumer package verification with TypeGPU's pinned
transform. No ONNX Runtime dependency in the zoo.

## LAZERS D1 and Desktop qualification

Qualify retained D1 600M Q8 through the supported packed public zoo loader,
including caller RangeSource, tokenizer, normal load options and the frozen
independent corpus. Reuse the retained loader rather than introducing a second
API; keep original F32 weights and vectors for offline reference comparisons.

Use original floating checkpoints only for offline reference tests. Desktop loads
quantized variants only, including for qualification and fallback. Measure
actual memory during load and inference. For Omni, 1 GB is a comparison point
alongside the earlier 4 GB observation. The measured 1.55 GB chat GPU buffer
peak is acceptable. Record the full pair’s Desktop memory with the functional
results.

Integrate the quantized checkpoint through the existing mailbox, exclusive GPU lease
and verified cache. Supply the lease-owned bounded range reader and cancellation;
preserve typed System One results, explicit overflow and actual model/precision/
revision/input-token identity through task review and GUI. Keep the 2B backend
selectable until qualification passes.

Use the existing owned Desktop from `OPENCODE_DESKTOP_TEST_ROOT`, its native CLI
bridge and supported reopen lifecycle. A fresh native preflight on 2026-11-11
found ready, idle input and a focused visible window; host version is 2.2.6 while
LAZERS peers target 2.2.5. Test compatibility, not just bundle evaluation. Exercise
the rendered decision controls and all three primitives, representative task
reviews, 2,538- and 5,138-token original loss workloads, cancellation, unload,
real device destruction followed by a successful fresh request, and repeated
load/unload. Record cold load, decision latency, heap/weight/transient memory,
renderer responsiveness, quality and retained results. Label unavailable measures
unknown. Do not arm CPU profiling. Historical 4.97 GB heap/crash and 1.57 GB 2B
decoder observations remain historical comparators, not new measurements.

## LFM3 streaming chat

Implement LFM3 separately from D1's bidirectional LFM2 trunk. Pin architecture,
tokenizer, checkpoint and reference contracts against the current Liquid engine.
Reuse the retained public native zoo generation/session API with the published
GGUF source pair specified below, including prefill/decode/cache parity,
streaming order, EOS, context exhaustion, reset, cancellation and disposal.
Prove a packed public consumer on real GPU before Desktop adoption. Original
floating checkpoint 21d75123f86c1f7ffb4bef1ea202710c4e7ebe67 is an offline reference.
Desktop adapters are
a downstream qualification boundary, not a prerequisite for this producer. Retain
the Liquid chat route while qualifying.

## LFM3 audio input and speech

Complete LFM3's public audio operators and quantized projector/codec loading on
the revised public backbone. Preserve original floating assets as offline
references. Compare against the pinned Liquid engine using the same published
files for preprocessing, transcript,
streaming/audio sample behavior, cancellation and cleanup. Do not substitute a
different speech recognizer. Prove installed public consumers on real GPU with
failure/load/device-loss coverage and resource measurements. Actual Desktop
dictation and playback qualification belongs to the downstream Desktop task;
native audio generation alone is not a playback result.

## LFM3 quantized public zoo qualification

Use Liquid AI's published `LFM3-Omni-2B-Q4_K_M.gguf` and
`mmproj-LFM3-Omni-2B-Q8_0.gguf` pair pinned by LAZERS in
`src/webgpu/manifest.ts` as the production source artifacts for regular Omni.
Support them through the public zoo loader. If ruNNtime needs a native
representation, convert from that exact pair and verify the conversion
against Liquid's runtime using the same files. Measure load and inference
memory as well as latency. Verify chat, transcription and speech before
Desktop adoption. Use original floating weights for offline references only.

## LFM3 quantized Desktop qualification

Connect quantized chat, transcription and speech through the existing
LAZERS mailbox/cache/lease and actual isolated Desktop controls. Each route must
have accurate model/precision/revision/usage identities and demonstrate cancellation,
reset/unload, route switching, real device loss and a successful fresh request.
Preserve the original Liquid routes until each replacement qualifies. Native public
zoo/GPU evidence does not replace actual Desktop chat, dictation and audio playback.

## Upstream contributions and combined acceptance

Prepare separate reviewable D1 and LFM3 contributions against current ruNNtime
main, with public exports/registration, examples, tests, model provenance,
license/attribution and documented conversion. Inspect upstream API changes first.
Use pinned pnpm 11.10.0 and supported Node, ruNNtime fixes/typechecks/unit/GPU/
packaging checks; LAZERS uses `bun run verify`, relevant tests and `build:gui`.
Test both as installed package consumers, including the actual Desktop bundle.
Retain upstream review results and submission-ready patches; do not publish model
weights or merge upstream without any required separate authorization.

Combined acceptance requires both quantized public zoo backends running together
in Desktop. Record per-model and combined memory during load, inference and unload.
Use the floating checkpoints only as offline parity references. Existing chat,
dictation and speech must remain usable throughout. Production active sessions,
queues, credentials and model caches are outside this work's mutation boundary.
Automated fixtures supplement but never replace real GPU/native Desktop checks.

### Quality decisions

Freeze a small independent reference corpus before evaluating candidates: all
three D1 primitives, reversed named options, clear positive/negative evidence,
rubrics and representative task reviews. For F32 D1, require probability error
at most 0.001 and exact stable final answers against pinned Liquid. For native
Q8 require per-option absolute probability error at most 0.04, exact winning
answers on clear-margin cases, and normalized rubric score error at most 0.05.
These are this plan's qualification budgets, not claims that community Q8 and
native Q8 are identical. Exceedances return to Architect; do not silently loosen
tolerances or change fixtures. Compare Q8 with both the original and ONNX
references and report differences separately.

LFM3 uses frozen teacher-forced vectors and deterministic chat cases against the
pinned Liquid engine, exact stable greedy-token cases and expected product
answers. Cached native decode must match native full-forward tokens and have
at most 0.001 probability error. Record full numerical differences against
Liquid, with Architect review of any unexplained discrepancy before route
qualification. Transcription must reproduce the words in fixed clean reference
clips (normalizing case/punctuation only). Speech must produce finite nonempty
24 kHz audio, complete real Desktop playback, and recover the requested words
when transcribed by the retained Liquid reference. Also retain comparative
latency/audio quality evidence; no claim of perceptual equivalence follows from
transcription alone. A backend that cannot meet these budgets remains selectable
only as an unqualified candidate, with its existing route retained.

## Source findings

- ruNNtime D1 `decider.ts` currently loses final output handles, omits exceptional
  cleanup/serialization, uses the default executor and silently truncates in the
  prompt packer. Shared gather dispatch also creates untracked uploads. Address
  shared-layer defects only when demonstrated by the scoped model/tests.
- Existing int8/int4 matmul uses signed symmetric group scales and blocked tiles;
  the baseline has no stock quantized Linear, but current main supplies it. The
  scorer's width-one output is incompatible
  with current quantized matmul width requirements. Quantization alone does not
  fix large activation allocations.
- LAZERS `src/webgpu/manifest.ts` pins Liquid LFM3 GGUF revision
  `3d29af2ad166f8299c2d820937e47dc0add20ffc`, engine revision
  `9c2fb176f4c222da394e8037d3c0d0837f70b978`, and current D1 2B ONNX revision
  `2552a495cd0fc6d82f7911110f07bca7a05c11c6`.
- `src/webgpu/system-one.ts`, `task-review.ts`, `runtime.ts`, `files-fetch.ts`,
  `lease.ts`, and `.agents/docs/product-verification.md` define consumer contracts.
- The live tool catalog does not expose `lz-verify-task`. Source
  `src/webgpu/server.ts` explicitly permits ordinary Architect workflow when local
  review is disabled. Record this limitation; it is not a self-review pass.
- Research pins D1 original `02b55d7076f15129e59ab3f94783f32c4b088674`,
  community ONNX `4ebc1b97bf1477485371c79d1cf8d5e4e8eebfa0`, LFM3 original
  `21d75123f86c1f7ffb4bef1ea202710c4e7ebe67`, and LFM3 ONNX
  `d2e656f0bddfaa2b8ebd4bfbe9d88de7897ee592`. Preserve the already-pinned
  Liquid engine as the product comparator rather than silently updating it.
- D1 community Q8 uses asymmetric int8 matmul and int4 embeddings; native grouped
  symmetric conversion must start from original weights. Community probability
  errors are reference observations, not a native acceptance threshold.
- Weight repositories use LFM Open License v1.0, including revenue-based
  commercial terms. Runtime code remains MIT. Keep weight notices, conversion
  attribution and licenses separate; no model-weight redistribution is in scope.
- LFM3 scope here is the requested streaming chat, audio transcription/dictation
  and speech output, not new image/video product controls. Its 24-layer causal
  hybrid backbone, audio encoder, 12-codebook depthformer and LiquidCodec are
  separate implementation responsibilities; D1's trunk is not an LFM3 generator.
