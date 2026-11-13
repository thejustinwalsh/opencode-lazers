# Pinned Liquid audio capture blocker

This is environment evidence, not model qualification. The two synthetic 16 kHz
mono PCM16 clips remain frozen and local as recorded in
`audio-reference-inputs.md`. The pinned engine and exact language/projector
files are present in the approved local cache, but no Liquid transcription,
speech output, or same-file audio comparison was produced.

The reference cache server was launched through the existing Portless proxy
without restarting it. `portless list` registered
`lazers-lfm3-reference.localhost` as an HTTP route on proxy port 1355;
`portless doctor` reported `Mode: HTTP` and explicitly reported that HTTPS is
disabled. Requests to the named route over HTTPS returned HTTP 404 from
Portless, and the default HTTPS endpoint failed its TLS handshake. The server's
HTTP route was not used for model downloads or inference because the required
HTTPS route is unavailable. Restarting or replacing the proxy was not
authorized.

The retained capture harness passed `pnpm --filter runntime exec tsc --noEmit`
and the packed-consumer syntax check with its Liquid test skipped. A direct
focused Vitest run also skipped the Liquid test. These checks do not execute the
reference engine. Audio reference capture, public native audio inference,
same-file parity, speech quality, and complete-pair resource measurements remain
pending.
