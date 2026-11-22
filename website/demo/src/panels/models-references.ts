import type { ModelDecisionOverview } from "../../../../src/models/decision-contract.ts"
import { ModelDecisionReferenceEstimateSchema } from "../../../../src/models/reference-estimate.ts"

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
