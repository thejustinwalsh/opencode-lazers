# Task schedule projection: the Tasks panel as keyset sources

Status: draft for review (2026-11-20). Applies [data handling](data-handling.md) principle 2
("store derived views; update them incrementally") to the Tasks list so the panel can read
through [data streams](data-streams.md). Plan: [.agents/plans/task-schedule.md](../.agents/plans/task-schedule.md).

## Intent

The Tasks panel cannot move onto streams because what it shows is not a column of any table.
This design stores everything the list shows as rows kept current in the writer's transaction,
so each panel read becomes a plain keyset source: a window over indexed columns, served by a
read worker. Nothing is overlaid from main-thread memory, nothing is rebuilt on read.

Constraints this design keeps: workflow states stay in XState (`lifecycleMachines`); the
projection is derived and never a second source of truth; no transition exists only in SQL;
no cap refuses work; "unknown" is never a UI default; no native binaries.

## What the code does today

| Read                               | Where                                                                        | Cost and shape                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Tasks.query` (`sort: "schedule"`) | `src/storage.ts:912` `readPage`, `src/tasks/schedule-order.ts:32`            | Window functions over every task of the project, 7-term order, `position` cursor                |
| `finished` time                    | `schedule-order.ts:44-51`                                                    | Per finished task, `json_extract` over every transition of its node (about 1,700 per node live) |
| Row fields                         | `src/tasks/read.ts:216-252` (`query`), `:392` (`effectiveExecution`)         | Per row: 6 point reads, a plan-body `zod` parse, a full reservation scan                        |
| `transport.scheduling`             | `src/tasks/scheduling-read.ts:792` `buildSnapshot`, `panel-state.ts:208`     | Up to 1,000 plans, git ancestry proofs, in-process caches                                       |
| `topology`                         | `src/observability/read.ts:2504`, `panel-state.ts:472`                       | Every plan, node and dependency of the project                                                  |
| Merge and tree                     | `execution-list.ts`, `virtual-rows.ts`, `panel-state.ts:147` `taskViewCache` | Cursor chains, a 24-entry view cache, a derived tree rebuilt per change                         |

Measured on the live database, read-only (260 tasks, 251 nodes, 221 plans, 438,621
transitions): the first page of the schedule order costs **50 ms** on the main thread, and
`EXPLAIN QUERY PLAN` shows two correlated `runner_transitions` subqueries and two temp
B-trees. The cost is linear in project tasks times transitions per node, per page, per
refresh.

### Premise corrected: reservations are already persisted

`effectiveExecution` consults `runner.dispatchReservations()`, which looks like in-memory
state but is not (`src/runner/store.ts:3747-3761`). It is a pure derivation of three
persisted things:

- `activeProjectAttempts()` (`store.ts:4523`): `runner_attempts` rows in `preparing`,
  `running`, `verifying` (partial index `runner_attempts_active_project`).
- `activeAdoptions()` (`store.ts:4897`): `runner_adoptions` rows in `pending`, `task-checks`,
  `combined-checks`.
- `effectiveReservationScope()` (`store.ts:3743`): the task's `writeScope` and `createScope`
  plus the newest `SCOPE_AMENDED` transition (`store.ts:3712`, written at
  `src/runner/commands-scope.ts:89`).

So the blocker reason is a function of stored rows. It changes only when one of those rows
changes, and every such change is a database write we can observe. No overlay and no
in-memory persistence step is needed.

## The projection

One row per task, one row per plan, and three small child tables. No tree rows and no plan
header rows are stored: the panel renders no plan headers (`virtual-rows.ts` lists tasks
only; plans supply priority and nesting), and a tree row would duplicate a DAG per parent.

```
                      ┌──────────────────────┐
 tasks ──────────────►│ task_schedule        │◄── one row per task   (the list)
 runner_nodes/plans ─►│  sort_key, bucket,   │
 runner_attempts ────►│  status, reason, ... │
 recovery concerns ──►└──────┬───────────────┘
                             │ task_id            ┌─────────────────────────┐
                             ├───────────────────►│ task_schedule_edges     │ dependency children
                             ├───────────────────►│ task_schedule_blockers  │ reservation blockers
                             ├───────────────────►│ task_schedule_waits     │ prerequisite plans
                             ├───────────────────►│ task_schedule_sessions  │ session association
                             └───────────────────►│ task_schedule_scopes    │ write-scope paths
 runner_plans ───────────────►│ task_schedule_plans │ one row per plan (detail, scheduling plans)
