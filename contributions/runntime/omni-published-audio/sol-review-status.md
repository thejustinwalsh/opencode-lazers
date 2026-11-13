# Sol review disposition for the current audio attempt

This note records coverage in the current ruNNtime diff. It is not
qualification or acceptance evidence. The prior published-chat receipt remains
unchanged.

| Finding                                      | Current disposition                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. LFM3 synchronous forward upload ownership | Addressed in source: `Lfm3CausalLM.forward` accepts the session-owned upload list before graph construction, and the runtime destroys that list in `finally`, including when graph construction throws. The focused WebGPU regression test passed in this resumed attempt.                                                                                          |
| 2. Grouped RMSNorm reshapes                  | Not changed. This pass does not expand into the separately queued operator simplification.                                                                                                                                                                                                                                                                          |
| 3. D1 checkpoint-hook transforms             | Not changed; outside the assigned Omni audio composition.                                                                                                                                                                                                                                                                                                           |
| 4. Repeated GGUF tensor-range reads          | Partially addressed in source: Q4_K, Q6_K and Q8_0 component readers share one in-flight range read and decode. Focused tests passed and assert one payload read per chunk in addition to the full-file hash pass. The retained earlier chat run read 3,579,186,200 bytes; a new full-model cold-load byte/time and temporary-memory measurement has not been made. |
| 5. Omni Q4_K MLP gate/up fusion              | Not changed.                                                                                                                                                                                                                                                                                                                                                        |
| 6. LFM3 depthwise-convolution pipeline key   | Not changed; the audio/model path is not yet integrated.                                                                                                                                                                                                                                                                                                            |
| 7. Fused LFM3 logits readback                | Not changed.                                                                                                                                                                                                                                                                                                                                                        |

The audio contribution is incomplete. Audio source currently includes the
standalone CPU frontend, a metadata/schema-only projector GGUF guard, and a
selected-tensor inventory. The frontend normalization now matches the pinned
Liquid kernel's `(log10(power) + 4) * 0.25` formula, with an independent direct
DFT test. The speech encoder blocks, language-model audio-row integration,
depth decoder, LiquidCodec, public transcription/speech API, fixed same-file
audio corpus and real-WebGPU audio qualification are not implemented. No audio
parity, playback, complete-pair resource, or installed-package audio claim is
made.

The current ruNNtime source commit and ordered patches are recorded in
`partial-manifest.json`. The complete contribution verifier is intentionally
not accepted by this partial receipt; it still requires the pending model
execution, parity, package and resource evidence before a final manifest can be
issued. Applying all three retained patches to the recorded `b824c95` base
reconstructed the current `26ffe2b` tip tree (`evidence/reconstruction-final.log`).

The exact pinned language, projector and Liquid engine identities are also
retained in the partial manifest. Their local source bytes match the pinned
language and projector digests. No fixed clean speech clips or captured
same-file Liquid audio outputs are present in the assigned workspace/cache, so
no transcription or speech parity result is claimed. The public audio encoder,
depthformer and LiquidCodec are not implemented in this source tip.
