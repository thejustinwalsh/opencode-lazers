import { Database } from "bun:sqlite"
import {
  MODEL_EVIDENCE_SOURCES,
  ModelEvidenceErrorCodeSchema,
  ModelEvidenceOutputSchema,
  ModelEvidenceReadInputSchema,
  ModelEvidenceRefreshStatusSchema,
  ModelEvidenceSnapshotSchema,
} from "./source-schema.ts"
import type {
  ModelEvidenceErrorCode,
  ModelEvidenceOutput,
  ModelEvidenceRefreshStatus,
  ModelEvidenceSnapshot,
  ModelEvidenceSource,
} from "./source-schema.ts"

type SourceGeneration = Record<ModelEvidenceSource, number>

type RefreshRow = {
  source: ModelEvidenceSource
  state: "never" | "refreshing" | "succeeded" | "failed" | "cancelled"
  generation: number
  started_at: string | null
  completed_at: string | null
  latest_snapshot_id: string | null
  latest_retrieved_at: string | null
  latest_record_count: number | null
  error_code: string | null
  http_status: number | null
}

type SnapshotRow = {
  snapshot_id: string
  project_directory: string
  source: ModelEvidenceSource
  generation: number
  retrieved_at: string
  record_count: number
  body: string
}

/** Project-scoped, append-only source snapshots and separately mutable refresh state. */
export class ModelEvidenceStore {
  private readonly db: Database

