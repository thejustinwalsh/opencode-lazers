import { needsRepair } from "../audit/audit-findings.ts"
import type { FallowAcceptance, FallowDisposition, FallowPackage } from "../audit/contract.ts"
import { renderRepair } from "../audit/fallow-render.ts"
import type { FallowReviewInput, FallowReviewResult } from "../audit/review.ts"
import { FALLOW_CHECK_ID } from "../task.ts"
import type { RunnerCheckReceipt } from "./artifacts.ts"

/** Reserved verification ID: authored checks cannot use it. */
export { FALLOW_CHECK_ID } from "../task.ts"
export const FALLOW_CHECK_COMMAND = "lazers:fallow-audit"
/** The runtime-run verify step: mechanical fix, authored checks, then `verify:fallow-audit`. */
export const FALLOW_EFFECT_KIND = "verify:fallow-audit"
/** The plan-level review of the combined artifact; never holds or fails the plan. */
export const FALLOW_PLAN_EFFECT_KIND = "graph-verify:fallow-audit"

/** Effect kinds recorded before the rename stay recognised; nothing rewrites them. */
export const isFallowEffectKind = (kind: string, current: string): boolean =>
  kind === current ||
  kind === (current === FALLOW_EFFECT_KIND ? "verify:lazers-fallow" : "graph-verify:lazers-fallow")

const OUTCOME_ITEM_LIMIT = 10

export type FallowReview = (input: FallowReviewInput) => Promise<FallowReviewResult>

/** Loads the plan review on first use, like the task review. */
export const defaultFallowPlanReview: FallowReview = async (input) =>
  (await import("../audit/review-plan.ts")).fallowPlanReview(input)

/** Loads the analyzer on first use so a service that never verifies never pays for it. */
export const defaultFallowReview: FallowReview = async (input) =>
  (await import("../audit/review.ts")).fallowReview(input)

/** The package of a review that ran; undefined when it was unavailable. */
const packageOf = (result: FallowReviewResult | undefined): FallowPackage | undefined =>
  result?.package

/** Findings the change introduced or worsened (what the worker is asked about). */
function liveFindingCount(result: FallowReviewResult | undefined): number {
  const pkg = packageOf(result)
  return pkg ? pkg.summary.errors + pkg.summary.warnings : 0
}

export function fallowReasonText(pkg: FallowPackage): string {
  return `Verification ${FALLOW_CHECK_ID} ${pkg.verdict}: ${pkg.summary.errors} errors, ${pkg.summary.warnings} warnings`
}

/**
 * The review as a check receipt. Exit 1 when the audit warns or fails on the change, with the
 * rendered package as the output the one repair is given.
 */
export function fallowCheckReceipt(input: {
  id: string
  workspace: string
  artifact: string
  inputIdentity: string
  environmentIdentity: string
  startedAt: number
  endedAt: number
  result: FallowReviewResult
  /** The plan-level review reports but never fails: exit 0 whatever it found. */
  advisory?: boolean
}): RunnerCheckReceipt {
  const pkg = packageOf(input.result)
  const failing = !input.advisory && needsRepair(pkg)
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
    stdout: failing && pkg ? renderRepair(pkg) : "",
    stderr: "",
    fallow: input.result,
  }
}

export function unavailableFallowResult(reason: string): FallowReviewResult {
  return { status: "unavailable", reason }
}

/** What an accepted task reports to the Architect; absent when nothing remains to say. */
export function fallowOutcome(
  result: FallowReviewResult | undefined,
  dispositions?: FallowDisposition[],
): FallowAcceptance | undefined {
  const pkg = packageOf(result)
  if (!pkg || (liveFindingCount(result) === 0 && !dispositions?.length)) return undefined
  const live = pkg.findings.filter((f) => f.attribution !== "inherited")
  return {
    package: { ...pkg, findings: live.slice(0, OUTCOME_ITEM_LIMIT) },
    ...(dispositions?.length ? { dispositions } : {}),
  }
}
