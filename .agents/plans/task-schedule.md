# Task Schedule Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the Tasks panel shows is a stored projection kept current in the writer's
transaction, so the panel reads `tasks.*` keyset sources through data streams and the cursor
chains, `taskViewCache`, `scheduledTaskPageSQL` and the merged tree are deleted.

**Architecture:** One `task_schedule` row per task with a composite `sort_key`, a `bucket`
for the state chips and the display fields; `task_schedule_plans` per plan; child tables for
dependencies, reservation blockers, prerequisite plans and sessions and scope paths; a stored `search_text` for search. Triggers
on the source tables queue dirty entries; `drainTaskSchedule` runs inside `atomic` and
`atomicAsync` and recomputes only the affected plan or task. Backfill is paged and resumable.

**Tech Stack:** TypeScript (strict), Bun 1.4.4, `bun:sqlite` (SQLite 3.54),
XState (`lifecycleMachines`, unchanged), the streams API in `src/streams/`, SolidJS.

**Spec:** [design/task-schedule-projection.md](../../design/task-schedule-projection.md) (read it first), with
[design/data-handling.md](../../design/data-handling.md) and [design/data-streams.md](../../design/data-streams.md).

## Global Constraints

- Workflow states and transitions stay in XState. The projection is derived: nothing in it is
  read by a decision, and no transition exists only in SQL. Triggers queue facts; they compute
  nothing.
- A decide read never reads the projection. Show reads use the streams only.
- No cap refuses or truncates a read; a batch size is a unit of work with its measurement
  beside it. "Unknown" is never a default in the UI or the vocabulary.
- No native binaries or addons. No FTS5 in this lane (see the design).
- Every write that can change a stored row is covered by a trigger and a test that fails when
  one is missing (Task 5).
- A schema generation bump needs a full service restart; say so in the commit that bumps it.
- Never open the live `tasks.sqlite` for writing. The only reads of it are the parity audit on
  a copy the owner places under a temp path, and row counts or `EXPLAIN` read-only.
- New worker scripts are added to `scripts/build-server.ts`; this plan adds none.
- Tests: `bun test --timeout 120000 <files>`; `bun run verify` before each commit.
- Atomic Conventional Commits, configured identity, no AI attribution, signing as configured.
- Work in the worktree `.claude/worktrees/task-schedule`; never build in the main checkout.
- Do not change the live service from a task here. Reloads, restarts and the Desktop
  walkthrough belong to the driver (Task 14).

## Review Focus

1. A missed write path: any statement that changes a displayed value without queuing a dirty
   entry (Task 5 rebuild-equivalence and trigger-coverage tests).
2. A refresh that reads stale sources: every refresh runs inside the writing transaction and
   reads current rows (Task 5).
3. The hot tables: `runner_transitions` (438,621 rows live) and `runner_attempts` counter
   updates must cost zero trigger work (Task 2 test counts dirty inserts per event).
4. Order parity: `sort_key` equals the seven-term SQL order for every combination (Task 3).
5. Backfill concurrent with writes and restarts (Task 7).
6. The reservation blocker equals `effectiveExecution` for every plan mode, scope and pause
   (Task 4).
7. Every non-terminal state has an exit: dirty entries always drain (Task 5 test with a
   throwing refresh leaves the entry and reports it; a later drain recovers).

## File Structure

