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
