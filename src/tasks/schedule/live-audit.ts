import { Database } from "bun:sqlite"
import { planPrioritySortSQL } from "../../runner/priority.ts"
import { TaskStateFilter } from "../state-filter.ts"
import { backfillPage } from "./backfill.ts"
import { bucketsFor } from "./key.ts"
import { SUPPORT_SQL, TABLES_SQL } from "./schema.ts"
import { planIs } from "../../runner/identity-read.ts"

// The old read's SQL, kept here only so the audit can compare a live database with the stored list.
// It is not exported: product code reads the stored list.

/**
 * State rank of a task for the list, from the same effective-state rules as `state-filter.ts`:
 * a cancelled plan or node is cancelled, a blocked plan holds its running node out of Running.
 *
 *   0 running or verifying   1 other open (queued, ready, waiting, blocked, paused, unplanned)
 *   2 accepted   3 integrated   4 failed or exhausted   5 cancelled
 */
const STATE_RANK_SQL = (node: string, plan: string) => `CASE
  WHEN ${node}.state='cancelled' OR ${plan}.state='cancelled' THEN 5
  WHEN ${node}.state IN ('failed','exhausted') THEN 4
  WHEN ${node}.state='incorporated' THEN 3
  WHEN ${node}.state='accepted' THEN 2
  WHEN ${node}.state IN ('running','verifying') AND ${plan}.state!='blocked' THEN 0
  ELSE 1
END`

/**
 * One sort key for every filter and page, computed in the read; never mutates scheduling.
 *
 *   1. state rank (above)
 *   2a. open ranks: plan priority (1 first, none last), plan FIFO, node ordinal, task rowid;
 *       unplanned tasks follow all planned work, most recent first
 *   2b. finished ranks: most recently finished first, then plan priority, then task rowid
 *       (newest first). Finished time is the latest recorded transition of the node into its
 *       current state (`runner_transitions.created_at`); a task cancelled with its plan uses the
 *       plan's latest transition; with no record it sorts as oldest.
 *
 * `position` pages over the whole key, so cursors stay stable and gap-free.
 */
function scheduledTaskPageSQL(db: Database, alias: "t" | "tasks", where: string, before: boolean) {
  return `WITH ranked AS (
    SELECT ${alias}.body AS body,r.reference AS reference,${alias}.rowid AS task_rowid,
      schedule_plan.id AS plan_id,schedule_plan.rowid AS plan_rowid,
      schedule_node.ordinal AS ordinal,schedule_node.plan_id AS node_plan,schedule_node.task_id AS node_task,
      schedule_node.state AS node_state,
      ${planPrioritySortSQL("schedule_plan.body")} AS priority_key,
      ${STATE_RANK_SQL("schedule_node", "schedule_plan")} AS rank
    FROM tasks ${alias}
    JOIN task_references r ON r.project_directory=${alias}.project_directory AND r.task_id=${alias}.id
    LEFT JOIN runner_nodes schedule_node ON schedule_node.task_id=${alias}.id
    LEFT JOIN runner_plans schedule_plan ON schedule_plan.id=schedule_node.plan_id
      AND schedule_plan.project_directory=${alias}.project_directory
    WHERE ${where}
  ), timed AS (
    SELECT *,CASE WHEN rank>=2 THEN COALESCE(
        (SELECT MAX(tr.created_at) FROM runner_transitions tr
          WHERE ${planIs(db, "runner_transitions", "tr", "node_plan")} AND tr.task_id=node_task
            AND json_extract(tr.payload,'$.to')=node_state),
        (SELECT MAX(tr.created_at) FROM runner_transitions tr WHERE ${planIs(db, "runner_transitions", "tr", "node_plan")}),0)
      ELSE 0 END AS finished
    FROM ranked
  ), scheduled AS (
    SELECT body,reference,
      COUNT(*) OVER () - ROW_NUMBER() OVER (ORDER BY
        rank,
        CASE WHEN rank<=1 AND plan_id IS NULL THEN 1 ELSE 0 END,
        -finished,
        priority_key,
        CASE WHEN rank<=1 THEN COALESCE(plan_rowid,0) ELSE 0 END,
        CASE WHEN rank<=1 THEN COALESCE(ordinal,0) ELSE 0 END,
        CASE WHEN rank>=2 OR plan_id IS NULL THEN -task_rowid ELSE task_rowid END
      ) + 1 AS position
    FROM timed
  ) SELECT body,reference,position FROM scheduled
    ${before ? "WHERE position<?" : ""} ORDER BY position DESC LIMIT ?`
}