```

### `task_schedule` (the list row)

`seq INTEGER PRIMARY KEY` is `tasks.created_version`: unique across projects, immutable, and
the key every child table joins on. It replaces `tasks.rowid`, which a full `VACUUM` (`src/retention/vacuum.ts`)
may renumber; the old order tie-break (`-task_rowid`) silently depends on rowid stability,
this one does not.

| Group       | Columns                                                                                                                                                                                        | Source of truth                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Identity    | `seq`, `task_id` UNIQUE, `project_directory`, `reference`, `revision`, `created_at`, `session_id`                                                                                              | `tasks`, `task_references`                                   |
| Task text   | `title` (`taskTitle`, `presentation.ts:2`), `objective` (first 400 chars), `classification` (current), `source_plan` (json)                                                                    | task body, `task_classifications`                            |
| Disposition | `retired` (bool), `disposition` (json: disposition and reason)                                                                                                                                 | `task_dispositions`                                          |
| Schedule    | `plan_id`, `plan_seq`, `ordinal`, `node_state`, `plan_state`, `rank`, `bucket`, `priority_key`, `finished_at`, `finished_basis`, `transition_mark`, `sort_key`                                 | `runner_nodes`, `runner_plans`, `runner_transitions`         |
| Display     | `status`, `reason`, `started_at`, `takeover`, `concern` (json: line, reasons), `dispatch_pause` (json), `wait_plans_count`, `blocker_count`, `dependency_count`, `decision`, `decision_reason` | derived in the refresh from the above and the attempt tables |

Indexes (every one leads with `project_directory`; each serves one source order and filter):

| Index                                                | Serves                                |
| ---------------------------------------------------- | ------------------------------------- |
| `(project_directory, retired, sort_key)`             | default list, schedule order          |
| `(project_directory, retired, bucket, sort_key)`     | state chips (Running, Queued, ...)    |
| `(project_directory, session_id, retired, sort_key)` | creator-session scope                 |
| `(project_directory, retired, seq)`                  | `recent` order (the old default sort) |
| `(plan_id)`                                          | plan-scoped refresh and plan detail   |

### `task_schedule_plans` (plans)

`plan_id` PK; `project_directory`, `seq` (the plan's rowid at first sight, immutable),
`title`, `state`, `reason`, `priority` (0 is none), `priority_key`, `owner_session_id`,
`workspace_mode`, `after_plans` (json), `after_plans_count`, `pause` (json),
`plan_version`, `plan_revision`, `node_count`, `open_count`.
Index `(project_directory, priority_key, seq)`: the scheduler's plan order, which replaces
`planOrder` and the 1,000-plan page chain of `transport.scheduling`.

### Child tables

| Table                    | Key                           | Holds                                                                                                                       | Replaces                                                                  |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `task_schedule_edges`    | `(parent_task_id, ord)`       | `child_task_id`, `kind` (`plan`, `after-plan`), `child_reference`, `child_title`, `child_state`, `waiting`, `child_plan_id` | `relationMap`/`dependencyTasks` (`execution-list.ts:304`), topology edges |
| `task_schedule_blockers` | `(task_id, blocker_task_id)`  | the active reservations a queued task conflicts with                                                                        | `reservationTaskIDs` (capped at 100 today)                                |
| `task_schedule_waits`    | `(task_id, ord)`              | `plan_id`, `title`, `state`, `reason`: prerequisite plans not yet integrated                                                | `waitingOnPlans` (capped at 100, `schema.ts:381`)                         |
| `task_schedule_sessions` | `(session_id, task_id, role)` | `role`: `creator`, `owner` (plan owner), `attempt`                                                                          | the three-way `OR EXISTS` of `observability/task-reads.ts:120`            |

Edge indexes: `(child_task_id)`, `(child_plan_id)` for fan-out updates. Blockers: `(blocker_task_id)`.
Sessions: `(task_id)`.

Search has no index. `task_schedule.search_text` holds the lower-cased six fields
`summarize` matches (id, reference, objective, write scope, acceptance assertions, context
references); the reader worker filters with `instr(search_text, ?)`. `task_schedule_scopes
(task_id, path)` (indexed by `path`) holds the write-scope paths for `scopePath`. At 260 live
tasks a scan of one narrow column is cheap, and no shadow tables or schema drift follow. **When
to replace it with FTS5:** when a project passes about 50,000 tasks, or when a search query
exceeds 10 ms on a window read. FTS5 with the trigram tokenizer works in this `bun:sqlite`
(SQLite 3.54.0); the data point is 12 ms for a below-3-character scan and 2 ms for a trigram
`MATCH` over 50,000 rows. Rerun that scratch measurement against `search_text` at the real row
count before switching.

### Sorting without renumbering: the schedule key

The order in `scheduledTaskPageSQL` (`schedule-order.ts:56-65`, displayed ascending) is seven
terms. Each is a function of stored columns of the row's own node, its plan and its task:

| #   | Term (`schedule-order.ts`)                                                                                | Stored column   | Changes when                                        |
| --- | --------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------- |
| 1   | `rank` (`STATE_RANK_SQL`, `:10-17`: cancelled 5, failed 4, incorporated 3, accepted 2, running 0, else 1) | `rank`          | node moves; plan state changes                      |
| 2   | `rank<=1 AND plan_id IS NULL` (unplanned open work last)                                                  | folded into key | the task is planned                                 |
| 3   | `-finished`                                                                                               | `finished_at`   | node enters a terminal state; plan fallback (below) |
| 4   | `priority_key` (`planPrioritySortSQL`, `priority.ts:50`)                                                  | `priority_key`  | plan body revised (`store.ts:4047`)                 |
| 5   | `rank<=1 ? plan_rowid : 0`                                                                                | `plan_seq`      | never                                               |
| 6   | `rank<=1 ? ordinal : 0`                                                                                   | `ordinal`       | never                                               |
| 7   | `rank>=2 OR unplanned ? -task_rowid : task_rowid`                                                         | `seq`           | never                                               |

**Choice: (a) a composite `sort_key TEXT`, stored per row, recomputed only for rows whose
terms changed.** Fixed-width decimal fields, concatenated in term order, compare bytewise
(SQLite BINARY collation) exactly as the seven terms compare:

```
sort_key = rank(1) | unplanned_open(1) | 9999999999999 - finished_at (13)
         | priority_key (10) | plan_seq or 0 (16) | ordinal or 0 (9)
         | seq or 9999999999999999 - seq (16)       -- sign chosen as in term 7
