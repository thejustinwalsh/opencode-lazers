/**
 * Names and counters shared by the projection's write side (decision-projection.ts) and its read
 * side (observation-ledger-read.ts), kept apart so neither imports the other.
 */
export const DECISION_PROJECTION_TABLES = {
  facts: "model_decision_progress",
  state: "model_decision_progress_state",
  dirty: "model_decision_progress_dirty",
  tasks: "model_decision_task",
  taskDirty: "model_decision_task_dirty",
  /** Per project and session: the change clock value at which its facts last changed. */
  sessions: "model_decision_session",
} as const

/** Progress kinds a decision fact is built from. */
export const DECISION_PROGRESS_KINDS = ["step", "usage-snapshot"] as const

/** Counters for diagnostics and tests: what the folds and the reads touched. */
export const decisionProjectionStats = {
  /** Rows read from runner_progress by folds. */
  foldSourceRows: 0,
  /** Rows written to the projection by folds. */
  foldWrites: 0,
  /** Projected rows removed because their source row left the projection's kinds or the table. */
  foldRemovals: 0,
  /** Fold transactions committed. */
  foldPages: 0,
  /** Projected progress facts read by decision reads. */
  readProjectionRows: 0,
  /** runner_progress rows read (and parsed) by decision reads: the tail and the dirty rows. */
  readSourceRows: 0,
  /** Tasks derived from their source rows by folds. */
  foldTasks: 0,
  /** Stored task rows read by decision reads. */
  readStoredTasks: 0,
  /** Tasks decision reads derived from their source rows (queued or not yet folded). */
  readLiveTasks: 0,
  /** Sessions a decision read considered, and how each was served. */
  digestSessions: 0,
  digestHits: 0,
  digestBuilds: 0,
  /** Stored progress facts parsed to build digests. */
  digestFactsRead: 0,
  reset() {
    this.foldSourceRows = 0
    this.foldWrites = 0
    this.foldRemovals = 0
    this.foldPages = 0
    this.readProjectionRows = 0
    this.readSourceRows = 0
    this.foldTasks = 0
    this.readStoredTasks = 0
    this.readLiveTasks = 0
    this.digestSessions = 0
    this.digestHits = 0
    this.digestBuilds = 0
    this.digestFactsRead = 0
  },
}
