# Panel Streams Implementation Plan (v0.2.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Radar (live monitor, group, attempt, lifecycle), Trajectory, Models (catalog,
comparison, assignments) and Projects panels read only through data streams over stored
projections. No show read of these panels runs on the plugin main thread, and every whole
snapshot RPC, client cache and snapshot-diff machinery they use is deleted.

**Architecture:** Each panel's fields become columns of rowid projection tables, kept current
in the writer's transaction (or, for host facts, a watermark fold on the project core). Three
projections are shared: `task_events` (transitions, effects, checks, progress and host message
parts per task), `host_session_state` (live OpenCode session facts per tracked session) and the
existing `task_schedule*` family. Sources in `src/streams/sources/` read them in the reader
workers; GUIs open them with `createStream` (`src/streams/gui.ts:75`) over `rpcStreamsTransport`
(`src/streams/gui.ts:195`).

**Tech Stack:** TypeScript (strict), Bun 1.4.4, `bun:sqlite`, XState (`lifecycleMachines`),
the streams API in `src/streams/`, SolidJS.

**Spec:** [design/data-streams.md](../../design/data-streams.md) (read it first), with
[design/data-handling.md](../../design/data-handling.md). Follow the "Migration recipe" in
[data-streams plan](data-streams.md) (Task 9) for every source. Reference migrations:
`src/streams/sources/live-history.ts` over `runner_progress_display`
(`src/progress/display-store.ts:29-58`, `display-backfill.ts`) and the Tasks panel
([task-schedule plan](task-schedule.md), `src/streams/sources/tasks.ts`,
`src/tasks/panel-streams.ts`).

## Measured scale (live database, read-only, 2026-11-21)

| Table                       |    Rows | Note                                                               |
| --------------------------- | ------: | ------------------------------------------------------------------ |
| `runner_transitions`        | 418,671 | 409,170 have `task_id IS NULL` (plan-level); 9,501 are task-scoped |
| `runner_progress`           |  79,365 | `runner_progress_display` has the same 79,365 (backfill done)      |
| `native_tool_calls`         |  82,327 | wide rows (`payload`, `sources_json`, `event_ids_json`)            |
| `runner_effects`            |   2,626 | 1,348 are `verify:*` / `graph-verify:*` checks                     |
| `runner_attempts`           |     252 | 215 distinct tasks; largest attempt has 3,619 progress rows        |
| `tasks` / `task_schedule`   | 260/260 |                                                                    |
| `model_evidence_snapshots`  |     251 | `models-dev` bodies are 2,000 records, about 0.93 MB each          |
| `model_decision_progress`   |  22,442 | WITHOUT ROWID (never read by a source)                             |
| `lazers_projects` / `paths` |     3/3 | `lazers_profile_revisions` 1                                       |
| database file               | 1.49 GB |                                                                    |

The two biggest plan-level events (`OUTCOME_OWNER_TRANSFER_UNCERTAIN` 199,995 and
`ARCHITECT_RENEWAL_BLOCKED_STALE_CHECKPOINT` 119,685) carry `task_id NULL`; no panel row in this
plan reads them, so `task_events` backfill copies 9,501 transition rows, not 418,671.

## Global Constraints

- Workflow states and transitions only in XState `lifecycleMachines`
  (`src/runner/lifecycle-machines.ts:246`). Each projection's backfill readiness is a new
  `projection` lifecycle (`backfilling → ready`, `ready → backfilling` on a generation bump),
  moved by `lifecycleTransition`; no SQL-only state. Projections are derived: no decide read
  reads them; triggers only queue dirty entries.
- Decide reads stay on the main thread (see "What stays on the main thread").
- Sources read only rowid tables (`src/streams/sources/rowid.test.ts`): the update hook never
  fires for WITHOUT ROWID. Every table in this plan is declared with an `INTEGER PRIMARY KEY`
  (or plain rowid) and a UNIQUE natural key.
- Integer-key rule: any plan or attempt filter on `runner_transitions` or `runner_progress`
  uses `planIs`/`planIn`/`attemptIs`/`attemptIn` from `src/runner/identity-read.ts`
  (enforced by `src/runner/identity-predicates.test.ts`). A source's `filter()` gets no
  database handle, so **no source filters those two tables**. Backfills that must filter them
  use the helpers on the main connection; projection rows store `plan_id`/`attempt_id` text
  plus their own indexes. Task 0 extends the predicate test to `src/streams/sources/`.
- No cap refuses or truncates work. Windows slide; backfill page sizes are units of work with
  the measurement beside the constant. Existing caps that the old reads enforced (1000 plans,
  10,001 transitions, 512,000-byte live response, `LIVE_GROUP_TASKS = 25`) are deleted with
  the reads, not ported.
- "Unknown" is never a UI default. A missing price omits the price UI; an un-backfilled row is
  absent (as `runner_progress_display` does), and the panel shows the backfill progress from
  the `projection` lifecycle state, never a placeholder value.
- No native binaries or addons; no FTS5.
- Counts are `"more"` by default; `exact: "scan"` only on a small, asserted range;
  `exact: { before, after }` only over a stored counter.
- Website demo (`website/demo/src/panels/`) answers every new source with real frames, as
  `website/demo/src/panels/tasks-streams.ts` does. The radar demo's `Streams` stub
  (`website/demo/src/panels/radar-answers.ts:387-394`) is replaced.
- A schema generation bump needs a full service restart; the commit that bumps says so.
  Bumps are batched per wave (see "Schema generations").
- Tests: `bun test --timeout 120000 <files>`; `bun run verify` before each commit. Never open
  the live `tasks.sqlite` except read-only for counts and `EXPLAIN`.
- Atomic Conventional Commits, configured identity, no AI attribution, signing as configured.
- Work in worktrees under `.claude/worktrees/`; never build in the main checkout. Reloads,
  restarts and the Desktop walkthrough belong to the driver (Task 15).

## Review Focus

1. A missed writer: a statement that changes a displayed value without queuing a dirty entry
   (trigger-coverage tests per projection; `runner_effects` alone has three production writers:
   `src/runner/runtime-journal.ts:261`, `src/runner/commands-scope.ts:132`, the store).
2. Host facts (Task 3, Task 7): a native event lost between the hub and the fold, or a
   restart between cursor and rows. The fold must be idempotent and resume from its cursor.
3. Parity with read-time derivations that move into writers: `projectTaskEffortBasis`
   (`src/trajectory/accounting.ts:1079`), `buildCatalog`/`rankCatalog`
   (`src/models/catalog-projection.ts:255-511`), `effectiveExecution` fields already stored.
4. Hot-table trigger cost: `runner_transitions` plan-level inserts (409k of 418k) must cost
   zero dirty inserts (guard `WHEN NEW.task_id IS NOT NULL`).
5. Backfills concurrent with writes and restarts, one small transaction per page, yielding.
6. Every non-terminal state has an exit: dirty queues always drain; a throwing refresh leaves
   its entry, records the error, and a later drain recovers.

## File Structure

| File                                                                                 | Responsibility                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `src/projections/owner.ts`                                                           | Shared paged backfill + dirty-drain owner on the project core            |
| `src/projections/lifecycle.ts`                                                       | `projection` lifecycle wiring (machine lives in `lifecycle-machines.ts`) |
| `src/events/task-events-schema.ts`                                                   | `task_events`, dirty queue, triggers                                     |
| `src/events/task-events-refresh.ts`                                                  | Transition, effect, check, progress row derivation                       |
| `src/events/host-session-state.ts`                                                   | `host_session_state` table and the native-event fold                     |
| `src/events/host-transcript-fold.ts`                                                 | Attempt-session message fold into `task_events` by host cursor           |
| `src/progress/native-call-display.ts`                                                | `native_tool_call_display` written with `native_tool_calls`              |
| `src/trajectory/effort-store.ts`                                                     | `trajectory_task_effort` usage rows and repricing                        |
| `src/models/candidate-store.ts`                                                      | `model_candidates` written with evidence snapshots                       |
| `src/models/decision-store.ts`                                                       | `model_decision_view_*` tables written from worker results               |
| `src/models/assignment-view.ts`                                                      | `model_assignment_view` written with `model_mappings`                    |
| `src/projects/overview-store.ts`                                                     | `project_overview`, `project_presence`                                   |
| `src/streams/sources/{radar,trajectory,models,projects,task-detail}.ts` (+`-ref.ts`) | Sources                                                                  |
| `website/demo/src/panels/{radar,trajectory,models}-streams.ts`                       | Demo stream answers                                                      |

---

## Panel 1: Radar (observability)

### 1.1 What it reads today

Monitor, Map and Flow views render through `RadarLiveMonitorPanel` (`src/radar/panel.tsx:894`);
the lifecycle view is `RadarDiagnosticsPanel` (`src/radar/panel.tsx:216`), selected at
`src/radar/panel.tsx:1083-1105`. Handlers: `registerObservability` (`src/observability/rpc.ts:88`,
called `src/index.ts:396-398`), all synchronous `bun:sqlite` on the main thread.

