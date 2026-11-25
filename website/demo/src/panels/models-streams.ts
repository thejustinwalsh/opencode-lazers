import type { Columns } from "../../../../src/streams/frame.ts"
import {
  MODELS_SOURCES,
  modelAssignmentColumns,
  modelBenchmarkColumns,
  modelCandidateColumns,
  modelCandidateDetail,
  modelCatalogColumns,
  modelContributorColumns,
  modelPointColumns,
  modelPricePolicyColumns,
  modelViewColumns,
  modelViewDetail,
} from "../../../../src/streams/sources/models-ref.ts"
import { routedModels } from "../../../../src/models/catalog-inputs.ts"
import {
  buildDecisionView,
  type DecisionViewRequest,
  type DecisionViewRows,
} from "../../../../src/models/decision-view-build.ts"
import type { ModelDecisionInspect } from "../../../../src/models/decision-contract.ts"
import { streamAnswers, type DemoRow, type Open } from "./stream-answers.ts"
import type { ModelSettingsOutput } from "../../../../src/models/contract.ts"
import type { ModelComparisonOutput } from "../../../../src/models/comparison-schema.ts"
import type {
  ModelDecisionFilters,
  ModelDecisionOverview,
} from "../../../../src/models/decision-contract.ts"
import type {
  ModelPriceSource,
  ModelPriceSourcePolicy,
} from "../../../../src/models/price-source-settings.ts"

/** What the demo's mock data answers, handed in by `models-answers.ts`. */
export type ModelsDemoReads = {
  overview(filters: ModelDecisionFilters): ModelDecisionOverview
  inspect(filters: ModelDecisionFilters, configurationID: string): ModelDecisionInspect
  comparison(): ModelComparisonOutput
  settings(taskID: string | undefined): ModelSettingsOutput
  priceSources: readonly ModelPriceSource[]
  pricePolicy: ModelPriceSourcePolicy
  pricesRetrievedAt: string
}

/**
 * The demo's answer to the Models streams: the stored view the service would write for the
 * panel's selection, computed by the real view builder (`buildDecisionView`) from the demo's
 * mock overview, inspections and candidates, and served as real frames. A view is ready at once;
 * the demo never builds one in the background.
 */

type Found = Extract<ModelDecisionInspect, { status: "found" }>
const VIEW_ID = 1

const sources: Record<string, { columns: Columns; key: string[] }> = {
  [MODELS_SOURCES.view]: { columns: { ...modelViewColumns, ...modelViewDetail }, key: ["id"] },
  [MODELS_SOURCES.points]: { columns: modelPointColumns, key: ["id"] },
  [MODELS_SOURCES.catalog]: { columns: modelCatalogColumns, key: ["id"] },
  [MODELS_SOURCES.benchmark]: { columns: modelBenchmarkColumns, key: ["id"] },
  [MODELS_SOURCES.contributors]: { columns: modelContributorColumns, key: ["id"] },
  [MODELS_SOURCES.assignments]: { columns: modelAssignmentColumns, key: ["id"] },
  [MODELS_SOURCES.pricePolicy]: { columns: modelPricePolicyColumns, key: ["project_directory"] },
  [MODELS_SOURCES.candidates]: {
    columns: { ...modelCandidateColumns, ...modelCandidateDetail },
    key: ["id"],
  },
}

