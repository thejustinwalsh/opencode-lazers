# Renderer hang and inference trace

2026-10-31, OpenCode 2.2.5, ONNX Runtime Web 1.31.1.

## Observed

OpenCode window.log recorded an unresponsive renderer at 16:41:23.803 EDT.
A five-second native sample at 16:42:30 captured renderer PID 85242 with a
2.9 GB physical footprint and 8.1 GB peak. The process used about one CPU core
(102.7%). Main-thread samples traverse JS/JIT and V8 object/microtask code;
unsymbolized frames prevent attribution to application functions. This sample
has no `_OrtRun` symbol. It does not establish ONNX, context overflow, GPU
fallback, or a particular reactive component as the cause.

The original native logs remain in
`~/Library/Application Support/ai.opencode.desktop/logs/20261031T193533/`.
The preserved [native sample](renderer.sample.txt) is specific to this incident;
prior freeze exports describe different incidents. ORT warnings at 16:37:40
reported CPU placement for some nodes; they are not failure evidence and do not
establish that those nodes caused this hang.

Three real workers were stalled on pending native build, source-read and edit
permissions while the UI was unresponsive. Those requests were allowed once
through the supported permission API; no permanent policy was broadened.

## Instrumentation

Bounded, content-free events go through the supported GUI IPC into Electron's
main-process info log. Correlation uses request/job/window IDs, stages and timings,
configured execution provider, memory, lag, input sizes, output sizes and error class.
Main-process window events retain the last received request and stage when the
renderer becomes unresponsive or exits. A stage marker is flushed before model
loading, generation and direct ORT execution. Prompts, audio and generated text
are excluded. A failed diagnostic write does not fail inference.

The direct decision path records actual token count and tensor shape before
`session.run`, including the existing 8,192-token rejection. The chat/speech
engine uses its existing 4,096-token configuration; its usage count is available
after generation, not before the engine's internal prefill. A hung chat generation
therefore leaves a stage and character count, not a proven actual token count.
Renderer lag is reported only when the event loop resumes; main-process window
events remain independent of that loop. GPU execution attribution stays unknown
unless actually observed. This change does not disable inference, change provider
selection, alter context limits, move inference, or claim a freeze fix.

Validation: full suite 229 pass, 0 fail, 2,303 assertions; native formatter, lint,
strict typecheck and GUI build pass. Native activation and actual trace capture are recorded below.

## Runtime interpretation

WebGPU kernel execution does not eliminate CPU/WASM graph control, tokenization,
allocation or data movement. The built-in WASM proxy flag does not support WebGPU;
a developer-owned dedicated Web Worker can load ORT and use WebGPU. These are
different mechanisms. Long local prefill and memory pressure remain hypotheses.
The pinned `/webgpu` bundle uses the native WebGPU EP and does not expose the
JSEP profiling callback implemented in `/all`; do not claim per-op provider evidence
from that unsupported callback.

Primary sources:

