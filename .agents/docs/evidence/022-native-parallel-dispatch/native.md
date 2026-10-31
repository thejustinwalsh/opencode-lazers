# Native parallel-dispatch dogfood evidence

## Status: unresolved — native run not performed

No OpenCode Desktop/native scheduler plan was run during this implementation.
There are therefore no native worker session IDs, actual native worktree
directories, native start/stop observations, reviewed integration receipt, or
non-forced native cleanup receipt to report. Do not infer native overlap from
queued plans or the automated host fixture.

## Automated evidence (not native dogfood)

The runner tests use delayed in-process `RunnerHost` sessions and real Git
worktrees. They verify simultaneous active isolated workers in one plan and
across plans; persisted `WORKER_STARTED` and `WORKER_STOPPED` records bind
attempt, session, workspace, time, and outcome. They also cover dependency
inputs, wildcard/ancestor serialization, combined branch acceptance and
conflict preservation, branch failure/cancellation/repair, lost worktree
response recovery after restart, and owned-only cleanup after a reviewed merge.
Dirty and unmerged owned worktrees and foreign worktrees remain preserved. These
tests do not call OpenCode's native session/worktree APIs.

The final automated checks passed: `bun test src/runner test/runner` (36 tests,
654 assertions), `bun test` (155 tests, 1,487 assertions), and `bun run verify`
(formatting, lint, and typecheck).

## Required native follow-up

Run a disjoint isolated multi-task plan through the loaded LAZERS plugin in
OpenCode Desktop. Record the plan and task IDs; for each attempt, record its
attempt/session/workspace identities and `WORKER_STARTED`/`WORKER_STOPPED`
observations. Confirm at least two worker intervals overlap, each native task
check passes, and the combined artifact contains every branch. Review and merge
that exact artifact, request integration, and retain the native cleanup
receipts showing owned clean inactive worktrees were removed without force while
foreign or unmerged work survived. Replace this status only with observed
evidence from that run.