```

The source order is `[sort_key asc, task_id asc]`, a two-term keyset: `source.ts:beyond`
(`:165`) expands an n-term order into an n-way `OR` of `IS ?` equalities; with seven separate
columns the planner cannot seek and walks the index. With one key column the seek is a plain range.
`sort_key` already contains `seq`, so it is unique per project; `task_id` is the declared key.

| Option                                        | Rows written per event                                                                           | Why not / why                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) composite key, recompute changed rows** | node move 1; plan state or priority change N(plan); plan submit N(plan); attempt 1; hot events 0 | **Chosen.** N(plan) averages 1.14 live (max 5). Locality follows from the terms: only the row's own node and plan feed it                                                       |
| (b) fractional or gap ranks                   | same N(plan) re-key, plus a neighbour read per insert, plus precision exhaustion                 | The order is a pure function of row state, not of insertion history; a midpoint buys nothing and adds a failure mode                                                            |
| (c) renumber a plan's rows only               | not definable: ranks are global, so a plan's new rank shifts every row after it                  | Renumbering the plan's rows is not enough; a priority change moves a plan past other plans, shifting up to every row of the project (about 130 now, tens of thousands at scale) |

Writes per event:

| Event                                                                                    | `task_schedule` rows                   | Other rows                                                     |
| ---------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| `move` of one node (`store.ts:4176`)                                                     | 1                                      | 1 plan counter row; edges whose child is the node (successors) |
| Plan state change (cancel, block, unblock, clean)                                        | N(plan)                                | plan row; edges of the plan; dependent plans' waits (cascade)  |
| Plan priority change (`revisePlan`, `store.ts:4047`)                                     | N(plan)                                | plan row. No other plan's rows: the key is per row             |
| Plan submit (`store.ts:3990`)                                                            | N(plan) updated                        | plan row, edges                                                |
| Attempt start or end                                                                     | 1                                      | blockers of queued tasks if the reservation set changed        |
| Pause or unpause (project, global, plan)                                                 | queued and ready nodes of the scope    | none                                                           |
| `tool_count`/`retry_count` bump (`roles.ts:265,299`)                                     | 0                                      | trigger scoped to `UPDATE OF state,...`                        |
| Transition insert of any other event (438,621 live, mostly outbox and Architect notices) | 0                                      | trigger guarded by `WHEN`                                      |
| Project code rename (`projects/registry.ts:140`)                                         | all tasks of the project (`reference`) | paged drain, see Maintenance                                   |

`finished_at` is incremental, not recomputed. Today it is `MAX(created_at)` over the node's
transitions whose `payload.to` equals the node state (`schedule-order.ts:46-48`). A node's
state changes only through `move` (`store.ts:4176` is the only `UPDATE runner_nodes SET state`),
and `move` always records a transition `to` that state (`store.ts:4179`). So the refresh keeps
`transition_mark` (the newest transition id it has seen for the node); when `node_state`
differs from the stored value it reads only transitions with `id > transition_mark` and takes
the newest `to = node_state`. Cost: the transitions since the last refresh, not 1,700. A
node with no own record (a legacy row) falls back to the plan's newest transition
(`finished_basis = 'plan'`, `schedule-order.ts:49`); those rows are re-keyed when a
transition arrives for a cancelled plan, which is rare and bounded by N(plan).

`bucket` is one column that replaces `taskStatePredicate` (`src/tasks/state-filter.ts:35`).
The predicates are mutually exclusive except `open`, `completed` and `all`, so one value per
row answers every chip:

| `bucket`     | Definition (from `state-filter.ts`)                                                          |
| ------------ | -------------------------------------------------------------------------------------------- |
| `cancelled`  | plan or node cancelled                                                                       |
| `failed`     | node `failed` or `exhausted`                                                                 |
| `integrated` | node `incorporated`                                                                          |
| `accepted`   | node `accepted`                                                                              |
| `paused`     | node `queued`/`ready`, plan not blocked or cancelled, plan, project or global dispatch pause |
| `blocked`    | node `blocked`, or plan `blocked` with a non-terminal node                                   |
| `running`    | node `running`, plan not blocked or cancelled                                                |
| `queued`     | node `queued`, plan not blocked or cancelled, not paused                                     |
| `open`       | everything else open: `ready`, `verifying`, and tasks with no node                           |

Filters become: `open` is `bucket NOT IN (cancelled, failed, integrated, accepted)`;
`completed` is `bucket IN (accepted, integrated)`; the legacy default is `bucket NOT IN
(accepted, integrated, cancelled)`; `all` has no clause. A table-driven test checks every
node-state by plan-state by pause combination against the SQL predicates before they are deleted.

## The panel as sources

All sources are defined with `defineSource` (`src/streams/source.ts:62`) in
`src/streams/sources/tasks.ts` and imported by `sources/index.ts`. Collapse is not a filter on
one flat tree: the expanded set is per-view client state, and a source filter cannot see it.
Instead each expanded row owns one small child stream, which is the window contract applied to
a tree.

```ts
export const taskScheduleSource = defineSource({
  name: "tasks.schedule",
  table: "task_schedule",
  tables: ["task_schedule", "task_schedule_sessions", "task_schedule_search"],
  key: ["task_id"],
  orders: {
    schedule: [{ column: "sort_key", direction: "asc" }, { column: "task_id", direction: "asc" }],
    recent:   [{ column: "seq", direction: "desc" }, { column: "task_id", direction: "asc" }],
  },
  columns: { task_id: "text", sort_key: "text", seq: "int", reference: "text", title: "text",
             status: "text", reason: "text", node_state: "text", bucket: "text", plan_id: "text",
             priority_key: "int", started_at: "int", takeover: "bool", classification: "text",
             concern: "json", dispatch_pause: "json", dependency_count: "int", blocker_count: "int",
             wait_plans_count: "int", decision: "text", decision_reason: "text",
             disposition: "json", retired: "bool", source_plan: "json", revision: "int", ... },
  filter: (f: { project: string; bucket?: Bucket | readonly Bucket[]; retired?: boolean;
                session?: string; creator?: string; search?: string; scopePath?: string }) => ...,
  count: { exact: "scan" },  // an index range count; see Sizes
})
```

| Source               | Table (view)                                  | Key                          | Order                      | Filter                                                        | Replaces                                                                            |
| -------------------- | --------------------------------------------- | ---------------------------- | -------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `tasks.schedule`     | `task_schedule`                               | `task_id`                    | `schedule`, `recent`       | project, bucket, retired, session, creator, search, scopePath | `Tasks.query`, cursors, `taskViewCache`; `detail` columns carry the cold row fields |
| `tasks.dependencies` | `task_schedule_edges`                         | `(parent_task_id, ord)`      | `ord`                      | `parent` (a task id)                                          | `dependencyTasks`, `flattenExecutionList` nesting                                   |
| `tasks.plans`        | `task_schedule_plans`                         | `plan_id`                    | `schedule` (priority, seq) | project, state                                                | `transport.scheduling` pages, `topology.plans`                                      |
| `tasks.blockers`     | `task_schedule_blockers` join `task_schedule` | `(task_id, blocker_task_id)` | `blocker_task_id`          | `task`                                                        | `reservationTaskIDs`                                                                |
| `tasks.waits`        | `task_schedule_waits`                         | `(task_id, ord)`             | `ord`                      | `task`                                                        | `waitingOnPlans`                                                                    |
| `tasks.bucketCounts` | view `GROUP BY bucket`                        | `bucket`                     | `bucket`                   | project, session                                              | `stateCounts` (`storage.ts:1012`)                                                   |

How the tree renders. The panel opens `tasks.schedule` with `window` = view plus slop. A row
with `dependency_count > 0` is expandable. Expanding it opens `tasks.dependencies` with
`{ parent: task_id }`; expanding a child opens another for the child's id. The consumer splices
child windows into the parent's items by key (`task:<id>` and `<parent key>><id>` as today).
Cycles are cut on the client by the ancestor path, as `flattenExecutionList` does now
(`virtual-rows.ts:141`), because the path is view state. Child rows carry reference, title,
state and `waiting`, so the `referenceRow` fallback for unknown tasks disappears. At most one
child stream exists per expanded row; closing the row closes the stream.

Counts. `tasks.schedule` uses the default probe count (`count: "more"`): one existence probe per
side, no scan of a table that grows with tasks. A view that needs a position (the chips) reads
`task_schedule_counts (project_directory, bucket, n)`, stored per-bucket counters kept by the
refresh: a row write adjusts the old and new bucket in the same transaction. `tasks.bucketCounts`
reads that table; the session-scoped chip counts read `task_schedule_session_bucket_counts`, a
view over `task_schedule_sessions` and the row's bucket (cost proportional to the session's
tasks).

Detail. `tasks.schedule` opened with `window: 1` adds the cold columns (`wait` text, the
concern totals, `plan_title`). Plan, blockers and waits are the sources above, anchored at one
key. `Tasks.get` still reads the immutable task body, advice, audit history and the attempt
and activity lists by id; those are point reads of the detail pane and belong to the details
lane, not to the list.

## Maintenance: every write path

### Why triggers and a drain

The writes that move a row are spread over 117 SQL statements in 35 files (counts from
`grep` of `INSERT`, `UPDATE` and `DELETE` against the source tables, test files and fixtures
excluded):

| Source table                                  | Statements     | Files | Where (examples)                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | -------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner_plans` state, reason, body, owner     | 52             | 19    | `store.ts:3990` insert, `:4048` revise, `commands-control.ts:173,255,305`, `cancellation.ts:223`, `plan-finish.ts:337`, `retire-gates.ts:55,97,155,390`, `worktree-cleanup.ts:841-951`, `adoption-execution.ts:108,891,918,962`, `commands-recovery.ts:171,202,268,331,378,449,489,607`, `commands-scope.ts:206,251`, `takeover.ts:752`, `plan-step.ts:255,315` |
| `runner_nodes`                                | 8              | 6     | state: `store.ts:4176` (`move`) only; `artifact` updates at `adoption-execution.ts:929,933`, `commands-control.ts:166`, `commands-retained.ts:172`, `verification-candidate.ts:781` do not change the row                                                                                                                                                       |
| `runner_attempts`                             | 33             | 15    | insert `dispatch.ts:370`, `takeover.ts:773`; state at `attempt-advance.ts:182,546`, `worker-preparation.ts:122,354`, `cancellation.ts:372,422`, `commands-control.ts:163`, `commands-retained.ts:177,457`, `verification-review.ts:739,763,766`, `retained-verification-execution.ts:2248`, `verification-candidate.ts:1049`                                    |
| `runner_adoptions`                            | 8              | 3     | `store.ts:4993,5057,5080,5247`, `adoption-execution.ts:885,912,956`, `retire-gates.ts:35`                                                                                                                                                                                                                                                                       |
| `runner_dependencies`                         | 2              | 2     | `store.ts:4009`, `plan-step.ts:207`                                                                                                                                                                                                                                                                                                                             |
| `runner_dispatch_controls`                    | 1              | 1     | `store.ts:1632`                                                                                                                                                                                                                                                                                                                                                 |
| `lazers_dispatch_pause`                       | 1              | 1     | `projects/pause.ts:50`                                                                                                                                                                                                                                                                                                                                          |
| `runner_transitions`                          | 7 + `record()` | 2     | `store.ts:4065`, `retire-gates.ts:60,102,165,200,315,395`                                                                                                                                                                                                                                                                                                       |
| `tasks`, `task_references`                    | 2 + 2          | 1+2   | `storage.ts:756` insert; `:821` reference; `projects/registry.ts:140` rename                                                                                                                                                                                                                                                                                    |
| `task_dispositions`, `task_classifications`   | 1 + 1          | 1     | `storage.ts:1414`, `:1119`                                                                                                                                                                                                                                                                                                                                      |
| `recovery_concern_versions`, `…_dispositions` | 2              | 1     | `recovery/handoff/store.ts:1282,1430`                                                                                                                                                                                                                                                                                                                           |

