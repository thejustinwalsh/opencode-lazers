# Spike 022 — native parallel dispatch and combined integration

## Question and increment

Can LAZERS overlap ready, disjoint isolated workers within one plan and across
plans without weakening the shared-checkout serial default, dependency gates,
native worktree ownership, or verified integration?

The scheduler now reserves and dispatches compatible ready tasks together under
the existing single project reconciler lease. Shared tasks remain single-writer;
isolated tasks are held behind active shared work and any equal, wildcard, or
ancestor-conflicting path scope. Dependency consumers receive a deterministic
Git artifact made from their accepted dependency closure, rather than an
unrelated earlier ordinal. Plan completion merges every accepted branch in
`integrationOrder`; a Git conflict blocks combined acceptance while leaving all
task artifacts and checks intact. Combined isolated checks use an owned native
worktree. Worker start/stop transitions retain attempt, native session, actual
workspace, observed time, and outcome for lifetime review.

No budget/concurrency quota, UI, routing, migration, or GPU policy was added.

## Recovery and integration

Each attempt is durably reserved before native effects. Existing effect fences
and reconciliation continue to prevent replay after lost worktree, session, or
prompt responses. A blocked plan does not prompt an unstarted reservation;
already-started siblings are still observed and retain their usage and check
receipts. Cancellation waits for all sessions to stop. Integration conflicts
are reported as `blocked`, never repaired by resetting a branch or checkout.

After reviewed merge, cleanup still selects only recorded native worktrees,
requires idle sessions, a clean status, and merged commits, then calls the
host's non-forced removal API. Dirty, unmerged, or foreign worktrees remain
protected.

## Regression evidence

`src/runner/runtime.test.ts` uses delayed worker sessions with real Git
worktrees. It proves overlap within one plan and across two plans, records
overlapping `WORKER_STARTED`/`WORKER_STOPPED` identities, waits for dependencies,
serializes wildcard/ancestor scopes, and prevents a second reconciler from
duplicating dispatch. Real branch commits prove that combined checks see every
branch, that overlapping content conflicts preserve both accepted artifacts,
and that failure, cancellation, and repair preserve sibling state, usage, and
verification receipts. A lost native creation response is recovered after a
runtime restart without prompting blocked work; existing prompt-response loss
recovery prevents a second worker session. A reviewed multi-branch merge cleans
only its owned worktrees while preserving a foreign one; dirty and unmerged
owned worktrees are retained.

Source map: `runtime.ts:434-550` selects compatible work; `552-626` handles
cancellation and records worker lifetimes; `628-663` resolves dependency
inputs; `665-864` reserves and dispatches native workers; `1048-1174` combines
branches and verifies the resulting artifact; `1176-1240` protects cleanup.
`artifacts.ts:36-103` provides conservative scope conflict detection and ordered
Git merging; `store.ts:343-395` applies scope conflict detection at audit. The
parallel real-Git regressions are in `runtime.test.ts:422-816`; dirty and
unmerged cleanup regressions are at `runtime.test.ts:1327-1396`.

These tests establish scheduler behavior against a delayed host fixture and
real Git. They do **not** establish native OpenCode worker overlap. See the
[native dogfood record](../evidence/022-native-parallel-dispatch/native.md); its
native-overlap requirement remains unresolved until exercised in OpenCode.

## Verification

- `bun test src/runner test/runner`: 36 tests passed, 654 assertions.
- `bun test`: 155 tests passed, 1,487 assertions.
- `bun run verify`: formatting, lint, and typecheck passed.

Native overlap and native reviewed cleanup are separate from these automated
results and remain unresolved in the [native evidence note](../evidence/022-native-parallel-dispatch/native.md).
