# Task workspaces and integration

User direction, 2026-10-31. Serial tasks default to native child sessions in the
current checkout. Parallel tasks use OpenCode-managed worktrees. Explicit
isolation remains available when a serial task needs it. One writer owns a shared
checkout; dependent work waits for its prerequisite to be integrated.

Use `ctx.worktree.create/list/refresh/remove`, not a LAZERS worktree strategy.
Record task/attempt ownership, the returned actual directory, starting ref,
resulting commits, integration result and cleanup outcome. Native `directory`
means the parent destination; `branch` means the starting ref. Preserve the
returned directory when the host handles a name collision.

Child creation inherits its parent's location. In pinned OpenCode 2.2.5,
`session.create` ignores the supplied `location` when `parentID` is present.
For isolated work, use `session.move` and confirm the assigned location before
prompting. Shared children retain their inherited checkout.

Review the changes and checks, integrate them, and verify the combined result.
For this dogfood run the driver performs review and merge; the user waived PR
and human-review stops. Normal production flow may use PR review and merge.

Reconcile the task ledger with native worktree inventory. After integration,
remove each owned worktree through OpenCode with `force: false`. Preserve dirty,
unmerged or still-running work. Keep cleanup failures visible and retryable;
cleanup failure does not erase an accepted implementation or its history. Recovery
must distinguish an already-removed directory from an unfinished removal, and
never remove unrelated worktrees. Reconcile leftovers at startup and after merges.

Current boundary: native creation and location routing are implemented. Shared
checkout selection, recorded integration and automatic cleanup still require a
bounded runner increment. The existing interrupted attempt retains its original
worktree and preserved edits while its corrected worker flow is verified.

Pinned source: [session handler](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/server/src/handlers/session.ts),
[worktree lifecycle](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/worktree.ts).
