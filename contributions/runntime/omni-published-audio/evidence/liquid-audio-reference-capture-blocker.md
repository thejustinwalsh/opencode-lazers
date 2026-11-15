# Initial Portless audio-capture blocker (resolved)

This records the original environment blocker only. At the time of the initial
attempt, Portless exposed the local fixture route as HTTP-only. That route was
not used for model downloads or inference, and no TLS bypass or login-keychain
change was made by this worker.

The blocker was later resolved by registering the existing asset and fixture
servers through the existing Portless HTTPS proxy. CA-verified TLS and exact
hostname SANs were checked immediately before the real-WebGPU capture; see
`browser-tls-verification.md`. The pinned Liquid same-file run then loaded both
frozen clips and produced both 24 kHz speech outputs. Input transcription
matched both requested texts, but Liquid transcription of its own generated
speech did not recover either request. A separate same-file pass also
transcribed the captured native speech and returned a nonmatching transcript.
These are model/output-quality failures, not a current route or TLS blocker;
see `speech-quality-deviation.md`.
