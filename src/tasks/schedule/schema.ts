import type { Database } from "bun:sqlite"
import { schemaModules } from "../../database-schema.ts"
import type { TaskRepository } from "../../storage.ts"
import { drainTaskSchedule } from "./drain.ts"
import { enrollScheduleConnection, registerScheduleDrain } from "./hook.ts"

import { BUCKETS, type Bucket } from "./buckets.ts"

export { BUCKETS, type Bucket }

export type DirtyKind = "task" | "plan" | "reservations" | "pause"

const MODULE = schemaModules["task-schedule"]
export const TASK_SCHEDULE_TABLES = MODULE.tables

/** Rows of each projection table, dropped together on a generation change. */
export const TABLES_SQL = `
  CREATE TABLE task_schedule (
    seq INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE,
    project_directory TEXT NOT NULL,
    reference TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    classification TEXT NOT NULL,
    source_plan TEXT,
    search_text TEXT NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    retired INTEGER NOT NULL DEFAULT 0,
    disposition TEXT,
    plan_id TEXT,
    plan_seq INTEGER,
    ordinal INTEGER,
    node_state TEXT,
    plan_state TEXT,
    rank INTEGER NOT NULL,
    bucket TEXT NOT NULL,
    owner_hold INTEGER NOT NULL DEFAULT 0,
    priority_key INTEGER NOT NULL,
    finished_at INTEGER NOT NULL DEFAULT 0,
    finished_basis TEXT,
    transition_mark INTEGER NOT NULL DEFAULT 0,
    sort_key TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    node_reason TEXT,
    plan_reason TEXT,
    started_at INTEGER,
    takeover INTEGER NOT NULL DEFAULT 0,
    concern TEXT,
    concern_totals TEXT,
    concern_version INTEGER,
    dispatch_pause TEXT,
    dispatch_pause_plan_id TEXT,
    wait_plans_count INTEGER NOT NULL DEFAULT 0,
    wait_plan_ids TEXT NOT NULL DEFAULT '[]',
    blocker_task_ids TEXT NOT NULL DEFAULT '[]',
    dependency_waiting INTEGER NOT NULL DEFAULT 0,
    blocker_count INTEGER NOT NULL DEFAULT 0,
    dependency_count INTEGER NOT NULL DEFAULT 0,
    decision TEXT NOT NULL,
    decision_reason TEXT
  );
  CREATE INDEX task_schedule_order ON task_schedule(project_directory, retired, sort_key);
  CREATE INDEX task_schedule_bucket ON task_schedule(project_directory, retired, bucket, sort_key);
  CREATE INDEX task_schedule_bucket_recent ON task_schedule(project_directory, retired, bucket, seq);
  CREATE INDEX task_schedule_hold ON task_schedule(project_directory, seq) WHERE owner_hold=1 AND retired=0;
  CREATE INDEX task_schedule_creator
    ON task_schedule(project_directory, session_id, retired, sort_key);
  CREATE INDEX task_schedule_recent ON task_schedule(project_directory, retired, seq);
  CREATE INDEX task_schedule_plan ON task_schedule(plan_id);
  CREATE INDEX task_schedule_plan_basis ON task_schedule(plan_id) WHERE finished_basis='plan';
  CREATE TABLE task_schedule_plans (
    plan_id TEXT PRIMARY KEY,
    project_directory TEXT NOT NULL,
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    priority INTEGER NOT NULL,
    priority_key INTEGER NOT NULL,
    owner_session_id TEXT NOT NULL,
    workspace_mode TEXT,
    after_plans TEXT NOT NULL,
    after_plans_count INTEGER NOT NULL,
    pause TEXT,
    plan_revision INTEGER NOT NULL,
    node_count INTEGER NOT NULL,
    open_count INTEGER NOT NULL
  );
  CREATE INDEX task_schedule_plans_order
    ON task_schedule_plans(project_directory, priority_key, seq);
  CREATE TABLE task_schedule_edges (
    parent_task_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    child_task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    child_reference TEXT,
    child_title TEXT NOT NULL,
    child_state TEXT NOT NULL,
    waiting INTEGER NOT NULL,
    child_plan_id TEXT,
    PRIMARY KEY(parent_task_id, ord)
  );
  CREATE INDEX task_schedule_edges_child ON task_schedule_edges(child_task_id);
  CREATE INDEX task_schedule_edges_plan ON task_schedule_edges(child_plan_id);
  CREATE TABLE task_schedule_blockers (
    task_id TEXT NOT NULL,
    blocker_task_id TEXT NOT NULL,
    PRIMARY KEY(task_id, blocker_task_id)
  );
  CREATE INDEX task_schedule_blockers_blocker ON task_schedule_blockers(blocker_task_id);
  CREATE TABLE task_schedule_waits (
    task_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    plan_id TEXT NOT NULL,
    title TEXT,
    state TEXT,
    version INTEGER,
    reason TEXT,
    PRIMARY KEY(task_id, ord)
  );
  CREATE TABLE task_schedule_sessions (
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY(session_id, task_id, role)
  );
  CREATE INDEX task_schedule_sessions_task ON task_schedule_sessions(task_id);
  CREATE TABLE task_schedule_scopes (
    task_id TEXT NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY(task_id, path)
  );
  CREATE INDEX task_schedule_scopes_path ON task_schedule_scopes(path);
  CREATE TABLE task_schedule_counts (
    project_directory TEXT NOT NULL,
    bucket TEXT NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY(project_directory, bucket)
  );
  CREATE VIEW task_schedule_session_bucket_counts AS
    SELECT s.session_id AS session_id, t.project_directory AS project_directory,
           t.bucket AS bucket, COUNT(*) AS n
    FROM task_schedule_sessions s JOIN task_schedule t ON t.task_id=s.task_id
    WHERE t.retired=0 GROUP BY s.session_id, t.project_directory, t.bucket;
`