Listing call sites in each writer would miss the next one. The same shape already exists:
`src/models/decision-projection.ts:103-155` queues dirty tasks from triggers on the same tables.
This design follows it, with two differences: the drain runs inside the writing transaction,
and the unit of work is a plan, not a task.

```
 any writer, any connection        the writing transaction
 ──────────────────────────        ───────────────────────────────────────────────
 INSERT/UPDATE source table ─trigger─► INSERT OR IGNORE task_schedule_dirty(kind, ref)
                                       │
 repository.atomic / atomicAsync ──► run(db) ──► drainTaskSchedule(db) ──► COMMIT
      (storage.ts:537, :555)                      reads sources, upserts projection rows,
                                                  deletes the dirty entries it handled
```

Two choke points cover the writers: `TaskRepository.atomic` (`storage.ts:537`) and
`atomicAsync` (`:555`); `RunnerStore.atomic` (`store.ts:1520`), `fencedAtomic` (`:4233`) and the
retry wrappers all call them. Triggers fire for any copy of the plugin or any connection that
writes, including the 44 stale module copies this process may hold; a copy without the drain
leaves dirty rows, and the project core drains them from the table-change listener
(`database-events.ts` `subscribeTables`) the next turn. The dirty queue is durable, so a
crash between commit and settle loses nothing.

Triggers queue facts, not decisions: each trigger is `INSERT OR IGNORE INTO
task_schedule_dirty SELECT ...`. No trigger computes a state or a transition, so "no
transition only in SQL" holds. Workflow changes keep going through `RunnerStore.move`, the
`lz_runner_transition(...)` bridge and XState; the projection reads their results.

