import { afterAll, expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { createServer } from "vite"
import type { ModelCandidate } from "../../src/models/comparison-state.ts"

const vite = await createServer({
  configFile: "./vite.config.ts",
  server: { middlewareMode: true, ws: false },
  appType: "custom",
})
afterAll(() => vite.close())
const { ModelCandidateRow, HistoricalChartPlaceholder, RoutingNotActiveNotice } =
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
  expect(html).toContain('aria-label="openai / gpt-6 · high. Native catalog 1 records.')
  expect(html).toContain("OpenRouter GPT-6")
  expect(html).toContain("Coding index 71.4")
  expect(html).not.toContain("$0.18")
})

test("unavailable chart and read-only assignments never fabricate values or imply active routing", () => {
  const chart = renderToString(() => createComponent(HistoricalChartPlaceholder, {}))
  expect(chart).toContain("Comparable coordinates unavailable")
  expect(chart).toContain("No sample points or frontier are shown")
  expect(chart).not.toContain("<svg")
  expect(chart).not.toContain("illustrative")

  const assignments = renderToString(() => createComponent(RoutingNotActiveNotice, {}))
  expect(assignments).toContain("Routing is not active")
  expect(assignments).toContain("do not change worker dispatch")
  expect(assignments).not.toContain("<button")
})
