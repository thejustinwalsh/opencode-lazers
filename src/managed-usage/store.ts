import type { Database } from "bun:sqlite"
import { canonical, fingerprint } from "../identity.ts"
import type { TaskRepository } from "../storage.ts"
import {
  ManagedUsageAssociationSchema,
  ManagedUsageNativeFactSchema,
  type ManagedUsageAssociation,
  type ManagedUsageEnrollmentInput,
  type ManagedUsageNativeFact,
} from "./contract.ts"
import { insertManagedUsageCoverageGaps, insertManagedUsageGap } from "./capture-gaps.ts"
import {
  enrollManagedUsageBoundary,
  type ManagedUsageEnrollmentReceipt,
  type ManagedUsageEnrollmentResult,
} from "./enrollment.ts"
import type { ManagedUsageLocation } from "./native-location.ts"
import { managedUsageSchemaModule } from "./schema.ts"

export type { ManagedUsageEnrollmentResult } from "./enrollment.ts"

const MAX_SNAPSHOT_FACTS = 100_000
const MAX_SNAPSHOT_GAPS = 10_000

function hasColumn(db: Database, table: string, column: string) {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column)
}

export type ManagedUsageBoundary = {
  sessionID: string
  revision: number
  requestID: string
  boundarySequence: number
  excludedAssistantMessageID: string | null
  agent: string
  association: ManagedUsageAssociation
  nativeLocation: ManagedUsageLocation | null
  createdAt: number
}

export type ManagedUsageStoredFact = ManagedUsageNativeFact & {
  eventKey: string
  fingerprint: string
}

export type ManagedUsageSnapshot = {
  revision: number
  boundaries: ManagedUsageBoundary[]
  boundaryCount: number
  boundariesTruncated: boolean
  facts: ManagedUsageStoredFact[]
  factConflicts: ManagedUsageStoredFact[]
  factCount: number
  factConflictCount: number
  factsTruncated: boolean
  factConflictsTruncated: boolean
  listenerGaps: Array<{ sessionID: string; kind: string; recordedAt: number }>
  listenerGapCount: number
  gapsTruncated: boolean
  listenerGapCounts: Array<{ sessionID: string; count: number }>
  listenerGapCountsTruncated: boolean
}

type BoundaryRow = {
  session_id: string
  revision: number
  request_id: string
  boundary_sequence: number
  excluded_assistant_message_id: string | null
  managed_agent: string
  native_directory: string | null
  workspace_id: string | null
  association_kind: string
  plan_id: string | null
  task_id: string | null
  created_at: number
  request_fingerprint: string
  receipt_json: string
}

type FactRow = {
  session_id: string
  event_key: string
  fingerprint: string
  fact_json: string
}

function associationFromRow(row: BoundaryRow): ManagedUsageAssociation {
  return ManagedUsageAssociationSchema.parse(
    row.association_kind === "task"
      ? { kind: "task", planID: row.plan_id, taskID: row.task_id }
      : row.association_kind === "plan"
        ? { kind: "plan", planID: row.plan_id }
        : { kind: "unallocated" },
  )
}

function parseFact(row: FactRow): ManagedUsageStoredFact {
  return {
    ...ManagedUsageNativeFactSchema.parse(JSON.parse(row.fact_json)),
    eventKey: row.event_key,
    fingerprint: row.fingerprint,
  }
}

function factFingerprint(fact: ManagedUsageNativeFact) {
  const { recordedAt: _recordedAt, ...identity } = fact
  return fingerprint(identity)
}

function incrementRevision(db: Database, projectDirectory: string) {
  db.query("UPDATE managed_usage_meta SET revision=revision+1 WHERE project_directory=?").run(
    projectDirectory,
  )
}

function snapshotCounts(db: Database, projectDirectory: string) {
  const count = (table: string) =>
    db
      .query<{ count: number }, [string]>(
        `SELECT count(*) AS count FROM ${table} WHERE project_directory=?`,
      )
      .get(projectDirectory)?.count ?? 0
  return {
    revision:
      db
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM managed_usage_meta WHERE project_directory=?",
        )
        .get(projectDirectory)?.revision ?? 0,
    boundaryCount: count("managed_usage_boundaries"),
    factCount: count("managed_usage_facts"),
    factConflictCount: count("managed_usage_fact_conflicts"),
    listenerGapCount: count("managed_usage_capture_gaps"),
  }
}

