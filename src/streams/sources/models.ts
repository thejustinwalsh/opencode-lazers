import { defineSource, type StreamContext } from "../source.ts"
import {
  MODELS_SOURCES,
  modelCandidateColumns,
  modelCandidateDetail,
  type ModelCandidatesFilter,
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
