import type { Database } from "bun:sqlite"
import { z } from "zod"
import type { BenchmarkRoute, BenchmarkSourceDates } from "./benchmark-baseline.ts"
import { catalogFor } from "./catalog-inputs.ts"
import { entryCost } from "./catalog-projection.ts"
import type { CatalogEntry, CatalogSummary } from "./catalog-projection.ts"
import type { PublicCatalogItem } from "./comparison-schema.ts"
import type { ModelCandidate } from "./comparison-presentation.ts"
import { ModelDecisionReadInputSchema } from "./decision-contract.ts"
import type { ModelDecisionFilters } from "./decision-contract.ts"
import type { DecisionViewParts } from "./decision-read.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"
import { readComparisonSourcesFrom } from "./source-store.ts"

/**
 * A stored decision view: what the Models panel shows for one filter (persona × task kind ×
 * period, plus the score basis and the task whose routes count as routed), computed in the
 * decision worker and written by the main thread (`decision-store.ts`).
 *
 * ```
 * worker: snapshot (cached by revision and price identity) ─┐
 *         model_candidates + model_candidate_sets (read-only)├─► catalogFor ─► rows
 *         price source order (main thread's price inputs) ───┘    (the panel's own catalog code)
 * main:   rows ─► one transaction per page ─► model_catalog_entries, model_decision_points,
 *                                             model_decision_contributors, model_decision_views
 * ```
 *
 * The identity covers every input; a refresh whose identity equals the stored one computes
 * nothing and writes nothing.
 */
export type DecisionViewRequest = {
  filters: ModelDecisionFilters
  /** The score basis the user picked (`aa` or an Epoch benchmark id); null lets the set choose. */
  basis: string | null
  /** The task whose layer routes count as routed, as the panel's settings read; null: none. */
  taskID: string | null
}

/** A view request as a stream sends it; validated on the main thread before a view is opened. */
export const DecisionViewRequestSchema = z.strictObject({
  filters: ModelDecisionReadInputSchema.shape.filters,
  basis: z.string().min(1).max(200).nullable().default(null),
  taskID: z.uuid().nullable().default(null),
})

/** What the worker needs beyond the request: host-owned routes, and the identity already stored. */
export type DecisionViewCall = DecisionViewRequest & {
  routed: BenchmarkRoute[]
  known: string | null
}

export type DecisionViewEntryRow = {
  rank: number
  key: string
  label: string
  tags: string
  costPerTask: number | null
  tokens: number | null
  accepted: number | null
  score: number | null
  frontier: boolean
  observed: boolean
  priceSource: ModelPriceSource | null
  detail: CatalogEntry
}

export type DecisionViewPointRow = {
  ord: number
  referenceOrd: number | null
  configurationID: string
  label: string | null
  x: number | null
  y: number | null
  frontier: boolean
  point: DecisionViewParts["overview"]["graph"]["points"][number] | null
  reference:
    NonNullable<DecisionViewParts["overview"]["graph"]["referenceEstimates"]>[number] | null
}

export type DecisionViewContributorRow = {
  configurationID: string
  ord: number
  taskID: string
  detail: DecisionViewParts["contributors"][number]["contributors"][number]
}

export type DecisionViewRows = {
  identity: string
  revision: number | null
  priceIdentity: string
  snapshotID: string
  context: DecisionViewParts["overview"]["context"]
  /** The overview less its graph (counts), for the view's detail. */
  counts: { configurationCount: number; groupCount: number }
  summary: CatalogSummary
  entries: DecisionViewEntryRow[]
  points: DecisionViewPointRow[]
  contributors: DecisionViewContributorRow[]
}

export type DecisionViewResult = { unchanged: true; identity: string } | DecisionViewRows

/** A project's stored candidates and the public catalog of their snapshot set. */
export type CandidateSet = {
  snapshotSet: string
  candidates: ModelCandidate[]
  external: PublicCatalogItem[]
}

/** Candidate rows read per page: a unit of work for the worker's read-only connection. */
const CANDIDATE_PAGE_ROWS = 500

