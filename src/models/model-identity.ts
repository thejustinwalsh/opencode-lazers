import { z } from "zod"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import type { ModelEvidenceSnapshot } from "./source-schema.ts"
import { createModelIndex, parseModelName, vendorSlug } from "./name-identity.ts"
import type { ModelIndex } from "./name-identity.ts"

export const MODEL_IDENTITY_RULE_VERSION = 1

export const ModelIdentityEvidenceReferenceSchema = z.strictObject({
  source: z.enum(["native-catalog", "openrouter-models"]),
  snapshotID: z.uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  recordIndex: z.number().int().nonnegative().max(1_999),
  recordID: z.string().min(1).max(512),
})
export type ModelIdentityEvidenceReference = z.infer<typeof ModelIdentityEvidenceReferenceSchema>

export const ModelIdentityRuleCitationSchema = z.strictObject({
  url: z.url().max(2_048),
  retrievedOn: z.iso.date(),
  excerpt: z.string().min(1).max(512),
  snapshotID: z.uuid().nullable(),
  retrievedAt: z.iso.datetime().nullable(),
  recordID: z.string().max(512).nullable(),
})

export const ModelIdentityRuleSchema = z.strictObject({
  id: z.string().min(1).max(128),
  version: z.literal(MODEL_IDENTITY_RULE_VERSION),
  citations: z.array(ModelIdentityRuleCitationSchema).max(4).optional(),
})

export const ModelIdentityResolutionSchema = z.strictObject({
  status: z.enum([
    "exact",
    "ambiguous",
    "unsupported",
    "supported-but-absent",
    "source-unavailable",
  ]),
  productID: z.string().min(1).max(512).nullable(),
  rules: z.array(ModelIdentityRuleSchema).max(10),
  basis: z
    .enum([
      "exact-published-catalog-id",
      "owner-qualified-catalog-id",
      "provider-owner-qualification",
      "verified-source-backed-route-alias",
      "name-identity",
    ])
    .nullable(),
  catalogSourceState: z.enum(["available", "none", "missing-table", "missing-snapshot"]),
  evidence: z.strictObject({
    native: z.array(ModelIdentityEvidenceReferenceSchema).max(100),
    catalog: z.array(ModelIdentityEvidenceReferenceSchema).max(100),
    nativeRecordCount: z.number().int().nonnegative().max(4_000),
    catalogRecordCount: z.number().int().nonnegative().max(4_000),
    nativeTruncated: z.boolean(),
    catalogTruncated: z.boolean(),
  }),
})
export type ModelIdentityResolution = z.infer<typeof ModelIdentityResolutionSchema>

type RouteRule = {
  id: string
  catalogModelID: string
  productID: string
  basis:
    | "exact-published-catalog-id"
    | "owner-qualified-catalog-id"
    | "provider-owner-qualification"
    | "verified-source-backed-route-alias"
    | "name-identity"
  citations?: z.infer<typeof ModelIdentityRuleCitationSchema>[]
}

/** These execution provider IDs are verified source owners even while the catalog is unavailable. */
const SUPPORTED_OWNER_NAMESPACES = new Set(["anthropic", "openai"])