/** The view of one selection, as `decision-view-build.ts` computes it for the service. */
function viewRows(reads: ModelsDemoReads, request: DecisionViewRequest) {
  const shown = reads.overview(request.filters)
  // Every configuration the overview names, plotted or referenced, once.
  const ids = new Set([
    ...shown.graph.points.map((point) => point.configurationID),
    ...(shown.graph.referenceEstimates ?? []).map((reference) => reference.configurationID),
  ])
  const found = [...ids].flatMap((id) => {
    const page = reads.inspect(request.filters, id)
    return page.status === "found" ? [page as Found] : []
  })
  const compared = reads.comparison()
  return buildDecisionView({
    parts: {
      overview: shown,
      sourceRevision: 1,
      priceIdentity: "demo",
      contributors: found.map((page) => ({
        configurationID: page.configuration.configurationID,
        contributors: page.contributorPage.contributors,
      })),
      inspections: found.map(
        ({ status: _s, context: _c, selectedTaskID: _t, contributorPage: _p, ...facts }) =>
          facts as never,
      ),
    },
    set: {
      snapshotSet: "demo",
      candidates: compared.candidates,
      external: compared.publicCatalog ?? [],
      publicCoverage: compared.publicCoverage ?? null,
    },
    call: {
      ...request,
      routed: routedModels(reads.settings(request.taskID ?? undefined)),
      known: null,
    },
    priceSources: reads.priceSources,
    sourceDates: {
      openrouter: reads.pricesRetrievedAt,
      opencode: reads.pricesRetrievedAt,
      modelsDev: null,
    },
    sources: compared.sources,
    identity: "demo",
  })
}

const withIDs = (rows: DemoRow[]) => rows.map((row, index) => ({ id: index + 1, ...row }))

function viewSourceRows(view: DecisionViewRows, open: Open): DemoRow[] {
  switch (open.source) {
    case MODELS_SOURCES.view:
      return [
        {
          id: VIEW_ID,
          state: "ready",
          entry_count: view.entries.length,
          point_count: view.points.length,
          benchmark_count: view.benchmarkRows.length,
          revision: view.revision,
          produced_at: Date.now(),
          last_error: null,
          context: view.context,
          counts: view.counts,
          summary: view.summary,
          sources: view.sources,
          benchmark: view.benchmark,
        },
      ]
    case MODELS_SOURCES.points:
      return withIDs(
        view.points.map((point) => ({
          ord: point.ord,
          reference_ord: point.referenceOrd,
          configuration_id: point.configurationID,
          group_id: point.groupID,
          label: point.label,
          display_label: point.displayLabel,
          x: point.x,
          y: point.y,
          frontier: point.frontier,
          point: point.point,
          reference: point.reference,
          chart: point.chart,
          chart_reference: point.chartReference,
          cost: point.cost,
          inspection: point.inspection,
        })),
      )
    case MODELS_SOURCES.catalog:
      return withIDs(
        view.entries.map((entry) => ({
          rank: entry.rank,
          entry_key: entry.key,
          label: entry.label,
          tags: entry.tags,
          cost_per_task: entry.costPerTask,
          tokens: entry.tokens,
          accepted: entry.accepted,
          score: entry.score,
          frontier: entry.frontier,
          observed: entry.observed,
          price_source: entry.priceSource,
          detail: entry.detail,
        })),
      )
    case MODELS_SOURCES.benchmark:
      return withIDs(
        view.benchmarkRows.map((row) => ({
          ord: row.ord,
          kind: row.kind,
          label: row.label,
          score: row.score,
          observed: row.observed,
          detail: row.detail,
        })),
      )
    case MODELS_SOURCES.contributors: {
      const filter = open.filter as {
        configurationID: string
        taskID?: string
        exceptTaskID?: string
      }
      return withIDs(
        view.contributors
          .filter(
            (row) =>
              row.configurationID === filter.configurationID &&
              (filter.taskID === undefined || row.taskID === filter.taskID) &&
              (filter.exceptTaskID === undefined || row.taskID !== filter.exceptTaskID),
          )
          .map((row) => ({ ord: row.ord, task_id: row.taskID, detail: row.detail })),
      )
    }
    default:
      return []
  }
}

/** The assignments' layer rows, as `model_assignment_view` holds them for the selected task. */
function assignmentRows(reads: ModelsDemoReads, taskID: string | null): DemoRow[] {
  const shown = reads.settings(taskID ?? undefined)
  const rows: DemoRow[] = []
  for (const persona of shown.personas)
    for (const layer of ["shared", "project", "task"] as const) {
      const record = persona.layers[layer]
      if (record)
        rows.push({
          layer,
          task_id: layer === "task" ? (taskID ?? "") : "",
          subject: persona.persona,
          revision: record.revision,
          record,
        })
    }
  // The host names no model of its own for the demo's agents (a LAZERS route is what they run),
  // unless an agent's source says the model is native or the plugin's default.
  for (const agent of shown.agents ?? []) {
    const hosted = agent.source === "native" || agent.source === "plugin-default"
    rows.push({
      layer: "host",
      task_id: "",
      subject: agent.agentID,
      revision: 1,
      record: {
        reachable: true,
        model: hosted ? agent.model : null,
        pluginDefault: agent.source === "plugin-default",
      },
    })
  }
  return withIDs(rows.toSorted((a, b) => String(a.subject).localeCompare(String(b.subject))))
}

