# Remaining idle service work — 2026-11-04

Root's settled post-installation quiet window1793838312074–1793838324106 measured service17.54%, renderer0.25%, GPU-process0%, with the same PIDs and no active native model sessions. This remains material service CPU; the earlier busy-text repair and provider quota failure are separate facts. All six inference flags remain true, unload Never, demand false. Retained attempts, dirty worker trees and background holds are preserved.

## Fresh attribution

Root performed one explicit in-process10-second JSC capture through the restored temporary diagnostic: `/private/tmp/lazers-service-residual-before-20261104.json`, PID95968,1793838509851–1793838519882, elapsed10030.36ms,1080 samples. Active inventory was empty immediately before it, and no competing Root RPC/UI/test/build work occurred. The diagnostic adds overhead; its sample count is not a substitute for the separate OS baseline.

Counted once per stack,244 samples include native-host full-context reads (`runner/native.ts` messagesBefore/messages),75 include `step`'s effects lookup,71 include `latestTransition`, and85 include progress `reconstructSession`. The local effects/transition paths perform full-table scans. The native adapter's detailed session path intentionally reads context twice around fresh metadata/control checks; those checks remain necessary for terminal proof.

## Fail-closed preflight

`advanceAttempt` previously used an existing lightweight background blocker only when there was no terminal outcome. A succeeded/failed outcome therefore loaded full context twice before holding for the same unknown/busy background fact. The preflight now also holds those outcomes immediately. Each tick still performs a fresh lightweight read, so later idle evidence or state changes remain visible. Clearing the blocker still enters the unchanged detailed context/lineage/control proof, verification and acceptance paths. Explicitly observed interrupted outcomes retain their detailed path and stop diagnostic. For other outcomes, diagnostics available only from full context are deferred while the background blocker persists; for example, the native adapter can derive interruption from unfinished assistant content. This is a diagnostic-timing change, not an assertion of identical event timing. Native progress event/reconstruction capture is unchanged. No cross-tick cache, synthesized idle evidence, relaxed acceptance or hidden recovery is introduced. Cancellation and reconstruction are unchanged.

The existing terminal-verification regression was extended with detail-read counters: old code fails with one context-detail call while unknown; repaired code makes none while unknown or known-background-busy, then performs detailed proof and acceptance after a later zero-background observation. Two additional cases prove failed outcomes are freshly reread/held across ticks while interrupted outcomes retain detailed reads and their stop evidence. The targeted8 runtime tests pass151 assertions, including input mismatch, foreground races, approvals, cancellation races, native clear controls and source-fence recovery. Native/store suites pass41 tests193 assertions. Formatter/lint360/typecheck350 pass. No full broad suite or GUI rebuild was repeated for this server-only delta.

## Equivalent indexed lookups

Two idempotent indexes support the unchanged SQL: `runner_effects(plan_id)` and `runner_transitions(plan_id,task_id,event,id)`. No query predicate, returned payload, ordering, state, event or history retention changes. Existing and reopened databases receive them through the existing store initialization.

A fresh read-only snapshot248061952 bytes contains1162 effects and9320 transitions. Forty actual lookup shapes across25 running/blocked/cancelling plans and5 active attempts return deeply identical rows before/after indexing. EXPLAIN changes full-table SCAN to the respective indexed SEARCH. Twelve alternating same-snapshot rounds, excluding each first round, measure median8.588ms before versus1.113ms after for the forty-query group. Index setup is excluded from those timings; first creation measured10.0ms. Artifacts: `/private/tmp/lazers-residual2-sql-replay.json` (plans/output counts/EXPLAIN), `/private/tmp/lazers-residual2-sql-interleaved.json` (alternating timings), and the private snapshot/scripts beside them. These are lookup replay gains, not a claim of whole-service CPU savings.

Canonical activation and the post-fix observations are recorded below. Remaining context/reconstruction work is not assumed fixed from source checks alone.

## Live post-fix attribution and diagnostic cleanup

Root activated the reviewed repair source-only as canonical7d72291. Current source-fence registration and both actual indexes were confirmed at1793839077827, with the same native PID/project/database. The first12.034-second OS window1793839092537–1793839104571 measured service15.29%, renderer0.25%, GPU-process0%; it may include warmup and is not the final steady-state comparison.

The single post-fix profile `/private/tmp/lazers-service-residual-after-20261104.json` covers1793839155444–1793839165463,10019ms, samePID95968,509 samples, without competing Root traffic. Counted once per stack, the targeted native-host full-context paths fall244→0 samples; latestTransition71→3; step effects lookup75→10. Those are concrete attribution changes. Overall1080→509 sampled stacks is not itself a CPU or battery reduction measurement. Progress reconstruction85→27 is not attributed to this patch because that unchanged periodic work may differ between windows. Residual work includes native HTTP handling and metadata/control reads, outbox selection/delivery, plan reads and periodic progress reconstruction. No claim that all idle service cost is solved.

The temporary CPU-profile contract/handler/helper/tests are removed after these two captures. No model-facing tool, background profiling or permanent diagnostic API remains. Root will take one final settled OS window after cleanup activation; that result belongs alongside the separate17.54% pre-fix service baseline.

Cleanup verification: affected Observability RPC suite4 tests/41 assertions passes; formatter, lint358, typecheck348 and diff checks pass. No GUI rebuild or broad test repeat was needed.

## Final cleanup window exposed another spike

Canonical960b7a3 removes the temporary profiler. Current source-fence registration
was confirmed at1793839526019, samePID95968/project/DB. Native active inventory was
empty at1793839525404; all six inference flags remained true and demand false.
Desktop confirmed Main selected and DevTools closed. An OS-only12.038-second
window1793839542408–1793839554446 then measured **service103.92%, renderer29.41%,
GPU-process1.99%**, with the same PIDs and no competing Root model, build, test or
profiling traffic. This contradicts any claim that idle performance is resolved.
The prior15.29% and17.54% windows remain bounded observations, not a steady-state
ceiling. Astra is investigating the recurrence; cause is not established. Raw rows
remain in `/private/tmp/lazers-panel-cpu-windows-20261104.jsonl`.