| File                                      | Responsibility                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/tasks/schedule/schema.ts`            | Module install: tables, indexes, triggers, views; state and dirty tables                               |
| `src/tasks/schedule/key.ts`               | Pure: `rankOf`, `bucketOf`, `encodeSortKey`                                                            |
| `src/tasks/schedule/facts.ts`             | Read the facts one refresh needs (plan, node, attempt, concern, sessions)                              |
| `src/tasks/schedule/status.ts`            | Pure `effectiveStatus(facts)`, the extracted `effectiveExecution`                                      |
| `src/tasks/schedule/blockers.ts`          | Reservation set fingerprint and blocker recompute                                                      |
| `src/tasks/schedule/refresh.ts`           | `refreshTask`, `refreshPlan`, `refreshReservations`, `refreshPause`                                    |
| `src/tasks/schedule/drain.ts`             | `drainTaskSchedule`, dirty queue, work budget                                                          |
| `src/tasks/schedule/search.ts`            | The filter fragments for search and `scopePath`                                                        |
| `src/tasks/schedule/backfill.ts`          | Paged, resumable backfill and readiness                                                                |
| `src/tasks/schedule/owner.ts`             | Project-core owner: backfill loop, table-change drain, idle when clean                                 |
| `src/streams/sources/tasks.ts`            | `defineSource` for `tasks.schedule`, `.dependencies`, `.plans`, `.blockers`, `.waits`, `.bucketCounts` |
| `src/tasks/schedule/parity.ts`            | Old-versus-new comparison used by tests and the audit script                                           |
| `scripts/task-schedule-audit.ts`          | Read-only audit of a database path                                                                     |
| `test/fixtures/task-schedule/corpus.json` | Golden event corpus and expected orders                                                                |

---

### Task 1: Schema module, tables, views

**Files:** Create `src/tasks/schedule/schema.ts`, test beside it; modify
`src/database-schema.ts` (new `"task-schedule"` module with every table including the FTS5
shadow tables), `src/storage.ts` (call the installer where the other modules install).

**Interfaces — Produces:**

```ts
export const TASK_SCHEDULE_TABLES = [...] as const
export function installTaskScheduleSchema(db: Database): void // idempotent; one transaction
export const BUCKETS = ["running","queued","paused","blocked","open","accepted","integrated","failed","cancelled"] as const
export type Bucket = (typeof BUCKETS)[number]
```

- Columns, keys and indexes exactly as in the design (`task_schedule` with `seq` PK,
  `task_schedule_plans`, `_edges`, `_blockers`, `_waits`, `_sessions`, `_scopes`, `_counts`, `_dirty`, `_state`, view `task_schedule_session_bucket_counts`).
- Install creates all tables and indexes, drops and recreates triggers (Task 2 supplies the
  trigger SQL), inserts a `task_schedule_state` row per known project with `ready = 0`.

- [ ] Test: install twice leaves one copy of each object; `schemaDrift()` reports no undeclared
      and no missing table .
- [ ] Test: installing at a lower stored generation upgrades; a higher stored generation throws
      `Unsupported LAZERS schema module`.
- [ ] Test: `EXPLAIN QUERY PLAN` for the three list reads (default, bucket filter, creator
      filter) uses `(project_directory, retired, ...)` indexes and no temp B-tree.
- [ ] Implement; run; `bun run verify`; commit
      `feat(tasks): task schedule projection schema, generation 1`.

### Task 2: Triggers that queue dirty entries

**Files:** Modify `src/tasks/schedule/schema.ts` (trigger SQL); create
`src/tasks/schedule/triggers.test.ts`.

**Interfaces — Produces:**

```ts
export type DirtyKind = "task" | "plan" | "reservations" | "pause"
export const SCHEDULE_TRIGGERS: readonly {
  table: string
  event: "INSERT" | "UPDATE" | "DELETE"
  columns?: readonly string[] // UPDATE OF
  when?: string // trigger WHEN guard
  queues: DirtyKind
  ref: string // SQL expression over NEW/OLD
}[]
```

- Triggers per the design table: `tasks`, `task_references`, `task_dispositions`,
  `task_classifications`, `runner_plans`, `runner_nodes`, `runner_dependencies`,
  `runner_attempts`, `runner_adoptions`, `runner_transitions` (two guarded triggers),
  `runner_dispatch_controls`, `lazers_dispatch_pause`, `recovery_concern_versions`,
  `recovery_concern_dispositions`. Each body is only `INSERT OR IGNORE INTO task_schedule_dirty`.
- Triggers are created only for tables that exist (the recovery tables are created by another
  module); the installer re-runs when that module installs (hook in its install).

- [ ] Test: for each trigger, one write to the source table inserts the expected dirty entry
      (kind, ref) and an irrelevant column write inserts none (`tool_count`, `retry_count`,
      `version`-only plan update, a non-guarded transition event).
- [ ] Test: 10,000 unguarded `runner_transitions` inserts add zero dirty entries and cost under
      2x the baseline insert time (measured, asserted loosely, recorded in the test name).
- [ ] Test: writes from a second connection (a stale copy without the drain) queue entries.
- [ ] Implement; run; verify; commit `feat(tasks): triggers queue schedule projection work`.

### Task 3: Pure derivations: rank, bucket, sort key

**Files:** Create `src/tasks/schedule/key.ts`, `key.test.ts`.

**Interfaces — Produces:**

```ts
export type KeyFacts = {
  planID: string | null
  nodeState: string | null
  planState: string | null
  priority: number | null // plan body priority, 0 or null is none
  planSeq: number | null
  ordinal: number | null
  seq: number
  finishedAt: number // 0 for open ranks
}
export function rankOf(facts: Pick<KeyFacts, "nodeState" | "planState">): 0 | 1 | 2 | 3 | 4 | 5
export function bucketOf(facts: {
  nodeState: string | null
  planState: string | null
  paused: boolean
}): Bucket
export function encodeSortKey(facts: KeyFacts): string // fixed-width, byte-comparable
export function decodeSortKey(key: string): KeyFacts // test and audit only
```

- `rankOf` is `STATE_RANK_SQL` (`schedule-order.ts:10-17`); `encodeSortKey` is the seven terms
  as in the design; `prioritySortSQL` rule from `priority.ts:30` is mirrored (none sorts last).

- [ ] Test (oracle): seed a real SQLite database with every node state x plan state x priority
      x finished combination (planned and unplanned) and compare the order of `encodeSortKey`
      against `scheduledTaskPageSQL` output (the old SQL, still present) row by row.
- [ ] Test: `bucketOf` against every `TaskStateFilter` predicate from `taskStatePredicate`
      (`state-filter.ts:35`) over every node x plan x pause combination on a real database.
- [ ] Test: field widths hold at the extremes (priority 2,147,483,647, `seq` 9e15, finished 0).
- [ ] Implement; run; verify; commit `feat(tasks): schedule rank, bucket and sort key`.

### Task 4: Status and reservation blockers

**Files:** Create `src/tasks/schedule/status.ts`, `blockers.ts`, `facts.ts` and tests.

**Interfaces — Consumes:** Task 3. **Produces:**

```ts
export type StatusFacts = {
  node: NodeRow
  plan: PlanRow
  waitingOn: string[] // store.ts:3842 semantics
  prerequisitePlans: PlanWaitFact[] // waitingOnPlanFacts, whole
  adoptionHold: { id: string; reason: string | null } | null
  pause: DispatchPause | undefined
  blockers: string[] // task ids, whole
  references: ReadonlyMap<string, string>
}
export function effectiveStatus(facts: StatusFacts): {
  status: TaskState
  reason: string | null
  blockedBy: "plan" | "prerequisites" | "reservation" | null
}

