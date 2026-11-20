import type { Database } from "bun:sqlite"
import { acquireSharedConnection } from "../storage.ts"
import { budgetFromEnv, sharedByteLru } from "./byte-lru.ts"
import type { SharedConnection } from "../storage.ts"
import {
  ENDPOINT_PRICING_PRODUCTS,
  EndpointPricingProductIDSchema,
  EndpointPricingReadSchema,
  EndpointPricingScenarioSchema,
  EndpointPricingSnapshotSchema,
} from "./endpoint-pricing.ts"
import type {
  EndpointPricingProductID,
  EndpointPricingRead,
  EndpointPricingSnapshot,
} from "./endpoint-pricing.ts"
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

type SnapshotMetaRow = Omit<SnapshotRow, "body"> & { body_bytes: number }

/**
 * Parsed evidence snapshots by project and immutable snapshot id, shared by every plugin copy.
 * Budget counts stored JSON bytes. Measured 2026-11-20: JSON.parse of a 22 MB native-shaped
 * catalog (60 000 records) adds 32 MB of heap, 1.5 bytes per text byte; the schema parse keeps
 * one copy of that, so 48 MiB of text bounds the cache near 72-150 MB. models.dev (about 24 MB)
 * fits alone; the two priced sources fit together.
 * Tune with LAZERS_SNAPSHOT_CACHE_MIB.
 */
const parsedSnapshots = sharedByteLru<ModelEvidenceSnapshot>(
  "model-evidence-snapshots",
  budgetFromEnv("LAZERS_SNAPSHOT_CACHE_MIB", 48),
)

/** Cache counters for diagnostics and tests. */
export const parsedSnapshotCacheStats = () => ({
  hits: parsedSnapshots.stats.hits,
  misses: parsedSnapshots.stats.misses,
  size: parsedSnapshots.size,
  bytes: parsedSnapshots.bytes,
})
export const clearParsedSnapshotCache = () => parsedSnapshots.clear()

type EndpointPricingGeneration = Record<EndpointPricingProductID, number>

