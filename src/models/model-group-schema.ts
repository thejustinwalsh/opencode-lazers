import { z } from "zod"
import {
  ModelComparisonEvidenceReferenceSchema,
  ModelComparisonSnapshotSelectionSchema,
  ModelComparisonSourceSchema,
} from "./comparison-schema.ts"
import {
  MODEL_IDENTITY_RULE_VERSION,
  ModelIdentityResolutionSchema,
  ModelIdentityRuleSchema,
} from "./model-identity.ts"
import {
  MODEL_EVIDENCE_SOURCES,
  NativeModelEvidenceRecordSchema,
  OpenRouterBenchmarkEvidenceRecordSchema,
  OpenRouterModelEvidenceRecordSchema,
} from "./source-schema.ts"

export const ModelGroupFiltersSchema = z.strictObject({
  providerID: z.string().min(1).max(512).optional(),
  search: z.string().min(1).max(256).optional(),
})
export type ModelGroupFilters = z.infer<typeof ModelGroupFiltersSchema>

export const ModelGroupReadContextSchema = z.strictObject({
  scope: z.string().min(1).max(2_048),
  ruleVersion: z.literal(MODEL_IDENTITY_RULE_VERSION),
  filters: ModelGroupFiltersSchema,
  snapshots: ModelComparisonSnapshotSelectionSchema,
})
export type ModelGroupReadContext = z.infer<typeof ModelGroupReadContextSchema>

const CursorFields = {
  version: z.literal(1),
  ruleVersion: z.literal(MODEL_IDENTITY_RULE_VERSION),
  scope: z.string().min(1).max(2_048),
  offset: z.number().int().nonnegative().max(200_000),
  filters: ModelGroupFiltersSchema,
  groupFilters: ModelGroupFiltersSchema,
  snapshots: ModelComparisonSnapshotSelectionSchema,
}

export const ModelGroupCursorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...CursorFields, kind: z.literal("groups"), groupID: z.null() }),
  z.strictObject({
    ...CursorFields,
    kind: z.literal("configurations"),
    groupID: z.string().min(1).max(2_048),
  }),
])

export const ModelGroupsReadInputSchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(8_192)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  filters: ModelGroupFiltersSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
export type ModelGroupsReadInput = z.infer<typeof ModelGroupsReadInputSchema>

export const ModelConfigurationsReadInputSchema = z.strictObject({
  groupID: z.string().min(1).max(2_048),
  context: ModelGroupReadContextSchema,
  cursor: z
    .string()
    .min(1)
    .max(8_192)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  filters: ModelGroupFiltersSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
export type ModelConfigurationsReadInput = z.infer<typeof ModelConfigurationsReadInputSchema>

const GroupEvidenceSchema = z.strictObject({
  records: z.array(ModelComparisonEvidenceReferenceSchema).max(100),
  recordCount: z.number().int().nonnegative().max(4_000),
  truncated: z.boolean(),
})

export const ModelGroupSchema = z.strictObject({
  groupID: z.string().min(1).max(2_048),
  productID: z.string().min(1).max(512).nullable(),
  displayName: z.string().max(512).nullable(),
  identityStatus: z.enum([
    "exact",
    "ambiguous",
    "unsupported",
    "supported-but-absent",
    "source-unavailable",
    "metadata-only",
    "mixed",
  ]),
  configurationCount: z.number().int().nonnegative().max(200_000),
  nativeRecordCount: z.number().int().nonnegative().max(4_000),
  catalogRecordCount: z.number().int().nonnegative().max(4_000),
  rules: z.array(ModelIdentityRuleSchema).max(100),
  nativeEvidence: GroupEvidenceSchema,
  catalogEvidence: GroupEvidenceSchema,
})
export type ModelGroup = z.infer<typeof ModelGroupSchema>

export const ModelGroupsOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  context: ModelGroupReadContextSchema,
  filters: ModelGroupFiltersSchema,
  sources: z.array(ModelComparisonSourceSchema).length(MODEL_EVIDENCE_SOURCES.length),
  groups: z.array(ModelGroupSchema).max(100),
  totalGroups: z.number().int().nonnegative().max(200_000),
  nextCursor: z.string().max(8_192).nullable(),
})
export type ModelGroupsOutput = z.infer<typeof ModelGroupsOutputSchema>

const NativeConfigurationSchema = z.strictObject({
  source: z.literal("native-catalog"),
  name: z.string().max(512).nullable(),
  enabled: z.boolean().nullable(),
  type: z.string().max(512).nullable(),
  contextTokens: z.number().finite().nonnegative().nullable(),
  capabilities: NativeModelEvidenceRecordSchema.shape.capabilities,
  availableVariants: z.array(z.string().min(1).max(512)).max(100).nullable(),
  variantCoverage: z.strictObject({
    status: z.enum(["complete", "truncated", "unknown"]),
    totalVariants: z.number().int().nonnegative().max(200_000).nullable(),
    omittedVariants: z.number().int().nonnegative().max(200_000).nullable(),
  }),
  prices: NativeModelEvidenceRecordSchema.shape.prices,
  ambiguousIdentity: z.boolean(),
  evidence: GroupEvidenceSchema,
})

export const ModelGroupConfigurationSchema = z
  .strictObject({
    /** The same opaque key as the legacy comparison candidateID. */
    candidateID: z.string().min(1).max(2_048),
    /** Compatibility alias for clients that name route+effort configurations. */
    configurationID: z.string().min(1).max(2_048),
    groupID: z.string().min(1).max(2_048),
    route: z.strictObject({
      providerID: z.string().min(1).max(512),
      modelID: z.string().min(1).max(512),
      variant: z.string().max(512).nullable(),
    }),
    identity: ModelIdentityResolutionSchema,
    native: NativeConfigurationSchema,
    externalCatalog: z.strictObject({
      source: z.literal("openrouter-models"),
      model: OpenRouterModelEvidenceRecordSchema.nullable(),
      evidence: GroupEvidenceSchema,
    }),
    benchmarkCorrespondence: z.strictObject({
      status: z.enum(["exact", "unresolved", "ambiguous"]),
      basis: z.literal("published-canonical-slug").nullable(),
      evidence: GroupEvidenceSchema,
    }),
    externalBenchmark: OpenRouterBenchmarkEvidenceRecordSchema.nullable(),
    externalBenchmarkEvidence: GroupEvidenceSchema,
    effortApplicability: z.strictObject({
      status: z.literal("unknown"),
      evidence: GroupEvidenceSchema,
    }),
  })
  .refine((configuration) => configuration.candidateID === configuration.configurationID, {
    message: "candidateID and configurationID must identify the same exact route configuration",
  })
export type ModelGroupConfiguration = z.infer<typeof ModelGroupConfigurationSchema>

export const ModelConfigurationsOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  context: ModelGroupReadContextSchema,
  groupID: z.string().min(1).max(2_048),
  filters: ModelGroupFiltersSchema,
  sources: z.array(ModelComparisonSourceSchema).length(MODEL_EVIDENCE_SOURCES.length),
  configurations: z.array(ModelGroupConfigurationSchema).max(100),
  totalConfigurations: z.number().int().nonnegative().max(200_000),
  nextCursor: z.string().max(8_192).nullable(),
})
export type ModelConfigurationsOutput = z.infer<typeof ModelConfigurationsOutputSchema>
