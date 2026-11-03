import {
  ModelComparisonEvidenceReferenceSchema,
  ModelComparisonSnapshotSelectionSchema,
  ModelComparisonSourceSchema,
} from "./comparison-schema.ts"
import { z } from "zod"
import type { ModelEvidenceSnapshot } from "./source-schema.ts"
import {
  MODEL_IDENTITY_RULE_VERSION,
  modelConfigurationID,
  modelIdentityReference,
  resolveModelIdentity,
  unsupportedModelGroupID,
} from "./model-identity.ts"
import type { ModelIdentityEvidenceReference, ModelIdentityResolution } from "./model-identity.ts"
import {
  ModelConfigurationsOutputSchema,
  ModelGroupConfigurationSchema,
  ModelGroupCursorSchema,
  ModelGroupSchema,
  ModelGroupsOutputSchema,
  ModelGroupFiltersSchema,
  ModelGroupReadContextSchema,
  ModelConfigurationsReadInputSchema,
  ModelGroupsReadInputSchema,
} from "./model-group-schema.ts"
import type {
  ModelConfigurationsReadInput,
  ModelGroup,
  ModelGroupConfiguration,
  ModelGroupFilters,
  ModelGroupReadContext,
  ModelGroupsReadInput,
} from "./model-group-schema.ts"
import { ModelEvidenceSnapshotSummarySchema } from "./source-schema.ts"
import type { ModelEvidenceComparisonSourceRead, ModelEvidenceReadStore } from "./source-store.ts"

type NativeSnapshot = Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>
type CatalogSnapshot = Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>
type BenchmarkSnapshot = Extract<ModelEvidenceSnapshot, { source: "openrouter-benchmarks" }>
type NativeRecord = NativeSnapshot["records"][number]
type CatalogRecord = CatalogSnapshot["records"][number]
type IdentityReference = ModelIdentityEvidenceReference
type EvidenceReference = z.infer<typeof ModelComparisonEvidenceReferenceSchema>
type Entry<T> = { record: T; recordIndex: number }
type ReadStore = Pick<ModelEvidenceReadStore, "projectDirectory" | "readComparisonSources">

type ConfigurationAccumulator = {
  configurationID: string
  candidateID: string
  groupID: string
  route: { providerID: string; modelID: string; variant: string | null }
  identity: ModelIdentityResolution
  catalogRecord: CatalogRecord | null
  catalogEvidence: IdentityReference[]
  nativeEntries: Array<Entry<NativeRecord>>
  routeEntries: Array<Entry<NativeRecord>>
}

type GroupAccumulator = {
  groupID: string
  productID: string | null
  catalogEntries: Array<Entry<CatalogRecord>>
  configurations: Map<string, ConfigurationAccumulator>
  metadataRules: Set<string>
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function stableJSON(value: unknown): string {
  return JSON.stringify(value)
}

function sameValue<T>(values: T[]): T | undefined {
  if (!values.length) return undefined
  const first = values[0]!
  return values.every((value) => stableJSON(value) === stableJSON(first)) ? first : undefined
}

function boundedEvidence(references: EvidenceReference[]) {
  const unique = new Map(
    references.map((reference) => [
      `${reference.source}:${reference.snapshotID}:${reference.recordIndex}`,
      reference,
    ]),
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
  return ModelComparisonSourceSchema.parse({
    source: source.source,
    storage: source.storage,
    snapshotState: source.snapshotState,
    selectedSnapshotID: source.snapshotID,
    refresh: source.refresh,
    snapshot: snapshot
      ? ModelEvidenceSnapshotSummarySchema.parse({ ...metadata, recordCount: records.length })
      : null,
  })
}

function snapshotSelection(sources: ModelEvidenceComparisonSourceRead[]) {
  return ModelComparisonSnapshotSelectionSchema.parse(
    Object.fromEntries(sources.map((source) => [source.source, source.snapshotID])),
  )
}

function normalizeFilters(filters?: ModelGroupFilters): ModelGroupFilters {
  return ModelGroupFiltersSchema.parse({
    ...(filters?.providerID === undefined ? {} : { providerID: filters.providerID }),
    ...(filters?.search === undefined ? {} : { search: filters.search }),
  })
}

function sameFilters(left: ModelGroupFilters, right: ModelGroupFilters): boolean {
  return stableJSON(normalizeFilters(left)) === stableJSON(normalizeFilters(right))
}

function sameSnapshots(
  left: ReturnType<typeof snapshotSelection>,
  right: ReturnType<typeof snapshotSelection>,
): boolean {
  return (
    left["native-catalog"] === right["native-catalog"] &&
    left["openrouter-models"] === right["openrouter-models"] &&
    left["openrouter-benchmarks"] === right["openrouter-benchmarks"]
  )
}

function decodeCursor(token: string) {
  try {
    const decoded = Buffer.from(token, "base64url")
    if (decoded.toString("base64url") !== token) throw new Error("invalid encoding")
    return ModelGroupCursorSchema.parse(JSON.parse(decoded.toString("utf8")) as unknown)
  } catch {
    throw new Error("Model group cursor is invalid")
  }
}

function encodeCursor(cursor: {
  kind: "groups" | "configurations"
  groupID: string | null
  offset: number
  scope: string
  filters: ModelGroupFilters
  groupFilters: ModelGroupFilters
  snapshots: ReturnType<typeof snapshotSelection>
}): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      ruleVersion: MODEL_IDENTITY_RULE_VERSION,
      ...cursor,
    }),
  ).toString("base64url")
}

