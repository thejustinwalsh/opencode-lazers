# Published Q4 public chat after audio composition

On 2026-11-13, packed-consumer run 18 imported only the installed `runntime/zoo`
entry, loaded the exact Q4_K_M source at revision
`3d29af2ad166f8299c2d820937e47dc0add20ffc`, streamed text, and passed on real
Chromium WebGPU. The run used the existing Portless HTTPS asset route; its CA,
hostname and SPKI were checked immediately beforehand and the server returned
HTTP 206 for the pinned GGUF range.

The passing run exercised a caller-provided `RangeSource`, partial-load abort
and cleanup, warm-up abort after complete weight upload and cleanup, load
progress, stable Liquid reference answers (`42`, `Paris`, `Blue`),
streaming/result agreement, cancellation and recovery in the same session,
disposal, then a new public chat session and generation after the first session
had disposed the shared executor. Partial-load and warm-up aborts both rejected
with `LOAD_ABORTED` and left zero new storage buffers. The subsequent session
returned nonempty streamed/result text. The source test no longer imports private
`src/core` paths, so the packed consumer reaches inference rather than failing
during module resolution.

Observed metrics for run 18:

- Packed Vitest: 1 test passed, 0 failed; test duration 68,501 ms.
- First successful model load plus warm-up: 19,127.8 ms; first and second
  requests: 284.2 ms and 133.0 ms.
- Source reads over four model loads (partial abort, warm-up abort, first
  successful session, post-disposal session): 8,603,380,320 bytes. First-load
  progress completed `1,306,420,224 / 1,306,420,224`.
- First-load GPU buffers: 1,535,385,996 bytes; sampled peak:
  1,547,757,452 bytes. Sampled peak JS heap was 1,679,978,877 bytes; host JS
  heap after first load was 1,065,367,137 bytes.
- Stable Liquid answers matched exactly. The first ordinary request returned
  “Hello! How can I help you today?”; the second returned “Goodbye!”; the
  post-disposal shared-executor request returned nonempty text.
- After the second session disposed, zero new storage buffers remained;
  TypeGPU retained 229 root-cache buffers totaling 515,332 bytes.

The report covers the text backbone, not the audio projector/depth decoder/
codec, and does not establish Desktop playback. It is evidence for the composed
public chat API and its package boundary only. Earlier run 17 also passed before
the abort-path probes were added; run 18 supersedes it for current source.