function candidateRows(reads: ModelsDemoReads, open: Open): DemoRow[] {
  const filter = open.filter as { enabled?: boolean; providerID?: string; modelID?: string }
  return withIDs(
    reads
      .comparison()
      .candidates.filter(
        (candidate) =>
          (filter.enabled === undefined || candidate.native.enabled === filter.enabled) &&
          (filter.providerID === undefined ||
            candidate.identity.providerID === filter.providerID) &&
          (filter.modelID === undefined || candidate.identity.modelID === filter.modelID),
      )
      .map((candidate) => {
        const tier = candidate.native.prices?.tiers.find(
          (entry) => entry.contextTierTokens === null,
        )
        return {
          candidate_id: candidate.candidateID,
          provider_id: candidate.identity.providerID,
          model_id: candidate.identity.modelID,
          variant: candidate.identity.variant,
          name: candidate.native.name,
          enabled: candidate.native.enabled,
          context_tokens: candidate.native.contextTokens,
          price_input: tier?.input ?? null,
          price_output: tier?.output ?? null,
          correspondence: candidate.correspondence.status,
          benchmark_correspondence: candidate.benchmarkCorrespondence.status,
          detail: candidate,
        }
      }),
  )
}

/** `version` changes when the mock data does; a view is computed once per version and selection. */
export function modelStreams(reads: () => ModelsDemoReads, version: () => unknown) {
  const views = new Map<string, { version: unknown; rows: DecisionViewRows }>()
  const viewOf = (request: DecisionViewRequest) => {
    const key = JSON.stringify([request.filters, request.basis ?? null, request.taskID ?? null])
    const current = version()
    const cached = views.get(key)
    if (cached && cached.version === current) return cached.rows
    const rows = viewRows(reads(), {
      filters: request.filters,
      basis: request.basis ?? null,
      taskID: request.taskID ?? null,
    })
    views.set(key, { version: current, rows })
    return rows
  }
  return streamAnswers(sources, (open) => {
    if (open.source === MODELS_SOURCES.assignments)
      return assignmentRows(reads(), (open.filter.taskID as string | null) ?? null)
    if (open.source === MODELS_SOURCES.pricePolicy) {
      const policy = reads().pricePolicy
      return [
        {
          project_directory: String(open.filter.projectDirectory ?? ""),
          revision: policy.revision,
          sources: policy.sources,
        },
      ]
    }
    if (open.source === MODELS_SOURCES.candidates) return candidateRows(reads(), open)
    const request = open.filter.view as DecisionViewRequest | undefined
    return request ? viewSourceRows(viewOf(request), open) : []
  })
}

type StreamHandlers = ReturnType<typeof streamAnswers>

/** One `lazers.streams` answer over two: a stream stays with the answer that opened it. */
export function combinedStreams(models: StreamHandlers, other: StreamHandlers): StreamHandlers {
  const owner = new Map<string, StreamHandlers>()
  const of = (stream: string) => owner.get(stream) ?? other
  return {
    ...other,
    open: (input) => {
      const target = input.source.startsWith("models.") ? models : other
      owner.set(input.stream, target)
      return target.open(input)
    },
    slide: (input) => of(input.stream).slide(input),
    seek: (input) => of(input.stream).seek(input),
    read: (input) => of(input.stream).read(input),
    touch: () => ({ alive: true }),
    close: (input) => {
      const target = of(input.stream)
      owner.delete(input.stream)
      return target.close(input)
    },
  }
}
