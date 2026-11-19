import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { ModelPolicy, WorkerPersona } from "../runner/schema.ts"
import { TaskReferenceSchema } from "../task.ts"
import { ModelPricePinSourceSchema, ModelPriceSourcePolicySchema } from "./price-source-settings.ts"
import { KnownUsageMarketSchema } from "./market-range.ts"
import { ModelDecisionReferenceEstimateSchema } from "./reference-estimate.ts"

/** Versioned, producer-owned read contract for the Models decision view. */
export const MODELS_DECISION_RPC_ID = "lazers.models.decision.v2"
export const MODELS_DECISION_CONTRACT_VERSION = 2
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

const ModelDecisionTaskKindSchema = z.enum(MODELS_DECISION_TASK_KINDS)
export type ModelDecisionTaskKind = z.infer<typeof ModelDecisionTaskKindSchema>

const ModelDecisionRouteSchema = z.strictObject({
  providerID: ModelPolicy.shape.providerID,
  modelID: ModelPolicy.shape.id,
  variant: z.string().min(1).max(512).nullable(),
})
export type ModelDecisionRoute = z.infer<typeof ModelDecisionRouteSchema>

const ModelDecisionScopeSchema = z.strictObject({
  projectDirectory: z.string().min(1).max(8192),
})

const ModelDecisionFiltersSchema = z.strictObject({
  persona: WorkerPersona.nullable(),
  taskKind: ModelDecisionTaskKindSchema.nullable(),
  period: z.strictObject({
    from: z.iso.datetime().nullable(),
    to: z.iso.datetime().nullable(),
  }),
})
export type ModelDecisionFilters = z.infer<typeof ModelDecisionFiltersSchema>

const ReadShape = {
  schemaVersion: z
    .literal(MODELS_DECISION_CONTRACT_VERSION)
    .default(MODELS_DECISION_CONTRACT_VERSION),
  scope: ModelDecisionScopeSchema,
  filters: ModelDecisionFiltersSchema,
}

export const ModelDecisionReadInputSchema = z.strictObject(ReadShape)
export const ModelDecisionRowsInputSchema = z.strictObject({
  ...ReadShape,
  /** Optional pin returned by overview; an omitted pin preserves legacy fresh reads. */
  snapshotID: OpaqueID.optional(),
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

const ModelDecisionAccountingSchema = z.strictObject({
  id: z.literal(MODELS_DECISION_ACCOUNTING_BASIS),
  numerator: z.literal("all-attributable-cohort-failed-retry-and-accepted-effort"),
  denominator: z.literal("accepted-logical-tasks"),
  acceptanceThreshold: z.null(),
  sampleSizeThreshold: z.null(),
  valuation: z.literal("current-ordered-whole-model-price-source-pins"),
  nativeReportedCosts: z.literal("retained-separately-not-market-equivalent"),
})

const ModelDecisionTaskKindCatalogSchema = z.strictObject({
  id: z.literal(MODELS_DECISION_TASK_KIND_CATALOG),
  kinds: z.array(ModelDecisionTaskKindSchema).length(6),
})

const ModelDecisionClassificationCoverageSchema = z.strictObject({
  status: z.enum(["complete", "partial", "backend-not-ready"]),
  classifiedTaskCount: Count,
  unclassifiedTaskCount: Count,
  excludedTaskCount: Count,
  totalTaskCount: Count,
})

const ModelDecisionPriceIndexSchema = z
  .strictObject({
    source: z.enum(["openrouter", "opencode", "mixed", "unavailable"]),
    sourcePolicyRevision: Count,
    pins: z
      .array(
        z.strictObject({
          source: ModelPricePinSourceSchema,
          snapshotID: OpaqueID,
          retrievedAt: z.iso.datetime(),
          freshness: z.enum(["current", "stale"]),
          semantics: z.enum([
            "exact-published-route-quotes",
            "exact-native-model-quotes",
            "observed-endpoint-averages",
            "mixed",
            "unknown",
          ]),
        }),
      )
      .max(2),
    freshness: z.enum(["current", "stale", "unavailable"]),
    semantics: z.enum([
      "exact-published-route-quotes",
      "exact-native-model-quotes",
      "observed-endpoint-averages",
      "mixed",
      "unknown",
    ]),
    note: z.string().max(2000),
  })
  .superRefine((index, context) => {
    const sources = new Set(index.pins.map((pin) => pin.source))
    const expectedSource =
      sources.size === 0 ? "unavailable" : sources.size === 1 ? index.pins[0]!.source : "mixed"
    if (index.source !== expectedSource)
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "The overview source must reflect its actual source pins",
      })
    if (sources.size !== index.pins.length)
      context.addIssue({
        code: "custom",
        path: ["pins"],
        message: "An overview can contain only one pin per supported price source",
      })

    const expectedFreshness =
      index.pins.length === 0
        ? "unavailable"
        : index.pins.some((pin) => pin.freshness === "stale")
          ? "stale"
          : "current"
    if (index.freshness !== expectedFreshness)
      context.addIssue({
        code: "custom",
        path: ["freshness"],
        message: "Overview freshness must summarize its source pins",
      })

    const semantics = new Set(index.pins.map((pin) => pin.semantics))
    const expectedSemantics =
      semantics.size === 0 ? "unknown" : semantics.size === 1 ? index.pins[0]!.semantics : "mixed"
    if (index.semantics !== expectedSemantics)
      context.addIssue({
        code: "custom",
        path: ["semantics"],
        message: "Overview semantics must summarize its source pins",
      })
  })

