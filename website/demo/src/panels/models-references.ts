import type { ModelDecisionOverview } from "../../../../src/models/decision-contract.ts"
import { ModelDecisionReferenceEstimateSchema } from "../../../../src/models/reference-estimate.ts"
import type { ModelComparisonOutput } from "../../../../src/models/comparison-schema.ts"

/**
 * The overview the service stores holds an OpenRouter reference estimate for each plotted
 * configuration (the mock overview builds none; this adds them): the catalog's observed facts and the
 * projected ranking's token profile come from them.
 */
export function withReferences(overview: ModelDecisionOverview): ModelDecisionOverview {
  const category = (tokens: number) => ({
    tokens,
    status: "observed" as const,
    rateCoverage: "complete" as const,
  })
  return {
    ...overview,
    graph: {
      ...overview.graph,
      referenceEstimates: overview.graph.points.map((point) => {
        const [, route = "", variant = "none"] =
          /^configuration:(.*)::(.*)$/.exec(point.configurationID) ?? []
        const [providerID = "", ...rest] = route.split("/")
        const tokens = point.tokensPerAcceptedTask
        return {
          configurationID: point.configurationID,
          label: point.label,
          tokensPerAcceptedTask: tokens,
          estimate: ModelDecisionReferenceEstimateSchema.parse({
            status: "exact",
            basis: "openrouter-published-model-reference-cost-per-accepted-task",
            route: {
              providerID,
              modelID: rest.join("/"),
              variant: variant === "none" ? null : variant,
            },
            acceptedTaskCount: point.acceptedTaskCount,
            numeratorUSD: point.currentMarketUSDPerAcceptedTask * point.acceptedTaskCount,
            numeratorRangeUSD: null,
            valueUSDPerAcceptedTask: point.currentMarketUSDPerAcceptedTask,
            rangeUSDPerAcceptedTask: null,
            knownSubtotalUSD: null,
            knownSubtotalRangeUSD: null,
            knownSubtotalUSDPerAcceptedTask: null,
            knownSubtotalRangeUSDPerAcceptedTask: null,
            identityStatus: "exact",
            provenance: {
              source: "openrouter-models",
              policyRevision: 0,
              availability: "available",
              access: "configured",
              snapshotID: "33333333-3333-4333-8333-333333333333",
              generation: 337,
              retrievedAt: "2026-11-19T17:21:30.333Z",
              sourceURL: "https://openrouter.ai/api/v1/models",
              recordID: route,
              recordIndex: 0,
              freshness: "current",
            },
            coverage: {
              categories: {
                uncachedInput: category(tokens * 0.15),
                output: category(tokens * 0.05),
                reasoning: category(0),
                cacheRead: category(tokens * 0.8),
                cacheWrite: category(0),
              },
              retries: {
                status: "complete",
                attemptCount: point.acceptedTaskCount,
                failedAttemptCount: 0,
                retryAttemptCount: 0,
                attemptsWithCompleteUsage: point.acceptedTaskCount,
                failedAttemptsWithCompleteUsage: 0,
                retryAttemptsWithCompleteUsage: 0,
              },
              attribution: {
                status: "complete",
                relatedTaskCount: point.acceptedTaskCount,
                unknownRouteTaskCount: 0,
                relatedSessionCount: point.acceptedTaskCount,
                matchedRouteSessionCount: point.acceptedTaskCount,
                includedSessionCount: point.acceptedTaskCount,
                otherRouteSessionCount: 0,
                mixedRouteSessionCount: 0,
                unknownRouteSessionCount: 0,
                sharedSessionCount: 0,
                unattributedSessionCount: 0,
              },
            },
            reasons: [],
          }),
        }
      }),
    },
  }
}

/** What each demo model scores: the Coding Index, and SWE-bench Verified (a fraction) for some. */
const scores: Record<string, { coding: number; swe?: number }> = {
  "claude-opus-5-5": { coding: 70, swe: 0.82 },
  "gpt-6.2-sol": { coding: 66, swe: 0.78 },
  "muse-spark-1.3": { coding: 52 },
  "deepseek-v4-pro": { coding: 61, swe: 0.6 },
  "meta/muse-ember": { coding: 40 },
}
/**
 * The comparison's candidates matched to the public benchmarks of `scores`: what OpenRouter's and
 * Epoch AI's sources answer for them (the mock comparison carries no benchmarks).
 */
export const withBenchmarks = (output: ModelComparisonOutput): ModelComparisonOutput => ({
  ...output,
  candidates: output.candidates.map((candidate) => {
    const score = scores[candidate.identity.modelID]
    if (!score) return candidate
    const evidence = { records: [], recordCount: 0, truncated: false }
    return {
      ...candidate,
      benchmarkCorrespondence: {
        status: "exact",
        basis: "exact-published-catalog-id",
        evidence,
      } as never,
      externalBenchmark: {
        kind: "openrouter-benchmark",
        source: "artificial-analysis",
        taskType: "coding",
        modelPermaslug: candidate.identity.modelID,
        displayName: candidate.native.name,
        effort: null,
        codingIndex: score.coding,
        agenticIndex: null,
        intelligenceIndex: null,
        prices: null,
      },
      publicBenchmarks:
        score.swe === undefined
          ? []
          : [
              {
                kind: "epoch-benchmark",
                benchmarkID: "swe-bench-verified",
                benchmark: "SWE-bench Verified",
                origin: "Epoch AI",
                modelVersion: candidate.identity.modelID,
                modelKey: candidate.identity.modelID,
                effort: null,
                score: score.swe,
                stderr: null,
                agent: null,
                releaseDate: null,
              },
            ],
    }
  }),
})
