# Residual CPU attribution — 2026-11-07

## Result and boundaries

Read-only follow-through on the existing performance lane. No source edits,
tests/builds, worker queries/prompts, UI/JXA, settings changes, reloads, restarts,
or database writes were performed. LZ-174's repair activity and the requested
roadmap ordering are taken from the supplied context, not independently polled:
keep independent queued work moving, with Models → Tasks/Trajectory → Radar
priority. This observation is not a global freeze or an acceptance decision.

A bounded active window confirms material service CPU. One short macOS sample
shows SQLite schema/statement-preparation frames on the service main thread, but
its caller and database are unsymbolized. This is a useful subsystem lead, not
source-level attribution or evidence for a particular repair. Renderer and GPU
helper CPU were measured with counters only; their causes remain unattributed.
There is no quiet baseline, controlled comparison, battery result, or Desktop
visual-acceptance claim.

## Existing lane evidence

- The Nov 7 LZ-129 follow-through observed 27 observability events with 27
  distinct complete identities in a three-second subscription after canonical
  activation. That is improved deduplication for that sample, not proof of
  system-wide CPU savings. The separate earlier 12.039-second window was
  service 42.03%, renderer 14.62%, GPU helper 37.71%, with Trajectory visible
  and a recovery worker active; it is a different workload, not a baseline for
  this capture.
- LZ-111 and LZ-115/116 records describe the integrated scheduler/reconstruction
  diagnostics as partial coverage. Scheduler/reconstruction counters are not
  whole-service CPU attribution. LZ-135's prior 30.92% → 30.16% service result
  was explicitly inconclusive; this active window does not clear its separate
  native-performance gate.
- The existing temporary in-process JSC profiler was removed after its
  authorized captures. I did not recreate or invoke it. The prior active sample
  likewise cautioned that unsymbolized Bun/JIT/SQLite stacks cannot name a JS
  caller. Root's `8975516` cache-ownership fix and native chat/d1/restart proof
  remain complete and out of scope; WebGPU source/lease fixture clearance is
  likewise unchanged.

## Live process validation and bounded CPU window

At 2026-11-07 15:23 UTC, PID 3219 was validated as the _current_ service rather
than assumed from an older note: `ps` showed PPID 1 and the OpenCode Desktop
2.2.6 `opencode-cli` executable; `lsof` showed its localhost listener and open
OpenCode/LAZERS SQLite shared-memory files. Desktop PID 35080 owned helper
35087 and renderer 35091. No transcript, credential, or database contents were
read. LZ-174 active work is user-supplied context; no worker/session inventory
was queried.

`ps` cumulative CPU-time counters over 2026-11-07 15:23:42–15:23:54 UTC (12 s):

| Process            |   PID | CPU-time delta | Mean of one core | RSS start → end (KiB) |
| ------------------ | ----: | -------------: | ---------------: | --------------------: |
| OpenCode service   |  3219 |         7.67 s |            63.9% | 2,558,400 → 2,596,944 |
| Desktop renderer   | 35091 |         2.59 s |            21.6% |     622,640 → 627,808 |
| GPU helper process | 35087 |         4.54 s |            37.8% |       77,984 → 74,032 |

These are process CPU counters, not GPU hardware utilization. Work and service
load were active and changing; the values should not be compared causally with
the earlier 42.03/14.62/37.71% window.

Raw bounded counters: `/private/var/folders/tr/3_qw264x55z9g8391dqb7tb40000gn/T/opencode/lazers-residual-cpu-window-20261107.txt`.

## One service sample

After validating PID 3219 again, I ran exactly one `sample 3219 3 10` capture at
2026-11-07 10:24:15.916 -0500. Its main-thread call graph contains 218 sample
observations; 29 reach `sqlite3LockAndPrepare` → `sqlite3Prepare` →
`sqlite3ReadSchema`/`sqlite3InitOne`, including a nested 25-observation
`sqlite3_exec`/schema-initialization path. Smaller branches include
`sqlite3_step` and JSON validation/conversion. These are sample counts, not
measured CPU percentages. The JIT/`opencode-cli` frames are mostly unknown or
unsymbolized; the report cannot identify the initiating JavaScript function,
which database was active for those calls, or whether a connection lifecycle
caused them.

`sample` reported completion and wrote the artifact. The surrounding shell
wrapper then returned exit 1 because its follow-up assignment used zsh's
read-only `status` variable; there was no retry or second sample.

macOS `sample` suspends the target at its sampling intervals. The requested
10-ms interval therefore perturbs the service; overhead was not measured, and
the separate 12-second counter window is not a post-sample comparison. The
capture is not a quiet baseline.

Raw sample: `/private/var/folders/tr/3_qw264x55z9g8391dqb7tb40000gn/T/opencode/lazers-service-sample-20261107-pid3219.txt`.

## Source boundary and next existing-lane action

Current source provides only candidates for later correlation: `RunnerStore`
schema setup enters `repository.atomic` at `src/runner/store.ts:618-622`; the
attempt-directory backfill at `:828-838` is guarded by the missing-column
legacy migration. The sample does not map its SQLite frames to either that code
or to a particular database. Existing optimized paths such as
`outboxForDelivery` (`src/runner/store.ts:2871-2890`) and
`activeProjectAttempts` (`:3291-3307`) are not identified by the sample. Do not
reopen the completed cache fix, duplicate an existing query fix, or infer that
LZ-129 event dedup caused the remaining CPU.

Keep residual CPU acceptance open in the existing performance/LZ-129 lane. The
next useful step is source/DB correlation using an already-authorized,
read-only diagnostic path at a naturally active boundary; if no such
JS-attributed facility is currently available, stop at this lead rather than
recreating the removed profiler or creating/replacing a task or worker. Keep
LZ-135's gate separate. This single active observation neither clears nor
blocks the independent Models → Tasks/Trajectory → Radar roadmap.

## Follow-through: 2026-11-09 04:33 UTC

A fresh process snapshot identifies current service PID1754 at56.8% CPU; main
Desktop PID53628 is0.1%, renderer53657 and GPU helper53652 are0.0%. These are
instantaneous process readings, not a quiet baseline or battery measurement.
Architect and a native Luna worker were active; no service or GPU setting changed.

One read-only `sample 1754 3` completed at local2026-11-08 23:33:27.930. It
reports2.9GB physical footprint,7.9GB peak. Of1435 main-thread sample observations,
437 descend through `sqlite3LockAndPrepare`/`sqlite3Prepare`;426 reach
`sqlite3ReadSchema`, with398 in `sqlite3InitOne`. The initiating JIT/CLI frames
remain unsymbolized. As before, this identifies a subsystem lead, not which
database or JavaScript caller caused it. Sample counts are not CPU percentages.
This short sampling operation perturbs the target; no overhead comparison was
performed. Raw capture: `/private/tmp/lazers-service-1754-20261109.sample.txt`.

Current `TaskRepository` retains its connection and opens lazily after closure;
source inspection does not support claiming every transaction opens a database.
No code edit, source attribution, reload or performance acceptance follows from
this observation. Existing performance work still needs JS/DB correlation.
