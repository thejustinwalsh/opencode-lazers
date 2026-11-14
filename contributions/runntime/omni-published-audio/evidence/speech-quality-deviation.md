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

The native public WebGPU run generated 132,480 samples (5.52 s) at 24 kHz for
the first request, using seed `1234` and three depth passes. Its PCM16 capture
has SHA-256
`f07d75887f14bef29d817a6b152bc55260ce2bce2548a2cd835f97ab64ac3d74`, peak
`0.5745137929916382`, RMS `0.06324239459333775`, and zero clipped samples. The
retained pinned Liquid model, given this captured WAV resampled by the public
`resampleAudio` helper to 16 kHz, returned “The quick brown seas is the
sannies.” rather than the requested sentence. Run metadata and the capture
path are recorded in `native-speech-diagnostic.md`.

This is a confirmed, unresolved reference-quality failure, not evidence that
the native output is equivalent to Liquid. No weights, clips, precision,
codec, or recognition model were substituted. The current public audio GPU
test deliberately keeps the requested-word recovery assertion and reports the
seed/depth, waveform metrics, and stream accounting before failing that
assertion. Return the unexplained difference to Architect; do not claim speech
qualification or Desktop playback qualification.
