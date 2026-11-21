import { defineSource, type StreamContext } from "../source.ts"
import {
  openDecisionViewFor,
  refreshHostAgentsFor,
  releaseDecisionViewFor,
} from "../../models/decision-view-registry.ts"
import {
  MODELS_SOURCES,
  modelCandidateColumns,
  modelCandidateDetail,
  modelCatalogColumns,
  modelAssignmentColumns,
  modelContributorColumns,
  modelPointColumns,
  modelViewColumns,
  modelViewDetail,
  type ModelAssignmentsFilter,
  type ModelCandidatesFilter,
  type ModelCatalogFilter,
  type ModelContributorsFilter,
  type ModelPointsFilter,
  type ModelViewFilter,
} from "./models-ref.ts"

/**
 * The Models sources, over stored rows only (`.agents/plans/panel-streams.md`, Panel 3).
 *
 * Scope checks carried over from the replaced RPCs (`src/models/server.ts`): an eligible session of
 * this project and the RPC's own permission (`context.assertAction`), and the project is the
 * service's own directory, whatever the caller sent.
 */
async function scoped<F extends { sessionID: string; projectDirectory: string }>(
  input: F,
  context: StreamContext,
  action: string,
): Promise<F> {
  if (!input.sessionID) throw new Error("Models scope is unavailable")
  if (!context.assertAction) throw new Error("Models scope is unavailable")
  await context.assertAction(input.sessionID, action)
  return { ...input, projectDirectory: context.projectDirectory }
}

/**
 * Comparison candidates (`model_candidates`), in the comparison read's order: provider, model,
 * then variant with the model's own entry (NULL) first. Replaces `comparison` pages and the
 * `catalog` RPC's picker list (`lz-read-model-comparison`).
 */
export const modelCandidatesSource = defineSource({
  name: MODELS_SOURCES.candidates,
  table: "model_candidates",
  key: ["id"],
  orders: {
    catalog: [
      { column: "provider_id", direction: "asc" },
      { column: "model_id", direction: "asc" },
      { column: "variant", direction: "asc" },
      { column: "id", direction: "asc" },
    ],
  },
  authorize(input: ModelCandidatesFilter, context) {
    return scoped(input, context, "lz-read-model-comparison")
  },
  filter(input: ModelCandidatesFilter) {
    const clauses = ["model_candidates.project_directory = ?"]
    const params: (string | number)[] = [input.projectDirectory]
    if (input.enabled !== undefined) {
      clauses.push("model_candidates.enabled = ?")
      params.push(input.enabled ? 1 : 0)
    }
    if (input.providerID !== undefined) {
      clauses.push("model_candidates.provider_id = ?")
      params.push(input.providerID)
    }
    return { where: clauses.join(" AND "), params }
  },
  columns: modelCandidateColumns,
  detail: modelCandidateDetail,
})

/**
 * The view-backed sources: `authorize` checks the session, then opens the view of the selection
 * (a point write on the main thread that starts its build) and sets `viewID`; `filter` reads only
 * that view's rows. A view nobody opened for 7 days is dropped, and the next open builds it again.
 */
async function viewScoped<F extends ModelViewFilter>(
  input: F,
  context: StreamContext,
  action: string,
): Promise<F> {
  const checked = await scoped(input, context, action)
  const viewID = openDecisionViewFor(context.projectDirectory, input.view)
  return { ...checked, viewID }
}

/** The stream that held the view closed or expired: the view may stop refreshing. */
const viewReleased = (input: ModelViewFilter) => {
  if (input.viewID !== undefined) releaseDecisionViewFor(input.projectDirectory, input.viewID)
}

const viewID = (input: { viewID?: number }) => {
  if (input.viewID === undefined) throw new Error("Models scope is unavailable")
  return input.viewID
}

