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

## Renderer attribution and repair

Root drove a same-PID, 12-second A/B/A observation while native workers continued. Main with Trajectory129 measured service/renderer/GPU-process35.07/29.33/27.34%; a completed Sol chat with its session-scoped panel closed measured20.61/25.26/21.85%; returning to Main measured64.95/34.14/30.56%. The changing service workload prevents a causal panel comparison. GUI process CPU remained material with the completed chat selected. Exact windows are retained in `/private/tmp/lazers-panel-cpu-windows-20261104.jsonl`; GPU-process CPU is not GPU utilization.

Native DevTools inventory found two `text-shimmer-sweep` background-position animations and24 `spinner-radar-*` opacity animations. The latter are native OpenCode busy indicators, not the LAZERS Radar panel. The earlier renderer trace records a compositor failure for the shimmer's background-position; paint counts are not frame rate, and the docked profiler changes viewport/overhead. Pinned native [TextShimmer source](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/ui/src/typography/text-shimmer/text-shimmer.tsx) and [CSS](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/ui/src/typography/text-shimmer/text-shimmer.css) confirm an ordinary child SPAN background-position animation, without pseudo-elements or component-level Web Animations calls.

Two initial temporary pause experiments are invalid for causal inference. The first paused animation objects but a native rerender replaced one during the CPU window. The second applied scoped CSS, but actual animations remained running even though computed `animation-play-state` was paused. This matches the [CSS Animations 2 interaction rule](https://drafts.csswg.org/css-animations-2/#animations): calling an animation's `play()` or `pause()` overrides subsequent CSS play-state control. The preceding manual pause/restore is a sufficient explanation for that discrepancy; it is not evidence of a native product defect. All experimental styles were removed and animations resumed. No inference setting, permanent animation rule or host UI code was changed.

A subsequent stable manual pair is valid. Completed Sol chat stayed selected, one native global busy shimmer was paused at1793836747676, and DevTools was closed. The12.036-second window1793836757949–1793836769985 measured service27.25%, renderer0.75%, GPU-process0.42%. Post-verification1793836786577 found the original target still connected/paused and the only current shimmer paused. Root resumed it at1793836788068, closed DevTools, and measured the12.041-second control1793836799227–1793836811268: service26.16%, renderer23.75%, GPU-process21.18%. Other native spinner animations were untouched, workers continued, and no Root diagnostics/build/tests ran during the windows. This strongly attributes the GUI process cost in these conditions to the native background-position text shimmer, not the plugin panel or inference. It does not establish whole-machine battery savings or service CPU reduction.

The first production candidate used an opacity pulse over readable static base text. Root injected the exact1086-byte CSS at1793837097990, closed DevTools, and captured1793837109429–1793837121459: service22.61%, renderer5.99%, GPU-process20.20%. Post-verification1793837155741 found only `lazers-native-busy-opacity`, running with opacity as its sole animated property; the background-position animation was absent. Root removed the temporary style at1793837157136. Renderer cost improved, but GPU-process cost stayed near the running control21.18%, so this candidate is rejected. Compositor eligibility alone did not solve the observed process CPU cost.

The revised focused candidate uses the public [Style registry](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/plugin/src/gui/registries.ts) for plugin-owned lifetime and removal. A single rule makes only the native shimmer text static/readable, using its existing theme base color and active/inactive opacity transitions. Native busy spinners and status text remain, and native reduced-motion rules are excluded from the override. This is a compatibility repair against pinned2.2.5 native DOM selectors, not a stable component replacement API; host upgrades must recheck it and remove it when the upstream component is repaired. No app archive patch, host fork, private API, extra timer or animation polling is introduced. The exact313-byte static candidate passed actual Desktop verification. Root installed it at1793837259881; the12.035-second closed-DevTools window1793837272836–1793837284871 measured service21.60%, renderer0.50%, GPU-process0.25%. Post-verification1793837323600 found the style present, no shimmer animations, and the active overlay fully visible in native theme gray (`rgb(179,183,188)`, opacity1); the screenshot confirmed readable Working text. Root removed the temporary contribution at1793837324891 and returned to Main. These are same-PID completed-chat measurements with native workers continuing, not a whole-battery or full busy-Main outcome. The source candidate is still awaiting coordinated canonical activation.

| Before                                                                                                                 | After                                                                | Why                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native busy text animates background position continuously; an opacity-only replacement still consumes GPU-process CPU | Static readable status text alongside unchanged native busy spinners | Remove measured redundant continuous text animation while retaining activity feedback, theme colors, state transitions and native reduced-motion behavior |

Static candidate verification: native formatter/linter/typechecker pass (355 linted/345 typechecked files), GUI build and process-free bundle evaluation pass. Build reports the existing Vite inlineDynamicImports deprecation and ONNX CommonJS import.meta warnings. No behavior tests were added for a single reversible CSS rule; actual native animation inventory, visual readability and process CPU checks exercise the change directly. Backend regression results above remain valid; no broad suites were repeated.

## Root integration verification

Root preserved the original source-clear bootstrap branch at5d485d13 and combined it
with Astra's f07cc43/b420a98/96f147e on `feat/retained-bootstrap-performance` in the
existing isolated bootstrap worktree. The only source conflict was the occupied
reservation projection: it now reads `activeProjectAttempts()`, then retains the
bootstrap's exact `sourceReservationExcluded` filter before projecting scopes.
Current native roadmap/handoff changes were reconciled at5713490.

The merged candidate passes **199 tests / 3,181 assertions / eight files /57.27s**,
including the full source-fence/native/roles/runtime suites and the added
reservation/proof regressions. Formatter, lint358, typecheck348 and diff checks
pass. Its exact GUI build and process-free bundle smoke pass with the existing
warnings above. Logs are `/private/tmp/lazers-bootstrap-performance-merged-tests-20261104.log`
and `/private/tmp/lazers-bootstrap-performance-merged-gui-20261104.log`.

Native OpenCode then hit the actual ChatGPT provider usage limit, independently
confirmed in Desktop and the exact three session outcomes. At1793837499164–9178,
Main and both original workers had terminal failed outcomes and native idle
messages carrying that error; their last tools were completed. Active inventory
at1793837484027 was empty. LZ129/132 worktrees and original attempts remain
preserved; neither task is accepted or complete. Both plans report the retained
idle/background-observation blockage, not a passing product result. No replacement
worker or route change was made.

Before canonical activation, a no-model/test/build/diagnostic-traffic12.094s window
at1793837563827–1793837575921 measured the unchanged servicePID95968 at19.35%,
renderer54076 at0.33%, and GPU-process54072 at0.25%, Main selected. All six inference
settings read back true at1793837541024–1026; demand was false and Never unload was
unchanged. This is the new quiet backend comparison baseline; the earlier active
workload and native text animation results remain separately labelled. Canonical
activation, actual source-fence qualification and post-activation backend comparison
are still pending at this source checkpoint.

## Canonical installation and remaining idle work

Root fast-forwarded canonical main toc44eb9b after the actual provider-limit stop;
no process restart or inference-setting change was needed. The canonical GUI build
and process-free bundle smoke pass. Native source-fence status at1793837989539
confirmed the project location's current registration, and at1793838009581 confirmed
the exact retained72 worker location's registration, both in servicePID95968 with
the expected project/database/location binding. This proves installed native guard
registration; the quarantine command, archive/readback and exclusion flow remain
unexercised. At1793838415118 there were zero quarantine rows; the original72 check
remained uncertain and its attempt verifying. No old resource or acceptance was
released.

Desktop at1793838179741 contained the owned313-character repair style and zero
temporary experiment symbols. DevTools was closed. Native settings at1793838287566–68
were all true, demand false, and active inventory at1793838287589 was empty.
The first post-install CPU window1793838204001–1793838216042 measured service17.36%,
renderer10.88%, GPU-process0.08% during GUI settling. A subsequent settled window
1793838312074–1793838324106 measured **service17.54%, renderer0.25%, GPU-process0%**
on the original PIDs, with no model, profiler, test, build or diagnostic traffic.
The matched pre-install quiet service result was19.35%; this is a modest backend
improvement, not completion of service performance work. The busy-label result
above remains a separate controlled observation, not a claim that quiet GUI CPU
was high before installation.

Astra is continuing the residual service investigation. Root temporarily restored
the previously reviewed bounded attribution endpoint at5e9e9be. One actual capture
at1793838509851–1793838519882 lasted10,030ms and returned1,080 samples onPID95968;
no other Root diagnostic traffic ran in that interval. Raw metadata is private at
`/private/tmp/lazers-service-residual-before-20261104.json`. Attribution and the next
fix are pending; SQL primitive names alone do not establish a cause. This temporary
diagnostic must be removed again after the comparison.
