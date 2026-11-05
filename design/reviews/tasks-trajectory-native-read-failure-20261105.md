# Tasks history and trajectory product check

Native Desktop exposes Open, Completed, Failed/exhausted, Cancelled and All task
filters. Completed history loads, task references are visible, and selected tasks
offer Copy task link and Open trajectory. However, Completed includes accepted
tasks with pending combined product gates; it is not a list of fully integrated
deliveries. Preserve that distinction in existing Tasks presentation work.

Opening LZ137's historical trajectory selected the Trajectory tab, but displayed
`Trajectory for LZ-137 is unavailable: Trajectory snapshot could not be refreshed`
and `No tasks are associated with this scope`. Navigation exists; the actual
historical read is broken. The latter empty-state message is misleading after a
failed read.

Production log entries at `2026-11-05T09:36:37.744Z` and
`2026-11-05T09:44:40.686Z` identify `lazers.observability/trajectoryStatus` failure:
`Observation scope is too large; narrow it`. A fresh read at Unix milliseconds
`1793872099792` returned public `rpc.internal` / `RPC call failed`.

Source cause: `src/observability/read.ts` loads full project projection history
before checking the requested task in `trajectory`, `trajectoryHistory` and
`trajectoryStatus`. `loadProjectionSource` rejects above 10,000 transitions,
attempts or checks, even when the caller requests one task. This also breaks the
Models selected-task effort read; its UI renders the error as `[object Object]`.
Read-only DB inspection counted 14,104 project transitions, 133 attempts and 695
verification effects: transitions already exceed that ceiling.

Repair should authorize the requested task/attempt within the selected scope,
then read the required task-scoped data and truthful boundary, without loading
unrelated project history. Do not merely raise the ceiling or discard history.
The existing panel entry path must also change: `trajectory-panel/projection.ts:59`
calls full-project `rpc.snapshot`, and `panel-state.ts:271` awaits that snapshot
before selected-task history/status loading. Backend task-method narrowing alone
cannot repair actual navigation. Include the minimal consumer/transport adaptation
and preserve selected task identity and check display; this is existing behavior
restoration, not a new UI feature. Verify the complete entry path above the old
ceiling, not just direct backend method calls.
Reconcile with existing LZ131 and Models/Tasks work; add a focused linked increment
only if their current scope cannot coherently contain this repair. Cover an
unrelated project-history volume above the old ceiling, foreign task exclusion,
task and attempt lookup, historical/status reads and actual Desktop navigation.

Read-only findings: no production data, source, settings or running workers were
modified during this observation.

## Native tasking follow-through

Architect submitted LZ139 (`873b7617-e895-486d-bdba-7e89b07dee07`), plan
`916474c0-4f49-4c42-80dd-718ff3c20ba3`. Existing owner c59 applied supported
scope amendment/version7 adding the consumer projection/state files and tests.
No immutable task rewrite, duplicate task or worker restart was needed.

Its first launch reached preparing attempt
`dd65c71f-4864-4bdd-a412-03856c5c72c4`, then worktree creation returned
`Worktree.DirectoryUnavailableError`; no worker session exists. The creation
effect remains uncertain. Native inventory found no matching tree. Disk had
7.3GiB available, so ENOSPC is not established.

Root's source hypothesis: `nativeHost.worktree` passes `ctx.location.directory`
as `from`, while the shared scheduler selects its first registered participant.
A removed checkout's retained location could therefore be used as a creation
source. Actual selected host identity is not captured, so this is not yet a
confirmed cause. Validate canonical project sourcing and a removed-location
regression within existing LZ118/owner coordination. LZ118 is actively implementing
startup recovery; no watched canonical source was changed mid-worker.
