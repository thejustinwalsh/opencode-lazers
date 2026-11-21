import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseEpochArchive } from "./epoch-parse.ts"
import { parseModelsDev } from "./models-dev-parse.ts"
import {
  MODEL_EVIDENCE_QUERIES,
  MODEL_EVIDENCE_SOURCE_URLS,
  ModelEvidenceSnapshotSchema,
  type ModelEvidenceSnapshot,
  type ModelEvidenceSource,
} from "./source-schema.ts"
import type { ModelEvidenceStore } from "./source-store.ts"

/**
 * A recorded evidence corpus for the candidate projection's parity tests: native routes with and
 * without variants and prices, OpenRouter models (exact, ambiguous, unmatched), benchmarks, and the
 * recorded models.dev and Epoch excerpts in `fixtures/`.
 */
const fixtureFile = (name: string) => join(import.meta.dir, "fixtures", name)

export function nativeRecord(input: {
  providerID: string
  id: string
  variants: string[] | null
  price: number | null
  enabled?: boolean
}) {
  return {
    kind: "native-model",
    providerID: input.providerID,
    id: input.id,
    name: `${input.providerID} ${input.id}`,
    enabled: input.enabled ?? true,
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

export function evidenceSnapshot(
  source: ModelEvidenceSource,
  project: string,
  generation: number,
  records: unknown[],
): ModelEvidenceSnapshot {
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

export const corpusNativeRecords = () => [
  nativeRecord({
    providerID: "openrouter",
    id: "vendor/model",
    variants: ["low", "high"],
    price: 0,
  }),
  nativeRecord({ providerID: "openrouter", id: "other-unmatched", variants: null, price: null }),
  nativeRecord({ providerID: "openai", id: "vendor/model", variants: ["high"], price: 3 }),
  nativeRecord({ providerID: "openrouter", id: "vendor/ambiguous", variants: [], price: 1 }),
  nativeRecord({ providerID: "anthropic", id: "claude-haiku-4-5", variants: null, price: 1 }),
  nativeRecord({ providerID: "opencode-go", id: "glm-5.2", variants: null, price: null }),
  nativeRecord({ providerID: "openai", id: "gpt-5", variants: ["low", "high"], price: 1.25 }),
  nativeRecord({
    providerID: "openai",
    id: "gpt-retired",
    variants: null,
    price: 2,
    enabled: false,
  }),
]

/** Every source of the corpus, saved through the writer as a refresh does. */
export function seedEvidenceCorpus(writer: ModelEvidenceStore, project: string) {
  const generations = writer.beginRefresh()
  const saved: Record<string, ModelEvidenceSnapshot> = {}
  const save = (source: ModelEvidenceSource, records: unknown[]) => {
    const snapshot = evidenceSnapshot(source, project, generations[source], records)
    writer.saveSnapshot(snapshot)
    saved[source] = snapshot
  }
  save("native-catalog", corpusNativeRecords())
  save("openrouter-models", [
    modelRecord("vendor/model", "vendor/model-20261102", "0.000001"),
    modelRecord("vendor/ambiguous", "vendor/ambiguous-a"),
    modelRecord("vendor/ambiguous", "vendor/ambiguous-b", "0.000009"),
    modelRecord("openai/gpt-5", "openai/gpt-5-2025-08-07", "0.00000125"),
  ])
  save("openrouter-benchmarks", [
    benchmarkRecord("vendor/model-20261102", "high", 77),
    benchmarkRecord("vendor/ambiguous-a", null, null),
    benchmarkRecord("openai/gpt-5-2025-08-07", "high", 81),
  ])
  save(
    "models-dev",
    parseModelsDev(JSON.parse(readFileSync(fixtureFile("models-dev.excerpt.json"), "utf8"))),
  )
  save(
    "epoch-benchmarks",
    parseEpochArchive(
      new Uint8Array(readFileSync(fixtureFile("epoch-benchmark-data.excerpt.zip"))),
    ),
  )
  return saved
}