/**
 * All four reads repeat this exact producer context. A row page never changes the
 * graph's global filtered snapshot or the accounting used for its coordinates.
 */
export const ModelDecisionContextSchema = z
  .strictObject({
    schemaVersion: z.literal(MODELS_DECISION_CONTRACT_VERSION),
    snapshotID: OpaqueID,
    producedAt: z.iso.datetime(),
    scope: ModelDecisionScopeSchema,
    filters: ModelDecisionFiltersSchema,
    priceSourcePolicy: ModelPriceSourcePolicySchema,
    availability: z.enum(["ready", "partial", "backend-not-ready"]),
    freshness: z.enum(["current", "stale", "unknown"]),
    unavailableReason: z.string().max(2000).nullable(),
    accounting: ModelDecisionAccountingSchema,
    taskKindCatalog: ModelDecisionTaskKindCatalogSchema,
    classification: ModelDecisionClassificationCoverageSchema,
    priceIndex: ModelDecisionPriceIndexSchema,
  })
  .superRefine((producerContext, context) => {
    if (
      producerContext.priceIndex.sourcePolicyRevision !== producerContext.priceSourcePolicy.revision
    )
      context.addIssue({
        code: "custom",
        path: ["priceIndex", "sourcePolicyRevision"],
        message: "Price index and source policy revisions must match",
      })
    for (const [index, pin] of producerContext.priceIndex.pins.entries())
      if (!producerContext.priceSourcePolicy.sources.includes(pin.source))
        context.addIssue({
          code: "custom",
          path: ["priceIndex", "pins", index, "source"],
          message: "A source pin must use an enabled policy source",
        })
  })
export type ModelDecisionContext = z.infer<typeof ModelDecisionContextSchema>

