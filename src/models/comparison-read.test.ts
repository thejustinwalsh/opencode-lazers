import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MODEL_EVIDENCE_QUERIES,
  MODEL_EVIDENCE_SOURCE_URLS,
  ModelEvidenceSnapshotSchema,
} from "./source-schema.ts"
import { ModelComparisonOutputSchema } from "./comparison-schema.ts"
import type { ModelEvidenceSource } from "./source-schema.ts"
import { readModelComparison } from "./comparison-read.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"

const projectDirectory = "/comparison-project"

function directory() {
  return mkdtempSync(join(tmpdir(), "lazers-model-comparison-"))
}

function nativeRecord(input: {
  providerID: string
  id: string
  variants: string[] | null
  price: number | null
}) {
  return {
    kind: "native-model",
    providerID: input.providerID,
    id: input.id,
    name: `${input.providerID} ${input.id}`,
    enabled: true,
    type: "language",
    contextTokens: 128_000,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: input.variants,
    prices:
      input.price === null
        ? null
        : {
            unit: "USD per million tokens",
            tiers: [
              {
                contextTierTokens: null,
                input: input.price,
                output: input.price * 2,
                cacheRead: 0,
                cacheWrite: null,
              },
            ],
          },
  }
}

function modelRecord(id: string, canonicalSlug: string | null, prompt = "0.000001") {
  return {
    kind: "openrouter-model",
    id,
    canonicalSlug,
    name: `External ${id}`,
    contextLength: 200_000,
    architecture: {
      modality: "text->text",
      inputModalities: ["text"],
      outputModalities: ["text"],
      tokenizer: null,
      instructType: null,
    },
    supportedParameters: ["tools", "reasoning_effort"],
    prices: {
      unit: "USD per token",
      tiers: [
        {
          minPromptTokens: null,
          prompt,
          completion: "0.000002",
          inputCacheRead: null,
          inputCacheWrite: null,
        },
      ],
    },
  }
}

function benchmarkRecord(slug: string, effort: string | null, score: number | null) {
  return {
    kind: "openrouter-benchmark",
    source: "artificial-analysis",
    taskType: "coding",
    modelPermaslug: slug,
    displayName: `Benchmark ${slug}`,
    effort,
    codingIndex: score,
    agenticIndex: null,
    intelligenceIndex: null,
    prices: { unit: "USD per token", prompt: "0", completion: null },
  }
}

function snapshot(
  source: ModelEvidenceSource,
  project: string,
  generation: number,
  records: unknown[],
) {
  return ModelEvidenceSnapshotSchema.parse({
    snapshotID: crypto.randomUUID(),
    projectDirectory: project,
    source,
    generation,
    retrievedAt: "2026-11-03T12:00:00.000Z",
    asOf: source === "openrouter-benchmarks" ? "2026-11-02T12:00:00.000Z" : null,
    version: source === "openrouter-benchmarks" ? "v1" : null,
    citation: "Published source",
    upstreamSourceURL: null,
    sourceURL: MODEL_EVIDENCE_SOURCE_URLS[source],
    query: MODEL_EVIDENCE_QUERIES[source],
    records,
  })
}