/** SQL predicate for a correlated `tasks` (or `t`) row, as the old chips filtered. */
function taskStatePredicate(state: string, taskAlias: "tasks" | "t"): string {
  if (state === "all") return ""
  if (state === "legacy")
    return `NOT EXISTS (
      SELECT 1 FROM runner_nodes n
      WHERE n.task_id=${taskAlias}.id AND n.state IN ('accepted','incorporated','cancelled')
    ) AND NOT EXISTS (
      SELECT 1 FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
      WHERE n.task_id=${taskAlias}.id
        AND p.project_directory=${taskAlias}.project_directory AND p.state='cancelled'
    )`
  const effective = `CASE
    WHEN p.state='cancelled' OR n.state='cancelled' THEN 'cancelled'
    WHEN p.state='blocked' AND n.state IN ('queued','ready') THEN 'blocked'
    ELSE n.state
  END`
  const matchingExecution = (predicate: string) => `EXISTS (
    SELECT 1 FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
    WHERE n.task_id=${taskAlias}.id AND p.project_directory=${taskAlias}.project_directory
      AND (${predicate})
  )`
  const paused = `n.state IN ('queued','ready') AND (EXISTS (
    SELECT 1 FROM runner_dispatch_controls c WHERE c.plan_id=p.id AND c.state='paused'
  ) OR EXISTS (
    SELECT 1 FROM lazers_dispatch_pause d WHERE d.state='paused' AND (
      d.scope='global' OR d.scope=(SELECT k.key FROM lazers_project_paths k WHERE k.path=p.project_directory)
    )
  ))`
  if (state === "paused")
    return matchingExecution(`p.state NOT IN ('blocked','cancelled') AND (${paused})`)
  if (state === "queued" || state === "running")
    return matchingExecution(
      `n.state='${state}' AND p.state NOT IN ('blocked','cancelled') AND NOT (${paused})`,
    )
  if (state === "blocked")
    return matchingExecution(
      `p.state!='cancelled' AND (n.state='blocked' OR (p.state='blocked' AND n.state NOT IN ('accepted','incorporated','failed','exhausted','cancelled')))`,
    )
  if (state === "completed") return matchingExecution(`${effective} IN ('accepted','incorporated')`)
  if (state === "accepted") return matchingExecution(`${effective}='accepted'`)
  if (state === "integrated") return matchingExecution(`${effective}='incorporated'`)
  if (state === "failed") return matchingExecution(`${effective} IN ('failed','exhausted')`)
  if (state === "cancelled") return matchingExecution(`${effective}='cancelled'`)
  return `NOT ${matchingExecution(`${effective} IN ('accepted','incorporated','failed','exhausted','cancelled')`)}`
}

/**
 * Audit the projection against a database file that is never written.
 *
 * An in-memory database is `main` and holds the projection tables. The file is attached
 * `mode=ro` as `live`: SQLite resolves an unqualified table name to the first database that has
 * it, so the refresh code reads the source tables from the file and writes only the projection.
 * Nothing is copied or written to the file, and no repository is opened (a repository would
 * install schema in it).
 *
 * It compares the order of the old schedule query (`scheduledTaskPageSQL`, kept above for this audit) and each state chip's membership with the
 * projection's, and reports mismatches by kind and count with task references only.
 */
export type LiveAudit = {
  project: string
  tasks: number
  scheduleOrder: { equal: boolean; firstMismatchAt?: number }
  chips: Record<string, { old: number; new: number; missing: number; extra: number }>
  /** Chip differences by kind, with up to 5 task references each. */
  kinds: Record<string, { count: number; references: string[] }>
}

