import type { Columns } from "../frame.ts"

/**
 * The Models sources, the part a consumer without a database needs: names, columns and filters.
 * The GUI imports this file; `models.ts` defines the sources from the same columns.
 */
export const MODELS_SOURCES = {
  candidates: "models.candidates",
} as const

/** Every Models filter: the project is set by the service, whatever the caller sends. */
type Scoped = { projectDirectory: string; sessionID: string }

/** A project's comparison candidates; the picker reads `enabled: true`. */
export type ModelCandidatesFilter = Scoped & { enabled?: boolean; providerID?: string }

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
