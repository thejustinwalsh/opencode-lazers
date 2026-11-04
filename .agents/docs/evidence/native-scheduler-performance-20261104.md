# Scheduler performance repair — 2026-11-04

Root implemented the user-assigned repair while native Architect and its
reconstruction worker continued. Native OpenCode created the repair worktree.
Source `bfdc6e1` was integrated as `cba6ab2`; no runtime reload or inference-setting
change was performed. Source inclusion does not prove effective activation.

## Measured baseline

At roughly 07:13 ET, ten two-second CPU intervals averaged **63.5% service**,
**25.2% renderer**, **32.5% GPU helper**. Architect and the reconstruction worker
were active. This confirms sustained CPU use in that window, not the reported
earlier 2,000% peak or its cause. Raw bounded capture:
`/private/tmp/lazers-energy-before-scheduler-20261104.txt`.

The earlier five-second service sample retained mostly unsymbolized Bun/JIT
stacks and SQLite work. It cannot attribute CPU to a specific JavaScript
function. Do not claim ONNX causation from that sample. A native review separately
reported an actual GPU device-loss/mapAsync error; it is not proof of CPU causation.

## Implemented and tested

- One process-shared deadline timer, coalesced project reconciliation, independent
  project deadlines, no overlapping drain for one project, explicit wake requests.
- Location tools/hooks remain registered. Disposal waits for owned work before
  storage closes; replacement work does not overlap the retiring drain.
- Manual Start uses the elected runtime, avoiding a second location lease owner.
- Lease heartbeats use the same timer. A failed lease claim releases the runtime's
  running flag so the next reconciliation can retry.
- Read-only `sharedScheduler.snapshot()` reports aggregate timer/group/participant,
  running, run, error and wake counts for the pending native diagnostics seam.

Bun 1.4.4 native-environment checks: **138 runtime tests / 2,544 assertions**
(74.54 seconds); **15 coordinator tests / 50 assertions**. Formatting, lint,
typecheck and diff checks pass. Main repeats of coordinator tests, lint and
typecheck pass after integration. An earlier sandboxed broader run hit short
adoption-test timeouts before the runtime edits and was stopped; that is not a
full-suite pass, and its timeout cause was not established.

## Remaining proof

Coordinate activation with native work, verify the effective scheduler, then
measure sustained CPU, actual reconciliation counts and errors during matched
no-worker and working windows. Compare against the recorded activity conditions;
do not infer improvement from timer arithmetic or passing tests. Continue the
reconstruction correction/diagnostics and investigate residual CPU independently.
Computer Use explicitly reported locked before Root could deliver its commit
handoff prompt. Native Architect and worker were still confirmed active.

## Inference-settings follow-up

Source `39ea888`, merge `bae990e`, removes the additional one-second interval
created by each location's inference registration. Those jobs use the same shared
timer, and their authority reads share an in-flight request/value for one polling
interval. Feature authority, GPU jobs, enabled settings and scope-local tool/agent
updates remain intact. Separate injected authorities remain separate.

Merged verification: **30 tests / 145 assertions** across coordinator, settings
read, feature-server and task-review suites; typecheck and diff checks pass.
Independent 54-reader tests show one request per interval, retry after failure
without presenting expired data as refreshed, and sharing across loader copies.
This remains source/component proof. Native activation and CPU comparison are
still pending; Computer Use again explicitly reported locked.

## Review corrections and event-driven Radar

Independent native review reproduced a captured-follower shutdown race in the
initial shared scheduler: a Start waiter already captured by an elected drain
could resume after its own repository closed. Root reproduced the failure,
then committed `6a7b4dd` (integrated `e2da051`). Disposal now rejects that
caller's queued and in-flight waits while preserving already accepted elected
work. A real two-connection regression observes no post-close read/reopen and
one worker dispatch. Combined coordinator/runtime checks pass **155 tests /
2,608 assertions** (72.51s); lint, typecheck and diff checks pass. Scheduler
snapshots now include implementation `scheduler/v2` and a runtime generation.

