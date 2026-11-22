import { expect, test } from "bun:test"
import { observedCostFixture, projectedCostFixture } from "./cost.fixture.ts"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { benchmarkBaseline, benchmarkPrice } from "./benchmark-baseline.ts"
import { buildCatalog, entryProvenanceText } from "./catalog-projection.ts"
import type { ModelCandidate } from "./comparison-presentation.ts"
import { freeEntries, projectedRankRows, shortModelLabel } from "./chart-data.ts"
import { sourceState } from "./comparison-presentation.ts"
import { iterateCSV, parseCSV } from "./csv.ts"
import { EPOCH_CODING_BENCHMARKS, parseEpochArchive } from "./epoch-parse.ts"
import { parseModelsDev, parseModelsDevStream } from "./models-dev-parse.ts"
import { createPublicJoin } from "./public-join.ts"
import { chooseScoreBasis, epochScore } from "./public-score.ts"
import { EPOCH_ATTRIBUTION } from "./source-schema.ts"
import { ZipError, openZip, readZipEntries } from "./zip-reader.ts"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name))
const modelsDevPayload = () => JSON.parse(fixture("models-dev.excerpt.json").toString("utf8"))
const epochRows = () =>
  parseEpochArchive(new Uint8Array(fixture("epoch-benchmark-data.excerpt.zip")))

// -- models.dev ---------------------------------------------------------------------------------

test("models.dev prices are USD per million tokens and carry over unchanged", () => {
  const records = parseModelsDev(modelsDevPayload())
  const haiku = records.find((r) => r.providerID === "anthropic" && r.id === "claude-haiku-4-5")!
  // Claude Haiku 4.5 lists at $1 in, $5 out per 1M tokens: the same unit as the OpenRouter
  // snapshot after its per-token price is multiplied by 1e6.
  expect(haiku.prices).toEqual({
    unit: "USD per million tokens",
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  })
  expect(haiku).toMatchObject({
    name: expect.any(String),
    canonicalModelID: "anthropic/claude-haiku-4-5",
    releaseDate: "2025-10-15",
    contextTokens: 200000,
    outputTokens: 64000,
    toolCall: true,
  })
})

test("models.dev keeps routed and BYOK providers first and drops models with no text output", () => {
  const payload = modelsDevPayload()
  payload.helicone.models["image-only"] = {
    id: "image-only",
    name: "Image only",
    modalities: { input: ["text"], output: ["image"] },
    cost: { input: 1, output: 1 },
  }
  const records = parseModelsDev(payload, new Set(["opencode-go"]))
  expect(records.some((r) => r.id === "image-only")).toBe(false)
  const order = records.map((r) => r.providerID)
  const firstGateway = order.indexOf("helicone")
  expect(order.lastIndexOf("anthropic")).toBeLessThan(firstGateway)
  expect(order.lastIndexOf("opencode-go")).toBeLessThan(firstGateway)
})

test("a models.dev payload that is not the database is rejected", () => {
  expect(() => parseModelsDev([])).toThrow()
  expect(parseModelsDev({})).toEqual([])
})

// -- Epoch archive ------------------------------------------------------------------------------

test("the Epoch archive is read for its coding benchmarks, scores as fractions", () => {
  const rows = epochRows()
  const byBenchmark = Object.groupBy(rows, (row) => row.benchmarkID)
  expect(Object.keys(byBenchmark).sort()).toEqual([
    "aider-polyglot",
    "swe-bench-verified",
    "terminal-bench",
  ])
  const swe = byBenchmark["swe-bench-verified"]!.find((r) => r.modelVersion === "glm-5.2_max")!
  expect(swe).toMatchObject({
    score: 0.787,
    origin: "Epoch AI",
    effort: "max",
    benchmark: "SWE-bench Verified",
  })
  // Aider lists percent correct (41.8); the hub's own scale for it is 0.01.
  const aider = byBenchmark["aider-polyglot"]!.find((r) => r.modelVersion === "gpt-oss-120b_high")!
  expect(aider.score).toBeCloseTo(0.418, 6)
  expect(aider.origin).toBe("Aider LLM Leaderboards")
  expect(rows.every((row) => row.score >= 0 && row.score <= 1)).toBe(true)
  // Terminal-Bench rows keep the agent that produced them.
  expect(byBenchmark["terminal-bench"]!.some((r) => r.agent)).toBe(true)
})

test("CSV fields may hold commas, doubled quotes and line breaks", () => {
  const rows = parseCSV('a,b\n"one, two","say ""hi""\nthere"\n3,4\n')
  expect(rows).toEqual([
    { a: "one, two", b: 'say "hi"\nthere' },
    { a: "3", b: "4" },
  ])
  // The Aider excerpt has such a field (training compute notes) and still yields its row.
  expect(epochRows().some((row) => row.modelVersion === "gpt-oss-120b_high")).toBe(true)
})