const ModelDecisionCohortCountsSchema = z.strictObject({
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

const ModelDecisionPricePinSchema = z
  .strictObject({
    source: ModelPricePinSourceSchema.nullable(),
    sourcePolicyRevision: Count,
    sourceRecordID: OpaqueID.nullable(),
    snapshotID: OpaqueID.nullable(),
    retrievedAt: z.iso.datetime().nullable(),
    semantics: z.enum([
      "exact-route-quote",
      "exact-native-model-quote",
      "observed-endpoint-average",
      "unknown",
    ]),
    freshness: z.enum(["current", "stale", "unavailable"]),
  })
  .superRefine((pin, context) => {
    if (pin.source === null) {
      if (
        pin.sourceRecordID !== null ||
        pin.snapshotID !== null ||
        pin.retrievedAt !== null ||
        pin.semantics !== "unknown" ||
        pin.freshness !== "unavailable"
      )
        context.addIssue({
          code: "custom",
          message: "An unavailable price cannot claim a source pin or quote",
        })
    } else if (
      pin.snapshotID === null ||
      pin.retrievedAt === null ||
      pin.semantics === "unknown" ||
      pin.freshness === "unavailable"
    )
      context.addIssue({
        code: "custom",
        message: "A selected price source requires an authentic available quote pin",
      })
  })

const ModelDecisionNativeCostSchema = z.strictObject({
  status: z.enum(["available", "partial", "unknown", "unmetered"]),
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

const ModelDecisionEfficiencySchema = z.discriminatedUnion("status", [
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

function refineZeroAcceptedEfficiency(
  acceptedTaskCount: number,
  efficiency: ModelDecisionEfficiency,
  context: z.RefinementCtx,
) {
  if (acceptedTaskCount !== 0) return
  for (const field of ["tokensPerAcceptedTask", "currentMarketUSDPerAcceptedTask"] as const) {
    if (efficiency[field] !== null)
      context.addIssue({
        code: "custom",
        path: ["efficiency", field],
        message: "A cohort with no accepted tasks has no accepted-task efficiency coordinates",
      })
  }
}

export const ModelDecisionConfigurationSchema = z
  .strictObject({
    configurationID: OpaqueID,
    groupID: OpaqueID,
    label: z.string().min(1).max(512),
    route: ModelDecisionRouteSchema,
    currentPrice: ModelDecisionPricePinSchema,
    /** Additive published-OpenRouter reference; omission remains valid for old v2 records. */
    referenceEstimate: ModelDecisionReferenceEstimateSchema.optional(),
  })
  .superRefine((configuration, context) => {
    if (
      configuration.referenceEstimate &&
      JSON.stringify(configuration.referenceEstimate.route) !== JSON.stringify(configuration.route)
    )
      context.addIssue({
        code: "custom",
        path: ["referenceEstimate", "route"],
        message: "A reference estimate must use its configuration's exact route",
      })
  })
export type ModelDecisionConfiguration = z.infer<typeof ModelDecisionConfigurationSchema>

function refineConfigurationPricePolicy(
  configuration: ModelDecisionConfiguration,
  policy: ModelDecisionContext["priceSourcePolicy"],
  path: Array<string | number>,
  context: z.RefinementCtx,
) {
  if (configuration.currentPrice.sourcePolicyRevision !== policy.revision)
    context.addIssue({
      code: "custom",
      path: [...path, "currentPrice", "sourcePolicyRevision"],
      message: "Configuration price and source policy revisions must match",
    })
  if (
    configuration.currentPrice.source !== null &&
    !policy.sources.includes(configuration.currentPrice.source)
  )
    context.addIssue({
      code: "custom",
      path: [...path, "currentPrice", "source"],
      message: "A configuration price must use an enabled policy source",
    })
}

export const ModelDecisionRowSchema = z
  .strictObject({
    configuration: ModelDecisionConfigurationSchema,
    cohort: ModelDecisionCohortCountsSchema,
    efficiency: ModelDecisionEfficiencySchema,
    nativeReportedCost: ModelDecisionNativeCostSchema,
    /** Same exact route/source estimate as the nested configuration, kept row-addressable. */
    referenceEstimate: ModelDecisionReferenceEstimateSchema.optional(),
  })
  .superRefine((row, context) => {
    refineZeroAcceptedEfficiency(row.cohort.acceptedTaskCount, row.efficiency, context)
    if (Boolean(row.referenceEstimate) !== Boolean(row.configuration.referenceEstimate))
      context.addIssue({
        code: "custom",
        path: ["referenceEstimate"],
        message: "A row and its configuration must either both include or both omit the estimate",
      })
    if (row.referenceEstimate) {
      if (JSON.stringify(row.referenceEstimate.route) !== JSON.stringify(row.configuration.route))
        context.addIssue({
          code: "custom",
          path: ["referenceEstimate", "route"],
          message: "A row reference estimate must use its configuration's exact route",
        })
      if (
        row.configuration.referenceEstimate &&
        JSON.stringify(row.referenceEstimate) !==
          JSON.stringify(row.configuration.referenceEstimate)
      )
        context.addIssue({
          code: "custom",
          path: ["referenceEstimate"],
          message: "Row and configuration reference estimates must agree",
        })
    }
  })
export type ModelDecisionRow = z.infer<typeof ModelDecisionRowSchema>

/** Coordinates are already authoritative; consumers must not infer or rank them. */
export const ModelDecisionGraphPointSchema = z
  .strictObject({
    configurationID: OpaqueID,
    groupID: OpaqueID,
    label: z.string().min(1).max(512),
    tokensPerAcceptedTask: Nonnegative,
    currentMarketUSDPerAcceptedTask: Nonnegative,
    observationCount: z.int().positive(),
    acceptedTaskCount: Count,
    /** Accepted and rejected logical tasks together; the base of the acceptance rate. */
    terminalTaskCount: Count.optional(),
    partial: z.boolean(),
  })
  .refine((point) => point.acceptedTaskCount > 0, {
    path: ["acceptedTaskCount"],
    message: "A graph point requires at least one accepted task",
  })
export type ModelDecisionGraphPoint = z.infer<typeof ModelDecisionGraphPointSchema>

const ModelDecisionGraphSchema = z.strictObject({
  scope: z.literal("global-filtered-snapshot"),
  points: z.array(ModelDecisionGraphPointSchema),
  frontierConfigurationIDs: z.array(OpaqueID),
  /** Global filtered-cohort values are independent of loaded row/configuration pages. */
  referenceEstimates: z
    .array(
      z.strictObject({
        configurationID: OpaqueID,
        /** Stable producer-owned display label, independent of loaded row pages. */
        label: z.string().min(1).max(512).optional(),
        /** Actual cohort effort coordinate; null means the producer has no numeric basis. */
        tokensPerAcceptedTask: Nonnegative.nullable().optional(),
        estimate: ModelDecisionReferenceEstimateSchema,
      }),
    )
    .optional(),
})

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

export const ModelDecisionRowsOutputSchema = z
  .strictObject({
    context: ModelDecisionContextSchema,
    rows: z.array(ModelDecisionRowSchema).max(100),
    ...Page,
  })
  .superRefine((output, context) => {
    output.rows.forEach((row, index) =>
      refineConfigurationPricePolicy(
        row.configuration,
        output.context.priceSourcePolicy,
        ["rows", index, "configuration"],
        context,
      ),
    )
  })
export type ModelDecisionRows = z.infer<typeof ModelDecisionRowsOutputSchema>

export const ModelDecisionConfigurationsOutputSchema = z
  .strictObject({
    context: ModelDecisionContextSchema,
    configurations: z.array(ModelDecisionConfigurationSchema).max(100),
    ...Page,
  })
  .superRefine((output, context) => {
    output.configurations.forEach((configuration, index) =>
      refineConfigurationPricePolicy(
        configuration,
        output.context.priceSourcePolicy,
        ["configurations", index],
        context,
      ),
    )
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

/**
 * Route coverage for the complete retry history of accepted logical tasks.
 * `mixed` means the history contains both same-route and cross-route observations.
 */
const ModelDecisionEstimateHistoryScopeSchema = z.strictObject({
  completeness: z.literal("complete-accepted-logical-task-retry-history"),
  routeScope: z.enum(["same-route", "cross-route", "mixed", "unknown"]),
})

const EstimateHistoryScope = {
  /** Omission preserves old v2 records without implying same-route history. */
  historyScope: ModelDecisionEstimateHistoryScopeSchema.nullable().optional(),
}

/** Observed spread, never a predictive confidence interval. */
export const ModelDecisionEstimateSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("available"),
      basis: z.literal("empirical-observed-spread"),
      observationCount: z.int().min(2),
      range: EmpiricalRange,
      confidenceInterval: z.null(),
      ...EstimateHistoryScope,
    }),
    z.strictObject({
      status: z.literal("single-observation"),
      basis: z.literal("empirical-observed-spread"),
      observationCount: z.literal(1),
      range: EmpiricalRange,
      confidenceInterval: z.null(),
      ...EstimateHistoryScope,
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
      ...EstimateHistoryScope,
    }),
    z.strictObject({
      status: z.literal("zero-accepted"),
      basis: z.literal("no-successful-task-efficiency"),
      observationCount: Count,
      range: EmptyEmpiricalRange,
      confidenceInterval: z.null(),
      ...EstimateHistoryScope,
    }),
    z.strictObject({
      status: z.literal("unknown"),
      basis: z.literal("unavailable"),
      observationCount: Count,
      range: EmptyEmpiricalRange,
      confidenceInterval: z.null(),
      reason: z.string().min(1).max(2000),
      ...EstimateHistoryScope,
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

const ModelDecisionContributorSchema = z.strictObject({
  taskID: z.uuid(),
  taskReference: TaskReferenceSchema,
  attemptID: z.uuid().nullable(),
  sessionID: z.string().min(1).max(200),
  contribution: z.enum(["accepted", "failed", "retry"]),
  /** Missing or null route means the exact contributor route is unknown. */
  route: ModelDecisionRouteSchema.nullable().optional(),
  /** Whether this work contributes to the configuration cohort, accepted history, or both. */
  membership: z.enum(["cohort-effort", "empirical-history", "both"]).optional(),
  tokens: Nonnegative.nullable(),
  currentMarketUSD: Nonnegative.nullable(),
  nativeReportedUSD: Nonnegative.nullable(),
  observedAt: z.iso.datetime().nullable(),
})
export type ModelDecisionContributor = z.infer<typeof ModelDecisionContributorSchema>

const ModelDecisionContributorPageSchema = z.strictObject({
  contributors: z.array(ModelDecisionContributorSchema).max(100),
  ...Page,
})
export type ModelDecisionContributorPage = z.infer<typeof ModelDecisionContributorPageSchema>

export const ModelDecisionInspectOutputSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("found"),
      context: ModelDecisionContextSchema,
      configuration: ModelDecisionConfigurationSchema,
      cohort: ModelDecisionCohortCountsSchema,
      efficiency: ModelDecisionEfficiencySchema,
      nativeReportedCost: ModelDecisionNativeCostSchema,
      selectedTaskID: z.uuid().nullable(),
      estimate: ModelDecisionEstimateSchema,
      referenceEstimate: ModelDecisionReferenceEstimateSchema.optional(),
      contributorPage: ModelDecisionContributorPageSchema,
      /** Optional additive v1 known-usage endpoint-scenario surface; v2 values stay unchanged. */
      knownUsageMarket: KnownUsageMarketSchema.optional(),
      /** Additive: median first-attempt-to-acceptance time of the accepted tasks; absent when unrecorded. */
      medianAcceptedDurationMs: Nonnegative.optional(),
    }),
    z.strictObject({
      status: z.literal("not-found"),
      context: ModelDecisionContextSchema,
      configurationID: OpaqueID,
    }),
  ])
  .superRefine((inspection, context) => {
    if (inspection.status === "found")
      refineZeroAcceptedEfficiency(
        inspection.cohort.acceptedTaskCount,
        inspection.efficiency,
        context,
      )
    if (inspection.status === "found")
      refineConfigurationPricePolicy(
        inspection.configuration,
        inspection.context.priceSourcePolicy,
        ["configuration"],
        context,
      )
    if (
      inspection.status === "found" &&
      Boolean(inspection.referenceEstimate) !== Boolean(inspection.configuration.referenceEstimate)
    )
      context.addIssue({
        code: "custom",
        path: ["referenceEstimate"],
        message:
          "An inspection and its configuration must either both include or both omit the estimate",
      })
    if (
      inspection.status === "found" &&
      inspection.referenceEstimate &&
      (JSON.stringify(inspection.referenceEstimate.route) !==
        JSON.stringify(inspection.configuration.route) ||
        (inspection.configuration.referenceEstimate &&
          JSON.stringify(inspection.referenceEstimate) !==
            JSON.stringify(inspection.configuration.referenceEstimate)))
    )
      context.addIssue({
        code: "custom",
        path: ["referenceEstimate"],
        message: "Inspection and configuration reference estimates must agree",
      })
  })
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