function readCursor<
  T extends { cursor?: string; filters?: ModelGroupFilters; context?: ModelGroupReadContext },
>(store: ReadStore, input: T, kind: "groups" | "configurations", groupID: string | null) {
  const decoded = input.cursor ? decodeCursor(input.cursor) : null
  if (decoded && decoded.kind !== kind) throw new Error("Model group cursor kind does not match")
  if (decoded && decoded.groupID !== groupID)
    throw new Error("Model group cursor group does not match")
  if (decoded && decoded.scope !== store.projectDirectory)
    throw new Error("Model group cursor scope does not match")
  const context = input.context ? ModelGroupReadContextSchema.parse(input.context) : null
  if (context && context.scope !== store.projectDirectory)
    throw new Error("Model group context scope does not match")
  if (context && context.ruleVersion !== MODEL_IDENTITY_RULE_VERSION)
    throw new Error("Model group context rule version does not match")
  const filters = decoded?.filters ?? normalizeFilters(input.filters)
  if (decoded && input.filters !== undefined && !sameFilters(decoded.filters, input.filters))
    throw new Error("Model group cursor filters do not match")
  const groupFilters = context?.filters ?? decoded?.groupFilters ?? filters
  if (decoded && !context && !sameFilters(decoded.groupFilters, decoded.filters))
    throw new Error("Model group cursor context filters do not match")
  if (context && decoded) {
    if (
      context.scope !== decoded.scope ||
      context.ruleVersion !== decoded.ruleVersion ||
      !sameFilters(context.filters, decoded.groupFilters) ||
      !sameSnapshots(context.snapshots, decoded.snapshots)
    )
      throw new Error("Model group cursor context does not match")
  }
  const selectedSnapshots = decoded?.snapshots ?? context?.snapshots
  const sources = store.readComparisonSources(selectedSnapshots)
  const snapshots = decoded?.snapshots ?? selectedSnapshots ?? snapshotSelection(sources)
  if (selectedSnapshots) {
    for (const source of sources) {
      const expected = selectedSnapshots[source.source]
      if (
        expected !== null &&
        (source.snapshotID !== expected ||
          source.snapshotState === "missing-snapshot" ||
          source.snapshotState === "missing-table")
      )
        throw new Error("Model group context source pin is unavailable")
    }
  }
  const readContext = ModelGroupReadContextSchema.parse({
    scope: store.projectDirectory,
    ruleVersion: MODEL_IDENTITY_RULE_VERSION,
    filters: groupFilters,
    snapshots,
  })
  return { decoded, filters, groupFilters, context: readContext, sources, snapshots }
}

function routeKey(providerID: string, modelID: string): string {
  return stableJSON([providerID, modelID])
}

