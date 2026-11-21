import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import { enrollProjectionConnection, registerProjectionDrain } from "../projections/hook.ts"
import { ensureProjectionStateSchema, resetProjectionState } from "../projections/lifecycle.ts"
import { queueRef, queueRefs, queueTableSQL } from "../projections/queue.ts"
import type { TaskRepository } from "../storage.ts"
import { drainTaskEvents, TASK_EVENTS } from "./task-events-refresh.ts"

/**
 * `task_events`: what a task's timeline shows, one narrow row per event, stored so a stream reads
 * a task's, plan's or attempt's events through an index instead of rebuilding them from
 * `runner_transitions` (418,671 rows, 9,501 task-scoped), `runner_effects` and progress rows.
 *
 * ```
 * runner_transitions INSERT (task_id NOT NULL) ─┐
 * runner_effects INSERT/UPDATE/DELETE ──────────┤ triggers ─► task_events_dirty(ref)
 * runner_progress_display INSERT/UPDATE ───────┤
 * runner_attempts, runner_nodes (dependencies) ─┘                    │ drain (same transaction)
 *                                                                    ▼
 *                             task_events  ◄── refresh(ref): the trajectory read's own derivation
 * runner_transitions, runner_progress_display DELETE ── trigger ──► its row deleted directly
 * ```
 *
 * `origin` names the source row: `tr:<transition id>`, `ef:<effect id>` (a task's effect or check)
 * or `ef:<effect id>@<task id>` (a plan-level effect, shown in every task of its plan, as the
 * trajectory read shows it) or `pg:<seq>` (a progress row of one of the task's attempts). A queue `ref` is the origin without the `@<task>` part. `at` is the
 * event time the trajectory read sorts by; NULL when the source has none (an effect with no
 * attempt and no check timing), which that read sorts last. `detail` is the trajectory event (and,
 * for a check, its check view) as JSON: cold, read only at `window: 1`.
 */
const MODULE = schemaModules["task-events"]
const TASK_EVENTS_QUEUE = "task_events_dirty"

const TABLES_SQL = `
  CREATE TABLE task_events (
    id INTEGER PRIMARY KEY,
    project_directory TEXT NOT NULL, task_id TEXT NOT NULL, plan_id TEXT,
    attempt_id TEXT, session_id TEXT,
    at REAL,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL UNIQUE,
    event TEXT, from_state TEXT, to_state TEXT, status TEXT, tool TEXT, title TEXT,
    route_provider TEXT, route_model TEXT, route_variant TEXT,
    detail TEXT
  );
  CREATE INDEX task_events_task ON task_events(project_directory, task_id, at, id);
  CREATE INDEX task_events_plan ON task_events(project_directory, plan_id, kind, id);
  CREATE INDEX task_events_attempt ON task_events(project_directory, attempt_id, at, id);
  ${queueTableSQL(TASK_EVENTS_QUEUE)}
`

/** The queue ref of a stored row: its origin without a plan-level effect's `@<task>`. */
const REF_OF_ORIGIN =
  "CASE WHEN instr(origin,'@')>0 THEN substr(origin,1,instr(origin,'@')-1) ELSE origin END"
const queue = (ref: string) => queueRef(TASK_EVENTS_QUEUE, ref)
const queueSelect = (select: string) => queueRefs(TASK_EVENTS_QUEUE, select)
const planProject = (plan: string) =>
  `(SELECT project_directory FROM runner_plans WHERE id=${plan})`
/** Plan-level effects of a plan: their rows fan out to the plan's tasks. */
const planEffects = (plan: string) =>
  queueSelect(
    `SELECT 'ef:'||id AS ref FROM runner_effects WHERE plan_id=${plan} AND task_id IS NULL AND attempt_id IS NULL`,
  )

type TriggerSpec = { name: string; on: string; event: string; when?: string; body: string }

/**
 * Every trigger names the columns the derivation reads, so a write that cannot change a row
 * (the integer-key backfill's `plan_n` updates, a lease fence) queues nothing, and the
 * plan-level transitions (409,170 of 418,671) queue nothing by their `WHEN`.
 */