function snapshotBoundaries(db: Database, projectDirectory: string) {
  return db
    .query<BoundaryRow, [string]>(
      `SELECT * FROM managed_usage_boundaries WHERE project_directory=?
       ORDER BY session_id,revision LIMIT 100_000`,
    )
    .all(projectDirectory)
    .map((row) => ({
      sessionID: row.session_id,
      revision: row.revision,
      requestID: row.request_id,
      boundarySequence: row.boundary_sequence,
      excludedAssistantMessageID: row.excluded_assistant_message_id,
      agent: row.managed_agent,
      association: associationFromRow(row),
      nativeLocation:
        row.native_directory === null
          ? null
          : { directory: row.native_directory, workspaceID: row.workspace_id },
      createdAt: row.created_at,
    }))
}

function snapshotFacts(db: Database, projectDirectory: string) {
  const rows = (table: string) =>
    db
      .query<FactRow, [string, number]>(
        `SELECT session_id,event_key,fingerprint,fact_json FROM ${table}
         WHERE project_directory=? ORDER BY id LIMIT ?`,
      )
      .all(projectDirectory, MAX_SNAPSHOT_FACTS + 1)
      .slice(0, MAX_SNAPSHOT_FACTS)
      .map(parseFact)
  return {
    facts: rows("managed_usage_facts"),
    factConflicts: rows("managed_usage_fact_conflicts"),
  }
}

function snapshotGaps(db: Database, projectDirectory: string) {
  const listenerGaps = db
    .query<{ session_id: string; kind: string; recorded_at: number }, [string, number]>(
      `SELECT session_id,kind,recorded_at FROM managed_usage_capture_gaps
       WHERE project_directory=? ORDER BY id LIMIT ?`,
    )
    .all(projectDirectory, MAX_SNAPSHOT_GAPS + 1)
    .slice(0, MAX_SNAPSHOT_GAPS)
    .map((row) => ({
      sessionID: row.session_id,
      kind: row.kind,
      recordedAt: row.recorded_at,
    }))
  const gapCounts = db
    .query<{ session_id: string; count: number }, [string, number]>(
      `SELECT session_id,count(*) AS count FROM managed_usage_capture_gaps
       WHERE project_directory=? GROUP BY session_id ORDER BY session_id LIMIT ?`,
    )
    .all(projectDirectory, 100_001)
  const listenerGapCounts = gapCounts
    .slice(0, 100_000)
    .map((row) => ({ sessionID: row.session_id, count: row.count }))
  return {
    listenerGaps,
    listenerGapCounts,
    listenerGapCountsTruncated: gapCounts.length > 100_000,
  }
}

function snapshotInDatabase(db: Database, projectDirectory: string): ManagedUsageSnapshot {
  const counts = snapshotCounts(db, projectDirectory)
  const boundaries = snapshotBoundaries(db, projectDirectory)
  const facts = snapshotFacts(db, projectDirectory)
  const gaps = snapshotGaps(db, projectDirectory)
  return {
    ...counts,
    ...facts,
    ...gaps,
    boundaries,
    boundariesTruncated: counts.boundaryCount > 100_000,
    factsTruncated: counts.factCount > MAX_SNAPSHOT_FACTS,
    factConflictsTruncated: counts.factConflictCount > MAX_SNAPSHOT_FACTS,
    gapsTruncated: counts.listenerGapCount > MAX_SNAPSHOT_GAPS,
    listenerGapCountsTruncated: gaps.listenerGapCountsTruncated,
  }
}

