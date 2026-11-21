import { z } from "zod"
import {
  EpochBenchmarkRecordSchema,
  MODEL_EVIDENCE_SOURCES,
  ModelEvidenceRefreshStatusSchema,
  ModelsDevModelRecordSchema,
  ModelEvidenceSnapshotSummarySchema,
  ModelEvidenceSourceSchema,
  NativeModelEvidenceRecordSchema,
  OpenRouterBenchmarkEvidenceRecordSchema,
  OpenRouterModelEvidenceRecordSchema,
} from "./source-schema.ts"

export const ModelComparisonFiltersSchema = z.strictObject({
  providerID: z.string().min(1).max(512).optional(),
  search: z.string().min(1).max(256).optional(),
  enabled: z.boolean().optional(),
})
export type ModelComparisonFilters = z.infer<typeof ModelComparisonFiltersSchema>

export const ModelComparisonReadInputSchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  filters: ModelComparisonFiltersSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
export type ModelComparisonReadInput = z.infer<typeof ModelComparisonReadInputSchema>

export const ModelComparisonEvidenceReferenceSchema = z.strictObject({
  source: ModelEvidenceSourceSchema,
  snapshotID: z.uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  recordIndex: z.number().int().nonnegative().max(1_999),
  recordID: z.string().min(1).max(512),
})

const EvidenceReferencesSchema = z.strictObject({
  records: z.array(ModelComparisonEvidenceReferenceSchema).max(100),
  recordCount: z.number().int().nonnegative().max(4_001),
  truncated: z.boolean(),
})

const CorrespondenceSchema = z.strictObject({
  status: z.enum(["exact", "unresolved", "ambiguous"]),
  basis: z
    .enum([
      "direct-openrouter-route-and-exact-catalog-id",
      "exact-published-catalog-id",
      "owner-qualified-catalog-id",
      "provider-owner-qualification",
      "verified-source-backed-route-alias",
      "name-identity",
    ])
    .nullable(),
  evidence: EvidenceReferencesSchema,
})

const BenchmarkCorrespondenceSchema = z.strictObject({
  status: z.enum(["exact", "unresolved", "ambiguous"]),
  basis: z.enum(["published-canonical-slug", "name-identity"]).nullable(),
  evidence: EvidenceReferencesSchema,
})

export const ModelComparisonSourceSchema = z.strictObject({
  source: ModelEvidenceSourceSchema,
  storage: z.enum([
    "ready",
    "missing-snapshot-table",
    "missing-refresh-table",
    "missing-both-tables",
  ]),
  snapshotState: z.enum(["available", "none", "missing-table", "missing-snapshot"]),
  selectedSnapshotID: z.uuid().nullable(),
  refresh: ModelEvidenceRefreshStatusSchema.nullable(),
  snapshot: ModelEvidenceSnapshotSummarySchema.nullable(),
})

const EffortApplicabilitySchema = z.strictObject({
  status: z.enum(["exact", "unknown"]),
  evidence: EvidenceReferencesSchema,
})

const VariantCoverageSchema = z.strictObject({
  status: z.enum(["complete", "truncated", "unknown"]),
  totalVariants: z.number().int().nonnegative().max(200_000).nullable(),
  omittedVariants: z.number().int().nonnegative().max(200_000).nullable(),
})

/** The catalog fields every native model record carries, shared by the candidate and the group schemas. */
export const NativeCatalogFields = {
  name: z.string().max(512).nullable(),
  enabled: z.boolean().nullable(),
  type: z.string().max(512).nullable(),
  contextTokens: z.number().finite().nonnegative().nullable(),
  capabilities: NativeModelEvidenceRecordSchema.shape.capabilities,
  availableVariants: z.array(z.string().min(1).max(512)).max(100).nullable(),
}

/** What one price source quotes for a model, USD per million tokens. */
const PriceQuoteSchema = z.strictObject({
  source: z.enum(["openrouter", "opencode", "models-dev"]),
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative().nullable(),
  cacheWrite: z.number().finite().nonnegative().nullable(),
  appliesBelowTokens: z.number().finite().nonnegative().nullable().optional(),
})

