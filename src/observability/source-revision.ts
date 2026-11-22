import type { Database } from "bun:sqlite"
import { ensureCleanupRevisions } from "./cleanup-revision.ts"

const DERIVED_COLUMNS: Record<string, readonly string[]> = {
  runner_progress: ["latest_observed_at", "plan_n", "attempt_n"],
  runner_transitions: ["plan_n"],
}

/** Transactional invalidation; panel polling never needs to scan historical payloads. */
export function ensureObservationRevision(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS observation_revisions (
    project_directory TEXT PRIMARY KEY, revision INTEGER NOT NULL
  )`)
  const direct = ["tasks", "task_changes", "task_dispositions", "runner_plans", "runner_progress"]
  const related = [
    "runner_nodes",
    "runner_dependencies",
    "runner_attempts",
    "runner_effects",
    "runner_adoptions",
    "runner_adoption_checks",
    "runner_continuations",
    "runner_outbox",
    "runner_transitions",
  ]
  for (const table of [...direct, ...related]) {
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      // Derived columns: the recency stamp and the integer identity keys, filled by triggers and the
      // paged backfill, are not changes an observer can see.
      .filter(({ name }) => !DERIVED_COLUMNS[table]?.includes(name))
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const changed =
        event === "UPDATE"
          ? `WHEN ${columns.map(({ name }) => `OLD."${name}" IS NOT NEW."${name}"`).join(" OR ")}`
          : ""
      const rows = event === "UPDATE" ? ["OLD", "NEW"] : [event === "DELETE" ? "OLD" : "NEW"]
      const projects = rows
        .map((row) => {
          if (direct.includes(table)) return `SELECT ${row}.project_directory AS project_directory`
          if (table === "runner_adoption_checks")
            return `SELECT p.project_directory FROM runner_adoptions a
              JOIN runner_plans p ON p.id=a.plan_id WHERE a.id=${row}.adoption_id`
          return `SELECT project_directory FROM runner_plans WHERE id=${row}.plan_id`
        })
        .join(" UNION ")
      const name = `observation_revision_${table}_${event}`
      const definition = `CREATE TRIGGER ${name}
        AFTER ${event} ON ${table} ${changed} BEGIN
          INSERT INTO observation_revisions(project_directory,revision)
          SELECT project_directory,1 FROM (${projects}) WHERE project_directory IS NOT NULL
          ON CONFLICT(project_directory) DO UPDATE SET revision=revision+1;
        END`
      const current = db
        .query<{ sql: string }, [string]>(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
        )
        .get(name)?.sql
      const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim()
      if (current && normalize(current) === normalize(definition)) continue
      if (current) db.exec(`DROP TRIGGER ${name}`)
      db.exec(definition)
    }
  }
  ensureCleanupRevisions(db)
}
