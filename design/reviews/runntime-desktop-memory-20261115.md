# ruNNtime Desktop memory — 2026-11-15

Two fresh isolated OpenCode Desktop 2.2.6 instances used the same Mac, pinned
Liquid Omni language Q4_K_M GGUF and audio Q8_0 GGUF, and the same converted
D1-Omni-600M Q8 safetensors. The renderer used one model at a time. Baseline
ruNNtime was `15d64e0`; the optimized run used `68e9e60`. Both builds were
ruNNtime only.

The probe sent “Reply with one word: Hello” through `LocalInference.ask`.
It then called `LocalInference.systemOne` with binary and score questions.
Both builds answered “Hello” (17 input, two output tokens). D1 reported
0.9992196 for the binary answer, score 1.7754995 out of 2, and 77 input tokens.
The optimized build also transcribed the frozen “quick brown fox” fixture and
returned 161,324 bytes of WAV speech from `LocalInference.speak`. The audio
check measured generation; it did not measure speaker playback. In these two runs, the cold Omni request took 34.37 s before and 32.07 s after (renderer poll to completion). The generation stage took 110 ms and 115 ms respectively. Long prompt performance was not measured.

The probe used macOS `footprint` and `vmmap -summary` on the isolated Electron
process tree and owned service. Peaks sampled aggregate `footprint` every
400 ms. Driver-specific counters were not added; “graphics” below is
macOS’s **Owned physical footprint (unmapped) (graphics)** category, not a sum
of explicit WebGPU buffer sizes. After each answer an Electron debugger
queried CDP `Runtime.getHeapUsage`, ran `HeapProfiler.collectGarbage`, and
queried again. The physical snapshots after each response followed this
diagnostic collection. These are single A/B runs, and transient peaks depend
on allocator behavior and sampling cadence.

All values below are decimal MB.

| Metric                                              | Before | After |
| --------------------------------------------------- | -----: | ----: |
| Whole isolated instance, baseline snapshot          |    849 |   866 |
| Omni phase, sampled whole-instance peak             |  4,769 | 3,883 |
| Omni after response, whole-instance snapshot        |  3,291 | 3,093 |
| Omni after response, renderer footprint             |    683 |   457 |
| Omni after response, graphics category              |  1,869 | 1,868 |
| Omni renderer backing storage, before diagnostic GC |    774 |   481 |
| Omni renderer backing storage, after diagnostic GC  |    417 |   101 |
| D1 after response, whole-instance snapshot          |  1,638 | 1,703 |
| D1 after response, graphics category                |    412 |   412 |
| D1 renderer backing storage, after diagnostic GC    |    274 |   274 |
| After unloading, whole-instance snapshot            |    948 | 1,018 |
| After unloading, graphics category                  |     37 |    36 |

`Lfm3CausalLM.transformStateDict` previously bound one `token_embd.weight`
to both CPU `embed_tokens` and GPU `lm_head`. The pinned GGUF stores this
128,000 × 2,048 table as Q6_K. The CPU route held 262,144,000 decoded int8
values and 65,536,000 bytes of float scales, or 327,680,000 bytes total.
The optimized `readGgufEmbeddingRows` reads only the rows needed for each
input and `Lfm3LmHead.transformStateDict` reads one shard at a time. Post-GC
backing storage fell by 316,019,527 bytes without reducing graphics residency.
The profiler also reclaimed transient backing allocations after each answer;
it did not attribute each remaining backing allocation to an individual object.

D1’s `Trunk.embed_tokens` has no tied GPU output head. Its 65,536 × 1,024
FP32 table accounts for 268,435,456 bytes of the 274 MB post-GC backing
storage. It uploads only the input rows; it does not keep a second GPU
embedding table. Omni is released before D1 loads. Keep that default: the
new measurements are for exclusive residency and do not qualify loading
both simultaneously or guarantee a peak below 4 GB with longer prompts.
