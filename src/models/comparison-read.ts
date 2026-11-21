import {
  ModelComparisonCursorSchema,
  ModelComparisonFiltersSchema,
  ModelComparisonOutputSchema,
  ModelComparisonReadInputSchema,
  ModelComparisonSnapshotSelectionSchema,
} from "./comparison-schema.ts"
import type {
  ModelComparisonCandidateSchema,
  ModelComparisonFilters,
  ModelComparisonOutput,
  ModelComparisonReadInput,
  ModelComparisonSnapshotSelection,
} from "./comparison-schema.ts"
import { ModelEvidenceSnapshotSummarySchema, type ModelEvidenceSnapshot } from "./source-schema.ts"
import type { ModelEvidenceComparisonSourceRead, ModelEvidenceReadStore } from "./source-store.ts"
import { createPublicJoin } from "./public-join.ts"
import type { PublicJoin } from "./public-join.ts"
import { createModelIndex, vendorSlug } from "./name-identity.ts"
import type { ModelIndex } from "./name-identity.ts"
import {
  modelConfigurationID,
  resolveModelIdentity,
  type ModelIdentityEvidenceReference,
} from "./model-identity.ts"

type NativeRecord = Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>["records"][number]
type OpenRouterBenchmarkRecord = Extract<
  ModelEvidenceSnapshot,
  { source: "openrouter-benchmarks" }