export const ModelComparisonCandidateSchema = z.strictObject({
  candidateID: z.string().min(1).max(2048),
  identity: z.strictObject({
    providerID: z.string().min(1).max(512),
    modelID: z.string().min(1).max(512),
    variant: z.string().max(512).nullable(),
  }),
  native: z.strictObject({
    ...NativeCatalogFields,
    variantCoverage: VariantCoverageSchema,
    prices: NativeModelEvidenceRecordSchema.shape.prices,
    ambiguousIdentity: z.boolean(),
    evidence: EvidenceReferencesSchema,
  }),
  correspondence: CorrespondenceSchema,
  externalModel: OpenRouterModelEvidenceRecordSchema.nullable(),
  externalModelEvidence: EvidenceReferencesSchema,
  benchmarkCorrespondence: BenchmarkCorrespondenceSchema,
  externalBenchmark: OpenRouterBenchmarkEvidenceRecordSchema.nullable(),
  externalBenchmarkEvidence: EvidenceReferencesSchema,
  effortApplicability: EffortApplicabilitySchema,
  /** The route's models.dev entry: an exact provider and model id match. Absent on old reads. */
  publicModel: ModelsDevModelRecordSchema.nullable().optional(),
  /** Epoch coding-benchmark rows matched to this model by explicit normalisation. */
  publicBenchmarks: z.array(EpochBenchmarkRecordSchema).max(100).optional(),
  /**
   * What OpenRouter and models.dev quote for this model by name identity, however they spell it
   * or whichever provider they list it under: the price walk takes the first configured source.
   */
  publicQuotes: z.array(PriceQuoteSchema).max(3).optional(),
})

const PublicCoverageSchema = z.strictObject({
  epoch: z
    .strictObject({
      benchmarks: z
        .array(
          z.strictObject({
            benchmarkID: z.string().min(1).max(512),
            benchmark: z.string().min(1).max(512),
            rows: z.number().int().nonnegative(),
            matched: z.number().int().nonnegative(),
          }),
        )
        .max(50),
      unmatched: z
        .array(
          z.strictObject({ name: z.string().min(1).max(512), reason: z.string().min(1).max(512) }),
        )
        .max(200),
    })
    .nullable(),
})

/**
 * A model of the public catalogs that no route of this install runs: the Anthropic and OpenAI
 * lineups (BYOK) and the newest or most listed models of models.dev and OpenRouter. They are
 * listed and priced, never offered as a route.
 */
const PublicCatalogItemSchema = z.strictObject({
  source: z.enum(["models-dev", "openrouter", "opencode"]),
  /** A model one of this install's routes runs, listed so it plots before its page loads. */
  routed: z.boolean().optional(),
  providerID: z.string().min(1).max(512),
  modelID: z.string().min(1).max(512),
  name: z.string().max(512).nullable(),
  releaseDate: z.string().max(32).nullable(),
  contextTokens: z.number().finite().nonnegative().nullable(),
  /** USD per million tokens. */
  prices: z
    .strictObject({
      input: z.number().finite().nonnegative(),
      output: z.number().finite().nonnegative(),
      cacheRead: z.number().finite().nonnegative().nullable(),
      cacheWrite: z.number().finite().nonnegative().nullable(),
    })
    .nullable(),
  /**
   * What each price source quotes for this model, joined by name identity whichever source
   * listed it. The reader walks the configured order and takes the first.
   */
  quotes: z.array(PriceQuoteSchema).max(3).optional(),
  benchmarks: z.array(EpochBenchmarkRecordSchema).max(24),
})
export type PublicCatalogItem = z.infer<typeof PublicCatalogItemSchema>

export const ModelComparisonOutputSchema = z.strictObject({
  filters: ModelComparisonFiltersSchema,
  sources: z.array(ModelComparisonSourceSchema).length(MODEL_EVIDENCE_SOURCES.length),
  candidates: z.array(ModelComparisonCandidateSchema).max(100),
  totalCandidates: z.number().int().nonnegative().max(200_000),
  nextCursor: z.string().max(8192).nullable(),
  /** How many public benchmark rows reach a model of this catalog. First page only. */
  publicCoverage: PublicCoverageSchema.optional(),
  /** Public-catalog models beyond this install's routes. First page only. */
  publicCatalog: z.array(PublicCatalogItemSchema).max(200).optional(),
})
export type ModelComparisonOutput = z.infer<typeof ModelComparisonOutputSchema>

export const ModelComparisonSnapshotSelectionSchema = z.strictObject({
  "native-catalog": z.uuid().nullable(),
  "openrouter-models": z.uuid().nullable(),
  "openrouter-benchmarks": z.uuid().nullable(),
  // Absent in cursors issued before these sources existed.
  "models-dev": z.uuid().nullable().optional(),
  "epoch-benchmarks": z.uuid().nullable().optional(),
})
export type ModelComparisonSnapshotSelection = z.infer<
  typeof ModelComparisonSnapshotSelectionSchema
>

export const ModelComparisonCursorSchema = z.strictObject({
  version: z.literal(1),
  offset: z.number().int().nonnegative().max(200_000),
  filters: ModelComparisonFiltersSchema,
  snapshots: ModelComparisonSnapshotSelectionSchema,
})
