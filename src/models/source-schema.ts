import { z } from "zod"

export const MODEL_EVIDENCE_SOURCES = [
  "native-catalog",
  "openrouter-models",
  "openrouter-benchmarks",
] as const

export const ModelEvidenceSourceSchema = z.enum(MODEL_EVIDENCE_SOURCES)
export type ModelEvidenceSource = z.infer<typeof ModelEvidenceSourceSchema>

export const MODEL_EVIDENCE_QUERIES = {
  "native-catalog": "OpenCode model.list for the current project location",
  "openrouter-models": "GET https://openrouter.ai/api/v1/models",
  "openrouter-benchmarks":
    "GET https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=coding",
} as const satisfies Record<ModelEvidenceSource, string>

export const MODEL_EVIDENCE_SOURCE_URLS = {
  "native-catalog": "https://opencode.ai/v2/docs/models/",
  "openrouter-models": "https://openrouter.ai/api/v1/models",
  "openrouter-benchmarks":
    "https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=coding",
} as const satisfies Record<ModelEvidenceSource, string>

const BoundedText = z.string().min(1).max(512)
const NullableText = z.string().max(512).nullable()
const OptionalTextList = z.array(BoundedText).max(100).nullable()
const FiniteNonnegative = z.number().finite().nonnegative()
const DecimalString = z
  .string()
  .max(64)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/)
  .nullable()

export const NativeModelEvidenceRecordSchema = z.strictObject({
  kind: z.literal("native-model"),
  providerID: BoundedText,
  id: BoundedText,
  name: NullableText,
  enabled: z.boolean().nullable(),
  type: NullableText,
  contextTokens: FiniteNonnegative.nullable(),
  capabilities: z.strictObject({
    tools: z.boolean().nullable(),
    input: OptionalTextList,
    output: OptionalTextList,
  }),
  variants: z.array(BoundedText).max(100).nullable(),
  prices: z
    .strictObject({
      unit: z.literal("USD per million tokens"),
      tiers: z
        .array(
          z.strictObject({
            contextTierTokens: FiniteNonnegative.nullable(),
            input: FiniteNonnegative.nullable(),
            output: FiniteNonnegative.nullable(),
            cacheRead: FiniteNonnegative.nullable(),
            cacheWrite: FiniteNonnegative.nullable(),
          }),
        )
        .max(100),
    })
    .nullable(),
})

const OpenRouterPriceTierSchema = z.strictObject({
  minPromptTokens: FiniteNonnegative.nullable(),
  prompt: DecimalString,
  completion: DecimalString,
  inputCacheRead: DecimalString,
  inputCacheWrite: DecimalString,
})

export const OpenRouterModelEvidenceRecordSchema = z.strictObject({
  kind: z.literal("openrouter-model"),
  id: BoundedText,
  canonicalSlug: NullableText,
  name: NullableText,
  contextLength: FiniteNonnegative.nullable(),
  architecture: z.strictObject({
    modality: NullableText,
    inputModalities: OptionalTextList,
    outputModalities: OptionalTextList,
    tokenizer: NullableText,
    instructType: NullableText,
  }),
  supportedParameters: OptionalTextList,
  prices: z
    .strictObject({
      unit: z.literal("USD per token"),
      tiers: z.array(OpenRouterPriceTierSchema).max(100),
    })
    .nullable(),
})

export const OpenRouterBenchmarkEvidenceRecordSchema = z.strictObject({
  kind: z.literal("openrouter-benchmark"),
  source: z.literal("artificial-analysis"),
  taskType: z.literal("coding"),
  modelPermaslug: BoundedText,
  displayName: NullableText,
  effort: NullableText,
  codingIndex: FiniteNonnegative.nullable(),
  agenticIndex: FiniteNonnegative.nullable(),
  intelligenceIndex: FiniteNonnegative.nullable(),
  prices: z
    .strictObject({
      unit: z.literal("USD per token"),
      prompt: DecimalString,
      completion: DecimalString,
    })
    .nullable(),
})

export const ModelEvidenceRecordSchema = z.discriminatedUnion("kind", [
  NativeModelEvidenceRecordSchema,
  OpenRouterModelEvidenceRecordSchema,
  OpenRouterBenchmarkEvidenceRecordSchema,
])
export type ModelEvidenceRecord = z.infer<typeof ModelEvidenceRecordSchema>

const SnapshotFields = {
  snapshotID: z.uuid(),
  projectDirectory: z.string().min(1).max(2048),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  retrievedAt: z.iso.datetime(),
  asOf: z.iso.datetime().nullable(),
  version: NullableText,
  citation: z.string().max(1024).nullable(),
  upstreamSourceURL: z.string().url().max(2048).nullable(),
  sourceURL: z.string().url().max(2048),
  query: z.string().min(1).max(512),
}

