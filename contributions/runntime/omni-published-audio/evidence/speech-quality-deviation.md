# Same-file speech quality deviation

Pinned comparison used Liquid engine revision
`9c2fb176f4c222da394e8037d3c0d0837f70b978` (bundle SHA-256
`77821949412f5dd6d60e37f22415f0e71454e65f6a73928529c6fbec0f2cf2cb`) and the
exact Q4_K_M/Q8_0 source pair recorded in `partial-manifest.json`. The two
frozen clips, their bytes, and expected words were unchanged. The verified
Portless certificate route/SPKIs are in `browser-tls-verification.md`.

The packed Chromium Liquid run correctly transcribed both clean 16 kHz inputs:

| Request                                        | Liquid input transcription                     | Result                                           |
| ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| “The quick brown fox jumps over the lazy dog.” | “The quick brown fox jumps over the lazy dog.” | Exact words after case/punctuation normalization |
| “Please turn left at the next street.”         | “Please turn left at the next street.”         | Exact words after case/punctuation normalization |

Liquid streamed finite, nonempty 24 kHz audio with seed `1234` and depth
temperature `0.4`; the emitted frames were retained outside the repository.
The first same-file transcription attempt (run 19) passed those 24 kHz samples
directly to a path that expects 16 kHz. Its transcripts were not valid recovery
evidence and are superseded below. The harness now uses the existing
`resampleAudio` helper before pinned Liquid transcription; the fixed source
clips, generated waveforms, and requested words are unchanged. This correction
is committed in sibling ruNNtime commit `4d081aa` and retained as patch 0007.

The corrected packed Chromium run 20 again transcribed both frozen 16 kHz
inputs exactly and generated the same 24 kHz waveforms (same byte hashes as run
19). It then resampled each generated waveform to 16 kHz for same-file
transcription. Requested-word recovery still failed:

| Request                                        | 24 kHz samples / duration | PCM SHA-256                                                        | 16 kHz ASR samples | Liquid transcription of generated speech                           |
| ---------------------------------------------- | ------------------------: | ------------------------------------------------------------------ | -----------------: | ------------------------------------------------------------------ |
| “The quick brown fox jumps over the lazy dog.” |          107,520 / 4.48 s | `4f9d6f596c0da1ce3e6ccf30ecf9ff05a7517c3583082b7a831844abf534da12` |             71,680 | “The recording is completely silent.”                              |
| “Please turn left at the next street.”         |          216,960 / 9.04 s | `ec4b0c812bce03d599b739ed058b68e0f6e2a47e4c7045608852477dbb852515` |            144,640 | “The electric buzzing of a machine is constant in the background.” |

The float32 waveforms were finite and nonempty, but quiet: peak/RMS were
`0.006935/0.001806` and `0.015184/0.002877`, respectively. Those level
measurements do not establish audibility or perceptual quality. The WAVs remain
in the approved local capture cache, not in this contribution. The corrected
run log, including the exact 16 kHz sample counts and transcripts, is
`liquid-audio-reference-run-20.log`.

Run 21 repeated the corrected same-file check and also loaded the retained
native depth-3 capture through the pinned Liquid transcriber. It resampled the
native 24 kHz PCM16 file to 88,320 samples at 16 kHz; the transcript remained
“The quick brown seas is the sannies.” The Liquid-generated waveforms and their
nonmatching same-file transcripts were identical to run 20. This single run
confirms that both generated-speech paths fail under the properly rate-matched
reference input path; see `liquid-audio-reference-run-21.log`.

Run 23 tested whether low level alone explained the failures, without changing
the retained WAVs or the acceptance input. The opt-in diagnostic scaled each
Liquid output to a fixed RMS of `0.1` (about -20 dBFS), resampled it to 16 kHz,
and ran the same pinned Liquid ASR. The adjusted peaks were `0.3839` and
`0.5279`, so neither diagnostic input clipped. The resulting transcripts were
“The silence is broken by a single, very quiet, low-frequency hum.” and “An
engine is running with a steady hum in the background.” Neither recovered the
requested words. This rules out simple low RMS as a sufficient explanation;
it does not identify the codec/depth-decoder cause. The diagnostic is disabled
by default and the raw-PCM recovery assertion remains unchanged. See
`liquid-audio-reference-run-23.log`.

