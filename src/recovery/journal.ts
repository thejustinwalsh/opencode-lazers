import type { Database } from "bun:sqlite"
import type { TaskRepository } from "../storage.ts"
import { schemaModules } from "../database-schema.ts"

const MAX_PAGE_SIZE = 250

/**
 * Newest facts kept per project. The only production reader is the live radar diagnostic
 * (`LIVE_LIMITS.journalFacts` = 257 newest rows of a project in src/observability/live-store.ts:745);
 * it discards facts whose progress row it already loaded, so older facts add nothing. Four times
 * that limit leaves margin for concurrent writers between the reader's snapshot and its hydration.
 */
export const RECOVERY_FACT_WINDOW = 1024

/**
 * Oldest facts removed per progress write. Steady state removes one row per write (the one that
 * fell out of the window); the cap only bounds the one-time backlog on a database that grew
 * without a window (469 k rows live), which drains at 64 rows per write instead of stalling a
 * write transaction on a bulk delete. The retention kind `recovery-fact-window` clears it in bulk.
 */
const PRUNE_BATCH = 64

/** Marks triggers that prune; install replaces triggers without it. */
const WINDOW_MARKER = "recovery-fact-window"

/**
 * Facts beyond the window are dead unless a registered consumer has not reached them yet
 * (`pageIn`/`advanceIn` stay exact for any consumer that exists).
 */
const PRUNE_FACTS = `
        /* ${WINDOW_MARKER} */
        DELETE FROM recovery_progress_facts WHERE change_id IN (
          SELECT change_id FROM recovery_progress_facts
           WHERE project_directory=NEW.project_directory
             AND change_id <= COALESCE((SELECT change_id FROM recovery_progress_facts
                                         WHERE project_directory=NEW.project_directory
                                         ORDER BY change_id DESC LIMIT 1 OFFSET ${RECOVERY_FACT_WINDOW}), 0)
             AND change_id <= COALESCE((SELECT MIN(change_id) FROM recovery_progress_consumers
                                         WHERE project_directory=NEW.project_directory), 9007199254740991)
           ORDER BY change_id LIMIT ${PRUNE_BATCH});`
const STATUS_VALUES = [
  "completed",
  "ended",
  "error",
  "exited",
  "failed",
  "killed",
  "not-executed",
  "running",
  "started",
  "succeeded",
  "timeout",
] as const
const SOURCE_VALUES = [
  "tool-commentary",
  "tool-hook",
  "native-event",
  "runtime",
  "recovery",
  "reminder",
] as const
const KIND_VALUES = [
  "commentary",
  "tool",
  "visible-text",
  "step",
  "usage-snapshot",
  "provider-retry",
  "execution-outcome",
  "outcome-snapshot",
  "shell",
  "verification",
  "artifact",
  "gap",
  "reminder",
] as const

const progressColumns = [
  "project_directory",
  "project_id",
  "plan_id",
  "task_id",
  "attempt_id",
  "session_id",
  "at",
  "source",
  "sources_json",
  "kind",
  "event_ids_json",
  "call_id",
  "message_id",
  "dedupe_key",
  "payload",
] as const

export type RecoveryCoverage = {
  projectDirectory: string
  kind: "legacy-or-unavailable"
  source: "runner_progress"
  /** Cursor boundary for new consumers; zero preserves any already-captured facts. */
  afterChangeID: number
  /** Highest existing source sequence observed; captured journal facts remain eligible. */
  sourceSequence: number
  reason: string
}

export type RecoveryFact = {
  changeID: number
  projectDirectory: string
  projectID: string
  planID: string
  taskID: string
  attemptID: string
  sessionID: string
  sourceSequence: number
  sourceAt: number
  changeKind: "inserted" | "modified"
  sourceKind: string
  source: string
  previousStatus: string | null
  status: string | null
  changedFields: string[]
}

