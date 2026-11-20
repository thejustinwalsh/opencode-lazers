import { DECISION_PROJECTION_TABLES } from "./decision-projection-tables.ts"

// Decision reads keep only retained usage measurements and route-bearing step
// observations. The SQL projection is intentionally separate from the public ledger's
// richer progress view. The batch size is a unit of work, not a ceiling: the reader
// keeps paging by sequence until the table is exhausted. 512 is not measured;
// changing it changes only how many queries a read makes.
export const DECISION_PROGRESS_BATCH_SIZE = 512

// F-S10-3: sequence pagination must seek the rowid, not re-sort the project's
// dedupe index on every page. The payload is projected in JS, not in SQL: building the same
// objects with json_object/json_each cost about a second on the live 111k-row table and was
// parsed again here; a plain JSON.parse of the stored text takes a fraction of that.
export const LIVE_PROGRESS_COLUMNS =
  "r.seq,r.attempt_id,r.session_id,r.at,r.recorded_at,r.source,r.sources_json,r.kind," +
  "r.event_ids_json,r.message_id,r.payload"
export const LIVE_PROGRESS_JOIN = `
  JOIN runner_plans p ON p.id=r.plan_id
  JOIN tasks t ON t.id=r.task_id AND t.project_directory=p.project_directory`
export const LIVE_TAIL_SQL = `
  SELECT ${LIVE_PROGRESS_COLUMNS}
  FROM runner_progress r NOT INDEXED ${LIVE_PROGRESS_JOIN}
  WHERE r.project_directory=? AND p.project_directory=? AND r.seq>?
    AND r.kind IN ('step','usage-snapshot')
  ORDER BY r.seq LIMIT ?`
export const LIVE_ONE_SQL = `
  SELECT ${LIVE_PROGRESS_COLUMNS}
  FROM runner_progress r ${LIVE_PROGRESS_JOIN}
  WHERE r.seq=? AND r.project_directory=? AND p.project_directory=?
    AND r.kind IN ('step','usage-snapshot')`
export const STORED_PROGRESS_SQL = `
  SELECT f.seq,f.flags,f.fact
  FROM ${DECISION_PROJECTION_TABLES.facts} f
  JOIN runner_plans p ON p.id=f.plan_id
  JOIN tasks t ON t.id=f.task_id AND t.project_directory=p.project_directory
  WHERE f.project_directory=? AND p.project_directory=? AND f.seq>? AND f.seq<=?
  ORDER BY f.seq LIMIT ?`