function variants(record: NativeRecord): Array<string | null> {
  if (!record.variants?.length) return [null]
  return [...new Set(record.variants)].sort(compareText)
}

function routeGroupRecords(snapshot: NativeSnapshot) {
  const groups = new Map<
    string,
    {
      providerID: string
      modelID: string
      records: Array<Entry<NativeRecord>>
      variants: Set<string | null>
    }
  >()
  snapshot.records.forEach((record, recordIndex) => {
    const key = routeKey(record.providerID, record.id)
    let group = groups.get(key)
    if (!group) {
      group = {
        providerID: record.providerID,
        modelID: record.id,
        records: [],
        variants: new Set(),
      }
      groups.set(key, group)
    }
    group.records.push({ record, recordIndex })
    for (const variant of variants(record)) group.variants.add(variant)
  })
  return [...groups.values()].sort((left, right) =>
    compareText(routeKey(left.providerID, left.modelID), routeKey(right.providerID, right.modelID)),
  )
}

function identityReferences(
  snapshot: NativeSnapshot,
  entries: Array<Entry<NativeRecord>>,
  source?: ModelEvidenceComparisonSourceRead,
): IdentityReference[] {
  return entries.map(({ record, recordIndex }) =>
    modelIdentityReference(
      "native-catalog",
      snapshot,
      sourceRecordIndex(source, recordIndex),
      record.id,
    ),
  )
}

function benchmarkReference(
  snapshot: BenchmarkSnapshot,
  recordIndex: number,
  recordID: string,
): EvidenceReference {
  return {
    source: "openrouter-benchmarks",
    snapshotID: snapshot.snapshotID,
    generation: snapshot.generation,
    recordIndex,
    recordID,
  }
}

function sourceRecordIndex(source: ModelEvidenceComparisonSourceRead | undefined, index: number) {
  const recordIndexes = (
    source as
      | (ModelEvidenceComparisonSourceRead & {
          recordIndexes?: readonly number[]
        })
      | undefined
  )?.recordIndexes
  return recordIndexes?.[index] ?? index
}

function identityStatus(
  values: Array<ModelIdentityResolution["status"]>,
  configurationCount: number,
): ModelGroup["identityStatus"] {
  if (configurationCount === 0) return "metadata-only"
  const distinct = [...new Set(values)]
  return distinct.length === 1 ? distinct[0]! : "mixed"
}

