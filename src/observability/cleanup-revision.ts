import type { Database } from "bun:sqlite"
import { WORKTREE_CREATION_KINDS } from "../runner/cleanup/worktree-kinds.ts"

const TRACKED_COLUMNS: Record<string, readonly string[]> = {
  runner_plans: ["id", "project_directory", "state", "revision", "owner", "artifact"],
  runner_effects: ["id", "plan_id", "kind", "state", "payload", "receipt"],
  runner_attempts: [
    "id",
    "plan_id",
    "project_directory",
    "task_id",
    "number",
    "session_id",
    "message_id",
    "workspace",
    "artifact",
    "state",
    "started_at",
  ],
  runner_adoptions: ["id", "plan_id", "state", "task_workspace", "combined_workspace"],
  runner_adoption_checks: ["adoption_id", "phase", "check_id", "state", "receipt", "created_at"],
  tasks: ["id", "project_directory", "body"],
}

const TABLES = Object.keys(TRACKED_COLUMNS)
const creationKinds = WORKTREE_CREATION_KINDS.map((kind) => `'${kind}'`).join(",")

/** Install revisions for the durable facts cleanup actually reads, not every project observation. */
export function ensureCleanupRevisions(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS cleanup_revisions (
    project_directory TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(project_directory,plan_id)
  )`)

  for (const table of TABLES) {
    const tracked = new Set(TRACKED_COLUMNS[table])
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .filter(({ name }) => tracked.has(name))
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const changed =
        event === "UPDATE"
          ? `WHEN ${
              columns.map(({ name }) => `OLD."${name}" IS NOT NEW."${name}"`).join(" OR ") || "0"
            }`
          : ""
      const rows = event === "UPDATE" ? ["OLD", "NEW"] : [event === "DELETE" ? "OLD" : "NEW"]
      const plans = rows
        .flatMap((row) => plansForRow(table, row))
        .concat(table === "runner_attempts" ? rows.flatMap(ownersForAttempt) : [])
        .join(" UNION ")
      const name = `cleanup_revision_${table}_${event}`
      const definition = `CREATE TRIGGER ${name}
        AFTER ${event} ON ${table} ${changed} BEGIN
          INSERT INTO cleanup_revisions(project_directory,plan_id,revision)
          SELECT project_directory,plan_id,1 FROM (${plans})
          WHERE project_directory IS NOT NULL
          ON CONFLICT(project_directory,plan_id) DO UPDATE SET revision=revision+1;
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
}

/** One indexed lookup; unrelated project and plan observations do not invalidate cleanup facts. */
export function cleanupRevisionStamp(
  db: Database,
  projectDirectory: string,
  planID: string,
): number {
  try {
    return (
      db
        .query<{ revision: number }, [string, string]>(
          "SELECT revision FROM cleanup_revisions WHERE project_directory=? AND plan_id=?",
        )
        .get(projectDirectory, planID)?.revision ?? 0
    )
  } catch {
    // NaN never equals itself, so a missing stamp table cannot reuse stale cleanup facts.
    return Number.NaN
  }
}

function plansForRow(table: string, row: string): string[] {
  if (table === "runner_plans")
    return [`SELECT ${row}.project_directory AS project_directory,${row}.id AS plan_id`]
  if (table === "tasks")
    return [
      `SELECT p.project_directory,p.id AS plan_id FROM runner_attempts a
       JOIN runner_plans p ON p.id=a.plan_id
       WHERE p.project_directory=${row}.project_directory AND a.task_id=${row}.id`,
    ]
  if (table === "runner_adoption_checks")
    return [
      `SELECT p.project_directory,p.id AS plan_id FROM runner_adoptions a
       JOIN runner_plans p ON p.id=a.plan_id WHERE a.id=${row}.adoption_id`,
    ]
  return [
    `SELECT p.project_directory,p.id AS plan_id FROM runner_plans p
     WHERE p.id=${row}.plan_id`,
  ]
}

function ownersForAttempt(row: string): string {
  return `SELECT p.project_directory,p.id AS plan_id FROM runner_plans p
    JOIN runner_effects e ON e.plan_id=p.id
    WHERE p.project_directory=${row}.project_directory
      AND e.kind IN (${creationKinds}) AND e.state='completed'
      AND CASE WHEN json_valid(e.receipt)
        THEN json_extract(e.receipt,'$.workspace') END=${row}.workspace`
}
