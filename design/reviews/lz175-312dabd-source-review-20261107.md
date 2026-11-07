# LZ-175 `312dabd`: independent source review

Read-only Luna Max review of exact candidate
`312dabd2873beb3d8a49e5dbdefab4c0b8b7ced0` against parent `9657f16`, in Root's
native isolated review worktree. No tests, source edits, controls, prompts,
activation or integration were performed by the reviewer. Root reports declared
62 tests / 670 assertions, quality/GUI build and broader 586 / 7,723 passing;
those checks do not cover the three findings below.

## Findings requiring correction

1. **High — stale native Architect authorization at reservation (new exposure).**
   Candidate `src/runner/runtime.ts:2522–2547, 2982–2998` checks a fresh owner at
   line 2523, then awaits repair-worker observations. The final reservation uses
   the older `ownerSession` snapshot from line 2363. If the native owner is
   archived or loses Architect/project eligibility during those awaits without
   a persisted plan-owner/epoch change, verification can still be reserved.
   Re-fetch/validate the native owner after the last async observation and use
   that result at admission. Add deferred native-owner archive/role/project
   invalidation tests, not only plan reassignment tests.
2. **High — native-owner invalidation during checks can still reach acceptance
   (baseline gap affecting the new flow).**
   `runtime.ts:9652–9675, 9750–9800, 9439–9552` validates the Architect before
   asynchronous checks. The later `retainedVerificationLive` validates durable
   owner/epoch, and the repair-specific acceptance observation validates the
   worker, but neither revalidates the current native owner. Native archive or
   loss of eligibility during checks can therefore be missed. Revalidate native
   owner eligibility after checks before the fenced acceptance transaction;
   test invalidation without a database owner transfer. Reassignment/epoch
   fencing must remain intact.
3. **Medium — cross-plan scope conflicts can appear during admission awaits
   (baseline gap widened by new awaits).**
   `runtime.ts:793–823, 2601–2611, 2981–3053` scans conflicting attempts,
   adoptions and retained verifications during preparation. Final reservation
   checks same-plan adoptions but does not repeat the project-wide/scope scans.
   A conflicting same-scope attempt or verification can appear during the
   worktree/native awaits without changing this plan version. Repeat applicable
   conflicts atomically at reservation, with a deferred competing-admission
   regression; the existing test only starts with a competitor already present.

## Preserved good behavior and boundary

The candidate binds the current repair operation, prior artifact, current task
and attempt, exact route, clean HEAD, scope and new check receipts. It preserves
unknown original background and emits no new repair prompt. Keep those properties
while closing the three admission/acceptance gaps; do not add exhaustive content
fingerprinting or invent original idle/resource evidence.

Root owns the already-specified bootstrap implementation and corrections.
LZ-175's native dispatch remains stopped with zero attempts; no competing worker
or source quarantine/archive of held LZ-174 is authorized. Active original
LZ-165's IPC correction and its actual reload gate remain separate. Do not merge
or activate this candidate unchanged; Root's exact corrected code/test/live
results still precede normal task disposition and native LZ-173/LZ-174 follow-up.
