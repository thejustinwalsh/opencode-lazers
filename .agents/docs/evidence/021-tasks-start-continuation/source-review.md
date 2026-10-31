# Post-repair source review — 2026-10-31

Reviewed main at `59fb19e`, separately from root's current WebIDL scheduler-binding
repair in `src/tasks/panel-view.ts` and its focused regression. Those two files
are root-owned for this repair; they were not edited by this review.

## Start ownership round-trip race — repaired in this review

The direct Start path separately adopted a continuation, reread the plan, then
submitted Run under that newer version. `store.updatePlanOwner` checks only the
old owner, so explicit A→B→A reassignment during native creation could be
overwritten by stale continuation adoption. The direct Run path's atomic
version/receipt check did not protect this separate Start path.

Start now submits Run with the captured original owner/version and lets the same
atomic command transaction adopt the continuation. The regression injects both
explicit reassignments during creation: stale Start must reject, retain restored
owner A/version 3 and create no attempt; a fresh click may then start under A.
This removes the duplicate adoption path rather than weakening ownership checks.

Verification at `ce6174d` (including root's `a53dba3` scheduler-binding repair):
`bun test` passed **167 tests / 1,472 expectations** across 37 files; full
formatting/lint/typecheck passed. Focused runner/native/process-recovery checks
passed 39 tests, and command replay, foreign-caller denial and pre-receipt-crash
reproductions still passed. These do not establish final native acceptance.

## Confirmed scheduler acceptance starvation (existing task 2958fa32)

Driver observations: `/private/tmp/lazers-021-driver-observations.json` records
all Tasks plan nodes accepted while plan `7b602667-38d8-4350-9e20-46c09b75b934`
remains running/version 6 with no plan artifact during the isolated scheduler
worker's activity. `src/runner/runtime.ts:703-715` returns for another plan's
active attempt before reaching the completed-plan check at lines 733-734.
This is a dispatch-slot guard incorrectly blocking completion, not evidence that
the task is still executing or that native acceptance has passed.

Keep this fix and regression under existing scheduler task
`2958fa32-9f7a-43d9-9252-3d30f2d4dca1`. Its review gate must show a fully
completed plan finishing and delivering its outcome while an independent plan's
worker remains busy, without loosening shared-work dispatch serialization. No
duplicate task or concurrent edit of the worker's native checkout was made.

## Exact artifact verification remains an independent integration gate

The Tasks accepted node/attempt artifact is still `d215cc8`; Architect repair
`4c5eb55` and later documentation/design commits are descendants, not replacements
for that historical artifact. `runtime.ts:1112-1125` selects the accepted artifact
and its old workspace for combined verification. The shared checkout has since
advanced, including root's live GUI repair. `artifacts.ts:54-62,149+` correctly
reports changed-source receipts as unchanged=false rather than validating newer
source under the old identity.

When scheduler finalization is unblocked, preserve this provenance: combined
checks must run at the exact selected/combined artifact in an appropriate native
worktree, or report the mismatch honestly. Separately retain the final repaired
checkout's full suite/build and root/Terra native evidence. Do not reset main,
rewrite the accepted attempt, relabel old receipts as repaired-source checks, or
force integration to hide the mismatch.

## Other current boundaries

- Project-specific native agent lookup now confirms Luna Max. The CLI's prior
  default-home result is not a configuration defect; no configuration change is
  needed for it.
- Linked worker Session Tasks discovery remains under `efd8459f`, as recorded in
  the existing projection addendum. The driver observed the real Luna Max child,
  not a fabricated worker or proof of simultaneous workers.
- Root's blank-panel `Illegal invocation` finding demonstrates why the passing
  pure-helper suite and GUI build alone were insufficient. A final repaired-build
  running capture is still required. No native visual pass is claimed here.

## Subsequent native evidence and shared baseline correction

Root's `7a9d009` adds `browser.md` and real Desktop captures: Terra passed narrow
Search; pointer/keyboard split, independent scrolling and close/reopen restoration
passed. Manual Start admitted existing Repomix plan `aa71e2c0` from draft/v1 to
running/v2 with Luna Max; replay retained one plan/version. No worker attempt or
execution is claimed for that admission. These observations supersede the earlier
pending visual checks above, but not scheduler finalization or exact-artifact gates.

Root also identified queued `fc88ccc0` following accepted `6edcc32f` in plan
`db24c4b4`. Dispatch preferred the old predecessor artifact over current shared
HEAD even for the next task's first attempt. A real-Git regression reproduced the
wrong base after a reviewed commit between accepted predecessor and successor:
the successor's scope comparison included the reviewer's unrelated repair.

The correction chooses current HEAD for a new shared node, treating intervening
reviewed commits as input. Explicit retry baselines still take precedence, and
retry without a newly selected baseline still continues its failed artifact;
isolated predecessor selection is unchanged. The regression reopens the runtime,
checks successor base/policy source, verifies only its own file is attributed,
and preserves the predecessor's historical artifact and source. No hash gate,
task replacement or active-worker-checkout edit was added. Preserve this behavior
when reviewing and merging the isolated `2958fa32` scheduler result.

Verification: the new first-attempt regression failed before the correction;
all three first-attempt/explicit-retry/default-retry baseline tests now pass
(110 expectations). Full suite: **168 tests / 1,493 expectations** passed across
37 files; formatting, lint and typecheck passed. This runner-only correction
does not change the GUI bundle or establish a live successor dispatch.
