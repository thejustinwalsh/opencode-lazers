import type { Database } from "bun:sqlite"
import { acquireSharedConnection } from "../storage.ts"
import { budgetFromEnv, sharedByteLru } from "./byte-lru.ts"

import {
  ENDPOINT_PRICING_PRODUCTS,
  EndpointPricingReadSchema,
  EndpointPricingScenarioSchema,
  EndpointPricingSnapshotSchema,
} from "./endpoint-pricing.ts"
import type {
  EndpointPricingProductID,
  EndpointPricingRead,
  EndpointPricingScenario,
  EndpointPricingSnapshot,
} from "./endpoint-pricing.ts"

const MAX_ENDPOINT_SNAPSHOT_BYTES = 4 * 1024 * 1024

/**
 * Parsed endpoint pricing snapshots by project and immutable id, shared by every plugin copy.
 * Each is at most MAX_ENDPOINT_SNAPSHOT_BYTES of text and there is one per product scenario
 * (a handful), so 16 MiB holds the current set with room for a refresh in flight.
 * Tune with LAZERS_ENDPOINT_CACHE_MIB.
 */
const parsedEndpointSnapshots = sharedByteLru<EndpointPricingSnapshot>(
  "model-endpoint-pricing-snapshots",
  budgetFromEnv("LAZERS_ENDPOINT_CACHE_MIB", 16),
)
export const clearParsedEndpointSnapshotCache = () => parsedEndpointSnapshots.clear()

type RefreshRow = {
  product_id: EndpointPricingProductID
  state: EndpointPricingScenario["state"]
  generation: number
  started_at: string | null
  completed_at: string | null
  latest_snapshot_id: string | null
  latest_retrieved_at: string | null
  latest_record_count: number | null
  error_code: EndpointPricingScenario["errorCode"]
  http_status: number | null
}

type SnapshotRow = {
  snapshot_id: string
  project_directory: string
  product_id: EndpointPricingProductID
  generation: number
  retrieved_at: string
  source_url: string
  http_status: number
  record_count: number
  body_bytes: number
}

function tableExists(db: Database, name: string) {
  return Boolean(
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(name),
  )
}

function emptyScenario(productID: EndpointPricingProductID): EndpointPricingScenario {
  const product = ENDPOINT_PRICING_PRODUCTS.find((item) => item.productID === productID)!
  return {
    productID,
    sourceURL: product.sourceURL,
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
  }
}

function invalidScenario(row: RefreshRow, productID: EndpointPricingProductID) {
  const product = ENDPOINT_PRICING_PRODUCTS.find((item) => item.productID === productID)!
  return EndpointPricingScenarioSchema.parse({
    productID,
    sourceURL: product.sourceURL,
    state: "failed",
    generation: row.generation,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    latestSnapshotID: null,
    latestRetrievedAt: null,
    latestRecordCount: null,
    errorCode: "malformed-response",
    httpStatus: row.http_status,
    snapshot: null,
  })
}

function readSnapshot(
  db: Database,
  projectDirectory: string,
  productID: EndpointPricingProductID,
  snapshotID: string,
): EndpointPricingSnapshot | null {
  const row = db
    .query<SnapshotRow, [string, string]>(
      `SELECT snapshot_id, project_directory, product_id, generation, retrieved_at,
              source_url, http_status, record_count, length(CAST(body AS BLOB)) AS body_bytes
       FROM model_endpoint_pricing_snapshots WHERE project_directory=? AND snapshot_id=?`,
    )
    .get(projectDirectory, snapshotID)
  if (!row) return null
  if (row.body_bytes > MAX_ENDPOINT_SNAPSHOT_BYTES) return null
  // Snapshots are immutable by id: parse once, then validate only the row's metadata.
  const cacheKey = `${projectDirectory}\u0000${snapshotID}\u0000${row.generation}:${row.record_count}:${row.body_bytes}`
  let snapshot = parsedEndpointSnapshots.get(cacheKey)
  if (!snapshot) {
    const body = db
      .query<{ body: string }, [string, string, number]>(
        `SELECT body FROM model_endpoint_pricing_snapshots
         WHERE project_directory=? AND snapshot_id=? AND length(CAST(body AS BLOB))<=?`,
      )
      .get(projectDirectory, snapshotID, MAX_ENDPOINT_SNAPSHOT_BYTES)?.body
    if (body === undefined) return null
    snapshot = EndpointPricingSnapshotSchema.parse(JSON.parse(body))
    parsedEndpointSnapshots.set(cacheKey, snapshot, row.body_bytes)
  }
  if (
    snapshot.snapshotID !== row.snapshot_id ||
    snapshot.projectDirectory !== row.project_directory ||
    snapshot.productID !== row.product_id ||
    snapshot.productID !== productID ||
    snapshot.generation !== row.generation ||
    snapshot.retrievedAt !== row.retrieved_at ||
    snapshot.sourceURL !== row.source_url ||
    snapshot.httpStatus !== row.http_status ||
    snapshot.records.length !== row.record_count
  )
    return null
  return snapshot
}