function nativeView(
  snapshot: NativeSnapshot,
  entries: Array<Entry<NativeRecord>>,
  routeEntries: Array<Entry<NativeRecord>>,
  source: ModelEvidenceComparisonSourceRead,
) {
  const records = entries.map(({ record }) => record)
  const routeRecords = routeEntries.map(({ record }) => record)
  const availableVariants = routeRecords.some((record) => record.variants === null)
    ? null
    : [...new Set(routeRecords.flatMap((record) => record.variants ?? []))].sort(compareText)
  const variantCoverage =
    availableVariants === null
      ? { status: "unknown" as const, totalVariants: null, omittedVariants: null }
      : {
          status: availableVariants.length > 100 ? ("truncated" as const) : ("complete" as const),
          totalVariants: availableVariants.length,
          omittedVariants: Math.max(0, availableVariants.length - 100),
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
  return {
    source: "native-catalog" as const,
    name: sameValue(records.map((record) => record.name)) ?? null,
    enabled: sameValue(records.map((record) => record.enabled)) ?? null,
    type: sameValue(records.map((record) => record.type)) ?? null,
    contextTokens: sameValue(records.map((record) => record.contextTokens)) ?? null,
    capabilities: {
      tools: sameValue(records.map((record) => record.capabilities.tools)) ?? null,
      input: sameValue(records.map((record) => record.capabilities.input)) ?? null,
      output: sameValue(records.map((record) => record.capabilities.output)) ?? null,
    },
    availableVariants: availableVariants?.slice(0, 100) ?? null,
    variantCoverage,
    prices: sameValue(records.map((record) => record.prices)) ?? null,
    ambiguousIdentity: identitySignatures.some((signature) => signature !== identitySignatures[0]),
    evidence: boundedEvidence(identityReferences(snapshot, entries, source)),
  }
}

function makeGroups(sources: ModelEvidenceComparisonSourceRead[]): {
  groups: ModelGroup[]
  configurations: Map<string, ModelGroupConfiguration[]>
} {
  const nativeSnapshot = sources.find((source) => source.source === "native-catalog")?.snapshot
  const catalogSnapshot = sources.find((source) => source.source === "openrouter-models")?.snapshot
  const benchmarkSnapshot = sources.find(
    (source) => source.source === "openrouter-benchmarks",
  )?.snapshot
  const nativeSource = sources.find((source) => source.source === "native-catalog")!
  const native = nativeSnapshot?.source === "native-catalog" ? nativeSnapshot : null
  const catalog = catalogSnapshot?.source === "openrouter-models" ? catalogSnapshot : null
  const benchmarks =
    benchmarkSnapshot?.source === "openrouter-benchmarks" ? benchmarkSnapshot : null
  const catalogSource = sources.find((source) => source.source === "openrouter-models")!
  const accumulators = new Map<string, GroupAccumulator>()
  const ensureGroup = (groupID: string, productID: string | null): GroupAccumulator => {
    let group = accumulators.get(groupID)
    if (!group) {
      group = {
        groupID,
        productID,
        catalogEntries: [],
        configurations: new Map(),
        metadataRules: new Set(),
      }
      accumulators.set(groupID, group)
    }
    return group
  }

  if (catalog) {
    catalog.records.forEach((record, index) => {
      const group = ensureGroup(record.id, record.id)
      group.catalogEntries.push({ record, recordIndex: sourceRecordIndex(catalogSource, index) })
      group.metadataRules.add(
        record.id.includes("/") ? "owner-qualified-catalog-id-v1" : "exact-published-catalog-id-v1",
      )
    })
  }

  if (native) {
    for (const route of routeGroupRecords(native)) {
      const routeEntries = route.records
      for (const variant of [...route.variants].sort((left, right) => {
        if (left === null) return right === null ? 0 : -1
        if (right === null) return 1
        return compareText(left, right)
      })) {
        const supporting = routeEntries.filter(({ record }) => variants(record).includes(variant))
        const nativeRefs = identityReferences(native, supporting, nativeSource)
        const resolved = resolveModelIdentity({
          route: { providerID: route.providerID, modelID: route.modelID },
          nativeEvidence: nativeRefs,
          catalogSource,
        })
        const groupID =
          resolved.resolution.productID ??
          unsupportedModelGroupID({ providerID: route.providerID, modelID: route.modelID })
        const group = ensureGroup(groupID, resolved.resolution.productID)
        const configurationID = modelConfigurationID(route.providerID, route.modelID, variant)
        group.configurations.set(configurationID, {
          configurationID,
          candidateID: configurationID,
          groupID,
          route: { providerID: route.providerID, modelID: route.modelID, variant },
          identity: resolved.resolution,
          catalogRecord:
            resolved.resolution.status === "exact"
              ? (resolved.catalogMatches[0]?.record ?? null)
              : null,
          catalogEvidence: catalog
            ? resolved.catalogMatches.map(({ record, recordIndex }) =>
                modelIdentityReference("openrouter-models", catalog, recordIndex, record.id),
              )
            : [],
          nativeEntries: supporting,
          routeEntries,
        })
      }
    }
  }

  const groupRows: ModelGroup[] = []
  const configurationPages = new Map<string, ModelGroupConfiguration[]>()
  for (const group of accumulators.values()) {
    const configurationAccumulators = [...group.configurations.values()]
    const configurations = configurationAccumulators
      .map((configuration) => {
        const nativeEntryView = nativeView(
          native!,
          configuration.nativeEntries,
          configuration.routeEntries,
          nativeSource,
        )
        const nativeEvidence = boundedEvidence(
          identityReferences(native!, configuration.nativeEntries, nativeSource),
        )
        const externalCatalogEvidence = boundedEvidence(configuration.catalogEvidence)
        const benchmarkMatches =
          configuration.catalogRecord?.canonicalSlug && benchmarks
            ? benchmarks.records
                .map((record, recordIndex) => ({ record, recordIndex }))
                .filter(
                  ({ record }) =>
                    record.modelPermaslug === configuration.catalogRecord!.canonicalSlug,
                )
            : []
        const benchmarkReferences = benchmarks
          ? benchmarkMatches.map(({ record, recordIndex }) =>
              benchmarkReference(benchmarks, recordIndex, record.modelPermaslug),
            )
          : []
        const benchmarkEvidence = boundedEvidence([
          ...configuration.identity.evidence.native,
          ...configuration.identity.evidence.catalog,
          ...benchmarkReferences,
        ])
        const externalBenchmarkEvidence = boundedEvidence(benchmarkReferences)
        return ModelGroupConfigurationSchema.parse({
          candidateID: configuration.candidateID,
          configurationID: configuration.configurationID,
          groupID: group.groupID,
          route: configuration.route,
          identity: configuration.identity,
          native: { ...nativeEntryView, evidence: nativeEvidence },
          externalCatalog: {
            source: "openrouter-models",
            model: configuration.catalogRecord,
            evidence: externalCatalogEvidence,
          },
          benchmarkCorrespondence: {
            status:
              benchmarkMatches.length === 1
                ? "exact"
                : benchmarkMatches.length > 1
                  ? "ambiguous"
                  : "unresolved",
            basis: benchmarkMatches.length ? "published-canonical-slug" : null,
            evidence: benchmarkEvidence,
          },
          externalBenchmark: benchmarkMatches.length === 1 ? benchmarkMatches[0]!.record : null,
          externalBenchmarkEvidence,
          effortApplicability: {
            status: "unknown",
            evidence: boundedEvidence([
              ...configuration.identity.evidence.native,
              ...configuration.identity.evidence.catalog,
              ...benchmarkReferences,
            ]),
          },
        })
      })
      .sort((left, right) => {
        const provider = compareText(left.route.providerID, right.route.providerID)
        if (provider) return provider
        const model = compareText(left.route.modelID, right.route.modelID)
        if (model) return model
        if (left.route.variant === null) return right.route.variant === null ? 0 : -1
        if (right.route.variant === null) return 1
        return compareText(left.route.variant, right.route.variant)
      })

    const catalogRecords = group.catalogEntries.map(({ record }) => record)
    const nativeEvidence = boundedEvidence(
      configurationAccumulators.flatMap((configuration) =>
        identityReferences(native!, configuration.nativeEntries, nativeSource),
      ),
    )
    const catalogIdentityReferences = group.catalogEntries.flatMap(({ record, recordIndex }) =>
      catalog ? [modelIdentityReference("openrouter-models", catalog, recordIndex, record.id)] : [],
    )
    const catalogEvidence = boundedEvidence([
      ...catalogIdentityReferences,
      ...configurationAccumulators.flatMap((configuration) => configuration.catalogEvidence),
    ])
    const configStatuses = configurations.map((configuration) => configuration.identity.status)
    const rules = new Map<string, ModelIdentityResolution["rules"][number]>()
    for (const configuration of configurations)
      for (const rule of configuration.identity.rules) rules.set(rule.id, rule)
    for (const id of group.metadataRules)
      rules.set(id, { id, version: MODEL_IDENTITY_RULE_VERSION as 1 })
    const displayName =
      sameValue(catalogRecords.map((record) => record.name)) ??
      sameValue(configurations.map((configuration) => configuration.native.name)) ??
      null
    const nativeRecordCount = nativeEvidence.recordCount
    const row = ModelGroupSchema.parse({
      groupID: group.groupID,
      productID: group.productID,
      displayName,
      identityStatus: identityStatus(configStatuses, configurations.length),
      configurationCount: configurations.length,
      nativeRecordCount,
      catalogRecordCount: catalogEvidence.recordCount,
      rules: [...rules.values()].sort((left, right) => compareText(left.id, right.id)),
      nativeEvidence,
      catalogEvidence,
    })
    groupRows.push(row)
    configurationPages.set(group.groupID, configurations)
  }
  groupRows.sort((left, right) => compareText(left.groupID, right.groupID))
  return { groups: groupRows, configurations: configurationPages }
}

function groupMatches(
  group: ModelGroup,
  configs: ModelGroupConfiguration[],
  filters: ModelGroupFilters,
) {
  if (
    filters.providerID &&
    !configs.some((configuration) => configuration.route.providerID === filters.providerID)
  )
    return false
  const search = filters.search?.toLowerCase()
  if (!search) return true
  return [
    group.groupID,
    group.productID ?? "",
    group.displayName ?? "",
    ...configs.flatMap((config) => [
      config.route.providerID,
      config.route.modelID,
      config.native.name ?? "",
    ]),
  ].some((value) => value.toLowerCase().includes(search))
}

function configurationMatches(configuration: ModelGroupConfiguration, filters: ModelGroupFilters) {
  if (filters.providerID && configuration.route.providerID !== filters.providerID) return false
  const search = filters.search?.toLowerCase()
  return (
    !search ||
    [
      configuration.groupID,
      configuration.route.providerID,
      configuration.route.modelID,
      configuration.route.variant ?? "",
      configuration.native.name ?? "",
    ].some((value) => value.toLowerCase().includes(search))
  )
}

/** Read stable product groups, applying filters before bounded group pagination. */
export function readModelGroups(store: ReadStore, input: ModelGroupsReadInput | unknown = {}) {
  const request = ModelGroupsReadInputSchema.parse(input)
  const page = readCursor(store, request, "groups", null)
  const model = makeGroups(page.sources)
  const filtered = model.groups.filter((group) =>
    groupMatches(group, model.configurations.get(group.groupID) ?? [], page.filters),
  )
  const offset = page.decoded?.offset ?? 0
  if (offset > filtered.length) throw new Error("Model group cursor is unavailable")
  const groups = filtered.slice(offset, offset + request.limit)
  const nextOffset = offset + groups.length
  const nextCursor =
    nextOffset < filtered.length
      ? encodeCursor({
          kind: "groups",
          groupID: null,
          offset: nextOffset,
          scope: store.projectDirectory,
          filters: page.filters,
          groupFilters: page.context.filters,
          snapshots: page.snapshots,
        })
      : null
  return ModelGroupsOutputSchema.parse({
    schemaVersion: 1,
    context: page.context,
    filters: page.filters,
    sources: page.sources.map(sourceSummary),
    groups,
    totalGroups: filtered.length,
    nextCursor,
  })
}

/** Read one group's exact native route/effort configurations on an independent cursor. */
export function readModelConfigurations(
  store: ReadStore,
  input: ModelConfigurationsReadInput | unknown,
) {
  const request = ModelConfigurationsReadInputSchema.parse(input)
  const page = readCursor(store, request, "configurations", request.groupID)
  const model = makeGroups(page.sources)
  const group = model.groups.find((candidate) => candidate.groupID === request.groupID)
  if (
    !group ||
    !groupMatches(group, model.configurations.get(request.groupID) ?? [], page.groupFilters)
  )
    throw new Error("Model group is unavailable in this context")
  const groupConfigurations = model.configurations.get(request.groupID) ?? []
  const filtered = groupConfigurations.filter((configuration) =>
    configurationMatches(configuration, page.filters),
  )
  const offset = page.decoded?.offset ?? 0
  if (offset > filtered.length) throw new Error("Model configuration cursor is unavailable")
  const configurations = filtered.slice(offset, offset + request.limit)
  const nextOffset = offset + configurations.length
  const nextCursor =
    nextOffset < filtered.length
      ? encodeCursor({
          kind: "configurations",
          groupID: request.groupID,
          offset: nextOffset,
          scope: store.projectDirectory,
          filters: page.filters,
          groupFilters: page.context.filters,
          snapshots: page.snapshots,
        })
      : null
  return ModelConfigurationsOutputSchema.parse({
    schemaVersion: 1,
    context: page.context,
    groupID: request.groupID,
    filters: page.filters,
    sources: page.sources.map(sourceSummary),
    configurations,
    totalConfigurations: filtered.length,
    nextCursor,
  })
}