| Trigger on (columns)                                                                  | Queues (`kind`, `ref`)          | Notes                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `tasks` INSERT                                                                        | `task`, task id                 | body is immutable; no UPDATE trigger needed                             |
| `task_references` UPDATE reference, INSERT                                            | `task`                          | rename touches all tasks                                                |
| `task_dispositions` INSERT                                                            | `task`                          | append-only; `retired` and `disposition`                                |
| `task_classifications` INSERT                                                         | `task`                          | append-only                                                             |
| `runner_plans` INSERT, UPDATE OF `state,reason,body,owner,project_directory`          | `plan`, plan id                 | not `version` or `artifact`: `move` bumps `version` on every transition |
| `runner_nodes` INSERT, DELETE, UPDATE OF `state,reason,ordinal`                       | `plan`, plan id                 | per-node events re-derive only that node (see drain)                    |
| `runner_dependencies` INSERT, DELETE                                                  | `plan`                          | `plan-step.ts:207` prunes satisfied edges                               |
| `runner_attempts` INSERT, UPDATE OF `state,session_id,workspace,policy`               | `task`; `reservations`, project | not `tool_count`, `retry_count`, `message_id`, `artifact`               |
| `runner_adoptions` INSERT, UPDATE OF `state,hold_reason`                              | `task`; `reservations`, project |                                                                         |
| `runner_transitions` INSERT `WHEN event IN ('SCOPE_AMENDED','PREREQUISITE_OBSERVED')` | `reservations`; `task`          | the guard keeps the 438,621-row hot table at zero cost                  |
| `runner_transitions` INSERT `WHEN` its plan is `cancelled`                            | `plan`                          | only for the plan-fallback finish time                                  |
| `runner_dispatch_controls`, `lazers_dispatch_pause` INSERT, UPDATE                    | `pause`, plan id or scope       | project and global pauses touch every queued or ready node in scope     |
| `recovery_concern_versions`, `recovery_concern_dispositions` INSERT                   | `task`                          | open concern and its line                                               |

Drain order within one transaction: `task`, then `plan`, then `reservations`, then `pause`.

| Kind           | Work                                                                                                                                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`         | Parse the immutable body once if the row is new (title, objective, scope, search text); read classification, reference, disposition, sessions, latest attempt, open concern; recompute the task's schedule columns, status, key and edges                                                                                          |
| `plan`         | Parse the plan body once (`PlanInput`: priority, `afterPlans`, workspace mode, title); upsert the plan row; recompute every node row of the plan; rebuild the plan's edges and the edges of other plans whose children are in it; for each plan listing this one in `afterPlans`, queue a `plan` if this plan's stored row changed |
| `reservations` | Hash the active reservation set (task id, shared flag, effective scopes); if it differs from `task_schedule_state.reservations_fp`, recompute blockers for the project's queued and ready tasks and queue their rows                                                                                                               |
| `pause`        | Recompute `bucket`, `status` and `dispatch_pause` for queued and ready nodes in the scope                                                                                                                                                                                                                                          |

Both cascades terminate: a dependent is queued only when a stored row actually changed, and
`validatePlanDependencies` (`store.ts:4029`) already forbids plan cycles.

Drain budget. The drain handles every dirty entry; nothing is dropped or refused. To keep a
write transaction short, `drainTaskSchedule` stops after a work budget (rows touched, a unit
of work with the measurement beside it, not a cap) and leaves the rest queued; the core
continues from the table-change listener, each page in its own transaction. Normal events
(a move, an attempt, a plan state change) finish inside the writer's transaction. A project
code rename or a global pause is paged. A reader that arrives mid-drain sees rows that were
correct at the previous commit and gets the update on the next revision; there is no torn read.

### `effectiveExecution` and the reservation blocker

`read.ts:392-459` is reduced to a pure function `effectiveStatus(facts)` that the refresh
calls; `TaskReads.effectiveExecution` is deleted after the callers below move. Inputs are all
stored: node and plan rows, `waitingOn` (`store.ts:3842`), prerequisite plan facts
(`waitingOnPlanFacts`, `store.ts:3768`), pause, adoption hold, and the blockers.

| Visible result                                      | Computed when                                     | Stored in                                         |
| --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| `status`, `reason` for a cancelled plan             | `plan` refresh                                    | `task_schedule.status`, `.reason`                 |
| "Prerequisite plan facts are incomplete" blocked    | deleted: waits are stored whole, never incomplete | none                                              |
| "Waiting for prerequisite integration: ..."         | `plan` refresh of this plan or a prerequisite     | `status`, `reason`, `task_schedule_waits` rows    |
| "Waiting for checkout or write scope: LZ-12, LZ-13" | `reservations` refresh                            | `status`, `reason`, `task_schedule_blockers` rows |
| `waitingOn` (same-plan prerequisites)               | `plan` refresh                                    | `task_schedule_edges.waiting`                     |
| `dispatchPause`                                     | `plan` or `pause` refresh                         | `task_schedule.dispatch_pause`                    |
| `startedAt`                                         | `task` refresh (newest attempt `started_at`)      | `task_schedule.started_at`                        |

Blocker maintenance is incremental on the reservation set. Frequency: a reservation changes
when an attempt or adoption enters or leaves an active state (249 attempts in this project's
whole history, so on the order of 500 changes). That is the only trigger; per-tool events and
the 438,621 transitions do not reach it. When the set changes, the refresh recomputes blockers
for the project's queued or ready tasks in `running` plans (9 live; the conflict test
`scopePatternsConflict`, `runner/artifacts.ts`, is the same function dispatch uses at
`dispatch.ts:358,431,459`). Cost is queued tasks times active reservations (about 9 x 2), in the
writer's transaction.

The panel's current inconsistency is kept in the first cut for parity and called out as an
owner question: a task blocked by a reservation shows `blocked` but sits in the `queued`
chip, because `taskStatePredicate` reads only stored node and plan state.

### Derived text and flags

All stored at write time, in the `task` or `plan` refresh:

| Field                     | Written at                                                                                       | From                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `title`, `objective`      | task insert (`storage.ts:756`) via the `task` refresh                                            | `taskTitle(objective)` (`presentation.ts:2`)                                 |
| `classification`          | classification insert (`storage.ts:1119`), task insert                                           | `taskClassificationFor` (`classification.ts:93`)                             |
| `concern` (line, reasons) | concern version or disposition insert (`recovery/handoff/store.ts:1282,1430`), node state change | `openConcerns` (`recovery/detector.ts:314`), `canStruggle` of the node state |
| `takeover`                | attempt insert (`dispatch.ts:370`, `takeover.ts:773`)                                            | `isTakeoverAttempt(policy)` of the newest attempt (`detector.ts:368`)        |
| `started_at`              | attempt insert                                                                                   | newest attempt `started_at`                                                  |

`concern.totals` (attempts, verify rounds, tokens, cost) grows with every progress event and
`attemptMs` depends on the clock (`readTrajectoryFacts(db, planID, taskID, Date.now())`,
`read.ts:488`). Storing live totals would rewrite the row on every tool call. The list row
keeps the line and reasons; the totals shown in the inspector are stored once per concern
version, as of the detection, in the concern version write (`handoff/store.ts:1282`). That is
a visible change, listed under the owner questions.

### Filters

| Filter today                                             | Becomes                                                                        | Maintained by                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `state` (`state-filter.ts`)                              | `bucket` column and index                                                      | `task`, `plan`, `pause` refresh                |
| `includeRetired` (`storage.ts:948`)                      | `retired` column, in every index                                               | disposition insert                             |
| `sessionID`, creator (`storage.ts:950`, `json_extract`)  | `session_id` column and index                                                  | task insert                                    |
| `sessionID`, association (`task-reads.ts:120`)           | `EXISTS` on `task_schedule_sessions (session_id, task_id, role)`               | task insert; plan owner change; attempt insert |
| `search` (`storage.ts:956`, `instr` over the whole body) | `instr(search_text, ?)` on the stored lower-cased column, in the reader worker | `task` refresh (reference renames rewrite it)  |
| `scopePath` (`storage.ts:967`, `json_each`)              | `EXISTS` on `task_schedule_scopes` with `instr(lower(path), ?)`                | `task` refresh                                 |
| `created_version <= snapshot` (`storage.ts:939`)         | deleted: the stream anchors on keys and a revision                             | none                                           |

The search text is the six fields `summarize` already matches (`read.ts:60-67`): id, reference,
objective, scope, acceptance assertions, context references. Today `search` runs over the
whole JSON body, so it matches key names such as `proposal`. Narrowing it is an engineering
call with a visible effect, listed below. A reference rename rewrites `search_text`.

### The scheduling decision### The scheduling decision, and the one fact the writer cannot know

`TaskSchedulingRead` computes `decision` (`eligible`, `waiting`, `unknown`) by walking plans
in priority order with git ancestry proofs (`scheduling-read.ts:228,1043`), delegated-agent
capacity and reservation holds. The panel uses only `decision === "waiting"` and its reason
(`panel.tsx:684,699,896`, `row-presentation.ts:87,158`).

- Everything the database knows (dependencies, pause, reservations, prerequisite plan state,
  adoption hold) is in `status`, `reason`, edges, blockers and waits.
- The git ancestry result is the one fact no database write reveals. The dispatcher already
  evaluates it on every tick (`dispatch.ts:158` task prerequisites, `:217` plan prerequisites)
  as part of deciding to dispatch. It will record the result with `store.recordOnce(planID,
taskID, "PREREQUISITE_OBSERVED", { decision, reason, head })` (`store.ts:4071`, the existing
  changed-condition idiom, used at `dispatch.ts:627`). A trigger on that event queues the
  task, and the refresh folds the newest observation into `decision` and `decision_reason`.
  This is the watermark fold the data-handling design allows for facts the writer cannot know.
- `unknown` is deleted from the vocabulary. A task whose prerequisites are integrated but not
  yet observed shows `waiting` with the reason "Waiting for the scheduler to confirm the
  prerequisite integration". The next dispatcher tick replaces it.
- The `next` candidate, `delegatedAgents` capacity and snapshot coverage text have no list
  reader. They remain in `TaskSchedulingRead` for the Architect and are removed from the panel
  path.

## Backfill, generations, parity

### Schema module and generation

A new module in `src/database-schema.ts`:

```ts
"task-schedule": { generation: 1, source: "src/tasks/schedule/schema.ts",
  tables: ["task_schedule", "task_schedule_plans", "task_schedule_edges", "task_schedule_blockers",
           "task_schedule_waits", "task_schedule_sessions",           "task_schedule_search_data", "task_schedule_search_idx", "task_schedule_search_content",
           "task_schedule_search_docsize", "task_schedule_search_config",
           "task_schedule_dirty", "task_schedule_state"] }
