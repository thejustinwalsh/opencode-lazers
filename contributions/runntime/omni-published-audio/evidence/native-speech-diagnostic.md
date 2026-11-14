# Public native speech diagnostic

This is a real-WebGPU packed-consumer diagnostic, not qualification evidence.
The installed `runntime/zoo` entry loaded the pinned language and projector
files, transcribed both frozen clean clips exactly, and produced finite,
nonempty streamed speech. Requested-word speech recovery failed.

Run 9 used seed `1234`, three depth passes, and the request “The quick brown
fox jumps over the lazy dog.” It streamed 69 frames as 70 chunks and returned
5.52 seconds of finite mono PCM at 24 kHz. Measured waveform peak was
`0.5745137929916382`, RMS was `0.06324239459333775`, and no samples clipped.
Retained Liquid transcription of that generated speech returned “The quick
brown seas is the sannies.” The fixed request and clean-input transcripts were
not changed to match the output.

The captured, local-only WAV is
`/private/var/folders/tr/3_qw264x55z9g8391dqb7tb40000gn/T/opencode/lazers-lfm3-native-audio-capture/run-9/native-speech-depth-3.wav`;
it is 16-bit mono PCM at 24 kHz with SHA-256
`f07d75887f14bef29d817a6b152bc55260ce2bce2548a2cd835f97ab64ac3d74`.
Run 14 repeated the same seed/depth and produced the same SHA-256. At depth 1,
the stream stopped after 24 frames/1.92 s and measured peak `0.4352702498435974`
and RMS `0.07026942625398602`; at depth 3 it stopped after 69 frames/5.52 s,
measured peak `0.5745137929916382` and RMS `0.06324239459333775`, and had no
clipped samples. Both depths yielded 24 kHz streamed chunks. Speech generation
latencies were 963.8 ms and 3,274.3 ms, respectively.

The complete pair took 26,542.7 ms to load and warm; the harness observed
1,819,152,568 GPU bytes both loaded and peak (about 1.82 GB), above the
under-1-GB optimization target. It read 3,456,883,176 bytes across model loads.
The test passed clean-clip transcription, queued cancellation, and transcription
recovery after cancellation; after disposal it observed no remaining storage
buffers and 519,028 bytes in the GPU root cache. The latter residual is reported
separately rather than attributed to runner-owned storage.

Pinned Liquid transcription of the depth-3 WAV returned “The quick brown seas
is the sannies.” The pinned same-file reference's own generated-speech
transcription also fails on both clean requests; details and PCM identities are
in `speech-quality-deviation.md`. Do not infer perceptual quality from the PCM
format or ASR output.