test("a damaged or oversized archive is an error, not an empty catalog", () => {
  expect(() => parseEpochArchive(new Uint8Array([1, 2, 3]))).toThrow(ZipError)
  const zip = new Uint8Array(fixture("epoch-benchmark-data.excerpt.zip"))
  expect(readZipEntries(zip, new Set(["nope.csv"])).size).toBe(0)
  expect(EPOCH_CODING_BENCHMARKS.map((b) => b.file)).toContain("swe_bench_verified.csv")
})

// -- joins --------------------------------------------------------------------------------------

const routes = [
  { providerID: "anthropic", modelID: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { providerID: "openai", modelID: "gpt-5", name: "GPT-5" },
  { providerID: "opencode-go", modelID: "glm-5.2", name: "GLM 5.2" },
  { providerID: "opencode-go", modelID: "kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
  { providerID: "somegateway", modelID: "gpt-5-mini", name: null },
]

test("Epoch rows attach by name identity; efforts are rows of the one model", () => {
  const join = createPublicJoin({ modelsDev: [], epoch: epochRows(), routes })
  const gpt5 = join.epoch({ providerID: "openai", modelID: "gpt-5" })
  expect(gpt5.map((row) => row.benchmarkID)).toContain("swe-bench-verified")
  // `gpt-5-2025-08-07_high` and `_medium` are efforts of gpt-5, recorded and not merged away.
  expect(
    gpt5
      .filter((r) => r.benchmarkID === "swe-bench-verified")
      .map((r) => r.effort)
      .sort(),
  ).toEqual(["high", "medium"])
  // A tier is another model: gpt-5-mini has none of gpt-5's rows on SWE-bench Verified here.
  expect(
    join
      .epoch({ providerID: "somegateway", modelID: "gpt-5-mini" })
      .every((r) => !r.modelVersion.startsWith("gpt-5-2025")),
  ).toBe(true)
  expect(join.epoch({ providerID: "opencode-go", modelID: "glm-5.2" })[0]!.modelVersion).toBe(
    "glm-5.2_max",
  )
  expect(join.epoch({ providerID: "x", modelID: "not-a-model" })).toEqual([])
})

test("the coverage names what matched, what did not and why", () => {
  const join = createPublicJoin({ modelsDev: [], epoch: epochRows(), routes })
  const coverage = join.coverage()!
  const swe = coverage.benchmarks.find((b) => b.benchmarkID === "swe-bench-verified")!
  // Six SWE-bench Verified rows in the excerpt; opus-4-6, gpt-5 (two) and glm-5.2 are routed.
  expect(swe.rows).toBe(6)
  expect(swe.matched).toBe(4)
  const names = coverage.unmatched.map((entry) => entry.name)
  expect(names).toContain("yi-lightning")
  expect(names).not.toContain("glm-5.2_max")
  for (const entry of coverage.unmatched)
    expect(entry.reason).toMatch(/no catalog model named|ambiguous/)
  expect(createPublicJoin({ modelsDev: [], epoch: [], routes }).coverage()).toBeNull()
})

test("models.dev joins by provider and id, then by first-party identity; a gateway copy is never a price", () => {
  const dev = parseModelsDev(modelsDevPayload(), new Set(["opencode-go", "helicone"]))
  const join = createPublicJoin({ modelsDev: dev, epoch: [], routes })
  expect(join.modelsDev({ providerID: "anthropic", modelID: "claude-haiku-4-5" })).toMatchObject({
    tier: "provider-id",
  })
  // The date-stamped id of the same model reaches the same entry through the name identity.
  const stamped = join.modelsDev({ providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" })
  expect(stamped?.record.providerID).toBe("anthropic")
  // A route under another provider takes the model's first-party entry.
  expect(
    join.modelsDev({ providerID: "opencode", modelID: "claude-sonnet-4-5" })?.record.providerID,
  ).toBe("anthropic")
  // helicone lists o3-mini, a gateway copy: no first-party entry in this excerpt, so no price.
  expect(join.modelsDev({ providerID: "otherprovider", modelID: "o3-mini" })).toBeNull()
})

// -- price sources and score basis --------------------------------------------------------------

function candidateWith(
  providerID: string,
  modelID: string,
  parts: {
    openrouter?: { prompt: string; completion: string }
    native?: { input: number; output: number }
    dev?: { input: number; output: number; releaseDate?: string }
    epoch?: Array<{ benchmarkID: string; benchmark: string; score: number }>
    aa?: number
  },
): ModelCandidate {
  return {
    candidateID: `${providerID}:${modelID}`,
    identity: { providerID, modelID, variant: null },
    native: {
      name: modelID,
      enabled: true,
      type: null,
      contextTokens: null,
      capabilities: null,
      availableVariants: null,
      variantCoverage: { status: "complete", totalVariants: 0, omittedVariants: 0 },
      prices: parts.native
        ? {
            tiers: [
              {
                contextTierTokens: null,
                input: parts.native.input,
                output: parts.native.output,
                cacheRead: null,
                cacheWrite: null,
              },
            ],
          }
        : null,
      ambiguousIdentity: false,
      evidence: { recordCount: 0, records: [] },
    },
    correspondence: { status: parts.openrouter ? "exact" : "none" },
    externalModel: parts.openrouter
      ? {
          id: `${providerID}/${modelID}`,
          prices: {
            tiers: [
              {
                minPromptTokens: null,
                utcStart: null,
                utcEnd: null,
                prompt: parts.openrouter.prompt,
                completion: parts.openrouter.completion,
                inputCacheRead: null,
                inputCacheWrite: null,
              },
            ],
          },
        }
      : null,
    externalModelEvidence: { recordCount: 0, records: [] },
    benchmarkCorrespondence: { status: parts.aa === undefined ? "none" : "exact" },
    externalBenchmark:
      parts.aa === undefined
        ? null
        : {
            displayName: modelID,
            modelPermaslug: modelID,
            codingIndex: parts.aa,
            agenticIndex: null,
            intelligenceIndex: null,
          },
    externalBenchmarkEvidence: { recordCount: 0, records: [] },
    effortApplicability: { status: "unknown" },
    publicModel: parts.dev
      ? {
          kind: "models-dev-model",
          providerID,
          id: modelID,
          releaseDate: parts.dev.releaseDate ?? null,
          prices: {
            unit: "USD per million tokens",
            input: parts.dev.input,
            output: parts.dev.output,
            cacheRead: null,
            cacheWrite: null,
          },
        }
      : null,
    publicBenchmarks: (parts.epoch ?? []).map((row) => ({
      kind: "epoch-benchmark",
      origin: "Epoch AI",
      modelVersion: modelID,
      modelKey: modelID,
      effort: null,
      stderr: null,
      agent: null,
      releaseDate: null,
      ...row,
    })),
  } as never
}

const dates = {
  openrouter: "2026-11-17T00:00:00.000Z",
  opencode: "2026-11-17T01:00:00.000Z",
  modelsDev: "2026-11-17T02:00:00.000Z",
}

test("the ordered price sources pick the first that prices the model and keep which one", () => {
  const all = candidateWith("p", "m", {
    openrouter: { prompt: "0.000003", completion: "0.000015" },
    native: { input: 2, output: 8 },
    dev: { input: 1, output: 5 },
  })
  expect(benchmarkPrice(all, ["openrouter", "opencode", "models-dev"], dates)).toMatchObject({
    source: "openrouter",
    input: 3,
    output: 15,
  })
  expect(benchmarkPrice(all, ["opencode", "openrouter", "models-dev"], dates)).toMatchObject({
    source: "opencode",
    input: 2,
  })
  expect(benchmarkPrice(all, ["models-dev", "openrouter"], dates)).toMatchObject({
    source: "models-dev",
    input: 1,
    output: 5,
    retrievedAt: dates.modelsDev,
  })
  // OpenRouter access absent (no exact model): the keyless source still prices the model.
  const keyless = candidateWith("p", "m", { dev: { input: 1, output: 5 } })
  expect(benchmarkPrice(keyless, ["openrouter", "opencode", "models-dev"], dates)).toMatchObject({
    source: "models-dev",
  })
  // No source prices it: nothing is invented.
  expect(
    benchmarkPrice(candidateWith("p", "none", {}), ["openrouter", "opencode", "models-dev"], dates),
  ).toBeNull()
})

test("one score basis ranks the whole set: Epoch when it covers more models than the Coding Index", () => {
  const swe = (score: number) => [
    { benchmarkID: "swe-bench-verified", benchmark: "SWE-bench Verified", score },
  ]
  const set = [
    candidateWith("p", "a", { epoch: swe(0.7) }),
    candidateWith("p", "b", { epoch: swe(0.5) }),
    candidateWith("p", "c", { aa: 60 }),
  ]
  const choice = chooseScoreBasis(set)
  expect(choice.basis).toMatchObject({
    source: "epoch",
    benchmarkID: "swe-bench-verified",
    label: "SWE-bench Verified (%)",
  })
  expect(choice.basis.caption).toContain(EPOCH_ATTRIBUTION)
  expect(epochScore(set[0]!, "swe-bench-verified")?.value).toBe(70)
  // With the Coding Index covering at least as many, it keeps the lead.
  expect(chooseScoreBasis([...set, candidateWith("p", "d", { aa: 55 })]).basis.source).toBe(
    "artificial-analysis",
  )
  expect(chooseScoreBasis([candidateWith("p", "x", {})]).basis.source).toBe("artificial-analysis")
})

test("the Benchmark view plots Epoch scores when OpenRouter benchmarks are absent", () => {
  const swe = (score: number) => [
    { benchmarkID: "swe-bench-verified", benchmark: "SWE-bench Verified", score },
  ]
  const baseline = benchmarkBaseline({
    candidates: [
      candidateWith("p", "a", { dev: { input: 1, output: 5 }, epoch: swe(0.7) }),
      candidateWith("p", "b", { epoch: swe(0.5) }),
      candidateWith("p", "c", { dev: { input: 2, output: 8 } }),
    ],
    priceSources: ["openrouter", "opencode", "models-dev"],
    sourceDates: dates,
    observedRoutes: new Set(),
    label: (route) => route.modelID,
  })
  expect(baseline.scoreBasis.source).toBe("epoch")
  expect(
    baseline.points.map((p) => [p.route.modelID, p.benchmark.codingIndex, p.price.source]),
  ).toEqual([["a", 70, "models-dev"]])
  expect(baseline.points[0]!.benchmark.scoreCaption).toContain(EPOCH_ATTRIBUTION)
  // b has a score and no price: listed as a gap, not plotted; c has no score.
  expect(baseline.gaps.map((g) => [g.route.modelID, g.reason])).toEqual([["b", "no-price"]])
  expect(baseline.unmatchedRoutes).toBe(1)
})

const profile = {
  uncachedInput: 1_000_000,
  cacheRead: 0,
  cacheWrite: 0,
  output: 200_000,
  reasoning: 0,
  configurations: 1,
  acceptedTasks: 4,
}

test("without OpenRouter the catalog is still full: priced by models.dev, newest release first", () => {
  const set = [
    candidateWith("p", "old", { dev: { input: 1, output: 5, releaseDate: "2024-01-01" } }),
    candidateWith("p", "new", { dev: { input: 1, output: 5, releaseDate: "2026-06-01" } }),
    candidateWith("p", "mid", { dev: { input: 1, output: 5, releaseDate: "2025-03-01" } }),
  ]
  const { entries, summary } = buildCatalog({
    candidates: set,
    priceSources: ["openrouter", "opencode", "models-dev"],
    sourceDates: dates,
    profile,
    observed: new Map(),
    routed: [],
    label: (route) => route.modelID,
  })
  expect(entries).toHaveLength(3)
  expect(entries.every((entry) => entry.price?.source === "models-dev")).toBe(true)
  expect(summary.orderSource).toBe("models-dev")
  expect(summary.ordering).toContain("release date")
})

test("a recorded run and a routed model join the catalog entry for the same model by name", () => {
  const set = [candidateWith("opencode-go", "kimi-k3.1-pro", { dev: { input: 1, output: 5 } })]
  const observed = new Map([
    [
      "moonshotai\u0000kimi-k3.1-pro-20261023",
      {
        configurationID: "c1",
        cost: observedCostFixture(0.5),
        tokens: 1000,
        accepted: 3,
        terminal: 4,
      },
    ],
  ])
  const { entries } = buildCatalog({
    candidates: set,
    priceSources: ["models-dev"],
    sourceDates: dates,
    profile,
    observed,
    routed: [{ providerID: "someone", modelID: "Kimi K3.1 Pro" }],
    label: (route) => route.modelID,
  })
  // One entry, tagged Observed, Routed and Catalog, instead of three lonely ones.
  expect(entries).toHaveLength(1)
  expect(entries[0]!.tags).toEqual(["observed", "routed", "catalog"])
  expect(entries[0]!.observed?.configurationID).toBe("c1")
})

// -- attribution --------------------------------------------------------------------------------

test("the Epoch source line carries the required attribution and the snapshot date", () => {
  const line = sourceState({
    source: "epoch-benchmarks",
    storage: "ready",
    snapshotState: "available",
    selectedSnapshotID: null,
    refresh: null,
    snapshot: {
      source: "epoch-benchmarks",
      recordCount: 445,
      retrievedAt: "2026-11-18T20:00:00.000Z",
      asOf: null,
    },
  } as never)
  expect(line).toContain("Epoch AI · CC BY 4.0")
  expect(line).toContain("445 records")
  expect(line).toMatch(/retrieved .*(Nov|11)/)
  expect(EPOCH_ATTRIBUTION).toBe("Epoch AI · CC BY 4.0")
})

test("SWE-bench Verified leads while it covers most of what the best covered benchmark does", () => {
  const rows = (id: string, name: string) => [{ benchmarkID: id, benchmark: name, score: 0.5 }]
  const many = (count: number, tag: string, id: string, name: string) =>
    Array.from({ length: count }, (_, at) =>
      candidateWith("p", `${tag}${at}`, { epoch: rows(id, name) }),
    )
  const set = (swe: number, deep: number) => [
    ...many(swe, "s", "swe-bench-verified", "SWE-bench Verified"),
    ...many(deep, "d", "deepswe", "DeepSWE"),
  ]
  // 27 of 31 (87%): the recognised benchmark keeps the lead.
  expect(chooseScoreBasis(set(27, 31)).basis).toMatchObject({ benchmarkID: "swe-bench-verified" })
  // 5 of 10: another benchmark clearly covers more, so it ranks the set.
  expect(chooseScoreBasis(set(5, 10)).basis).toMatchObject({ benchmarkID: "deepswe" })
})

test("a dated snapshot and its latest alias are one catalog entry; versions keep their own price", () => {
  const set = [
    candidateWith("anthropic", "claude-opus-4-5-20251101", { dev: { input: 5, output: 25 } }),
    candidateWith("anthropic", "claude-opus-4-5", { dev: { input: 5, output: 25 } }),
    candidateWith("anthropic", "claude-opus-4-1", { dev: { input: 15, output: 75 } }),
    candidateWith("anthropic", "claude-opus-4-6", { dev: { input: 5, output: 25 } }),
  ]
  const { entries } = buildCatalog({
    candidates: set,
    priceSources: ["models-dev"],
    sourceDates: dates,
    profile,
    observed: new Map(),
    routed: [{ providerID: "anthropic", modelID: "claude-opus-4-5-20251101" }],
    label: (route) => route.modelID,
  })
  expect(entries.map((entry) => entry.route.modelID).sort()).toEqual([
    "claude-opus-4-1",
    "claude-opus-4-5",
    "claude-opus-4-6",
  ])
  // The routed dated id joined the undated alias's entry.
  expect(entries.find((entry) => entry.route.modelID === "claude-opus-4-5")!.tags).toContain(
    "routed",
  )
  // 4.1 lists at three times 4.5's rate: no version borrows a sibling's price.
  const usd = (id: string) => entries.find((entry) => entry.route.modelID === id)!.projected.low!
  expect(usd("claude-opus-4-1")).toBeCloseTo(usd("claude-opus-4-5") * 3, 6)
})

// -- public catalog beyond the routes -----------------------------------------------------------

test("the public catalogs add Anthropic and OpenAI lineups no route runs, once per model", () => {
  const dev = parseModelsDev(modelsDevPayload(), new Set(["opencode-go"]))
  const join = createPublicJoin({
    modelsDev: dev,
    epoch: epochRows(),
    // This install routes only GLM through opencode-go: no Anthropic or OpenAI provider at all.
    routes: [{ providerID: "opencode-go", modelID: "glm-5.2", name: "GLM 5.2" }],
    openrouter: [
      {
        kind: "openrouter-model",
        id: "acme/rocket-1",
        canonicalSlug: null,
        name: "Acme: Rocket 1",
        contextLength: 128000,
        architecture: {
          modality: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          tokenizer: null,
          instructType: null,
        },
        supportedParameters: ["tools"],
        prices: {
          unit: "USD per token",
          tiers: [
            {
              minPromptTokens: null,
              prompt: "0.000002",
              completion: "0.00001",
              inputCacheRead: null,
              inputCacheWrite: null,
            },
          ],
        },
      },
      {
        // An OpenRouter listing of a model models.dev already gave: one model, not two.
        kind: "openrouter-model",
        id: "anthropic/claude-opus-4.6",
        canonicalSlug: null,
        name: "Anthropic: Claude Opus 4.6",
        contextLength: 200000,
        architecture: {
          modality: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          tokenizer: null,
          instructType: null,
        },
        supportedParameters: ["tools"],
        prices: {
          unit: "USD per token",
          tiers: [
            {
              minPromptTokens: null,
              prompt: "0.000005",
              completion: "0.000025",
              inputCacheRead: null,
              inputCacheWrite: null,
            },
          ],
        },
      },
    ] as never,
  })
  const items = join.external()
  const ids = items.map((item) => `${item.providerID}/${item.modelID}`)
  // Anthropic: Haiku 4.5 and Opus 4.6; Sonnet 4.5 is marked deprecated upstream and is left out.
  expect(ids.filter((id) => id.startsWith("anthropic/")).length).toBe(2)
  expect(ids).not.toContain("anthropic/claude-sonnet-4-5-20250929")
  expect(ids).toContain("anthropic/claude-haiku-4-5")
  expect(ids).not.toContain("anthropic/claude-haiku-4-5-20251001")
  expect(ids.some((id) => id.startsWith("openai/gpt-5"))).toBe(true)
  // GLM is already a route; the OpenRouter copy of Opus 4.6 is the same model as models.dev's.
  expect(ids).not.toContain("opencode-go/glm-5.2")
  expect(
    ids.filter((id) => (id.includes("opus-4") && id.includes("4.6")) || id.includes("opus-4-6")),
  ).toHaveLength(1)
  expect(ids).toContain("acme/rocket-1")
  const rocket = items.find((item) => item.modelID === "rocket-1")!
  expect(rocket).toMatchObject({ source: "openrouter", prices: { input: 2, output: 10 } })
  const opus = items.find((item) => item.modelID === "claude-opus-4-6")!
  expect(opus).toMatchObject({ source: "models-dev", prices: { input: 5, output: 25 } })
  expect(opus.benchmarks.some((row) => row.benchmarkID === "swe-bench-verified")).toBe(true)
})

test("public-catalog models join the ranked set, priced by their source and scored on its basis", () => {
  const join = createPublicJoin({
    modelsDev: parseModelsDev(modelsDevPayload()),
    epoch: epochRows(),
    routes: [],
  })
  const external = join.external()
  const { entries, summary } = buildCatalog({
    candidates: [],
    priceSources: ["openrouter", "opencode", "models-dev"],
    sourceDates: dates,
    profile,
    observed: new Map(),
    routed: [],
    external,
    label: (route) => route.modelID,
  })
  expect(entries.length).toBe(external.length)
  expect(summary.external).toBe(external.length)
  const opus = entries.find((entry) => entry.route.modelID === "claude-opus-4-6")!
  expect(opus).toMatchObject({ label: expect.any(String), tags: ["catalog"] })
  expect(opus.price).toMatchObject({ source: "models-dev", input: 5, output: 25 })
  expect(opus.projected.low!).toBeGreaterThan(0)
  // A source that is not configured contributes nothing.
  expect(
    buildCatalog({
      candidates: [],
      priceSources: ["opencode"],
      sourceDates: dates,
      profile,
      observed: new Map(),
      routed: [],
      external,
      label: (route) => route.modelID,
    }).entries,
  ).toHaveLength(0)
})

// -- ordered price lookup for public-catalog models ---------------------------------------------

const orRecord = (id: string, prompt: string, completion: string, name = id) =>
  ({
    kind: "openrouter-model",
    id,
    canonicalSlug: null,
    name,
    contextLength: 200000,
    architecture: {
      modality: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      tokenizer: null,
      instructType: null,
    },
    supportedParameters: ["tools"],
    prices: {
      unit: "USD per token",
      tiers: [
        { minPromptTokens: null, prompt, completion, inputCacheRead: null, inputCacheWrite: null },
      ],
    },
  }) as never

const catalogOf = (
  join: ReturnType<typeof createPublicJoin>,
  priceSources: Array<"openrouter" | "opencode" | "models-dev">,
) =>
  buildCatalog({
    candidates: [],
    priceSources,
    sourceDates: dates,
    profile,
    observed: new Map(),
    routed: [],
    external: join.external(),
    label: (route) => route.modelID,
  }).entries

test("a models.dev-listed Anthropic model is priced by OpenRouter when OpenRouter lists it", () => {
  const dev = parseModelsDev(modelsDevPayload())
  // OpenRouter lists Opus 4.6 at a different rate than models.dev, under its own spelling.
  const join = createPublicJoin({
    modelsDev: dev,
    epoch: [],
    routes: [],
    openrouter: [
      orRecord("anthropic/claude-opus-4.6", "0.000004", "0.00002", "Anthropic: Claude Opus 4.6"),
    ],
  })
  const opus = catalogOf(join, ["openrouter", "opencode", "models-dev"]).find(
    (entry) => entry.route.modelID === "claude-opus-4-6",
  )!
  expect(opus.listedBy).toBe("models-dev")
  expect(opus.price).toMatchObject({
    source: "openrouter",
    input: 4,
    output: 20,
    retrievedAt: dates.openrouter,
  })
  expect(entryProvenanceText(opus)).toMatch(
    /^Catalog · listed by models\.dev · priced by OpenRouter · /,
  )
  // Not listed by OpenRouter: it falls to models.dev, and says so.
  const without = createPublicJoin({ modelsDev: dev, epoch: [], routes: [], openrouter: [] })
  const fallback = catalogOf(without, ["openrouter", "opencode", "models-dev"]).find(
    (entry) => entry.route.modelID === "claude-opus-4-6",
  )!
  expect(fallback.price).toMatchObject({ source: "models-dev", input: 5, output: 25 })
  expect(entryProvenanceText(fallback)).toContain("priced by models.dev")
  // The order is the user's: models.dev first takes models.dev's rate.
  expect(
    catalogOf(join, ["models-dev", "openrouter"]).find(
      (e) => e.route.modelID === "claude-opus-4-6",
    )!.price?.source,
  ).toBe("models-dev")
})

test("an OpenRouter-listed model is priced by OpenRouter and its models.dev entry is the fallback quote", () => {
  const join = createPublicJoin({
    modelsDev: parseModelsDev(modelsDevPayload(), new Set()),
    epoch: [],
    routes: [],
    openrouter: [orRecord("openai/gpt-5", "0.0000012", "0.00001", "OpenAI: GPT-5")],
  })
  const gpt5 = join.external().find((item) => item.modelID === "gpt-5")!
  expect(gpt5.quotes?.map((quote) => quote.source)).toEqual(["openrouter", "models-dev"])
})

test("the price join never crosses a tier or a version, and a reseller is not the model's price", () => {
  const dev = parseModelsDev(modelsDevPayload())
  const join = createPublicJoin({
    modelsDev: dev,
    epoch: [],
    routes: [],
    openrouter: [
      // Different tier of the same family and a different major version: neither may be used.
      orRecord("openai/gpt-5-mini", "0.0000001", "0.0000004", "OpenAI: GPT-5 Mini"),
      orRecord("openai/gpt-6", "0.00002", "0.0001", "OpenAI: GPT-6"),
      // A reseller's copy of Haiku, marked up, beside no first-party listing: it is the only
      // listing in this source, so it is taken; with the vendor's own listing present it is not.
      orRecord("resellerco/claude-haiku-4.5", "0.000009", "0.000045", "Reseller: Claude Haiku 4.5"),
    ],
  })
  const entries = catalogOf(join, ["openrouter", "models-dev"])
  const price = (id: string) => entries.find((entry) => entry.route.modelID === id)!.price!
  expect(price("gpt-5")).toMatchObject({ source: "models-dev" })
  expect(price("gpt-5-mini").source).toBe("openrouter")
  expect(price("gpt-5-mini").input).toBeCloseTo(0.1, 9)
  const both = createPublicJoin({
    modelsDev: dev,
    epoch: [],
    routes: [],
    openrouter: [
      orRecord("resellerco/claude-haiku-4.5", "0.000009", "0.000045"),
      orRecord("anthropic/claude-haiku-4.5", "0.000001", "0.000005"),
    ],
  })
  expect(
    catalogOf(both, ["openrouter", "models-dev"]).find(
      (e) => e.route.modelID === "claude-haiku-4-5",
    )!.price,
  ).toMatchObject({ source: "openrouter", input: 1, output: 5 })
  // The lone reseller listing is the only OpenRouter listing for Haiku, so it prices Haiku.
  expect(price("claude-haiku-4-5")).toMatchObject({ source: "openrouter", input: 9 })
})

test("one model is one entry however many providers offer it, with the providers listed", () => {
  const set = [
    candidateWith("github-copilot", "claude-haiku-5-5", { dev: { input: 0.1, output: 0.5 } }),
    candidateWith("anthropic", "claude-haiku-5-5", { dev: { input: 0.1, output: 0.5 } }),
    candidateWith("anthropic", "claude-haiku-4-5", { dev: { input: 1, output: 5 } }),
  ]
  const { entries } = buildCatalog({
    candidates: set,
    priceSources: ["models-dev"],
    sourceDates: dates,
    profile,
    observed: new Map([
      // The route the user actually runs is the Copilot one; it joins the same entry.
      [
        "github-copilot\u0000claude-haiku-5-5",
        {
          configurationID: "c",
          cost: observedCostFixture(0.4),
          tokens: 1e6,
          accepted: 2,
          terminal: 2,
        },
      ],
    ]),
    routed: [],
    label: (route) => route.modelID,
  })
  expect(entries.map((entry) => entry.route.modelID).sort()).toEqual([
    "claude-haiku-4-5",
    "claude-haiku-5-5",
  ])
  const haiku = entries.find((entry) => entry.route.modelID === "claude-haiku-5-5")!
  // The vendor's own provider speaks for it; the other is listed beside it.
  expect(haiku.route.providerID).toBe("anthropic")
  expect(haiku.providers).toEqual(["anthropic", "github-copilot"])
  expect(haiku.observed?.configurationID).toBe("c")
  expect(
    entries.find((entry) => entry.route.modelID === "claude-haiku-4-5")!.providers,
  ).toBeUndefined()
})

test("a model its source lists as free is shown as free, below the ranking, never as $0", () => {
  const entries = buildCatalog({
    candidates: [],
    priceSources: ["openrouter"],
    sourceDates: dates,
    profile,
    observed: new Map(),
    routed: [],
    external: [
      {
        source: "openrouter",
        providerID: "dots-studio",
        modelID: "dots-3-note-preview:free",
        name: "Dots Studio: Dots3-Note Preview (free)",
        releaseDate: null,
        contextTokens: null,
        prices: { input: 0, output: 0, cacheRead: null, cacheWrite: null },
        benchmarks: [],
      },
      {
        source: "openrouter",
        providerID: "acme",
        modelID: "rocket-1",
        name: "Acme: Rocket 1",
        releaseDate: null,
        contextTokens: null,
        prices: { input: 2, output: 10, cacheRead: null, cacheWrite: null },
        benchmarks: [],
      },
    ],
    label: (route) => route.modelID,
  }).entries
  expect(freeEntries(entries).map((entry) => entry.route.modelID)).toEqual([
    "dots-3-note-preview:free",
  ])
  expect(projectedRankRows(entries).map((row) => row.label)).toEqual(["Rocket 1"])
})

test("ranking labels drop the vendor prefix and routing suffix; the tooltip keeps the full name", () => {
  expect(shortModelLabel("Dots Studio: Dots3-Note Preview (free)")).toBe("Dots3-Note Preview")
  expect(shortModelLabel("Gemini 3 Flash Preview (CLI)")).toBe("Gemini 3 Flash Preview")
  expect(shortModelLabel("Anthropic: Claude Haiku 5.5")).toBe("Claude Haiku 5.5")
  expect(shortModelLabel("Claude Opus 4.5 (latest)")).toBe("Claude Opus 4.5")
  // Parentheses that are part of the name stay.
  expect(shortModelLabel("GPT-5 (high)")).toBe("GPT-5 (high)")
  expect(shortModelLabel("claude-haiku-5-5")).toBe("claude-haiku-5-5")
  const entry = {
    id: "x",
    route: { providerID: "p", modelID: "m" },
    label: "Dots Studio: Dots3-Note Preview (free)",
    tags: ["catalog"],
    price: {
      source: "openrouter",
      input: 1,
      output: 2,
      cacheRead: null,
      cacheWrite: null,
      blended: 1.25,
      appliesBelowTokens: null,
      retrievedAt: null,
    },
    projected: projectedCostFixture(1),
    score: null,
    contextTokens: null,
    observed: null,
    frontier: false,
  } as never
  const [row] = projectedRankRows([entry])
  expect(row!.label).toBe("Dots3-Note Preview")
  expect(row!.tooltip[0]).toBe("Dots Studio: Dots3-Note Preview (free)")
})

async function* chunked(text: string, size: number) {
  for (let at = 0; at < text.length; at += size) {
    yield text.slice(at, at + size)
    await Promise.resolve()
  }
}

test("streaming a models.dev body yields exactly the records of parsing it whole, at any chunking", async () => {
  const payload = modelsDevPayload()
  // Strings with structural characters and escapes must not confuse the splitter.
  payload.helicone.models["tricky"] = {
    id: 'tri"cky,{x}[y]\\',
    name: 'A "quoted", {braced} [bracketed] name \\ é',
    modalities: { input: ["text"], output: ["text"] },
    cost: { input: 1, output: 2 },
  }
  const routed = new Set(["opencode-go"])
  const expected = parseModelsDev(payload, routed)
  const body = JSON.stringify(payload, null, 1)
  for (const size of [1, 2, 7, 64, 4096, body.length])
    expect(await parseModelsDevStream(chunked(body, size), routed)).toEqual(expected)
  expect(expected.some((r) => r.id === 'tri"cky,{x}[y]\\')).toBe(true)
})

test("streaming a models.dev body holds only the cap, newest releases first, and matches whole parsing", async () => {
  const providers = 120
  const models = 60
  const payload: Record<string, unknown> = {}
  for (let p = 0; p < providers; p++)
    payload[`gateway-${p}`] = {
      id: `gateway-${p}`,
      models: Object.fromEntries(
        Array.from({ length: models }, (_, m) => [
          `m${m}`,
          {
            id: `m${m}`,
            name: `Model ${m}`,
            release_date: `20${10 + ((p * 7 + m * 3) % 15)}-0${1 + (m % 9)}-1${m % 10}`,
            modalities: { input: ["text"], output: ["text"] },
            cost: { input: 1, output: 2 },
          },
        ]),
      ),
    }
  payload["opencode-go"] = { id: "opencode-go", models: { a: { id: "a", name: "A" } } }
  const routed = new Set(["opencode-go"])
  const expected = parseModelsDev(payload, routed)
  // 7 200 gateway records compete for the 2 000 places left.
  expect(expected).toHaveLength(2_000)
  expect(expected[0]!.providerID).toBe("opencode-go")
  const body = JSON.stringify(payload)
  expect(await parseModelsDevStream(chunked(body, 65_536), routed)).toEqual(expected)
})

test("a streamed models.dev body that is not a complete object is rejected", async () => {
  await expect(parseModelsDevStream(chunked("[]", 1))).rejects.toThrow()
  await expect(parseModelsDevStream(chunked('{"a":{"models":{}', 3))).rejects.toThrow()
  await expect(parseModelsDevStream(chunked('{"a":{"models":{}}} x', 3))).rejects.toThrow()
  await expect(parseModelsDevStream(chunked('{"a":{"models":{"b":}}}', 5))).rejects.toThrow()
  expect(await parseModelsDevStream(chunked(" {} ", 1))).toEqual([])
})

test("CSV rows stream one at a time and match the whole-file parse on awkward input", () => {
  const cases = [
    "",
    "a,b\n",
    "a,b",
    "a,b\r\n1,2\r\n\r\n3\r\n",
    "﻿a,b\n1,2\n",
    'a,b\n"x\r\ny",""\n,\n"unterminated,2',
    "a,b\n\n\n1,2",
  ]
  for (const text of cases) {
    const streamed: Array<Record<string, string>> = []
    for (const row of iterateCSV(text)) streamed.push(row)
    expect(streamed).toEqual(parseCSV(text))
  }
  expect(parseCSV("a,b\r\n1,2\r\n\r\n3\r\n")).toEqual([
    { a: "1", b: "2" },
    { a: "3", b: "" },
  ])
  // Nothing is read ahead: the first row is available before the rest of the text is walked.
  const walk = iterateCSV("a\n1\n2\n3\n")
  expect(walk.next().value).toEqual({ a: "1" })
})

test("a zip entry is inflated when it is read, and only the wanted ones are listed", () => {
  const zip = new Uint8Array(fixture("epoch-benchmark-data.excerpt.zip"))
  const wanted = new Set(EPOCH_CODING_BENCHMARKS.map((item) => item.file))
  const all = readZipEntries(zip, wanted)
  const lazy = openZip(zip, wanted)
  expect(all.size).toBeGreaterThan(0)
  for (const [name, bytes] of all) expect(lazy.read(name)).toEqual(bytes)
  expect(lazy.read("not-wanted.csv")).toBeUndefined()
  expect(openZip(zip, new Set(["nope.csv"])).read("nope.csv")).toBeUndefined()
})
