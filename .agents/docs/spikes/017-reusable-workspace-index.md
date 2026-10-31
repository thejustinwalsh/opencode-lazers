# Spike 017: reusable workspace index

## Outcome

The context service now keeps one persisted Repomix snapshot per canonical worktree. `context_workspaces` retains the worktree identity, and `context_cache` uses the reserved `$workspace` selection for the current snapshot; ordinary path selections no longer create cache rows or Repomix packs.

Architect uses `lazers_project_refresh` to collect the bounded workspace and publish a complete snapshot. The tool requires the native `lazers_project_refresh` permission and the `architect` caller role; the service enforces the role again. The snapshot file is written to a private temporary file and renamed before the SQLite pointer is updated in one transaction. A failed collection, processing step, file write, or database update leaves the prior pointer unchanged. Concurrent reads continue to resolve the prior complete snapshot until publication.

`lazers_project_index`, `lazers_project_read`, and task packet construction only load the persisted snapshot. They do not enumerate the workspace, read source files, invoke Repomix, or write cache state. Each call re-checks native file permission for its principal before returning a path or source; permission decisions are not cached across callers or calls. Existing canonical-workspace isolation, ignore policy, secret filtering, symlink rejection, source limits, and response bounds remain in force.

Read outputs include the stable snapshot ID, refresh timestamp, and `freshness: "as-of-refresh"`. This identifies exactly what the response describes; it is not a claim that the worktree has not changed since refresh. Reads do not detect newly added files, changed content, deletions, or updated ignore rules. Architect explicitly refreshes when those changes matter. An absent snapshot is an explicit unavailable-index error, never a read-side build. Legacy selection-specific cache rows are not promoted to the workspace snapshot.

## Verification coverage

`src/context/index.test.ts` covers Repomix filtering, stable identity across selections and service reopen, throwing collection/processor spies, cache-state immutability on reads, current reader permission and revocation, absent and foreign indexes, failed refresh rollback, visibility of additions/edits/deletions/ignore changes after refresh, reads during a concurrent refresh, and bounded responses. `src/context/tools.test.ts` covers native tool permissions and Architect-only refresh. `src/architect.test.ts` checks that Architect is told to reuse snapshots and refresh explicitly.

Verification on 2026-10-31: focused `bun test src/context src/tools.test.ts src/architect.test.ts` passed (24 tests); full `bun test` passed (177 tests); `bun run verify` passed formatting, lint, and typechecking. No source hashes or evidence receipts are used as gates.
