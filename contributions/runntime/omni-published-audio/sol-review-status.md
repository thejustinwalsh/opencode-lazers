# Sol review disposition for the current audio attempt

This note records coverage in the current ruNNtime diff. It is not
qualification or acceptance evidence. The prior published-chat receipt remains
unchanged.

| Finding                                      | Current disposition                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. LFM3 synchronous forward upload ownership | Addressed in source: `Lfm3CausalLM.forward` accepts the session-owned upload list before graph construction, and the runtime destroys that list in `finally`, including when graph construction throws. The focused WebGPU regression test passed in this resumed attempt.                                                                                                                                                                                     |
| 2. Grouped RMSNorm reshapes                  | Not changed. This pass does not expand into the separately queued operator simplification.                                                                                                                                                                                                                                                                                                                                                                     |
| 3. D1 checkpoint-hook transforms             | Not changed; outside the assigned Omni audio composition.                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4. Repeated GGUF tensor-range reads          | Partially addressed in source: Q4_K, Q6_K and Q8_0 component readers share one in-flight range read and decode. Focused tests assert one payload read per chunk in addition to the full-file hash pass. The new packed audio run measured 3,456,883,176 source bytes and 26,542.7 ms complete-pair load plus warm-up, with 1,819,152,568 peak GPU bytes; it did not separately measure host temporary peak memory or isolate chat's reader cold-load behavior. |
| 5. Omni Q4_K MLP gate/up fusion              | Not changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6. LFM3 depthwise-convolution pipeline key   | Not changed; the audio encoder and codec use separate keyed audio execution paths.                                                                                                                                                                                                                                                                                                                                                                             |
| 7. Fused LFM3 logits readback                | Not changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The committed audio implementation includes the native log-mel frontend,
the complete pinned projector schema and reader, the 17-layer audio encoder,
shared-language audio embeddings, 12-codebook depth decoder, embedded
LiquidCodec overlap-add synthesis and public transcription/streaming speech API.
The independent direct-DFT frontend and inverse-DFT/overlap-add codec unit
references pass (20 focused frontend, codec and projector tests); the projector
guard checks the 319 expected audio tensors (including types and shapes) and
rejects unknown entries. Independent audio attention, convolution and depth-
decoder vectors against Liquid remain outstanding.

Packed real-WebGPU runs load the exact published Q4_K_M/Q8_0 pair and the
unchanged frozen 16 kHz clips through CA-verified Portless HTTPS. The public
audio run transcribed both fixtures exactly, generated finite nonempty 24 kHz
speech at depth 1 and depth 3, recovered transcription after queued cancellation
and disposed with no remaining storage buffers. It failed the retained speech
recovery assertion: the native depth-3 WAV transcribes through pinned Liquid as
“The quick brown seas is the sannies.” The pinned Liquid reference itself also
fails to recover either of its own generated utterances after the reference
harness was corrected to resample 24 kHz generated audio to its 16 kHz ASR input
rate. The correction is in sibling ruNNtime commit `4d081aa`; run 20 records the
valid same-file attempt and still fails requested-word recovery. Run 21 repeated
the corrected path for both Liquid-generated audio and the retained native WAV;
both remain nonmatching. See
`evidence/speech-quality-deviation.md`; no weights, clips or recovery assertions
were changed and no playback claim is made.

The full pair measured 1,819,152,568 peak GPU bytes (~1.82 GB), above the 1 GB
optimization target; load plus warm-up was 26,542.7 ms. After disposal no
storage buffers remained, while 519,028 bytes remained in the TypeGPU root
cache. See `evidence/native-speech-diagnostic.md` for the observations and
limitations.

The current ruNNtime source commit and all seven ordered patches are recorded in
`partial-manifest.json`. Applying the series to the recorded `b824c95` base
reconstructed the exact `cf360ee` tip tree; see
`evidence/reconstruction-final.log`. The contribution remains a partial receipt:
the full parity and speech-quality requirements are not met.

The exact pinned language, projector and Liquid engine identities remain in the
partial manifest. Both frozen synthetic clips and generated Liquid/native
samples are retained locally outside Git; their hashes, transcripts and source
route verification are documented under `evidence/`. The initial HTTP-only
Portless blocker is resolved; see `evidence/liquid-audio-reference-capture-blocker.md`
and `evidence/browser-tls-verification.md`. The docs build includes the audio
page under the Zoo topic. The installed-package chat consumer was rerun after
audio composition: the exact Q4 public package streamed and
matched the pinned stable answers, recovered after cancellation, and opened a
second session after disposing the first. The observed result is retained in
`contributions/runntime/omni-published-chat/evidence/composed-public-consumer.md`.
Speech quality and independent operator/reference qualification remain
unresolved, so this contribution remains explicitly incomplete and is not an
acceptance receipt.