export type Reservation = { taskID: string; shared: boolean; scopes: readonly string[] }
export function activeReservations(db: Database, project: string): Reservation[]
export function reservationFingerprint(set: readonly Reservation[]): string
export function blockersFor(
  task: { scope: readonly string[]; planMode: "shared" | "isolated" },
  set: readonly Reservation[],
): string[]
```

- `effectiveStatus` is `effectiveExecution`'s decision tree (`read.ts:392-459`) as a pure
  function; `blockersFor` uses `scopePatternsConflict` and the `mode === "shared" || entry.shared`
  rule. The "Prerequisite plan facts are incomplete" branch is removed (waits are stored whole).

- [ ] Test: table-driven parity with `TaskReads.effectiveExecution` over plan states, node
      states, pause levels, adoption holds, prerequisites, reservations (shared, isolated,
      overlapping and disjoint scopes, scope amendments).
- [ ] Test: `activeReservations` equals `RunnerStore.dispatchReservations()` on a seeded
      database with active attempts and adoptions.
- [ ] Implement; run; verify; commit `feat(tasks): pure effective status and blocker derivation`.

### Task 5: Refresh and drain

**Files:** Create `src/tasks/schedule/refresh.ts`, `drain.ts`, `search.ts` and tests; modify
`src/storage.ts` (`atomic` at 537, `atomicAsync` at 555: call `drainTaskSchedule` after `run`
and before commit).

**Interfaces — Consumes:** Tasks 1 to 4. **Produces:**

```ts
export function refreshTask(db: Database, taskID: string): void
export function refreshPlan(db: Database, planID: string): void // plan row, node rows, edges, waits, cascade
export function refreshReservations(db: Database, project: string): void
export function refreshPause(db: Database, scope: string): void

