# Original LZ135: minimal live recovery evidence

Root's same-view quiet service CPU30.92%→30.16% is inconclusive for total CPU
benefit. The native-performance gate remains held; fixture work counts do not
prove live reuse. Use existing135 and its retained worker for any correction, not
a new task or profiling framework. Root drives actual native observations.

## Existing supported observations

- `lazers.observability.progressDiagnostics` is lookup-only. Its reconstruction
  `get`/`context` counters show actual native reads, not recorder memo reuse or
  append/projection work. It does not create or wake reconstruction. An Architect
  request also samples scheduler totals; do not confuse those with replay work.
- Existing `trajectoryStatus` reads stored progress facts and metadata-only status.
  Relevant `report.progressFacts` and `coverage.workerProgress` before/after an
  ordinary new/late fact can establish projection without inducing a context read.
  Do not substitute `trajectory`, which reads `session.context`.
- Take bounded before/after snapshots around ordinary activity, not a polling loop,
  forced replay, certificate prompt, inference change or temporary profiler RPC.
  Native-read deltas alone still cannot satisfy the missing reuse evidence.

## Smallest necessary implementation

Expose bounded recorder-local work counters through the **existing** reconstruction
diagnostics: memo hits/misses and message projection/recovery append attempts,
with enough fixed-work accounting to avoid implying fingerprinting/reminder work
was eliminated. Distinguish attempts from committed durable changes; omit durable
write counts unless they are transaction-success accurate. Existing stored-fact
reads remain the independent new/late projection check.

Wire a lookup-only recorder snapshot through the actual registered reconstruction
participant. Preserve reset/start/generation and mixed/old participant coverage;
unknown or missing instrumentation is partial/unavailable, never invented zero.
Avoid double-counting one recorder exposed by multiple participants. Fixed bounded
numeric fields only: no histories, bodies, session/message IDs, credentials,
arbitrary labels or unbounded per-session maps. Preserve the existing bounded memo
and all recovery behavior. No new RPC, timer, profiling framework or diagnostics-
triggered recovery. Test real recorder/participant wiring, warm skips, changed/late
facts, rollback accounting, multiple registrations and lookup-only reads.

After reviewed activation, Root compares same-generation diagnostics around normal
cold/changed and warm unchanged reconstruction, observes memo reuse plus reduced
projection/append work, and separately verifies ordinary new/late facts through
`trajectoryStatus`. Record actual coverage/reset boundaries. Report CPU improvement
or lack thereof honestly; counters prove only the work they actually count.

## Scope admission is currently blocked

The original135 scope already permits recorder/tests and this evidence directory.
Additional wiring/tests need `src/progress/native.ts`, `native.test.ts`,
`reconstruction.ts`, `reconstruction.test.ts`, `src/observability/contract.ts` and
`src/observability/rpc.test.ts`; the existing RPC handler spreads reconstruction
diagnostics and does not require a new method.

Supported amendment request `lz135-live-recovery-diagnostics-scope-20261105-v1`
was rejected because active LZ127 (`a683d4bf-ef65-4225-9891-a39237d0ffb6`, plan
`f5deb6cf-1414-4060-a65f-0b29be137450`) reserves the native adapter/test paths.
No amendment was admitted and no135 cancellation/resume or implementation started.
Preserve127,99 and133, their reservations and priorities. Wait for legitimate
scope release; do not invent another registry/wiring path to bypass admission.
The58 ownership transfers remain pending approval.

Root confirmed the research checkout's `09c7e62` caveat is docs-only drift;
`git diff 09c7e62 HEAD -- src/progress src/observability` is empty. The diagnosed
counter gap therefore remains applicable without a source-drift detour.

## Current127 dependency coordination

Root found retained127 tree clean at `633da56`, an ancestor ofmain. Fresh runtime
inspection atversion42 still shows the original attempt running/held because
execution success does not match current `experimental.idle` execution, with all
five effects completed. Source inclusion does not establish completion.

Under Root's direction, current owner `ses_c10fbf89effe4d9f9951e6a26590d7f3`
received keyed instruction context at1793856966659:
`lazers.coordination.lz127.actual-live-dependency-without-certificate.20261105.v1`.
It requests meaningful received-duplicate-start verification, truthful fresh native
and journal facts, and supported same-worker recovery only for actual work while
preserving99. Missing/stale evidence stays unknown; no retrospective certificate,
proof-only inference, source-based acceptance or scope bypass is authorized.

Native readback confirmed the entry and unchanged owner input
`msg_78267ff167e04a5aaf50a169d0678664`. No prompt, ownership or worker mutation
occurred. Consumption, live qualification and reservation release remain
unobserved. This is current127→135 dependency work, not historical replay or an
approved58-plan transfer;135's instrumentation amendment remains unadmitted.
