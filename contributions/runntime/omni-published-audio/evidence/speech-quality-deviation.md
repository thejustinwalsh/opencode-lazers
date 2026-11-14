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

Liquid then streamed finite, nonempty 24 kHz audio with seed `1234` and depth
temperature `0.4`; the emitted frames were retained outside the repository.
The same pinned Liquid transcription path did not recover either requested
sentence:

| Request                                        | Samples / duration | PCM SHA-256                                                        | Liquid transcription of generated speech                       |
| ---------------------------------------------- | -----------------: | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| “The quick brown fox jumps over the lazy dog.” |   107,520 / 4.48 s | `4f9d6f596c0da1ce3e6ccf30ecf9ff05a7517c3583082b7a831844abf534da12` | “The audio is completely silent.”                              |
| “Please turn left at the next street.”         |   216,960 / 9.04 s | `ec4b0c812bce03d599b739ed058b68e0f6e2a47e4c7045608852477dbb852515` | “The static hum of an appliance is audible in the background.” |

The float32 waveforms were finite and nonempty, but quiet: peak/RMS were
`0.006935/0.001806` and `0.015184/0.002877`, respectively. Those level
measurements do not establish audibility or perceptual quality. The WAVs remain
in the approved local capture cache, not in this contribution.

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
