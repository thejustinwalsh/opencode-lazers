# Cleanup repair review

Observed 2026-11-09, Unix milliseconds 1794240011509 onward. This reviews an
uncommitted LZ-185 draft, not an accepted candidate. Architect owns disposition,
worker advice, integration and live observation.

## Performance concern

In the draft native checkout `3156909f-f2b7-429d-b50c-a9c879079a18`,
`TaskRuntime.tick()` visits cleanup-blocked/cancelled plans and calls
`worktreeCleanupFactsChanged()`. For existing uncertain removals this calls
`worktreeCleanupObservation()` before deciding whether facts changed.

That observation lists native worktrees, synchronously runs Git inventory,
top-level, HEAD, status, unresolved-index and main HEAD commands, and reads
associated native sessions with messages. The standalone runtime fallback is
10 seconds; production `src/index.ts` registers `runtime.tick()` at 2 seconds.
The audit found 38 cleanup-blocked plans with 50 clean merged checkouts. Thus
unchanged holds can still cause repeated expensive observations; suppressing
removal retries alone does not suppress this work. This is a source-supported
scaling concern, not a measured candidate CPU regression.

Review the reconciliation cost against the real retained inventory. Keep cleanup
eventually progressing when ownership/activity/source facts change, without
recreating the previous constant CPU drain. Use existing scheduler/event/native
facilities; no new daemon or worker takeover is requested. Routine design choices
remain with Architect and implementor.

## Current observations

- Earlier broad worker run: 495 tests passed. Later edits are not covered by it.
- Adoption rerun after timeout correction: 25 passed, 0 failed, 277 assertions.
- The newer automatic-retry regression still reproduced the stale-idle hold;
  the SAME worker was actively investigating it after compaction.
- Native Architect was idle while this worker ran. No worker delivery had yet
  occurred, so an idle parent alone does not establish a lost completion notice.
- A running-service snapshot showed about 111% CPU. It was not an idle baseline
  or a run of this unintegrated draft.

Manual removal of 16 worktrees and about 7.8 GiB does not establish automatic
cleanup. Observe the repaired scheduler against retained resources after native
review/integration, preserving active, dirty and useful unmerged work. Keep
implementation acceptance separate from pending cleanup.

This report is driver review assistance. It is not autonomous detection or repair
by the product. See `worktree-cleanup-audit-20261109.md` and its linked inventory
for the original leak and native cleanup intervention.

## Architect disposition

Architect inspected the same worker's draft and confirmed the call chain:
`tick()` → `worktreeCleanupFactsChanged()` → `worktreeCleanupObservation()`.
Full native inventory, synchronous Git probes and message-bearing session reads
occur before the fingerprint comparison. Identical removal retry suppression
therefore does not address unchanged observation cost.

Resolve this inside LZ-185, preserving the same worker and current useful work.
Use cheap eligibility/invalidation and shared observations within the existing
scheduler/native lifecycle; retain bounded fallback for external changes or
missing events. Cached facts must never authorize removal without fresh safety
checks. No new daemon, worker takeover or integration dependency is warranted.

Before integration, review deterministic counts of actual expensive Git/native
session operations over repeated unchanged ticks at representative inventory
scale, plus automatic reconsideration after relevant fact changes and restart.
Keep dirty/unmerged/active/unknown resources safe and demonstrate eventual cleanup
when holds resolve. Earlier broad test passes do not cover later draft edits.

The same-worker checkpoint was admitted through native recovery controls;
consumption and response were not yet observed at that admission. Reassess the
implemented selection approach and focused operation-count/convergence results,
the delivered candidate, or a concrete blocker. This records a review requirement,
not a completed fix or measured candidate performance result. Driver assistance
remains explicitly attributed; cleanup stays first in the existing roadmap.

## Native disposition

Driver feedback was submitted through Desktop as
`msg_1c10ab56f0015vtke2JcXHkBCN`, Unix1794240067108. Architect acknowledged
it in `msg_1c10ab636001FZmybJReWweUCH`, read this report and started reviewing
the tick path, preserving the SAME worker. This proves receipt and investigation,
not a performance fix, integration or automatic cleanup.

Subsequent source review corrected the cadence above: the production registration
uses 2 seconds. Architect confirmed the repeated observations and recorded native
follow-up disposition `3ae45e71-b783-469c-b437-c5ab966eb763`, preserving the current
worker. Its response `msg_1c10d846d0010HcX0otqRwHTcU` reports steering for cheap
unchanged ticks and cleanup after facts change. Those results remain unproven.
