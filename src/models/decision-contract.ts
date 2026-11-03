import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { ModelPolicy, WorkerPersona } from "../runner/schema.ts"
import { TaskReferenceSchema } from "../task.ts"

/** Additive, producer-owned read contract for the Models decision view. */
export const MODELS_DECISION_RPC_ID = "lazers.models.decision.v1"
export const MODELS_DECISION_CONTRACT_VERSION = 1
export const MODELS_DECISION_ACCOUNTING_BASIS =
  "attributable-cohort-effort-per-accepted-logical-task-v1"
export const MODELS_DECISION_TASK_KIND_CATALOG = "task-kind/v1"
export const MODELS_DECISION_TASK_KINDS = [
  "bug-repair",
  "feature-implementation",
  "refactoring",
  "testing",
  "documentation",
  "maintenance",
] as const

const OpaqueID = z.string().min(1).max(2048)
const Cursor = z.string().min(1).max(8192)
const Nonnegative = z.number().finite().nonnegative()
const Count = z.int().nonnegative()
const NullableRange = z
  .strictObject({ minimum: Nonnegative, maximum: Nonnegative })
  .refine((range) => range.minimum <= range.maximum, {
    message: "An empirical range cannot have its minimum above its maximum",
  })

export const ModelDecisionTaskKindSchema = z.enum(MODELS_DECISION_TASK_KINDS)
export type ModelDecisionTaskKind = z.infer<typeof ModelDecisionTaskKindSchema>

export const ModelDecisionRouteSchema = z.strictObject({
  providerID: ModelPolicy.shape.providerID,
  modelID: ModelPolicy.shape.id,
  variant: z.string().min(1).max(512).nullable(),
})
export type ModelDecisionRoute = z.infer<typeof ModelDecisionRouteSchema>

export const ModelDecisionScopeSchema = z.strictObject({
  projectDirectory: z.string().min(1).max(8192),
})

export const ModelDecisionFiltersSchema = z.strictObject({
  persona: WorkerPersona.nullable(),
  taskKind: ModelDecisionTaskKindSchema.nullable(),
  period: z.strictObject({
    from: z.iso.datetime().nullable(),
    to: z.iso.datetime().nullable(),
  }),
})
export type ModelDecisionFilters = z.infer<typeof ModelDecisionFiltersSchema>

const ReadShape = {
  schemaVersion: z.literal(MODELS_DECISION_CONTRACT_VERSION).default(1),
  scope: ModelDecisionScopeSchema,
  filters: ModelDecisionFiltersSchema,
}

export const ModelDecisionReadInputSchema = z.strictObject(ReadShape)
export const ModelDecisionRowsInputSchema = z.strictObject({
  ...ReadShape,
  cursor: Cursor.optional(),
  limit: z.int().min(1).max(100).default(50),
})
export const ModelDecisionConfigurationsInputSchema = ModelDecisionRowsInputSchema
export const ModelDecisionInspectInputSchema = z.strictObject({
  ...ReadShape,
  snapshotID: OpaqueID,
  configurationID: OpaqueID,
  selectedTaskID: z.uuid().nullable().default(null),
  contributorCursor: Cursor.optional(),
  contributorLimit: z.int().min(1).max(100).default(50),
})

export type ModelDecisionReadInput = z.input<typeof ModelDecisionReadInputSchema>
export type ModelDecisionRowsInput = z.input<typeof ModelDecisionRowsInputSchema>
export type ModelDecisionConfigurationsInput = z.input<
  typeof ModelDecisionConfigurationsInputSchema
>
export type ModelDecisionInspectInput = z.input<typeof ModelDecisionInspectInputSchema>

const RPCScope = { sessionID: z.string().min(1).max(200) }
export const ModelDecisionOverviewRPCInputSchema = z.strictObject({
  ...RPCScope,
  ...ModelDecisionReadInputSchema.shape,
})
export const ModelDecisionRowsRPCInputSchema = z.strictObject({
  ...RPCScope,
  ...ModelDecisionRowsInputSchema.shape,
})
export const ModelDecisionConfigurationsRPCInputSchema = z.strictObject({
  ...RPCScope,
  ...ModelDecisionConfigurationsInputSchema.shape,
})
export const ModelDecisionInspectRPCInputSchema = z.strictObject({
  ...RPCScope,
  ...ModelDecisionInspectInputSchema.shape,
})

