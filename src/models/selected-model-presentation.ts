import type { ModelDecisionEfficiency } from "./decision-contract.ts"
import type { ModelCandidate, ModelComparisonPanelData } from "./comparison-state.ts"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"
import { joinSegments } from "./comparison-presentation.ts"
import { formatMoney, formatNumber } from "./panel-shared.ts"

type Inspection = Extract<
  NonNullable<ModelComparisonPanelData["decisionInspection"]>,
  { status: "found" }
>
type Estimate = Inspection["estimate"]

/** Disclosure wording for a selected model. A missing fact drops its segment; nothing says "unknown". */

export function benchmarkLabel(candidate: ModelCandidate) {
  const benchmark = candidate.externalBenchmark
  if (!benchmark) return undefined
  return benchmark.codingIndex === null ? undefined : `Coding index ${benchmark.codingIndex}`
}

export function efficiencySummary(efficiency: ModelDecisionEfficiency) {
  switch (efficiency.status) {
    case "available":
      return joinSegments([
        efficiency.tokensPerAcceptedTask !== null &&
          `${formatNumber(efficiency.tokensPerAcceptedTask)} tokens`,
        efficiency.currentMarketUSDPerAcceptedTask !== null &&
          `${formatMoney(efficiency.currentMarketUSDPerAcceptedTask)} per accepted task`,
        `${efficiency.observationCount} observations`,
      ])
    case "single-observation":
      return joinSegments([
        efficiency.tokensPerAcceptedTask !== null &&
          `${formatNumber(efficiency.tokensPerAcceptedTask)} tokens`,
        efficiency.currentMarketUSDPerAcceptedTask !== null &&
          formatMoney(efficiency.currentMarketUSDPerAcceptedTask),
        "n=1",
      ])
    case "partial":
      return joinSegments([
        "Partial",
        efficiency.tokensPerAcceptedTask !== null &&
          `${formatNumber(efficiency.tokensPerAcceptedTask)} tokens`,
        efficiency.currentMarketUSDPerAcceptedTask !== null &&
          formatMoney(efficiency.currentMarketUSDPerAcceptedTask),
      ])
    case "zero-accepted":
      return "No accepted tasks"
    case "unknown":
      return efficiency.reason
  }
}

function moneyRange(range: { minimum: number; maximum: number }) {
  return range.minimum === range.maximum
    ? formatMoney(range.minimum)
    : `${formatMoney(range.minimum)}–${formatMoney(range.maximum)}`
}

export function referenceCostSummary(estimate: ModelDecisionReferenceEstimate) {
  switch (estimate.status) {
    case "exact":
      return estimate.valueUSDPerAcceptedTask === null
        ? undefined
        : `OpenRouter model catalog scalar reference · ${formatMoney(estimate.valueUSDPerAcceptedTask)} / accepted task`
    case "conditional":
      return estimate.rangeUSDPerAcceptedTask
        ? `OpenRouter model catalog conditional range · ${moneyRange(estimate.rangeUSDPerAcceptedTask)} / accepted task`
        : undefined
    case "partial":
      if (estimate.knownSubtotalUSDPerAcceptedTask !== null)
        return `OpenRouter model catalog priced subtotal only · ${formatMoney(estimate.knownSubtotalUSDPerAcceptedTask)} / accepted task · remainder unknown`
      if (estimate.knownSubtotalRangeUSDPerAcceptedTask)
        return `OpenRouter model catalog priced subtotal range only · ${moneyRange(estimate.knownSubtotalRangeUSDPerAcceptedTask)} / accepted task · remainder unknown`
      return undefined
    case "zero-accepted":
      return "No accepted tasks · no reference per-task amount"
    case "unavailable":
      return undefined
  }
}

export function referenceCategorySummary(
  estimate: ModelDecisionReferenceEstimate,
  category: string,
) {
  const usage = estimate.coverage.categories[category as keyof typeof estimate.coverage.categories]
  return joinSegments([
    usage.tokens !== null && `${formatNumber(usage.tokens)} tokens`,
    `${usage.status} usage`,
    `${usage.rateCoverage} rate coverage`,
  ])
}

export function estimateHeadline(estimate: Estimate) {
  if (estimate.status === "zero-accepted") return "No accepted tasks; no estimate."
  if (estimate.status === "unknown") return undefined
  if (estimate.status === "single-observation")
    return "Empirical observed value · n=1 accepted logical-task history"
  if (estimate.status === "partial")
    return `Partial empirical observed spread · n=${estimate.observationCount}`
  return `Empirical observed spread · n=${estimate.observationCount} accepted logical-task histories`
}

export function estimateValues(estimate: Estimate) {
  if (estimate.status === "zero-accepted") return undefined
  if (estimate.status === "unknown") return undefined
  const range = (
    value: { minimum: number; maximum: number } | null,
    format: typeof formatNumber,
  ) =>
    value
      ? value.minimum === value.maximum
        ? format(value.minimum)
        : `${format(value.minimum)}–${format(value.maximum)}`
      : undefined
  const tokens = range(estimate.range.tokens, formatNumber)
  const price = range(estimate.range.currentMarketUSD, formatMoney)
  return joinSegments([
    tokens && `${tokens} tokens`,
    price,
    estimate.status === "single-observation" && "one value, no interval",
    estimate.status === "partial" && `missing ${estimate.missing.join(", ")}`,
  ])
}

export function estimateUnavailableReason(estimate: Estimate) {
  return estimate.status === "unknown" ? estimate.reason : undefined
}

export function estimateHistoryScope(estimate: Estimate) {
  const historyScope = estimate.historyScope
  if (!historyScope) return undefined
  return joinSegments([
    historyScope.completeness === "complete-accepted-logical-task-retry-history"
      ? "Complete accepted-task retry history"
      : "Accepted-task retry history may be incomplete",
    `Route scope · ${historyScope.routeScope}`,
  ])
}

export function estimateHistoryNote(estimate: Estimate) {
  return estimate.historyScope?.completeness === "complete-accepted-logical-task-retry-history"
    ? "The producer reports complete accepted-task histories, including retries. This is observed spread, not a predictive interval."
    : "Accepted-task retry history may be incomplete. This is observed spread, not a predictive interval."
}

export function contributorMembership(
  membership: "cohort-effort" | "empirical-history" | "both" | undefined,
) {
  switch (membership) {
    case "cohort-effort":
      return "cohort-effort"
    case "empirical-history":
      return "history-only"
    case "both":
      return "both"
    default:
      return undefined
  }
}

export function variantCoverage(candidate: ModelCandidate) {
  const variants = candidate.native.availableVariants
  const coverage = candidate.native.variantCoverage
  if (!variants?.length) return undefined
  const labels = variants.join(", ")
  if (coverage.status === "truncated")
    return `Variants (${variants.length} shown${
      coverage.totalVariants === null ? "" : ` of ${formatNumber(coverage.totalVariants)}`
    }${coverage.omittedVariants === null ? "" : `; ${formatNumber(coverage.omittedVariants)} omitted`}): ${labels}`
  if (coverage.status === "complete" && coverage.totalVariants !== null)
    return `Variants (${formatNumber(coverage.totalVariants)}): ${labels}`
  return `Variants: ${labels}`
}

export const referenceUsageCategories = [
  ["uncachedInput", "Uncached input"],
  ["output", "Output"],
  ["reasoning", "Reasoning"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write"],
] as const
