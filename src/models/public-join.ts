import {
  createModelIndex,
  deriveFamilyVendors,
  parseModelName,
  vendorSlug,
} from "./name-identity.ts"
import type { MatchTier, ModelIndex } from "./name-identity.ts"
import type { EpochBenchmarkRecordSchema, ModelsDevModelRecordSchema } from "./source-schema.ts"

type ModelsDevRecord = typeof ModelsDevModelRecordSchema._output
type EpochRecord = typeof EpochBenchmarkRecordSchema._output

export type Route = { providerID: string; modelID: string; name?: string | null }

export type EpochCoverage = {
  /** Per benchmark: its rows in the archive and how many belong to a model we route. */
  benchmarks: Array<{ benchmarkID: string; benchmark: string; rows: number; matched: number }>
  /** Distinct hub model names that matched no route, with why. A debugging aid. */
  unmatched: Array<{ name: string; reason: string }>
}

const first = <T>(items: readonly T[]) => items[0]

/**
 * The public sources joined to the routes this install can run, through the name identity
 * resolver: models.dev by provider and model id (the ids OpenCode itself uses) and then by name;
 * the Epoch rows by name identity alone.
 */
export function createPublicJoin(input: {
  modelsDev: readonly ModelsDevRecord[]
  epoch: readonly EpochRecord[]
  routes: readonly Route[]
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

  return { modelsDev, epoch, coverage }
}

export type PublicJoin = ReturnType<typeof createPublicJoin>
