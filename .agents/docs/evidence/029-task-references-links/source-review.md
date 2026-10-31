# References source landing review

2026-10-31. Task `7207e67f-927e-41a2-b382-a3a8904ee54f` (`LZ-25`), accepted
attempt `1aa93ea5-623b-4921-b26e-7a4646a659df`, artifact `d1f58b4`.

The artifact was already merged as `053338d`; no duplicate merge or implementation
was performed for the delayed task-accepted notice. Its omitted association-aware
adapter changes and optional-reference workaround were repaired by Root in
`1f9fb6a`, with the read boundary documented in `6cebc7c`.

Reviewed current source:

- `src/observability/task-reads.ts` joins persisted references into Session
  summaries, searches the reference relation and resolves an LZ reference to its
  UUID before checking Session membership. Unknown/foreign membership stays closed.
- `src/tasks/contract.ts` requires the reference again. The original cancelled-plan
  Open filter from `653e2c4` remains in the association-aware adapter.
- Shared tool/RPC reads, persisted identity/retry handling and native link-handler
  coverage remain. Root's reviewed `5d9be1f` retains original `239e728` ancestry
  without changing the recovered final source tree.

Fresh command:

```sh
bun test src/storage.test.ts src/submission.test.ts src/tools.test.ts src/tasks test/task-links src/observability/read.test.ts test/observability/registered.test.ts
```

Result: **63 passed, 0 failed, 527 assertions** across 12 files. These checks do
not establish Desktop interaction or quality checks for Root's concurrently
uncommitted startup-recovery changes, which were left untouched.

Normal runtime command `references-task-source-landed-d1f58b4-v1` recorded this
accepted task's source landing at plan `58146c54-d236-4235-9704-630ad550c084`
v13 → v14, observed HEAD `955036c`. It did not finalize the combined plan,
clean worktrees or alter the active grouping worker.

## Remaining native observation

Spike 029 still explicitly requires a real Tasks inspector Copy task link,
paste into a native message, rendered-link click and correct scoped Tasks
selection. Returning the user's copied `LZ-23` Markdown link is not proof of
that interaction. This source record does not claim it occurred; native driver
evidence must close that concrete boundary separately. Grouping and progress
continue in their existing owned attempts; lifecycle retains its real prerequisite.
