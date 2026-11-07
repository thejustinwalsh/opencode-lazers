# Live dogfood follow-through — 2026-11-07

## Runtime and delivery

Native readback at Unix 1794064489043: original LZ-174 worker
`ses_5210fab90d3745959a4d269dbd6ab744` is active on OpenAI Luna Max. Main
Architect remains OpenAI Sol High. Original LZ-173 worker completed corrected
candidate `0b289721647eddafa8e5d9bba4f5ce2daf945811`; independent Luna source
review found no material findings. Its native acceptance/binding remains open.

LZ-174 corrects the reviewed task-disposition race and adds recovery-command
fence regressions, in its original attempt/tree. LZ-175 is queued at priority105
behind LZ-174 priority110. It supplies the missing immutable repaired-candidate
binding for retained verification. Original LZ-172 UI work remains held, not
discarded. See the three task-specific Nov7 review records for the precise gaps.

The native plan snapshot still has Tasks148/149 and architecture170/171 queued;
Radar/Trajectory160/161 are draft. Several previously accepted Models plans
await real connected UI acceptance. This is incomplete delivery, not a completed
roadmap. Runtime prerequisites/reservations determine actual dispatch eligibility;
priority alone does not prove a task could run now.

## Current performance observations

After canonical LZ-129 source activation, a 3-second event subscription at Unix
1794064517588 saw **27 observability events / 27 distinct complete identities**.
Every returned identity appeared once at one location. The earlier Nov6 sample
had 435 events /319 complete identities and five copies across five locations.
These are different active workloads, so this is observed absence of duplication
in this sample, not a controlled throughput comparison or proof for every branch.

A separate 12.039-second CPU window, Unix1794064566738–1794064578778, with the
Trajectory panel visible and the recovery worker active, measured:

| Process          |   PID | CPU seconds | Mean percent of one core |   RSS KiB |
| ---------------- | ----: | ----------: | -----------------------: | --------: |
| OpenCode service |  3219 |        5.06 |                   42.03% | 1,459,136 |
| Desktop renderer | 35091 |        1.76 |                   14.62% |   378,160 |
| GPU helper       | 35087 |        4.54 |                   37.71% |    69,552 |

Source: cumulative process CPU counters, existing temporary measurement helper;
raw window retained in `/private/tmp/lazers-panel-cpu-windows-20261104.jsonl`.
No controlled before/after, quiet-idle baseline, battery result or causal stack
attribution follows from this window. Residual CPU remains a live issue. Keep
the existing performance lane open; do not call LZ-129 whole-system performance
acceptance complete from publication deduplication alone.

Root also captured a passive 3-second macOS `sample` of the same service PID3219:
`/private/tmp/lz-service-active-sample-20261107.txt`, starting10:19:36.926EST.
Most JavaScript/native executable frames are unsymbolized. Some SQLite work is
visible, but this does not identify a responsible JS caller or establish SQLite
as the dominant cause. Reuse this capture where useful; source-level attribution
needs stronger evidence than unsymbolized stacks.

## Observed Tasks activity discrepancy

With Project/State:All and the search cleared, Desktop Tasks displayed LZ-174 as
`Running / Worker Unknown` on consecutive observations. The public
`lazers.tasks.currentActivity` RPC at Unix1794064925842 returned the exact original
task49dbfe29/attempt0375ef98/session5210fab9 as `foreground: active`,
`unknownReason: null`, `waiting: false`, zero pending permissions/forms.
Subsequent Desktop observation still showed Unknown. Native session.active also
confirmed the worker running, and its checkout gained runtime and test edits.

This establishes a UI/projection discrepancy, not a stalled worker or a native
idle completion claim. Investigate existing Tasks activity refresh/cancellation
before adding another producer: `panel-state.ts` clears requested activity before
observation and rejects responses when listRequest changes. Frequent ordinary
list updates may starve the activity response; that mechanism remains a hypothesis
until reproduced. Use existing Tasks147/149 work where appropriate, preserving
real lifecycle/background uncertainty separately from observable foreground work.

## Inference recovery

Canonical `8975516` repairs process-scoped cache ownership. Native chat and d1
requests succeeded, followed by another successful chat request after fully
quitting/reopening Desktop with d1 loaded. Six switches and downloaded files
were preserved. Detailed regression and native outcomes are in
`inference-lease-lifecycle-20261104.md`. This does not establish renderer freeze
resolution or every LZ-165 navigation branch.