- [ORT environment/session options](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
- [ORT WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)
- [ORT performance diagnosis](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
- [Native WebGPU migration](https://github.com/microsoft/onnxruntime/blob/main/docs/design/onnxruntime_web_jsep_to_webgpu_ep_migration.md)

## Native trace observation

Used OpenCode's native Relaunch action after preserving the hang sample. Desktop
recovered and loaded the built plugin. The main-process log recorded chat model
`session-create` and `session-ready`, then a single built-in typed-decision check
through Desktop's LAZERS settings. All feature toggles remained enabled.

Request `a4d21319-f60d-4ac8-ab2b-807315b62a99` recorded **33 input tokens** against
the existing **8,192-token** decision limit, input shape `[1,33]`, ORT run/readback,
output shape `[1,128000]`, disposal and successful completion. Run-to-readback took
about **470 ms**; total request time including switching/loading was **6.377 s**.
One **1.131 s** renderer-lag event was captured during the request. Completion
reported approximately **1.93 GB JS heap** against a **4.40 GB heap limit**.
Configured provider is WebGPU; operator attribution remains unknown.

[Content-free native trace](native-trace.log) · [Desktop result](native-decision.png).
This verifies that the new metadata reaches the independent persistent log through
a real native inference request. It is a diagnostics smoke check, not a model
benchmark or reproduction/fix of the earlier freeze. Main Architect and original
worker sessions remain active; the native task-menu worker reached verification.

## Next-freeze debugger capture

Prepared automatic, local capture using Electron's public
[webContents debugger transport](https://www.electronjs.org/docs/latest/api/debugger).
On the first unresponsive event in a freeze period, the main process attaches,
starts a **500 ms CPU profile**, and detaches in cleanup. CDP commands have a
**2 s total deadline**. A responsive event permits capture of a later freeze.
Existing DevTools or another attached debugger is left untouched. No listening
port, continuous profiler, renderer pause, runtime evaluation or inference setting
change is introduced.

Successful captures save a standalone `.cpuprofile` and a small correlation JSON
under `~/.local/share/opencode/plugins/lazers/diagnostics/`. Main logs name the
artifact and retain window/PID/request/job/last-stage correlation. CPU profile
nodes retain call-tree links, sampled node IDs, timing, script IDs and source
locations; unknown line/column remain -1. Invalid or oversized profiles are
reported rather than silently truncating samples and corrupting timing. Local
variables, scope objects, script bodies, prompts, audio and model output are not
requested; source URL query/hash and data URLs are excluded.

Native activation was observed in the main-process log at **17:05:48 EDT**,
including the diagnostic directory, 500 ms duration and 2,000 ms deadline. A
subsequent GUI build carries the final profile validation/error cleanup. No
production hang was deliberately induced while workers were active. Capturing
the next actual hang remains an observation, not a completed diagnosis. If the
inspector cannot answer during a deep native hang, the failure/timeout is logged
and native process sampling remains the fallback.

Validation: **241 tests passed, 0 failed, 2,357 assertions** across 50 files;
focused debugger/lifecycle tests, native formatter, lint, strict typecheck and
GUI build pass. Tests include profile graph/sample consistency, preserving -1
locations, existing-inspector skips, stop timeout, active abort, failed artifact
writes and once-per-freeze hookup.

## Healthy native network baseline — 2026-11-01 15:24 UTC

Root opened Desktop's own View → Toggle Developer Tools and inspected Console
and Network while the real roadmap workers ran and the mounted Trajectory
remained on historical LZ-9. This was normal product use, not an inference
benchmark or a reproduced freeze. No runtime code, inference settings, service,
listener or debugger flag was changed.

The Console retained historical removed-worktree 404s and WebGPU bridge 500s;
those entries do not establish a current failure. Current visible Network rows
for bridge poll/settings and observation snapshot/trajectory returned 200. The
captured visible-row sample contains no 4xx/5xx. Repeated unchanged-task reads
showed about 586 kB decoded / 48.5 kB transferred for snapshot and 219 kB decoded /
31.3 kB transferred for trajectory. This is a real pre-LZ-36 payload baseline,
not proof of native-context call counts, sustained throughput or a CPU-hang cause.
[Captured request/status/size rows](native-network-baseline.txt) contain no
request headers, response bodies, transcript text or console inline bundles.

Developer Tools was then closed and the full Desktop layout restored. The existing
automatic unresponsive-event profiler is intentionally skipped while DevTools is
open, so leaving it closed preserves that route. The current main-process log
`20261031T205316/main.log` at 10:09:15.816 local recorded the deployed diagnostics
directory, 500 ms profile and 2,000 ms deadline. No later unresponsive/debugger
capture was found in this inspection; the diagnostics directory is still absent
(it is created on capture). Do not turn this healthy observation into a freeze
fix claim. The next actual freeze still needs its correlated native evidence.

## Native pagination regression baseline — 15:30 UTC

With the same historical LZ-9 trajectory mounted and real workers continuing,
Root opened Check output: its receipt/stdout content remained visible after a
six-second interval. That disclosure path did not reproduce a reset.

Root then closed Check output, expanded Activity and scrolled its inspector.
The native accessibility tree exposed 50 Activity event toggle rows and Load more
activity. Clicking Load more exposed 99 rows. After a six-second observation
interval and a fresh complete native accessibility read, it had returned to 50
rows, with Activity still expanded and Load more still present. No task/scope
change or manual recapture occurred. Historical `read · error` event labels were
old task data, not evidence of a new network error.

This reproduces loaded-history loss across ordinary refresh on the deployed
pre-LZ-36 implementation. It does not establish why the intermediate row count
was 99 rather than 100, a complete page-union proof, or a renderer freeze cause.
LZ-36 already targets this stability issue; this observation adds a real native
before case rather than changing its scope or creating another task.

## Real local-review device-loss case — 2026-11-01

A real Architect review, ID `a2bad597-ad99-45aa-b240-c128e7062a5d`, returned an
ORT buffer-download failure: device lost before MapAsync completed, status 4.
The local trace for request/job `324b3c9e-485a-45c6-9254-d0ba5a8004f8` records
2,078 actual input tokens, shape `[1,2078]`, three questions and configured
8,192-token capacity. At 10:31:20.864 local it entered run; at 10:31:25.903 it
recorded error, about 5,045 ms total, with approximately 2.06 GB JS heap against
4.40 GB limit. Configured EP is WebGPU; observed operator EP remains unknown.
The tool reported partial aggregate usage and no semantic pass, then requested a
bounded retry of the same review. This is not a context-overflow error or proof
of the historical renderer-hang cause. Desktop was responsive/Ready when Root
inspected it; no new unresponsive capture was observed.

Existing code already owns a fresh decision GPUDevice and registers its lost
promise in `src/webgpu/decision-runtime.ts:56-99`; `src/webgpu/runtime.ts:216-281`
already marks loss, aborts without replay and attempts model recovery. Do not
claim loss handling is absent or replace it without evaluating that code.

Current primary-source research, checked 2026-11-01:

- The [WebGPU specification](https://gpuweb.github.io/gpuweb/#devices) says loss
  invalidates a device and resources created from it; its recovery example obtains
  a new adapter/device and recreates resources. The loss message is descriptive,
  not a machine-readable reason to parse. This establishes lifecycle semantics,
  not why this device was lost.
- [ORT WebGpuFlags](https://onnxruntime.ai/docs/api/js/interfaces/Env.WebGpuFlags.html#device)
  documents device access and providing a device before the first session.
  Installed `onnxruntime-common/lib/env.ts` exposes matching getter/setter types;
  any dependency-specific recovery change still needs the pinned implementation.
- [ORT issue 33753](https://github.com/microsoft/onnxruntime/issues/33753) reports
  single-pass prefill/device loss on iOS Safari and an application chunking
  workaround. It is a reporter's platform-specific case, not evidence that its
  watchdog explanation or token threshold applies to this Electron/Mac incident.
- [ORT issue 32257](https://github.com/microsoft/onnxruntime/issues/32257) documents
  a separate custom-device synchronization defect closed by 32259. A similar
  buffer-download label alone does not identify this case or justify changing
  the working provider/stack.

No recovery, model, provider, context-capacity or inference setting was changed
by this inspection/research. The new case should inform the existing scoped
responsiveness investigation; its result remains unproven.