export type RecoveryPage = {
  projectDirectory: string
  consumerID: string
  fromChangeID: number
  throughChangeID: number
  limit: number
  hasMore: boolean
  coverage: RecoveryCoverage
  facts: RecoveryFact[]
  metrics: {
    pageCount: number
    /** UTF-8 bytes in the returned facts' JSON, not SQLite bytes or total I/O. */
    serializedBytesRead: number
    /** Source progress payloads selected; page reads do not select those payloads. */
    sourcePayloadsRead: number
  }
}

type CoverageRow = {
  project_directory: string
  coverage_kind: "legacy-or-unavailable"
  source: "runner_progress"
  after_change_id: number
  source_sequence: number
  reason: string
}

type FactRow = {
  change_id: number
  project_directory: string
  project_id: string
  plan_id: string
  task_id: string
  attempt_id: string
  session_id: string
  source_seq: number
  source_at: number
  change_kind: "inserted" | "modified"
  source_kind: string
  source: string
  previous_status: string | null
  status: string | null
  changed_fields: string
}

function statusExpression(alias: "NEW" | "OLD") {
  const statusList = STATUS_VALUES.map((status) => `'${status}'`).join(",")
  return `CASE WHEN json_valid(${alias}.payload) THEN
    CASE WHEN json_extract(${alias}.payload,'$.status') IN (${statusList})
      THEN json_extract(${alias}.payload,'$.status') ELSE NULL END
    ELSE NULL END`
}

function safeColumnExpression(
  alias: "NEW" | "OLD",
  column: "source" | "kind",
  values: readonly string[],
) {
  const allowlist = values.map((value) => `'${value}'`).join(",")
  return `CASE WHEN ${alias}.${column} IN (${allowlist}) THEN ${alias}.${column} ELSE 'unknown' END`
}

function changedFieldsExpression() {
  return `rtrim(${progressColumns
    .map((column) => `(CASE WHEN OLD.${column} IS NOT NEW.${column} THEN '${column},' ELSE '' END)`)
    .join(" || ")}, ',')`
}

function validateConsumerID(consumerID: string) {
  if (typeof consumerID !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(consumerID))
    throw new Error("Recovery journal consumer ID must be 1–120 safe ASCII characters")
}

function validatePageSize(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
    throw new Error(`Recovery journal page size must be an integer from 1 to ${MAX_PAGE_SIZE}`)
}

function coverageFromRow(row: CoverageRow): RecoveryCoverage {
  return {
    projectDirectory: row.project_directory,
    kind: row.coverage_kind,
    source: row.source,
    afterChangeID: row.after_change_id,
    sourceSequence: row.source_sequence,
    reason: row.reason,
  }
}

function factFromRow(row: FactRow): RecoveryFact {
  return {
    changeID: row.change_id,
    projectDirectory: row.project_directory,
    projectID: row.project_id,
    planID: row.plan_id,
    taskID: row.task_id,
    attemptID: row.attempt_id,
    sessionID: row.session_id,
    sourceSequence: row.source_seq,
    sourceAt: row.source_at,
    changeKind: row.change_kind,
    sourceKind: row.source_kind,
    source: row.source,
    previousStatus: row.previous_status,
    status: row.status,
    changedFields: row.changed_fields ? row.changed_fields.split(",") : [],
  }
}

function sameFact(left: RecoveryFact, right: RecoveryFact): boolean {
  return (
    left.changeID === right.changeID &&
    left.projectDirectory === right.projectDirectory &&
    left.projectID === right.projectID &&
    left.planID === right.planID &&
    left.taskID === right.taskID &&
    left.attemptID === right.attemptID &&
    left.sessionID === right.sessionID &&
    left.sourceSequence === right.sourceSequence &&
    left.sourceAt === right.sourceAt &&
    left.changeKind === right.changeKind &&
    left.sourceKind === right.sourceKind &&
    left.source === right.source &&
    left.previousStatus === right.previousStatus &&
    left.status === right.status &&
    Array.isArray(right.changedFields) &&
    left.changedFields.length === right.changedFields.length &&
    left.changedFields.every((field, index) => field === right.changedFields[index])
  )
}

