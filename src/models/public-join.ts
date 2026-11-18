import {
  createModelIndex,
  deriveFamilyVendors,
  parseModelName,
  vendorSlug,
} from "./name-identity.ts"
import type { MatchTier, ModelIndex } from "./name-identity.ts"
import type {
  EpochBenchmarkRecordSchema,
  ModelsDevModelRecordSchema,
  OpenRouterModelEvidenceRecordSchema,
} from "./source-schema.ts"
import type { PublicCatalogItem } from "./comparison-schema.ts"

type ModelsDevRecord = typeof ModelsDevModelRecordSchema._output
type EpochRecord = typeof EpochBenchmarkRecordSchema._output
type OpenRouterRecord = typeof OpenRouterModelEvidenceRecordSchema._output

export type Route = { providerID: string; modelID: string; name?: string | null }

export type EpochCoverage = {
  /** Per benchmark: its rows in the archive and how many belong to a model we route. */
  benchmarks: Array<{ benchmarkID: string; benchmark: string; rows: number; matched: number }>
  /** Distinct hub model names that matched no route, with why. A debugging aid. */
  unmatched: Array<{ name: string; reason: string }>
}

const first = <T>(items: readonly T[]) => items[0]

/** Newest models taken per BYOK provider, and from the other vendors and OpenRouter. */
export const EXTERNAL_PER_BYOK = 12
export const EXTERNAL_TRENDING = 30

/**
 * The public sources joined to the routes this install can run, through the name identity
 * resolver: models.dev by provider and model id (the ids OpenCode itself uses) and then by name;
 * the Epoch rows by name identity alone.
 */