export const TASK_EVENTS_TRIGGERS: readonly TriggerSpec[] = [
  {
    name: "task_events_q_transition_insert",
    on: "runner_transitions",
    event: "INSERT",
    when: "NEW.task_id IS NOT NULL",
    body: queue("'tr:'||NEW.id"),
  },
  {
    name: "task_events_q_transition_update",
    on: "runner_transitions",
    event: "UPDATE OF task_id,event,payload,created_at,version",
    when: "NEW.task_id IS NOT NULL OR OLD.task_id IS NOT NULL",
    body: queue("'tr:'||NEW.id"),
  },
  {
    name: "task_events_transition_delete",
    on: "runner_transitions",
    event: "DELETE",
    when: "OLD.task_id IS NOT NULL",
    body: "DELETE FROM task_events WHERE origin='tr:'||OLD.id;",
  },
  {
    name: "task_events_q_effect_insert",
    on: "runner_effects",
    event: "INSERT",
    body: queue("'ef:'||NEW.id"),
  },
  {
    name: "task_events_q_effect_update",
    on: "runner_effects",
    event: "UPDATE OF plan_id,task_id,attempt_id,kind,state,receipt",
    body: queue("'ef:'||NEW.id"),
  },
  {
    name: "task_events_q_effect_delete",
    on: "runner_effects",
    event: "DELETE",
    body: queue("'ef:'||OLD.id"),
  },
  // A transition names its attempt only when the attempt exists; a new attempt can resolve the
  // task's transitions that had none. Read through the projection's own index, never history.
  {
    name: "task_events_q_attempt_insert",
    on: "runner_attempts",
    event: "INSERT",
    body: queueSelect(
      `SELECT origin AS ref FROM task_events WHERE project_directory=${planProject("NEW.plan_id")}
         AND task_id=NEW.task_id AND kind='transition' AND attempt_id IS NULL`,
    ),
  },
  {
    name: "task_events_q_attempt_update",
    on: "runner_attempts",
    event: "UPDATE OF plan_id,task_id,session_id,started_at",
    body: queueSelect(
      `SELECT ${REF_OF_ORIGIN} AS ref FROM task_events WHERE project_directory=${planProject("OLD.plan_id")}
         AND attempt_id=OLD.id`,
    ),
  },
  {
    name: "task_events_q_attempt_delete",
    on: "runner_attempts",
    event: "DELETE",
    body: queueSelect(
      `SELECT ${REF_OF_ORIGIN} AS ref FROM task_events WHERE project_directory=${planProject("OLD.plan_id")}
         AND attempt_id=OLD.id`,
    ),
  },
  // Progress rows mirror the stored display, which the recorder writes with the progress row.
  {
    name: "task_events_q_progress_insert",
    on: "runner_progress_display",
    event: "INSERT",
    body: queue("'pg:'||NEW.seq"),
  },
  {
    name: "task_events_q_progress_update",
    on: "runner_progress_display",
    event: "UPDATE",
    body: queue("'pg:'||NEW.seq"),
  },
  {
    name: "task_events_progress_delete",
    on: "runner_progress_display",
    event: "DELETE",
    body: "DELETE FROM task_events WHERE origin='pg:'||OLD.seq;",
  },
  // A plan's events show in a task only while the plan holds its node; plan-level effects fan out
  // to the plan's nodes.
  {
    name: "task_events_q_node_insert",
    on: "runner_nodes",
    event: "INSERT",
    // A transition written before its node in the same transaction is drained at commit, after
    // both; nodes are not added to a plan later than its transitions.
    body: planEffects("NEW.plan_id"),
  },
  {
    name: "task_events_q_node_delete",
    on: "runner_nodes",
    event: "DELETE",
    body: `${planEffects("OLD.plan_id")}
      ${queueSelect(
        `SELECT ${REF_OF_ORIGIN} AS ref FROM task_events WHERE project_directory=${planProject("OLD.plan_id")}
           AND plan_id=OLD.plan_id AND task_id=OLD.task_id`,
      )}`,
  },
]

const hasTable = (db: Database, name: string) =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))

/** Create the queue triggers on every source table that exists now; safe to run again. */
function installTaskEventsTriggers(db: Database) {
  if (!hasTable(db, "task_events")) return
  for (const spec of TASK_EVENTS_TRIGGERS) {
    if (!hasTable(db, spec.on)) continue
    db.exec(
      `DROP TRIGGER IF EXISTS ${spec.name};
       CREATE TRIGGER ${spec.name} AFTER ${spec.event} ON ${spec.on}
       ${spec.when ? `WHEN ${spec.when}` : ""} BEGIN
         ${spec.body}
       END;`,
    )
  }
}

/** The projection's tables and triggers, rebuilt from nothing; the backfill refills them. */
function installTaskEventsSchema(db: Database) {
  for (const spec of TASK_EVENTS_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${spec.name}`)
  db.exec(`DROP TABLE IF EXISTS task_events; DROP TABLE IF EXISTS ${TASK_EVENTS_QUEUE};`)
  db.exec(TABLES_SQL)
  resetProjectionState(db, TASK_EVENTS)
  installTaskEventsTriggers(db)
}

/** Install through the module registry (one transaction, generation checked) and join the drain. */
export function ensureTaskEventsSchema(repository: TaskRepository) {
  ensureProjectionStateSchema(repository)
  repository.installSchema("task-events", MODULE.generation, MODULE.tables, (db) =>
    installTaskEventsSchema(db),
  )
  registerProjectionDrain(TASK_EVENTS, TASK_EVENTS_QUEUE, (db) => void drainTaskEvents(db))
  repository.read((db) => enrollProjectionConnection(db, TASK_EVENTS))
}