export const ModelDecisionAccountingSchema = z.strictObject({
  id: z.literal(MODELS_DECISION_ACCOUNTING_BASIS),
  numerator: z.literal("all-attributable-cohort-failed-retry-and-accepted-effort"),
  denominator: z.literal("accepted-logical-tasks"),
  acceptanceThreshold: z.null(),
  sampleSizeThreshold: z.null(),
  valuation: z.literal("current-common-openrouter-price-pins"),
  nativeReportedCosts: z.literal("retained-separately-not-market-equivalent"),
})

export const ModelDecisionTaskKindCatalogSchema = z.strictObject({
  id: z.literal(MODELS_DECISION_TASK_KIND_CATALOG),
  kinds: z.array(ModelDecisionTaskKindSchema).length(6),
})

export const ModelDecisionClassificationCoverageSchema = z.strictObject({
  status: z.enum(["complete", "partial", "backend-not-ready"]),
  classifiedTaskCount: Count,
  unclassifiedTaskCount: Count,
  excludedTaskCount: Count,
  totalTaskCount: Count,
})

export const ModelDecisionPriceIndexSchema = z.strictObject({
  source: z.literal("openrouter"),
  snapshotID: OpaqueID.nullable(),
  retrievedAt: z.iso.datetime().nullable(),
  freshness: z.enum(["current", "stale", "unavailable"]),
  semantics: z.enum([
    "exact-published-route-quotes",
    "observed-endpoint-averages",
    "mixed",
    "unknown",
  ]),
  note: z.string().max(2000),
})

/**
 * All four reads repeat this exact producer context. A row page never changes the
 * graph's global filtered snapshot or the accounting used for its coordinates.
 */
export const ModelDecisionContextSchema = z.strictObject({
  schemaVersion: z.literal(MODELS_DECISION_CONTRACT_VERSION),
  snapshotID: OpaqueID,
  producedAt: z.iso.datetime(),
  scope: ModelDecisionScopeSchema,
  filters: ModelDecisionFiltersSchema,
  availability: z.enum(["ready", "partial", "backend-not-ready"]),
  freshness: z.enum(["current", "stale", "unknown"]),
  unavailableReason: z.string().max(2000).nullable(),
  accounting: ModelDecisionAccountingSchema,
  taskKindCatalog: ModelDecisionTaskKindCatalogSchema,
  classification: ModelDecisionClassificationCoverageSchema,
  priceIndex: ModelDecisionPriceIndexSchema,
})
export type ModelDecisionContext = z.infer<typeof ModelDecisionContextSchema>

export const ModelDecisionCohortCountsSchema = z.strictObject({
  logicalTaskCount: Count,
  classifiedTaskCount: Count,
  unclassifiedTaskCount: Count,
  acceptedTaskCount: Count,
  terminalTaskCount: Count,
  attemptCount: Count,
  failedAttemptCount: Count,
  retryAttemptCount: Count,
})
export type ModelDecisionCohortCounts = z.infer<typeof ModelDecisionCohortCountsSchema>

export const ModelDecisionPricePinSchema = z.strictObject({
  source: z.literal("openrouter"),
  sourceRecordID: OpaqueID.nullable(),
  snapshotID: OpaqueID.nullable(),
  retrievedAt: z.iso.datetime().nullable(),
  semantics: z.enum(["exact-route-quote", "observed-endpoint-average", "unknown"]),
  freshness: z.enum(["current", "stale", "unavailable"]),
})
export type ModelDecisionPricePin = z.infer<typeof ModelDecisionPricePinSchema>

export const ModelDecisionNativeCostSchema = z.strictObject({
  status: z.enum(["available", "partial", "unknown"]),
  totalUSD: Nonnegative.nullable(),
  source: z.literal("native-reported"),
  note: z.string().max(2000),
})

const EfficiencyValues = {
  tokensPerAcceptedTask: Nonnegative,
  currentMarketUSDPerAcceptedTask: Nonnegative,
}
const NoEfficiencyValues = {
  tokensPerAcceptedTask: z.null(),
  currentMarketUSDPerAcceptedTask: z.null(),
}

export const ModelDecisionEfficiencySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    ...EfficiencyValues,
    observationCount: z.int().min(2),
  }),
  z.strictObject({
    status: z.literal("single-observation"),
    ...EfficiencyValues,
    observationCount: z.literal(1),
  }),
  z.strictObject({
    status: z.literal("partial"),
    tokensPerAcceptedTask: Nonnegative.nullable(),
    currentMarketUSDPerAcceptedTask: Nonnegative.nullable(),
    observationCount: Count,
    missing: z.array(z.enum(["tokens", "current-price", "attribution"])).min(1),
  }),
  z.strictObject({
    status: z.literal("zero-accepted"),
    ...NoEfficiencyValues,
    observationCount: Count,
  }),
  z.strictObject({
    status: z.literal("unknown"),
    ...NoEfficiencyValues,
    observationCount: Count,
    reason: z.string().min(1).max(2000),
  }),
])
export type ModelDecisionEfficiency = z.infer<typeof ModelDecisionEfficiencySchema>

export const ModelDecisionConfigurationSchema = z.strictObject({
  configurationID: OpaqueID,
  groupID: OpaqueID,
  label: z.string().min(1).max(512),
  route: ModelDecisionRouteSchema,
  currentPrice: ModelDecisionPricePinSchema,
})
export type ModelDecisionConfiguration = z.infer<typeof ModelDecisionConfigurationSchema>

export const ModelDecisionRowSchema = z.strictObject({
  configuration: ModelDecisionConfigurationSchema,
  cohort: ModelDecisionCohortCountsSchema,
  efficiency: ModelDecisionEfficiencySchema,
  nativeReportedCost: ModelDecisionNativeCostSchema,
})
export type ModelDecisionRow = z.infer<typeof ModelDecisionRowSchema>

/** Coordinates are already authoritative; consumers must not infer or rank them. */
export const ModelDecisionGraphPointSchema = z.strictObject({
  configurationID: OpaqueID,
  groupID: OpaqueID,
  label: z.string().min(1).max(512),
  tokensPerAcceptedTask: Nonnegative,
  currentMarketUSDPerAcceptedTask: Nonnegative,
  observationCount: z.int().positive(),
  acceptedTaskCount: Count,
  partial: z.boolean(),
})
export type ModelDecisionGraphPoint = z.infer<typeof ModelDecisionGraphPointSchema>

export const ModelDecisionGraphSchema = z.strictObject({
  scope: z.literal("global-filtered-snapshot"),
  points: z.array(ModelDecisionGraphPointSchema),
  frontierConfigurationIDs: z.array(OpaqueID),
})
export type ModelDecisionGraph = z.infer<typeof ModelDecisionGraphSchema>

const Page = {
  totalCount: Count,
  nextCursor: Cursor.nullable(),
}

export const ModelDecisionOverviewOutputSchema = z.strictObject({
  context: ModelDecisionContextSchema,
  graph: ModelDecisionGraphSchema,
  configurationCount: Count,
  groupCount: Count,
})
export type ModelDecisionOverview = z.infer<typeof ModelDecisionOverviewOutputSchema>

export const ModelDecisionRowsOutputSchema = z.strictObject({
  context: ModelDecisionContextSchema,
  rows: z.array(ModelDecisionRowSchema).max(100),
  ...Page,
})
export type ModelDecisionRows = z.infer<typeof ModelDecisionRowsOutputSchema>

export const ModelDecisionConfigurationsOutputSchema = z.strictObject({
  context: ModelDecisionContextSchema,
  configurations: z.array(ModelDecisionConfigurationSchema).max(100),
  ...Page,
})
export type ModelDecisionConfigurations = z.infer<typeof ModelDecisionConfigurationsOutputSchema>

const EmpiricalRange = z.strictObject({
  tokens: NullableRange,
  currentMarketUSD: NullableRange,
})
const EmptyEmpiricalRange = z.strictObject({
  tokens: z.null(),
  currentMarketUSD: z.null(),
})

