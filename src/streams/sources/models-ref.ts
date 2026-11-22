import type { Columns } from "../frame.ts"
import { sourceRef, type SourceRef } from "../source.ts"

/**
 * The Models sources, the part a consumer without a database needs: names, columns and filters.
 * The GUI imports this file; `models.ts` defines the sources from the same columns.
 */
export const MODELS_SOURCES = {
  candidates: "models.candidates",
  view: "models.view",
  catalog: "models.catalog",
  points: "models.points",
  contributors: "models.contributors",
  assignments: "models.assignments",
  benchmark: "models.benchmark",
} as const

/** Every Models filter: the project is set by the service, whatever the caller sends. */
type Scoped = { projectDirectory: string; sessionID: string }

/** A project's comparison candidates; the picker reads `enabled: true`. */
export type ModelCandidatesFilter = Scoped & {
  enabled?: boolean
  providerID?: string
  modelID?: string
}

const candidateColumns = {
  id: "int",
  candidate_id: "text",
  provider_id: "text",
  model_id: "text",
  /** Null for the model's own entry; it sorts first. */
  variant: "text",
  name: "text",
  /** Null when the catalog's records disagree. */
  enabled: "bool",
  context_tokens: "int",
  /** The native catalog's unconditional tier, USD per million tokens; null: omit the price. */
  price_input: "float",
  price_output: "float",
  /** `exact`, `ambiguous` or `unresolved`. */
  correspondence: "text",
  benchmark_correspondence: "text",
} as const satisfies Columns

/** The whole candidate, as the comparison read returned it (`ModelComparisonCandidateSchema`). */
const candidateDetail = { detail: "json" } as const satisfies Columns

export const modelCandidateColumns = candidateColumns
export const modelCandidateDetail = candidateDetail

/**
 * A stored decision view, named by what it shows: the decision filters (persona, task kind,
 * period), the score basis the user picked and the task whose routes count as routed. `authorize`
 * opens the view (created on first open, built in the decision worker) and sets `viewID`.
 */
type DecisionViewSelection = {
  filters: {
    persona: string | null
    taskKind: string | null
    period: { from: string | null; to: string | null }
  }
  basis?: string | null
  taskID?: string | null
}
type ViewScoped = Scoped & { view: DecisionViewSelection; viewID?: number }
export type ModelViewFilter = ViewScoped
export type ModelCatalogFilter = ViewScoped
export type ModelPointsFilter = ViewScoped
/**
 * `taskID` reads only that task's contributors, `exceptTaskID` all others: the pane shows the
 * selected task's first, then the rest, each in the inspection's order.
 */
export type ModelContributorsFilter = ViewScoped & {
  configurationID: string
  taskID?: string
  exceptTaskID?: string
}
export type ModelBenchmarkFilter = ViewScoped

/** The view's state: `backfilling` until its first build is written (shown as building), then `ready`. */
export const modelViewColumns = {
  id: "int",
  state: "text",
  entry_count: "int",
  point_count: "int",
  benchmark_count: "int",
  revision: "int",
  produced_at: "int",
  last_error: "text",
} as const satisfies Columns
/**
 * The decision context (price index and its provenance), counts, the catalog's summary, the
 * sources' record-free summaries and refresh states, and the Benchmark view's basis and options.
 */
export const modelViewDetail = {
  context: "json",
  counts: "json",
  summary: "json",
  sources: "json",
  benchmark: "json",
} as const satisfies Columns

/** A ranked catalog row; `price_source` is the source of the price taken, null when unpriced. */
export const modelCatalogColumns = {
  id: "int",
  rank: "int",
  entry_key: "text",
  label: "text",
  tags: "text",
  cost_per_task: "float",
  tokens: "float",
  accepted: "int",
  score: "float",
  frontier: "bool",
  observed: "bool",
  price_source: "text",
  /**
   * The whole `CatalogEntry`: price with provenance, the projected cost and the observed facts
   * with the observed configuration's stored cost. `cost_per_task` is the rank's order key only.
   */
  detail: "json",
} as const satisfies Columns

/**
 * A configuration of the view: a graph point, a reference estimate, both or neither, with what the
 * chart draws for it (`chart`, `chart_reference`), its display label and its inspection facts.
 */
export const modelPointColumns = {
  id: "int",
  ord: "int",
  reference_ord: "int",
  configuration_id: "text",
  group_id: "text",
  label: "text",
  display_label: "text",
  x: "float",
  y: "float",
  frontier: "bool",
  point: "json",
  reference: "json",
  chart: "json",
  chart_reference: "json",
  /** The configuration's one displayed cost (`ConfigurationCost`, observed basis). */
  cost: "json",
  inspection: "json",
} as const satisfies Columns

/** A Benchmark chart row: `point` (scored and priced) or `gap` (left off, with its reason). */
export const modelBenchmarkColumns = {
  id: "int",
  ord: "int",
  kind: "text",
  label: "text",
  score: "float",
  observed: "bool",
  detail: "json",
} as const satisfies Columns

/** A configuration's contributors in the inspection's order (no task selected). */
export const modelContributorColumns = {
  id: "int",
  ord: "int",
  task_id: "text",
  detail: "json",
} as const satisfies Columns

/** The assignments of the project, plus the task layer of `taskID` when one is selected. */
export type ModelAssignmentsFilter = Scoped & { taskID?: string | null }

/** One layer row (`model_assignment_view`): a mapping record, or an agent's host fact. */
export const modelAssignmentColumns = {
  id: "int",
  layer: "text",
  task_id: "text",
  subject: "text",
  revision: "int",
  record: "json",
} as const satisfies Columns

/**
 * Rows of one read: 7 subjects in the shared and project layers, 3 personas in the task layer and
 * 4 agents' host rows, at most 21; the window is that bound (`ASSIGNMENT_SUBJECTS`).
 */
export const MODEL_ASSIGNMENTS_WINDOW = 7 + 7 + 3 + 4

export const modelCandidatesRef: SourceRef<ModelCandidatesFilter, typeof candidateColumns> =
  sourceRef({ name: MODELS_SOURCES.candidates, columns: candidateColumns, detail: candidateDetail })
export const modelViewRef: SourceRef<ModelViewFilter, typeof modelViewColumns> = sourceRef({
  name: MODELS_SOURCES.view,
  columns: modelViewColumns,
  detail: modelViewDetail,
})
export const modelCatalogRef: SourceRef<ModelCatalogFilter, typeof modelCatalogColumns> = sourceRef(
  { name: MODELS_SOURCES.catalog, columns: modelCatalogColumns },
)
export const modelPointsRef: SourceRef<ModelPointsFilter, typeof modelPointColumns> = sourceRef({
  name: MODELS_SOURCES.points,
  columns: modelPointColumns,
})
export const modelContributorsRef: SourceRef<
  ModelContributorsFilter,
  typeof modelContributorColumns
> = sourceRef({ name: MODELS_SOURCES.contributors, columns: modelContributorColumns })
export const modelAssignmentsRef: SourceRef<ModelAssignmentsFilter, typeof modelAssignmentColumns> =
  sourceRef({ name: MODELS_SOURCES.assignments, columns: modelAssignmentColumns })
export const modelBenchmarkRef: SourceRef<ModelBenchmarkFilter, typeof modelBenchmarkColumns> =
  sourceRef({ name: MODELS_SOURCES.benchmark, columns: modelBenchmarkColumns })