## Next observations

Review corrected LZ-174, integrate and activate through the native flow, then
recover original172 and qualify corrected173 using175. Exercise connected pricing
and approved narrow/wide Models interactions before recording acceptance. Check
Tasks148/149 eligibility and independent roadmap work through Architect rather
than treating Models holds as a global freeze. Capture attributable residual CPU
in the existing performance lane; keep source publication/navigation/scope
verification and CPU acceptance separate.

## LZ-182 scheduling read before integration

Root invoked the actual candidate TaskSchedulingRead against the real project DB
read-only at1794092767945/1794092768103: first-page reads took235.88ms/157.28ms,
covering149plans/175nodes/13reservations; each returned94025bytes for100plans.
Repository revision changed1024644→1024649 under active native work. This is two
observations, not a benchmark or invented target. The fresh-page path rebuilds
inside a read-only transaction and calls synchronous Git ancestry operations;
its cache only serves cursor pages. Native Architect attached advice2 to the
SAME182worker to keep hot reads responsive and reuse unchanged scheduling/source
work without weakening dispatch freshness. No new task, hashes or polling were
introduced. Improvement has not yet been measured. Reproduction script:
/private/tmp/lz182-read-performance-observation.ts.
# Updated Tasks candidate observation

At Unix ms 1794094403548/1794094403607, Root reran the same real project read-only scheduling observation against LZ-182's updated asynchronous candidate, awaiting the result. First page: 121.76 ms cold, 58.21 ms repeated. Earlier candidate readings were 235.88/157.28 ms. Workload coverage remained 149 plans, 175 nodes, 13 active reservations; first page 100 plans / 94,025 bytes. Repository version was 1037842 for both updated reads.

Work counters demonstrate actual reuse: two fact captures but one projection build, one projection cache hit and three total prerequisite-proof evaluations. Git commands increased four to six: the repeated read still observes branch/HEAD but does not repeat prerequisite evaluation. This is a small read-only sample against an active project, not a controlled CPU/battery benchmark or final native UI acceptance. The updated candidate remains in its original worker checkout and is not yet integrated. Native worker checks at this boundary passed seven scheduling-read tests / 47 assertions, seven selected scheduling/runtime/UI tests / 153 assertions, and automatic formatting/lint/type checks. Full relevant completion checks remain the worker's responsibility.

Observation script: `/private/tmp/lz182-async-read-performance-observation.ts`. No production DB writes, model calls or listening server were used.

## Tasks transient-failure cache regression

Root reviewed the updated asynchronous cache and reproduced a failure using the worker's existing scheduling fixture in a temporary standalone test, without modifying its checkout. An integrated parent and eligible dependent child normally return a known next task. Injecting one generic I/O failure into the first `merge-base` command makes the first read return none. The second fresh-page read, with Git healthy and unchanged DB/HEAD, still returns none. Counters: two captures, one projection build, one projection cache hit, one proof evaluation. The expected recovery assertion fails. An identical control with no injected failure passes and returns the child on both reads.

Cause in current `src/tasks/scheduling-read.ts`: `planProof`/`taskProof` avoid their individual caches on unexpected Git failures, but `projectionFor` caches the resulting unsuccessful whole projection regardless. That projection is reused while semantic facts/HEAD stay unchanged. Explicit Refresh cannot retry the failed proof. Correct the existing cache's transient-failure propagation and add a focused refresh/recovery regression within LZ-182; preserve normal unchanged-state reuse and fresh runtime dispatch authority. No new task or cache timeout policy is necessary to establish this behavior.

Reproduction `/private/tmp/lz182-transient-proof-observation.test.ts` failed one assertion; no-failure control `/private/tmp/lz182-transient-proof-control.test.ts` passed. Both use disposable SQLite/Git fixtures and clean them up. This is a candidate review finding, not a claim that runtime dispatch itself is blocked by this read-only UI cache.

The worker's broader native test command completed in 198.98 seconds with **709 passing / 19 failing** across 49 files (8,877 assertions). Root read the exact completed tool result, not an observation timeout. Failures include dependency execution, retained successor chains, serial shared children, integration and cleanup fixtures. Their causes still require worker diagnosis against the changed integration-before-successor contract; they are not automatically unrelated or waived by the seven focused scheduling passes. Full retained output is `/private/tmp/lz182-broad-test-output.txt`. The current original worker is still active repairing the cache finding; no restart or duplicate suite was launched by Root.

