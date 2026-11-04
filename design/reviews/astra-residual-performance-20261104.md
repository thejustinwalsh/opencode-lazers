# Residual performance repair

## Current workload and ownership

This resumes the already integrated outbox/read/event repairs; it does not repeat them. The previous final quiet service observation was 17.61% CPU. A fresh 12.033-second OS-only observation at Unix ms1793835654702–1793835666736 measured service19.78%, renderer26.68%, and GPU-process35.57%, same PIDs95968/54076/54072. Main and LZ129 were active, Trajectory129 was visible; Root subsequently observed another native worker starting. This is an active-workload observation, not a quiet comparison or GPU utilization measurement. All six inference flags and Never unload remain unchanged.

Astra owns the isolated native tree `/private/tmp/lazers-astra-residual-performance`, created at1793835615954. Native workers129/132 retain their files; Root's source-clear retained bootstrap remains offline. No canonical source activation/restart is performed from this tree.

## Active reservation read

The prior actual service profile identified repeated attempt/transition reads under `TaskRuntime.step`. The current source still calls `plans()` and then `attempts()` for every historical plan simply to select preparing/running/verifying attempts. Each `attempts()` first rereads its plan, producing two reads per plan plus the initial plan list.

A fresh read-only database snapshot at1793835718075 contains107 project plans and127 historical attempts. Replaying the actual old method composition and new `activeProjectAttempts()` alternately sixteen times returns deeply identical4 active attempts every time. Transactional reads fall **215 → 1 per decision**, and median method time falls **5.143 → 0.490 ms**. Artifact: `/private/tmp/lazers-residual-method-replay.json`; private snapshot and SQL/EXPLAIN replay are retained beside it. These are method replay measurements, not a claim of whole-service CPU improvement.

The new read materializes narrow plan IDs/priority/sequence, then joins active attempts from the attempt side. It preserves `plans()`' existing1000-plan priority/rowid window and the existing attempt start/number ordering; no new cap is added. Explicit join order prevents a repeated attempt-table scan for each historical plan. It returns full attempt rows in one read transaction. No cache, schema/index migration, extra timer, state mutation or lifecycle decision is introduced; every scheduler decision rereads current reservations.

Verification: store10 tests/48 assertions pass, including a new regression for priority, active states, terminal exclusion, foreign project isolation, a second connection changing state/session/workspace between decisions, and reopen. Six targeted existing runtime tests/143 assertions pass for scope amendment/overlap, accepted dependencies, concurrent plans, shared baseline and afterPlans shared-checkout admission. Native formatter/linter/typecheck (342 files) pass. Live matching before/after observation awaits a coordinated natural quiet boundary; workers are preserved.

## Prerequisite proof before Git

The existing authoritative prerequisite evaluator is extracted into `prerequisite-proof.ts`; both runtime callers still pass through it. All durable rows are validated before any Git call. Valid evidence still executes the exact same baseline resolution/verification and three ancestry checks per prerequisite, in the same order. Missing, stale, cancelled, malformed, mismatched or foreign evidence still returns unavailable and blocks progress. There is no skipped dispatch/finalization proof, cross-decision cache, changed admission rule or presumed idle state.

The fresh snapshot contains two running `afterPlans` evaluations. Replaying their real durable rows against current Git, before and after, produced the same unavailable result every time. The single-prerequisite case previously launched2 Git processes (12.7–16.4 ms), while the four-prerequisite case launched8 (59.7–65.8 ms) before discovering a later invalid durable row. The new evaluator launches0 in each case (0.002–0.15 ms). Three alternating evaluations per case are recorded in `/private/tmp/lazers-prerequisite-replay.json`. This establishes avoided work for these actual blocked prerequisites; it does not establish savings for valid proofs or whole-service CPU.

Verification: new evaluator3 tests/73 assertions cover unchanged Git command sequences for normal/selected baselines and cleaning/cleanup-blocked/integrated parents; all-row validation before process launch; malformed/foreign/stale/cancelled evidence; changed artifact/acceptance; Git failures at every stage; and fresh reevaluation without a cached pass. Twelve existing afterPlans/cross-plan runtime regressions pass285 assertions, covering real Git ancestry, cancellation, cleanup-in-progress, reopen/resume, invalidation while creation/recovery is deferred, combined-check recovery and shared-checkout admission. Formatter/linter/typecheck pass344 files. No further broad suite was run.

Root's offline bootstrap also filters occupied reservations through `sourceReservationExcluded`; when both candidates are integrated, that exact filter must follow `activeProjectAttempts()` so the existing exclusion guard is retained. Root owns that integration and the source-clear bootstrap remains separately controlled.
