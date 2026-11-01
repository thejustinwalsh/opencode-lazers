# LZ-28 retained-candidate review

Plan `8253ff59-57a5-45fd-8847-acd971438af8`, original task
`239f45a9-3247-4cba-b339-19c8267d0800`, original attempt
`33e6b86d-edda-41dc-9ac4-93d195f537ea`. Candidate:
`e127d1a5836b65ca6d89dd19974f94249e9df1ed`.

## Recorded block and reconciliation

The worker stopped normally. Runtime focused, all, and quality checks exited
zero against the candidate; the focused receipt records 125 tests / 1,954
assertions. The worker's implementation evidence reports 387 full-suite tests,
but that annotation is not a replacement for native observation.

The plan stopped at v8 for missing task-level `native-dogfood:human` evidence.
Allowed `audit` and `reconcile` were requested with stable command IDs
`lifecycle-native-gate-audit-e127d1a-v1` and
`lifecycle-reconcile-retained-native-gate-v1`. After reconciliation it is v10,
still blocked on the same requirement. All six native/verification effects are
complete, with no pending effects. There is no uncertain operation to replay.
The candidate, original attempt, selected Luna Max route and owned worktree are
retained. No retry, replacement worker, acceptance, source merge, native reload
or cleanup was requested.

## Reproduced input-safety finding — do not activate this candidate

The candidate observes `ctx.session.hook("prompt")`, but native synthetic input
is a separate admission path on pinned OpenCode 2.2.5. At host commit
`9bbb8ce18c80f099e0e448775f59d965ead40a21`,
`packages/core/src/session/session.ts:286-326` directly calls
`admission.admit` for synthetic input without running the prompt hook. A queued
synthetic with `resume:false` need not change busy/idle timing.

Candidate `considerArchitectRenewal` checks the predecessor inbox once before
native successor creation (`src/runner/runtime.ts:883-897`). Later transfer,
archive and commit checks consult prompt markers and busy/idle timing, not new
foreign inbox arrivals. The existing tests invoke `observeArchitectPrompt`
directly for input races, which does not cover this native bypass.

The isolated [`queued-input-repro.ts`](queued-input-repro.ts) invokes the exact
candidate renewal implementation with a disposable SQLite fixture and fake host.
It injects one external queued synthetic input during successor creation, after
the initial empty-inbox read. Observed result:

```text
renewalState: committed
predecessorArchived: true
ownerTransferred: true
queuedForeignInputStillOnPredecessor: true
nativeInboxReads: 1
```

This is a deterministic implementation reproduction, **not native dogfood**. It
does not prove that a real input was lost, but does show that the candidate can
commit archival without accounting for an admitted input on a supported native
path. The reproduction changes no application database, native session, model,
worker checkout or task state. Run it with Bun and
`LAZERS_CANDIDATE_DIRECTORY` pointing to the retained exact candidate checkout.

There is also an incomplete handoff contract: the persisted wake payload contains
plan IDs, label and predecessor/successor identities, and the renderer asks for
live plan reads. It has no explicit decision/unresolved-question snapshot or
durable reference to such a snapshot. Review must establish how conversation-only
decisions/questions survive renewal without replaying or summarizing the old
transcript; the current passing tests do not establish that requirement.

## Safe next boundary

Do not manufacture Root evidence or convert the passing tests/progress-tool
roundtrip into native lifecycle acceptance. Preserve the live owner and block
archival until the input-safety gap is repaired or native support proves a
fail-closed protocol. Repair should retain this task/attempt lineage and add the
missing native-admission cases; a replacement implementation task is not needed.

After review repairs and fresh exact-artifact checks, Root still owns actual
busy/recent reuse, configured idle renewal, labelled same-route successor,
durable handoff/current-owner outcome routing, input during creation/transfer/
archival, visible inactive predecessor and unchanged-worker observations.
Wake bytes must match the actual emitted text. Wake-attributed tokens/cache and
API-equivalent costs remain unknown unless public native evidence identifies
their scope. Native proof and artifact-bound human evidence must precede
acceptance, integration and normal non-forced cleanup.
