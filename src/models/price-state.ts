import { createHash } from "node:crypto"
import { buildCurrentPriceIndex } from "./current-price-index.ts"
import type { CurrentPriceApplicability } from "./current-price-index.ts"
import type { ModelDecisionPriceState } from "./decision-read.ts"
import { readEndpointPricingEvidence, readEndpointPricingStamp } from "./market-range-evidence.ts"
import { ModelPriceSourceSettingsSchema } from "./price-source-settings.ts"
import type { ModelPriceSourcePolicy, ModelPriceSourceSettings } from "./price-source-settings.ts"
import { ModelEvidenceReadStore } from "./source-store.ts"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import { currentPriceIndexFreshness } from "./task-valuation.ts"

/**
 * The only price inputs OpenCode owns: the saved source order and whether OpenRouter is
 * connected. They are a few hundred bytes, so they are what crosses the worker boundary; the
 * evidence (catalogs, endpoint pricing) is read from SQLite by whoever needs it.
 */
export type PriceInputs = {
  policy: ModelPriceSourcePolicy
  openrouter: ModelPriceSourceSettings["access"]["openrouter"]
}

/** The two whole-model sources a price index and a market identity are built from. */
export const PRICE_EVIDENCE_SOURCES = ["native-catalog", "openrouter-models"] as const

type SnapshotFacts = {
  snapshotID: string
  generation: number
  retrievedAt: string
  records: number
}

function snapshotFacts(
  source: ModelEvidenceComparisonSourceRead | undefined,
): SnapshotFacts | null {
  if (!source) return null
  if (source.snapshot)
    return {
      snapshotID: source.snapshot.snapshotID,
      generation: source.snapshot.generation,
      retrievedAt: source.snapshot.retrievedAt,
      records: source.snapshot.records.length,
    }
  if (source.stamp && source.snapshotID)
    return {
      snapshotID: source.snapshotID,
      generation: source.stamp.generation,
      retrievedAt: source.stamp.retrievedAt,
      records: source.stamp.recordCount,
    }
  return null
}

/** OpenCode quotes use an authorized, recorded native catalog read, not its execution login. */
export function nativeCatalogAccess(
  source: ModelEvidenceComparisonSourceRead | undefined,
): "configured" | "unknown" {
  const snapshot = snapshotFacts(source)
  const refresh = source?.refresh
  if (
    source?.storage !== "ready" ||
    source.snapshotState !== "available" ||
    source.source !== "native-catalog" ||
    !snapshot ||
    snapshot.records === 0 ||
    !refresh ||
    refresh.state === "never" ||
    refresh.generation === 0 ||
    refresh.latestSnapshotID !== snapshot.snapshotID ||
    refresh.latestRetrievedAt !== snapshot.retrievedAt ||
    refresh.latestRecordCount !== snapshot.records
  )
    return "unknown"

  const matchingOutcome =
    refresh.state === "succeeded"
      ? refresh.generation === snapshot.generation
      : refresh.generation > snapshot.generation
  return matchingOutcome ? "configured" : "unknown"
}

export function priceIndexFromSources(input: {
  sources: readonly ModelEvidenceComparisonSourceRead[]
  policy: ModelPriceSourcePolicy
  openrouter: ModelPriceSourceSettings["access"]["openrouter"]
  routes: readonly CurrentPriceApplicability[]
}) {
  const opencode = nativeCatalogAccess(
    input.sources.find((source) => source.source === "native-catalog"),
  )
  const settings = ModelPriceSourceSettingsSchema.parse({
    policy: input.policy,
    access: { openrouter: input.openrouter, opencode, "models-dev": "configured" as const },
  })
  const index = buildCurrentPriceIndex({
    sourceStore: { readComparisonSources: () => [...input.sources] },
    priceSources: settings,
    observedRoutes: input.routes,
  })
  return { settings, opencode, index }
}

/**
 * The full price state a decision snapshot is built from, read from SQLite here. Parsed
 * catalogs come from the process-wide memo, so a repeat read costs row metadata, not a parse.
 */
export function readDecisionPriceState(input: {
  path: string
  projectDirectory: string
  inputs: PriceInputs
  routes: readonly CurrentPriceApplicability[]
  signal?: AbortSignal
}): ModelDecisionPriceState {
  input.signal?.throwIfAborted()
  const store = new ModelEvidenceReadStore(input.path, input.projectDirectory)
  let sources: ModelEvidenceComparisonSourceRead[]
  try {
    sources = store.readComparisonSources(undefined, { sources: PRICE_EVIDENCE_SOURCES })
  } finally {
    store.close()
  }
  const { settings, opencode, index } = priceIndexFromSources({
    sources,
    policy: input.inputs.policy,
    openrouter: input.inputs.openrouter,
    routes: input.routes,
  })
  const endpointPricing = readEndpointPricingEvidence(
    input.path,
    input.projectDirectory,
    input.signal,
  )
  input.signal?.throwIfAborted()
  return {
    settings,
    index,
    endpointPricing,
    identityCatalogSource: sources.find((source) => source.source === "openrouter-models"),
    identityNativeSource: sources.find((source) => source.source === "native-catalog"),
    sources,
    freshness: currentPriceIndexFreshness(index, sources),
    note: `Ordered source access: OpenRouter ${input.inputs.openrouter}; OpenCode ${opencode}. ${index.pins.length ? "Quotes are pinned to the selected cached whole-model sources." : "No applicable configured cached quote is available."}`,
  }
}

/**
 * Fingerprint of everything a price state derives from, read without any snapshot body: the
 * inputs, each source's refresh row and snapshot stamp, and the endpoint refresh rows. Evidence
 * is immutable by snapshot id, so an equal fingerprint means an equal price state, and a decision
 * snapshot keeps this string instead of the evidence it was built from.
 */
export function readPriceIdentity(input: {
  path: string
  projectDirectory: string
  inputs: PriceInputs
  signal?: AbortSignal
}): string {
  input.signal?.throwIfAborted()
  const store = new ModelEvidenceReadStore(input.path, input.projectDirectory)
  let sources: ModelEvidenceComparisonSourceRead[]
  try {
    sources = store.readComparisonSources(undefined, {
      sources: PRICE_EVIDENCE_SOURCES,
      stampOnly: true,
    })
  } finally {
    store.close()
  }
  const opencode = nativeCatalogAccess(sources.find((source) => source.source === "native-catalog"))
  return createHash("sha256")
    .update(
      JSON.stringify({
        inputs: input.inputs,
        opencode,
        sources: sources.map((source) => ({
          source: source.source,
          storage: source.storage,
          snapshotState: source.snapshotState,
          snapshotID: source.snapshotID,
          refresh: source.refresh,
          facts: snapshotFacts(source),
        })),
        endpoint: readEndpointPricingStamp(input.path, input.projectDirectory),
      }),
    )
    .digest("hex")
}
