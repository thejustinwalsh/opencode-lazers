import { expect, test } from "bun:test"
import {
  BENCHMARK_PRICE_MIX,
  benchmarkBaseline,
  benchmarkPrice,
  routeKey,
} from "./benchmark-baseline.ts"
import type { ModelCandidate } from "./comparison-state.ts"

const evidence = { records: [], recordCount: 0, truncated: false }
const dates = { openrouter: "2026-11-15T10:00:00.000Z", opencode: "2026-11-14T10:00:00.000Z" }

function candidate(
  modelID: string,
  options: {
    variant?: string | null
    benchmark?: "exact" | "ambiguous" | "unresolved"
    codingIndex?: number | null
    openRouter?: Array<{
      minPromptTokens: number | null
      prompt: string | null
      completion: string | null
      utcStart?: number | null
    }>
    openCode?: { input: number | null; output: number | null; contextTierTokens?: number | null }[]
  } = {},
): ModelCandidate {
  const benchmark = options.benchmark ?? "exact"
  return {
    candidateID: `openai|${modelID}|${options.variant ?? "-"}`,
    identity: { providerID: "openai", modelID, variant: options.variant ?? null },
    native: {
      name: modelID.toUpperCase(),
      enabled: true,
      type: "chat",
      contextTokens: 128_000,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      availableVariants: null,
      variantCoverage: { status: "unknown", totalVariants: null, omittedVariants: null },
      prices: options.openCode
        ? {
            unit: "USD per million tokens",
            tiers: options.openCode.map((tier) => ({
              contextTierTokens: tier.contextTierTokens ?? null,
              input: tier.input,
              output: tier.output,
              cacheRead: null,
              cacheWrite: null,
            })),
          }
        : null,
      ambiguousIdentity: false,
      evidence,
    },
    correspondence: {
      status: options.openRouter ? "exact" : "unresolved",
      basis: options.openRouter ? "exact-published-catalog-id" : null,
      evidence,
    },
    externalModel: options.openRouter
      ? {
          kind: "openrouter-model",
          id: `openai/${modelID}`,
          canonicalSlug: `openai/${modelID}`,
          name: modelID,
          contextLength: 128_000,
          architecture: {
            modality: null,
            inputModalities: null,
            outputModalities: null,
            tokenizer: null,
            instructType: null,
          },
          supportedParameters: null,
          prices: {
            unit: "USD per token",
            tiers: options.openRouter.map((tier) => ({
              minPromptTokens: tier.minPromptTokens,
              utcStart: tier.utcStart ?? null,
              utcEnd: null,
              prompt: tier.prompt,
              completion: tier.completion,
              inputCacheRead: null,
              inputCacheWrite: null,
            })),
          },
        }
      : null,
    externalModelEvidence: evidence,
    benchmarkCorrespondence: {
      status: benchmark,
      basis: benchmark === "unresolved" ? null : "published-canonical-slug",
      evidence,
    },
    externalBenchmark:
      benchmark === "exact"
        ? {
            kind: "openrouter-benchmark",
            source: "artificial-analysis",
            taskType: "coding",
            modelPermaslug: `openai/${modelID}`,
            displayName: `${modelID} (high)`,
            effort: null,
            codingIndex: options.codingIndex === undefined ? 50 : options.codingIndex,
            agenticIndex: null,
            intelligenceIndex: null,
            prices: null,
          }
        : null,
    externalBenchmarkEvidence: evidence,
    effortApplicability: { status: "unknown", evidence },
  }
}

const openRouterRate = [{ minPromptTokens: null, prompt: "0.000002", completion: "0.000008" }]