/** `task_schedule_failed` parks entries whose refresh threw, out of the hot queue. */
export const SUPPORT_SQL = `
  CREATE TABLE IF NOT EXISTS task_schedule_dirty (
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    PRIMARY KEY(kind, ref)
  );
  CREATE TABLE IF NOT EXISTS task_schedule_failed (
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    error TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    next_at INTEGER NOT NULL,
    PRIMARY KEY(kind, ref)
  );
  CREATE TABLE IF NOT EXISTS task_schedule_state (
    project_directory TEXT PRIMARY KEY,
    ready INTEGER NOT NULL DEFAULT 0,
    backfill_after INTEGER NOT NULL DEFAULT 0,
    reservations_fp TEXT NOT NULL DEFAULT '',
    last_error TEXT
  );
`

type TriggerSpec = {
  table: string
  event: "INSERT" | "UPDATE" | "DELETE"
  /** `UPDATE OF` columns; a change to any other column fires nothing. */
  columns?: readonly string[]
  /** Guard evaluated before the body, so hot tables cost nothing for irrelevant rows. */
  when?: string
  /** Statements queuing work: `[kind, SQL expression over NEW/OLD, optional extra WHERE]`. */
  queues: readonly (readonly [DirtyKind, string, string?])[]
}

const projectOfPlan = (plan: string) =>
  `(SELECT project_directory FROM runner_plans WHERE id=${plan})`

/** Every write to a table the list is derived from queues its owner. Triggers decide nothing. */
export const SCHEDULE_TRIGGERS: readonly TriggerSpec[] = [
  { table: "tasks", event: "INSERT", queues: [["task", "NEW.id"]] },
  { table: "task_references", event: "INSERT", queues: [["task", "NEW.task_id"]] },
  {
    table: "task_references",
    event: "UPDATE",
    columns: ["reference"],
    queues: [["task", "NEW.task_id"]],
  },
  { table: "task_dispositions", event: "INSERT", queues: [["task", "NEW.task_id"]] },
  { table: "task_classifications", event: "INSERT", queues: [["task", "NEW.task_id"]] },
  { table: "runner_plans", event: "INSERT", queues: [["plan", "NEW.id"]] },
  {
    table: "runner_plans",
    event: "UPDATE",
    columns: ["state", "reason", "body", "owner", "project_directory"],
    queues: [["plan", "NEW.id"]],
  },
  {
    // Reservations are listed in plan priority order, and blocker reasons name them in that order.
    table: "runner_plans",
    event: "UPDATE",
    columns: ["body"],
    queues: [["reservations", "NEW.project_directory"]],
  },
  { table: "runner_nodes", event: "INSERT", queues: [["plan", "NEW.plan_id"]] },
  { table: "runner_nodes", event: "DELETE", queues: [["plan", "OLD.plan_id"]] },
  {
    table: "runner_nodes",
    event: "UPDATE",
    // `artifact`: a prerequisite's recorded artifact decides whether its successors still wait.
    columns: ["state", "reason", "ordinal", "artifact"],
    queues: [["plan", "NEW.plan_id"]],
  },
  { table: "runner_dependencies", event: "INSERT", queues: [["plan", "NEW.plan_id"]] },
  { table: "runner_dependencies", event: "DELETE", queues: [["plan", "OLD.plan_id"]] },
  {
    table: "runner_attempts",
    event: "INSERT",
    queues: [
      ["task", "NEW.task_id"],
      ["reservations", projectOfPlan("NEW.plan_id")],
    ],
  },
  {
    table: "runner_attempts",
    event: "UPDATE",
    columns: ["state", "session_id", "workspace", "policy"],
    queues: [
      ["task", "NEW.task_id"],
      ["reservations", projectOfPlan("NEW.plan_id")],
    ],
  },
  {
    table: "runner_adoptions",
    event: "INSERT",
    queues: [
      ["task", "NEW.task_id"],
      ["plan", "NEW.plan_id"],
      ["reservations", projectOfPlan("NEW.plan_id")],
    ],
  },
  {
    table: "runner_adoptions",
    event: "UPDATE",
    columns: ["state", "hold_reason"],
    queues: [
      ["task", "NEW.task_id"],
      ["plan", "NEW.plan_id"],
      ["reservations", projectOfPlan("NEW.plan_id")],
    ],
  },
  {
    table: "runner_transitions",
    event: "INSERT",
    // A recorded landing releases the successors of the task, which a plan refresh re-derives.
    when: "NEW.event IN ('SCOPE_AMENDED','PREREQUISITE_OBSERVED','TASK_INTEGRATION_RECORDED')",
    queues: [
      ["task", "NEW.task_id", "NEW.task_id IS NOT NULL"],
      ["plan", "NEW.plan_id", "NEW.task_id IS NULL OR NEW.event='TASK_INTEGRATION_RECORDED'"],
      ["reservations", projectOfPlan("NEW.plan_id"), "NEW.event='SCOPE_AMENDED'"],
    ],
  },
  {
    table: "runner_transitions",
    event: "INSERT",
    // Only rows that took the plan's newest transition as their finish time follow it.
    when: "EXISTS (SELECT 1 FROM task_schedule WHERE plan_id=NEW.plan_id AND finished_basis='plan')",
    queues: [["plan", "NEW.plan_id"]],
  },
  { table: "runner_dispatch_controls", event: "INSERT", queues: [["plan", "NEW.plan_id"]] },
  { table: "runner_dispatch_controls", event: "UPDATE", queues: [["plan", "NEW.plan_id"]] },
  { table: "lazers_dispatch_pause", event: "INSERT", queues: [["pause", "NEW.scope"]] },
  { table: "lazers_dispatch_pause", event: "UPDATE", queues: [["pause", "NEW.scope"]] },
  {
    table: "recovery_concern_versions",
    event: "INSERT",
    queues: [["task", "NEW.task_id"]],
  },
  {
    table: "recovery_concern_dispositions",
    event: "INSERT",
    queues: [
      [
        "task",
        `(SELECT task_id FROM recovery_concern_versions WHERE project_directory=NEW.project_directory AND concern_id=NEW.concern_id LIMIT 1)`,
        `EXISTS (SELECT 1 FROM recovery_concern_versions WHERE project_directory=NEW.project_directory AND concern_id=NEW.concern_id)`,
      ],
    ],
  },
]

