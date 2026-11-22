import type { Database } from "bun:sqlite"
import type { BenchmarkSourceDates } from "./benchmark-baseline.ts"
import type { ModelCandidate } from "./comparison-presentation.ts"
import type { PublicCatalogItem } from "./comparison-schema.ts"
import type { DecisionViewParts } from "./decision-read.ts"
import type { CandidateSet, DecisionViewCall, DecisionViewSource } from "./decision-view-build.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"
import { ModelEvidenceSnapshotSummarySchema } from "./source-schema.ts"
import { readComparisonSourcesFrom } from "./source-store.ts"

/**
 * The decision worker's reads for a stored view (`decision-view-build.ts` computes its rows):
 * the project's candidate set, the sources' stamps and record-free summaries, and the identity
 * that decides whether a refresh computes anything.
 */
/** Candidate rows read per page: a unit of work for the worker's read-only connection. */
const CANDIDATE_PAGE_ROWS = 500

/** The project's candidates in the comparison order, or null before their first build. */
export function readCandidateSet(db: Database, projectDirectory: string): CandidateSet | null {
  const set = db
    .query<{ snapshot_set: string; public_catalog: string; public_coverage: string }, [string]>(
      `SELECT snapshot_set,public_catalog,public_coverage FROM model_candidate_sets
       WHERE project_directory=?`,
    )
    .get(projectDirectory)
  if (!set) return null
  const candidates: ModelCandidate[] = []
  const page = db.query<{ id: number; detail: string }, [string, number, number]>(
    "SELECT id,detail FROM model_candidates WHERE project_directory=? AND id>? ORDER BY id LIMIT ?",
  )
  for (let after = 0; ;) {
    const rows = page.all(projectDirectory, after, CANDIDATE_PAGE_ROWS)
    for (const row of rows) candidates.push(JSON.parse(row.detail) as ModelCandidate)
    if (rows.length < CANDIDATE_PAGE_ROWS) break
    after = rows.at(-1)!.id
  }
  // The comparison read's order (`candidatesFor`): provider, model, then the model's own entry
  // before its variants; the catalog's listing ties follow it.
  const text = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
  candidates.sort(
    (left, right) =>
      text(left.identity.providerID, right.identity.providerID) ||
      text(left.identity.modelID, right.identity.modelID) ||
      (left.identity.variant === null
        ? right.identity.variant === null
          ? 0
          : -1
        : right.identity.variant === null
          ? 1
          : text(left.identity.variant, right.identity.variant)),
  )
  return {
    snapshotSet: set.snapshot_set,
    candidates,
    external: JSON.parse(set.public_catalog) as PublicCatalogItem[],
    publicCoverage: JSON.parse(set.public_coverage) as CandidateSet["publicCoverage"],
  }
}

/**
 * The comparison's sources as stamps: which snapshot each source selects and its refresh state,
 * with no body read. A view's identity covers them, so a refresh that moves a state rewrites it.
 */
export function readSourceStamps(db: Database, projectDirectory: string) {
  return readComparisonSourcesFrom(db, projectDirectory, undefined, { stampOnly: true })
}
export type SourceStamps = ReturnType<typeof readSourceStamps>

/** The retrieval dates the catalog's price provenance carries, from the sources' stamps. */
export function sourceDatesOf(stamps: SourceStamps): BenchmarkSourceDates {
  const date = (source: string) => {
    const read = stamps.find((item) => item.source === source)
    return read?.snapshotState === "available" ? (read.stamp?.retrievedAt ?? null) : null
  }
  return {
    openrouter: date("openrouter-models"),
    opencode: date("native-catalog"),
    modelsDev: date("models-dev"),
  }
}

/**
 * The record-free summary of each source, as the comparison read reported it. SQLite drops the
 * records in the worker (`json_remove`); measured on the live database (2026-11-21): five bodies of
 * about 0.93 MB each, under 20 ms in all, and no record reaches JavaScript.
 */
export function readSourceSummaries(
  db: Database,
  projectDirectory: string,
  stamps: SourceStamps,
): DecisionViewSource[] {
  const meta = db.query<{ meta: string }, [string, string]>(
    `SELECT json_remove(body,'$.records') AS meta FROM model_evidence_snapshots
     WHERE project_directory=? AND snapshot_id=?`,
  )
  return stamps.map((read) => {
    const found =
      read.snapshotState === "available" && read.snapshotID && read.stamp
        ? meta.get(projectDirectory, read.snapshotID)
        : null
    return {
      source: read.source,
      storage: read.storage,
      snapshotState: read.snapshotState,
      selectedSnapshotID: read.snapshotID,
      refresh: read.refresh,
      snapshot: found
        ? ModelEvidenceSnapshotSummarySchema.parse({
            ...(JSON.parse(found.meta) as object),
            recordCount: read.stamp!.recordCount,
          })
        : null,
    }
  })
}

export function decisionViewIdentity(input: {
  parts: Pick<DecisionViewParts, "sourceRevision" | "priceIdentity">
  set: CandidateSet | null
  call: DecisionViewCall
  priceSources: readonly ModelPriceSource[]
  stamps: SourceStamps
}) {
  return Bun.hash(
    JSON.stringify([
      input.parts.sourceRevision,
      input.parts.priceIdentity,
      input.set?.snapshotSet ?? null,
      input.call.filters,
      input.call.basis,
      input.call.routed,
      input.priceSources,
      input.stamps.map((read) => [read.source, read.snapshotID, read.refresh, read.storage]),
    ]),
  ).toString(36)
}
