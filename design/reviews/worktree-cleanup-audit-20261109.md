# Worktree retention audit

Observed 2026-11-09. This is a read-only audit prompted by the user's report of
136 leaked worktrees consuming over 81 GB. No checkout was removed by the driver.

## Findings

- Git registers 143 worktrees in addition to the main checkout: 141 exist and two
  temporary review registrations point to missing directories.
- OpenCode's native inventory returns 142 entries, including main. Its other 141
  paths match the existing Git checkouts.
- `du -sk` reports 84,454,708 KiB in the runner worktree folder and 2,406,228 KiB
  in the project sibling folder: about 82.8 GiB combined. This is observed folder
  allocation, not a claim that every byte can be reclaimed.
- 50 checkouts map to 38 `cleanup-blocked` plans. Every one is clean, and every
  HEAD is already an ancestor of main. All 38 plans have the same reason:
  `Owned worktree worker activity is not conclusively idle; preserve it`.
- All 44 associated attempt sessions were found through the native API. None
  appeared in the active-session map before or after the observation; each has
  an idle timestamp after its busy timestamp. This establishes no current
  foreground execution in that observation, not absence of background work.
- Other associations include 48 checkouts on blocked plans, 20 on cancelled
  plans, four on accepted plans and six on running plans. These are checkout
  counts, not plan counts or permission to delete.
- Fifteen Git entries lack an attempt/creation-effect association. Eight are
  named retained-verification checkouts; others include review/composition
  checkouts and the two missing temporary registrations. Some also have retained
  check records. They require inventory reconciliation, not blind deletion.

The exact paths, task references, associations, native inventory comparison and
clean/merged observations are in
[the inventory](worktree-lifecycle-inventory-20261109.json). It records Unix
milliseconds. The live DB and host state remain authoritative after this snapshot.

## Why cleanup did not converge

`src/runner/runtime.ts` enters `cleaning` after an accepted plan is recorded as
integrated. Its scheduler advances that state through `cleanupWorktrees()`.
Cleanup checks ownership, worker activity, source cleanliness and ancestry,
then calls the native host removal API with `force: false`.

A failed check changes the plan to `cleanup-blocked` and emits an Architect
outcome. Resumption currently requires another integration command. The normal
cleanup path does not sweep cancelled plans or independently reconcile all owned
review/verification resources. It therefore does not provide project-wide
eventual cleanup by itself.

`assertWorktreeQuiescent()` requires a matching worker session, current outcome,
completed/interrupted turn and background-idle observation. Missing or stale host
observations can hold already-integrated clean work indefinitely. All 38 blocked
plans currently hit this shared condition. The audit does not establish which
host observation is missing for each plan or prove absence of native background
processes; that is the next reconciliation step before removal.

LZ-185 already owns the coherent native workspace lifecycle feature and depends
on LZ-182. It is queued, not delivered. Its older scope still assigns review and
qualification to Root, contrary to current Architect ownership. The user request
is to prioritize and complete this lifecycle work, reclaim safe retained resources
through supported native controls, and make scheduler cleanup converge after
integration, cancellation and restart. Active work and useful dirty/unmerged work
must remain available. Cleanup holds do not invalidate implemented behavior.

## Observation boundary

The driver relayed this user-requested priority through Desktop; delivery must be
confirmed from the native conversation before claiming Architect consumed it.
No SQL repair, forced Git removal, new daemon, source hashing gate or fabricated
idle receipt was used. Required follow-through is actual native reconciliation,
removal receipts and before/after disk observations, plus subsequent automatic
cleanup under the corrected scheduler lifecycle.
