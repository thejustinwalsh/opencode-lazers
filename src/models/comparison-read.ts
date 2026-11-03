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

type NativeRecord = Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>["records"][number]
type OpenRouterModelRecord = Extract<
  ModelEvidenceSnapshot,
  { source: "openrouter-models" }
>["records"][number]
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

function candidateID(providerID: string, modelID: string, variant: string | null): string {
  const segment = (value: string | null) => (value === null ? "-" : `${value.length}:${value}`)
  return [segment(providerID), segment(modelID), segment(variant)].join("|")
}

function sameValue<T>(values: T[]): T | undefined {
  if (!values.length) return undefined
  const first = values[0]!
  return values.every((value) => stableJSON(value) === stableJSON(first)) ? first : undefined
}

function reference(
  source: ModelEvidenceSnapshot,
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

function sourceSummary(source: ModelEvidenceComparisonSourceRead) {
  const snapshot = source.snapshot
  const { records, ...metadata } = snapshot ?? { records: [] }
  return {
    source: source.source,
    storage: source.storage,
    snapshotState: source.snapshotState,
    selectedSnapshotID: source.snapshotID,
    refresh: source.refresh,
    snapshot: snapshot
      ? ModelEvidenceSnapshotSummarySchema.parse({ ...metadata, recordCount: records.length })
      : null,
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
    candidateID: candidateID(group.providerID, group.modelID, variant),
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

function indexByID<T extends { id: string }>(records: T[] | undefined) {
  const index = new Map<string, Array<{ record: T; recordIndex: number }>>()
  records?.forEach((record, recordIndex) => {
    const matches = index.get(record.id) ?? []
    matches.push({ record, recordIndex })
    index.set(record.id, matches)
  })
  return index
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

function candidatesFor(
  nativeSnapshot: Extract<ModelEvidenceSnapshot, { source: "native-catalog" }> | null,
  modelSnapshot: Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }> | null,
  benchmarkSnapshot: Extract<ModelEvidenceSnapshot, { source: "openrouter-benchmarks" }> | null,
  filters: ModelComparisonFilters,
): Candidate[] {
  if (!nativeSnapshot) return []
  const groups = filtered(candidateGroups(nativeSnapshot), filters)
  const modelRecords = (modelSnapshot?.records ?? []) as OpenRouterModelRecord[]
  const benchmarkRecords = (benchmarkSnapshot?.records ?? []) as OpenRouterBenchmarkRecord[]
  const modelIndex = indexByID(modelRecords)
  const benchmarkIndex = indexBenchmarks(benchmarkRecords)
  const output: Candidate[] = []

  for (const group of groups) {
    const matchingModels =
      group.providerID === "openrouter" ? (modelIndex.get(group.modelID) ?? []) : []
    const modelReferences = modelSnapshot
      ? matchingModels.map(({ record, recordIndex }) =>
          reference(modelSnapshot, recordIndex, record.id),
        )
      : []
    const correspondenceStatus: Candidate["correspondence"]["status"] =
      matchingModels.length === 1 ? "exact" : matchingModels.length > 1 ? "ambiguous" : "unresolved"
    const exactModel = matchingModels.length === 1 ? matchingModels[0]!.record : null
    const nativeBaseReferences = group.records.map(({ recordIndex }) =>
      reference(nativeSnapshot, recordIndex, group.modelID),
    )
    const correspondenceEvidence = boundedEvidence([...nativeBaseReferences, ...modelReferences])
    const correspondence = {
      status: correspondenceStatus,
      basis: matchingModels.length
        ? ("direct-openrouter-route-and-exact-catalog-id" as const)
        : null,
      evidence: correspondenceEvidence,
    }

    let benchmarkMatches: Array<{ record: OpenRouterBenchmarkRecord; recordIndex: number }> = []
    if (exactModel?.canonicalSlug && benchmarkSnapshot) {
      benchmarkMatches = benchmarkIndex.get(exactModel.canonicalSlug) ?? []
    }
    const benchmarkReferences = benchmarkSnapshot
      ? benchmarkMatches.map(({ record, recordIndex }) =>
          reference(benchmarkSnapshot, recordIndex, record.modelPermaslug),
        )
      : []
    const exactModelReference =
      exactModel && modelSnapshot
        ? reference(modelSnapshot, matchingModels[0]!.recordIndex, exactModel.id)
        : null
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
      basis: benchmarkMatches.length ? ("published-canonical-slug" as const) : null,
      evidence: benchmarkEvidence,
    }

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

/** Project a stable, filtered page from pinned source snapshots. */
export function readModelComparison(
  store: Pick<ModelEvidenceReadStore, "readComparisonSources">,
  input: ModelComparisonReadInput | unknown = {},
): ModelComparisonOutput {
  const request = ModelComparisonReadInputSchema.parse(input)
  const decoded = request.cursor ? decodeCursor(request.cursor) : null
  const filters = decoded?.filters ?? normalizeFilters(request.filters)
  if (decoded && request.filters !== undefined && !sameFilters(decoded.filters, request.filters))
    throw new Error("Model comparison cursor filters do not match")

  const sources = store.readComparisonSources(decoded?.snapshots)
  const selection = decoded?.snapshots ?? snapshotSelection(sources)
  const nativeSource = sources.find((source) => source.source === "native-catalog")?.snapshot
  const modelSource = sources.find((source) => source.source === "openrouter-models")?.snapshot
  const benchmarkSource = sources.find(
    (source) => source.source === "openrouter-benchmarks",
  )?.snapshot
  const allCandidates = candidatesFor(
    nativeSource?.source === "native-catalog" ? nativeSource : null,
    modelSource?.source === "openrouter-models" ? modelSource : null,
    benchmarkSource?.source === "openrouter-benchmarks" ? benchmarkSource : null,
    filters,
  )
  const offset = decoded?.offset ?? 0
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
  })
}

export type { ModelComparisonReadInput }