function sameCoverage(left: RecoveryCoverage, right: RecoveryCoverage): boolean {
  return (
    left.projectDirectory === right.projectDirectory &&
    left.kind === right.kind &&
    left.source === right.source &&
    left.afterChangeID === right.afterChangeID &&
    left.sourceSequence === right.sourceSequence &&
    left.reason === right.reason
  )
}

/**
 * A transactional, privacy-minimal journal over progress rows that SQLite
 * actually inserts or materially updates. Deliveries discarded before a source
 * write (including ignored duplicate inserts) cannot become journal facts.
 * Captured facts roll back with their source write; page consumers advance only
 * after the returned facts are rechecked against storage in the caller's
 * transaction as their result.
 */
export class RecoveryJournal {
  constructor(readonly repository: TaskRepository) {
    // The install is idempotent and runs for every store, so a plugin reload upgrades it as well.
    repository.atomic((db) => this.install(db))
    const module = schemaModules["recovery-progress"]
    repository.installSchema("recovery-progress", module.generation, module.tables, () => {})
  }

  private install(db: Database) {
    const sourceTable = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get("runner_progress")
    if (!sourceTable)
      throw new Error("RecoveryJournal requires RunnerStore to initialize runner_progress")

    const columns = new Set(
      db
        .query<{ name: string }, []>("PRAGMA table_info(runner_progress)")
        .all()
        .map((column) => column.name),
    )
    for (const column of progressColumns)
      if (!columns.has(column))
        throw new Error(`RecoveryJournal requires runner_progress.${column}`)

    db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_progress_facts (
        change_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_directory TEXT NOT NULL,
        project_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        source_at INTEGER NOT NULL,
        change_kind TEXT NOT NULL CHECK(change_kind IN ('inserted','modified')),
        source_kind TEXT NOT NULL,
        source TEXT NOT NULL,
        previous_status TEXT,
        status TEXT,
        changed_fields TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recovery_progress_facts_project_cursor
        ON recovery_progress_facts(project_directory,change_id);
      CREATE INDEX IF NOT EXISTS recovery_progress_facts_project_source
        ON recovery_progress_facts(project_directory,source_seq,change_id);
      CREATE TABLE IF NOT EXISTS recovery_progress_coverage (
        project_directory TEXT PRIMARY KEY,
        coverage_kind TEXT NOT NULL CHECK(coverage_kind='legacy-or-unavailable'),
        source TEXT NOT NULL CHECK(source='runner_progress'),
        after_change_id INTEGER NOT NULL,
        source_sequence INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_progress_consumers (
        project_directory TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        change_id INTEGER NOT NULL,
        PRIMARY KEY(project_directory,consumer_id)
      );
    `)

    const insert = (kind: "inserted" | "modified", previousStatus: string, fields: string) => `
      INSERT INTO recovery_progress_facts (
        project_directory,project_id,plan_id,task_id,attempt_id,session_id,
        source_seq,source_at,change_kind,source_kind,source,previous_status,status,changed_fields
      ) VALUES (
        NEW.project_directory,NEW.project_id,NEW.plan_id,NEW.task_id,NEW.attempt_id,NEW.session_id,
        NEW.seq,NEW.at,${kind === "inserted" ? "'inserted'" : "'modified'"},
        ${safeColumnExpression("NEW", "kind", KIND_VALUES)},
        ${safeColumnExpression("NEW", "source", SOURCE_VALUES)},
        ${previousStatus},${statusExpression("NEW")},${fields}
      );`

    // A trigger created before the window existed has no pruning; replace it once.
    const triggers = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('recovery_progress_inserted','recovery_progress_modified')",
      )
      .all()
    if (triggers.length !== 2 || triggers.some((trigger) => !trigger.sql.includes(WINDOW_MARKER)))
      db.exec(`
      DROP TRIGGER IF EXISTS recovery_progress_inserted;
      DROP TRIGGER IF EXISTS recovery_progress_modified;
      CREATE TRIGGER recovery_progress_inserted
      AFTER INSERT ON runner_progress
      BEGIN
        ${insert("inserted", "NULL", "'insert'")}
        ${PRUNE_FACTS}
      END;
      CREATE TRIGGER recovery_progress_modified
      AFTER UPDATE ON runner_progress
      WHEN ${progressColumns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}
      BEGIN
        ${insert("modified", statusExpression("OLD"), changedFieldsExpression())}
        ${PRUNE_FACTS}
      END;
    `)

    const coverage = db
      .query<{ project_directory: string }, [string]>(
        "SELECT project_directory FROM recovery_progress_coverage WHERE project_directory=?",
      )
      .get(this.repository.projectDirectory)
    if (!coverage) {
      const maxSourceSequence = db
        .query<{ value: number }, [string]>(
          "SELECT COALESCE(MAX(seq),0) AS value FROM runner_progress WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory)!.value
      db.query(
        `INSERT INTO recovery_progress_coverage
          (project_directory,coverage_kind,source,after_change_id,source_sequence,reason)
         VALUES(?,'legacy-or-unavailable','runner_progress',?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        0,
        maxSourceSequence,
        "Legacy progress rows without captured facts have unavailable history and are not reconstructed; facts captured before this project's initialization remain eligible.",
      )
    }
  }

  coverage(): RecoveryCoverage {
    return this.repository.atomic((db) => this.coverageIn(db))
  }

  private coverageIn(db: Database): RecoveryCoverage {
    const row = db
      .query<CoverageRow, [string]>(
        `SELECT project_directory,coverage_kind,source,after_change_id,source_sequence,reason
         FROM recovery_progress_coverage WHERE project_directory=?`,
      )
      .get(this.repository.projectDirectory)
    if (!row) throw new Error("Recovery journal coverage boundary is missing")
    return coverageFromRow(row)
  }

  /** Read one bounded page inside an existing caller transaction. */
  pageIn(db: Database, consumerID: string, limit = 100): RecoveryPage {
    validateConsumerID(consumerID)
    validatePageSize(limit)
    const projectDirectory = this.repository.projectDirectory
    const coverage = this.coverageIn(db)
    db.query(
      `INSERT OR IGNORE INTO recovery_progress_consumers(project_directory,consumer_id,change_id)
       VALUES(?,?,?)`,
    ).run(projectDirectory, consumerID, coverage.afterChangeID)

    const cursor = db
      .query<{ change_id: number }, [string, string]>(
        `SELECT change_id FROM recovery_progress_consumers
         WHERE project_directory=? AND consumer_id=?`,
      )
      .get(projectDirectory, consumerID)!
    const rows = db
      .query<FactRow, [string, number, number]>(
        `SELECT change_id,project_directory,project_id,plan_id,task_id,attempt_id,session_id,
                source_seq,source_at,change_kind,source_kind,source,previous_status,status,changed_fields
         FROM recovery_progress_facts
         WHERE project_directory=? AND change_id>? ORDER BY change_id LIMIT ?`,
      )
      .all(projectDirectory, cursor.change_id, limit)
    const facts = rows.map(factFromRow)
    const throughChangeID = facts.at(-1)?.changeID ?? cursor.change_id
    const serializedBytesRead = facts.length
      ? new TextEncoder().encode(JSON.stringify(facts)).byteLength
      : 0
    const more = db
      .query<{ found: number }, [string, number]>(
        `SELECT 1 AS found FROM recovery_progress_facts
         WHERE project_directory=? AND change_id>? LIMIT 1`,
      )
      .get(projectDirectory, throughChangeID)

    return {
      projectDirectory,
      consumerID,
      fromChangeID: cursor.change_id,
      throughChangeID,
      limit,
      hasMore: more !== null,
      coverage,
      facts,
      metrics: { pageCount: 1, serializedBytesRead, sourcePayloadsRead: 0 },
    }
  }

  /** Read a page in its own transaction; use pageIn when a caller owns a transaction. */
  page(consumerID: string, limit = 100): RecoveryPage {
    return this.repository.atomic((db) => this.pageIn(db, consumerID, limit))
  }

  /**
   * Advance only a page whose cursor, ordered facts, and boundaries still match
   * storage. A stale, foreign, or tampered page is rejected rather than
   * skipping or misrepresenting durable facts.
   */
  advanceIn(db: Database, page: RecoveryPage): void {
    if (!page || typeof page !== "object") throw new Error("Invalid recovery journal page")
    if (page.projectDirectory !== this.repository.projectDirectory)
      throw new Error("Recovery journal page belongs to a different project")
    validateConsumerID(page.consumerID)
    validatePageSize(page.limit)
    if (
      !Number.isSafeInteger(page.fromChangeID) ||
      page.fromChangeID < 0 ||
      !Number.isSafeInteger(page.throughChangeID) ||
      page.throughChangeID < 0
    )
      throw new Error("Recovery journal page has an invalid cursor boundary")
    if (!Array.isArray(page.facts) || page.facts.length > page.limit)
      throw new Error("Recovery journal page exceeds its declared bound")
    const cursor = db
      .query<{ change_id: number }, [string, string]>(
        `SELECT change_id FROM recovery_progress_consumers
         WHERE project_directory=? AND consumer_id=?`,
      )
      .get(page.projectDirectory, page.consumerID)
    if (!cursor || cursor.change_id !== page.fromChangeID)
      throw new Error("Stale recovery journal cursor")

    const coverage = this.coverageIn(db)
    if (!page.coverage || !sameCoverage(page.coverage, coverage))
      throw new Error("Recovery journal page coverage does not match storage")

    const rows = db
      .query<FactRow, [string, number, number, number]>(
        `SELECT change_id,project_directory,project_id,plan_id,task_id,attempt_id,session_id,
                source_seq,source_at,change_kind,source_kind,source,previous_status,status,changed_fields
         FROM recovery_progress_facts
         WHERE project_directory=? AND change_id>? AND change_id<=? ORDER BY change_id LIMIT ?`,
      )
      .all(page.projectDirectory, page.fromChangeID, page.throughChangeID, page.limit)
    const expectedFacts = rows.map(factFromRow)
    if (
      page.facts.length !== expectedFacts.length ||
      expectedFacts.some((fact, index) => !page.facts[index] || !sameFact(fact, page.facts[index]!))
    )
      throw new Error("Recovery journal page does not match the stored ordered facts")

    const expectedThrough = expectedFacts.at(-1)?.changeID ?? cursor.change_id
    if (page.throughChangeID !== expectedThrough)
      throw new Error("Recovery journal page has an invalid advancement boundary")

    const expectedBytes = expectedFacts.length
      ? new TextEncoder().encode(JSON.stringify(expectedFacts)).byteLength
      : 0
    // Continuation describes the capture, not facts appended after that boundary.
    if (typeof page.hasMore !== "boolean")
      throw new Error("Recovery journal page has an invalid continuation boundary")
    if (
      !page.metrics ||
      page.metrics.pageCount !== 1 ||
      page.metrics.serializedBytesRead !== expectedBytes ||
      page.metrics.sourcePayloadsRead !== 0
    )
      throw new Error("Recovery journal page metrics do not match the returned facts")
    if (!expectedFacts.length) return

    const result = db
      .query(
        `UPDATE recovery_progress_consumers SET change_id=?
         WHERE project_directory=? AND consumer_id=? AND change_id=?`,
      )
      .run(page.throughChangeID, page.projectDirectory, page.consumerID, page.fromChangeID)
    if (result.changes !== 1) throw new Error("Stale recovery journal cursor")
  }

  advance(page: RecoveryPage): void {
    this.repository.atomic((db) => this.advanceIn(db, page))
  }
}