export type DrainResult = {
  handled: number
  remaining: number
  failed: { kind: DirtyKind; ref: string; error: string }[]
}
export function drainTaskSchedule(db: Database, options?: { budget?: number }): DrainResult
export function installScheduleDrain(repository: TaskRepository): void // sets the hook used by atomic/atomicAsync
```

- A refresh reads current source rows inside the caller's transaction and upserts only the
  columns whose value differs (compare, then write), so unchanged rows cost no write and no
  index churn.
- `finished_at` is incremental from `transition_mark` (design: Sorting).
- A failing refresh leaves its dirty entry, records the error on the `task_schedule_state` row
  and does not fail the writer's transaction; the next drain retries it.
- `budget` is a count of rows touched with its measurement noted in code; the drain returns
  `remaining`, and the owner (Task 7) continues.

- [ ] Test: each refresh equals a from-scratch derivation of the same row (the same function
      run with an empty projection).
- [ ] Test (differential, seeded): a random event stream drives the real writers for 2,000
      events; after each event, every projection row equals the rebuild; failures print the
      event index and the seed.
- [ ] Test (coverage): trigger coverage per Task 2 table; a static check greps `src/` for SQL
      writes to the source tables and fails on an unlisted table.
- [ ] Test: `move` plus its transition record yields one `finished_at` equal to the old
      `MAX(created_at)` query; a cancelled plan with a node without its own record falls back to
      the plan's newest transition and re-keys when one more arrives.
- [ ] Test: a priority change re-keys only that plan's rows (count writes); a plan cancel re-keys
      its rows and queues dependents; a cycle-free cascade terminates.
- [ ] Test: a throwing refresh leaves the dirty entry and the write commits; the next drain
      recovers.
- [ ] Test: with the drain budget at 1, a project rename of 50 tasks drains over several calls
      and ends equal to the rebuild.
- [ ] Implement; run; verify; commit `feat(tasks): refresh and drain the schedule projection in the writer's transaction`.

### Task 6: Observations the writer cannot know

**Files:** Modify `src/runner/dispatch.ts` (near 158 and 217), `src/runner/store.ts`
(`recordOnce` caller helper), `src/recovery/handoff/store.ts` (near 1282); modify
`src/tasks/schedule/refresh.ts` to fold them; tests beside each.

**Interfaces — Produces:**

```ts
// store.ts
recordPrerequisiteObservation(planID: string, taskID: string | null, observation: {
  decision: "ready" | "waiting"
  reason: string | null
  head: string | null
}): boolean // recordOnce(..., "PREREQUISITE_OBSERVED", ...)
```

- The dispatcher records each prerequisite proof result when it changes. The refresh reads the
  newest `PREREQUISITE_OBSERVED` for the task and the plan into `decision` and
  `decision_reason`. Missing observation with integrated prerequisites yields `waiting` with the
  reason "Waiting for the scheduler to confirm the prerequisite integration".
- The concern version write stores the totals snapshot used by the inspector (`concern_totals`
  on the version payload); the refresh does not read trajectory facts.
- `TaskDecision` loses `unknown`: update `scheduling-contract.ts` and its consumers.

- [ ] Test: a fake git runner returning ready, then waiting, then an error: three
      `PREREQUISITE_OBSERVED` writes at most (one per change), and the row `decision` follows.
- [ ] Test: no observation yet gives the explicit waiting reason, never an unknown value.
- [ ] Test: a concern version carries totals; the projection row exposes line and reasons only.
- [ ] Implement; run; verify; commit `feat(runner): record prerequisite observations for the schedule projection`.

### Task 7: Backfill, readiness and the project-core owner

**Files:** Create `src/tasks/schedule/backfill.ts`, `owner.ts` and tests; modify
`src/core/core.ts` (start and stop the owner with the project core).

**Interfaces — Consumes:** Task 5. **Produces:**

```ts
export function backfillPage(
  db: Database,
  project: string,
  page: number,
): { done: boolean; next: number }
export class TaskScheduleOwner {
  constructor(repository: TaskRepository)
  start(): void // backfill loop until ready, then table-change drain; idle when the queue is empty
  ready(project: string): boolean
  close(): void
}
```

- `backfillPage` runs one page in one `BEGIN IMMEDIATE`; `backfill_after` and the rows commit
  together. `page` is a unit of work (tasks per transaction, measured), not a cap.
- The owner yields the event loop between pages, resumes from `backfill_after` after a restart,
  and drains leftover dirty entries on `subscribeTables` notifications. When clean it holds no
  timer.

- [ ] Test: kill and restart the owner mid-backfill (fake clock); it resumes at the stored
      watermark and ends equal to the rebuild.