| RPC                               | Handler → reader                                                                                 | Reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Shape                                                                                               | GUI consumer                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`                        | `rpc.ts:114-134` → `read.ts:2491-2608`                                                           | association closure (`read.ts:259-358`, `associations.ts:10-91`, unbounded `tasks`/`runner_plans` ids, throws over 1000 plans `read.ts:327`); every task body parsed (`read.ts:375-384`); nodes, dependencies; `runner_transitions` / `runner_attempts` / `runner_effects` `LIMIT 10001` (`read.ts:423-451`)                                                                                                                                                                                                              | whole snapshot (`contract.ts:155-181`)                                                              | lifecycle view via `src/radar/state.ts:158-161`, `src/radar/projection.ts:8-61`; Trajectory task choices (`src/trajectory-panel/projection.ts:66`)                  |
| `radar`                           | `rpc.ts:201-253` → `read.ts:2068-2214`, `loadRadarSource` `read.ts:575-693`                      | all of `snapshot` plus plan bodies `LIMIT 1001`, effects `LIMIT 20001`, outbox, 5001 progress payloads (`read.ts:644-665`), up to 500 serial host `get` (`read.ts:1021-1038`)                                                                                                                                                                                                                                                                                                                                             | whole projection (`contract.ts:408-485`)                                                            | used only as a freshness gate: `hasContent`, `observedAt`, `status` (`src/radar/panel.tsx:294,375,383,391`; `state.ts:33-42,177-188`)                               |
| `liveRadar`                       | `rpc.ts:254-278` → `live-read.ts:1510-1680`, `LiveReadStore.readCurrent` `live-store.ts:576-745` | active attempts `LIMIT 33` (`live-store.ts:441-453`); per attempt two `runner_progress` lanes `LIMIT 18` with payload (`:274-333`); `storedWorkload` (`src/tasks/schedule/stored.ts:69-77`); task labels via `json_extract` on bodies (`:409-438`); journal `recovery_progress_facts LIMIT 257` (`:640-653`); `native_tool_calls` per session (`:540-574`) and tool details `LIMIT 400` (`:498-533`); host `project`/`get` (`live-read.ts:873-998`); in-memory `sharedScheduler.projectStatus` (`live-read.ts:1410-1423`) | bounded snapshot re-read whole per change, at most one start per 400 ms (`monitor-state.ts:46,165`) | `RadarMonitorState` (`src/radar/monitor-state.ts:78-352`) → `monitor-view.tsx`, `monitor-model.ts:131,224,312,374`, `flow-model.ts:170-240`, `map-model.ts:226-230` |
| `liveAttempt`                     | `rpc.ts:304-330` → `live-store.ts:751-846`                                                       | attempt point read (`:776-785`); `openConcerns` without a `task_id` index (`src/recovery/detector.ts:314-335`); `readAttemptSummary` up to 1001 payload rows (`src/tasks/attempt-summary.ts:54-107`)                                                                                                                                                                                                                                                                                                                      | one object, `summary.ticks` ≤ 1000                                                                  | `monitor-view.tsx:731-748` → `src/radar/worker-pane.ts`                                                                                                             |
| `liveGroup`                       | `rpc.ts:279-303` → `live-store.ts:852-871`, `storedGroupHead` `stored.ts:80-116`                 | `task_schedule` `LIMIT 25` + workload counts; ignores scope                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 25-row head                                                                                         | `monitor-view.tsx:766-783`                                                                                                                                          |
| `topology`, `progressDiagnostics` | `rpc.ts:135-200`                                                                                 | topology half of snapshot; in-memory diagnostics                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | whole                                                                                               | no GUI consumer                                                                                                                                                     |
| event `changed`                   | `rpc.ts:405-428`, tracker `changes.ts:192-257,584-597`                                           | stamp re-read every 250 ms on any `task_changes`/`observation_revisions` write (`src/database-events.ts:34-40`), always on for every loaded location                                                                                                                                                                                                                                                                                                                                                                      | push                                                                                                | `src/radar/transport.ts:87-96`, `monitor-transport.ts:82-88`, Trajectory `events.ts:20-35`                                                                          |

Already streamed: `observability.liveHistory` (`src/streams/sources/live-history.ts:17-63`,
GUI `src/radar/history-list.tsx:45-62`, window 33 at `:29-34`).

Client machinery to delete: `ObservationSyncState` (`src/observability/state.ts:20-90`),
`kept` (`src/radar/kept.ts:6-28`), refresh/retry/coalescing in `src/radar/state.ts:113-338`
and `monitor-state.ts:61-321`, boundary pairing of `radar` and `snapshot`.

### 1.2 Stored projections

| Field group                                                                                | Projection                                                                                                                   | Status                                                                                                                         |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| group lists, workload counts, task labels, concern, takeover                               | `task_schedule` (+ `task_schedule_counts`, partial index `task_schedule_hold`)                                               | **qualifies** (rowid, `seq INTEGER PRIMARY KEY`, `src/tasks/schedule/schema.ts:18-75`)                                         |
| session scope membership                                                                   | `task_schedule_sessions(task_id, session_id, role)` (`schema.ts:112-118`)                                                    | **qualifies**; add index `(session_id, task_id)` (gen bump)                                                                    |
| attempt calls lanes, summary ticks                                                         | `runner_progress_display` (`display-store.ts:29-58`)                                                                         | **qualifies** for `tool`, `status`, `at`, route; ticks are display rows                                                        |
| active attempts                                                                            | `runner_attempts` (rowid, `session_id UNIQUE`, partial `runner_attempts_active_project`)                                     | **qualifies** (`src/runner/store.ts:1108-1114,1339-1342`); filter by `project_directory` and state, never by plan              |
| lifecycle plans and nodes                                                                  | `task_schedule_plans`, `task_schedule` by `plan_id` (index `task_schedule_plan`), `task_schedule_edges`                      | **qualifies**; ★ `task_schedule.ordinal` already exists (`schema.ts:36`), no bump for it                                       |
| lifecycle transitions                                                                      | `task_events` kind `transition`                                                                                              | **new** (Task 1)                                                                                                               |
| live session facts (busy, pending input/permissions/forms, outcome, archived, model route) | `host_session_state`                                                                                                         | **new** (Task 3)                                                                                                               |
| Architect calls (no progress rows)                                                         | `native_tool_call_display`                                                                                                   | **new** (Task 4); `native_tool_calls` is wide and has no recency index                                                         |
| journal                                                                                    | `recovery_progress_facts` (rowid, `change_id` PK, index `(project_directory, change_id)`, `src/recovery/journal.ts:303-321`) | **qualifies**                                                                                                                  |
| scheduler slots                                                                            | `scheduler_project_status` one row per project                                                                               | **new** (Task 4); written by the scheduler coordinator when its status changes (`src/runner/scheduler-coordinator.ts:118-127`) |

`host_session_state` (Task 3):

```sql
CREATE TABLE host_session_state (
  id INTEGER PRIMARY KEY,
  project_directory TEXT NOT NULL, session_id TEXT NOT NULL,
  role TEXT NOT NULL,              -- architect | worker | unmanaged
  attempt_id TEXT, task_id TEXT, parent_session_id TEXT,
  busy INTEGER NOT NULL, pending_input INTEGER NOT NULL, pending_permissions INTEGER NOT NULL,
  pending_forms INTEGER NOT NULL, outcome TEXT, archived INTEGER NOT NULL,
  route_provider TEXT, route_model TEXT, route_variant TEXT,
  tokens_in INTEGER, tokens_out INTEGER,
  updated_at INTEGER NOT NULL, host_updated_at INTEGER NOT NULL,
  UNIQUE(project_directory, session_id)
);
CREATE INDEX host_session_state_recent ON host_session_state(project_directory, archived, updated_at DESC, id);
```

Kept current by a watermark fold (host events cannot be written in a LAZERS writer
transaction): the native event hub (`src/core/event-hub.ts`, joined at
`src/observability/rpc.ts:458-473`) hands each coalesced batch of session events to the
project core's fold, which writes changed rows in one transaction (compare, then write). A
session's `host_updated_at` (`time.updated`) is the stamp: an event older than the stored stamp
is ignored, so redelivery is harmless. Backfill: on owner start, one `host.get` per session in
`task_schedule_sessions` plus the Architect session, paged 20 per transaction, resumable from
`projection_state.after` (largest session `id` done). Stays current across restarts because the
backfill re-stamps every tracked session once (live set ≤ the 252 attempt sessions plus
architects).

`native_tool_call_display` (Task 4, built in `src/progress/native-call-display.ts`; ★ own
module `native-call-display` generation 1, not a runner bump, so `src/runner/store.ts` only gains
an install call): `id INTEGER PRIMARY KEY` (★ the call's own `native_tool_calls` rowid, which an
identity promotion keeps, so no natural-key UNIQUE is needed), `project_directory, session_id,
identity_kind, invocation_id, call_id, detail_call_id, message_id, agent, tool, attempt_id,
status, detail, error, first_observed_at, last_observed_at`, index `(project_directory,
session_id, first_observed_at DESC, id)`. ★ Kept by triggers on `native_tool_calls` (INSERT,
UPDATE OF the displayed columns, DELETE) running the live read's own SQL expressions
(`json_extract` of status, 200-character detail, 240-character error): every writer (the
recorder's insert, merge and identity promotion, project-key backfill, retention) is covered
with no recorder change. Order key `first_observed_at` never changes, so windows do not re-anchor
on update; ★ the old read ordered by `last_observed_at`, so a long call that updates late no
longer jumps to the top. Backfill measured on the live-sized copy (82,525 calls): 166 pages of
500 by rowid, newest first, median 5.6 ms, slowest 38 ms, 1.3 s in all; 29 MB table + 12 MB index.

`scheduler_project_status` (Task 4, `src/runner/scheduler-status.ts`, ★ module
`scheduler-status` generation 1): `id INTEGER PRIMARY KEY, project_directory UNIQUE, status,
participants, updated_at`. ★ The coordinator gained `watch(key, listener)`, called on register,
drain start, drain end and dispose; the core mirrors the latest status with serialized,
coalesced `atomicAsync` writes (only a changed status writes). An observation of in-memory state,
not a workflow state: nothing decides from it.

### 1.3 Sources

| Source                   | Table                                                                                | Filter (authorize sets project)                                                                    | Order (ends with key)           | Window from UI                                               | Counts                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `radar.sessions`         | `host_session_state`                                                                 | project; scope session → `session_id = ? OR parent_session_id = ?`                                 | `recent`: `updated_at desc, id` | 32 sessions drawn (old `LIVE_LIMITS` sessions) + 8 slop = 40 | more                                                                                        |
| `radar.assignments`      | `runner_attempts` aliased join `task_schedule` (title, reference, concern, takeover) | project, `state IN ('preparing','running','verifying')`, scope session → `session_id = ?`          | `started_at desc, id`           | 32 + 8 = 40                                                  | more                                                                                        |
| `radar.calls`            | `runner_progress_display` (reuse `liveHistory` with `toolsOnly`)                     | attempt, session                                                                                   | `recent`                        | lane of 9 in view + 9 slop = 18 (old `LIMIT 18`)             | more                                                                                        |
| `radar.nativeCalls`      | `native_tool_call_display`                                                           | project, session                                                                                   | `first_observed_at desc, id`    | 18                                                           | more                                                                                        |
| `radar.group`            | `task_schedule`                                                                      | project, `retired=0`, group predicate (`owner_hold=1`, `bucket='failed'`, `bucket IN (queued...)`) | `seq desc`                      | 25 in view + 25 slop = 50                                    | stored: `task_schedule_counts` (bucket groups) / scan over `task_schedule_hold` (needs-you) |
| `radar.workload`         | `task_schedule_counts`                                                               | project                                                                                            | `bucket`                        | all buckets (9)                                              | exact: scan (small)                                                                         |
| `radar.journal`          | `recovery_progress_facts`                                                            | project                                                                                            | `change_id desc`                | 16 + 16 = 32                                                 | more                                                                                        |
| `radar.scheduler`        | `scheduler_project_status`                                                           | project                                                                                            | key                             | 1                                                            | exact: scan                                                                                 |
| `radar.attempt` (detail) | `runner_attempts` join `task_schedule`                                               | project, `session_id = ?`; session scope requires `sessionID === scope.sessionID`                  | key                             | 1                                                            | —                                                                                           |
| `radar.planEvents`       | ★ latest row per edge of one node, grouped over `task_events`                        | project, `plan_id = ?`, `task_id = ?`, kind transition with from/to                                | `id`                            | the node's edges (exact scan)                                | exact: scan                                                                                 |
| `radar.plans`            | reuse `tasks.plans` (`src/streams/sources/tasks.ts`)                                 |                                                                                                    |                                 |                                                              |                                                                                             |
| `radar.planNodes`        | `task_schedule`                                                                      | `plan_id = ?`                                                                                      | `ordinal, task_id`              | node count; slide                                            | more                                                                                        |

`authorize` carries over `authorize()` (`src/observability/rpc.ts:68-86`): `callerSession`
(`src/projects/read-access.ts:15-30`) via `context.assertRead(scope.sessionID)`, action
`read`, resource the service's project directory; project directory and
`context.projectIds(projectID)` overwritten (as `live-history.ts:29-38`); `liveAttempt`'s
session equality (`live-store.ts:752-753`). Foreign or archived sessions
(`live-read.ts:841-845`) are excluded by the fold, not by the read.

### 1.4 GUI changes

- `RadarMonitorState` is replaced by a `createRadarStreams(transport, scope)` module opening
  `radar.sessions`, `radar.assignments`, `radar.workload`, `radar.scheduler`, `radar.journal`;
  `monitor-model.ts`, `flow-model.ts`, `map-model.ts` take stream rows (routes and flow are
  derived from sessions + assignments + calls in the consumer, as today).
- Worker pane: `radar.attempt` + `radar.calls` replace `liveAttempt`; the 10 s effect at
  `monitor-view.tsx:731-748` is deleted (streams push changes).
- Group pane: `radar.group` replaces `liveGroup` (`monitor-view.tsx:766-783`).
- Lifecycle view: `radar.plans`, `radar.planNodes`, `radar.planEvents`; `RadarPanelState`
  (`src/radar/state.ts:57-357`), `createRadarTransport`, `kept`, `ObservationSyncState`
  usage deleted.
- Deleted server reads: `snapshot` (after Trajectory, Task 9), `radar`, `liveRadar`,
  `liveAttempt`, `liveGroup`, `topology`, `loadRadarSource`, `LiveRadarReader`,
  `LiveReadStore.readCurrent`/`readAttempt`/`readGroupTasks`/`nativeCalls`/`toolDetails`,
  `topologyGate`, `planInputs`, `sessionGates`, `associationIndex`, the `changed` event and the
  always-on tracker refresh (`rpc.ts:441-455`) once Trajectory no longer subscribes.

### 1.5 Tests first

- `radar.sessions parity: rows equal liveRadar sessions on the recorded fixture` — fixture
  `test/fixtures/panel-streams/radar.json` (event script: architect + 3 workers, one pending
  form, one archived, one foreign project); compare ids, order, busy, pending counts, route.
- `radar.assignments parity: equals readCurrent active assignments for project and session scope`.
- `radar.calls parity: equals the two LIMIT 18 lanes for every assignment` (tool lane and
  recent lane, payload-derived fields via `runner_progress_display`).
- `radar.group parity: needs-you, failed, queued heads equal storedGroupHead and totals equal workload`.
- `radar.attempt parity: equals liveAttempt for worker and architect sessions; ticks equal summary.ticks`.
- `radar.planEvents parity: transitions of a plan equal snapshot.transitions filtered to the plan`.
  ★ Open for Task 5: `task_events` holds task-scoped transitions only (`task_id` NOT NULL); the
  old snapshot's `transitions` include plan-level ones (`task_id` NULL, 409,170 live). Check what
  the lifecycle view renders of them before building `radar.planEvents` on `task_events`.
- `host_session_state fold: redelivered and out-of-order events leave the newest stamp`;
  `restart between cursor and rows resumes and ends equal to a fresh backfill`.
- `idle: with no write and no native event, an open monitor issues 0 statements on the main connection and 0 reader re-reads` (`meterRepository`, `src/runner/read-meter.fixture.ts`; assert the same meter counts the old `liveRadar` statements so the test is not vacuous).
- `rowid: every radar source table is a rowid table` (extend `rowid.test.ts`).
- `authorize: a session-scope open for another session throws; directory and project ids are overwritten`.

### 1.6 What stays on the main thread

`authorize` point reads (session lookup, permission assert); the host-event fold's writes;
the scheduler coordinator's own decide state (it only writes the status row).

---

## Panel 2: Trajectory

### 2.1 What it reads today

Transport `createTrajectoryTransport` (`src/trajectory-panel/projection.ts:57-87`), state
`src/trajectory-panel/panel-state.ts`, view `src/trajectory-panel/panel.tsx` (`PanelView` `:239`).

| RPC                          | Handler → reader                                                                                        | Reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Shape                                                                                                       | GUI consumer                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `snapshot`                   | as Radar                                                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | whole                                                                                                       | task choices when no target is pinned (`panel-state.ts:424-593`)                                         |
| `trajectoryStatus`           | `rpc.ts:383-399` → `read.ts:2723-2790` → `inspectTrajectoryStatus` (`src/trajectory/read.ts:1736-1747`) | `loadTaskObservationSource` + stamp (`read.ts:468-510`); per plan `runner_attempts`, `runner_effects` (only a `plan_id` index), `runner_transitions` — all unbounded `ORDER BY` (`trajectory/read.ts:756-797`); `progressReportWindow` newest 10,000 progress rows with payload parse per row (`read.ts:1429-1443`, `src/runner/store.ts:4876-4918`); `openConcerns`; host `session.get` per attempt (`native.ts:68-82`); valuation via `taskValuationProvider` (`src/models/server.ts:185-213`) | full report with all events every call; `TrajectoryLiveCache` diffs after building it (`read.ts:2762-2781`) | `refreshStatus` `panel-state.ts:634-760`                                                                 |
| `trajectoryHistory`          | `rpc.ts:349-382` → `read.ts:2666-2721`                                                                  | first page: everything above plus every host message of every attempt session (`eachMessagePage`, up to 10,001 per session, `src/core/host-messages.ts:259-283`), folded by `messageFold` (`read.ts:576-641`); later pages served from `TrajectoryHistoryCache` (`src/trajectory/history.ts:139-345`, 128 MB default budget shared with the live cache, `cache-pair.ts:14-20`)                                                                                                                   | whole capture, paged from memory; HMAC cursor                                                               | `captureHistory` `panel-state.ts:762-960`, `loadMoreActivity` `:1114-1226`, `drainActivity` `:1087-1108` |
| tool `lz-inspect-trajectory` | `src/trajectory/tools.ts:16-71`                                                                         | same `inspectTrajectory`, plus the host message fold on every page, no cache                                                                                                                                                                                                                                                                                                                                                                                                                     | paged by snapshot-hash cursor                                                                               | agent                                                                                                    |

Derived at read time (no stored projection): `projectTaskEffortBasis`
(`src/trajectory/accounting.ts:1079`), `projectProgressFact` per row
(`src/progress/projection.ts:517`), `attemptView`, `effortView`, `checkView`,
`transitionEvent`, `effectEvents` (`trajectory/read.ts:643-984,1335-1387`).
Client: `TrajectoryViewCache` (`panel-state.ts:123-180`), status cursor, capture ids,
`PageRecaptureError`, `settledHistory` (`projection.ts:659-700`).

### 2.2 Stored projections

`task_events` (Task 1 and Task 2, built; shared with Radar lifecycle and Tasks activity). As
built in `src/events/task-events-schema.ts`, corrected from this plan's first sketch where the code
disagreed (marked ★):

```sql
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY,
  project_directory TEXT NOT NULL, task_id TEXT NOT NULL, plan_id TEXT,
  attempt_id TEXT, session_id TEXT,
  at REAL,                           -- ★ event time; NULL when the source has none (below)
  kind TEXT NOT NULL,                -- transition | effect | check | progress (later: message | tool | step)
  origin TEXT NOT NULL UNIQUE,       -- ★ globally unique: 'tr:<id>' | 'ef:<id>' | 'ef:<id>@<task>' | 'pg:<seq>'
  event TEXT, from_state TEXT, to_state TEXT, status TEXT, tool TEXT, title TEXT,
  route_provider TEXT, route_model TEXT, route_variant TEXT,
  detail TEXT                        -- cold JSON, read only at window: 1
);
CREATE INDEX task_events_task ON task_events(project_directory, task_id, at, id);
CREATE INDEX task_events_plan ON task_events(project_directory, plan_id, kind, id);
CREATE INDEX task_events_attempt ON task_events(project_directory, attempt_id, at, id);
-- ★ the shared queue shape (src/projections/queue.ts): parked entries carry their error
CREATE TABLE task_events_dirty (ref TEXT PRIMARY KEY, next_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
```

- ★ Plan-level effects (`task_id IS NULL AND attempt_id IS NULL`, 868 live, mostly
  `graph-verify:*` checks and `worktree-remove`) show in every task of their plan in the old
  read, so they fan out: one row per node, origin `ef:<id>@<task>`. A row needs its plan to hold
  the task's node, as the old read does.
- ★ `at` is nullable: a non-check effect with no attempt (plan cleanup) has no time in the old
  read, which sorts it last; the row stores NULL rather than a made-up time. Columns: transition
  → `event`, `from_state`, `to_state`; effect → `event` = effect kind, `to_state` = effect state;
  check → `event` = check id, `status` = passed/failed/unknown, `to_state` = effect state;
  progress → `event` = display kind, `status`, `tool`, route. `detail` holds `{ event }` (the old
  read's event object exactly, plus `check`, the old `CheckView`, for checks) or, for progress,
  `{ source, messageID, callID, agent, result, error }`.
- For Task 13: ★ `sort_at` (`at`, or the largest safe integer when `at` is NULL) and `sort_key`
  (the old event id) carry the old read's order (NULL `at` last, ties by event id); a timeline
  orders `sort_at, sort_key, id` through `task_events_task (project_directory, task_id, sort_at,
sort_key, id)`, which replaces the `at`-ordered index. A parity test checks the order with tied
  times and an untimed plan cleanup.
- Writers: guarded triggers queue the source key on `runner_transitions` INSERT
  `WHEN NEW.task_id IS NOT NULL` (and UPDATE OF its displayed columns, never `plan_n`), on
  `runner_effects` INSERT/DELETE/UPDATE OF ★ `plan_id,task_id,attempt_id,kind,state,receipt`,
  and on `runner_progress_display` INSERT/UPDATE. ★ Dependency triggers on `runner_attempts`
  (a new attempt can resolve a transition's `attemptID`; started_at/session_id feed rows) and
  `runner_nodes` (fan-out) read `task_events`' own indexes, never a history table. Deletes of a
  transition or display row delete the event directly. The drain runs inside `atomic` /
  `atomicAsync` through ★ the shared projections hook (`src/projections/hook.ts`), and derives
  rows with ★ `transitionEvent` / `effectEvents` (which applies `checkView`), moved from
  `src/trajectory/read.ts` into `src/trajectory/events.ts` so both use one copy. A refresh writes
  only a row that differs (every column compared).
- Host message parts (`kind` message/tool/step, `origin` `host:`): `host-transcript-fold.ts`
  reads `message.list` after the per-session cursor in `host_message_cursors`
  (`src/core/host-messages.ts:36-42`; a writer table, never read by a source), pages of 50,
  applies `messageFold` and the privacy filter (`src/trajectory/privacy.ts`) at write time,
  and advances the cursor in the same transaction as the rows. Triggered by native
  `message.part.updated`/`step` events for attempt sessions (Task 3's hub path).
- Backfill (paged, resumable, versioned by `projection_state(name='task-events', generation,
phase, after)`), measured on a copy of the live source tables (2026-11-21: 418,709 transition
  ids, 9,510 task-scoped; 2,628 effects; 79,423 display rows), three runs:

  | Phase       | Page              | Pages | Median page | Slowest page | Phase total |
  | ----------- | ----------------- | ----: | ----------: | -----------: | ----------: |
  | transitions | 2,000 ids (range) |   225 |      0.7 ms |        29 ms |      533 ms |
  | effects     | 50 effects        |    53 |      7.3 ms |        31 ms |      503 ms |
  | progress    | 250 display rows  |   318 |      2.8 ms |        36 ms |    1,562 ms |

  About 2.6 s of writer time in total, spread by the owner's pacing (40 ms slices with 25 ms
  waits when quiet, 6 ms slices with 500 ms waits while an attempt runs). Effects pages started
  at 500 and measured 107 ms (check receipts are sanitized at write), then 100 (up to 58 ms).
  Stored size on the copy: table 56 MB, three indexes 31 MB, of which progress `detail` was
  19.6 MB; ★ that detail duplicated the display row and is no longer copied (progress rows keep
  `detail` NULL; `pg:<seq>` names the display row): table 35 MB, indexes 33 MB.
  Writer cost: 1,000 plan-level transition inserts 1.3 to 2.5 ms with zero queued; 1,000
  task-scoped inserts plus their drain 15 ms; the hook's probe with nothing due 2.3 µs.
  Host transcripts (Task 7): 252 attempt sessions, one session per page, then its message pages.

`trajectory_task_effort` (Task 7):

```sql
CREATE TABLE trajectory_task_effort (
  id INTEGER PRIMARY KEY,
  project_directory TEXT NOT NULL, task_id TEXT NOT NULL, session_id TEXT NOT NULL,
  provider TEXT, model TEXT, effort TEXT,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL, reasoning INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL, provider_retries INTEGER NOT NULL, recorded_cost TEXT,
  price_source TEXT, price_identity TEXT, market_cost TEXT,   -- NULL when no source prices it
  UNIQUE(project_directory, task_id, session_id, provider, model, effort)
);
```

Rows are the per-session pieces `projectTaskEffortBasis` composes (`accounting.ts:953,1079`).
A dirty entry per `(task, session)` is queued by the `runner_progress` trigger family; the owner
refreshes the session's pieces from its facts (digest memo `accounting.ts:907`). Repricing: when
the price identity (`src/models/price-state.ts:151-186`) changes, the owner rewrites
`market_cost` for rows whose `price_identity` differs, paged; usage is untouched. Totals are
composed in the consumer from rows in the same sorted order (bit-identical sums, see
`design/data-handling.md` "Composition"). Backfill: 215 tasks with attempts; parsing 79,365
payloads in pages of 100 progress rows (about 800 transactions on the owner timer).

Attempts and plans need no new table: `runner_attempts` (`task_id` via `UNIQUE(task_id,
number)`) and `task_schedule_plans`/`task_schedule` qualify.

### 2.3 Sources

| Source                     | Table                                        | Filter                                                     | Order                                                   | Window                                                                                                 | Counts                                                                                        |
| -------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `trajectory.events`        | `task_events`                                | project, `task_id`; optional `attempt_id`, `kind IN (...)` | `at asc, id` (timeline) and `at desc, id` (follow head) | view rows of the timeline (about 60 at default zoom) + 30 + 30 = 120; detail `window: 1` adds `detail` | exact: scan over `task_events_task` (per task ≤ a few thousand; asserted in a test at 20,000) |
| `trajectory.attempts`      | `runner_attempts`                            | project, `task_id`                                         | `number, id`                                            | all attempts of the task (count from exact scan); slide                                                | exact: scan                                                                                   |
| `trajectory.effort`        | `trajectory_task_effort`                     | project, `task_id`                                         | `session_id, provider, model, effort, id`               | pieces of one task                                                                                     | exact: scan                                                                                   |
| `trajectory.task` (detail) | `task_schedule` + `tasks.body` cold          | project, `task_id`                                         | key                                                     | 1                                                                                                      | —                                                                                             |
| task choices               | reuse `tasks.schedule` with `session` filter |                                                            |                                                         |                                                                                                        |                                                                                               |

`authorize` carries over: `callerSession` + permission action `lz-inspect-trajectory`
resource `["*"]` (`src/observability/rpc.ts:339-395`); `ownedByProject` (`trajectory/read.ts:986-991`)
becomes the project filter; scope membership (`read.ts:468-510`) becomes "session scope →
`task_id IN (SELECT task_id FROM task_schedule_sessions WHERE session_id = ?)`" checked by a
point read in `authorize`. The tool reads one `trajectory.events` window and returns the edge
key as its continue marker.

### 2.4 GUI changes

`TrajectoryPanelState.refresh/refreshStatus/captureHistory/loadMoreActivity/drainActivity/
recaptureActivity` replaced by streams; the timeline slides with the viewport
(`src/trajectory-panel/viewport.ts`). Deleted: `TrajectoryViewCache`, `statusCursor`,
`capturedEventIDs`, `PageRecaptureError`, `settledHistory` fingerprinting, `trajectoryChanges`
(`events.ts:20-35`); server `trajectory`, `trajectoryStatus`, `trajectoryHistory`,
`TrajectoryHistoryCache`, `TrajectoryLiveCache`, `trajectoryCachePair`, `historyCacheMB`
setting use for these caches (`src/core/core.ts:216-222`), `inspectTrajectory`'s read path
(kept only as the parity oracle until Task 14). Models' `trajectoryStatus` callers
(`src/models/models-controller.ts:365`, `comparison-state.ts:1199`) move to `trajectory.effort`.

### 2.5 Tests first

- `trajectory.events parity: walking the stream equals trajectoryHistory events (ids, order, kind, status, tool, route) on the recorded fixture` — fixture `test/fixtures/panel-streams/trajectory.json`: 3 attempts, takeover, check pass/fail, effect superseded, 1,200 progress rows, a fake host with 300 messages per session.
- `trajectory_task_effort parity: composed totals equal projectTaskEffortBasis bit for bit; market cost equals marketEquivalentCostOf`.
- `reprice: a price identity change rewrites market_cost only; usage columns unchanged; no source prices it → NULL and the pane omits the price`.
- `host transcript fold: a restart after N pages resumes at the stored cursor; redelivery adds no row`.
- `task_events triggers: one row per task-scoped transition; 10,000 plan-level transitions queue zero dirty entries`.
- `idle: an open timeline with no write reads no history (0 main statements; reader issues no query on an unrelated table write)`.
- `tool: lz-inspect-trajectory returns one window and a continue marker; the next call continues at the edge`.

### 2.6 What stays on the main thread

`authorize` point reads; the host transcript fold's async host reads and its writes (one small
transaction per page); repricing writes.

---

## Panel 3: Models catalog and comparison

### 3.1 What it reads today

Controller `createModelsController` (`src/models/models-controller.ts:126-1616`), state
`ModelComparisonPanelState` (`src/models/comparison-state.ts:397-1735`), contracts
`src/models/contract.ts:159-183`, `decision-contract.ts:760-786`.

| RPC                                                   | Handler → reader                                                           | Reads                                                                                                                                                                                                                   | Shape                                                                                                              | GUI consumer                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `comparison`                                          | `server.ts:534-560` → `readModelComparison` (`comparison-read.ts:491-609`) | stamp pass, then whole bodies of up to 5 evidence snapshots (`source-store.ts:786-926`, parse LRU 48 MiB `:69-72`), candidates built whole (`candidatesFor` `comparison-read.ts:318-445`), module caches `:129,486,488` | pages of 100 sliced from a whole list (about 1,373 candidates, `design/models-panel/native-review-20261103.md:16`) | `refreshComparison` (read twice on open, `comparison-state.ts:470,620`) + background paging `models-controller.ts:889-909` |
| `catalog`                                             | `server.ts:492-508` → `runner/catalog.ts:6-51`                             | host `model.list`, `agent.get`                                                                                                                                                                                          | unbounded list                                                                                                     | model picker (`models-controller.ts:1152`)                                                                                 |
| `settings`                                            | `server.ts:372-404` → `service.ts:30-52`                                   | 28–42 point reads in a write transaction (`service.ts:34`) + 4 host `agent.get`                                                                                                                                         | small                                                                                                              | `AssignmentsView` (`assignments-view.tsx:33-486`)                                                                          |
| `priceSources`                                        | `server.ts:437-470`                                                        | host storage + all 5 snapshot bodies to compute `nativeCatalogAccess` (`price-state.ts:54-79`)                                                                                                                          | small                                                                                                              | `models-controller.ts:696-708`                                                                                             |
| `refreshSources`                                      | `server.ts:617-658`                                                        | `due()` parses all latest bodies and uncached endpoint bodies (`source-refresh.ts:627-640`)                                                                                                                             | statuses                                                                                                           | `comparison-state.ts:621,651`                                                                                              |
| `ModelsDecision.overview/rows/configurations/inspect` | `server.ts:662-800` → decision worker (`decision-read.ts:1922-1996`)       | snapshot built in the worker from `model_decision_*` (WITHOUT ROWID) + ledger tables; held in worker memory, 4 per project (`decision-read.ts:59`)                                                                      | overview carries unpaged `graph.points` and `referenceEstimates`                                                   | chart, pane, `buildCatalog`                                                                                                |

The "All models" table (`all-models-table.tsx:31-97`) and charts render `buildCatalog`
(`catalog-projection.ts:255-476`) + `rankCatalog` (`:499-511`), computed in a GUI `createMemo`
(`models-controller.ts:822-844`) over every loaded candidate, the public catalog and the
decision overview. Client snapshot cache: 12 entries / 32 MiB (`models-controller.ts:76-111`).
No push events (`contract.ts:161`, `decision-contract.ts:762`).

### 3.2 Stored projections

`model_candidates` (Task 8), one row per (project, provider, model, variant):

```sql
CREATE TABLE model_candidates (
  id INTEGER PRIMARY KEY,
  project_directory TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  name TEXT, enabled INTEGER NOT NULL, context_tokens INTEGER,
  price_input TEXT, price_output TEXT, price_source TEXT,           -- NULL: omit price UI
  public_score REAL, benchmark_score REAL, correspondence TEXT,
  snapshot_set TEXT NOT NULL,                                       -- snapshot ids it was built from
  detail TEXT NOT NULL,                                             -- cold: whole candidate JSON
  UNIQUE(project_directory, provider_id, model_id, variant)
);
```

Written in the `saveSnapshot` transaction (`source-store.ts:431-519`): after a snapshot commits,
`candidatesFor` runs over the new latest set and upserts changed rows, deletes vanished ones
(compare, then write). The native `model.list` catalog already arrives as the `native-catalog`
evidence source (`source-refresh.ts:761-767`), so the picker reads `enabled` candidates and the
`catalog` RPC goes. `nativeCatalogAccess` becomes a column on `model_evidence_refreshes`.
Backfill: one build per project from current latest snapshots (5 body parses, about 1,400 rows);
versioned by `projection_state`.

Decision views (Task 9), stored per filter key so a stream can read them:

```sql
CREATE TABLE model_decision_views (id INTEGER PRIMARY KEY, project_directory TEXT NOT NULL,
  filter_key TEXT NOT NULL, revision INTEGER NOT NULL, price_identity TEXT NOT NULL,
  produced_at INTEGER NOT NULL, last_read_at INTEGER NOT NULL, state TEXT NOT NULL,
  UNIQUE(project_directory, filter_key));
CREATE TABLE model_catalog_entries (id INTEGER PRIMARY KEY, view_id INTEGER NOT NULL,
  rank INTEGER NOT NULL, entry_key TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL,
  cost_per_task TEXT, tokens INTEGER, accepted INTEGER, score REAL, frontier INTEGER NOT NULL,
  observed INTEGER NOT NULL, detail TEXT NOT NULL, UNIQUE(view_id, entry_key));
CREATE INDEX model_catalog_entries_rank ON model_catalog_entries(view_id, rank, id);
CREATE TABLE model_decision_points (id INTEGER PRIMARY KEY, view_id INTEGER NOT NULL,
  configuration_id TEXT NOT NULL, x REAL, y REAL, frontier INTEGER NOT NULL, estimate TEXT,
  UNIQUE(view_id, configuration_id));
CREATE TABLE model_decision_contributors (id INTEGER PRIMARY KEY, view_id INTEGER NOT NULL,
  configuration_id TEXT NOT NULL, ord INTEGER NOT NULL, task_id TEXT NOT NULL, detail TEXT NOT NULL,
  UNIQUE(view_id, configuration_id, task_id));
CREATE INDEX model_decision_contributors_order ON model_decision_contributors(view_id, configuration_id, ord, id);
```

- The decision worker keeps computing (`createSnapshot`, `decision-read.ts:1797-1838`) and also
  runs `buildCatalog`/`rankCatalog` over `model_candidates` rows it reads read-only; it posts the
  rows to the main thread, which writes the view in one transaction (compare, then write) and
  stamps `revision` and `price_identity`. Writes stay on the main thread
  (`design/data-streams.md` "Threads").
- A view is materialized when a stream opens it (`authorize` asks the registry, a point action),
  refreshed by the existing warm pass (`decision-worker.ts:104-137`) when the observation
  revision or price identity moves, and dropped by the existing idle sweep
  (`decision-projection.ts:611-659`). View `state` (`building`/`ready`) is a `projection`
  lifecycle value; the GUI shows "building" from it, never empty "unknown".
- Assignments: `model_assignment_view(id INTEGER PRIMARY KEY, project_directory, task_id,
subject, layer_task, layer_project, layer_shared, resolved, revision, UNIQUE(...))`, written
  in the `ModelMappingStore.write` transaction (`mapping-store.ts:124-163`); agent routes from
  host `agent.get` are stored at configure time and refreshed on `agent.reload`.

### 3.3 Sources

| Source                 | Table                         | Filter                                                                | Order                            | Window                                                     | Counts                         |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| `models.catalog`       | `model_catalog_entries`       | `view_id` (authorize resolves project + persona + task kind + period) | `rank, id`                       | table rows in view (about 24) + 12 + 12 = 48               | stored (view row count column) |
| `models.points`        | `model_decision_points`       | `view_id`                                                             | `configuration_id`               | chart: point count of the view (stored), slide when larger | stored                         |
| `models.contributors`  | `model_decision_contributors` | `view_id`, `configuration_id`                                         | `ord, id`                        | pane rows 20 + 10 + 10 = 40                                | more                           |
| `models.candidates`    | `model_candidates`            | project; `enabled`; provider                                          | `provider_id, model_id, variant` | picker 30 + 15 + 15 = 60; detail `window: 1`               | more                           |
| `models.assignments`   | `model_assignment_view`       | project, `task_id`                                                    | `subject`                        | 7 subjects                                                 | exact: scan                    |
| `models.view` (detail) | `model_decision_views`        | project, filter key                                                   | key                              | 1                                                          | —                              |

`authorize` carries over `eligibleSession` + `permission.assert` (`server.ts:101-154`) with the
action of the replaced RPC: `lz-read-model-comparison` (catalog, candidates),
`lz-read-model-decision` (points, contributors, view; plus `scope.projectDirectory ===
projectDirectory`, `server.ts:216-234`), `lz-get-model-settings` (assignments); project
directory overwritten.

### 3.4 GUI changes

`buildCatalog`/`rankCatalog` leave the GUI (run in the worker). `AllModelsTable`, `ModelChart`,
`ProjectedPlot`, `ObservedModelPane` read streams. Deleted: comparison paging
(`models-controller.ts:889-909`), `snapshots` cache (`:76-111`), `assignmentRows`,
decision `rows`/`configurations` RPCs (never paged by the GUI), `inspect` contributor paging,
`catalog` RPC, comparison module caches (`comparison-read.ts:129,486,488`).
`refreshSources`, `configure`, `priceSources`, `configurePriceSources` stay RPC (writes and host
settings, not history reads); `priceSources` no longer reads snapshot bodies.

### 3.5 Tests first

- `model_candidates parity: rows equal readModelComparison candidates (identity, order, every list field) for the recorded evidence fixture` (`src/models/fixtures/`).
- `catalog parity: models.catalog for each persona × task kind equals buildCatalog + rankCatalog of the old GUI inputs`.
- `points/contributors parity: equal overview.graph.points and inspect contributor pages`.
- `snapshot write: unchanged evidence rewrites zero candidate rows (count writes)`.
- `missing price: a candidate no source prices has NULL price columns and the table omits its price cell`.
- `view lifecycle: building → ready; idle sweep drops; a stream on a dropped view rebuilds it`.
- `idle: an open Models panel with no revision or price change reads no history (main meter 0; worker warm pass reads nothing, decision-read.ts:1907-1921)`.

### 3.6 What stays on the main thread

`authorize`; writes of views, candidates and assignments; price identity inputs
(`decision-worker-registry.ts:63-74`, host storage and integration state).

---

## Panel 4: Projects

### 4.1 What it reads today

The Projects section of Settings: `setupProjects` (`src/projects/gui.tsx:37`), rows `Row`
(`gui.tsx:178`), `VerificationGroup` (`src/projects/profile-gui.tsx:56`). Contract `lz.projects`
(`src/projects/contract.ts:178-242`, `events: {}`), handlers `src/projects/rpc.ts:344-397`.

| RPC                                                   | Reads                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Shape                                                                 | GUI consumer            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------- |
| `list` (`rpc.ts:380` → `listProjects` `:102-132`)     | in-memory core registry (`src/core/registry.ts:96-100`) + `realpathSync` per path (`scope.ts:21-37`); `lazers_dispatch_pause`; `lazers_projects` then one `lazers_project_paths` query per project with no `key` index (`registry.ts:42-61`); per project `runner_architect_contact`, `lazers_settings` (zod per field, `settings.ts:75-95`), active profile with full payload and proof tails parsed then discarded (`profile-store.ts:183-242,382-397`) | whole list, polled every 3 s (`gui.tsx:18,59-63`)                     | `gui.tsx:52,457-465`    |
| `profile` (`rpc.ts:381` → `profileViewOf` `:149-164`) | every revision + N+1 proofs (`profile-store.ts:356-365`), all projects + `repo_map_sources` per path                                                                                                                                                                                                                                                                                                                                                      | whole, one call per project at mount (twice: `profile-gui.tsx:83-87`) | `profile-gui.tsx:71-87` |

No session check on `list`/`profile` (`contract.ts:182,194-206`).

### 4.2 Stored projections

```sql
CREATE TABLE project_overview (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, code TEXT NOT NULL, name TEXT NOT NULL,
  created_at TEXT NOT NULL, checkouts TEXT NOT NULL,                 -- JSON array, insertion order
  pause_reason TEXT, pause_by TEXT, pause_at TEXT, architect_contact_reason TEXT,
  limit_slots INTEGER, weight REAL, spend_ceiling_tokens INTEGER, planning_auto_dispatch INTEGER,
  setup_dismissed_at TEXT, profile_state TEXT NOT NULL, profile_revision INTEGER
);
CREATE INDEX project_overview_order ON project_overview(created_at, key);
CREATE TABLE project_presence (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
  canonical TEXT NOT NULL, instance TEXT NOT NULL, loaded_at INTEGER NOT NULL);
CREATE TABLE project_global (id INTEGER PRIMARY KEY CHECK(id = 1), pause_reason TEXT,
  pause_by TEXT, pause_at TEXT, decision_model TEXT, decision_slicer TEXT, global_slots INTEGER,
  aging_ms INTEGER, history_cache_mb INTEGER);
CREATE INDEX lazers_project_paths_key ON lazers_project_paths(key);   -- fixes the N+1 scan
```

- Kept current in the writer transaction: `setCode`, `setPause`, `setSetting`, `saveProfile`,
  path registration, the architect contact writer call `refreshProjectOverview(db, key)`;
  guarded triggers on the source tables queue a dirty key for coverage (drained in `atomic`).
- Settings are stored resolved: plugin-option defaults (`src/index.ts:357-372`) are known at
  service start, which refreshes all rows once (3 rows live).
- `project_presence`: the core registry writes on acquire/release (`src/core/registry.ts`),
  canonical path resolved once at write. At service start, rows of other `instance` values are
  deleted (one service process per database; see Questions).
- Profile: `lazers_profile_revisions` (rowid, index `(project_key, state, revision)`) and
  `lazers_profile_proofs` (rowid) **qualify**.
- Backfill: 3 rows, one transaction; versioned.

### 4.3 Sources

| Source               | Table                                                              | Filter        | Order                 | Window                                                          | Counts      |
| -------------------- | ------------------------------------------------------------------ | ------------- | --------------------- | --------------------------------------------------------------- | ----------- |
| `projects.list`      | `project_overview` left join `project_presence` (loaded)           | none          | `created_at, key, id` | rows in view (about 8) + 4 + 4 = 16                             | exact: scan |
| `projects.global`    | `project_global`                                                   | none          | key                   | 1                                                               | —           |
| `projects.revisions` | `lazers_profile_revisions`                                         | `project_key` | `revision desc, id`   | 5 + 5 = 10; detail `window: 1` carries `profile`, `map_preview` | more        |
| `projects.proofs`    | `lazers_profile_proofs` (aliased subquery exposing `rowid AS ord`) | `revision_id` | `ord`                 | 10 + 5 = 15; detail carries tails                               | more        |

`authorize`: today none; the stream keeps that (see Questions) and overwrites nothing else.

### 4.4 GUI changes

`gui.tsx` drops the 3 s `setInterval`, `reconcile` and the post-write `refresh()`; rows come
from `projects.list`. `profile-gui.tsx` opens `projects.revisions`/`projects.proofs` only when a
project's verification group is expanded. Deleted: `listProjects`, `profileViewOf`, the
`list`/`profile` RPCs, `liveDirectories`/`isLoaded` on the read path (kept for `needsYou`'s
`projectUnits` until that tool moves; `needsYou` has no GUI caller, `rpc.ts:359-379`).

### 4.5 Tests first

- `projects.list parity: equals Projects.list for the recorded fixture (3 projects, one paused, one with contact paused, one with an active profile, one not loaded)`.
- `writers: each of setCode, setPause, setSetting, saveProfile, path registration, architect contact updates project_overview in the same transaction`.
- `presence: acquire writes, release deletes, a new instance clears the old instance's rows`.
- `idle: an open Settings page with no write issues 0 statements on the main connection over 30 s` (the old poll issued about 10 per 3 s).

### 4.6 What stays on the main thread

Writes; `saveProfile`'s proof run; `setupStatus`/`startSetup` (session decide reads).

---

## Remaining main-thread Tasks reads (folded into Task 12)

| Read                                        | Where                                                                                                                                                     | Show read today                                                                                               | Stored equivalent                                                                                                                                                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tasks.get` → `TaskReads.get`               | `src/tasks/rpc.ts:81-100`, `src/tasks/read.ts:107-194`; `AssociationTaskReads` uses `repository.atomic` for a read (`src/observability/task-reads.ts:18`) | selected task (`src/tasks/panel-state.ts:275`, `panel.tsx:420-421,2344`), Models (`models-controller.ts:363`) | `status`, `reason`, `dispatch_pause`, waits, blockers, `owner_session_id` in `task_schedule*`. Missing: `tasks.body` (cold field), `node_version`, same-plan `waitingOn` (blocker `kind` column), classification history, advice, audit history, attempts, activity |
| `effectiveExecution`                        | `src/tasks/read.ts:196-262` (reservations `src/runner/store.ts:3799-3813`)                                                                                | via `get`                                                                                                     | fully stored by `effectiveStatus` (`src/tasks/schedule/status.ts:41-103`)                                                                                                                                                                                           |
| `currentActivity`                           | `src/tasks/rpc.ts:101-290`, `read.ts:289-384`, 2N host `session` reads                                                                                    | visible rows ≤ 40 (`panel.tsx:1486-1493`, `panel-state.ts:48,184`)                                            | node/plan fields stored; host fields from `host_session_state` (Task 3) joined through `task_schedule_sessions` role `attempt`                                                                                                                                      |
| per-hit `repository.get` for search matches | `src/tasks/stream-query.ts:180-198`, `matchesOf` `:42-74`                                                                                                 | agent tool `lz-query-tasks` (`src/tools.ts:573`) only                                                         | needs per-field text: `task_schedule_search(task_id, field, text)` child table written with `search_text` (`src/tasks/schedule/refresh.ts:560-568`); snippets derived in the tool from window rows                                                                  |

---

## Tasks

Sizes: S ≤ 1 day, M 2–3 days, L 4–6 days, XL > 6 days of one implementer.

### Task 0: Shared projection owner, `projection` lifecycle, source rules (S)

**Files:** `src/runner/lifecycle-machines.ts` (add `projection: backfilling → ready`,
`ready → backfilling`), `src/projections/owner.ts`, `src/projections/lifecycle.ts`
(`projection_state`, module `projections` generation 1), `src/projections/queue.ts` (dirty queue
with parking), `src/projections/hook.ts` (per-connection drain hook, called from `atomic` and
`atomicAsync` in `src/storage.ts`), `src/runner/identity-predicates.test.ts` (scan
`src/streams/sources/`). `src/streams/sources/rowid.test.ts` already asserts every registered
source's `tables` are rowid; nothing to add there until a source reads a new table.

As built (replaces the sketch this section first had: one `backfillPage` could not cover a
projection with several source tables, and an owner per database, not per core, is what the
schedule owner already does):

```ts
// src/projections/owner.ts
export type BackfillPage = { next: number; done: boolean }
export type BackfillPhase = {
  name: string
  page(db: Database, scope: string, after: number): BackfillPage // one write transaction
}
export type ProjectionSpec = {
  name: string // projection_state.name
  generation: number // derivation generation; raising it rewrites every row
  backfill: readonly BackfillPhase[] // ready when the last phase is done
  queue?: { table: string; drain(db: Database): QueueDrain }
}
export function startProjection(
  path: string,
  projectDirectory: string,
  spec: ProjectionSpec,
  options?: { scope?: string; pacing?: BackfillPacing; onError?(e: unknown): void },
): { owner: ProjectionOwner; release(): void } // one owner per (database, name, scope)
// ProjectionOwner: settle(), drain(), status(), idle(), backfillPage(), close()

// src/projections/queue.ts — queue table (ref TEXT PRIMARY KEY, next_at, attempts, error)
export function queueTableSQL(table: string): string
export const queueRef: (table: string, refExpr: string) => string // trigger body statement
export function drainQueue(db, table, refresh: (db, ref) => void, { budget, now? }): QueueDrain
// src/projections/hook.ts
export function registerProjectionDrain(name: string, queue: string, drain: (db) => void): void
export function enrollProjectionConnection(db: Database, name: string): void
// src/projections/lifecycle.ts
export function ensureProjectionStateSchema(repository: TaskRepository): void
export function projectionStatus(db, name, scope?): ProjectionStatus | undefined
export function resetProjectionState(db, name): void // a schema reinstall rebuilt the tables
```

A throwing refresh stays queued with its error and an exponential `next_at` (1 s to 5 min); the
hook's probe reads only due entries, so later writes skip it, and the owner holds one timer at
the earliest `next_at`. Idle (ready, nothing due or parked) the owner holds one table-change
subscription and no timer. The existing schedule owner and progress display backfill keep their
own owners; moving them onto this one is not part of this plan.

- [ ] Test `projection lifecycle: every state has an exit; generation bump returns ready → backfilling` (extend `lifecycle-dead-ends.test.ts`).
- [ ] Test `owner: resumes at the stored watermark after a kill; idle when clean holds no timer`.
- [ ] Test `source rules: a source whose filter names runner_transitions or runner_progress fails`.
- [ ] Implement (generalize `src/progress/display-backfill.ts` and `src/tasks/schedule/owner.ts`); verify; commit `feat(projections): shared paged backfill owner and projection lifecycle`.

### Task 1: `task_events` transitions, effects, checks (M)

**Files:** `src/events/task-events-schema.ts`, `task-events-refresh.ts`, tests;
`src/database-schema.ts` (new module `task-events`, generation 1), `src/storage.ts` (drain hook).
Tests in 2.5 for triggers and parity of transition/effect/check rows; Review Focus 1 coverage
test greps `src/` for writes to `runner_transitions`/`runner_effects`.
Commit `feat(events): task events projection for transitions, effects and checks`.

### Task 2: `task_events` progress rows (S)

Mirror `runner_progress_display` rows into `task_events` (kind progress) in the same
transaction as `refreshProgressDisplay`; backfill 79,365 rows. Commit
`feat(events): task events carry progress display rows`.

### Task 3: `host_session_state` and the native-event fold (L)

**Files:** `src/events/host-session-state.ts`, test; `src/core/event-hub.ts` (hand batches to
the fold), `src/observability/changes.ts` (tracker no longer owns live signals once Task 6
lands). Tests in 1.5. Commit `feat(events): fold host session state into the database`.

★ As built (`src/host-sessions/{state,fold,native}.ts`, module `host-sessions` generation 1;
source `radar.sessions` in `src/streams/sources/host-sessions{,-ref}.ts`). Corrections:

- Own directory, not `src/events/` (another lane owns it). `event-hub.ts` is unchanged: the
  fold joins it with `joinNativeEvents` from the project core; `changes.ts` is Task 6's.
- An event is a hint, not a fact: the fold re-reads the session (`session.get`, one call) and
  the inbox/permission/form counts (`RunnerHost.session` without messages) only when the
  session is busy and unknown or the event can move them. A hint created before the last read
  began reads nothing. A read older than the stored `host_updated_at` is ignored.
- Columns added: `agent`, `title`, `directory`, `created_at`; `updated_at` is when a shown
  column last changed (the `recent` order), `host_updated_at` the host's stamp. ★ `title` is the
  session record's own label (lead's decision: a session attribute, not transcript text),
  redacted and cut to 200 characters as the live monitor showed it; never derived from messages. Archived sessions keep their row
  (`archived = 1`; Task 12 shows it); foreign sessions are never stored; deleted ones are.
- Backfill: the shared owner's pages cannot await a host read, so the `projection` lifecycle
  covers a seed (attempt and task sessions queued into `host_session_dirty`, the shared queue
  shape, 6 pages of 200, slowest 0.6 ms) and the fold drains the queue asynchronously.
  Every subscription attach (start and reattach) resyncs: `session.list` of the project's live
  sessions by cursor, idle ones written from the listed record, busy ones queued, stored live
  rows not listed queued. That, not a per-restart re-stamp, is what converges after lost events.
- One writer: one fold per (database, project) per process; one service process per database
  (owner decision), so the update hook sees every write.

### Task 4: Native call display and scheduler status (M)

Built (see 1.2). `native_tool_call_display` (module `native-call-display` 1) and
`scheduler_project_status` (module `scheduler-status` 1). Commit `feat(radar): store native call
display and scheduler status`.

### Task 5: Radar sources (M) — `src/streams/sources/radar.ts`, `radar-ref.ts`; tests 1.5.

Built: `radar.assignments`, `radar.attempt` (detail adds workspace, base commit, artifact),
`radar.nativeCalls`, `radar.group`, `radar.workload`, `radar.journal`, `radar.scheduler`,
`radar.planEvents`. ★ Reused instead of new sources: `radar.calls` is `observability.liveHistory`
(`toolsOnly` for the tool lane), `radar.plans` is `tasks.plans`, `radar.planNodes` is
`tasks.schedule` with `planID` and order `plan`. ★ `radar.sessions` waits for Task 3
(`host_session_state` does not exist yet); it lands with or after Task 3. ★ In a session view,
`radar.nativeCalls` reads the scope's own session only; reading a child session's calls needs
`host_session_state.parent_session_id` (Task 3). ★ The `all` scope reads this service's project,
as `observability.liveHistory` does; a cross-project view opens one stream per project (Task 6).

★ `radar.planEvents`, decided from the GUI: the lifecycle view never renders a plan-level
transition. `planTransitions` feeds only `observedTransition` (`src/radar/projection.ts:34-52`),
which keeps `kind === "machine"` rows of the selected node (`task_id` set, valid from/to) and
takes the latest per (from, event, to) edge; a transition is selectable only through such an edge
(`src/radar/panel.tsx:600-640`), and the details pane shows that row's from, to, time, kind,
reason and ids. So the source is the latest row per edge of one node, grouped at read time over
`task_events` (pushed down to `task_events_plan`; 0.08 ms on the largest live node, 379 rows) with
`detail` (reason, version) at `window: 1`. No new table, no copy of the 409,170 plan-level rows;
Task 6 deletes that part of the old read.

### Task 6: Radar GUI on streams and deletions (L) — 1.4; demo `radar-streams.ts`.

Built, except the sessions part (below):

- Worker pane: `radar.attempt` (window 1, detail) plus `observability.liveHistory` (tools whole
  for the lane, newest row for the last activity) in `src/radar/radar-streams.ts`; the 10 s
  re-read effect and the old 1,000-tick lane cap are gone (the lane window starts at 256 calls and
  doubles while rows remain). ★ The stored concern (`task_schedule.concern`) carries the line
  only; the rule's recommended action and reason were read from `openConcerns` and are not shown
  until `task_schedule` stores them (Task 12). ★ "older calls still indexing" (`historyIndexing`)
  is not shown: it read the display backfill watermark on the main thread.
- Map group pane: `radar.group` (window 50 = the old 25-row head plus 25 of slop) and
  `radar.workload` (window 1) for the total. `ready = false` renders "still being indexed",
  never an empty group or a zero.
- Lifecycle view: `tasks.plans` (whole, first window 64: 221 plans live), ★ new `radar.nodes`
  (`runner_nodes` with the persisted machine snapshot; whole, first window 16) and
  `radar.planEvents` (whole, first window 64: at most one row per machine edge), plus a
  window-1 detail stream anchored at the selected edge for its reason. ★ The machine definition
  is plain data (`src/runner/task-machine-config.ts`), shared by the runner and the GUI, so the
  GUI bundles no XState. Deleted: `RadarPanelState` (`src/radar/state.ts`),
  `createRadarTransport` (`src/radar/transport.ts`), `ObservationSyncState`
  (`src/observability/state.ts`), `planTransitions`, `transitionForSequence`.
- Server deletions: RPCs `radar`, `topology`, `liveAttempt`, `liveGroup` and their all-projects
  variants; `loadRadarSource` and the Radar edge, route and session builders (about 1,300 lines
  of `src/observability/read.ts`); `LiveReadStore.readAttempt`/`readGroupTasks`;
  `LIVE_GROUP_TASKS` (25); snapshot `transitions` and the plan-level transition read (the
  snapshot now reads only a task's `WORKER_STARTED`/`WORKER_STOPPED`, which Trajectory's attempt
  executions use). ★ Kept, with their owner: the snapshot read itself and its 1,000-plan and
  10,001-row limits are Trajectory's (task choices, attempts, checks) until Task 13/14.
- SEAM (Task 3): `radar.sessions` is declared in `radar-ref.ts` (name and the 1.2 columns) with
  no server source. The monitor's sessions, calls and flow still come from `liveRadar`
  (`RadarMonitorState`, `kept.ts`, `monitor-transport.ts`, the 512 KB response cap); they are
  deleted together when Task 3's table lands.
- Demo: `website/demo/src/panels/radar-streams.ts` answers `radar.attempt`,
  `observability.liveHistory`, `radar.group` and `radar.workload` with real frames over the mock
  world (a shared engine in `stream-answers.ts` serves Tasks and Radar); the `Streams` stub and
  the `liveAttempt`/`liveGroup` answers are gone.

### Task 7: Host transcript fold and `trajectory_task_effort` (XL)

`src/events/host-transcript-fold.ts`, `src/trajectory/effort-store.ts`; module
`trajectory-projection` generation 1; tests 2.5.

### Task 8: Model candidates projection and `models.candidates` (M)

Module `model-sources` generation 2 → 3; tests 3.5.

### Task 9: Decision views, catalog entries, points, contributors (XL)

Module `model-decision-projection` generation 3 → 4; worker posts rows; tests 3.5.

### Task 10: Models assignments view and GUI on streams (L)

Module `model-mappings` generation 1 → 2; 3.4; demo `models-streams.ts`.

### Task 11: Projects overview, presence, sources, GUI (M)

Module `project-overview` generation 1; `projects` generation 2 → 3 (paths index); 4.2–4.5.

★ As built (`src/projects/overview-store.ts`, `presence.ts`, `overview-view.ts`; sources
`projects.list`, `projects.global` in `src/streams/sources/projects{,-ref}.ts`). Corrections:

- Settings are one resolved JSON column (`settings`, the exact `ProjectSettings` /
  `GlobalSettings` object), not one column each; pauses and Architect contact carry a `paused` /
  `architect_contact` flag (a pause reason may be empty). `canonical_checkouts` (real paths,
  resolved once at refresh) is what `loaded` matches `project_presence.canonical` against.
- Writers are not edited: guarded triggers on `lazers_projects`, `lazers_project_paths`,
  `lazers_settings`, `lazers_dispatch_pause`, `runner_architect_contact` and
  `lazers_profile_revisions` queue the key, and the projections hook drains it in the writer's
  transaction (the shared owner retries parked entries). Trigger bodies queue with UPDATE then
  INSERT-if-missing, never `INSERT OR REPLACE`: under a writer's upsert (`ON CONFLICT DO
UPDATE`, which `setPause` and the settings writer use) SQLite applies the outer conflict
  handling to trigger statements, and a second `OR REPLACE` of the same ref failed the writer
  with a UNIQUE error (found by the writers test).
- The backfill is one owner page (queue every key and the global row, drain); new plugin-option
  defaults (`setProjectOverviewDefaults`, at each core start) queue every row again.
- Presence is written by the project core (create, dispose), refcounted per root (a reload
  builds the new core before disposing the old); the first write of a process clears other
  instances' rows.
- `projects.revisions` (order `newest`; `state` filter; `window: 1` adds `payload`,
  `map_preview`) and `projects.proofs` (order `recorded`, the proof rowid) feed the Verification
  group: the active revision, its proofs and the earlier ones are three streams, and the
  `profile` RPC is removed (`profileViewOf` stays for the Architect's profile tool). The earlier
  list does not read documents, so a superseded revision whose payload no longer parses is listed
  (the old read dropped it); no writer can store one (`activateRevision` validates). The `list`
  RPC is removed; `listProjects` stays as the parity oracle until Task 14.

### Task 12: Tasks detail, activity, current activity, search fields (L)

Sources `tasks.detail` (`task_schedule` + `tasks.body` cold), `tasks.attempts`
(`runner_attempts`), `tasks.activity` (`task_events` kind transition), `tasks.currentActivity`
(`task_schedule_sessions` ⋈ `host_session_state`), `tasks.history` (classification, advice,
audit rows); `task-schedule` generation 4 → 5 (`node_version`, blocker `kind` (★ `ordinal` exists),
`task_schedule_search`, index `task_schedule_sessions(session_id, task_id)`). Delete
`TaskReads.get`, `effectiveExecution`, `AssociationTaskReads`, `currentActivity` RPC, the
per-hit `repository.get`. Parity: every `TaskDetail` field the panel renders
(`panel.tsx:681-711,1106-1111,1198-1236,1597-1710,2143-2285`) equals the old `get` on the
task-schedule corpus. Commit `feat(tasks): selected task detail and activity read streams`.

### Task 13: Trajectory sources, GUI, tool (L) — 2.3–2.4; demo `trajectory-streams.ts`.

### Task 14: Delete the old reads; show-read source check (M)

Delete `snapshot`, `topology`, `changed`, the tracker refresh, `inspectTrajectory`'s read path
(after parity), comparison and profile reads; add the check from data-streams Task 9: an RPC
handler or tool `execute` that calls `repository.read` fails `bun run verify`, remaining sites
in an allowlist with an owner per entry. Docs: `design/data-streams.md` sources table,
`README.md` panel notes.

### Task 15: Rollout and walkthrough (driver)

Build server and GUI; restart at a quiet point per wave (`scripts/reload-safe.ts`); confirm
each `projection` row is `ready` and dirty queues empty; walk Radar (monitor, map, flow,
lifecycle, worker pane, groups), Trajectory (pinned from Tasks and Radar, scroll, live
attempt), Models (catalog, chart, pane, assignments), Projects (pause, code, settings,
profile); record divergences with reproductions.

## Dependency order and parallel lanes

```
T0 ──► T1 ──► T2 ──────────────► T7 ──► T13 ─┐
  │      └──► T4 ──┐                          │
  │  T3 ───────────┼──► T5 ──► T6 ────────────┤
  │                └──────────────► T12 ──────┼──► T14 ──► T15
  │  T8 ──► T9 ──► T10 ───────────────────────┤
  └► T11 ─────────────────────────────────────┘
```

At most three implementers; lanes own disjoint files.

| Wave | Lane A (events, radar)                                                                                    | Lane B (models)                                                                      | Lane C (projects, host, trajectory)                                                      | Restart                                                      |
| ---- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | T0, T1, T2 (`src/projections/`, `src/events/task-events*`, `src/storage.ts`, `progress/display-store.ts`) | T8 (`src/models/candidate-store.ts`, `source-store.ts`, `comparison-read.ts`)        | T11 (`src/projects/`, `src/core/registry.ts`, `project-key.ts`)                          | once: task-events, model-sources, project-overview, projects |
| 2    | T4, T5 (`progress/recorder.ts`, `runner/scheduler-coordinator.ts`, `streams/sources/radar*`)              | T9 (`decision-*.ts`, `decision-worker*.ts`)                                          | T3 (`src/events/host-session-state.ts`, `core/event-hub.ts`, `observability/changes.ts`) | once: runner 22, host-sessions, model-decision-projection 4  |
| 3    | T6 (`src/radar/`, `website/demo/src/panels/radar*`)                                                       | T10 (`mapping-store.ts`, `models-controller.ts`, `comparison-state.ts`, demo models) | T7 (`events/host-transcript-fold.ts`, `trajectory/effort-store.ts`)                      | once: trajectory-projection, model-mappings 2                |
| 4    | T12 (`src/tasks/`, `streams/sources/tasks*`, `task-detail*`)                                              | —                                                                                    | T13 (`src/trajectory-panel/`, `trajectory/tools.ts`, demo trajectory)                    | once: task-schedule 5                                        |
| 5    | T14 (one implementer, after all)                                                                          |                                                                                      |                                                                                          | none                                                         |

Conflicts avoided: T2 and T4 both touch the progress recorder, so both sit in lane A; T6 and
T13 both drop `Observability.changed` consumers, but only T14 deletes the event; `src/index.ts`
registration edits are one line per task and merged in wave order.

## Schema generations and migration cost (418,671 transitions, 79,365 progress rows)

| Module                      | Generation | Task   | Work at install                                                         | Backfill (owner timer, paged)                                                                                                                             |
| --------------------------- | ---------- | ------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task-events`               | new, 1     | T1, T2 | create tables, triggers (plus `projections` new, 1: `projection_state`) | measured: 225 transition pages, 53 effect pages, 318 progress pages; 2.6 s of writer time in pages of at most about 36 ms, spread over the owner's pacing |
| `projects`                  | 2 → 3      | T11    | `CREATE INDEX lazers_project_paths_key` (3 rows)                        | none                                                                                                                                                      |
| `project-overview`          | new, 1     | T11    | create                                                                  | 1 transaction (3 rows)                                                                                                                                    |
| `model-sources`             | 2 → 3      | T8     | create `model_candidates`                                               | 1 build per project: 5 body parses (≈0.93 MB each), ≈1,400 rows                                                                                           |
| ★ `native-call-display`     | new, 1     | T4     | create display table, index, triggers                                   | measured: 166 pages of 500 over 82,525 calls, median 5.6 ms, slowest 38 ms, 1.3 s                                                                         |
| ★ `scheduler-status`        | new, 1     | T4     | create one-row-per-project table                                        | none                                                                                                                                                      |
| `host-sessions`             | new, 1     | T3     | create (★ table + `host_session_dirty` queue)                           | ★ seed: 6 queue pages (slowest 0.6 ms); then one `session.get` per seeded session, async                                                                  |
| `model-decision-projection` | 3 → 4      | T9     | create view tables                                                      | none (materialized on open)                                                                                                                               |
| `trajectory-projection`     | new, 1     | T7     | create effort table                                                     | 252 sessions × message pages of 50 (host reads, async); ≈800 pages of 100 progress payloads for effort                                                    |
| `model-mappings`            | 1 → 2      | T10    | create view                                                             | 1 transaction per project                                                                                                                                 |
| `task-schedule`             | 4 → 5      | T12    | drop and recreate projection                                            | 260 tasks re-backfilled (seconds)                                                                                                                         |

Every bump is a full service restart; four restarts total (one per wave 1–4).

## What stays on the main thread deliberately

| Read                                                                             | Why                                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `authorize` point reads (session lookup, permission assert, task-in-scope probe) | They gate an `open`; one indexed row each; they run before any frame                |
| Writers' reads inside `atomic` (projection refresh, drains)                      | They must see the writer's uncommitted rows; one writer means no races              |
| Runner decide reads (dispatch, reservations, plan state for a tick)              | Decide reads belong in the write's transaction (`design/data-streams.md` "Threads") |
| Host-event fold and transcript fold                                              | Host facts are written, not shown; reads are async host calls, not SQLite           |
| `setupStatus`, `startSetup`, `saveProfile`, `refreshSources`, `configure*`       | Writes or session decisions, not history reads                                      |
| Price identity inputs for the decision worker                                    | Host storage and integration state live in the main process                         |

## Riskiest three

1. **Host facts in the database (T3, T7).** Live session state and attempt transcripts become
   folds of host events. A dropped or reordered event, a cross-process writer the hook does not
   see (`src/database-events.ts:40-42` sees only this process), or a privacy rule applied at
   write time instead of read time changes what the panels show. The transcript backfill is
   hundreds of async host pages on a loaded machine.
2. **Models views written from worker output (T9).** Moving `buildCatalog`/`rankCatalog` into
   the worker and storing per-filter views changes when numbers update (warm pass cadence),
   adds a main-thread write per view refresh, and must keep price provenance and "omit when
   unpriced" exactly.
3. **Effort parity (T7).** Stored per-session usage pieces plus repricing must reproduce
   `projectTaskEffortBasis` and `marketEquivalentCostOf` bit for bit; a divergence shows wrong
   costs with no error.

## Questions only the owner can answer

1. Models decision views: materialize per filter (persona × task kind × period) on open, keep
   while read, drop after the existing 7-day idle sweep — or store every filter always?
2. Projects `list`/`profile` have no session or permission check today. Keep that for the
   streams, or require the `read` permission of the opening session?
3. Attempt transcripts: storing folded, privacy-filtered message parts in `tasks.sqlite`
   (growth bounded by retention) instead of reading the host on demand — acceptable, and under
   which retention rule?
4. `project_presence` assumes one service process per database (rows of another instance are
   cleared at start). Is that true for every deployment you run?

## Owner decisions (2026-11-21)

- **Scope:** all four panels ship in v0.2.0.
- **Question 3, transcripts, final (2026-11-21, replaces the entry below):** store, at a minimum,
  the transcript metadata the product requires; skip the line-by-line text. OpenCode owns message
  text (read on demand by cursor, for display only); LAZERS owns the facts it derives from
  messages, stored once, small, and queried (data-handling principle 4). A per-message metadata
  projection of worker sessions, folded by host cursor, feeds effort and route coverage, so the
  stored effort equals the history capture on every field. No text, tool input or output, or
  reasoning is stored. Transcript text in the Trajectory panel stays a host-backed stream.
  ★ Task 7 as built: `trajectory_task_effort` (module `trajectory-effort` 1), computed in the
  effort worker (`src/trajectory/effort-worker.ts`); the main thread claims and writes (longest
  step median 0.7 ms, up to about 20 ms when a write meets a WAL checkpoint). Until the metadata
  projection lands, the route fields (`routes.observedStepRoutes` native-context sources,
  `routes.assessments`, `routes.coverage`, market `coverage.routeEvidence` and
  `sessions[].routeAllocation`) equal the status read, not the history capture.
- **Question 3, transcripts: not stored** (superseded by the entry above). OpenCode already holds attempt transcripts; LAZERS
  does not duplicate them. Task 7 loses the host transcript fold
  (`src/events/host-transcript-fold.ts` is not built, no message text enters `tasks.sqlite`).
  Trajectory text is read from the host on demand, by cursor, a page at a time
  (`src/core/host-page.ts`, data-handling principle 4): the host call is asynchronous, so it does
  not block the main thread, and the window is the consumer's item count. Task 7 keeps only what
  LAZERS derives and cannot ask the host for cheaply: `trajectory_task_effort` (usage numbers,
  repriced from stored pieces) and the event rows already in `task_events`. Task 13's transcript
  source becomes a host-backed stream with the same contract (`open`, `slide`, `seek`, `close`),
  not a database source.
- **Question 1, driver's call:** decision views are materialized per filter when a stream opens
  them and dropped by the existing 7-day idle sweep.
- **Question 2, driver's call:** carry over today's checks unchanged (migration recipe: "carry
  over the old read's scope checks"); no new permission requirement in this release.
- **Question 4, driver's call:** one service process per database is the only supported
  deployment (the OpenCode service owns the plugin data directory).

## Owner decision, final, on transcripts (2026-11-21, later the same day)

This replaces the "transcripts: not stored" entry above. In the owner's words: store, at a
minimum, all the metadata from the transcript that we require; skip the line-by-line text.

- **OpenCode owns message text.** It is read on demand, by cursor, for display. It is never
  written to `tasks.sqlite`.
- **LAZERS owns the facts it derives from messages** (data-handling principle 4) and stores them
  once: per message or step, the ids, ordering key and times, role, provider, model, effort, the
  five token categories, finish or error name, and tool call ids, names, status and duration
  where a consumer reads them. A column with no consumer is not stored; no free-text column
  exists.
- Effort and route coverage are computed from those stored rows alone, with whole-object parity
  against the history capture. A session OpenCode has pruned keeps the rows already folded.
- The rows follow the finished-plan retention age.
