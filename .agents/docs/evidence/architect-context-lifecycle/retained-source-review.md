# Retained renewal candidate review — 7e02ce0

Independent native review `ses_e681b42b4ffeEkEylmWlst85JM` inspected the delivered
candidate in the original retained second-attempt workspace. Focused suite:
119 pass. Five scratch reproductions confirmed the blocking defects below;
git diff --check was clean. No source changes, live inference, reload or native
renewal/archival pass was claimed. Passing automated checks did not cover these
behaviors. Do not activate this candidate for the human gate yet.

## Required same-attempt corrections

1. **Honor cancellation during failed archival recovery.** Candidate
   `src/runner/runtime.ts:1591–1597` performs recovery before cancellation at
   `:1619`. Fail archival, cancel through the transferred current owner, and tick
   repeatedly: the plan remains cancelling and running workers receive no
   interruption. Cancellation must progress despite unresolved archival, retaining
   durable recovery obligations rather than ignoring cancellation or replaying work.
2. **Account for late/mutable assistant and tool results.**
   `src/runner/native.ts:215–219` drops result contents, and
   `src/runner/store.ts:717–724` ignores assistant/tool rows. Reconcile a delivered
   input, then complete/fail its assistant/tool work: no source revision or
   notification changes. Reconcile terminal/mutable result facts through durable
   safe identities/revisions and deduplicated source references. Do not copy raw
   tool state, private reasoning or transcript bodies into successor prompts or
   replay any original tools/requests.
3. **Concurrent admission must not strand transfer.**
   `src/runner/store.ts:1168–1179` adds a plan admitted during successor creation,
   but successor identity metadata at `runtime.ts:891–895` does not include it.
   Result: archiving with conflicting identity, no completed archival/handoff.
   Keep transfer and successor identity consistent; handle newly admitted plans
   deterministically without lost ownership, duplicate successors or a new global
   admission fence requirement. Exercise concurrent schedulers and reopen.
4. **Confine recovery to the canonical project.** Recovery/source queries at
   `src/runner/store.ts:499–528` lack project filtering in the shared database.
   Open another project against the same DB during needed recovery: its scheduler
   attempts foreign recovery, overwrites the foreign error, then throws Plan not
   found. A foreign scheduler must neither observe/mutate nor attempt that work.
   Exercise two canonical projects sharing persistence, not just two instances of
   one project.
5. **Bind checkpoints to covered observed inputs.**
   `src/runner/store.ts:883–893,1127–1155`: record decisions, then observe/deliver a
   contradictory user decision, finish that turn and reach idle expiry. The old
   checkpoint still permits renewal without any input-coverage relationship.
   Persist explicit coverage/revision evidence; never treat an old decision set
   as current merely because it exists. Stale/unresolved coverage must remain
   honest and cannot be silently summarized or inferred as resolved.

The original clarified boundary remains: preserve work, honor cancels, no complete
audit of foreign inputs deliberately cancelled before first observation and no
atomic native admission fence requirement. These findings do not authorize a
cancel-and-copy migration, original-request replay or disabling renewal.

## Receipt and acceptance boundary

The retained candidate still has the pre-2536084 verification lookup at
`src/runner/runtime.ts:2233–2240`. Bring the user's reviewed receipt selection fix
into the same retained source before final checks; preserve current main behavior
and do not misattribute historical stale-receipt failure to the new candidate.

Add discriminating regressions for all five cases, retain original checks and
rerun the focused/full/quality verification on the corrected exact artifact.
Use the same retained attempt/session/workspace; no replacement task or new
attempt and no interruption/restart of independent LZ-36/LZ-38 work. Native
renewal, visible archival and input/outcome continuity remain mandatory future
observations after source review and quiet-boundary supported activation.
