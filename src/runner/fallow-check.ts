import { fallowGuidance } from "../audit/review.ts"
import type { Finding, FallowReviewInput, FallowReviewResult } from "../audit/review.ts"
import type { CheckReceipt } from "./artifacts.ts"

/** Reserved verification ID: authored checks cannot use it. */
export { FALLOW_CHECK_ID } from "../task.ts"
export const FALLOW_CHECK_COMMAND = "lazers:fallow-review"
export const FALLOW_EFFECT_KIND = "verify:lazers-fallow"
const OUTCOME_ITEM_LIMIT = 10

export type FallowReview = (input: FallowReviewInput) => Promise<FallowReviewResult>

/** Loads the analyzer on first use so a service that never verifies never pays for it. */
export const defaultFallowReview: FallowReview = async (input) =>
  (await import("../audit/review.ts")).fallowReview(input)

export function fallowReasonText(introduced: number): string {
  return `Verification lazers-fallow found ${introduced} introduced findings`
}

/** The review as a check receipt: exit 1 only when the task introduced findings. */
export function fallowCheckReceipt(input: {
  id: string
  workspace: string
  artifact: string
  inputIdentity: string
  environmentIdentity: string
  startedAt: number
  endedAt: number
  result: FallowReviewResult
}): CheckReceipt {
  const failing = input.result.introduced.length > 0
  return {
    id: input.id,
    command: FALLOW_CHECK_COMMAND,
    cwd: input.workspace,
    artifact: input.artifact,
    inputIdentity: input.inputIdentity,
    environmentIdentity: input.environmentIdentity,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    exitCode: failing ? 1 : 0,
    timedOut: false,
    stdout: failing ? fallowGuidance(input.result) : "",
    stderr: "",
    fallow: input.result,
  }
}

export function unavailableFallowResult(reason: string): FallowReviewResult {
  return {
    status: "unavailable",
    introduced: [],
    concerns: [],
    thresholds: { cyclomatic: 20, cognitive: 15 },
    configSource: "defaults",
    reason,
  }
}

/** What an accepted task reports to the Architect; absent when nothing remains. */
export function fallowOutcome(
  result: FallowReviewResult | undefined,
): { introduced: Finding[]; concerns: Finding[] } | undefined {
  if (!result || result.introduced.length + result.concerns.length === 0) return undefined
  return {
    introduced: result.introduced.slice(0, OUTCOME_ITEM_LIMIT),
    concerns: result.concerns.slice(0, OUTCOME_ITEM_LIMIT),
  }
}
