import { afterAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { createServer } from "vite"
import type { ModelCandidate } from "../../src/models/comparison-state.ts"
import type { KnownUsageMarketScenario } from "../../src/models/market-range.ts"

const vite = await createServer({
  configFile: "./vite.config.ts",
  server: { middlewareMode: true, ws: false },
  appType: "custom",
})
afterAll(() => vite.close())
const { ModelCandidateRow, HistoricalChartPlaceholder, KnownUsageMarketScenarioCard } =
  (await vite.ssrLoadModule(
    "/src/models/comparison-panel.tsx",
  )) as typeof import("../../src/models/comparison-panel.tsx")

const candidate = {
  candidateID: "openai|gpt-6|high",
  identity: { providerID: "openai", modelID: "gpt-6", variant: "high" },
  native: {
    name: "GPT-6",
    enabled: true,
    type: "chat",
    contextTokens: 128_000,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    availableVariants: ["high"],
    prices: null,
    ambiguousIdentity: false,
    evidence: {
      records: [
        {
          source: "native-catalog",
          snapshotID: "11111111-1111-4111-8111-111111111111",
          generation: 1,
          recordIndex: 0,
          recordID: "gpt-6",
        },
      ],
      recordCount: 1,
      truncated: false,
    },
  },
  correspondence: {
    status: "exact",
    basis: "direct-openrouter-route-and-exact-catalog-id",
    evidence: { records: [], recordCount: 1, truncated: false },
  },
  externalModel: {
    kind: "openrouter-model",
    id: "openai/gpt-6",
    canonicalSlug: "openai/gpt-6",
    name: "OpenRouter GPT-6",
    contextLength: 128_000,
    architecture: {
      modality: "text",
      inputModalities: ["text"],
      outputModalities: ["text"],
      tokenizer: null,
      instructType: null,
    },
    supportedParameters: ["reasoning"],
    prices: null,
  },
  externalModelEvidence: { records: [], recordCount: 1, truncated: false },
  benchmarkCorrespondence: {
    status: "exact",
    basis: "published-canonical-slug",
    evidence: { records: [], recordCount: 1, truncated: false },
  },
  externalBenchmark: {
    kind: "openrouter-benchmark",
    source: "artificial-analysis",
    taskType: "coding",
    modelPermaslug: "openai/gpt-6",
    displayName: "GPT-6",
    effort: "high",
    codingIndex: 71.4,
    agenticIndex: null,
    intelligenceIndex: null,
    prices: null,
  },
  externalBenchmarkEvidence: { records: [], recordCount: 1, truncated: false },
  effortApplicability: {
    status: "unknown",
    evidence: { records: [], recordCount: 0, truncated: false },
  },
} as ModelCandidate

const renderedText = (html: string) => html.replace(/<[^>]*>/g, "")

function renderMarketScenario(scenario: KnownUsageMarketScenario) {
  const markup = renderToString(() => createComponent(KnownUsageMarketScenarioCard, { scenario }))
  const window = new Window()
  const container = window.document.createElement("div")
  container.innerHTML = markup
  const details = container.querySelector<HTMLDetailsElement>(
    ".lazers-models-market-evidence-details",
  )
  const summary = details?.querySelector("summary")
  if (!details || !summary) {
    window.happyDOM.abort()
    throw new Error("Known-usage evidence disclosure did not render")
  }
  const detailsStart = container.innerHTML.indexOf("<details")
  return {
    markup,
    compactText: renderedText(container.innerHTML.slice(0, detailsStart)),
    summary,
    details,
    initiallyOpen: details.open,
    expand: () => {
      summary.click()
      return details.open
    },
    evidenceText: () => details.textContent ?? "",
    dispose: () => window.happyDOM.abort(),
  }
}

test("candidate row exposes sourced route and separate external benchmark with keyboard selection semantics", () => {
  const html = renderToString(() =>
    createComponent(ModelCandidateRow, {
      candidate,
      selected: true,
      tabIndex: 0,
      onKeyDown: () => {},
      onSelect: () => {},
    }),
  )
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('tabindex="0"')
  expect(html).toContain(
    'aria-label="GPT-6. Exact route openai / gpt-6 · high. Effort high. Available in the native catalog."',
  )
  expect(html).toContain('<strong title="GPT-6">GPT-6</strong>')
  expect(html).toContain("Effort high")
  expect(html).toContain("Available")
  expect(html).not.toContain("OpenRouter GPT-6")
  expect(html).not.toContain("Coding index")
  expect(html).not.toContain("$0.18")
})

test("candidate row bounds a missing-name ID visually and exposes its full exact route accessibly", () => {
  const modelID = "provider-specific-model-identifier-that-is-long"
  const fallbackCandidate = {
    ...candidate,
    candidateID: "fallback-candidate",
    identity: { providerID: "new-provider", modelID, variant: null },
    native: { ...candidate.native, name: null },
  } as ModelCandidate
  const html = renderToString(() =>
    createComponent(ModelCandidateRow, {
      candidate: fallbackCandidate,
      selected: false,
      tabIndex: 0,
      onKeyDown: () => {},
      onSelect: () => {},
    }),
  )
  expect(html).toContain(`>${modelID.slice(0, 35)}…</strong>`)
  expect(html).toContain(`Exact route new-provider / ${modelID}`)
  expect(html).toContain(`title="new-provider / ${modelID}"`)
})

test("unavailable chart never fabricates zero or illustrative comparison values", () => {
  const chart = renderToString(() => createComponent(HistoricalChartPlaceholder, {}))
  expect(chart).toContain("Unknown prices and zero-accepted configurations stay unplotted")
  expect(chart).toContain('role="status"')
  expect(chart).not.toContain("<svg")
  expect(chart).not.toContain("illustrative")
})

const observed = (
  tokens: number | null,
  status: "observed" | "partial" | "missing" | "unavailable" = "observed",
) => ({
  tokens,
  status,
})

function knownUsageScenario(
  change: Partial<KnownUsageMarketScenario> = {},
): KnownUsageMarketScenario {
  return {
    id: "kimi-moonshot-mxfp4",
    label: "Kimi · Moonshot AI · mxfp4 · standard",
    status: "exact",
    freshness: "current",
    valueUSD: 0.00002,
    rangeUSD: null,
    knownSubtotalUSD: null,
    rateSets: [
      {
        tierID: "standard",
        minPromptTokens: null,
        utcStart: null,
        utcEnd: null,
        prompt: "0.000002",
        completion: "0.00001",
        cacheRead: "0.0000002",
        cacheWrite: "0",
      },
    ],
    missingRates: [],
    cacheWriteEvidence: {
      basis: "scoped-documentation",
      policyID: "kimi-cache-write-zero-v1",
      sourceURL: "https://docs.example.test/kimi-cache-write",
      retrievedAt: "2026-11-03T11:55:00.000Z",
    },
    tierAttribution: {
      status: "not-required",
      basis: "single-published-rate-scenario",
      callCount: 0,
      selectedTierIDs: ["standard"],
      promptThresholds: [],
      thresholdSemantics: null,
    },
    provenance: {
      source: "openrouter-endpoints",
      productID: "moonshotai/kimi-k3.1-pro",
      sourceURL: "https://openrouter.ai/moonshotai/kimi-k3.1-pro/pricing",
      refreshState: "succeeded",
      snapshotID: "11111111-1111-4111-8111-111111111111",
      snapshotGeneration: 4,
      currentGeneration: 4,
      retrievedAt: "2026-11-03T11:55:00.000Z",
      recordIndex: 0,
      providerName: "Moonshot AI",
      tag: "moonshotai/mxfp4",
      serviceTier: null,
    },
    coverage: {
      scope: "known-route-matched-retained-usage",
      wholeTaskBound: false,
      categories: {
        uncachedInput: observed(10),
        output: observed(2),
        reasoning: observed(1),
        cacheRead: observed(3),
        cacheWrite: observed(5),
      },
      route: {
        relatedSessionCount: 2,
        matchedRouteSessionCount: 1,
        includedSessionCount: 1,
        otherRouteSessionCount: 0,
        mixedRouteSessionCount: 0,
        unknownRouteSessionCount: 1,
        sharedSessionCount: 0,
      },
      retries: {
        status: "complete",
        attemptCount: 2,
        routeMatchedAttemptCount: 2,
        otherRouteAttemptCount: 0,
        mixedRouteAttemptCount: 0,
        unknownRouteAttemptCount: 0,
        sharedAttemptCount: 0,
        failedAttemptCount: 1,
        retryAttemptCount: 1,
        attemptsWithCompleteUsage: 2,
        failedAttemptsWithCompleteUsage: 1,
        retryAttemptsWithCompleteUsage: 1,
      },
    },
    reason: null,
    ...change,
  }
}

test("known-usage inspector shows endpoint provenance and scoped documented cache-write zero", () => {
  const card = renderMarketScenario(knownUsageScenario())
  try {
    expect(card.initiallyOpen).toBe(false)
    expect(card.compactText).toContain("Current-market equivalent of known retained usage")
    expect(card.compactText).toContain("Scenario amount · $0.00002")
    expect(card.compactText).toContain("OpenRouter endpoint · provider Moonshot AI")
    expect(card.compactText).toContain("moonshotai/mxfp4")
    expect(card.compactText).toContain("service tier not specified · Current")
    expect(card.compactText).toContain("not actual charges")
    expect(card.compactText).not.toContain("scoped documentation")
    expect(card.compactText).not.toContain("Retry coverage complete")
    expect(card.compactText).not.toContain("Measured token categories")

    expect(card.summary.tagName).toBe("SUMMARY")
    expect(card.summary.textContent).toBe("Evidence & assumptions")
    expect(card.details.firstElementChild).toBe(card.summary)
    expect(card.expand()).toBe(true)
    expect(card.evidenceText()).toContain("scoped documentation")
    expect(card.evidenceText()).toContain("kimi-cache-write-zero-v1")
    expect(card.evidenceText()).toContain("Cache write · 5 tokens · Observed")
    expect(card.evidenceText()).toContain("standard0.0000020.000010.00000020")
    expect(card.evidenceText()).toContain("not a complete-task bound")
    expect(card.markup).toContain('aria-label="Current-market equivalent of known retained usage"')
    expect(card.markup).toContain('<th scope="col">Tier</th>')
    expect(card.markup).toContain('<th scope="row">standard</th>')
    expect(card.markup).toContain('target="_blank" rel="noreferrer"')
  } finally {
    card.dispose()
  }
})

test("Luna tier envelopes stay conditional and per-call tier amounts stay exact to the scenario", () => {
  const lunaRange = knownUsageScenario({
    id: "luna-openai-standard",
    label: "Luna · OpenAI · standard service tier",
    status: "range",
    valueUSD: null,
    rangeUSD: { minimum: 0.00001575, maximum: 0.00003125 },
    cacheWriteEvidence: {
      basis: "endpoint-rate",
      policyID: null,
      sourceURL: null,
      retrievedAt: null,
    },
    tierAttribution: {
      status: "unresolved",
      basis: "aggregate-tier-envelope",
      callCount: 0,
      selectedTierIDs: ["base", "override:272000:1"],
      promptThresholds: [272_000],
      thresholdSemantics:
        "override applies when per-call prompt tokens are greater than minPromptTokens",
    },
    provenance: {
      ...knownUsageScenario().provenance,
      productID: "openai/gpt-6-luna",
      providerName: "OpenAI",
      tag: "openai",
    },
  })
  const lunaCard = renderMarketScenario(lunaRange)
  try {
    expect(lunaCard.initiallyOpen).toBe(false)
    expect(lunaCard.compactText).toContain("Endpoint range · $0.00001575–$0.00003125")
    expect(lunaCard.compactText).toContain("Conditional endpoint scenario · prompt tier unresolved")
    expect(lunaCard.compactText).toContain("not a complete-task or whole-history bound")
    expect(lunaCard.compactText).not.toContain("available tiers base")
    expect(lunaCard.compactText).not.toContain("272,000 prompt tokens")
    expect(lunaCard.expand()).toBe(true)
    expect(lunaCard.evidenceText()).toContain("available tiers base, override:272000:1")
    expect(lunaCard.evidenceText()).toContain("272,000 prompt tokens")
    expect(lunaCard.evidenceText()).toContain(
      "Coverage is complete only for retained matching usage",
    )
    expect(lunaCard.evidenceText()).toContain("Cache-write pricing uses the published rate")
  } finally {
    lunaCard.dispose()
  }

  const knownTier = knownUsageScenario({
    id: "luna-openai-standard",
    label: "Luna · OpenAI · standard service tier",
    valueUSD: 0.0000345,
    rateSets: [
      {
        ...knownUsageScenario().rateSets[0]!,
        tierID: "override:272000:1",
        minPromptTokens: 272_000,
      },
    ],
    tierAttribution: {
      status: "resolved-per-call",
      basis: "complete-per-call-prompt-usage",
      callCount: 2,
      selectedTierIDs: ["base", "override:272000:1"],
      promptThresholds: [272_000],
      thresholdSemantics:
        "override applies when per-call prompt tokens are greater than minPromptTokens",
    },
    provenance: {
      ...knownUsageScenario().provenance,
      productID: "openai/gpt-6-luna",
      providerName: "OpenAI",
      tag: "openai",
    },
  })
  const knownTierCard = renderMarketScenario(knownTier)
  try {
    expect(knownTierCard.compactText).toContain("Known-tier scenario amount · $0.0000345")
    expect(knownTierCard.compactText).not.toContain("Prompt tiers resolved per call")
    expect(knownTierCard.expand()).toBe(true)
    expect(knownTierCard.evidenceText()).toContain(
      "Prompt tiers resolved per call · 2 measured calls",
    )
    expect(knownTierCard.evidenceText()).toContain("override:272000:1")
  } finally {
    knownTierCard.dispose()
  }
})

test("Qwen cache-write rates are endpoint-scoped, while missing usage, rates and bounds are unavailable", () => {
  const qwen = knownUsageScenario({
    id: "qwen-alibaba",
    label: "Qwen · Alibaba · standard",
    cacheWriteEvidence: {
      basis: "endpoint-rate",
      policyID: null,
      sourceURL: null,
      retrievedAt: null,
    },
    rateSets: [
      {
        ...knownUsageScenario().rateSets[0]!,
        tierID: "alibaba",
        cacheWrite: "0.0000002",
      },
    ],
    provenance: {
      ...knownUsageScenario().provenance,
      productID: "qwen/qwen3.8-flash",
      providerName: "Alibaba",
      tag: "alibaba",
    },
  })
  const qwenCard = renderMarketScenario(qwen)
  try {
    expect(qwenCard.compactText).toContain("Scenario amount · $0.00002")
    expect(qwenCard.compactText).not.toContain("does not establish general cache-write capability")
    expect(qwenCard.expand()).toBe(true)
    expect(qwenCard.evidenceText()).toContain("does not establish general cache-write capability")
    expect(qwenCard.evidenceText()).toContain("0.0000002")
  } finally {
    qwenCard.dispose()
  }

  const missing = knownUsageScenario({
    status: "partial",
    valueUSD: null,
    rangeUSD: null,
    knownSubtotalUSD: null,
    missingRates: ["uncachedInput", "cacheWrite"],
    cacheWriteEvidence: {
      basis: "missing",
      policyID: null,
      sourceURL: null,
      retrievedAt: null,
    },
    rateSets: [
      {
        ...knownUsageScenario().rateSets[0]!,
        prompt: null,
        cacheWrite: null,
      },
    ],
    coverage: {
      ...knownUsageScenario().coverage,
      categories: {
        ...knownUsageScenario().coverage.categories,
        uncachedInput: observed(null, "missing"),
      },
    },
    reason: "A measured category and a required endpoint rate are missing; no bound is available.",
  })
  const missingCard = renderMarketScenario(missing)
  try {
    expect(missingCard.compactText).toContain("Unavailable · not a zero price")
    expect(missingCard.compactText).not.toContain("$0")
    expect(missingCard.compactText).not.toContain("uncachedInput")
    expect(missingCard.expand()).toBe(true)
    expect(missingCard.evidenceText()).toContain("Uncached input · tokens unavailable · Missing")
    expect(missingCard.evidenceText()).toContain("uncachedInput, cacheWrite")
    expect(missingCard.evidenceText()).toContain("Cache-write pricing evidence is missing")
    expect(missingCard.evidenceText()).toContain("standardUnavailable0.00001")
  } finally {
    missingCard.dispose()
  }

  const missingRange = knownUsageScenario({
    status: "range",
    valueUSD: null,
    rangeUSD: null,
    knownSubtotalUSD: null,
  })
  const missingRangeCard = renderMarketScenario(missingRange)
  try {
    expect(missingRangeCard.compactText).toContain("Unavailable · range not supplied")
    expect(missingRangeCard.compactText).toContain("not a zero price")
    expect(missingRangeCard.compactText).not.toContain("$0")
  } finally {
    missingRangeCard.dispose()
  }
})

test("incomplete retries expose a partial known subtotal without implying a task or history bound", () => {
  const partial = knownUsageScenario({
    status: "partial",
    valueUSD: null,
    rangeUSD: null,
    knownSubtotalUSD: { minimum: 0.00001, maximum: 0.00002 },
    tierAttribution: {
      ...knownUsageScenario().tierAttribution,
      status: "unresolved",
      basis: "aggregate-tier-envelope",
      selectedTierIDs: ["base", "override"],
      promptThresholds: [272_000],
      thresholdSemantics:
        "override applies when per-call prompt tokens are greater than minPromptTokens",
    },
    coverage: {
      ...knownUsageScenario().coverage,
      retries: {
        ...knownUsageScenario().coverage.retries,
        status: "partial",
        attemptsWithCompleteUsage: 1,
      },
    },
    reason: "Retained retry usage is incomplete; the known subtotal is not a bound.",
  })
  const partialCard = renderMarketScenario(partial)
  try {
    expect(partialCard.compactText).toContain("Known subtotal only · $0.00001–$0.00002")
    expect(partialCard.compactText).toContain("Partial known-usage subtotal only")
    expect(partialCard.compactText).toContain("prompt tier unresolved · retry coverage partial")
    expect(partialCard.compactText).toContain("not a complete-task or whole-history bound")
    expect(partialCard.compactText).not.toContain("Incomplete retry history is conditional")
    expect(partialCard.expand()).toBe(true)
    expect(partialCard.evidenceText()).toContain("Incomplete retry history is conditional")
    expect(partialCard.evidenceText()).toContain("Retained retry usage is incomplete")
  } finally {
    partialCard.dispose()
  }
})