  constructor(
    path: string,
    readonly projectDirectory: string,
  ) {
    this.db = new Database(path, { create: true, strict: true })
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON")
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS model_evidence_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          project_directory TEXT NOT NULL,
          source TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation > 0),
          retrieved_at TEXT NOT NULL,
          record_count INTEGER NOT NULL CHECK(record_count >= 0),
          body TEXT NOT NULL,
          UNIQUE(project_directory, source, generation)
        );
        CREATE INDEX IF NOT EXISTS model_evidence_snapshots_project_source
          ON model_evidence_snapshots(project_directory, source, generation DESC);
        CREATE TABLE IF NOT EXISTS model_evidence_refreshes (
          project_directory TEXT NOT NULL,
          source TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('never','refreshing','succeeded','failed','cancelled')),
          generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
          started_at TEXT,
          completed_at TEXT,
          latest_snapshot_id TEXT,
          latest_snapshot_generation INTEGER,
          latest_retrieved_at TEXT,
          latest_record_count INTEGER,
          error_code TEXT,
          http_status INTEGER,
          PRIMARY KEY(project_directory, source)
        );
      `)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  beginRefresh(): SourceGeneration {
    const now = new Date().toISOString()
    return this.db
      .transaction(() => {
        const generations = {} as SourceGeneration
        for (const source of MODEL_EVIDENCE_SOURCES) {
          this.db
            .query(
              `INSERT OR IGNORE INTO model_evidence_refreshes
               (project_directory, source, state, generation)
               VALUES (?, ?, 'never', 0)`,
            )
            .run(this.projectDirectory, source)
          const current = this.db
            .query<{ generation: number }, [string, string]>(
              `SELECT generation FROM model_evidence_refreshes
               WHERE project_directory=? AND source=?`,
            )
            .get(this.projectDirectory, source)!.generation
          if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER)
            throw new Error("Model evidence refresh generation is exhausted")
          const generation = current + 1
          this.db
            .query(
              `UPDATE model_evidence_refreshes SET state='refreshing', generation=?,
                 started_at=?, completed_at=NULL, error_code=NULL, http_status=NULL
               WHERE project_directory=? AND source=?`,
            )
            .run(generation, now, this.projectDirectory, source)
          generations[source] = generation
        }
        return generations
      })
      .immediate()
  }

  saveSnapshot(input: ModelEvidenceSnapshot): void {
    const snapshot = ModelEvidenceSnapshotSchema.parse(input)
    if (snapshot.projectDirectory !== this.projectDirectory)
      throw new Error("Model evidence snapshot does not belong to this project")
    const now = new Date().toISOString()
    this.db
      .transaction(() => {
        this.db
          .query(
            `INSERT INTO model_evidence_snapshots
             (snapshot_id, project_directory, source, generation, retrieved_at, record_count, body)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            snapshot.snapshotID,
            snapshot.projectDirectory,
            snapshot.source,
            snapshot.generation,
            snapshot.retrievedAt,
            snapshot.records.length,
            JSON.stringify(snapshot),
          )
        const current = this.db
          .query<
            { generation: number; latest_snapshot_generation: number | null },
            [string, ModelEvidenceSource]
          >(
            `SELECT generation, latest_snapshot_generation FROM model_evidence_refreshes
             WHERE project_directory=? AND source=?`,
          )
          .get(this.projectDirectory, snapshot.source)
        if (!current) throw new Error("Model evidence refresh was not started")
        if (snapshot.generation > current.generation)
          throw new Error("Model evidence refresh generation is unavailable")

        if (
          current.latest_snapshot_generation === null ||
          snapshot.generation > current.latest_snapshot_generation
        ) {
          this.db
            .query(
              `UPDATE model_evidence_refreshes SET latest_snapshot_id=?,
                 latest_snapshot_generation=?, latest_retrieved_at=?, latest_record_count=?
               WHERE project_directory=? AND source=?`,
            )
            .run(
              snapshot.snapshotID,
              snapshot.generation,
              snapshot.retrievedAt,
              snapshot.records.length,
              this.projectDirectory,
              snapshot.source,
            )
        }
        if (current.generation === snapshot.generation) {
          this.db
            .query(
              `UPDATE model_evidence_refreshes SET state='succeeded', completed_at=?,
                 error_code=NULL, http_status=NULL
               WHERE project_directory=? AND source=? AND generation=?`,
            )
            .run(now, this.projectDirectory, snapshot.source, snapshot.generation)
        }
      })
      .immediate()
  }

  failRefresh(
    source: ModelEvidenceSource,
    generation: number,
    errorCode: ModelEvidenceErrorCode,
    httpStatus: number | null = null,
  ): void {
    const code = ModelEvidenceErrorCodeSchema.parse(errorCode)
    this.finishRefresh(source, generation, "failed", code, httpStatus)
  }

  cancelRefresh(source: ModelEvidenceSource, generation: number): void {
    this.finishRefresh(source, generation, "cancelled", null, null)
  }

  private finishRefresh(
    source: ModelEvidenceSource,
    generation: number,
    state: "failed" | "cancelled",
    errorCode: string | null,
    httpStatus: number | null,
  ): void {
    this.db
      .query(
        `UPDATE model_evidence_refreshes SET state=?, completed_at=?, error_code=?, http_status=?
         WHERE project_directory=? AND source=? AND generation=?`,
      )
      .run(
        state,
        new Date().toISOString(),
        errorCode,
        httpStatus,
        this.projectDirectory,
        source,
        generation,
      )
  }

  read(input: unknown = {}): ModelEvidenceOutput {
    const request = ModelEvidenceReadInputSchema.parse(input)
    return this.db.transaction(() => {
      const sources = this.readStatuses()
      const snapshot = request.snapshotID
        ? this.readPage(request.snapshotID, request.cursor ?? "0", request.limit)
        : null
      return ModelEvidenceOutputSchema.parse({ sources, snapshot })
    })()
  }

  private readStatuses(): ModelEvidenceRefreshStatus[] {
    const rows = this.db
      .query<RefreshRow, [string]>(
        `SELECT r.source, r.state, r.generation, r.started_at, r.completed_at,
                r.latest_snapshot_id, r.latest_retrieved_at, r.latest_record_count,
                r.error_code, r.http_status
         FROM model_evidence_refreshes r WHERE r.project_directory=?`,
      )
      .all(this.projectDirectory)
    const bySource = new Map(rows.map((row) => [row.source, row]))
    return MODEL_EVIDENCE_SOURCES.map((source) => {
      const row = bySource.get(source)
      return ModelEvidenceRefreshStatusSchema.parse(
        row
          ? {
              source,
              state: row.state,
              generation: row.generation,
              startedAt: row.started_at,
              completedAt: row.completed_at,
              latestSnapshotID: row.latest_snapshot_id,
              latestRetrievedAt: row.latest_retrieved_at,
              latestRecordCount: row.latest_record_count,
              errorCode: row.error_code,
              httpStatus: row.http_status,
            }
          : {
              source,
              state: "never",
              generation: 0,
              startedAt: null,
              completedAt: null,
              latestSnapshotID: null,
              latestRetrievedAt: null,
              latestRecordCount: null,
              errorCode: null,
              httpStatus: null,
            },
      )
    })
  }

  private readPage(snapshotID: string, cursor: string, limit: number) {
    const row = this.db
      .query<SnapshotRow, [string, string]>(
        `SELECT snapshot_id, project_directory, source, generation, retrieved_at,
                record_count, body FROM model_evidence_snapshots
         WHERE project_directory=? AND snapshot_id=?`,
      )
      .get(this.projectDirectory, snapshotID)
    if (!row) throw new Error("Model evidence snapshot is unavailable in this project")

    const snapshot = ModelEvidenceSnapshotSchema.parse(JSON.parse(row.body))
    if (
      snapshot.snapshotID !== row.snapshot_id ||
      snapshot.projectDirectory !== row.project_directory ||
      snapshot.source !== row.source ||
      snapshot.generation !== row.generation ||
      snapshot.retrievedAt !== row.retrieved_at ||
      snapshot.records.length !== row.record_count
    )
      throw new Error("Model evidence snapshot is inconsistent")
    const offset = Number(cursor)
    if (!Number.isSafeInteger(offset) || offset > snapshot.records.length)
      throw new Error("Model evidence page cursor is unavailable")
    const records = snapshot.records.slice(offset, offset + limit)
    const nextOffset = offset + records.length
    const { records: _records, ...metadata } = snapshot
    return {
      snapshot: { ...metadata, recordCount: snapshot.records.length },
      records,
      nextCursor: nextOffset < snapshot.records.length ? String(nextOffset) : null,
    }
  }

  close(): void {
    this.db.close()
  }
}