User deferred Radar redesign. Root removed its redundant three-second pair of
full projections in `3e1bd30`, integrated `8a5c82a`. The new idle regression
failed before the change (two reads instead of one); event, manual, initial and
reconnect paths remain. Radar transport/state and observation-state checks pass
**9 tests / 61 assertions**, quality checks pass. Native GUI rebuild passed.

Two earlier activity windows are observations, not a controlled causal result:
Radar open: service 87.9%, renderer 31.4%, GPU helper 18.3%; Radar closed: 43.8%,
32.5%, 34.1%. Each is ten two-second intervals after discarding top's first
sample. Workload changed between windows. Raw paths:
`/private/tmp/lazers-energy-radar-open-20261104.txt` and
`/private/tmp/lazers-energy-radar-closed-20261104.txt`.

## Native database subscription follow-up — review pending

Final candidate `2782f96` on `84ad51d` removes the one-second per-location
Tasks/Observability source polls. Native SQLite hooks on transactional task and
observation revision rows schedule one deferred in-service invalidation. Read-side
durable revisions distinguish actual changes from rollback/duplicates. Existing
OpenCode native event subscriptions and RPC changed events remain. Initial,
manual and reconnect reads query current durable state. Healthy subscriptions
have no polling interval. Failed RPC deliveries retain retry-only timers, and
changes arriving during delivery schedule a follow-up.

All TaskRepository writers inside the connected OpenCode service participate.
This does not claim automatic live synchronization with an independent service
or arbitrary raw SQLite writer. A stronger external-writer probe found the
unactivated filesystem-watcher variant could miss an open writer's WAL overwrite
until close. Root removed that path and its cross-process claims rather than
shipping unreliable extra watchers or inventing a cross-process protocol.

Independent service connections, idle silence, disposal, module sharing, lost
delivery, storage operations, runtime-only writes and rollback pass **21 tests /
122 assertions**. Formatter, lint, typecheck and diff checks pass. The installed
service executable identifies Bun 1.4.4 and contains SQLite update-hook symbols;
actual native hook-driven delivery remains to be verified after integration.
Primary reference: [Bun SQLite update hooks](https://bun.sh/docs/runtime/sqlite#update-hooks).
Callbacks run before commit, so reads are deferred until the synchronous statement
ends. No file/document hashing is used as correctness evidence.

At Unix 1793797008722, the authorized read-only diagnostics RPC returned
`scheduler/v2`, one timer, 9 groups, 13 registrations, zero scheduler errors and
5 reconstruction locations. Coverage was explicitly partial, and no full
location reload had been reported yet. This proves that diagnostic generation
was loaded, not that every retained runtime was replaced or CPU improved.
Raw aggregate records: `/private/tmp/lazers-live-performance-diagnostics-20261104.jsonl`.

## First activation window

Supported server-wide location reload completed at Unix **1793797070040**, in
1,646ms. All six inference switches remained enabled; no service restart or
settings writes occurred. Root's nearby 20-second pre/post windows measured
service **53.1% → 39.6%**, renderer **22.8% → 19.9%**, GPU helper **29.7% → 29.2%**.
These are initial observations, not a stable performance acceptance: native Main's
later window grew from 5 to 22 locations and averaged service **61.1%**, with
reload-related RPC errors still under investigation. Do not claim the energy
issue is solved. Desktop native View → Reload loaded the rebuilt client bundle;
LFM3 transiently showed Error, then Loading, then Available without switch edits.

Root's Unix 1793797161092 → 1793797189772 aggregate boundary retained one
scheduler/v2 generation and one timer, 8 groups / 12 registrations, zero scheduler
errors, runs 4046 → 4205 and wakeups 1125 → 1170. Reconstruction get calls
93 → 99, context calls 84 → 90, 5 locations, partial coverage. These counters
cover their named components; they are not whole-process native call totals.
Raw CPU windows: `/private/tmp/lazers-energy-before-full-activation-20261104.txt`
and `/private/tmp/lazers-energy-after-scheduler-activation-20261104.txt`.
