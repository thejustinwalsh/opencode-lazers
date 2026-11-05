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

Concurrent authoring did create LZ140 (`e96994a1-2d36-490c-8f02-763bdadbd816`).
Before Root's inspection, c59 had used the native disposition tool to mark it
duplicate of139 at `2026-11-05T10:23:07.584Z`, request
`lz140-concurrent-duplicate-of-root139-20261105-v1`, disposition record11.
It has no plan/node or attempt. This demonstrates reconciliation after a raced
overlap query, not prevention of duplicate specification creation. No duplicate
implementation was dispatched and both immutable records remain.

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

### Targeted native cache maintenance

Root inspected the pinned public debug handler and location-map implementation.
`debug.location.list` found8 cached locations, including the already removed,
fully integrated LZ133 tree. No active session used that directory. At Unix
milliseconds `1793875323579–1793875323636`, Root used
`debug.location.evict({location:{directory: old133Directory}})` to retire only
that cached location. Readback found7 entries and no133 entry. Active worker118
and c59 remained active; worker118 retained its session, directory and Luna Max
route. No source edits, worker prompt/interrupt, lifecycle SQL writes or global
reload. Raw result: `/private/tmp/lazers-evict-cleaned133-location-20261105.json`.

This proves a cleaned checkout retained cached services and that targeted native
retirement worked. It does not prove the actual failed139 call selected that host
or settle its uncertain effect. Permanent canonical-source binding and cache
retirement follow-through still need review in the existing recovery work.

Primary API source: [debug handler](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/server/src/handlers/debug.ts),
[location map](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/location-service-map.ts).

Desktop was restored to Tasks → Open with actual running LZ118 selected. Current
list limitations remain visible:139's node says Running although its attempt is
preparing with no native worker, and older authored reason text still mentions99
even after its source isolation. Feed these into existing Tasks A/B's authoritative
state/attention/reason work; do not treat arbitrary old reason prose as live
eligibility or create another task-list implementation.
