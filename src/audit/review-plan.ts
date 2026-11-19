import { fallowReview, type FallowReviewInput, type FallowReviewResult } from "./review.ts"
import { unconsumedSuppressions, withExtraFindings } from "./suppression-flow.ts"

/**
 * Fallow audit of a combined plan artifact against the plan's base commit: the same audit as the
 * task review, run over the whole combined change, so a clone between two tasks, or an import
 * cycle two tasks close together, is found. It is advisory (the runtime never fails or holds a
 * plan on it); findings keep their task attribution through `attributeFindingsToTasks`.
 *
 * It also settles the suppressions the plan's tasks added for code left unused ahead of its
 * consumer: one the consumer left behind is already a stale-suppression finding (attributed to
 * the consuming task); one still covering unused code at the plan's end is reported here as
 * unconsumed, attributed to the task that added it.
 */
export async function fallowPlanReview(input: FallowReviewInput): Promise<FallowReviewResult> {
  const result = await fallowReview(input)
  if (!result.package) return result
  const pkg = withExtraFindings(result.package, unconsumedSuppressions(result.package))
  return {
    ...result,
    package: pkg,
    status: pkg.summary.errors + pkg.summary.warnings === 0 ? "clean" : "findings",
  }
}