test("comparison preserves exact route identity, dated evidence, original prices, and unknown effort", () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const writer = new ModelEvidenceStore(path, projectDirectory)
  const reader = new ModelEvidenceReadStore(path, projectDirectory)
  try {
    const generations = writer.beginRefresh()
    const native = snapshot("native-catalog", projectDirectory, generations["native-catalog"], [
      nativeRecord({
        providerID: "openrouter",
        id: "vendor/model",
        variants: ["low", "high"],
        price: 0,
      }),
      nativeRecord({
        providerID: "openrouter",
        id: "other-unmatched",
        variants: null,
        price: null,
      }),
      nativeRecord({ providerID: "openai", id: "vendor/model", variants: ["high"], price: 3 }),
      nativeRecord({ providerID: "openrouter", id: "vendor/ambiguous", variants: [], price: 1 }),
    ])
    const models = snapshot(
      "openrouter-models",
      projectDirectory,
      generations["openrouter-models"],
      [
        modelRecord("vendor/model", "vendor/model-20261102", "0.000001"),
        modelRecord("vendor/ambiguous", "vendor/ambiguous-a"),
        modelRecord("vendor/ambiguous", "vendor/ambiguous-b", "0.000009"),
      ],
    )
    const benchmarks = snapshot(
      "openrouter-benchmarks",
      projectDirectory,
      generations["openrouter-benchmarks"],
      [
        benchmarkRecord("vendor/model-20261102", "high", 77),
        benchmarkRecord("vendor/ambiguous-a", null, null),
      ],
    )
    writer.saveSnapshot(native)
    writer.saveSnapshot(models)
    writer.saveSnapshot(benchmarks)

    const output = readModelComparison(reader, { limit: 100 })
    expect(
      output.sources.map(({ source, snapshot, refresh }) => ({
        source,
        snapshotID: snapshot?.snapshotID,
        retrievedAt: snapshot?.retrievedAt,
        refreshState: refresh?.state,
      })),
    ).toEqual([
      {
        source: "native-catalog",
        snapshotID: native.snapshotID,
        retrievedAt: native.retrievedAt,
        refreshState: "succeeded",
      },
      {
        source: "openrouter-models",
        snapshotID: models.snapshotID,
        retrievedAt: models.retrievedAt,
        refreshState: "succeeded",
      },
      {
        source: "openrouter-benchmarks",
        snapshotID: benchmarks.snapshotID,
        retrievedAt: benchmarks.retrievedAt,
        refreshState: "succeeded",
      },
    ])
    expect(
      output.candidates.map(({ identity }) => [
        identity.providerID,
        identity.modelID,
        identity.variant,
      ]),
    ).toEqual([
      ["openai", "vendor/model", "high"],
      ["openrouter", "other-unmatched", null],
      ["openrouter", "vendor/ambiguous", null],
      ["openrouter", "vendor/model", "high"],
      ["openrouter", "vendor/model", "low"],
    ])

    const exact = output.candidates.find(
      ({ identity }) => identity.providerID === "openrouter" && identity.variant === "high",
    )!
    expect(exact).toMatchObject({
      correspondence: { status: "exact", basis: "owner-qualified-catalog-id" },
      externalModel: {
        id: "vendor/model",
        canonicalSlug: "vendor/model-20261102",
        prices: { unit: "USD per token", tiers: [{ prompt: "0.000001", completion: "0.000002" }] },
      },
      benchmarkCorrespondence: { status: "exact", basis: "published-canonical-slug" },
      externalBenchmark: {
        modelPermaslug: "vendor/model-20261102",
        effort: "high",
        codingIndex: 77,
        prices: { unit: "USD per token", prompt: "0", completion: null },
      },
      effortApplicability: { status: "unknown" },
      native: {
        prices: {
          unit: "USD per million tokens",
          tiers: [
            {
              contextTierTokens: null,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: null,
            },
          ],
        },
      },
    })
    expect(exact.effortApplicability.evidence.records).toEqual([
      {
        source: "native-catalog",
        snapshotID: native.snapshotID,
        generation: generations["native-catalog"],
        recordIndex: 0,
        recordID: "vendor/model",
      },
      {
        source: "openrouter-models",
        snapshotID: models.snapshotID,
        generation: generations["openrouter-models"],
        recordIndex: 0,
        recordID: "vendor/model",
      },
      {
        source: "openrouter-benchmarks",
        snapshotID: benchmarks.snapshotID,
        generation: generations["openrouter-benchmarks"],
        recordIndex: 0,
        recordID: "vendor/model-20261102",
      },
    ])
    expect(exact.correspondence.evidence.records.map(({ source }) => source)).toContain(
      "openrouter-models",
    )
    expect(exact.benchmarkCorrespondence.evidence.records.map(({ source }) => source)).toContain(
      "openrouter-benchmarks",
    )

    const low = output.candidates.find(
      ({ identity }) => identity.providerID === "openrouter" && identity.variant === "low",
    )!
    expect(low.effortApplicability).toMatchObject({ status: "unknown" })
    const unresolved = output.candidates.find(
      ({ identity }) => identity.modelID === "other-unmatched",
    )!
    expect(unresolved).toMatchObject({
      correspondence: { status: "unresolved", basis: null },
      native: { availableVariants: null, prices: null },
    })
    const otherProvider = output.candidates.find(
      ({ identity }) => identity.providerID === "openai",
    )!
    expect(otherProvider.correspondence).toMatchObject({
      status: "exact",
      basis: "owner-qualified-catalog-id",
    })
    const ambiguous = output.candidates.find(
      ({ identity }) => identity.modelID === "vendor/ambiguous",
    )!
    expect(ambiguous).toMatchObject({
      correspondence: { status: "ambiguous", evidence: { recordCount: 3 } },
      externalModel: null,
      benchmarkCorrespondence: { status: "unresolved" },
    })
  } finally {
    reader.close()
    writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("comparison pages bind filters and source snapshots across concurrent refreshes", () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const writer = new ModelEvidenceStore(path, projectDirectory)
  const reader = new ModelEvidenceReadStore(path, projectDirectory)
  try {
    const generations = writer.beginRefresh()
    const original = snapshot("native-catalog", projectDirectory, generations["native-catalog"], [
      nativeRecord({ providerID: "openrouter", id: "one", variants: ["high", "low"], price: 1 }),
      nativeRecord({ providerID: "openrouter", id: "two", variants: ["high"], price: 2 }),
    ])
    writer.saveSnapshot(original)
    const first = readModelComparison(reader, {
      limit: 1,
      filters: { providerID: "openrouter" },
    })
    expect(first.candidates).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()

    const nextGenerations = writer.beginRefresh()
    const newer = snapshot("native-catalog", projectDirectory, nextGenerations["native-catalog"], [
      nativeRecord({ providerID: "openrouter", id: "brand-new", variants: ["max"], price: 0 }),
    ])
    writer.saveSnapshot(newer)
    writer.saveSnapshot(
      snapshot("openrouter-models", projectDirectory, nextGenerations["openrouter-models"], [
        modelRecord("two", "two-20261103"),
      ]),
    )

    const second = readModelComparison(reader, { cursor: first.nextCursor!, limit: 2 })
    expect(second.sources[0]?.snapshot?.snapshotID).toBe(original.snapshotID)
    expect(second.sources[1]).toMatchObject({ selectedSnapshotID: null, snapshot: null })
    expect(second.candidates.map(({ identity }) => identity.modelID)).toEqual(["one", "two"])
    expect(second.candidates[1]?.correspondence.status).toBe("unresolved")
    expect(
      [...first.candidates, ...second.candidates].map(({ candidateID }) => candidateID),
    ).toEqual([
      "10:openrouter|3:one|4:high",
      "10:openrouter|3:one|3:low",
      "10:openrouter|3:two|4:high",
    ])
    expect(() =>
      readModelComparison(reader, {
        cursor: first.nextCursor!,
        filters: { providerID: "openai" },
      }),
    ).toThrow("Model comparison cursor filters do not match")
    const filtered = readModelComparison(reader, {
      filters: { providerID: "openrouter", search: "brand-new" },
    })
    expect(filtered.candidates.map(({ identity }) => identity.modelID)).toEqual(["brand-new"])
  } finally {
    reader.close()
    writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("comparison bounds duplicate-record variants while paging every candidate deterministically", () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const writer = new ModelEvidenceStore(path, projectDirectory)
  const reader = new ModelEvidenceReadStore(path, projectDirectory)
  try {
    const generations = writer.beginRefresh()
    const variants = Array.from(
      { length: 100 },
      (_, index) => `variant-${String(index).padStart(3, "0")}`,
    )
    variants.push("variant-100")
    const native = snapshot("native-catalog", projectDirectory, generations["native-catalog"], [
      nativeRecord({
        providerID: "openrouter",
        id: "duplicate-model",
        variants: variants.slice(0, 100),
        price: 0,
      }),
      nativeRecord({
        providerID: "openrouter",
        id: "duplicate-model",
        variants: variants.slice(100),
        price: 0,
      }),
    ])
    writer.saveSnapshot(native)

    const first = readModelComparison(reader, { limit: 1 })
    expect(first.candidates).toHaveLength(1)
    expect(first.totalCandidates).toBe(101)
    expect(first).toEqual(readModelComparison(reader, { limit: 1 }))

    const candidates = [...first.candidates]
    let page = first
    while (page.nextCursor) {
      page = readModelComparison(reader, { cursor: page.nextCursor, limit: 1 })
      expect(page.candidates).toHaveLength(1)
      expect(page.totalCandidates).toBe(101)
      ModelComparisonOutputSchema.parse(page)
      candidates.push(...page.candidates)
      expect(candidates.length).toBeLessThanOrEqual(101)
    }

    expect(candidates.map(({ identity }) => identity.variant)).toEqual(variants)
    expect(new Set(candidates.map(({ candidateID }) => candidateID)).size).toBe(101)
    expect(candidates[0]?.native.availableVariants).toEqual(variants.slice(0, 100))
    expect(candidates[0]?.native.variantCoverage).toEqual({
      status: "truncated",
      totalVariants: 101,
      omittedVariants: 1,
    })
    expect(candidates[0]?.native.prices).toMatchObject({
      unit: "USD per million tokens",
      tiers: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: null }],
    })
    expect(candidates[100]?.native.evidence.records).toEqual([
      {
        source: "native-catalog",
        snapshotID: native.snapshotID,
        generation: generations["native-catalog"],
        recordIndex: 1,
        recordID: "duplicate-model",
      },
    ])
  } finally {
    reader.close()
    writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("comparison cursor rejects same-project source IDs swapped across source pins", () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const writer = new ModelEvidenceStore(path, projectDirectory)
  const reader = new ModelEvidenceReadStore(path, projectDirectory)
  try {
    const generations = writer.beginRefresh()
    const native = snapshot("native-catalog", projectDirectory, generations["native-catalog"], [
      nativeRecord({ providerID: "openrouter", id: "model", variants: ["high", "low"], price: 0 }),
    ])
    const models = snapshot(
      "openrouter-models",
      projectDirectory,
      generations["openrouter-models"],
      [modelRecord("model", "model-slug")],
    )
    const benchmarks = snapshot(
      "openrouter-benchmarks",
      projectDirectory,
      generations["openrouter-benchmarks"],
      [benchmarkRecord("model-slug", "high", 1)],
    )
    writer.saveSnapshot(native)
    writer.saveSnapshot(models)
    writer.saveSnapshot(benchmarks)

    const first = readModelComparison(reader, { limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    const payload = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as {
      version: number
      offset: number
      filters: unknown
      snapshots: Record<string, string | null>
    }
    const cursor = Buffer.from(
      JSON.stringify({
        ...payload,
        snapshots: {
          "native-catalog": models.snapshotID,
          "openrouter-models": benchmarks.snapshotID,
          "openrouter-benchmarks": native.snapshotID,
        },
      }),
    ).toString("base64url")

    expect(() => readModelComparison(reader, { cursor, limit: 1 })).toThrow(
      "Model evidence snapshot source does not match its selection",
    )
  } finally {
    reader.close()
    writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("comparison reports missing schemas and retained snapshots after a failed refresh", () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const writer = new ModelEvidenceStore(path, projectDirectory)
  let saved!: ReturnType<typeof snapshot>
  try {
    const generation = writer.beginRefresh()["native-catalog"]
    saved = snapshot("native-catalog", projectDirectory, generation, [
      nativeRecord({ providerID: "openrouter", id: "stale", variants: [], price: null }),
    ])
    writer.saveSnapshot(saved)
    const failedGeneration = writer.beginRefresh()["native-catalog"]
    writer.failRefresh("native-catalog", failedGeneration, "native-unavailable")
  } finally {
    writer.close()
  }

  const reader = new ModelEvidenceReadStore(path, projectDirectory)
  try {
    const output = readModelComparison(reader)
    expect(output.sources[0]).toMatchObject({
      snapshotState: "available",
      refresh: {
        state: "failed",
        errorCode: "native-unavailable",
        latestSnapshotID: expect.any(String),
      },
      snapshot: { snapshotID: saved.snapshotID },
    })
    expect(output.candidates).toHaveLength(1)
  } finally {
    reader.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("a missing pinned snapshot remains missing instead of falling forward to the latest", () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const writer = new ModelEvidenceStore(path, projectDirectory)
  const reader = new ModelEvidenceReadStore(path, projectDirectory)
  try {
    const generation = writer.beginRefresh()["native-catalog"]
    writer.saveSnapshot(
      snapshot("native-catalog", projectDirectory, generation, [
        nativeRecord({ providerID: "openrouter", id: "latest", variants: [], price: 1 }),
      ]),
    )
    const missingID = crypto.randomUUID()
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        offset: 0,
        filters: {},
        snapshots: {
          "native-catalog": missingID,
          "openrouter-models": null,
          "openrouter-benchmarks": null,
        },
      }),
    ).toString("base64url")

    const output = readModelComparison(reader, { cursor })
    expect(output.sources[0]).toMatchObject({
      snapshotState: "missing-snapshot",
      selectedSnapshotID: missingID,
      snapshot: null,
    })
    expect(output.candidates).toEqual([])
  } finally {
    reader.close()
    writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})