>["records"][number]
type Candidate = typeof ModelComparisonCandidateSchema._output
type EvidenceReference = Candidate["native"]["evidence"]["records"][number]
type CandidateGroup = {
  providerID: string
  modelID: string
  records: Array<{ record: NativeRecord; recordIndex: number }>
  candidateVariants: Set<string | null>
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedUnique(values: Array<string | null>): Array<string | null> {
  return [...new Set(values)].sort((left, right) => {
    if (left === null) return right === null ? 0 : -1
    if (right === null) return 1
    return compareText(left, right)
  })
}

function stableJSON(value: unknown): string {
  return JSON.stringify(value)
}

function sameValue<T>(values: T[]): T | undefined {
  if (!values.length) return undefined
  const first = values[0]!
  return values.every((value) => stableJSON(value) === stableJSON(first)) ? first : undefined
}

function reference(
  source: Extract<ModelEvidenceSnapshot, { source: "native-catalog" | "openrouter-models" }>,
  recordIndex: number,
  recordID: string,
): ModelIdentityEvidenceReference {
  return {
    source: source.source,
    snapshotID: source.snapshotID,
    generation: source.generation,
    recordIndex,
    recordID,
  }
}

function benchmarkReference(
  source: Extract<ModelEvidenceSnapshot, { source: "openrouter-benchmarks" }>,
  recordIndex: number,
  recordID: string,
): EvidenceReference {
  return {
    source: source.source,
    snapshotID: source.snapshotID,
    generation: source.generation,
    recordIndex,
    recordID,
  }
}

function boundedEvidence(references: EvidenceReference[]) {
  const unique = new Map(
    references.map((ref) => [`${ref.source}:${ref.snapshotID}:${ref.recordIndex}`, ref]),
  )
  const records = [...unique.values()]
  return {
    records: records.slice(0, 100),
    recordCount: records.length,
    truncated: records.length > 100,
  }
}

type SnapshotSummary = ReturnType<typeof ModelEvidenceSnapshotSummarySchema.parse>
type SourceSummary = Omit<ReturnType<typeof summarize>, "snapshot"> & {
  snapshot: SnapshotSummary | null
}

function summarize(source: ModelEvidenceComparisonSourceRead, snapshot: ModelEvidenceSnapshot) {
  const { records, ...metadata } = snapshot
  return {
    source: source.source,
    storage: source.storage,
    snapshotState: source.snapshotState,
    selectedSnapshotID: source.snapshotID,
    refresh: source.refresh,
    snapshot: ModelEvidenceSnapshotSummarySchema.parse({
      ...metadata,
      recordCount: records.length,
    }),
  }
}

function sourceSummary(source: ModelEvidenceComparisonSourceRead): SourceSummary {
  const snapshot = source.snapshot
  if (snapshot) return summarize(source, snapshot)
  return {
    source: source.source,
    storage: source.storage,
    snapshotState: source.snapshotState,
    selectedSnapshotID: source.snapshotID,
    refresh: source.refresh,
    snapshot: null,
  }
}

function candidateGroups(snapshot: Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>) {
  const groups = new Map<string, CandidateGroup>()
  snapshot.records.forEach((record, recordIndex) => {
    const key = stableJSON([record.providerID, record.id])
    let group = groups.get(key)
    if (!group) {
      group = {
        providerID: record.providerID,
        modelID: record.id,
        records: [],
        candidateVariants: new Set(),
      }
      groups.set(key, group)
    }
    group.records.push({ record, recordIndex })
    if (!record.variants?.length) group.candidateVariants.add(null)
    else for (const variant of record.variants) group.candidateVariants.add(variant)
  })
  return [...groups.values()]
}

function nativeEvidence(
  snapshot: Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>,
  group: CandidateGroup,
  variant: string | null,
) {
  const supporting = group.records.filter(({ record }) =>
    variant === null ? !record.variants?.length : record.variants?.includes(variant),
  )
  const records = supporting.map(({ recordIndex }) =>
    reference(snapshot, recordIndex, group.modelID),
  )
  return { supporting, evidence: boundedEvidence(records) }
}

function makeNativeView(
  group: CandidateGroup,
  variant: string | null,
  evidence: ReturnType<typeof nativeEvidence>["evidence"],
) {
  const records = group.records.map(({ record }) => record)
  const capabilities = {
    tools: sameValue(records.map((record) => record.capabilities.tools)) ?? null,
    input: sameValue(records.map((record) => record.capabilities.input)) ?? null,
    output: sameValue(records.map((record) => record.capabilities.output)) ?? null,
  }
  const variants = records.some((record) => record.variants === null)
    ? null
    : [...new Set(records.flatMap((record) => record.variants ?? []))].sort(compareText)
  const variantCoverage =
    variants === null
      ? { status: "unknown" as const, totalVariants: null, omittedVariants: null }
      : {
          status: variants.length > 100 ? ("truncated" as const) : ("complete" as const),
          totalVariants: variants.length,
          omittedVariants: Math.max(0, variants.length - 100),
        }
  const identitySignatures = records.map((record) =>
    stableJSON({
      name: record.name,
      enabled: record.enabled,
      type: record.type,
      contextTokens: record.contextTokens,
      capabilities: record.capabilities,
      variants: record.variants === null ? null : [...new Set(record.variants)].sort(compareText),
      prices: record.prices,
    }),
  )
  const ambiguousIdentity = identitySignatures.some(
    (signature) => signature !== identitySignatures[0],
  )
  const prices = sameValue(records.map((record) => record.prices))
  return {
    candidateID: modelConfigurationID(group.providerID, group.modelID, variant),
    identity: {
      providerID: group.providerID,
      modelID: group.modelID,
      variant,
    },
    native: {
      name: sameValue(records.map((record) => record.name)) ?? null,
      enabled: sameValue(records.map((record) => record.enabled)) ?? null,
      type: sameValue(records.map((record) => record.type)) ?? null,
      contextTokens: sameValue(records.map((record) => record.contextTokens)) ?? null,
      capabilities,
      availableVariants: variants?.slice(0, 100) ?? null,
      variantCoverage,
      prices: prices === undefined ? null : prices,
      ambiguousIdentity,
      evidence,
    },
  }
}

function filtered(groups: CandidateGroup[], filters: ModelComparisonFilters): CandidateGroup[] {
  const search = filters.search?.toLowerCase()
  return groups.filter((group) => {
    if (filters.providerID !== undefined && group.providerID !== filters.providerID) return false
    const records = group.records.map(({ record }) => record)
    const enabled = sameValue(records.map((record) => record.enabled)) ?? null
    if (filters.enabled !== undefined && enabled !== filters.enabled) return false
    if (!search) return true
    return records.some(({ name }) =>
      [group.providerID, group.modelID, name ?? ""].some((field) =>
        field.toLowerCase().includes(search),
      ),
    )
  })
}

function indexBenchmarks(records: OpenRouterBenchmarkRecord[] | undefined) {
  const index = new Map<string, Array<{ record: OpenRouterBenchmarkRecord; recordIndex: number }>>()
  records?.forEach((record, recordIndex) => {
    const matches = index.get(record.modelPermaslug) ?? []
    matches.push({ record, recordIndex })
    index.set(record.modelPermaslug, matches)
  })
  return index
}

type BenchmarkEntry = { record: OpenRouterBenchmarkRecord; recordIndex: number }
const benchmarkNameIndexes = new WeakMap<object, ModelIndex<BenchmarkEntry>>()

/** Benchmark rows by every name they carry, for models the published slug does not reach. */
function benchmarkNameIndex(records: OpenRouterBenchmarkRecord[]) {
  let index = benchmarkNameIndexes.get(records)
  if (!index) {
    index = createModelIndex(
      records.map((record, recordIndex) => ({
        id: record.modelPermaslug,
        names: record.displayName ? [record.displayName] : [],
        vendor: vendorSlug(record.modelPermaslug.split("/")[0])
          ? record.modelPermaslug.split("/")[0]!
          : null,
        value: { record, recordIndex },
      })),
    )
    benchmarkNameIndexes.set(records, index)
  }
  return index
}

/** The unconditional rate of a native record: the tier with no context threshold. */
function nativeBasePrice(record: NativeRecord) {
  const base = record.prices?.tiers.find((tier) => tier.contextTierTokens === null)
  return base && base.input !== null && base.output !== null
    ? {
        input: base.input,
        output: base.output,
        cacheRead: base.cacheRead,
        cacheWrite: base.cacheWrite,
      }
    : null
}

function candidatesFor(
  nativeSnapshot: Extract<ModelEvidenceSnapshot, { source: "native-catalog" }> | null,
  catalogSource: ModelEvidenceComparisonSourceRead,
  benchmarkSnapshot: Extract<ModelEvidenceSnapshot, { source: "openrouter-benchmarks" }> | null,
  filters: ModelComparisonFilters,
  join: PublicJoin,
): Candidate[] {
  if (!nativeSnapshot) return []
  const groups = filtered(candidateGroups(nativeSnapshot), filters)
  const benchmarkRecords = (benchmarkSnapshot?.records ?? []) as OpenRouterBenchmarkRecord[]
  const benchmarkIndex = indexBenchmarks(benchmarkRecords)
  const output: Candidate[] = []

  for (const group of groups) {
    const nativeBaseReferences = group.records.map(({ recordIndex }) =>
      reference(nativeSnapshot, recordIndex, group.modelID),
    )
    const identity = resolveModelIdentity({
      route: { providerID: group.providerID, modelID: group.modelID },
      nativeEvidence: nativeBaseReferences,
      catalogSource,
    })
    const modelReferences = identity.resolution.evidence.catalog
    const exactModel =
      identity.resolution.status === "exact" ? (identity.catalogMatches[0]?.record ?? null) : null
    const correspondenceEvidence = boundedEvidence([...nativeBaseReferences, ...modelReferences])
    const correspondence = {
      status:
        identity.resolution.status === "exact"
          ? ("exact" as const)
          : identity.resolution.status === "ambiguous"
            ? ("ambiguous" as const)
            : ("unresolved" as const),
      basis: identity.resolution.basis,
      evidence: correspondenceEvidence,
    }

    let benchmarkMatches: Array<{ record: OpenRouterBenchmarkRecord; recordIndex: number }> = []
    let viaName = false
    if (exactModel?.canonicalSlug && benchmarkSnapshot) {
      benchmarkMatches = benchmarkIndex.get(exactModel.canonicalSlug) ?? []
      if (!benchmarkMatches.length) {
        // The publisher spells the model differently: join by name identity.
        const named = benchmarkNameIndex(benchmarkRecords).resolve(exactModel.canonicalSlug, {
          vendor: vendorSlug(exactModel.id.split("/")[0]) ? exactModel.id.split("/")[0]! : null,
        })
        if (named.status === "matched") {
          benchmarkMatches = named.items.map((item) => item.value)
          viaName = true
        }
      }
    }
    const benchmarkReferences = benchmarkSnapshot
      ? benchmarkMatches.map(({ record, recordIndex }) =>
          benchmarkReference(benchmarkSnapshot, recordIndex, record.modelPermaslug),
        )
      : []
    const exactModelReference = exactModel ? (modelReferences[0] ?? null) : null
    const benchmarkEvidence = boundedEvidence([
      ...nativeBaseReferences,
      ...(exactModelReference ? [exactModelReference] : modelReferences),
      ...benchmarkReferences,
    ])
    const benchmarkStatus: Candidate["benchmarkCorrespondence"]["status"] =
      benchmarkMatches.length === 1
        ? "exact"
        : benchmarkMatches.length > 1
          ? "ambiguous"
          : "unresolved"
    const benchmark = benchmarkMatches.length === 1 ? benchmarkMatches[0]!.record : null
    const benchmarkCorrespondence = {
      status: benchmarkStatus,
      basis: benchmarkMatches.length
        ? viaName
          ? ("name-identity" as const)
          : ("published-canonical-slug" as const)
        : null,
      evidence: benchmarkEvidence,
    }

    const route = {
      providerID: group.providerID,
      modelID: group.modelID,
      name: sameValue(group.records.map(({ record }) => record.name)) ?? null,
    }
    const publicModel = join.modelsDev(route)
    const publicBenchmarks = join.epoch(route).slice(0, 100)
    const publicQuotes = join.quotesForRoute(route)
    const candidateVariants = sortedUnique([...group.candidateVariants])
    for (const variant of candidateVariants) {
      const native = nativeEvidence(nativeSnapshot, group, variant)
      const view = makeNativeView(group, variant, native.evidence)
      const effortReferences = [
        ...native.supporting.map(({ recordIndex }) =>
          reference(nativeSnapshot, recordIndex, group.modelID),
        ),
        ...(exactModelReference ? [exactModelReference] : []),
        ...benchmarkReferences,
      ]
      output.push({
        ...view,
        correspondence,
        externalModel: exactModel,
        externalModelEvidence: boundedEvidence(modelReferences),
        benchmarkCorrespondence,
        externalBenchmark: benchmark,
        externalBenchmarkEvidence: boundedEvidence(benchmarkReferences),
        effortApplicability: {
          status: "unknown",
          evidence: boundedEvidence(effortReferences),
        },
        publicModel: publicModel?.record ?? null,
        publicBenchmarks: publicBenchmarks,
        publicQuotes: publicQuotes,
      })
    }
  }

  return output.sort((left, right) => {
    const providerOrder = compareText(left.identity.providerID, right.identity.providerID)
    if (providerOrder) return providerOrder
    const modelOrder = compareText(left.identity.modelID, right.identity.modelID)
    if (modelOrder) return modelOrder
    if (left.identity.variant === null) return right.identity.variant === null ? 0 : -1
    if (right.identity.variant === null) return 1
    return compareText(left.identity.variant, right.identity.variant)
  })
}

function normalizeFilters(filters?: ModelComparisonFilters): ModelComparisonFilters {
  return ModelComparisonFiltersSchema.parse({
    ...(filters?.providerID === undefined ? {} : { providerID: filters.providerID }),
    ...(filters?.search === undefined ? {} : { search: filters.search }),
    ...(filters?.enabled === undefined ? {} : { enabled: filters.enabled }),
  })
}

function decodeCursor(token: string) {
  try {
    const decoded = Buffer.from(token, "base64url")
    if (decoded.toString("base64url") !== token) throw new Error("invalid encoding")
    return ModelComparisonCursorSchema.parse(JSON.parse(decoded.toString("utf8")) as unknown)
  } catch {
    throw new Error("Model comparison cursor is invalid")
  }
}

function encodeCursor(cursor: {
  offset: number
  filters: ModelComparisonFilters
  snapshots: ModelComparisonSnapshotSelection
}): string {
  return Buffer.from(JSON.stringify({ version: 1, ...cursor })).toString("base64url")
}

function sameFilters(left: ModelComparisonFilters, right: ModelComparisonFilters): boolean {
  return stableJSON(normalizeFilters(left)) === stableJSON(normalizeFilters(right))
}

function snapshotSelection(
  sources: ModelEvidenceComparisonSourceRead[],
): ModelComparisonSnapshotSelection {
  return ModelComparisonSnapshotSelectionSchema.parse(
    Object.fromEntries(sources.map((source) => [source.source, source.snapshotID])),
  )
}

/** The public catalogs joined to the native routes of one snapshot set. */
function publicJoinFor(
  native: Extract<ModelEvidenceSnapshot, { source: "native-catalog" }> | null,
  modelSource: ModelEvidenceComparisonSourceRead,
  devSnapshot: ModelEvidenceSnapshot | null | undefined,
  epochSnapshot: ModelEvidenceSnapshot | null | undefined,
): PublicJoin {
  return createPublicJoin({
    modelsDev: devSnapshot?.source === "models-dev" ? devSnapshot.records : [],
    epoch: epochSnapshot?.source === "epoch-benchmarks" ? epochSnapshot.records : [],
    openrouter:
      modelSource.snapshot?.source === "openrouter-models" ? modelSource.snapshot.records : [],
    routes: native
      ? [
          ...new Map(
            native.records.map((record) => [`${record.providerID}\u0000${record.id}`, record]),
          ).values(),
        ].map((record) => ({
          providerID: record.providerID,
          modelID: record.id,
          name: record.name,
          nativePrice: nativeBasePrice(record),
        }))
      : [],
  })
}

/**
 * Every candidate of one snapshot set, unfiltered, in the comparison's order, with the first
 * page's public catalog and coverage: what `model_candidates` stores (`candidate-store.ts`). A
 * filtered comparison is this list with groups left out (filters drop whole provider-model groups
 * and no candidate reads another group), so a stored row equals the old read's candidate.
 * `sources` must carry the bodies of every source (`readComparisonSourcesFrom` without
 * `stampOnly`).
 */
export function buildComparisonCandidates(sources: readonly ModelEvidenceComparisonSourceRead[]) {
  const find = (name: ModelEvidenceComparisonSourceRead["source"]) =>
    sources.find((source) => source.source === name)
  const nativeSource = find("native-catalog")?.snapshot
  const native = nativeSource?.source === "native-catalog" ? nativeSource : null
  const modelSource = find("openrouter-models")
  if (!modelSource) throw new Error("Model comparison sources must include openrouter-models")
  const benchmarkSource = find("openrouter-benchmarks")?.snapshot
  const join = publicJoinFor(
    native,
    modelSource,
    find("models-dev")?.snapshot,
    find("epoch-benchmarks")?.snapshot,
  )
  const candidates = candidatesFor(
    native,
    modelSource,
    benchmarkSource?.source === "openrouter-benchmarks" ? benchmarkSource : null,
    normalizeFilters(),
    join,
  )
  return {
    candidates,
    publicCoverage: { epoch: join.coverage() },
    publicCatalog: [...join.external(), ...join.scoredRoutes()].slice(0, 200),
  }
}

/**
 * One page of the comparison, built from the pinned source snapshots. No RPC serves it since the
 * Models panel reads `model_candidates` and stored views; it stays as the reference the candidate
 * and view parity tests compare the stored rows with, and it keeps no cache.
 */
export function readModelComparison(
  store: Pick<ModelEvidenceReadStore, "readComparisonSources">,
  input: ModelComparisonReadInput | unknown = {},
): ModelComparisonOutput {
  const request = ModelComparisonReadInputSchema.parse(input)
  const decoded = request.cursor ? decodeCursor(request.cursor) : null
  const filters = decoded?.filters ?? normalizeFilters(request.filters)
  if (decoded && request.filters !== undefined && !sameFilters(decoded.filters, request.filters))
    throw new Error("Model comparison cursor filters do not match")

  const stamps = store.readComparisonSources(decoded?.snapshots, { stampOnly: true })
  const selection = decoded?.snapshots ?? snapshotSelection(stamps)
  const offset = decoded?.offset ?? 0
  const loaded = store.readComparisonSources(selection)
  const sources = stamps.map((read) => loaded.find((item) => item.source === read.source) ?? read)
  const nativeSource = sources.find((source) => source.source === "native-catalog")?.snapshot
  const modelSource = sources.find((source) => source.source === "openrouter-models")!
  const benchmarkSource = sources.find(
    (source) => source.source === "openrouter-benchmarks",
  )?.snapshot
  const native = nativeSource?.source === "native-catalog" ? nativeSource : null
  const devSnapshot = sources.find((source) => source.source === "models-dev")?.snapshot
  const epochSnapshot = sources.find((source) => source.source === "epoch-benchmarks")?.snapshot
  const join = publicJoinFor(native, modelSource, devSnapshot, epochSnapshot)
  const allCandidates = candidatesFor(
    native,
    modelSource,
    benchmarkSource?.source === "openrouter-benchmarks" ? benchmarkSource : null,
    filters,
    join,
  )
  if (offset > allCandidates.length) throw new Error("Model comparison cursor is unavailable")
  const candidates = allCandidates.slice(offset, offset + request.limit)
  const nextOffset = offset + candidates.length
  const nextCursor =
    nextOffset < allCandidates.length
      ? encodeCursor({ offset: nextOffset, filters, snapshots: selection })
      : null

  return ModelComparisonOutputSchema.parse({
    filters,
    sources: sources.map(sourceSummary),
    candidates,
    totalCandidates: allCandidates.length,
    nextCursor,
    ...(offset === 0
      ? {
          publicCoverage: { epoch: join.coverage() },
          publicCatalog: [...join.external(), ...join.scoredRoutes()].slice(0, 200),
        }
      : {}),
  })
}

export type { ModelComparisonReadInput }