- [ ] Test: writes arriving between pages (submits, moves) end consistent.
- [ ] Test: `ready` flips only after the last page; the old read path stays selected until then.
- [ ] Test: a generation bump drops and recreates the projection and backfills again.
- [ ] Implement; run; verify; commit `feat(tasks): paged resumable backfill of the schedule projection`.

### Task 8: Sources

**Files:** Create `src/streams/sources/tasks.ts`, `tasks.test.ts`; modify
`src/streams/sources/index.ts`.

**Interfaces — Consumes:** Task 1. **Produces:** the six sources in the design table.

```ts
export const taskScheduleSource: Source<TaskScheduleFilter, typeof taskScheduleColumns>
export type TaskScheduleFilter = {
  project: string
  bucket?: Bucket | readonly Bucket[] | "open" | "completed" | "legacy"
  retired?: boolean
  session?: string
  creator?: string
  search?: string
  scopePath?: string
}
export const taskDependenciesSource: Source<{ parent: string }, ...>
export const taskPlansSource: Source<{ project: string; state?: string }, ...>
export const taskBlockersSource, taskWaitsSource, taskBucketCountsSource
```

- `tasks.schedule`: orders `schedule` (`sort_key`, `task_id`) and `recent` (`seq` desc,
  `task_id`); `count: { exact: "scan" }`; `detail` columns for `window: 1`.
- Search and `scopePath` filter fragments from `search.ts` (`instr` on `search_text` and `task_schedule_scopes`); `tables` names every table read so table-level refresh works.
- `tasks.dependencies` order is `ord`; `tasks.plans` order is `(priority_key, seq)`.

- [ ] Test (stream harness, seeded projection): head window, slide, `seek(key)` equal the old
      `Tasks.query` pages for every filter and both sorts.
- [ ] Test: a window anchored on a key whose `sort_key` changes (priority change) re-anchors by
      key and keeps `before` and `after` correct.
- [ ] Test: search and `scopePath` equal the old `instr` results on a fixture where the match
      is inside the six indexed fields; strings of 1, 2 and 3 characters, `"` and `%` in the
      query.
- [ ] Test: a table-level refresh fires for a write to `task_schedule` and not for an unrelated
      table.
- [ ] Implement; run; verify; commit `feat(streams): tasks.* sources over the schedule projection`.

### Task 9: Parity harness, golden corpus, audit script

**Files:** Create `src/tasks/schedule/parity.ts`, `parity.test.ts`,
`test/fixtures/task-schedule/corpus.json`, `scripts/task-schedule-audit.ts`.

**Interfaces — Produces:**

```ts
export type Divergence = {
  filter: string
  sort: "schedule" | "recent"
  index: number
  old: string | null
  new: string | null
}
export function compareReads(db: Database, project: string): Divergence[] // empty when equal
```

- `compareReads` pages the old `TaskReads.query` and the `tasks.schedule` window for every
  `TaskStateFilter` x both sorts x {no scope, session scope}, plus `tasks.plans` versus the
  scheduling plan order and `tasks.dependencies` versus topology edges.
- The corpus holds the recorded event script (cancelled plans, accepted not integrated, takeover,
  dispatch paused, prerequisite plans, reservation conflicts) and the expected ordered ids per
  filter, generated by running the old read once and committed.
- The audit script opens its argument read-only (`mode=ro`), runs `compareReads` and prints the
  first divergence per filter; it refuses to run on a path that is the live `tasks.sqlite`
  unless the open is read-only (it always is).

- [ ] Test: the corpus replays to the committed expectations on both paths.
- [ ] Test: `compareReads` is empty after the Task 5 differential run.
- [ ] Test: breaking one trigger makes `compareReads` report a divergence (guards the guard).
- [ ] Implement; run; verify; commit `test(tasks): parity harness and golden corpus for the schedule projection`.

### Task 10: Panel on streams

**Files:** Modify `src/tasks/panel.tsx`, `src/tasks/panel-state.ts`,
`src/tasks/virtual-rows.ts`, `src/tasks/row-presentation.ts`; create `src/tasks/panel-streams.ts`;
tests updated (`panel-state.test.ts`, `virtual-rows.test.ts`, `row-presentation.test.ts`).

**Interfaces — Consumes:** Task 8 and the GUI stream client (`src/streams/gui.ts`).
**Produces:**