const VERIFIED_ROUTE_ALIASES: Array<RouteRule & { providerID: string; modelID: string }> = [
  {
    id: "opencode-go-kimi-k3-1-pro-to-openrouter-kimi-k3-1-pro-v1",
    providerID: "opencode-go",
    modelID: "kimi-k3.1-pro",
    catalogModelID: "moonshotai/kimi-k3.1-pro",
    productID: "moonshotai/kimi-k3.1-pro",
    basis: "verified-source-backed-route-alias",
    citations: [
      {
        url: "https://opencode.ai/v2/docs/console/go/",
        retrievedOn: "2026-11-03",
        excerpt:
          "| Kimi K3.1 Pro | kimi-k3.1-pro | `https://opencode.ai/inference/go/openai/v1/chat/completions` | `@ai-sdk/openai-compatible` |\nTo use Go in OpenCode, connect with `/connect` and set the [model](/models) using the format `opencode-go/<model-id>`:",
        snapshotID: null,
        retrievedAt: null,
        recordID: null,
      },
      {
        url: "https://openrouter.ai/moonshotai/kimi-k3.1-pro/llms.txt",
        retrievedOn: "2026-11-03",
        excerpt: '- model: string (required) — "moonshotai/kimi-k3.1-pro"',
        snapshotID: null,
        retrievedAt: null,
        recordID: null,
      },
    ],
  },
  {
    id: "opencode-go-qwen3-8-flash-to-openrouter-qwen3-8-flash-v1",
    providerID: "opencode-go",
    modelID: "qwen3.8-flash",
    catalogModelID: "qwen/qwen3.8-flash",
    productID: "qwen/qwen3.8-flash",
    basis: "verified-source-backed-route-alias",
    citations: [
      {
        url: "https://opencode.ai/v2/docs/console/go/",
        retrievedOn: "2026-11-03",
        excerpt:
          "| Qwen3.8 Flash | qwen3.8-flash | `https://opencode.ai/inference/go/anthropic/v1/messages` | `@ai-sdk/anthropic` |\nTo use Go in OpenCode, connect with `/connect` and set the [model](/models) using the format `opencode-go/<model-id>`:",
        snapshotID: null,
        retrievedAt: null,
        recordID: null,
      },
      {
        url: "https://openrouter.ai/qwen/qwen3.8-flash/llms.txt",
        retrievedOn: "2026-11-03",
        excerpt: '- model: string (required) — "qwen/qwen3.8-flash"',
        snapshotID: null,
        retrievedAt: null,
        recordID: null,
      },
    ],
  },
  {
    id: "anthropic-haiku-5-5-to-openrouter-haiku-5-5-v1",
    providerID: "anthropic",
    modelID: "claude-haiku-5-5",
    catalogModelID: "anthropic/claude-haiku-5.5",
    productID: "anthropic/claude-haiku-5.5",
    basis: "verified-source-backed-route-alias",
    citations: [
      {
        url: "https://platform.claude.com/docs/en/models/overview",
        retrievedOn: "2026-11-03",
        excerpt:
          "| Feature | Claude Fable 5.1 | Claude Opus 5.5 | Claude Sonnet 5.5 | Claude Haiku 5.5 |\n| :--- | :--- | :--- | :--- | :--- |\n| Claude API ID | `claude-fable-5-1` | `claude-opus-5-5` | `claude-sonnet-5-5` | `claude-haiku-5-5` |",
        snapshotID: null,
        retrievedAt: null,
        recordID: null,
      },
    ],
  },
  {
    id: "anthropic-sonnet-5-5-to-openrouter-sonnet-5-5-v1",
    providerID: "anthropic",
    modelID: "claude-sonnet-5-5",
    catalogModelID: "anthropic/claude-sonnet-5.5",
    productID: "anthropic/claude-sonnet-5.5",
    basis: "verified-source-backed-route-alias",
    citations: [
      {
        url: "https://platform.claude.com/docs/en/models/overview",
        retrievedOn: "2026-11-03",
        excerpt:
          "| Feature | Claude Fable 5.1 | Claude Opus 5.5 | Claude Sonnet 5.5 | Claude Haiku 5.5 |\n| :--- | :--- | :--- | :--- | :--- |\n| Claude API ID | `claude-fable-5-1` | `claude-opus-5-5` | `claude-sonnet-5-5` | `claude-haiku-5-5` |",
        snapshotID: null,
        retrievedAt: null,
        recordID: null,
      },
    ],
  },
]

type OpenRouterModelRecord = Extract<
  ModelEvidenceSnapshot,
  { source: "openrouter-models" }
>["records"][number]
type CatalogSnapshot = Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>

type Route = { providerID: string; modelID: string }
type RecordEntry<T> = { record: T; recordIndex: number }