```

It installs through `TaskRepository.installSchema` (`storage.ts:598`) in one transaction:
tables, indexes, triggers (all `DROP TRIGGER IF EXISTS` then `CREATE`, as
`decision-projection.ts:124` does), and a `task_schedule_state` row per project with
`ready = 0`. Triggers exist from the same commit that creates the tables, so no write can
slip between install and backfill.

Generation rules:

- Bump the generation for any change to a column, key, index, trigger or to the derivation of
  a stored value (for example the bucket rule). The install drops the projection tables,
  recreates them, sets `ready = 0` and the backfill runs again. That is the explicit
  migration; nothing rebuilds on a timer.
- A bump needs a full service restart. `installSchema` throws `Unsupported LAZERS schema
module ... generation` when the stored generation exceeds the module's (`storage.ts:612`), so
  a stale plugin copy that still holds the old code fails to attach. A reload of one location
  is not enough while other copies live.
- Until a restart, a stale copy's writes still fire the triggers and fill the dirty queue; the
  new generation's drain folds them. Nothing is lost during the mixed period.

### Paged, resumable backfill

`task_schedule_state(project_directory, ready, backfill_after, reservations_fp, generation)`.
The database-wide schedule owner (see below) owns the backfill, one project at a time (as `DecisionProjectionOwner` owns the decision fold):

```
loop:  BEGIN IMMEDIATE
         page = tasks WHERE created_version > backfill_after ORDER BY created_version LIMIT page
         for each task: refreshTask(db, task)        -- the same code the drain runs
         plans of those tasks: refreshPlan(db, plan)  -- idempotent
         backfill_after = last created_version; if page is short: ready = 1
       COMMIT                                          -- one page per transaction