```ts
export function openTaskList(input: {
  project: string
  filter: TaskScheduleFilter
  window: number
}): TaskListStreams
export type TaskListStreams = {
  list: Stream<TaskScheduleRow>
  children(taskKey: string, parent: string): Stream<TaskDependencyRow> // one per expanded row
  counts: Stream<BucketCount>
  close(): void
}
export function spliceItems(
  list: readonly TaskScheduleRow[],
  children: ReadonlyMap<string, readonly TaskDependencyRow[]>,
  expanded: ReadonlySet<string>,
): VirtualItem[]
```

- The panel's `window` follows the virtualizer (view plus slop); `slide` and `seek` replace the
  cursor chain. `expandedKeys` stays view state; a child stream opens on expand and closes on
  collapse or row exit. Cycles are cut by the ancestor path, as today.
- `TaskPanelState` keeps selection, detail and activity handling; list, scheduling, topology,
  caches and cursors are removed.

- [ ] Test: expanding a row opens one `tasks.dependencies` stream; collapsing closes it;
      expanding a child opens another; a cycle shows the row without a subtree.
- [ ] Test: a node state change updates the row in place and does not move the scroll anchor.
- [ ] Test: chips show counts from `tasks.bucketCounts`; with a search active no count badge.
- [ ] Test: panel unmount closes every stream (no buffer held).
- [ ] Implement; run; verify; commit `feat(tasks): the Tasks panel reads stream windows`.

### Task 11: Other callers

**Files:** Modify `src/models/models-controller.ts` (near 338), `src/tools.ts` (544, 569),
`src/tasks/rpc.ts` (97 to 111), `src/observability/task-reads.ts`, `src/core/core.ts` (230),
`src/projects/scope.ts` (unit cursors); tests updated.

- Agent tools read one `tasks.schedule` window and return the edge key as the continue marker;
  search snippets are composed from the returned tasks' bodies (the `summarize` logic moves
  into the tool).
- The all-projects read opens one `tasks.schedule` stream per readable unit in unit order.
- The Models panel opens `tasks.schedule`, order `recent`.

- [ ] Test: each caller returns what it returned before, for the existing fixtures
      (`read.test.ts`, `rpc.test.ts`, `all-projects.test.ts`, `tools.test.ts` pages).
- [ ] Implement; run; verify; commit `refactor(tasks): move task readers onto the schedule projection`.

### Task 12: Delete the old reads

**Files:** Delete `src/tasks/schedule-order.ts`, `src/tasks/execution-list.ts`,
`src/tasks/scheduling-read.ts` panel path, the `TasksScheduling` panel RPC and the topology
panel read; remove `readPage`, `stateCounts`, the snapshot cursor, `taskStatePredicate` (after
Task 3 test migrates to a stored table of expectations), `TaskReads.query` and `queryAll`,
`effectiveExecution`, `taskViewCache`, `inspectedCache`, `projectCache` and their tests.

- Run only after Task 9 shows an empty `compareReads` on the corpus and on the audit of a copy
  of the live database supplied by the owner.
- Keep `TaskSchedulingRead` pieces the Architect still uses; delete what only the panel read.

- [ ] Test: nothing imports a deleted module (`bun check`); the bundle test still passes.
- [ ] Run the full affected test set; `bun run verify`.
- [ ] Commit `refactor(tasks): delete the cursor reads and the merged tree`.

### Task 13: Documentation

**Files:** Modify `design/data-streams.md` (sources table), `design/runtime-state-machines.md`
(a note: the projection is derived, no transition in SQL), `README.md` panel notes.

- [ ] Update; `bun run verify`; commit `docs: Tasks panel reads the schedule projection`.

### Task 14: Rollout and walkthrough (driver)

- [ ] Build the server bundle and the GUI bundle (`bun run build`), in the worktree.
- [ ] Merge to `main` after the lead's review. The schema generation needs a full service
      restart; reload at a quiet point (`scripts/reload-safe.ts`), confirm `ready = 1` in
      `task_schedule_state`, and that the dirty queue is empty.
- [ ] Walk the Tasks panel in the regular Desktop: filter chips and counts, search, expand
      dependencies, priority change, plan cancel, a running task finishing, a dispatch pause.
      Record any divergence as a defect with the reproduction.
- [ ] Run the audit script on a copy of the database; attach the empty report to the PR.
