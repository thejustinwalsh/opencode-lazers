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
export function storedBucketCounts(
  db: Database,
  project: string,
): Record<Bucket, number> | undefined {
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

/** The first `limit` tasks of one bucket in schedule order, and how many the bucket holds. */
export function storedBucketHead(db: Database, project: string, bucket: Bucket, limit: number) {
  const counts = storedBucketCounts(db, project)
  if (!counts) return undefined
  return {
    total: counts[bucket],
    rows: db
      .query<{ task_id: string; reference: string; title: string }, [string, string, number]>(
        `SELECT task_id,reference,title FROM task_schedule
          WHERE project_directory=? AND retired=0 AND bucket=? ORDER BY sort_key,task_id LIMIT ?`,
      )
      .all(project, bucket, limit),
  }
}
