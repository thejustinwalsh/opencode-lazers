import { z } from "zod"
import { benchmarkBaseline, routeKey } from "./benchmark-baseline.ts"
import type {
  BenchmarkBaselineGap,
  BenchmarkBaselinePoint,
  BenchmarkRoute,
  BenchmarkSourceDates,
} from "./benchmark-baseline.ts"
import {
  catalogFor,
  chartPoints,
  chartReferences,
  modelDisplayLabeler,
  observedCosts,
} from "./catalog-inputs.ts"
import type { ConfigurationCost } from "./configuration-cost.ts"
import type { ComparisonChartPoint, ComparisonChartReference } from "./chart-data.ts"
import { entryCost } from "./catalog-projection.ts"
import type { CatalogEntry, CatalogSummary } from "./catalog-projection.ts"
import type { ModelComparisonOutput, PublicCatalogItem } from "./comparison-schema.ts"
import type { ModelCandidate } from "./comparison-presentation.ts"
import { ModelDecisionReadInputSchema } from "./decision-contract.ts"
import type { ModelDecisionFilters } from "./decision-contract.ts"
import type { DecisionInspectionFacts, DecisionViewParts } from "./decision-read.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"
import { scoreOptions, type ScoreBasis, type ScoreOption } from "./public-score.ts"

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

/**
 * One configuration of the view: a graph point, a reference estimate, both, or neither (a
 * configuration with no accepted task and no published reference), with what the chart draws for
 * it, its display label and what its inspection says (less the contributors, stored apart).
 */
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
  groupID: string
  /** The model's full display label among the view's configurations and references. */
  displayLabel: string
  chart: ComparisonChartPoint | null
  chartReference: ComparisonChartReference | null
  /** The configuration's one displayed cost (`configurationCost`, observed basis). */
  cost: ConfigurationCost | null
  inspection: DecisionInspectionFacts
}

/** A Benchmark chart row: a scored, priced model (`point`) or one left off it (`gap`). */
export type DecisionViewBenchmarkRow = {
  ord: number
  key: string
  kind: "point" | "gap"
  label: string
  score: number | null
  observed: boolean
  detail: BenchmarkBaselinePoint | BenchmarkBaselineGap
}

/** The comparison's source snapshots and refresh states (record-free summaries). */
export type DecisionViewSource = ModelComparisonOutput["sources"][number]

/** What the Benchmark view and the score picker show beside the rows. */
export type DecisionViewBenchmark = {
  scoreBasis: ScoreBasis
  scoreOptions: ScoreOption[]
  unmatchedRoutes: number
  ambiguousRoutes: number
  priceSources: ModelPriceSource[]
  publicCoverage: ModelComparisonOutput["publicCoverage"] | null
  /** Distinct catalog routes (provider and model) of the candidates. */
  catalogRoutes: number
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
  sources: DecisionViewSource[]
  benchmark: DecisionViewBenchmark
  benchmarkRows: DecisionViewBenchmarkRow[]
}

export type DecisionViewResult = { unchanged: true; identity: string } | DecisionViewRows

/** A project's stored candidates and the public catalog of their snapshot set. */
export type CandidateSet = {
  snapshotSet: string
  candidates: ModelCandidate[]
  external: PublicCatalogItem[]
  publicCoverage: ModelComparisonOutput["publicCoverage"] | null
}

