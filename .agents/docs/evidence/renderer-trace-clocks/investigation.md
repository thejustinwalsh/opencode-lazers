# Renderer trace clocks — independent investigation

Native read-only investigation `ses_e684cfd22ffeA75L4NDI0b8iwj` inspected main
`f7a2aa5` on 2026-11-01. Relevant WebGPU sources still match publication
`d69d301d-1a68-47cd-a063-846b9bba5ea8`; no refresh or inference was needed.

## Cancellation and causal boundary

LZ-14 and its parked refactor remain cancelled. Nothing was restored, built,
deployed, reloaded or redispatched. Settings, providers, models and execution
placement were not changed. The responsiveness goal is still open; the old
`_OrtRun` frame does not prove WebGPU failure or justify that abandoned refactor.

As of 15:26 UTC, the documented diagnostics directory
`~/.local/share/opencode/plugins/lazers/diagnostics` was absent. The current
Desktop log directory was
`~/Library/Application Support/ai.opencode.desktop/logs/20261031T205316/`.
Sanitized trace inspection found continued inference completions and lag records,
but no matching LAZERS unresponsive/debugger capture/process-gone records or newer
causal profile. Completed inference does not prove responsiveness. Idle lag also
cannot distinguish main-thread blocking from suspension/timer throttling.

## Proven diagnostics defect

`src/webgpu/inference-trace.ts:41–44` defines elapsed time from request start and
delta from the preceding event. `InferenceTraceSpan` implements those clocks at
lines 218–289. However, `src/webgpu/runtime.ts:636–654` writes lag events directly:
an active request ID receives elapsed time from runtime startup, and delta is the
lag magnitude rather than the interval since the preceding request event. The
next span event ignores that lag event when computing its own delta.

The retained sanitized fixture
`evidence/034-renderer-trace/native-trace.log:93–138` contains one request with
elapsed times `tokenize: 5822`, `renderer-lag: 136831`, `inputs-ready: 5868`.
This clock mixing is independently visible in code and recorded output. It is
not evidence of a freeze cause or an inference-engine defect.

The bounded correction should give each request one timeline, retain lag magnitude
in `rendererLagMs`, distinguish idle/runtime events and avoid reviving a completed
request during asynchronous trace delivery. Fake clocks must exercise the actual
production lag path, not just call the already-correct span in isolation. The
existing isolated renderer fixture is `test/webgpu-runtime.fixture.ts`; its mocks
must not leak into other tests. Keep this correction separate from LZ-14.

## What remains unknown

Stage intervals include trace IPC/scheduling latency; `queued` begins after broker
polling, not at admission. Decision `run`/`readback` does not isolate GPU kernel
time. Chat generation has only broad stage boundaries. Lag is reported after the
renderer timer runs again. Main's last received stage may be stale or an idle lag
marker and is correlation, not attribution. CPU captures, if present, sample only
their own post-unresponsive window. No latency improvement is claimed here.

Observe only ordinary authorized activity for the next causal investigation.
Read fixed trace fields and any already-produced automatic capture; sanitize URLs
and omit prompts/audio/source payloads. Match receipt order, request/job/window/PID
and the profile window. Missing/skipped/timed-out capture remains a limitation;
do not induce a hang, attach a new live profiler or change settings under this
read-only investigation. A freeze repair requires a matched incident or a
deterministic reproducer first.
