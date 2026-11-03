import { z } from "zod"
import {
  ModelEvidenceRefreshStatusSchema,
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
  basis: z.literal("direct-openrouter-route-and-exact-catalog-id").nullable(),
  evidence: EvidenceReferencesSchema,
})

const BenchmarkCorrespondenceSchema = z.strictObject({
  status: z.enum(["exact", "unresolved", "ambiguous"]),
  basis: z.literal("published-canonical-slug").nullable(),
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

export const ModelComparisonCandidateSchema = z.strictObject({
  candidateID: z.string().min(1).max(2048),
  identity: z.strictObject({
    providerID: z.string().min(1).max(512),
    modelID: z.string().min(1).max(512),
    variant: z.string().max(512).nullable(),
  }),
  native: z.strictObject({
    name: z.string().max(512).nullable(),
    enabled: z.boolean().nullable(),
    type: z.string().max(512).nullable(),
    contextTokens: z.number().finite().nonnegative().nullable(),
    capabilities: NativeModelEvidenceRecordSchema.shape.capabilities,
    availableVariants: z.array(z.string().min(1).max(512)).max(100).nullable(),
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
})

export const ModelComparisonOutputSchema = z.strictObject({
  filters: ModelComparisonFiltersSchema,
  sources: z.array(ModelComparisonSourceSchema).length(3),
  candidates: z.array(ModelComparisonCandidateSchema).max(100),
  totalCandidates: z.number().int().nonnegative().max(200_000),
  nextCursor: z.string().max(8192).nullable(),
})
export type ModelComparisonOutput = z.infer<typeof ModelComparisonOutputSchema>

export const ModelComparisonSnapshotSelectionSchema = z.strictObject({
  "native-catalog": z.uuid().nullable(),
  "openrouter-models": z.uuid().nullable(),
  "openrouter-benchmarks": z.uuid().nullable(),
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
