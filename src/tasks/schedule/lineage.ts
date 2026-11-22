import type { Database } from "bun:sqlite"

/**
 * Architect renewal lineages. A renewal hands a session's plans to a successor session; a chain of
 * renewals is one lineage, keyed by its first session. Every session of a lineage reads what the
 * lineage owns, archived predecessors included, through one indexed read of the key
 * (`lineageKeySQL`) instead of a link row per session (a live chain is 147 sessions long).
 *
 * ```
 *   root ──renewal──► s1 ──renewal──► s2 (owner now)
 *   task_schedule_lineage: s1→root, s2→root    link rows: lineage_key = root
 * ```
 */

/** The lineage key of a session: its root, or the session itself. */
export function lineageKeyOf(db: Database, sessionID: string): string {
  return (
    db
      .query<{ root: string }, [string]>(
        "SELECT root_session_id AS root FROM task_schedule_lineage WHERE session_id=?",
      )
      .get(sessionID)?.root ?? sessionID
  )
}

/** SQL for the lineage key of the session bound twice after it (`?, ?`). */
export const LINEAGE_KEY_SQL =
  "COALESCE((SELECT root_session_id FROM task_schedule_lineage WHERE session_id=?), ?)"

/**
 * Join one renewal's successor to the previous session's lineage, and re-key what already named
 * the successor as a root (its own successors, its link rows). Order-independent and idempotent:
 * renewals may arrive in any order.
 */
export function refreshLineage(db: Database, renewalID: string) {
  const renewal = db
    .query<{ previous: string; successor: string }, [string]>(
      `SELECT previous_session_id AS previous, successor_session_id AS successor
       FROM runner_architect_renewals WHERE id=?`,
    )
    .get(renewalID)
  if (!renewal || renewal.previous === renewal.successor) return
  const root = lineageKeyOf(db, renewal.previous)
  // A cycle would make the successor its own ancestor; keep the first lineage it joined.
  if (root === renewal.successor) return
  db.query(
    "INSERT INTO task_schedule_lineage(session_id,root_session_id) VALUES(?,?) ON CONFLICT(session_id) DO NOTHING",
  ).run(renewal.successor, root)
  const key = lineageKeyOf(db, renewal.successor)
  db.query("UPDATE task_schedule_lineage SET root_session_id=? WHERE root_session_id=?").run(
    key,
    renewal.successor,
  )
  db.query("UPDATE task_schedule_sessions SET lineage_key=? WHERE lineage_key=?").run(
    key,
    renewal.successor,
  )
}