/** Observed spread, never a predictive confidence interval. */
export const ModelDecisionEstimateSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("available"),
      basis: z.literal("empirical-observed-spread"),
      observationCount: z.int().min(2),
      range: EmpiricalRange,
      confidenceInterval: z.null(),
    }),
    z.strictObject({
      status: z.literal("single-observation"),
      basis: z.literal("empirical-observed-spread"),
      observationCount: z.literal(1),
      range: EmpiricalRange,
      confidenceInterval: z.null(),
    }),
    z.strictObject({
      status: z.literal("partial"),
      basis: z.literal("empirical-observed-spread"),
      observationCount: Count,
      range: z.strictObject({
        tokens: NullableRange.nullable(),
        currentMarketUSD: NullableRange.nullable(),
      }),
      confidenceInterval: z.null(),
      missing: z.array(z.enum(["tokens", "current-price", "attribution"])).min(1),
    }),
    z.strictObject({
      status: z.literal("zero-accepted"),
      basis: z.literal("no-successful-task-efficiency"),
      observationCount: Count,
      range: EmptyEmpiricalRange,
      confidenceInterval: z.null(),
    }),
    z.strictObject({
      status: z.literal("unknown"),
      basis: z.literal("unavailable"),
      observationCount: Count,
      range: EmptyEmpiricalRange,
      confidenceInterval: z.null(),
      reason: z.string().min(1).max(2000),
    }),
  ])
  .superRefine((estimate, context) => {
    if (estimate.status !== "single-observation") return
    for (const [dimension, range] of Object.entries(estimate.range)) {
      if (range.minimum !== range.maximum)
        context.addIssue({
          code: "custom",
          path: ["range", dimension],
          message: "One observation has one empirical value, not an invented interval",
        })
    }
  })
export type ModelDecisionEstimate = z.infer<typeof ModelDecisionEstimateSchema>

export const ModelDecisionContributorSchema = z.strictObject({
  taskID: z.uuid(),
  taskReference: TaskReferenceSchema,
  attemptID: z.uuid().nullable(),
  sessionID: z.string().min(1).max(200),
  contribution: z.enum(["accepted", "failed", "retry"]),
  tokens: Nonnegative.nullable(),
  currentMarketUSD: Nonnegative.nullable(),
  nativeReportedUSD: Nonnegative.nullable(),
  observedAt: z.iso.datetime().nullable(),
})
export type ModelDecisionContributor = z.infer<typeof ModelDecisionContributorSchema>

export const ModelDecisionContributorPageSchema = z.strictObject({
  contributors: z.array(ModelDecisionContributorSchema).max(100),
  ...Page,
})
export type ModelDecisionContributorPage = z.infer<typeof ModelDecisionContributorPageSchema>

export const ModelDecisionInspectOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("found"),
    context: ModelDecisionContextSchema,
    configuration: ModelDecisionConfigurationSchema,
    cohort: ModelDecisionCohortCountsSchema,
    efficiency: ModelDecisionEfficiencySchema,
    nativeReportedCost: ModelDecisionNativeCostSchema,
    selectedTaskID: z.uuid().nullable(),
    estimate: ModelDecisionEstimateSchema,
    contributorPage: ModelDecisionContributorPageSchema,
  }),
  z.strictObject({
    status: z.literal("not-found"),
    context: ModelDecisionContextSchema,
    configurationID: OpaqueID,
  }),
])
export type ModelDecisionInspect = z.infer<typeof ModelDecisionInspectOutputSchema>

export interface ModelDecisionReadOptions {
  signal?: AbortSignal
}

/** Server implementations are injected; this module has no storage dependency. */
export interface ModelDecisionReader {
  overview(
    input: ModelDecisionReadInput,
    options?: ModelDecisionReadOptions,
  ): Promise<ModelDecisionOverview>
  rows(
    input: ModelDecisionRowsInput,
    options?: ModelDecisionReadOptions,
  ): Promise<ModelDecisionRows>
  configurations(
    input: ModelDecisionConfigurationsInput,
    options?: ModelDecisionReadOptions,
  ): Promise<ModelDecisionConfigurations>
  inspect(
    input: ModelDecisionInspectInput,
    options?: ModelDecisionReadOptions,
  ): Promise<ModelDecisionInspect>
}

export const ModelsDecision = Rpc.define({
  id: MODELS_DECISION_RPC_ID,
  events: {},
  methods: {
    overview: {
      input: ModelDecisionOverviewRPCInputSchema,
      output: ModelDecisionOverviewOutputSchema,
    },
    rows: { input: ModelDecisionRowsRPCInputSchema, output: ModelDecisionRowsOutputSchema },
    configurations: {
      input: ModelDecisionConfigurationsRPCInputSchema,
      output: ModelDecisionConfigurationsOutputSchema,
    },
    inspect: {
      input: ModelDecisionInspectRPCInputSchema,
      output: ModelDecisionInspectOutputSchema,
    },
  },
})