export const ModelEvidenceSnapshotSchema = z.discriminatedUnion("source", [
  z.strictObject({
    ...SnapshotFields,
    source: z.literal("native-catalog"),
    query: z.literal(MODEL_EVIDENCE_QUERIES["native-catalog"]),
    sourceURL: z.literal(MODEL_EVIDENCE_SOURCE_URLS["native-catalog"]),
    records: z.array(NativeModelEvidenceRecordSchema).max(2_000),
  }),
  z.strictObject({
    ...SnapshotFields,
    source: z.literal("openrouter-models"),
    query: z.literal(MODEL_EVIDENCE_QUERIES["openrouter-models"]),
    sourceURL: z.literal(MODEL_EVIDENCE_SOURCE_URLS["openrouter-models"]),
    records: z.array(OpenRouterModelEvidenceRecordSchema).max(2_000),
  }),
  z.strictObject({
    ...SnapshotFields,
    source: z.literal("openrouter-benchmarks"),
    query: z.literal(MODEL_EVIDENCE_QUERIES["openrouter-benchmarks"]),
    sourceURL: z.literal(MODEL_EVIDENCE_SOURCE_URLS["openrouter-benchmarks"]),
    records: z.array(OpenRouterBenchmarkEvidenceRecordSchema).max(2_000),
  }),
])
export type ModelEvidenceSnapshot = z.infer<typeof ModelEvidenceSnapshotSchema>

export const ModelEvidenceSnapshotSummarySchema = z.discriminatedUnion("source", [
  z.strictObject({
    ...SnapshotFields,
    source: z.literal("native-catalog"),
    query: z.literal(MODEL_EVIDENCE_QUERIES["native-catalog"]),
    sourceURL: z.literal(MODEL_EVIDENCE_SOURCE_URLS["native-catalog"]),
    recordCount: z.number().int().nonnegative().max(2_000),
  }),
  z.strictObject({
    ...SnapshotFields,
    source: z.literal("openrouter-models"),
    query: z.literal(MODEL_EVIDENCE_QUERIES["openrouter-models"]),
    sourceURL: z.literal(MODEL_EVIDENCE_SOURCE_URLS["openrouter-models"]),
    recordCount: z.number().int().nonnegative().max(2_000),
  }),
  z.strictObject({
    ...SnapshotFields,
    source: z.literal("openrouter-benchmarks"),
    query: z.literal(MODEL_EVIDENCE_QUERIES["openrouter-benchmarks"]),
    sourceURL: z.literal(MODEL_EVIDENCE_SOURCE_URLS["openrouter-benchmarks"]),
    recordCount: z.number().int().nonnegative().max(2_000),
  }),
])

export const ModelEvidenceErrorCodeSchema = z.enum([
  "missing-credentials",
  "unsupported-credentials",
  "reauthentication-required",
  "credential-unavailable",
  "native-unavailable",
  "unauthorized",
  "rate-limited",
  "server-error",
  "http-error",
  "malformed-response",
  "response-too-large",
  "timeout",
  "network-error",
])

export const ModelEvidenceRefreshStatusSchema = z.strictObject({
  source: ModelEvidenceSourceSchema,
  state: z.enum(["never", "refreshing", "succeeded", "failed", "cancelled"]),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  latestSnapshotID: z.uuid().nullable(),
  latestRetrievedAt: z.iso.datetime().nullable(),
  latestRecordCount: z.number().int().nonnegative().max(2_000).nullable(),
  errorCode: ModelEvidenceErrorCodeSchema.nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
})
export type ModelEvidenceRefreshStatus = z.infer<typeof ModelEvidenceRefreshStatusSchema>

export const ModelEvidencePageSchema = z.strictObject({
  snapshot: ModelEvidenceSnapshotSummarySchema,
  records: z.array(ModelEvidenceRecordSchema).max(100),
  nextCursor: z
    .string()
    .regex(/^(?:0|[1-9]\d{0,8})$/)
    .nullable(),
})

export const ModelEvidenceOutputSchema = z.strictObject({
  sources: z.array(ModelEvidenceRefreshStatusSchema).length(MODEL_EVIDENCE_SOURCES.length),
  snapshot: ModelEvidencePageSchema.nullable(),
})
export type ModelEvidenceOutput = z.infer<typeof ModelEvidenceOutputSchema>

export const ModelEvidenceReadInputSchema = z.strictObject({
  snapshotID: z.uuid().optional(),
  cursor: z
    .string()
    .regex(/^(?:0|[1-9]\d{0,8})$/)
    .optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
export type ModelEvidenceReadInput = z.infer<typeof ModelEvidenceReadInputSchema>
export type ModelEvidenceErrorCode = z.infer<typeof ModelEvidenceErrorCodeSchema>
