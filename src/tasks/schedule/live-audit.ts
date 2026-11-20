import { Database } from "bun:sqlite"
import { scheduledTaskPageSQL } from "../schedule-order.ts"
import { taskStatePredicate, TaskStateFilter } from "../state-filter.ts"
import { backfillPage } from "./backfill.ts"
import { bucketsFor } from "./key.ts"
import { SUPPORT_SQL, TABLES_SQL } from "./schema.ts"

/**
 * Audit the projection against a database file that is never written.
 *
 * An in-memory database is `main` and holds the projection tables. The file is attached
 * `mode=ro` as `live`: SQLite resolves an unqualified table name to the first database that has
 * it, so the refresh code reads the source tables from the file and writes only the projection.
 * Nothing is copied or written to the file, and no repository is opened (a repository would
 * install schema in it).
 *
 * It compares the order of the old schedule query and each state chip's membership with the
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
        .query<{ body: string }, [string, number]>(scheduledTaskPageSQL("tasks", where, false))
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