export function createPublicJoin(input: {
  modelsDev: readonly ModelsDevRecord[]
  epoch: readonly EpochRecord[]
  routes: readonly Route[]
  /** The OpenRouter model list, in its own order. */
  openrouter?: readonly OpenRouterRecord[]
}) {
  const exact = new Map<string, ModelsDevRecord>()
  for (const record of input.modelsDev) exact.set(`${record.providerID}\u0000${record.id}`, record)
  let devIndex: ModelIndex<ModelsDevRecord> | undefined
  const devByName = () =>
    (devIndex ??= createModelIndex(
      input.modelsDev.map((record) => ({
        id: record.id,
        names: [
          ...(record.name ? [record.name] : []),
          `${record.providerID}/${record.id}`,
          ...(record.canonicalModelID ? [record.canonicalModelID] : []),
        ],
        vendor: record.providerID,
        value: record,
      })),
    ))

  // Which vendor a family belongs to, from the providers that are the vendors themselves.
  let vendors: Map<string, string> | undefined
  const familyVendors = () =>
    (vendors ??= deriveFamilyVendors(
      input.modelsDev
        .filter((record) => vendorSlug(record.providerID))
        .map((record) => ({ name: record.id, vendor: record.providerID })),
    ))

  /**
   * The models.dev entry for a route. Its own provider's entry first; otherwise the model's
   * first-party provider (the vendor named by the identity). A gateway's copy is never taken:
   * its price is the gateway's, not the model's.
   */
  const modelsDev = (
    route: Route,
  ): { record: ModelsDevRecord; tier: MatchTier | "provider-id" } | null => {
    const same = exact.get(`${route.providerID}\u0000${route.modelID}`)
    if (same) return { record: same, tier: "provider-id" }
    if (!input.modelsDev.length) return null
    const result = devByName().resolve(route.modelID, {
      vendor: vendorSlug(route.providerID) ? route.providerID : null,
    })
    if (result.status !== "matched") return null
    const items = result.items.map((item) => item.value)
    const sameProvider = items.filter((record) => record.providerID === route.providerID)
    const vendor = result.identity.vendor ?? familyVendors().get(result.identity.family) ?? null
    const firstParty = items.filter(
      (record) => vendor !== null && vendorSlug(record.providerID) === vendor,
    )
    const pool = sameProvider.length ? sameProvider : firstParty
    const newest = pool.toSorted((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
    const chosen = first(newest)
    return chosen ? { record: chosen, tier: result.tier } : null
  }

  const epochIndex = createModelIndex(
    input.epoch.map((record) => ({
      id: record.modelVersion,
      vendor: null,
      value: record,
    })),
  )
  const epochCache = new Map<string, EpochRecord[]>()
  const epoch = (route: Route): EpochRecord[] => {
    const key = `${route.providerID}\u0000${route.modelID}`
    const cached = epochCache.get(key)
    if (cached) return cached
    const attempts = [route.modelID, ...(route.name ? [route.name] : [])]
    let rows: EpochRecord[] = []
    for (const attempt of attempts) {
      const result = epochIndex.resolve(attempt, {
        vendor: vendorSlug(route.providerID) ? route.providerID : null,
      })
      if (result.status === "matched") {
        rows = result.items.map((item) => item.value)
        break
      }
    }
    epochCache.set(key, rows)
    return rows
  }

  /** How many Epoch rows reach a route; the rest are listed, never attached by guesswork. */
  const coverage = (): EpochCoverage | null => {
    if (!input.epoch.length) return null
    const routes = createModelIndex(
      input.routes.map((route) => ({
        id: route.modelID,
        names: route.name ? [route.name] : [],
        vendor: vendorSlug(route.providerID) ? route.providerID : null,
        value: route,
      })),
    )
    const verdicts = new Map<string, string | null>()
    const perBenchmark = new Map<string, { benchmark: string; rows: number; matched: number }>()
    for (const row of input.epoch) {
      let reason = verdicts.get(row.modelVersion)
      if (reason === undefined) {
        const result = routes.resolve(row.modelVersion)
        reason =
          result.status === "matched"
            ? null
            : result.reason === "ambiguous"
              ? `ambiguous: ${result.detail}`
              : `no catalog model named ${parseModelName(row.modelVersion).family || row.modelVersion}`
        verdicts.set(row.modelVersion, reason)
      }
      const entry = perBenchmark.get(row.benchmarkID) ?? {
        benchmark: row.benchmark,
        rows: 0,
        matched: 0,
      }
      entry.rows++
      if (reason === null) entry.matched++
      perBenchmark.set(row.benchmarkID, entry)
    }
    const unmatched = [...verdicts]
      .flatMap(([name, reason]) => (reason === null ? [] : [{ name, reason }]))
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200)
    return {
      benchmarks: [...perBenchmark].map(([benchmarkID, entry]) => ({ benchmarkID, ...entry })),
      unmatched,
    }
  }

  /**
   * The public catalogs' models that no route runs: every Anthropic and OpenAI model (newest
   * `BYOK_PER_PROVIDER` each), the newest first-party models of other vendors, and the first
   * OpenRouter-listed models, each once per identity. Dated snapshots and `latest` aliases are
   * one model; a model a route already covers is left to that route.
   */
  const external = (): PublicCatalogItem[] => {
    const covered = createModelIndex(
      input.routes.map((route) => ({
        id: route.modelID,
        names: route.name ? [route.name] : [],
        vendor: vendorSlug(route.providerID) ? route.providerID : null,
        value: route,
      })),
    )
    const taken = new Set<string>()
    const claim = (modelID: string, vendor: string | null, name: string | null) => {
      const identity = parseModelName(modelID, { vendor })
      const key = `${vendor ?? identity.vendor ?? ""}\u0000${identity.key}`
      if (taken.has(key)) return false
      if (covered.resolve(modelID, { vendor }).status === "matched") return false
      if (name && covered.resolve(name, { vendor }).status === "matched") return false
      taken.add(key)
      return true
    }
    const rowsFor = (modelID: string, name: string | null) => {
      for (const attempt of [modelID, ...(name ? [name] : [])]) {
        const result = epochIndex.resolve(attempt)
        if (result.status === "matched") return result.items.map((item) => item.value).slice(0, 24)
      }
      return []
    }
    const newest = (a: ModelsDevRecord, b: ModelsDevRecord) =>
      (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.id.length - b.id.length
    // Undated aliases and the newest dated snapshot first within an identity.
    const usable = input.modelsDev
      .filter(
        (record) =>
          // The vendor's own provider entry, not a cloud or gateway that resells it.
          vendorSlug(record.providerID) === record.providerID &&
          record.status !== "deprecated" &&
          record.toolCall !== false &&
          record.prices?.input != null &&
          record.prices.output != null,
      )
      .toSorted(newest)
    const items: PublicCatalogItem[] = []
    const fromDev = (record: ModelsDevRecord): PublicCatalogItem => ({
      source: "models-dev",
      providerID: record.providerID,
      modelID: record.id,
      name: record.name,
      releaseDate: record.releaseDate,
      contextTokens: record.contextTokens,
      prices: {
        input: record.prices!.input!,
        output: record.prices!.output!,
        cacheRead: record.prices!.cacheRead,
        cacheWrite: record.prices!.cacheWrite,
      },
      benchmarks: rowsFor(record.id, record.name),
    })
    for (const provider of ["anthropic", "openai"])
      for (const record of usable
        .filter((entry) => entry.providerID === provider)
        .filter((entry) => claim(entry.id, provider, entry.name))
        .slice(0, EXTERNAL_PER_BYOK))
        items.push(fromDev(record))
    let trending = 0
    for (const record of usable) {
      if (trending >= EXTERNAL_TRENDING) break
      if (record.providerID === "anthropic" || record.providerID === "openai") continue
      if (!claim(record.id, vendorSlug(record.providerID), record.name)) continue
      items.push(fromDev(record))
      trending++
    }
    let listed = 0
    for (const record of input.openrouter ?? []) {
      if (listed >= EXTERNAL_TRENDING) break
      const base = record.prices?.tiers.find(
        (tier) =>
          tier.minPromptTokens === null &&
          (tier.utcStart ?? null) === null &&
          (tier.utcEnd ?? null) === null,
      )
      const prompt = base?.prompt == null ? NaN : Number(base.prompt)
      const completion = base?.completion == null ? NaN : Number(base.completion)
      if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0)
        continue
      if (record.supportedParameters && !record.supportedParameters.includes("tools")) continue
      const outputs = record.architecture.outputModalities
      if (outputs && !outputs.includes("text")) continue
      const slash = record.id.indexOf("/")
      const owner = slash > 0 ? record.id.slice(0, slash) : ""
      const modelID = slash > 0 ? record.id.slice(slash + 1) : record.id
      if (!claim(modelID, vendorSlug(owner), record.name)) continue
      const perMillion = (value: string | null | undefined) =>
        value == null || !Number.isFinite(Number(value)) ? null : Number(value) * 1_000_000
      items.push({
        source: "openrouter",
        providerID: owner || "openrouter",
        modelID,
        name: record.name,
        releaseDate: null,
        contextTokens: record.contextLength,
        prices: {
          input: prompt * 1_000_000,
          output: completion * 1_000_000,
          cacheRead: perMillion(base?.inputCacheRead),
          cacheWrite: perMillion(base?.inputCacheWrite),
        },
        benchmarks: rowsFor(modelID, record.name),
      })
      listed++
    }
    return items
  }

  return { modelsDev, epoch, coverage, external }
}

export type PublicJoin = ReturnType<typeof createPublicJoin>