/** The rows of one view, from the snapshot's parts and the catalog inputs. */
export function buildDecisionView(input: {
  parts: DecisionViewParts
  set: CandidateSet | null
  call: DecisionViewCall
  priceSources: readonly ModelPriceSource[]
  sourceDates: BenchmarkSourceDates
  sources: DecisionViewSource[]
  identity: string
}): DecisionViewRows {
  const { overview } = input.parts
  const candidates = input.set?.candidates ?? []
  const external = input.set?.external ?? []
  // Each configuration's cost, computed once: the point rows store it and the catalog's observed
  // facts carry the same object, so every view reads one number per configuration.
  const routes = new Map(
    input.parts.inspections.map((item) => [
      item.configuration.configurationID,
      item.configuration.route,
    ]),
  )
  const costs = observedCosts(overview, (configurationID) => routes.get(configurationID))
  const catalog = catalogFor({
    costs,
    candidates,
    // The native catalog's names are the candidates' own: the same `model.list` records.
    catalog: [],
    overview,
    priceSources: input.priceSources,
    sourceDates: input.sourceDates,
    routed: input.call.routed,
    preferredBasis: input.call.basis,
    external,
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
  // What the chart draws: the panel's own chart inputs, labelled from the candidates' names.
  const chartRefs = chartReferences(overview.graph, candidates, [])
  const chartRefByID = new Map(chartRefs.map((item) => [item.configurationID, item]))
  const chartByID = new Map(
    chartPoints(overview, chartRefs, candidates, []).map((item) => [item.configurationID, item]),
  )
  const facts = new Map(
    input.parts.inspections.map((item) => [item.configuration.configurationID, item]),
  )
  // A configuration's full label among every configuration and reference of the view.
  const displayLabel = modelDisplayLabeler(
    [
      ...input.parts.inspections.map((item) => ({ ...item.configuration.route, variant: null })),
      ...references.map((item) => ({ ...item.estimate.route, variant: null })),
    ],
    candidates,
    [],
  )
  const order = [
    ...overview.graph.points.map((point) => point.configurationID),
    ...references.map((reference) => reference.configurationID),
    ...input.parts.inspections.map((item) => item.configuration.configurationID),
  ]
  const pointByID = new Map(overview.graph.points.map((point) => [point.configurationID, point]))
  const points: DecisionViewPointRow[] = []
  for (const configurationID of new Set(order)) {
    const inspection = facts.get(configurationID)
    // Every graph point and reference is a snapshot row; one without facts is not inspectable.
    if (!inspection) continue
    const point = pointByID.get(configurationID) ?? null
    const at = referenceAt.get(configurationID)
    const reference = at === undefined ? null : references[at]!
    points.push({
      ord: points.length,
      referenceOrd: at ?? null,
      configurationID,
      label: point?.label ?? reference?.label ?? null,
      x: point ? point.tokensPerAcceptedTask : (reference?.tokensPerAcceptedTask ?? null),
      y: point ? point.currentMarketUSDPerAcceptedTask : null,
      frontier: frontier.has(configurationID),
      point,
      reference,
      groupID: inspection.configuration.groupID,
      displayLabel: displayLabel(inspection.configuration.route),
      chart: chartByID.get(configurationID) ?? null,
      chartReference: chartRefByID.get(configurationID) ?? null,
      cost: costs.get(configurationID) ?? null,
      inspection,
    })
  }
  // The Benchmark view: public score against list price, one point per model.
  const label = modelDisplayLabeler(
    candidates.map((candidate) => ({ ...candidate.identity, variant: null })),
    candidates,
    [],
  )
  const baseline = benchmarkBaseline({
    candidates,
    priceSources: input.priceSources,
    sourceDates: input.sourceDates,
    observedRoutes: new Set([
      ...input.parts.inspections.map((item) => routeKey(item.configuration.route)),
      ...chartRefs.map((reference) => routeKey(reference.estimate.route)),
    ]),
    preferredBasis: input.call.basis,
    external,
    label: (route) => label({ ...route, variant: null }),
  })
  // A Benchmark point carries its model's stored costs, the catalog entry's own objects.
  const entryOf = new Map<string, CatalogEntry>()
  for (const entry of catalog.entries) {
    entryOf.set(entry.id, entry)
    entryOf.set(routeKey(entry.route), entry)
  }
  const benchmarkRows: DecisionViewBenchmarkRow[] = [
    ...baseline.points.map((point) => {
      const entry = entryOf.get(point.id) ?? entryOf.get(routeKey(point.route))
      return {
        kind: "point" as const,
        detail: entry
          ? {
              ...point,
              costs: { observed: entry.observed?.cost ?? null, projected: entry.projected },
            }
          : point,
      }
    }),
    ...baseline.gaps.map((gap) => ({ kind: "gap" as const, detail: gap })),
  ].map(({ kind, detail }, ord) => ({
    ord,
    key: `${kind}\u0000${detail.id}`,
    kind,
    label: detail.label,
    score: detail.benchmark.codingIndex,
    observed: "observed" in detail ? detail.observed : false,
    detail,
  }))
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
    sources: input.sources,
    benchmark: {
      scoreBasis: baseline.scoreBasis,
      scoreOptions: scoreOptions(candidates, external),
      unmatchedRoutes: baseline.unmatchedRoutes,
      ambiguousRoutes: baseline.ambiguousRoutes,
      priceSources: baseline.priceSources,
      publicCoverage: input.set?.publicCoverage ?? null,
      catalogRoutes: new Set(candidates.map((candidate) => routeKey(candidate.identity))).size,
    },
    benchmarkRows,
  }
}
