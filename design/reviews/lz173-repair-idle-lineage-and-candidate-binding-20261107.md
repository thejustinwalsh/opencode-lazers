# LZ-173 repaired candidate: idle lineage and verification binding

Read-only investigation on 2026-11-07, canonical runtime source `11461c9`.
No production state edits, worker prompts, restarts or idle backfill performed.

## Observed facts

- Original attempt `4d783df7-eb05-463c-b4db-df48a5c308c5`, native session
  `ses_145885557d454551815079ab36bd9c24`, current authorized repair input
  `msg_bce2549adb4346a0a0fd2221d8576edd` remain bound together.
- Original checkout is clean at corrected descendant
  `0b289721647eddafa8e5d9bba4f5ce2daf945811` (parent `ddefc44`). This new candidate
  is under independent source review, not runtime-accepted or verified yet.
- Native foreground is inactive/succeeded, with no input, permission or form
  pending. The hook entered with background count zero, then recorded
  `idle-lineage-unavailable`, not a formal current-input idle report.
- Persisted idle state retains an OLD report for `msg_00b3dfeb…`, execution start
  3094/event 3096. The current start is 3271; success 4247 invalidated the old report.
  The session log (`follow:false`) returned only `log.synced`, not recoverable
  historical events. An observed zero at hook entry cannot replace the missing
  lineage-qualified report. Native background stays unknown.
- Plan version 85 holds on that mismatch, with no pending effects. The latest
  runner attempt still records artifact `ddefc44756ddcb384fce8ad0f5e0377b592dc756`.

## Existing-control limitation

`prepareRetainedVerification` (`runtime.ts:631–754`) permits a blocked plan with
the original running attempt, using isolated no-inference resources. But it
rejects any candidate different from the non-null attempt/node artifact before
the unrecorded-current-HEAD path. Retained repair clears the node artifact but
keeps the prior attempt artifact; ordinary completion captures the new candidate
only after the missing-background gate. Thus the corrected immutable candidate
cannot use the existing retained-verification route either.

Source quarantine can preserve mutable-source reservation boundaries without
claiming idle, but cannot repair this candidate binding. Descendant adoption
requires idle and is not a bypass. Do not verify the old commit as if it contains
the repair, replay a model turn, clear historical resources, or change SQL.

## Narrow follow-through

The missing-idle hold itself is truthful and remains. A runtime correction can
let an explicitly authorized retained verification identify the exact committed,
scope-valid repair descendant in its original owned checkout, binding it to the
current repair/input and immutable operation without rewriting earlier artifact
history or inventing original execution completion. Preserve identity, owner and
control epochs, source guards/reservations, native/effect revalidation, isolation,
human gates and unknown-resource cleanup holds. Wrong/stale/unrelated candidates
and uncertain delivery remain rejected.

This is distinct from LZ-174's interrupted continuation authorization fix, LZ-88
approval clearing and LZ-164 read-only inspection. It supplements LZ-57 retained
repair and LZ-138 candidate verification, not a replacement implementation worker
for LZ-173. Root's WebGPU `main.ts` and lease fixtures remain reserved.