function originalRecordIndex(source: ModelEvidenceComparisonSourceRead, index: number): number {
  const recordIndexes = (
    source as ModelEvidenceComparisonSourceRead & {
      recordIndexes?: readonly number[]
    }
  ).recordIndexes
  return recordIndexes?.[index] ?? index
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function segment(value: string): string {
  return `${value.length}:${value}`
}

export function modelConfigurationID(
  providerID: string,
  modelID: string,
  variant: string | null,
): string {
  return [segment(providerID), segment(modelID), variant === null ? "-" : segment(variant)].join(
    "|",
  )
}

export function unsupportedModelGroupID(route: Route): string {
  return `route:${segment(route.providerID)}:${segment(route.modelID)}`
}

function boundedReferences(references: ModelIdentityEvidenceReference[]) {
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

export function modelIdentityReference(
  source: "native-catalog" | "openrouter-models",
  snapshot: Extract<ModelEvidenceSnapshot, { source: "native-catalog" | "openrouter-models" }>,
  recordIndex: number,
  recordID: string,
): ModelIdentityEvidenceReference {
  return {
    source,
    snapshotID: snapshot.snapshotID,
    generation: snapshot.generation,
    recordIndex,
    recordID,
  }
}

function ownerNamespace(modelID: string): string | null {
  const separator = modelID.indexOf("/")
  if (separator <= 0 || separator === modelID.length - 1) return null
  return modelID.slice(0, separator)
}

function sourceSupportsOwner(providerID: string, catalogSnapshot: CatalogSnapshot | null): boolean {
  if (SUPPORTED_OWNER_NAMESPACES.has(providerID)) return true
  return Boolean(
    catalogSnapshot?.records.some((record) => ownerNamespace(record.id) === providerID),
  )
}

function routeRules(route: Route, catalogSnapshot: CatalogSnapshot | null): RouteRule[] {
  const verifiedAliases = VERIFIED_ROUTE_ALIASES.filter(
    (rule) => rule.providerID === route.providerID && rule.modelID === route.modelID,
  )
  if (verifiedAliases.length) return verifiedAliases

  const qualifiedOwner = ownerNamespace(route.modelID)
  if (qualifiedOwner) {
    const ownerIsKnown =
      SUPPORTED_OWNER_NAMESPACES.has(qualifiedOwner) ||
      Boolean(
        catalogSnapshot?.records.some((record) => ownerNamespace(record.id) === qualifiedOwner),
      )
    if (ownerIsKnown || !catalogSnapshot)
      return [
        {
          id: "owner-qualified-catalog-id-v1",
          catalogModelID: route.modelID,
          productID: route.modelID,
          basis: "owner-qualified-catalog-id",
        },
      ]
    return []
  }

  if (catalogSnapshot?.records.some((record) => record.id === route.modelID))
    return [
      {
        id: "exact-published-catalog-id-v1",
        catalogModelID: route.modelID,
        productID: route.modelID,
        basis: "exact-published-catalog-id",
      },
    ]

  if (!sourceSupportsOwner(route.providerID, catalogSnapshot)) return []
  const catalogModelID = `${route.providerID}/${route.modelID}`
  return [
    {
      id: "provider-owner-qualified-local-id-v1",
      catalogModelID,
      productID: catalogModelID,
      basis: "provider-owner-qualification",
    },
  ]
}

function serializeRules(
  rules: RouteRule[],
  catalogSnapshot: CatalogSnapshot | null,
  catalogMatches: Array<RecordEntry<OpenRouterModelRecord>>,
) {
  return rules
    .map((rule) => {
      const matchedCatalogRecord =
        rule.basis === "verified-source-backed-route-alias"
          ? catalogMatches.find(({ record }) => record.id === rule.catalogModelID)?.record
          : undefined
      const citations = [
        ...(rule.citations ?? []),
        ...(catalogSnapshot && matchedCatalogRecord
          ? [
              {
                url: "https://openrouter.ai/api/v1/models",
                retrievedOn: catalogSnapshot.retrievedAt.slice(0, 10),
                excerpt: `"id": "${matchedCatalogRecord.id}"`,
                snapshotID: catalogSnapshot.snapshotID,
                retrievedAt: catalogSnapshot.retrievedAt,
                recordID: matchedCatalogRecord.id,
              },
            ]
          : []),
      ]
      return {
        id: rule.id,
        version: MODEL_IDENTITY_RULE_VERSION as 1,
        ...(citations.length ? { citations } : {}),
      }
    })
    .sort((left, right) => compareText(left.id, right.id))
}

const catalogIndexes = new WeakMap<
  CatalogSnapshot,
  ModelIndex<RecordEntry<OpenRouterModelRecord>>
>()

/** The catalog snapshot indexed by every name it gives a model: id, canonical slug and title. */
function catalogIndex(snapshot: CatalogSnapshot, source: ModelEvidenceComparisonSourceRead) {
  let index = catalogIndexes.get(snapshot)
  if (!index) {
    index = createModelIndex(
      snapshot.records.map((record, position) => ({
        id: record.id,
        names: [record.canonicalSlug, record.name].filter((name): name is string => Boolean(name)),
        vendor: ownerNamespace(record.id),
        value: { record, recordIndex: originalRecordIndex(source, position) },
      })),
    )
    catalogIndexes.set(snapshot, index)
  }
  return index
}

/** The newest dated snapshot of an identity speaks for it; undated ones order by id. */
function newestFirst(entries: Array<RecordEntry<OpenRouterModelRecord>>) {
  const dateOf = (entry: RecordEntry<OpenRouterModelRecord>) =>
    parseModelName(entry.record.canonicalSlug ?? entry.record.id).date ?? ""
  return entries.toSorted(
    (left, right) =>
      compareText(dateOf(right), dateOf(left)) || compareText(left.record.id, right.record.id),
  )
}

export type ModelIdentityResolutionResult = {
  resolution: ModelIdentityResolution
  catalogMatches: Array<RecordEntry<OpenRouterModelRecord>>
}

function resolveByName(
  route: Route,
  snapshot: CatalogSnapshot,
  source: ModelEvidenceComparisonSourceRead,
) {
  const result = catalogIndex(snapshot, source).resolve(route.modelID, {
    vendor: vendorSlug(route.providerID) ? route.providerID : null,
  })
  return result.status === "matched" ? result : null
}

function withNamedMatch(
  named: NonNullable<ReturnType<typeof resolveByName>>,
  input: { route: Route },
  native: ReturnType<typeof boundedReferences>,
  snapshot: CatalogSnapshot,
  catalogState: ModelIdentityResolution["catalogSourceState"],
): ModelIdentityResolutionResult {
  // Dated snapshots and provider copies of one identity are one model: the newest speaks for it.
  const entries = newestFirst(named.items.map((item) => item.value))
  const chosen = entries[0]!
  const references = boundedReferences(
    entries.map(({ record, recordIndex }) =>
      modelIdentityReference("openrouter-models", snapshot, recordIndex, record.id),
    ),
  )
  return {
    resolution: {
      status: "exact",
      productID: chosen.record.id,
      rules: [{ id: `name-identity-${named.tier}-v1`, version: MODEL_IDENTITY_RULE_VERSION }],
      basis: "name-identity",
      catalogSourceState: catalogState,
      evidence: {
        native: native.records,
        catalog: references.records,
        nativeRecordCount: native.recordCount,
        catalogRecordCount: references.recordCount,
        nativeTruncated: native.truncated,
        catalogTruncated: references.truncated,
      },
    },
    catalogMatches: [chosen],
  }
}

/**
 * Resolve a route to its catalog model: exact versioned route rules and exact published ids
 * first, then the name identity (dated snapshots of one model are one match, never a guess
 * between two models).
 */
export function resolveModelIdentity(input: {
  route: Route
  nativeEvidence: ModelIdentityEvidenceReference[]
  catalogSource: ModelEvidenceComparisonSourceRead
}): ModelIdentityResolutionResult {
  const catalogSnapshot =
    input.catalogSource.snapshot?.source === "openrouter-models"
      ? input.catalogSource.snapshot
      : null
  const catalogState = input.catalogSource.snapshotState
  const native = boundedReferences(input.nativeEvidence)
  const rules = routeRules(input.route, catalogSnapshot)

  if (!rules.length && catalogSnapshot) {
    const named = resolveByName(input.route, catalogSnapshot, input.catalogSource)
    if (named) return withNamedMatch(named, input, native, catalogSnapshot, catalogState)
  }
  if (!rules.length) {
    const status = catalogSnapshot ? "unsupported" : "source-unavailable"
    return {
      resolution: {
        status,
        productID: null,
        rules: [],
        basis: null,
        catalogSourceState: catalogState,
        evidence: {
          native: native.records,
          catalog: [],
          nativeRecordCount: native.recordCount,
          catalogRecordCount: 0,
          nativeTruncated: native.truncated,
          catalogTruncated: false,
        },
      },
      catalogMatches: [],
    }
  }

  const uniqueProductIDs = [...new Set(rules.map((rule) => rule.productID))].sort(compareText)
  const productID = uniqueProductIDs.length === 1 ? uniqueProductIDs[0]! : null
  const basis = rules.length === 1 ? rules[0]!.basis : null

  if (!catalogSnapshot) {
    return {
      resolution: {
        status: "source-unavailable",
        productID,
        rules: serializeRules(rules, null, []),
        basis,
        catalogSourceState: catalogState,
        evidence: {
          native: native.records,
          catalog: [],
          nativeRecordCount: native.recordCount,
          catalogRecordCount: 0,
          nativeTruncated: native.truncated,
          catalogTruncated: false,
        },
      },
      catalogMatches: [],
    }
  }

  const catalogMatches = catalogSnapshot.records
    .map((record, index) => ({
      record,
      recordIndex: originalRecordIndex(input.catalogSource, index),
    }))
    .filter(({ record }) => rules.some((rule) => rule.catalogModelID === record.id))
  if (!catalogMatches.length) {
    const named = resolveByName(input.route, catalogSnapshot, input.catalogSource)
    if (named) return withNamedMatch(named, input, native, catalogSnapshot, catalogState)
  }
  const catalogReferences = boundedReferences(
    catalogMatches.map(({ record, recordIndex }) =>
      modelIdentityReference("openrouter-models", catalogSnapshot, recordIndex, record.id),
    ),
  )
  const publicRules = serializeRules(rules, catalogSnapshot, catalogMatches)
  const status: ModelIdentityResolution["status"] =
    rules.length > 1 || catalogMatches.length > 1
      ? "ambiguous"
      : catalogMatches.length === 1
        ? "exact"
        : "supported-but-absent"

  return {
    resolution: {
      status,
      productID,
      rules: publicRules,
      basis,
      catalogSourceState: catalogState,
      evidence: {
        native: native.records,
        catalog: catalogReferences.records,
        nativeRecordCount: native.recordCount,
        catalogRecordCount: catalogReferences.recordCount,
        nativeTruncated: native.truncated,
        catalogTruncated: catalogReferences.truncated,
      },
    },
    catalogMatches,
  }
}