export function auditLive(path: string): LiveAudit[] {
  const db = new Database("file::memory:")
  try {
    db.query("ATTACH DATABASE ? AS live").run(`file:${path}?mode=ro`)
    db.exec(SUPPORT_SQL)
    db.exec(TABLES_SQL.replace(/CREATE VIEW[\s\S]*?;\n/g, ""))
    const projects = db
      .query<{ project_directory: string }, []>("SELECT DISTINCT project_directory FROM tasks")
      .all()
      .map((row) => row.project_directory)
    const reports: LiveAudit[] = []
    for (const project of projects) {
      for (let pages = 0; !backfillPage(db, project, 50).done; pages++)
        if (pages > 1_000_000) throw new Error("Backfill did not finish")
      const reference = new Map(
        db
          .query<{ task_id: string; reference: string }, [string]>(
            "SELECT task_id,reference FROM task_references WHERE project_directory=?",
          )
          .all(project)
          .map((row) => [row.task_id, row.reference]),
      )
      const retiredOnly =
        "NOT EXISTS (SELECT 1 FROM task_dispositions d WHERE d.project_directory=tasks.project_directory AND d.task_id=tasks.id)"
      const where = `tasks.project_directory = ? AND ${retiredOnly}`
      const oldOrder = db
        .query<{ body: string }, [string, number]>(scheduledTaskPageSQL(db, "tasks", where, false))
        .all(project, 1_000_000)
        .map((row) => (JSON.parse(row.body) as { id: string }).id)
      const newOrder = db
        .query<{ task_id: string }, [string]>(
          "SELECT task_id FROM task_schedule WHERE project_directory=? AND retired=0 ORDER BY sort_key,task_id",
        )
        .all(project)
        .map((row) => row.task_id)
      const mismatch = oldOrder.findIndex((id, index) => newOrder[index] !== id)
      const report: LiveAudit = {
        project,
        tasks: oldOrder.length,
        scheduleOrder:
          mismatch < 0 && oldOrder.length === newOrder.length
            ? { equal: true }
            : { equal: false, firstMismatchAt: mismatch < 0 ? oldOrder.length : mismatch },
        chips: {},
        kinds: {},
      }
      const note = (kind: string, id: string) => {
        const entry = (report.kinds[kind] ??= { count: 0, references: [] })
        entry.count++
        if (entry.references.length < 5) entry.references.push(reference.get(id) ?? "?")
      }
      for (const chip of TaskStateFilter.options.filter((name) => name !== "all")) {
        const predicate = taskStatePredicate(chip, "tasks")
        const old = new Set(
          db
            .query<{ id: string }, [string]>(
              `SELECT tasks.id FROM tasks WHERE tasks.project_directory=? AND ${retiredOnly}${predicate ? ` AND ${predicate}` : ""}`,
            )
            .all(project)
            .map((row) => row.id),
        )
        const buckets = bucketsFor(chip)
        const mine = new Map(
          db
            .query<
              { task_id: string; bucket: string; status: string; node_state: string | null },
              [string]
            >(
              "SELECT task_id,bucket,status,node_state FROM task_schedule WHERE project_directory=? AND retired=0",
            )
            .all(project)
            .filter((row) => !buckets || buckets.includes(row.bucket as never))
            .map((row) => [row.task_id, row] as const),
        )
        let missing = 0
        let extra = 0
        for (const id of old)
          if (!mine.has(id)) {
            missing++
            note(`chip ${chip}: in the old filter, not in the projection`, id)
          }
        for (const [id, row] of mine)
          if (!old.has(id)) {
            extra++
            const explained =
              chip === "blocked" &&
              row.status === "blocked" &&
              ["queued", "ready"].includes(row.node_state ?? "")
            note(
              explained
                ? `chip ${chip}: held-back task counted as Blocked (intentional)`
                : `chip ${chip}: in the projection, not in the old filter`,
              id,
            )
          }
        report.chips[chip] = { old: old.size, new: mine.size, missing, extra }
      }
      reports.push(report)
    }
    return reports
  } finally {
    db.close()
  }
}