export class ManagedUsageStore {
  constructor(readonly repository: TaskRepository) {
    const tables = managedUsageSchemaModule.tables
    repository.installSchema("managed-usage", managedUsageSchemaModule.generation, tables, (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS managed_usage_meta (
            project_directory TEXT PRIMARY KEY,
            revision INTEGER NOT NULL CHECK(revision >= 0)
          );
          CREATE TABLE IF NOT EXISTS managed_usage_boundaries (
            project_directory TEXT NOT NULL,
            session_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0),
            request_id TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            boundary_sequence INTEGER NOT NULL CHECK(boundary_sequence >= -1),
            excluded_assistant_message_id TEXT,
            managed_agent TEXT NOT NULL,
            native_directory TEXT,
            workspace_id TEXT,
            association_kind TEXT NOT NULL CHECK(association_kind IN ('task','plan','unallocated')),
            plan_id TEXT,
            task_id TEXT,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(project_directory,session_id,revision),
            UNIQUE(project_directory,request_id),
            CHECK(
              (association_kind='task' AND plan_id IS NOT NULL AND task_id IS NOT NULL) OR
              (association_kind='plan' AND plan_id IS NOT NULL AND task_id IS NULL) OR
              (association_kind='unallocated' AND plan_id IS NULL AND task_id IS NULL)
            )
          );
          CREATE INDEX IF NOT EXISTS managed_usage_boundaries_session
            ON managed_usage_boundaries(project_directory,session_id,boundary_sequence,revision);
          CREATE TABLE IF NOT EXISTS managed_usage_facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_directory TEXT NOT NULL,
            session_id TEXT NOT NULL,
            event_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            fact_json TEXT NOT NULL,
            sequence INTEGER,
            recorded_at INTEGER NOT NULL,
            UNIQUE(project_directory,session_id,event_key)
          );
          CREATE INDEX IF NOT EXISTS managed_usage_facts_project
            ON managed_usage_facts(project_directory,id);
          CREATE TABLE IF NOT EXISTS managed_usage_fact_conflicts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_directory TEXT NOT NULL,
            session_id TEXT NOT NULL,
            event_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            fact_json TEXT NOT NULL,
            sequence INTEGER,
            recorded_at INTEGER NOT NULL,
            UNIQUE(project_directory,session_id,event_key,fingerprint)
          );
          CREATE TABLE IF NOT EXISTS managed_usage_capture_gaps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_directory TEXT NOT NULL,
            listener_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('listener-started','stream-failed','stream-ended','listener-stopped','authority-changed','observation-failed','unidentified-event','unsequenced-event','buffer-overflow')),
            native_directory TEXT,
            workspace_id TEXT,
            recorded_at INTEGER NOT NULL,
            UNIQUE(project_directory,listener_id,session_id,kind)
          );
          CREATE INDEX IF NOT EXISTS managed_usage_capture_gaps_project
            ON managed_usage_capture_gaps(project_directory,id);
          CREATE TRIGGER IF NOT EXISTS managed_usage_boundaries_no_update BEFORE UPDATE ON managed_usage_boundaries
          BEGIN SELECT RAISE(ABORT, 'Managed usage attribution boundaries are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS managed_usage_boundaries_no_delete BEFORE DELETE ON managed_usage_boundaries
          BEGIN SELECT RAISE(ABORT, 'Managed usage attribution boundaries are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS managed_usage_facts_no_update BEFORE UPDATE ON managed_usage_facts
          BEGIN SELECT RAISE(ABORT, 'Managed usage native facts are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS managed_usage_facts_no_delete BEFORE DELETE ON managed_usage_facts
          BEGIN SELECT RAISE(ABORT, 'Managed usage native facts are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS managed_usage_fact_conflicts_no_update BEFORE UPDATE ON managed_usage_fact_conflicts
          BEGIN SELECT RAISE(ABORT, 'Managed usage fact conflicts are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS managed_usage_fact_conflicts_no_delete BEFORE DELETE ON managed_usage_fact_conflicts
          BEGIN SELECT RAISE(ABORT, 'Managed usage fact conflicts are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS managed_usage_capture_gaps_no_update BEFORE UPDATE ON managed_usage_capture_gaps
          BEGIN SELECT RAISE(ABORT, 'Managed usage capture gaps are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS managed_usage_capture_gaps_no_delete BEFORE DELETE ON managed_usage_capture_gaps
          BEGIN SELECT RAISE(ABORT, 'Managed usage capture gaps are immutable'); END;
         `)
      if (!hasColumn(db, "managed_usage_boundaries", "excluded_assistant_message_id"))
        db.exec(
          "ALTER TABLE managed_usage_boundaries ADD COLUMN excluded_assistant_message_id TEXT",
        )
      if (!hasColumn(db, "managed_usage_boundaries", "native_directory"))
        db.exec("ALTER TABLE managed_usage_boundaries ADD COLUMN native_directory TEXT")
      if (!hasColumn(db, "managed_usage_boundaries", "workspace_id"))
        db.exec("ALTER TABLE managed_usage_boundaries ADD COLUMN workspace_id TEXT")
      if (!hasColumn(db, "managed_usage_facts", "sequence"))
        db.exec("ALTER TABLE managed_usage_facts ADD COLUMN sequence INTEGER")
      if (!hasColumn(db, "managed_usage_fact_conflicts", "sequence"))
        db.exec("ALTER TABLE managed_usage_fact_conflicts ADD COLUMN sequence INTEGER")
      if (!hasColumn(db, "managed_usage_capture_gaps", "native_directory"))
        db.exec("ALTER TABLE managed_usage_capture_gaps ADD COLUMN native_directory TEXT")
      if (!hasColumn(db, "managed_usage_capture_gaps", "workspace_id"))
        db.exec("ALTER TABLE managed_usage_capture_gaps ADD COLUMN workspace_id TEXT")
      db.exec(
        `CREATE INDEX IF NOT EXISTS managed_usage_boundaries_location
         ON managed_usage_boundaries(project_directory,native_directory,workspace_id,session_id)`,
      )
    })
    // The schema is shared by every project in this database, but the revision row is not.
    // Initialize it on every project-scoped store construction, not only on first migration.
    // Present on every start after the first, and then no write lock is taken.
    const present = repository.read((db) =>
      db
        .query("SELECT 1 FROM managed_usage_meta WHERE project_directory=?")
        .get(repository.projectDirectory),
    )
    if (!present)
      repository.atomic((db) => {
        db.query(
          "INSERT OR IGNORE INTO managed_usage_meta(project_directory,revision) VALUES(?,0)",
        ).run(repository.projectDirectory)
      })
  }

  currentRevision(): number {
    return this.repository.read(
      (db) =>
        db
          .query<{ revision: number }, [string]>(
            "SELECT revision FROM managed_usage_meta WHERE project_directory=?",
          )
          .get(this.repository.projectDirectory)?.revision ?? 0,
    )
  }

  sessionRevision(sessionID: string): number {
    return this.repository.read((db) => this.currentSessionRevision(db, sessionID))
  }

  latestSequence(sessionID: string): number {
    return this.repository.read((db) => {
      const row = db
        .query<{ sequence: number | null }, [string, string, string, string, string, string]>(
          `SELECT MAX(sequence) AS sequence FROM (
             SELECT sequence FROM managed_usage_facts
             WHERE project_directory=? AND session_id=?
             UNION ALL
             SELECT sequence FROM managed_usage_fact_conflicts
             WHERE project_directory=? AND session_id=?
             UNION ALL
             SELECT boundary_sequence AS sequence FROM managed_usage_boundaries
             WHERE project_directory=? AND session_id=?
           )`,
        )
        .get(
          this.repository.projectDirectory,
          sessionID,
          this.repository.projectDirectory,
          sessionID,
          this.repository.projectDirectory,
          sessionID,
        )
      return row?.sequence ?? -1
    })
  }

  hasEnrollment(sessionID: string): boolean {
    return this.repository.read((db) =>
      Boolean(
        db
          .query(
            "SELECT 1 FROM managed_usage_boundaries WHERE project_directory=? AND session_id=? LIMIT 1",
          )
          .get(this.repository.projectDirectory, sessionID),
      ),
    )
  }

  enrolledAgent(sessionID: string): string | undefined {
    return this.repository.read(
      (db) =>
        db
          .query<{ managed_agent: string }, [string, string]>(
            `SELECT managed_agent FROM managed_usage_boundaries
           WHERE project_directory=? AND session_id=? ORDER BY revision DESC LIMIT 1`,
          )
          .get(this.repository.projectDirectory, sessionID)?.managed_agent,
    )
  }

  isWorkerSession(sessionID: string): boolean {
    return this.repository.read((db) => {
      const hasAttempts = Boolean(
        db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_attempts'").get(),
      )
      const hasAttempt =
        hasAttempts &&
        Boolean(db.query("SELECT 1 FROM runner_attempts WHERE session_id=? LIMIT 1").get(sessionID))
      return hasAttempt
    })
  }

  validateAssociation(association: ManagedUsageAssociation): void {
    const parsed = ManagedUsageAssociationSchema.parse(association)
    if (parsed.kind === "unallocated") return
    this.repository.read((db) => {
      const planExists = db
        .query<{ present: number }, [string, string]>(
          "SELECT 1 AS present FROM runner_plans WHERE project_directory=? AND id=?",
        )
        .get(this.repository.projectDirectory, parsed.planID)
      if (!planExists) throw new Error("Managed usage plan scope is unavailable")
      if (parsed.kind === "task") {
        const taskExists = db
          .query<{ present: number }, [string, string]>(
            "SELECT 1 AS present FROM tasks WHERE project_directory=? AND id=?",
          )
          .get(this.repository.projectDirectory, parsed.taskID)
        const belongs = db
          .query<{ present: number }, [string, string, string]>(
            `SELECT 1 AS present FROM runner_nodes n
             JOIN runner_plans p ON p.id=n.plan_id
             WHERE p.project_directory=? AND p.id=? AND n.task_id=?`,
          )
          .get(this.repository.projectDirectory, parsed.planID, parsed.taskID)
        if (!taskExists || !belongs) throw new Error("Managed usage task scope is unavailable")
      }
    })
  }

  enroll(input: {
    request: ManagedUsageEnrollmentInput
    agent: string
    boundarySequence: number
    nativeLocation?: ManagedUsageLocation | null
    excludedAssistantMessageID?: string | null
  }): ManagedUsageEnrollmentResult {
    if (!Number.isSafeInteger(input.boundarySequence) || input.boundarySequence < -1)
      throw new Error("Managed usage enrollment boundary is unavailable")
    return this.repository.atomic((db) => {
      return enrollManagedUsageBoundary({
        db,
        projectDirectory: this.repository.projectDirectory,
        ...input,
        currentSessionRevision: (database, sessionID) =>
          this.currentSessionRevision(database, sessionID),
        validateAssociation: (database, association) =>
          this.validateAssociationInDatabase(database, association),
        incrementRevision,
      })
    })
  }

  findEnrollmentRequest(
    requestID: string,
    request: ManagedUsageEnrollmentInput,
  ): ManagedUsageEnrollmentResult | null {
    const expected = fingerprint(request)
    return this.repository.read((db) => {
      const existing = db
        .query<
          { request_fingerprint: string; receipt_json: string; session_id: string },
          [string, string]
        >(
          `SELECT request_fingerprint,receipt_json,session_id FROM managed_usage_boundaries
           WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, requestID)
      if (!existing) return null
      const currentRevision = this.currentSessionRevision(db, request.sessionID)
      if (existing.request_fingerprint !== expected)
        return {
          status: "conflict" as const,
          reason: "request-id-reused" as const,
          expectedRevision: request.expectedRevision,
          currentRevision,
        }
      return JSON.parse(existing.receipt_json) as ManagedUsageEnrollmentReceipt
    })
  }

  appendFact(fact: ManagedUsageNativeFact): "recorded" | "duplicate" | "conflict" | "un-enrolled" {
    const parsed = ManagedUsageNativeFactSchema.parse(fact)
    const json = canonical(parsed)
    const valueFingerprint = factFingerprint(parsed)
    return this.repository.atomic((db) => {
      const enrolled = db
        .query(
          "SELECT 1 FROM managed_usage_boundaries WHERE project_directory=? AND session_id=? LIMIT 1",
        )
        .get(this.repository.projectDirectory, parsed.sessionID)
      if (!enrolled) return "un-enrolled"
      db.query(
        `INSERT OR IGNORE INTO managed_usage_facts(
          project_directory,session_id,event_key,fingerprint,fact_json,sequence,recorded_at
        ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        parsed.sessionID,
        parsed.eventKey,
        valueFingerprint,
        json,
        parsed.sequence,
        parsed.recordedAt,
      )
      const existing = db
        .query<{ fingerprint: string }, [string, string, string]>(
          `SELECT fingerprint FROM managed_usage_facts
           WHERE project_directory=? AND session_id=? AND event_key=?`,
        )
        .get(this.repository.projectDirectory, parsed.sessionID, parsed.eventKey)
      if (existing?.fingerprint === valueFingerprint) {
        const changed = db.query("SELECT changes() AS count").get() as { count: number }
        if (changed.count > 0) {
          incrementRevision(db, this.repository.projectDirectory)
          return "recorded"
        }
        return "duplicate"
      }
      db.query(
        `INSERT OR IGNORE INTO managed_usage_fact_conflicts(
          project_directory,session_id,event_key,fingerprint,fact_json,sequence,recorded_at
        ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        parsed.sessionID,
        parsed.eventKey,
        valueFingerprint,
        json,
        parsed.sequence,
        parsed.recordedAt,
      )
      const conflict = db.query("SELECT changes() AS count").get() as { count: number }
      if (conflict.count > 0) {
        incrementRevision(db, this.repository.projectDirectory)
        return "conflict"
      }
      return "duplicate"
    })
  }

  recordGap(input: {
    listenerID: string
    sessionID: string
    kind: string
    nativeLocation?: ManagedUsageLocation | null
    recordedAt?: number
  }) {
    return this.repository.atomic((db) => {
      const changed = insertManagedUsageGap(db, this.repository.projectDirectory, input)
      if (changed) incrementRevision(db, this.repository.projectDirectory)
      return changed
    })
  }

  recordGapForAll(input: { listenerID: string; kind: string; recordedAt?: number }) {
    return this.repository.atomic((db) => {
      const changedCount = insertManagedUsageCoverageGaps(db, this.repository.projectDirectory, {
        ...input,
        scope: { kind: "project" },
      })
      if (changedCount > 0) incrementRevision(db, this.repository.projectDirectory)
      return changedCount
    })
  }

  recordGapForLocation(input: {
    listenerID: string
    nativeLocation: ManagedUsageLocation
    kind: string
    recordedAt?: number
  }) {
    return this.repository.atomic((db) => {
      const changedCount = insertManagedUsageCoverageGaps(db, this.repository.projectDirectory, {
        ...input,
        scope: { kind: "location", nativeLocation: input.nativeLocation },
      })
      if (changedCount > 0) incrementRevision(db, this.repository.projectDirectory)
      return changedCount
    })
  }

  snapshot(): ManagedUsageSnapshot {
    return this.repository.read((db) =>
      db.transaction(() => snapshotInDatabase(db, this.repository.projectDirectory)).deferred(),
    )
  }

  private currentSessionRevision(db: Database, sessionID: string): number {
    return (
      db
        .query<{ revision: number }, [string, string]>(
          `SELECT revision FROM managed_usage_boundaries
           WHERE project_directory=? AND session_id=? ORDER BY revision DESC LIMIT 1`,
        )
        .get(this.repository.projectDirectory, sessionID)?.revision ?? 0
    )
  }

  private validateAssociationInDatabase(db: Database, association: ManagedUsageAssociation) {
    const parsed = ManagedUsageAssociationSchema.parse(association)
    if (parsed.kind === "unallocated") return
    const plan = db
      .query("SELECT 1 FROM runner_plans WHERE project_directory=? AND id=?")
      .get(this.repository.projectDirectory, parsed.planID)
    if (!plan) throw new Error("Managed usage plan scope is unavailable")
    if (parsed.kind === "task") {
      const task = db
        .query("SELECT 1 FROM tasks WHERE project_directory=? AND id=?")
        .get(this.repository.projectDirectory, parsed.taskID)
      const member = db
        .query(
          `SELECT 1 FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
           WHERE p.project_directory=? AND p.id=? AND n.task_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.planID, parsed.taskID)
      if (!task || !member) throw new Error("Managed usage task scope is unavailable")
    }
  }
}
