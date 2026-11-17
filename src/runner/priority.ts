import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import type { TaskRepository } from "../storage.ts"

/**
 * Plan priority: 1 is the top priority, larger integers are lower, and 0 (or absent) means none.
 * Unprioritized plans sort after every prioritized plan. Negative values from the legacy
 * "higher is first" model carry no meaning and are treated as none.
 */
export const NO_PRIORITY = 0
export const MAX_PRIORITY = 2147483647

/** Ascending sort key: 1 first, MAX_PRIORITY last, none after all. */
export function priorityKey(priority: number | null | undefined): number {
  return typeof priority === "number" && Number.isFinite(priority) && priority > 0
    ? priority
    : Number.POSITIVE_INFINITY
}

/** Comparator ordering the most important priority first. */
export function comparePriority(
  left: number | null | undefined,
  right: number | null | undefined,
): number {
  const a = priorityKey(left)
  const b = priorityKey(right)
  return a === b ? 0 : a < b ? -1 : 1
}

/** True when the value is a prioritized (positive) rank. */
export function hasPriority(priority: number | null | undefined): priority is number {
  return priorityKey(priority) !== Number.POSITIVE_INFINITY
}

/** SQL expression giving an ascending sort key for a priority expression (none sorts last). */
export function prioritySortSQL(expression: string): string {
  return `CASE WHEN COALESCE(${expression},0)>0 THEN ${expression} ELSE ${MAX_PRIORITY + 1} END`
}

/** SQL expression for a plan body column's priority sort key. */
export function planPrioritySortSQL(bodyColumn: string): string {
  return prioritySortSQL(`json_extract(${bodyColumn},'$.priority')`)
}

export const PRIORITY_MIGRATION_TABLE = "runner_priority_migration"

/**
 * Convert stored plan priorities from the legacy direction (higher first, negatives allowed) to
 * the current one. Per project, plans with a legacy priority > 0 are ranked by descending legacy
 * value into dense ranks 1..N (ties share a rank); zero or negative becomes none. Every plan with
 * a stored priority records its legacy value so the conversion is auditable and reversible.
 */
export function migrateLegacyPriorities(db: Database): number {
  // Once recorded, plan priorities already use the current direction; never convert them again.
  if (
    db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(PRIORITY_MIGRATION_TABLE)
  )
    return 0
  db.exec(`CREATE TABLE IF NOT EXISTS ${PRIORITY_MIGRATION_TABLE} (
    plan_id TEXT PRIMARY KEY, project_directory TEXT NOT NULL,
    legacy_priority INTEGER, new_priority INTEGER NOT NULL, migrated_at INTEGER NOT NULL
  )`)
  const plans = db
    .query<{ id: string; project_directory: string; priority: number | null }, []>(
      `SELECT id,project_directory,json_extract(body,'$.priority') AS priority FROM runner_plans`,
    )
    .all()
  const ranks = new Map<string, Map<number, number>>()
  for (const [directory, values] of Map.groupBy(plans, (plan) => plan.project_directory)) {
    const distinct = [
      ...new Set(
        values.flatMap((plan) => (plan.priority && plan.priority > 0 ? [plan.priority] : [])),
      ),
    ].sort((a, b) => b - a)
    ranks.set(directory, new Map(distinct.map((value, index) => [value, index + 1])))
  }
  const now = Date.now()
  let changed = 0
  for (const plan of plans) {
    const legacy = plan.priority
    const next = legacy && legacy > 0 ? ranks.get(plan.project_directory)!.get(legacy)! : 0
    if (legacy === null) continue
    db.query(`INSERT OR IGNORE INTO ${PRIORITY_MIGRATION_TABLE} VALUES(?,?,?,?,?)`).run(
      plan.id,
      plan.project_directory,
      legacy,
      next,
      now,
    )
    if (legacy !== next) {
      db.query(`UPDATE runner_plans SET body=json_set(body,'$.priority',?) WHERE id=?`).run(
        next,
        plan.id,
      )
      changed++
    }
  }
  return changed
}

/** Idempotent module install: runs once, guarded by the stored schema-module generation. */
export function installPrioritySchema(repository: TaskRepository) {
  repository.installSchema(
    "priority",
    schemaModules.priority.generation,
    schemaModules.priority.tables,
    (db) => {
      migrateLegacyPriorities(db)
    },
  )
}
