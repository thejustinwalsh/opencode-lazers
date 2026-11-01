# Failed retained-attempt resume

The task machine now permits the existing runtime `RESUME` command to move a
failed task node back to running. The persisted machine version remains
`lazers-task/1`; the change is additive and preserves prior task snapshots.

The focused regression uses a temporary Git checkout, SQLite task repository,
`RunnerStore`, and actual `TaskRuntime`. A worker produces a failed verification
receipt and stopped failed attempt; an authorized resume continues that same
attempt, session, workspace and policy. The test observes retained failure
history and usage, an idempotent replay, a fresh receipt for the changed commit,
and no additional attempt, session or worktree. Separate cases confirm stale or
unauthorized callers, unavailable owners, and intended/uncertain effects cannot
resume work. `RETRY` after failure still creates a distinct attempt.

Checks observed:

- `bun test src/runner/machine.test.ts src/runner/failed-resume.test.ts` — 6
  tests passed, 143 assertions.
- `bun test src/runner/runtime.test.ts` — 77 tests passed, 1,438 assertions.
- `bun run verify` — formatter, linter and strict typechecker passed.
