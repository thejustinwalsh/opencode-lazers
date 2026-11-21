import type { Database } from "bun:sqlite"
import { newRefreshContext } from "./drain.ts"
import { refreshPlan, refreshReservations, refreshTask } from "./refresh.ts"

/**
 * Tasks folded per write transaction. A unit of work, not a cap: the loop pages until the project
 * is done. Measured 2.3 ms per task idle (442 tasks/s, `rate.test.ts`); generation 5 (detail,
 * advice, audit and search rows) measured 3.1 ms per task on a loaded machine (326 tasks/s, 3.4
 * ms before it on the same load), so a page of 15 holds the write lock for about 46 ms.
 */
export const BACKFILL_PAGE = 15

export function backfillState(db: Database, project: string) {
  db.query("INSERT OR IGNORE INTO task_schedule_state(project_directory) VALUES(?)").run(project)
  return db
    .query<{ ready: number; backfill_after: number }, [string]>(
      "SELECT ready,backfill_after FROM task_schedule_state WHERE project_directory=?",
    )
    .get(project)!
}

/**
 * One page of the backfill, in the caller's write transaction: tasks above the stored watermark,
 * folded by the same refresh code the drain runs. The watermark commits with the rows, so a restart
 * resumes at the next page. Returns whether the project is now complete.
 */
export function backfillPage(
  db: Database,
  project: string,
  page: number = BACKFILL_PAGE,
): { done: boolean; folded: number } {
  const state = backfillState(db, project)
  if (state.ready) return { done: true, folded: 0 }
  const ctx = newRefreshContext(db)
  const rows = db
    .query<
      { id: string; created_version: number; plan_id: string | null },
      [string, number, number]
    >(
      `SELECT t.id,t.created_version,
         (SELECT n.plan_id FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
           WHERE n.task_id=t.id AND p.project_directory=t.project_directory
           ORDER BY p.rowid DESC LIMIT 1) AS plan_id
       FROM tasks t WHERE t.project_directory=? AND t.created_version>?
       ORDER BY t.created_version LIMIT ?`,
    )
    .all(project, state.backfill_after, page)
  const planned = new Set<string>()
  for (const row of rows) {
    // A plan refresh covers its nodes; only tasks outside any plan need their own.
    if (!row.plan_id) refreshTask(db, ctx, row.id)
    else if (!planned.has(row.plan_id)) {
      planned.add(row.plan_id)
      refreshPlan(db, ctx, row.plan_id)
    }
  }
  const done = rows.length < page
  if (done) {
    // Plans with no task of this project's list yet still get their header row.
    for (const plan of db
      .query<{ id: string }, [string]>("SELECT id FROM runner_plans WHERE project_directory=?")
      .all(project))
      if (!planned.has(plan.id)) refreshPlan(db, ctx, plan.id)
    refreshReservations(db, ctx, project)
  }
  db.query("UPDATE task_schedule_state SET backfill_after=?,ready=? WHERE project_directory=?").run(
    rows.at(-1)?.created_version ?? state.backfill_after,
    done ? 1 : 0,
    project,
  )
  return { done, folded: rows.length }
}