type EndpointPricingRefreshRow = {
  product_id: EndpointPricingProductID
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

type EndpointPricingSnapshotRow = {
  snapshot_id: string
  project_directory: string
  product_id: EndpointPricingProductID
  generation: number
  retrieved_at: string
  source_url: string
  http_status: number
  record_count: number
  body: string
}

/** Project-scoped, append-only source snapshots and separately mutable refresh state. */
export class ModelEvidenceStore {
  private readonly db: Database
  private shared: SharedConnection | undefined

  constructor(
    path: string,
    readonly projectDirectory: string,
  ) {
    // Shares the process-wide write connection (SQLITE_BUSY_TIMEOUT_MS, WAL, change hooks).
    const shared = acquireSharedConnection(path)
    this.shared = shared
    this.db = shared.db
    try {
      shared.once("model-evidence", (db) =>
        db.exec(`
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
        CREATE TABLE IF NOT EXISTS model_endpoint_pricing_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          project_directory TEXT NOT NULL,
          product_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation > 0),
          retrieved_at TEXT NOT NULL,
          source_url TEXT NOT NULL,
          http_status INTEGER NOT NULL CHECK(http_status BETWEEN 100 AND 599),
          record_count INTEGER NOT NULL CHECK(record_count BETWEEN 0 AND 200),
          body TEXT NOT NULL,
          UNIQUE(project_directory, product_id, generation)
        );
        CREATE INDEX IF NOT EXISTS model_endpoint_pricing_snapshots_project_product
          ON model_endpoint_pricing_snapshots(project_directory, product_id, generation DESC);
        CREATE TABLE IF NOT EXISTS model_endpoint_pricing_refreshes (
          project_directory TEXT NOT NULL,
          product_id TEXT NOT NULL,
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
          PRIMARY KEY(project_directory, product_id)
        );
      `),
      )
    } catch (error) {
      shared.release()
      throw error
    }
  }

  /** Start a refresh of the given sources (all by default); the others are left as they are. */
  beginRefresh(sources: readonly ModelEvidenceSource[] = MODEL_EVIDENCE_SOURCES): SourceGeneration {
    const now = new Date().toISOString()
    return this.db
      .transaction(() => {
        const generations = {} as SourceGeneration
        for (const source of sources) {
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

  beginEndpointPricingRefresh(): EndpointPricingGeneration {
    const now = new Date().toISOString()
    return this.db
      .transaction(() => {
        const generations = {} as EndpointPricingGeneration
        for (const { productID } of ENDPOINT_PRICING_PRODUCTS) {
          this.db
            .query(
              `INSERT OR IGNORE INTO model_endpoint_pricing_refreshes
               (project_directory, product_id, state, generation)
               VALUES (?, ?, 'never', 0)`,
            )
            .run(this.projectDirectory, productID)
          const current = this.db
            .query<{ generation: number }, [string, EndpointPricingProductID]>(
              `SELECT generation FROM model_endpoint_pricing_refreshes
               WHERE project_directory=? AND product_id=?`,
            )
            .get(this.projectDirectory, productID)!.generation
          if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER)
            throw new Error("Endpoint pricing refresh generation is exhausted")
          const generation = current + 1
          this.db
            .query(
              `UPDATE model_endpoint_pricing_refreshes SET state='refreshing', generation=?,
                 started_at=?, completed_at=NULL, error_code=NULL, http_status=NULL
               WHERE project_directory=? AND product_id=?`,
            )
            .run(generation, now, this.projectDirectory, productID)
          generations[productID] = generation
        }
        return generations
      })
      .immediate()
  }

  saveEndpointPricingSnapshot(input: EndpointPricingSnapshot): void {
    const snapshot = EndpointPricingSnapshotSchema.parse(input)
    if (snapshot.projectDirectory !== this.projectDirectory)
      throw new Error("Endpoint pricing snapshot does not belong to this project")
    const now = new Date().toISOString()
    this.db
      .transaction(() => {
        this.db
          .query(
            `INSERT INTO model_endpoint_pricing_snapshots
             (snapshot_id, project_directory, product_id, generation, retrieved_at, source_url,
              http_status, record_count, body)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            snapshot.snapshotID,
            snapshot.projectDirectory,
            snapshot.productID,
            snapshot.generation,
            snapshot.retrievedAt,
            snapshot.sourceURL,
            snapshot.httpStatus,
            snapshot.records.length,
            JSON.stringify(snapshot),
          )
        const current = this.db
          .query<
            { generation: number; latest_snapshot_generation: number | null },
            [string, EndpointPricingProductID]
          >(
            `SELECT generation, latest_snapshot_generation FROM model_endpoint_pricing_refreshes
             WHERE project_directory=? AND product_id=?`,
          )
          .get(this.projectDirectory, snapshot.productID)
        if (!current) throw new Error("Endpoint pricing refresh was not started")
        if (snapshot.generation > current.generation)
          throw new Error("Endpoint pricing refresh generation is unavailable")

        if (
          current.latest_snapshot_generation === null ||
          snapshot.generation > current.latest_snapshot_generation
        ) {
          this.db
            .query(
              `UPDATE model_endpoint_pricing_refreshes SET latest_snapshot_id=?,
                 latest_snapshot_generation=?, latest_retrieved_at=?, latest_record_count=?
               WHERE project_directory=? AND product_id=?`,
            )
            .run(
              snapshot.snapshotID,
              snapshot.generation,
              snapshot.retrievedAt,
              snapshot.records.length,
              this.projectDirectory,
              snapshot.productID,
            )
        }
        if (current.generation === snapshot.generation) {
          this.db
            .query(
              `UPDATE model_endpoint_pricing_refreshes SET state='succeeded', completed_at=?,
                 error_code=NULL, http_status=NULL
               WHERE project_directory=? AND product_id=? AND generation=?`,
            )
            .run(now, this.projectDirectory, snapshot.productID, snapshot.generation)
        }
      })
      .immediate()
  }

  failEndpointPricingRefresh(
    productID: EndpointPricingProductID,
    generation: number,
    errorCode: ModelEvidenceErrorCode,
    httpStatus: number | null = null,
  ): void {
    EndpointPricingProductIDSchema.parse(productID)
    const code = ModelEvidenceErrorCodeSchema.parse(errorCode)
    this.finishEndpointPricingRefresh(productID, generation, "failed", code, httpStatus)
  }

  cancelEndpointPricingRefresh(
    productID: EndpointPricingProductID,
    generation: number,
    httpStatus: number | null = null,
  ): void {
    EndpointPricingProductIDSchema.parse(productID)
    this.finishEndpointPricingRefresh(productID, generation, "cancelled", null, httpStatus)
  }

  private finishEndpointPricingRefresh(
    productID: EndpointPricingProductID,
    generation: number,
    state: "failed" | "cancelled",
    errorCode: string | null,
    httpStatus: number | null,
  ): void {
    this.db
      .query(
        `UPDATE model_endpoint_pricing_refreshes SET state=?, completed_at=?, error_code=?,
           http_status=?
         WHERE project_directory=? AND product_id=? AND generation=?`,
      )
      .run(
        state,
        new Date().toISOString(),
        errorCode,
        httpStatus,
        this.projectDirectory,
        productID,
        generation,
      )
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
        // Superseded snapshots have no reader: keep the newest two generations per source
        // (plus whatever the refresh row points at) and drop the rest in the same transaction.
        const pruned = this.db
          .query<{ snapshot_id: string }, [string, string, string, string, string]>(
            `DELETE FROM model_evidence_snapshots
             WHERE project_directory=? AND source=?
               AND snapshot_id NOT IN (
                 SELECT snapshot_id FROM model_evidence_snapshots
                 WHERE project_directory=? AND source=? ORDER BY generation DESC LIMIT 2)
               AND snapshot_id NOT IN (
                 SELECT latest_snapshot_id FROM model_evidence_refreshes
                 WHERE project_directory=? AND latest_snapshot_id IS NOT NULL)
             RETURNING snapshot_id`,
          )
          .all(
            this.projectDirectory,
            snapshot.source,
            this.projectDirectory,
            snapshot.source,
            this.projectDirectory,
          )
        for (const { snapshot_id } of pruned)
          parsedSnapshots.deleteByPrefix(`${this.projectDirectory}\u0000${snapshot_id}\u0000`)
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

  /** The latest stored snapshot of a source, or null before the first successful fetch. */
  latestSnapshot(source: ModelEvidenceSource): ModelEvidenceSnapshot | null {
    const row = this.db
      .query<{ body: string }, [string, string]>(
        `SELECT s.body FROM model_evidence_refreshes r
         JOIN model_evidence_snapshots s ON s.snapshot_id = r.latest_snapshot_id
         WHERE r.project_directory=? AND r.source=?`,
      )
      .get(this.projectDirectory, source)
    return row ? ModelEvidenceSnapshotSchema.parse(JSON.parse(row.body)) : null
  }

  /**
   * Source statuses, optionally one snapshot page. Endpoint pricing carries every scenario's
   * snapshot body (up to 4 MB each), so it is read only when the caller asks for it.
   */
  read(input: unknown = {}, options: { endpointPricing?: boolean } = {}): ModelEvidenceOutput {
    const request = ModelEvidenceReadInputSchema.parse(input)
    return this.db.transaction(() => {
      const sources = this.readStatuses()
      const snapshot = request.snapshotID
        ? this.readPage(request.snapshotID, request.cursor ?? "0", request.limit)
        : null
      return ModelEvidenceOutputSchema.parse({
        sources,
        snapshot,
        ...(options.endpointPricing === false
          ? {}
          : { endpointPricing: this.readEndpointPricing() }),
      })
    })()
  }

  private readEndpointPricing(): EndpointPricingRead {
    const rows = this.db
      .query<EndpointPricingRefreshRow, [string]>(
        `SELECT product_id, state, generation, started_at, completed_at, latest_snapshot_id,
                latest_retrieved_at, latest_record_count, error_code, http_status
         FROM model_endpoint_pricing_refreshes WHERE project_directory=?`,
      )
      .all(this.projectDirectory)
    const byProduct = new Map(rows.map((row) => [row.product_id, row]))
    const scenarios = ENDPOINT_PRICING_PRODUCTS.map(({ productID, sourceURL }) => {
      const row = byProduct.get(productID)
      const snapshot = row?.latest_snapshot_id
        ? this.readEndpointPricingSnapshot(productID, row.latest_snapshot_id)
        : null
      return EndpointPricingScenarioSchema.parse(
        row
          ? {
              productID,
              sourceURL,
              state: row.state,
              generation: row.generation,
              startedAt: row.started_at,
              completedAt: row.completed_at,
              latestSnapshotID: row.latest_snapshot_id,
              latestRetrievedAt: row.latest_retrieved_at,
              latestRecordCount: row.latest_record_count,
              errorCode: row.error_code,
              httpStatus: row.http_status,
              snapshot,
            }
          : {
              productID,
              sourceURL,
              state: "never",
              generation: 0,
              startedAt: null,
              completedAt: null,
              latestSnapshotID: null,
              latestRetrievedAt: null,
              latestRecordCount: null,
              errorCode: null,
              httpStatus: null,
              snapshot: null,
            },
      )
    })
    const states = scenarios.map(({ state }) => state)
    const state: EndpointPricingRead["state"] = states.every((value) => value === "never")
      ? "never"
      : states.some((value) => value === "refreshing")
        ? "refreshing"
        : states.every((value) => value === "succeeded")
          ? "succeeded"
          : states.every((value) => value === "cancelled")
            ? "cancelled"
            : states.every((value) => value === "failed")
              ? "failed"
              : "partial"
    return EndpointPricingReadSchema.parse({
      state,
      generation: Math.max(...scenarios.map(({ generation }) => generation)),
      complete: states.every((value) => value === "succeeded"),
      scenarios,
    })
  }

  private readEndpointPricingSnapshot(
    productID: EndpointPricingProductID,
    snapshotID: string,
  ): EndpointPricingSnapshot {
    const row = this.db
      .query<EndpointPricingSnapshotRow, [string, string]>(
        `SELECT snapshot_id, project_directory, product_id, generation, retrieved_at,
                source_url, http_status, record_count, body
         FROM model_endpoint_pricing_snapshots WHERE project_directory=? AND snapshot_id=?`,
      )
      .get(this.projectDirectory, snapshotID)
    if (!row) throw new Error("Endpoint pricing snapshot is unavailable in this project")
    if (row.product_id !== productID)
      throw new Error("Endpoint pricing snapshot product does not match its selection")
    const snapshot = EndpointPricingSnapshotSchema.parse(JSON.parse(row.body))
    if (
      snapshot.snapshotID !== row.snapshot_id ||
      snapshot.projectDirectory !== row.project_directory ||
      snapshot.productID !== row.product_id ||
      snapshot.generation !== row.generation ||
      snapshot.retrievedAt !== row.retrieved_at ||
      snapshot.sourceURL !== row.source_url ||
      snapshot.httpStatus !== row.http_status ||
      snapshot.records.length !== row.record_count
    )
      throw new Error("Endpoint pricing snapshot is inconsistent")
    return snapshot
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
    this.shared?.release()
    this.shared = undefined
  }
}

export type ModelEvidenceComparisonSourceRead = {
  source: ModelEvidenceSource
  storage: "ready" | "missing-snapshot-table" | "missing-refresh-table" | "missing-both-tables"
  snapshotState: "available" | "none" | "missing-table" | "missing-snapshot"
  snapshotID: string | null
  refresh: ModelEvidenceRefreshStatus | null
  snapshot: ModelEvidenceSnapshot | null
  /** Present on a stamp-only read: what identifies the snapshot, without its records. */
  stamp?: { generation: number; retrievedAt: string; recordCount: number }
}

export type ModelEvidenceComparisonReadOptions = {
  /** Read only these sources; others are left out of the result. Default: all. */
  sources?: readonly ModelEvidenceSource[]
  /** Return the snapshot's stamp and never its records (no body read, no parse). */
  stampOnly?: boolean
}

type CoreEvidenceSource = Exclude<ModelEvidenceSource, "models-dev" | "epoch-benchmarks">
/** Selections pinned before the public sources existed lack them; those read as latest. */
export type ModelEvidenceComparisonSnapshotSelection = Record<CoreEvidenceSource, string | null> &
  Partial<Record<"models-dev" | "epoch-benchmarks", string | null>>

/** Read-only, project-scoped snapshot access for comparison projections. */
export class ModelEvidenceReadStore {
  private readonly db: Database
  private shared: SharedConnection | undefined

  constructor(
    path: string,
    readonly projectDirectory: string,
  ) {
    this.shared = acquireSharedConnection(path, "readonly")
    this.db = this.shared.db
  }

  readComparisonSources(
    selection?: ModelEvidenceComparisonSnapshotSelection,
    options: ModelEvidenceComparisonReadOptions = {},
  ): ModelEvidenceComparisonSourceRead[] {
    const wanted = options.sources ?? MODEL_EVIDENCE_SOURCES
    const read = this.db.transaction(() => {
      const snapshotsTable = this.tableExists("model_evidence_snapshots")
      const refreshesTable = this.tableExists("model_evidence_refreshes")
      const storage: ModelEvidenceComparisonSourceRead["storage"] = snapshotsTable
        ? refreshesTable
          ? "ready"
          : "missing-refresh-table"
        : refreshesTable
          ? "missing-snapshot-table"
          : "missing-both-tables"
      const refreshRows = refreshesTable
        ? this.db
            .query<RefreshRow, [string]>(
              `SELECT r.source, r.state, r.generation, r.started_at, r.completed_at,
                      r.latest_snapshot_id, r.latest_retrieved_at, r.latest_record_count,
                      r.error_code, r.http_status
               FROM model_evidence_refreshes r WHERE r.project_directory=?`,
            )
            .all(this.projectDirectory)
        : []
      const refreshBySource = new Map(refreshRows.map((row) => [row.source, row]))

      return wanted.map((source): ModelEvidenceComparisonSourceRead => {
        const refreshRow = refreshBySource.get(source)
        const refresh = refreshesTable
          ? ModelEvidenceRefreshStatusSchema.parse(
              refreshRow
                ? {
                    source,
                    state: refreshRow.state,
                    generation: refreshRow.generation,
                    startedAt: refreshRow.started_at,
                    completedAt: refreshRow.completed_at,
                    latestSnapshotID: refreshRow.latest_snapshot_id,
                    latestRetrievedAt: refreshRow.latest_retrieved_at,
                    latestRecordCount: refreshRow.latest_record_count,
                    errorCode: refreshRow.error_code,
                    httpStatus: refreshRow.http_status,
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
          : null
        if (!snapshotsTable)
          return {
            source,
            storage,
            snapshotState: "missing-table",
            snapshotID: selection?.[source] ?? null,
            refresh,
            snapshot: null,
          }

        let snapshotID: string | null
        if (selection && selection[source] !== undefined) {
          snapshotID = selection[source] ?? null
        } else if (refreshRow) {
          snapshotID = refreshRow.latest_snapshot_id
        } else {
          snapshotID =
            this.db
              .query<{ snapshot_id: string }, [string, ModelEvidenceSource]>(
                `SELECT snapshot_id FROM model_evidence_snapshots
                 WHERE project_directory=? AND source=? ORDER BY generation DESC LIMIT 1`,
              )
              .get(this.projectDirectory, source)?.snapshot_id ?? null
        }

        if (snapshotID === null)
          return {
            source,
            storage,
            snapshotState: "none",
            snapshotID: null,
            refresh,
            snapshot: null,
          }

        const meta = this.db
          .query<SnapshotMetaRow, [string, string]>(
            `SELECT snapshot_id, project_directory, source, generation, retrieved_at,
                    record_count, length(body) AS body_bytes FROM model_evidence_snapshots
             WHERE project_directory=? AND snapshot_id=?`,
          )
          .get(this.projectDirectory, snapshotID)
        if (!meta)
          return {
            source,
            storage,
            snapshotState: "missing-snapshot",
            snapshotID,
            refresh,
            snapshot: null,
          }

        if (meta.source !== source)
          throw new Error("Model evidence snapshot source does not match its selection")

        if (options.stampOnly)
          return {
            source,
            storage,
            snapshotState: "available",
            snapshotID,
            refresh,
            snapshot: null,
            stamp: {
              generation: meta.generation,
              retrievedAt: meta.retrieved_at,
              recordCount: meta.record_count,
            },
          }

        // Snapshots are immutable by id, so a parsed one is reused; only metadata is read per call.
        const cacheKey = `${this.projectDirectory}\u0000${snapshotID}\u0000${meta.generation}:${meta.record_count}:${meta.body_bytes}`
        let snapshot = parsedSnapshots.get(cacheKey)
        if (!snapshot) {
          const row = this.db
            .query<{ body: string }, [string, string]>(
              `SELECT body FROM model_evidence_snapshots WHERE project_directory=? AND snapshot_id=?`,
            )
            .get(this.projectDirectory, snapshotID)
          if (!row) throw new Error("Model evidence snapshot is inconsistent")
          snapshot = ModelEvidenceSnapshotSchema.parse(JSON.parse(row.body))
          parsedSnapshots.set(cacheKey, snapshot, meta.body_bytes)
        }
        if (
          snapshot.snapshotID !== meta.snapshot_id ||
          snapshot.projectDirectory !== meta.project_directory ||
          snapshot.source !== meta.source ||
          snapshot.generation !== meta.generation ||
          snapshot.retrievedAt !== meta.retrieved_at ||
          snapshot.records.length !== meta.record_count
        ) {
          parsedSnapshots.delete(cacheKey)
          throw new Error("Model evidence snapshot is inconsistent")
        }
        return {
          source,
          storage,
          snapshotState: "available",
          snapshotID,
          refresh,
          snapshot,
        }
      })
    })
    return read.deferred()
  }

  private tableExists(name: string): boolean {
    return Boolean(
      this.db
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(name),
    )
  }

  close(): void {
    this.shared?.release()
    this.shared = undefined
  }
}
