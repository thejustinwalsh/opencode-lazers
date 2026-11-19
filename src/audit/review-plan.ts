import { fallowReview, type FallowReviewInput, type FallowReviewResult } from "./review.ts"

/**
 * Fallow audit of a combined plan artifact against the plan's base commit: the same audit as the
 * task review, run over the whole combined change, so a clone between two tasks, or an import
 * cycle two tasks close together, is found. It is advisory (the runtime never fails or holds a
 * plan on it); findings keep their task attribution through `attributeFindingsToTasks`.
 */
export function fallowPlanReview(input: FallowReviewInput): Promise<FallowReviewResult> {
  return fallowReview(input)
}