function aggregate(scenarios: EndpointPricingScenario[]): EndpointPricingRead {
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
    complete: scenarios.every(
      ({ state: itemState, generation, snapshot }) =>
        itemState === "succeeded" && snapshot?.generation === generation,
    ),
    scenarios,
  })
}

/** Read the retained endpoint snapshots without creating or migrating any project tables. */
export function readEndpointPricingEvidence(
  path: string,
  projectDirectory: string,
  signal?: AbortSignal,
): EndpointPricingRead {
  signal?.throwIfAborted()
  const shared = acquireSharedConnection(path, "readonly")
  const db = shared.db
  try {
    const scenarios = db
      .transaction(() => {
        signal?.throwIfAborted()
        if (!tableExists(db, "model_endpoint_pricing_refreshes"))
          return ENDPOINT_PRICING_PRODUCTS.map(({ productID }) => emptyScenario(productID))

        const rows = db
          .query<RefreshRow, [string]>(
            `SELECT product_id, state, generation, started_at, completed_at, latest_snapshot_id,
                    latest_retrieved_at, latest_record_count, error_code, http_status
             FROM model_endpoint_pricing_refreshes WHERE project_directory=?
             LIMIT ${ENDPOINT_PRICING_PRODUCTS.length}`,
          )
          .all(projectDirectory)
        const byProduct = new Map(rows.map((row) => [row.product_id, row]))
        const snapshotsTable = tableExists(db, "model_endpoint_pricing_snapshots")
        return ENDPOINT_PRICING_PRODUCTS.map(({ productID, sourceURL }) => {
          signal?.throwIfAborted()
          const row = byProduct.get(productID)
          if (!row) return emptyScenario(productID)
          if (!row.latest_snapshot_id)
            return EndpointPricingScenarioSchema.parse({
              productID,
              sourceURL,
              state: row.state,
              generation: row.generation,
              startedAt: row.started_at,
              completedAt: row.completed_at,
              latestSnapshotID: null,
              latestRetrievedAt: null,
              latestRecordCount: null,
              errorCode: row.error_code,
              httpStatus: row.http_status,
              snapshot: null,
            })

          if (!snapshotsTable) return invalidScenario(row, productID)
          try {
            const snapshot = readSnapshot(db, projectDirectory, productID, row.latest_snapshot_id)
            if (!snapshot) return invalidScenario(row, productID)
            return EndpointPricingScenarioSchema.parse({
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
            })
          } catch {
            return invalidScenario(row, productID)
          }
        })
      })
      .deferred()
    signal?.throwIfAborted()
    return aggregate(scenarios)
  } finally {
    shared.release()
  }
}

/**
 * What identifies the retained endpoint pricing without reading any snapshot body: the refresh
 * rows (state, generation, latest snapshot id). Snapshots are immutable by id, so equal rows
 * mean equal evidence.
 */
export function readEndpointPricingStamp(path: string, projectDirectory: string): RefreshRow[] {
  const shared = acquireSharedConnection(path, "readonly")
  try {
    const db = shared.db
    if (!tableExists(db, "model_endpoint_pricing_refreshes")) return []
    return db
      .query<RefreshRow, [string]>(
        `SELECT product_id, state, generation, started_at, completed_at, latest_snapshot_id,
                latest_retrieved_at, latest_record_count, error_code, http_status
         FROM model_endpoint_pricing_refreshes WHERE project_directory=? ORDER BY product_id LIMIT ${ENDPOINT_PRICING_PRODUCTS.length}`,
      )
      .all(projectDirectory)
  } finally {
    shared.release()
  }
}