/** The project's candidates in the comparison order, or null before their first build. */
export function readCandidateSet(db: Database, projectDirectory: string): CandidateSet | null {
  const set = db
    .query<{ snapshot_set: string; public_catalog: string }, [string]>(
      "SELECT snapshot_set,public_catalog FROM model_candidate_sets WHERE project_directory=?",
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
  }
}

/** The retrieval dates the catalog's price provenance carries, from the sources' stamps. */
export function readSourceDates(db: Database, projectDirectory: string): BenchmarkSourceDates {
  const stamps = readComparisonSourcesFrom(db, projectDirectory, undefined, {
    stampOnly: true,
    sources: ["native-catalog", "openrouter-models", "models-dev"],
  })
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

export function decisionViewIdentity(input: {
  parts: Pick<DecisionViewParts, "sourceRevision" | "priceIdentity">
  set: CandidateSet | null
  call: DecisionViewCall
  priceSources: readonly ModelPriceSource[]
  sourceDates: BenchmarkSourceDates
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
      input.sourceDates,
    ]),
  ).toString(36)
}

/** The rows of one view, from the snapshot's parts and the catalog inputs. */
export function buildDecisionView(input: {
  parts: DecisionViewParts
  set: CandidateSet | null
  call: DecisionViewCall
  priceSources: readonly ModelPriceSource[]
  sourceDates: BenchmarkSourceDates
  identity: string
}): DecisionViewRows {
  const { overview } = input.parts
  const catalog = catalogFor({
    candidates: input.set?.candidates ?? [],
    // The native catalog's names are the candidates' own: the same `model.list` records.
    catalog: [],
    overview,
    priceSources: input.priceSources,
    sourceDates: input.sourceDates,
    routed: input.call.routed,
    preferredBasis: input.call.basis,
    external: input.set?.external ?? [],
  })
  const entries = catalog.entries.map((entry, rank): DecisionViewEntryRow => ({
    rank,
    key: `${entry.route.providerID}\u0000${entry.route.modelID}`,
    label: entry.label,
    tags: entry.tags.join(","),
    costPerTask: entryCost(entry),
    tokens: entry.observed?.tokens ?? null,
    accepted: entry.observed?.accepted ?? null,
    score: entry.score,
    frontier: entry.frontier,
    observed: entry.observed !== null,
    priceSource: entry.price?.source ?? null,
    detail: entry,
  }))
  const frontier = new Set(overview.graph.frontierConfigurationIDs)
  const references = overview.graph.referenceEstimates ?? []
  const referenceAt = new Map(references.map((item, index) => [item.configurationID, index]))
  const points: DecisionViewPointRow[] = overview.graph.points.map((point, ord) => {
    const at = referenceAt.get(point.configurationID)
    return {
      ord,
      referenceOrd: at ?? null,
      configurationID: point.configurationID,
      label: point.label,
      x: point.tokensPerAcceptedTask,
      y: point.currentMarketUSDPerAcceptedTask,
      frontier: frontier.has(point.configurationID),
      point,
      reference: at === undefined ? null : references[at]!,
    }
  })
  const plotted = new Set(overview.graph.points.map((point) => point.configurationID))
  references.forEach((reference, index) => {
    if (plotted.has(reference.configurationID)) return
    points.push({
      ord: points.length,
      referenceOrd: index,
      configurationID: reference.configurationID,
      label: reference.label ?? null,
      x: reference.tokensPerAcceptedTask ?? null,
      y: null,
      frontier: frontier.has(reference.configurationID),
      point: null,
      reference,
    })
  })
  const contributors = input.parts.contributors.flatMap(({ configurationID, contributors: list }) =>
    list.map((detail, ord) => ({ configurationID, ord, taskID: detail.taskID, detail })),
  )
  return {
    identity: input.identity,
    revision: input.parts.sourceRevision,
    priceIdentity: input.parts.priceIdentity,
    snapshotID: overview.context.snapshotID,
    context: overview.context,
    counts: {
      configurationCount: overview.configurationCount,
      groupCount: overview.groupCount,
    },
    summary: catalog.summary,
    entries,
    points,
    contributors,
  }
}
