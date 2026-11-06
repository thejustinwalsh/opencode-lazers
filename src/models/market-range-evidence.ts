import { Database } from "bun:sqlite"
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
  const body = db
    .query<{ body: string }, [string, string, number]>(
      `SELECT body FROM model_endpoint_pricing_snapshots
       WHERE project_directory=? AND snapshot_id=? AND length(CAST(body AS BLOB))<=?`,
    )
    .get(projectDirectory, snapshotID, MAX_ENDPOINT_SNAPSHOT_BYTES)?.body
  if (body === undefined) return null
  const snapshot = EndpointPricingSnapshotSchema.parse(JSON.parse(body))
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
  const db = new Database(path, { readonly: true, strict: true })
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
             FROM model_endpoint_pricing_refreshes WHERE project_directory=?`,
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
    db.close()
  }
}
