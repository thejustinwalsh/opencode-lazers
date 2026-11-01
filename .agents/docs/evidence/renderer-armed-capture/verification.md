# Renderer armed CPU capture evidence

## Implemented behavior

- Settings → LAZERS → Diagnostics exposes per-window arm, disarm/stop, and
  current/result status. Status polling does not own capture lifetime; closing
  Settings leaves main-process timers and profiler ownership intact.
- Main process acknowledges `Profiler.enable`, 10,000 μs sampling interval, and
  `Profiler.start` before reporting the capture as armed. Existing DevTools or
  debugger owners are refused without detach. Duplicate arm calls are
  idempotent per window.
- A new job with request and job IDs in the caller window is bound once. Active
  pre-arm jobs, runtime-only events, other windows, and later jobs cannot replace
  it. A job observed during profiler preparation remains an explicit failed
  preparation race.
- Terminal traces, manual stop/disarm, no-job/recording deadlines,
  unresponsiveness, debugger-owner loss, renderer lifecycle loss, and plugin
  cleanup converge on one bounded finalizer. Trigger time, each acknowledged or
  failed CDP command, and debugger cleanup have separate outcomes/timestamps. A
  no-job expiry cannot hide a failed stop; failed detach cannot claim a successful
  capture.
- A timeout or disarm does not cancel a native CDP command. Pending command
  ownership reserves that renderer transport until settlement; explicit retries
  cannot overlap it. Late settlement updates the original capture record only and
  cannot detach a later owner. A late start acknowledgement or failed stop keeps
  the transport reserved until the profiler is confirmed stopped. Disarm does not
  cancel inference.
- Failed armed startup suppresses automatic CDP fallback in that window across
  later unresponsive/responsive events. Other windows and never-armed automatic
  capture remain independent.
- The `.cpuprofile` and `.json` metadata are separate. The metadata records
  window/PID, target request/job, up to 64 ordered stages, trigger time, bounded
  command and cleanup outcomes/timestamps, dropped-stage count, and capture
  outcome. It excludes prompt/context contents, audio, scopes, source text, and
  arbitrary objects.

## Verification

- `bun test src/webgpu/renderer-debug.test.ts src/webgpu/renderer-armed-capture.test.ts src/webgpu/main-trace.test.ts src/webgpu/inference-trace.test.ts` — 35 passed, including no-job stop failure, detach failure, deferred-start/disarm, late settlement ownership, and fallback-suppression regressions.
- `bun run verify` — passed formatting, lint, and strict typecheck.
- `bun test` — 440 passed across 84 files.
- `bun run build:gui` passed before the final profiler-state label change; Vite
  emitted its existing `import.meta` warnings from `onnxruntime-web`. The final
  GUI source was typechecked but not rebundled for this pass.
- The build's `prepare-engine` step verified the pinned engine. The deployed
  Desktop GUI and live profiler were not activated.

## Profile bounds

A local saved DevTools trace was summarized without loading its raw events into
model context. The aggregate contained 507,745 trace events, 5,841 `ProfileChunk`
events, 7,677 CPU-profile node entries across chunks, and 562,754 sample entries.
Its sampling rate differs from the proposed 10 ms armed capture and the chunked
trace is not a standalone `.cpuprofile`; these counts are not treated as a
prediction of the next capture.

The sanitizer now allows up to 8,192 nodes, enough for that observed
multi-thousand-node scale, while retaining the 20,000-sample and 2 MB serialized
profile bounds. The focused regression persists a valid 6,766-node profile below
the byte limit and rejects profiles beyond the node cap. Invalid, empty,
oversized, and persistence-failure cases continue to produce failed outcomes.

No live Desktop inference/profile trial was performed in this implementation
because activating the deployed GUI is outside the task boundary.
