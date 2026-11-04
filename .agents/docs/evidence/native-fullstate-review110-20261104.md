# LZ110: one genuine native full-state review observation

Root explicitly requested one ordinary pending task review on the landed code,
with full state, existing review budget and honest measurement/failure reporting.
No benchmark, worker, synthetic completion or automatic replay was created.

## Real pending work and unchanged input

Continued LZ131's existing review`aea0a98a-03dc-435f-a18a-2ba680a075e9` through the
normal`lz-verify-task` tool. The complete stored task proposal, original request
and all prior evidence were retained unchanged. The native input fingerprint
remained`13cc979cf0c0f02ff5a83a40229e3add4f468abf818d9a7b379203d89a9c1521`.
The retained research evidence is as-of its original snapshot/time, not a new DB
recapture. No text or checklist was trimmed to fit. LZ131 stays queued/unimplemented.

This used the landed110candidate`028c53e` within source landing`a218223` and GUI
build8213c406…, with Root's prior actual newly landed Desktop observations. The
bootstrap candidatecb6d447 is not installed and played no role.

## Content-free native measurements

Passive Desktop main-log capture began at byte1245553 and ended1251352 in
`~/Library/Application Support/ai.opencode.desktop/logs/20261103T155913/main.log`.
It contains12review trace events for **one submitted broker job**, request/job
`579f766a-f8c1-4acc-8375-57bcb4553477`:

| Observation                     | Actual value     |
| ------------------------------- | ---------------- |
| Submitted questions in this job | 16               |
| Polled request character count  | 11,318           |
| Actual packed input tokens      | 2,765            |
| Model context capacity          | 8,192            |
| Session creation / ready        | 2,438 /7,775ms   |
| Tokenize / inputs ready         | 7,804 /7,846ms   |
| Run entered                     | 7,861ms          |
| Device-lost event               | 15,573ms         |
| Dispose / terminal error        | 15,574 /15,577ms |

These elapsed values are the runtime's monotonic request-relative trace, including
loading. The broader orchestration observation window is148,549ms and includes
authoring/tool transport/measurement overhead; **it is not inference latency**.
The packed token count is tokenizer/tensor evidence, not a fabricated successful
usage receipt. The normal tool returned input usage unknown, output tokens0 and
no answers. Error suppressed further batch work; one observed job does not prove
completion of the full checklist or establish a performance improvement.

## Explicit outcome

The normal tool returned unavailable with an actual **OrtRun/WebGPU BufferManager
download failure**: `GPUBuffer.mapAsync` reported that the device was lost before
completion. This is not a semantic review pass, successful GPU recovery or a
driver-Escape interruption. No replay was attempted; the existing chain and its
remaining budget are preserved.

Before/after public reads retained OpenCode2.2.5/PID95968, all six settings true,
and renderer demand false at both boundaries. No service restart, explicit reload,
settings/idle-policy change, profiler activation, lease takeover or forced unload
was performed. The trace's dispose stage is ordinary failed-request cleanup.

Machine-readable start/result evidence is retained in the approved temp directory:
`lz110-fullstate-review131-20261104-start.json` and
`lz110-fullstate-review131-20261104-result.json`. Only allowlisted content-free
trace fields were exported. This records the requested observation, explicitly
failed; it does not supply a semantic pass or silently close110's human gate.