test("price follows the configured source order and skips sources without an applicable rate", () => {
  const both = candidate("both", {
    openRouter: openRouterRate,
    openCode: [{ input: 1, output: 4 }],
  })
  const openRouterFirst = benchmarkPrice(both, ["openrouter", "opencode"], dates)!
  expect(openRouterFirst).toMatchObject({
    source: "openrouter",
    input: 2,
    output: 8,
    retrievedAt: dates.openrouter,
  })
  // 3 input : 1 output, stated explicitly; per-token list price, not a task cost.
  expect(BENCHMARK_PRICE_MIX).toEqual({ input: 3, output: 1 })
  expect(openRouterFirst.blended).toBeCloseTo((2 * 3 + 8) / 4)
  expect(benchmarkPrice(both, ["opencode", "openrouter"], dates)).toMatchObject({
    source: "opencode",
    input: 1,
    output: 4,
    retrievedAt: dates.opencode,
  })
  const openCodeOnly = candidate("native", { openCode: [{ input: 1, output: 4 }] })
  expect(benchmarkPrice(openCodeOnly, ["openrouter", "opencode"], dates)?.source).toBe("opencode")
  expect(benchmarkPrice(openCodeOnly, ["openrouter"], dates)).toBeNull()
  expect(benchmarkPrice(both, [], dates)).toBeNull()
})

test("only an unconditional base rate applies; thresholds are reported and schedules never used", () => {
  const tiered = candidate("tiered", {
    openRouter: [
      ...openRouterRate,
      { minPromptTokens: 200_000, prompt: "0.000004", completion: "0.000016" },
    ],
  })
  expect(benchmarkPrice(tiered, ["openrouter"], dates)).toMatchObject({
    input: 2,
    appliesBelowTokens: 200_000,
  })
  const scheduledOnly = candidate("scheduled", {
    openRouter: [
      { minPromptTokens: null, utcStart: 0, prompt: "0.000001", completion: "0.000002" },
    ],
  })
  expect(benchmarkPrice(scheduledOnly, ["openrouter"], dates)).toBeNull()
  const missingOutput = candidate("missing", {
    openRouter: [{ minPromptTokens: null, prompt: "0.000001", completion: null }],
    openCode: [{ input: null, output: 4 }],
  })
  expect(benchmarkPrice(missingOutput, ["openrouter", "opencode"], dates)).toBeNull()
  const published = candidate("free", {
    openRouter: [{ minPromptTokens: null, prompt: "0", completion: "0" }],
  })
  expect(benchmarkPrice(published, ["openrouter"], dates)?.blended).toBe(0)
})

test("baseline plots one point per route with a single matched benchmark and an applicable price", () => {
  const observed = new Set([routeKey({ providerID: "openai", modelID: "observed" })])
  const baseline = benchmarkBaseline({
    candidates: [
      candidate("observed", { variant: "high", openRouter: openRouterRate, codingIndex: 61 }),
      candidate("observed", { variant: null, openRouter: openRouterRate, codingIndex: 61 }),
      candidate("cheap", { openCode: [{ input: 0.1, output: 0.4 }], codingIndex: 30 }),
      candidate("unpriced", { codingIndex: 45 }),
      candidate("unscored", { openRouter: openRouterRate, codingIndex: null }),
      candidate("several", { benchmark: "ambiguous", openRouter: openRouterRate }),
      candidate("none", { benchmark: "unresolved", openRouter: openRouterRate }),
    ],
    priceSources: ["openrouter", "opencode"],
    sourceDates: dates,
    observedRoutes: observed,
    label: (route) => `Label ${route.modelID}`,
  })
  expect(baseline.points.map((point) => point.route.modelID)).toEqual(["cheap", "observed"])
  // Efforts share the model-level benchmark; the effort-less configuration is the handle.
  expect(baseline.points[1]).toMatchObject({
    id: "openai|observed|-",
    observed: true,
    label: "Label observed",
    benchmark: { codingIndex: 61, displayName: "observed (high)" },
    price: { source: "openrouter" },
  })
  expect(baseline.points[0]).toMatchObject({ observed: false, price: { source: "opencode" } })
  expect(baseline.gaps.map((gap) => [gap.route.modelID, gap.reason])).toEqual([
    ["unpriced", "no-price"],
    ["unscored", "no-coding-index"],
  ])
  expect(baseline.unmatchedRoutes).toBe(2)
  expect(baseline.ambiguousRoutes).toBe(1)
  for (const point of baseline.points) expect(Object.keys(point)).not.toContain("taskCost")
})