const triggerName = (spec: TriggerSpec, index: number) =>
  `task_schedule_q_${spec.table}_${spec.event.toLowerCase()}_${index}`

const hasTable = (db: Database, name: string) =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))

/**
 * Create the queue triggers for every source table that exists now. Safe to run again: the
 * recovery tables are created by another module, which calls this once they exist.
 */
export function installScheduleTriggers(db: Database) {
  if (!hasTable(db, "task_schedule_dirty")) return
  SCHEDULE_TRIGGERS.forEach((spec, index) => {
    if (!hasTable(db, spec.table)) return
    const name = triggerName(spec, index)
    const body = spec.queues
      .map(
        ([kind, ref, where]) =>
          `INSERT OR IGNORE INTO task_schedule_dirty(kind,ref) SELECT '${kind}',${ref}${where ? ` WHERE ${where}` : ` WHERE ${ref} IS NOT NULL`};`,
      )
      .join("\n")
    const of = spec.columns ? ` OF ${spec.columns.join(",")}` : ""
    db.exec(
      `DROP TRIGGER IF EXISTS ${name};
       CREATE TRIGGER ${name} AFTER ${spec.event}${of} ON ${spec.table}
       ${spec.when ? `WHEN ${spec.when}` : ""} BEGIN
         ${body}
       END;`,
    )
  })
}

/** The projection tables, indexes and triggers, rebuilt from nothing; backfill refills them. */
export function installTaskScheduleSchema(db: Database) {
  db.exec(SUPPORT_SQL)
  const drops = db
    .query<{ name: string; type: string }, []>(
      `SELECT name,type FROM sqlite_master WHERE (type IN ('table','view') AND name LIKE 'task_schedule%'
         AND name NOT IN ('task_schedule_dirty','task_schedule_state','task_schedule_failed'))`,
    )
    .all()
  for (const { name } of drops.filter((row) => row.type === "view")) db.exec(`DROP VIEW ${name}`)
  for (const { name } of drops.filter((row) => row.type === "table")) db.exec(`DROP TABLE ${name}`)
  db.exec(TABLES_SQL)
  db.exec("DELETE FROM task_schedule_dirty")
  db.exec(
    "UPDATE task_schedule_state SET ready=0, backfill_after=0, reservations_fp='', last_error=NULL",
  )
  installScheduleTriggers(db)
}

/** Install through the module registry: one transaction, generation checked. */
export function ensureTaskScheduleSchema(repository: TaskRepository) {
  repository.installSchema("task-schedule", MODULE.generation, MODULE.tables, (db) => {
    installTaskScheduleSchema(db)
  })
  repository.read((db) => enrollScheduleConnection(db))
  registerScheduleDrain((db) => void drainTaskSchedule(db))
}
