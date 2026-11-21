import type { Database } from "bun:sqlite"
import { BUCKETS, type Bucket } from "./buckets.ts"

/**
 * Reads of the stored task list that are not a window of it: a flag, a handful of counters and
 * one bucket's rows. Each is an indexed range on `task_schedule` or a primary-key read of a
 * counter row, so none loads the list. They return `undefined` while the project is not indexed
 * (the owner has not finished its backfill, or the projection is not installed in this database):
 * the stored list is then unknown, and callers say so instead of showing zero.
 */

/** Whether this project's list is indexed. */
export function scheduleReady(db: Database, project: string): boolean {
  try {
    return (
      db
        .query<{ ready: number }, [string]>(
          "SELECT ready FROM task_schedule_state WHERE project_directory=?",
        )
        .get(project)?.ready === 1
    )
  } catch {
    return false
  }
}

/** Tasks per bucket of one project, retired tasks excluded (at most one row per bucket). */
function storedBucketCounts(db: Database, project: string): Record<Bucket, number> | undefined {
  if (!scheduleReady(db, project)) return undefined
  const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as Record<Bucket, number>
  for (const row of db
    .query<{ bucket: Bucket; n: number }, [string]>(
      "SELECT bucket,n FROM task_schedule_counts WHERE project_directory=?",
    )
    .all(project))
    counts[row.bucket] = row.n
  return counts
}

type Head = { task_id: string; reference: string; title: string; seq: number }

/** Tasks waiting on the owner: their own node or plan is Blocked (`owner_hold`, partial index). */
function holdCount(db: Database, project: string) {
  return db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM task_schedule WHERE project_directory=? AND retired=0 AND owner_hold=1",
    )
    .get(project)!.n
}

/**
 * Queued tasks as the old Queued filter counted them: the stored Queued bucket plus the queued
 * tasks held back by a reservation, a prerequisite plan or an adoption, which show Blocked but
 * wait on no owner.
 */
function heldQueued(db: Database, project: string) {
  return db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM task_schedule WHERE project_directory=? AND retired=0
        AND bucket='blocked' AND owner_hold=0 AND node_state='queued'`,
    )
    .get(project)!.n
}

/** The Radar workload: queued, needs-you (owner holds) and failed, from stored counters. */
export function storedWorkload(db: Database, project: string) {
  const counts = storedBucketCounts(db, project)
  if (!counts) return undefined
  return {
    queued: counts.queued + heldQueued(db, project),
    needsYou: holdCount(db, project),
    failed: counts.failed,
  }
}

/** The newest `limit` tasks behind one Radar group, and how many the group holds. */
export function storedGroupHead(
  db: Database,
  project: string,
  group: "needs-you" | "failed" | "queued",
  limit: number,
) {
  const workload = storedWorkload(db, project)
  if (!workload) return undefined
  const head = (where: string) =>
    db
      .query<Head, [string, number]>(
        `SELECT task_id,reference,title,seq FROM task_schedule
          WHERE project_directory=? AND retired=0 AND ${where} ORDER BY seq DESC LIMIT ?`,
      )
      .all(project, limit)
  const rows =
    group === "needs-you"
      ? head("owner_hold=1")
      : group === "failed"
        ? head("bucket='failed'")
        : [
            ...head("bucket='queued'"),
            ...head("bucket='blocked' AND owner_hold=0 AND node_state='queued'"),
          ]
            .toSorted((a, b) => b.seq - a.seq)
            .slice(0, limit)
  return {
    total:
      group === "needs-you"
        ? workload.needsYou
        : group === "failed"
          ? workload.failed
          : workload.queued,
    rows,
  }
}

/** Every owner hold of one project, newest first. */
export function storedOwnerHolds(db: Database, project: string) {
  if (!scheduleReady(db, project)) return undefined
  return db
    .query<
      {
        task_id: string
        title: string
        reference: string
        reason: string | null
        created_at: string
      },
      [string]
    >(
      `SELECT task_id,title,reference,node_reason AS reason,created_at FROM task_schedule
        WHERE project_directory=? AND retired=0 AND owner_hold=1 ORDER BY seq DESC`,
    )
    .all(project)
}