The native public WebGPU run generated 132,480 samples (5.52 s) at 24 kHz for
the first request, using seed `1234` and three depth passes. Its PCM16 capture
has SHA-256
`f07d75887f14bef29d817a6b152bc55260ce2bce2548a2cd835f97ab64ac3d74`, peak
`0.5745137929916382`, RMS `0.06324239459333775`, and zero clipped samples. The
retained pinned Liquid model, given this captured WAV resampled by the public
`resampleAudio` helper to 16 kHz, returned “The quick brown seas is the
sannies.” rather than the requested sentence. Run metadata and the capture
path are recorded in `native-speech-diagnostic.md`.

At that checkpoint, generated-speech recovery was unresolved. Corrected runs
26 and 27 below supersede that result: the corrected prompt framing and matched
depth-sampling controls recover the requested words through the retained Liquid
transcriber and public packed consumer. The earlier failure logs remain
historical and were not altered.

## Superseding prompt/sampling runs 26 and 27

The pinned reference run 26 used the unchanged source pair and same-file Liquid
engine above. ASR used the documented `Perform ASR in English.` system message
and audio-only user content. TTS used the documented `Perform TTS in American
English using a female voice.` system message and the unmodified requested text
as user content. The assistant audio-start marker occurred once. Depth controls
were seed `1234`, temperature `0.4`, repetition penalty `1.2`, repetition
window `64`, and the default `[4, 4, 4]` reveal schedule.

Both frozen input clips again transcribed to their exact expected words after
case/punctuation normalization. Liquid-generated 24 kHz speech was resampled to
16 kHz before same-file ASR; both requests were recovered:

| Request                                        |                      Liquid 24 kHz output | Liquid same-file transcription                 | Output SHA-256                                                     |
| ---------------------------------------------- | ----------------------------------------: | ---------------------------------------------- | ------------------------------------------------------------------ |
| “The quick brown fox jumps over the lazy dog.” | 76,800 samples / 3.20 s; 41 speech frames | “The quick brown fox jumps over the lazy dog.” | `9d2656622e96daf1a68a36405d6f4ca1ec83c1cbb5d4ec446630c5e969ceb5ad` |
| “Please turn left at the next street.”         | 55,680 samples / 2.32 s; 30 speech frames | “Please turn left at the next street.”         | `751feb32d16b26e1b3abd21ff1cb89bc1df7a9811ed4c24fd146aed9943476a6` |

Run 27 exercised the installed package's public `createLfm3Audio` consumer on
real Chromium WebGPU with the same pair. The two unchanged clips transcribed
exactly. With seed `1234`, the depth-3 stream generated 84,480 finite samples
(3.52 s) at 24 kHz in 45 chunks over 44 frames, with peak `0.4583`, RMS
`0.06324`, and no clipped samples. Its 16 kHz same-file transcription recovered
“The quick brown fox jumps over the lazy dog.” The depth-1 comparison generated
80,640 samples (3.36 s) in 43 chunks over 42 frames; its peak was `0.5109` and
RMS `0.06849`. The depth-3 PCM16 capture SHA-256 is
`78a653baeb471a729f93525b9c0fc1182ddcdbd95fc996dafeb58284fe411511`; depth-1
is `f0ad978cd0d526d615dffe812f1e9ed191a49259fd534348f3f0aa6ccc713a0b`.
Abort recovery then transcribed “Please turn left at the next street.”

The public run measured 27,011.4 ms to load and warm up; cumulative source reads
were 3,456,883,176 bytes, loaded and sampled peak GPU memory were both
1,825,200,572 bytes, and unload left no live storage buffers (518,496 bytes
remained in the TypeGPU root cache). The `<1 GB` model-size target was therefore
not met; the exact published pair was retained.

These runs supersede the prior word-recovery failures but do not establish
perceptual equivalence, natural-speech generalization, Desktop playback, or
broad seed/depth audio quality. Raw WAVs remain in the approved local capture
cache and are not included here. Detailed prompts, source identities and
per-run results are retained in `run-26-results.json` and `run-27-results.json`;
operator metrics are in `audio-operator-reference-run-30.json` and
`audio-operator-reference-run-30.md`. `partial-manifest.json` links the results
and keeps the separate language-logit and audio-attention/convolution checks
explicitly pending.