/** The view row: its building or ready state, counts and, at `window: 1`, the decision context. */
export const modelViewSource = defineSource({
  name: MODELS_SOURCES.view,
  table: "model_decision_views",
  key: ["id"],
  orders: { key: [{ column: "id", direction: "asc" }] },
  authorize(input: ModelViewFilter, context) {
    return viewScoped(input, context, "lz-read-model-decision")
  },
  release: viewReleased,
  filter(input: ModelViewFilter) {
    return { where: "model_decision_views.id = ?", params: [viewID(input)] }
  },
  columns: modelViewColumns,
  detail: modelViewDetail,
})

/** The "All models" table, best trade-off first (`rankCatalog`). A view holds about 100 rows. */
export const modelCatalogSource = defineSource({
  name: MODELS_SOURCES.catalog,
  table: "model_catalog_entries",
  key: ["id"],
  orders: {
    rank: [
      { column: "rank", direction: "asc" },
      { column: "id", direction: "asc" },
    ],
  },
  count: { exact: "scan" },
  authorize(input: ModelCatalogFilter, context) {
    return viewScoped(input, context, "lz-read-model-comparison")
  },
  release: viewReleased,
  filter(input: ModelCatalogFilter) {
    return { where: "model_catalog_entries.view_id = ?", params: [viewID(input)] }
  },
  columns: modelCatalogColumns,
})

/** The chart's configurations in the overview's point order, reference-only ones after. */
export const modelPointsSource = defineSource({
  name: MODELS_SOURCES.points,
  table: "model_decision_points",
  key: ["id"],
  orders: {
    chart: [
      { column: "ord", direction: "asc" },
      { column: "id", direction: "asc" },
    ],
  },
  count: { exact: "scan" },
  authorize(input: ModelPointsFilter, context) {
    return viewScoped(input, context, "lz-read-model-decision")
  },
  release: viewReleased,
  filter(input: ModelPointsFilter) {
    return { where: "model_decision_points.view_id = ?", params: [viewID(input)] }
  },
  columns: modelPointColumns,
})

/** One configuration's contributors (the pane), in the inspection's order. */
export const modelContributorsSource = defineSource({
  name: MODELS_SOURCES.contributors,
  table: "model_decision_contributors",
  key: ["id"],
  orders: {
    inspection: [
      { column: "ord", direction: "asc" },
      { column: "id", direction: "asc" },
    ],
  },
  authorize(input: ModelContributorsFilter, context) {
    return viewScoped(input, context, "lz-read-model-decision")
  },
  release: viewReleased,
  filter(input: ModelContributorsFilter) {
    return {
      where:
        "model_decision_contributors.view_id = ? AND model_decision_contributors.configuration_id = ?",
      params: [viewID(input), input.configurationID],
    }
  },
  columns: modelContributorColumns,
})

/**
 * The Models assignments (`model_assignment_view`): the shared layer, this project's layer and
 * host rows, and the selected task's layer. Replaces the `settings` RPC (`lz-get-model-settings`).
 */
export const modelAssignmentsSource = defineSource({
  name: MODELS_SOURCES.assignments,
  table: "model_assignment_view",
  key: ["id"],
  orders: {
    subject: [
      { column: "subject", direction: "asc" },
      { column: "layer", direction: "asc" },
      { column: "id", direction: "asc" },
    ],
  },
  count: { exact: "scan" },
  async authorize(input: ModelAssignmentsFilter, context) {
    const checked = await scoped(input, context, "lz-get-model-settings")
    refreshHostAgentsFor(context.projectDirectory)
    return checked
  },
  filter(input: ModelAssignmentsFilter) {
    return {
      where: `(model_assignment_view.layer = 'shared' OR (model_assignment_view.project_directory = ?
        AND (model_assignment_view.layer IN ('project','host')
          OR (model_assignment_view.layer = 'task' AND model_assignment_view.task_id = ?))))`,
      params: [input.projectDirectory, input.taskID ?? ""],
    }
  },
  columns: modelAssignmentColumns,
})