```

- The page is a unit of work (a batch of tasks, measured for transaction length), not a cap:
  the loop continues until done, yielding the event loop between pages.
- Resumable: `backfill_after` is in the same transaction as the rows, so a restart resumes at
  the next page.
- Concurrent writes are safe: each refresh reads current source rows inside its own write
  transaction, so a backfilled row can never be older than the source, and the drain handles
  anything written meanwhile.
- `ready = 0` keeps the panel on the current read path until the backfill finishes and the
  parity audit passes. That coexistence ends in the last task, which deletes the old path; it
  is a rollout step, not a second read path in the end state.

### Parity strategy

The projection-backed read must equal the current read before the old path is deleted.

1. **Order oracle.** `src/tasks/read-order.test.ts` already seeds nodes, priorities, finish
   times and plan transitions and asserts the schedule order. Its seeds run through both
   `Tasks.query` (`sort: "schedule"`) and `tasks.schedule`; the ids must be identical for every
   state filter in `TaskStateFilter`.
2. **Bucket table test.** Every node state x plan state x pause level combination: the stored
   `bucket` equals which `taskStatePredicate` filters select the row, evaluated against a real
   SQLite database.
3. **Differential test.** A seeded random event generator drives the real writers (submit
   tasks, create plans, `move`, cancel, revise priority, start and finish attempts, amend scope,
   pause, rename project code). After every event, `Tasks.query` (all filters, both sorts, page
   by page) equals a stream window read of `tasks.schedule`; `scheduling.plans` priority and
   order equal `tasks.plans`; topology edges equal `tasks.dependencies`.
4. **Rebuild equivalence.** After the same events, a full backfill into a scratch table is
   row-equal to the incrementally maintained table. This is the test that catches a write path
   whose trigger is missing.
5. **Trigger coverage test.** For each source table in the table above, `sqlite_master` has the
   trigger; a static test greps `src/` for `INSERT|UPDATE|DELETE` statements against those
   tables and fails on a table the module does not list.
6. **Golden corpus.** `test/fixtures/task-schedule/corpus.json` is a recorded event script
   (the shapes found in `read-order.test.ts`, `scheduling-read.test.ts` and the live state
   mix: cancelled plans, accepted-but-not-integrated, takeover, dispatch-paused, prerequisite
   plans) with the expected ordered ids per filter, committed. The corpus is generated by
   running the old read at the commit that introduces the projection.
7. **Audit script.** `scripts/task-schedule-audit.ts <db path>` opens a database read-only
   and reports the first divergence between the old read and the projection for every filter
   and both sorts. The driver runs it against a copy the owner places under a temp path; the
   implementer never opens the live `tasks.sqlite`.

## Sizes

Live database, read-only (`tasks.sqlite`, 2026-11-20):

| Table                                    | Rows                            | Projection rows                                                                      |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `tasks` (1.40 MB of bodies, 5.4 KB mean) | 260                             | `task_schedule` 260                                                                  |
| `runner_plans`                           | 221                             | `task_schedule_plans` 221                                                            |
| `runner_nodes`                           | 251 (max 5 per plan, mean 1.14) | n/a                                                                                  |
| `runner_dependencies`                    | 23                              | `task_schedule_edges` about 70 (same-plan 23, plus after-plan expansion of 49 plans) |
| `runner_attempts`                        | 249                             | `task_schedule_blockers` under 20 (active attempts x queued tasks)                   |
| `runner_adoptions`                       | 5                               | n/a                                                                                  |
| `task_dispositions`                      | 51                              | `retired` flag                                                                       |
| `runner_dispatch_controls`               | 28                              | `pause` json                                                                         |
| `runner_transitions`                     | 438,621                         | none copied                                                                          |
| `task_schedule_sessions`                 |                                 | about 600                                                                            |

Expected size: a list row is about 0.7 KB (title at most 72 characters, objective 400,
reason 400, json fields), so `task_schedule` is about 0.2 MB plus four indexes of about 0.1 MB
each, and `search_text` about 2 KB per task (0.5 MB). At 100,000 tasks: about 70 MB of rows and
indexes and about 200 MB of search text. Search text is the knob if it matters (see the FTS
threshold above).

Cost to read: the first page is a single index range seek of 30 to 100 rows instead of 50 ms of
window functions. Cost to write: a plan-scoped refresh is about 10 indexed point reads and
N(plan) upserts, estimated at 0.3 ms per node.

## What was deleted, and what moved (status after the migration)

- The old read is gone (`Tasks.query`, `TaskReads.query`/`queryAll`, `readPage`, `stateCounts`, the
  snapshot cursor, `scheduledTaskPageSQL`, `taskStatePredicate`). `TaskReads.get` still uses
  `effectiveExecution` for the one-task detail. The old order and chip SQL survive only as the
  audit oracle in `src/tasks/schedule/live-audit.ts`.
- **Recorded parity.** What the old read showed on the test corpora (random differential seeds,
  the golden mix, the real-runtime steps, the agent tool's pages) is committed as
  `recorded-projection.json` and `stream-query.recorded.json`; tests compare the stored list
  with it, so parity outlives the oracle.
- **The owner is per database.** One `TaskScheduleOwner` per database per process
  (`acquireScheduleOwner`, shared by every project core; the last release stops it)
  backfills every project found in `tasks`, each with its own `ready`, and drains the queue.
- **Needs you is a stored fact.** `task_schedule.owner_hold` is 1 when the task's own node or plan
  is recorded Blocked and the task is not finished. A task held back by a reservation, a
  prerequisite plan or an adoption shows Blocked (the Blocked chip follows the displayed status)
  but needs no owner, so Needs you and the Radar workload read `owner_hold`, not the bucket.
- **Search** matches the stored `search_text` of six fields (id, reference, objective, scope,
  acceptance, context), not the whole task body the old read searched.

Originally planned for deletion after the callers move:

- `src/tasks/schedule-order.ts` and `scheduledTaskPageSQL`; the `readPage` clause builder, the
  `stateCounts` helper and the `created_version` snapshot machinery (`storage.ts:912-1060`);
  `taskStatePredicate` (`state-filter.ts:35-83`) once the bucket test has run for a release.
- `TaskReads.query`, `queryAll`, the base64 `Cursor` and `effectiveExecution`
  (`read.ts:98-260,392-459`); `summarize` search snippets move to the agent tool, which
  composes snippets from the one task it returns.
- `unitCursor` chains for all-projects reads (`projects/scope.ts` `encodeUnitCursor`,
  `pickUnit`): the consumer opens one `tasks.schedule` stream per readable unit in the unit
  order.
- The `scheduling` and `topology` RPC reads for the panel (`TasksScheduling`,
  `rpc.ts:345-395`, `runtime.readScheduling` `runtime.ts:802`, `Observability.topology`
  `rpc.ts:151`, `read.ts:2504`) and `scheduling-read.ts` coverage and snapshot caches that only
  serve the panel.
- `src/tasks/execution-list.ts` (605 lines), `virtual-rows.ts` flatten logic, and in
  `panel-state.ts` (959 lines) the cursor chains, `followedCursors`, `readScheduling`,
  `readTopology`, `taskViewCache`, `inspectedCache`, `projectCache` (`panel-state.ts:147-151`),
  and `remember` (`:154`); `panel.tsx` uses stream items instead.

Every caller that must move first:

| Caller                                 | Where                                                                                                                                                | Moves to                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Tasks panel list, scheduling, topology | `panel.tsx:429-467` (`rpc().query`, `scheduling`, `topology`), `panel-state.ts:208,472,545-604`                                                      | `tasks.schedule`, `tasks.plans`, `tasks.dependencies` streams |
| Models panel task list                 | `models/models-controller.ts:338` (`tasks.query`)                                                                                                    | `tasks.schedule`, order `recent`, filter by session           |
| Agent tool `lz-list-tasks`             | `tools.ts:544` (`TaskReads.query`)                                                                                                                   | one window of `tasks.schedule`, edge key as marker            |
| Agent tool `lz-query-tasks`            | `tools.ts:569`                                                                                                                                       | same; snippets from the returned tasks                        |
| `Tasks.query` RPC and all-projects     | `tasks/rpc.ts:97,102`, `read.ts:143` (`queryAll`)                                                                                                    | stream RPC (`src/streams/rpc.ts`)                             |
| Association reads                      | `observability/task-reads.ts:78,178`, `core/core.ts:230`                                                                                             | `tasks.schedule` with `session` filter                        |
| `scheduledTaskPageSQL` users           | `storage.ts:987`, `observability/task-reads.ts:178`                                                                                                  | deleted with the callers above                                |
| Tests that call these                  | `read.test.ts`, `rpc.test.ts`, `read-order.test.ts`, `panel-state.test.ts`, `execution-list.test.ts`, `virtual-rows.test.ts`, `all-projects.test.ts` | rewritten against the sources                                 |

Not moved by this lane: `Tasks.get` (point read by id), `currentActivity` (host reads),
`start`, and `Tasks.changes`.

## Review amendments, calls and lead decisions

Amendments from the lead's review (2026-11-20), implemented as written above:

- **Search** is a stored `search_text` and a `task_schedule_scopes` child table; no FTS5.
- **Counts.** `tasks.schedule` uses probe counts; chip counts are stored per-bucket counters.
- **The drain costs one statement when nothing is queued.** `drainScheduleHook` runs
  `SELECT 1 FROM task_schedule_dirty LIMIT 1` through a prepared statement; the measurement is in
  the plan report. A test asserts a transaction touching no schedule table runs no other
  statement.
- **Several plans for one task.** `UNIQUE(task_id, spec_revision)` and the writer's constant
  `spec_revision = 1` (`store.ts:4000`) make a second plan for a task impossible through the
  writers. If one exists (legacy rows, a test), the projection and `tasks.schedule` show the
  newest plan by rowid, as `currentActivityTargets` (`read.ts`, `ORDER BY p.rowid DESC`) and the
  old `tasks.list` do; a re-planned task's current plan is its newest one. The old
  `runner.execution` took whichever row SQLite returned first, which is the oldest.
- **`session_id` and `revision` are columns** of `task_schedule`, so no source reads
  `json_extract` of a task body. `tasks.list` is deleted once `tasks.schedule` serves its `recent`
  order.

Lead decisions the owner can reverse:

1. No count badge while a search is active.
2. Search covers the six fields only.
3. Concern totals are frozen at the latest concern version (read once when the version moves,
   kept until it changes again).
4. The chip follows the displayed status: a task held by a reservation, a prerequisite plan or an
   adoption counts under Blocked, not Queued. The parity suite states this in one place,
   `INTENTIONAL_DIFFERENCES` in `src/tasks/schedule/parity.ts`.

Implementation notes that differ from the sections above:

- The plan header stores the plan's own pause only; a project or global pause shows on each
  queued row. `last_transition_at` is not stored: the finish-time fallback reads the plan's
  newest transition directly, and a trigger re-queues the plan on a transition only when a row
  of that plan took that fallback (`finished_basis = 'plan'`, partial index).
- `runner_nodes` triggers queue the plan, not the node: a plan has 1.14 nodes on average and one
  refresh rewrites only the rows that changed.
- Blockers are listed in reservation priority order (plan priority, plan rowid, start time), so a
  priority change queues `reservations`.
- Prerequisite observations are recorded per task (`taskDependencyIntegration`, `dispatch.ts`),
  not per plan. A task with no unmet prerequisite and no recorded observation shows `eligible`;
  unmet same-plan prerequisites, a hold, a pause or a recorded `waiting` proof show `waiting`
  with their reason. Nothing shows `unknown`.
- Measured: a refresh of one task is about 0.7 ms (20 statements); backfill runs at 442 tasks/s
  (about 2.3 ms per task), so a page is 25 tasks, about 60 ms. Backfill pages by task, with the
  plan refreshed once per page.

Engineering calls (mine; reverse them cheaply if you disagree):

1. Composite `sort_key`, not renumbering or fractional ranks.
2. Triggers queue dirty entries and a drain runs in the writer's transaction.
3. Plan-scoped refresh as the unit.
4. No tree rows: a child table and one child stream per expanded row.
5. `unknown` leaves the scheduling vocabulary; the panel never rendered it.
6. Prerequisite proofs recorded by the dispatcher as `PREREQUISITE_OBSERVED`.
7. Immutable `seq` and `plan_seq` instead of `rowid`, so `VACUUM` cannot reorder.
8. Dropped coverage fields: `waitingOnPlansComplete`, `reservationTaskIDsComplete`,
   `reservationTaskIDsScopeLimited` and the 100-item caps, because child tables are complete.
