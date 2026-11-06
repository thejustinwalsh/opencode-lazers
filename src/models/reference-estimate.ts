import { z } from "zod"
import type { ModelPriceSourceSettings } from "./price-source-settings.ts"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import { modelIdentityReference, resolveModelIdentity } from "./model-identity.ts"
import type { ModelIdentityResolution } from "./model-identity.ts"

const Nonnegative = z.number().finite().nonnegative()
const Count = z.number().int().nonnegative().max(100_000)
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Range = z
  .strictObject({ minimum: Nonnegative, maximum: Nonnegative })
  .refine((range) => range.minimum <= range.maximum, {
    message: "A reference estimate range cannot have its minimum above its maximum",
  })

export const ReferenceRouteSchema = z.strictObject({
  providerID: z.string().min(1).max(512),
  modelID: z.string().min(1).max(512),
  variant: z.string().min(1).max(512).nullable(),
})
export type ReferenceRoute = z.infer<typeof ReferenceRouteSchema>

const UsageCategorySchema = z.strictObject({
  tokens: Nonnegative.nullable(),
  status: z.enum(["observed", "partial", "missing", "unavailable"]),
  rateCoverage: z.enum(["complete", "partial", "missing", "not-required", "unknown"]),
})

const ReferenceCoverageSchema = z.strictObject({
  categories: z.strictObject({
    uncachedInput: UsageCategorySchema,
    output: UsageCategorySchema,
    reasoning: UsageCategorySchema,
    cacheRead: UsageCategorySchema,
    cacheWrite: UsageCategorySchema,
  }),
  retries: z.strictObject({
    status: z.enum(["complete", "partial", "unknown"]),
    attemptCount: Count,
    failedAttemptCount: Count,
    retryAttemptCount: Count,
    attemptsWithCompleteUsage: Count,
    failedAttemptsWithCompleteUsage: Count,
    retryAttemptsWithCompleteUsage: Count,
  }),
  attribution: z.strictObject({
    status: z.enum(["complete", "partial"]),
    relatedTaskCount: Count,
    unknownRouteTaskCount: Count,
    relatedSessionCount: Count,
    matchedRouteSessionCount: Count,
    includedSessionCount: Count,
    otherRouteSessionCount: Count,
    mixedRouteSessionCount: Count,
    unknownRouteSessionCount: Count,
    sharedSessionCount: Count,
    unattributedSessionCount: Count,
  }),
})

const ProvenanceSchema = z.strictObject({
  source: z.literal("openrouter-models").nullable(),
  policyRevision: Revision,
  availability: z.enum(["available", "disabled", "unavailable"]),
  access: z.enum(["configured", "not-configured", "reauthentication-required", "unknown"]),
  snapshotID: z.uuid().nullable(),
  generation: Revision.nullable(),
  retrievedAt: z.iso.datetime().nullable(),
  sourceURL: z.url().max(2048).nullable(),
  recordID: z.string().min(1).max(512).nullable(),
  recordIndex: z.number().int().nonnegative().max(1_999).nullable(),
  freshness: z.enum(["current", "stale", "unknown", "unavailable"]),
})

export const ModelDecisionReferenceEstimateSchema = z
  .strictObject({
    status: z.enum(["exact", "conditional", "partial", "zero-accepted", "unavailable"]),
    basis: z.literal("openrouter-published-model-reference-cost-per-accepted-task"),
    route: ReferenceRouteSchema,
    acceptedTaskCount: Count,
    numeratorUSD: Nonnegative.nullable(),
    numeratorRangeUSD: Range.nullable(),
    valueUSDPerAcceptedTask: Nonnegative.nullable(),
    rangeUSDPerAcceptedTask: Range.nullable(),
    knownSubtotalUSD: Nonnegative.nullable(),
    knownSubtotalRangeUSD: Range.nullable(),
    knownSubtotalUSDPerAcceptedTask: Nonnegative.nullable(),
    knownSubtotalRangeUSDPerAcceptedTask: Range.nullable(),
    identityStatus: z.enum([
      "not-checked",
      "exact",
      "ambiguous",
      "unsupported",
      "supported-but-absent",
      "source-unavailable",
    ]),
    provenance: ProvenanceSchema,
    coverage: ReferenceCoverageSchema,
    reasons: z
      .array(
        z.enum([
          "zero-accepted",
          "openrouter-disabled",
          "openrouter-unavailable",
          "catalog-unavailable",
          "identity-unavailable",
          "identity-ambiguous",
          "identity-unsupported",
          "identity-absent",
          "missing-rates",
          "missing-usage",
          "missing-rate",
          "unsupported-selector",
          "partial-attribution",
          "stale-source",
          "source-freshness-unknown",
          "nonfinite-arithmetic",
        ]),
      )
      .max(16),
  })
  .superRefine((estimate, context) => {
    const exactNumbers =
      estimate.numeratorUSD !== null &&
      estimate.valueUSDPerAcceptedTask !== null &&
      estimate.numeratorRangeUSD === null &&
      estimate.rangeUSDPerAcceptedTask === null
    const conditionalNumbers =
      estimate.numeratorUSD === null &&
      estimate.valueUSDPerAcceptedTask === null &&
      estimate.numeratorRangeUSD !== null &&
      estimate.rangeUSDPerAcceptedTask !== null
    if (estimate.numeratorUSD !== null && estimate.numeratorRangeUSD !== null)
      context.addIssue({
        code: "custom",
        path: ["numeratorRangeUSD"],
        message: "A reference numerator is either scalar or ranged, not both",
      })
    if (estimate.knownSubtotalUSD !== null && estimate.knownSubtotalRangeUSD !== null)
      context.addIssue({
        code: "custom",
        path: ["knownSubtotalRangeUSD"],
        message: "A known subtotal is either scalar or ranged, not both",
      })
    if (
      estimate.acceptedTaskCount > 0 &&
      ((estimate.knownSubtotalUSD !== null) !==
        (estimate.knownSubtotalUSDPerAcceptedTask !== null) ||
        (estimate.knownSubtotalRangeUSD !== null) !==
          (estimate.knownSubtotalRangeUSDPerAcceptedTask !== null))
    )
      context.addIssue({
        code: "custom",
        path: ["acceptedTaskCount"],
        message: "Known subtotals with a nonzero denominator must include their per-task amount",
      })
    if (estimate.status === "exact" && (!exactNumbers || estimate.acceptedTaskCount === 0))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "An exact reference estimate requires a nonzero denominator and scalar numerator",
      })
    if (
      estimate.status === "conditional" &&
      (!conditionalNumbers || estimate.acceptedTaskCount === 0)
    )
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A conditional estimate requires a nonzero denominator and cost envelope",
      })
    if (
      estimate.status === "zero-accepted" &&
      (estimate.acceptedTaskCount !== 0 ||
        estimate.valueUSDPerAcceptedTask !== null ||
        estimate.rangeUSDPerAcceptedTask !== null ||
        estimate.knownSubtotalUSDPerAcceptedTask !== null ||
        estimate.knownSubtotalRangeUSDPerAcceptedTask !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["acceptedTaskCount"],
        message: "Zero accepted tasks have no per-accepted-task value",
      })
    if (
      estimate.status === "unavailable" &&
      (estimate.numeratorUSD !== null ||
        estimate.numeratorRangeUSD !== null ||
        estimate.valueUSDPerAcceptedTask !== null ||
        estimate.rangeUSDPerAcceptedTask !== null ||
        estimate.knownSubtotalUSD !== null ||
        estimate.knownSubtotalRangeUSD !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Unavailable identity or source cannot publish reference amounts",
      })
    if (
      estimate.status === "partial" &&
      (estimate.numeratorUSD !== null ||
        estimate.numeratorRangeUSD !== null ||
        estimate.valueUSDPerAcceptedTask !== null ||
        estimate.rangeUSDPerAcceptedTask !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Partial reference coverage cannot publish a complete total or bound",
      })
    if (
      estimate.status !== "unavailable" &&
      estimate.provenance.availability !== "available" &&
      estimate.status !== "zero-accepted"
    )
      context.addIssue({
        code: "custom",
        path: ["provenance", "availability"],
        message: "A usable reference estimate requires enabled, accessible OpenRouter pricing",
      })
    if (
      (estimate.status === "exact" || estimate.status === "conditional") &&
      (estimate.identityStatus !== "exact" || estimate.provenance.recordID === null)
    )
      context.addIssue({
        code: "custom",
        path: ["identityStatus"],
        message: "A complete reference estimate requires one exact catalog identity",
      })
  })
export type ModelDecisionReferenceEstimate = z.infer<typeof ModelDecisionReferenceEstimateSchema>

export type ReferenceUsageCategory = {
  tokens: number | null
  status: "observed" | "partial" | "missing" | "unavailable"
}

export type ReferenceEstimateSession = {
  sessionID: string
  route: ReferenceRoute | null
  routeStatus:
    "single-observed-route" | "mixed-observed-routes" | "identity-unavailable" | "unavailable"
  shared: boolean
  attributable: boolean
  categories: Record<
    "uncachedInput" | "output" | "reasoning" | "cacheRead" | "cacheWrite",
    ReferenceUsageCategory
  >
  attempts: Array<{ id: string; state: string; retry: boolean }>
}

const CATEGORIES = ["uncachedInput", "output", "reasoning", "cacheRead", "cacheWrite"] as const
type Category = (typeof CATEGORIES)[number]
type Schedule = {
  minPromptTokens: number | null
  utcStart: number | null
  utcEnd: number | null
  prompt: string | null
  completion: string | null
  inputCacheRead: string | null
  inputCacheWrite: string | null
}
type CategoryCoverage = z.infer<typeof UsageCategorySchema>
type SourceFreshness = z.infer<typeof ProvenanceSchema.shape.freshness>

function routeKey(route: ReferenceRoute | null) {
  return route ? JSON.stringify([route.providerID, route.modelID, route.variant]) : null
}

function sameRoute(left: ReferenceRoute | null, right: ReferenceRoute) {
  return routeKey(left) === routeKey(right)
}

function sourceFreshness(source: ModelEvidenceComparisonSourceRead | undefined): SourceFreshness {
  const snapshot = source?.snapshot
  if (!snapshot || source?.snapshotState !== "available") return "unavailable"
  const refresh = source.refresh
  if (!refresh || source.storage !== "ready") return "unknown"
  return refresh.state === "succeeded" &&
    refresh.generation === snapshot.generation &&
    refresh.latestSnapshotID === snapshot.snapshotID &&
    refresh.latestRetrievedAt === snapshot.retrievedAt &&
    refresh.latestRecordCount === snapshot.records.length
    ? "current"
    : "stale"
}

function exactNativeEvidence(
  route: ReferenceRoute,
  source: ModelEvidenceComparisonSourceRead | undefined,
) {
  const snapshot = source?.snapshot?.source === "native-catalog" ? source.snapshot : null
  if (!snapshot) return []
  const indexes = source
    ? (source as ModelEvidenceComparisonSourceRead & { recordIndexes?: readonly number[] })
        .recordIndexes
    : undefined
  return snapshot.records.flatMap((record, index) =>
    record.providerID === route.providerID && record.id === route.modelID
      ? [modelIdentityReference("native-catalog", snapshot, indexes?.[index] ?? index, record.id)]
      : [],
  )
}

function categoryRate(category: Category, schedule: Schedule) {
  switch (category) {
    case "uncachedInput":
      return schedule.prompt
    case "output":
    case "reasoning":
      return schedule.completion
    case "cacheRead":
      return schedule.inputCacheRead
    case "cacheWrite":
      return schedule.inputCacheWrite
  }
}

function rateNumber(value: string | null) {
  if (value === null) return { value: null, nonfinite: false }
  const rate = Number(value)
  if (rate === 0 && /[1-9]/.test(value)) return { value: null, nonfinite: true }
  return Number.isFinite(rate) && rate >= 0
    ? { value: rate, nonfinite: false }
    : { value: null, nonfinite: true }
}

function aggregateUsage(sessions: readonly ReferenceEstimateSession[]) {
  let nonfinite = false
  const categories = Object.fromEntries(
    CATEGORIES.map((category) => {
      const measures = sessions.map((session) => session.categories[category])
      const values = measures.flatMap((measure) =>
        (measure.status === "observed" || measure.status === "partial") && measure.tokens !== null
          ? [measure.tokens]
          : [],
      )
      let tokens: number | null = values.length ? 0 : null
      for (const value of values) {
        tokens = (tokens ?? 0) + value
        if (!Number.isFinite(tokens)) {
          nonfinite = true
          return [category, { tokens: null, status: "partial" as const }]
        }
      }
      const status =
        measures.length > 0 &&
        measures.every((measure) => measure.status === "observed" && measure.tokens !== null)
          ? "observed"
          : values.length > 0 || measures.some((measure) => measure.status === "partial")
            ? "partial"
            : measures.some((measure) => measure.status === "unavailable")
              ? "unavailable"
              : "missing"
      return [category, { tokens, status }]
    }),
  ) as Record<Category, ReferenceUsageCategory>
  const complete = CATEGORIES.every(
    (category) =>
      categories[category].status === "observed" && categories[category].tokens !== null,
  )
  const hasObserved = CATEGORIES.some((category) => categories[category].tokens !== null)
  return { categories, complete, hasObserved, nonfinite }
}

function uniqueSessions(sessions: readonly ReferenceEstimateSession[]) {
  const unique = new Map<string, ReferenceEstimateSession>()
  for (const session of sessions)
    if (!unique.has(session.sessionID)) unique.set(session.sessionID, session)
  return [...unique.values()]
}

function rangesFromSchedules(
  categories: Record<Category, ReferenceUsageCategory>,
  schedules: readonly Schedule[],
  hasObservedUsage: boolean,
) {
  let nonfinite = false
  let missingRate = false
  let missingUsage = false
  const subtotals: Array<number | null> = []
  const completeAmounts: Array<number | null> = []
  const rateCoverage = Object.fromEntries(
    CATEGORIES.map((category) => {
      const usage = categories[category]
      if (usage.tokens === null) {
        missingUsage = true
        return [category, { ...usage, rateCoverage: "unknown" as const }]
      }
      if (usage.tokens === 0 && usage.status === "observed")
        return [category, { ...usage, rateCoverage: "not-required" as const }]
      const rates = schedules.map((schedule) => rateNumber(categoryRate(category, schedule)))
      if (rates.some((rate) => rate.nonfinite)) nonfinite = true
      const knownRates = rates.filter((rate) => rate.value !== null)
      if (knownRates.length === schedules.length)
        return [category, { ...usage, rateCoverage: "complete" as const }]
      if (knownRates.length > 0) return [category, { ...usage, rateCoverage: "partial" as const }]
      missingRate = true
      return [category, { ...usage, rateCoverage: "missing" as const }]
    }),
  ) as Record<Category, CategoryCoverage>

  for (const schedule of schedules) {
    let subtotal = 0
    let hasPricedCategory = false
    let completeAmount = true
    for (const category of CATEGORIES) {
      const usage = categories[category]
      if (usage.tokens === null) {
        completeAmount = false
        continue
      }
      if (usage.tokens === 0) {
        if (usage.status !== "observed") completeAmount = false
        continue
      }
      const rate = rateNumber(categoryRate(category, schedule))
      if (rate.nonfinite) nonfinite = true
      if (rate.value === null) {
        missingRate = true
        completeAmount = false
        continue
      }
      const value = usage.tokens * rate.value
      if (!Number.isFinite(value)) {
        nonfinite = true
        completeAmount = false
        continue
      }
      subtotal += value
      if (!Number.isFinite(subtotal)) {
        nonfinite = true
        completeAmount = false
        subtotal = 0
        hasPricedCategory = false
        break
      }
      hasPricedCategory = true
    }
    if (hasPricedCategory || hasObservedUsage) {
      subtotals.push(subtotal)
    } else subtotals.push(null)
    completeAmounts.push(completeAmount ? subtotal : null)
  }

  const subtotalValues = subtotals.filter((value): value is number => value !== null)
  const completeValues = completeAmounts.filter((value): value is number => value !== null)
  return {
    rateCoverage,
    complete: !missingUsage && !missingRate && completeValues.length === schedules.length,
    nonfinite,
    missingRate,
    missingUsage,
    knownSubtotal:
      nonfinite || !subtotalValues.length
        ? null
        : { minimum: Math.min(...subtotalValues), maximum: Math.max(...subtotalValues) },
    completeRange:
      completeValues.length === schedules.length && completeValues.length > 0
        ? { minimum: Math.min(...completeValues), maximum: Math.max(...completeValues) }
        : null,
  }
}

function emptyCoverage(input: {
  relatedTaskCount: number
  unknownRouteTaskCount: number
  relatedSessions: readonly ReferenceEstimateSession[]
  matchedSessions: readonly ReferenceEstimateSession[]
  includedSessions: readonly ReferenceEstimateSession[]
  unattributedSessionCount: number
  missingAttribution: boolean
}) {
  const attempts = new Map<string, { state: string; retry: boolean; complete: boolean }>()
  for (const session of input.relatedSessions) {
    const matched = input.matchedSessions.some((item) => item.sessionID === session.sessionID)
    if (!matched && session.routeStatus === "single-observed-route") continue
    for (const attempt of session.attempts)
      if (!attempts.has(attempt.id))
        attempts.set(attempt.id, {
          state: attempt.state,
          retry: attempt.retry,
          complete:
            input.includedSessions.some((included) => included.sessionID === session.sessionID) &&
            CATEGORIES.every(
              (category) =>
                session.categories[category].status === "observed" &&
                session.categories[category].tokens !== null,
            ),
        })
  }
  const attemptsList = [...attempts.values()]
  const attemptCount = attemptsList.length
  const attemptsWithCompleteUsage = attemptsList.filter((attempt) => attempt.complete).length
  const failed = attemptsList.filter((attempt) => attempt.state === "failed")
  const retries = attemptsList.filter((attempt) => attempt.retry)
  const attributionIncomplete =
    input.missingAttribution ||
    input.unknownRouteTaskCount > 0 ||
    input.unattributedSessionCount > 0 ||
    input.matchedSessions.some((session) => session.shared || !session.attributable) ||
    input.relatedSessions.some(
      (session) =>
        session.routeStatus === "mixed-observed-routes" ||
        session.routeStatus === "identity-unavailable" ||
        session.routeStatus === "unavailable",
    )
  const attributionStatus = attributionIncomplete ? ("partial" as const) : ("complete" as const)
  const mixedRouteSessionCount = input.relatedSessions.filter(
    (session) => session.routeStatus === "mixed-observed-routes",
  ).length
  const unknownRouteSessionCount = input.relatedSessions.filter(
    (session) =>
      session.routeStatus === "identity-unavailable" || session.routeStatus === "unavailable",
  ).length
  const otherRouteSessionCount = input.relatedSessions.filter(
    (session) =>
      session.routeStatus === "single-observed-route" &&
      session.route !== null &&
      !input.matchedSessions.some((matched) => matched.sessionID === session.sessionID),
  ).length
  const sharedSessionCount = input.matchedSessions.filter((session) => session.shared).length
  const categories = aggregateUsage(input.includedSessions).categories
  const categoryCoverage = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      { ...categories[category], rateCoverage: "unknown" as const },
    ]),
  ) as Record<Category, CategoryCoverage>
  const retriesComplete =
    attemptCount > 0 &&
    attemptsWithCompleteUsage === attemptCount &&
    attributionStatus === "complete" &&
    input.unknownRouteTaskCount === 0 &&
    input.unattributedSessionCount === 0
  return {
    categories: categoryCoverage,
    retries: {
      status:
        attemptCount === 0
          ? ("unknown" as const)
          : retriesComplete
            ? ("complete" as const)
            : ("partial" as const),
      attemptCount,
      failedAttemptCount: failed.length,
      retryAttemptCount: retries.length,
      attemptsWithCompleteUsage,
      failedAttemptsWithCompleteUsage: failed.filter((attempt) => attempt.complete).length,
      retryAttemptsWithCompleteUsage: retries.filter((attempt) => attempt.complete).length,
    },
    attribution: {
      status: attributionStatus,
      relatedTaskCount: input.relatedTaskCount,
      unknownRouteTaskCount: input.unknownRouteTaskCount,
      relatedSessionCount: input.relatedSessions.length,
      matchedRouteSessionCount: input.matchedSessions.length,
      includedSessionCount: input.includedSessions.length,
      otherRouteSessionCount,
      mixedRouteSessionCount,
      unknownRouteSessionCount,
      sharedSessionCount,
      unattributedSessionCount: input.unattributedSessionCount,
    },
  }
}

function emptyEstimate(input: {
  route: ReferenceRoute
  acceptedTaskCount: number
  settings: ModelPriceSourceSettings
  availability: "available" | "disabled" | "unavailable"
  access: ModelPriceSourceSettings["access"]["openrouter"]
  freshness: SourceFreshness
  identityStatus: ModelIdentityResolution["status"] | "not-checked"
  reason: z.infer<typeof ModelDecisionReferenceEstimateSchema.shape.reasons.element>
  coverage: z.infer<typeof ReferenceCoverageSchema>
  source?: ModelEvidenceComparisonSourceRead
  recordID?: string | null
  recordIndex?: number | null
  numeratorUSD?: number | null
  numeratorRangeUSD?: { minimum: number; maximum: number } | null
  knownSubtotalUSD?: { minimum: number; maximum: number } | null
  status?: ModelDecisionReferenceEstimate["status"]
}) {
  const snapshot =
    input.source?.snapshot?.source === "openrouter-models" ? input.source.snapshot : null
  const reasons = new Set<typeof input.reason>([input.reason])
  if (input.freshness === "stale") reasons.add("stale-source")
  if (input.freshness === "unknown") reasons.add("source-freshness-unknown")
  if (input.acceptedTaskCount === 0) reasons.add("zero-accepted")
  const estimateStatus =
    input.acceptedTaskCount === 0 ? "zero-accepted" : (input.status ?? "unavailable")
  const numeratorUSD = input.numeratorUSD ?? null
  const numeratorRangeUSD = input.numeratorRangeUSD ?? null
  const knownSubtotalUSD = input.knownSubtotalUSD
    ? input.knownSubtotalUSD.minimum === input.knownSubtotalUSD.maximum
      ? input.knownSubtotalUSD.minimum
      : null
    : null
  const knownSubtotalRangeUSD = input.knownSubtotalUSD
    ? input.knownSubtotalUSD.minimum === input.knownSubtotalUSD.maximum
      ? null
      : input.knownSubtotalUSD
    : null
  const denominator = input.acceptedTaskCount
  const valueUSDPerAcceptedTask =
    estimateStatus === "exact" && denominator > 0 && numeratorUSD !== null
      ? numeratorUSD / denominator
      : null
  const rangeUSDPerAcceptedTask =
    estimateStatus === "conditional" && denominator > 0 && numeratorRangeUSD
      ? {
          minimum: numeratorRangeUSD.minimum / denominator,
          maximum: numeratorRangeUSD.maximum / denominator,
        }
      : null
  const knownSubtotalUSDPerAcceptedTask =
    denominator > 0 && knownSubtotalUSD !== null ? knownSubtotalUSD / denominator : null
  const knownSubtotalRangeUSDPerAcceptedTask =
    denominator > 0 && knownSubtotalRangeUSD
      ? {
          minimum: knownSubtotalRangeUSD.minimum / denominator,
          maximum: knownSubtotalRangeUSD.maximum / denominator,
        }
      : null
  const cleanNumerator = estimateStatus === "unavailable" ? null : numeratorUSD
  const cleanNumeratorRange = estimateStatus === "unavailable" ? null : numeratorRangeUSD
  const cleanSubtotal = estimateStatus === "unavailable" ? null : knownSubtotalUSD
  const cleanSubtotalRange = estimateStatus === "unavailable" ? null : knownSubtotalRangeUSD
  return ModelDecisionReferenceEstimateSchema.parse({
    status: estimateStatus,
    basis: "openrouter-published-model-reference-cost-per-accepted-task",
    route: input.route,
    acceptedTaskCount: denominator,
    numeratorUSD: cleanNumerator,
    numeratorRangeUSD: cleanNumeratorRange,
    valueUSDPerAcceptedTask:
      estimateStatus === "zero-accepted" || estimateStatus === "unavailable"
        ? null
        : valueUSDPerAcceptedTask,
    rangeUSDPerAcceptedTask:
      estimateStatus === "zero-accepted" || estimateStatus === "unavailable"
        ? null
        : rangeUSDPerAcceptedTask,
    knownSubtotalUSD: cleanSubtotal,
    knownSubtotalRangeUSD: cleanSubtotalRange,
    knownSubtotalUSDPerAcceptedTask:
      estimateStatus === "zero-accepted" || estimateStatus === "unavailable"
        ? null
        : knownSubtotalUSDPerAcceptedTask,
    knownSubtotalRangeUSDPerAcceptedTask:
      estimateStatus === "zero-accepted" || estimateStatus === "unavailable"
        ? null
        : knownSubtotalRangeUSDPerAcceptedTask,
    identityStatus: input.identityStatus,
    provenance: {
      source: snapshot ? "openrouter-models" : null,
      policyRevision: input.settings.policy.revision,
      availability: input.availability,
      access: input.access,
      snapshotID: snapshot?.snapshotID ?? null,
      generation: snapshot?.generation ?? null,
      retrievedAt: snapshot?.retrievedAt ?? null,
      sourceURL: snapshot?.sourceURL ?? null,
      recordID: input.recordID ?? null,
      recordIndex: input.recordIndex ?? null,
      freshness: snapshot ? input.freshness : "unavailable",
    },
    coverage: input.coverage,
    reasons: [...reasons],
  })
}

/**
 * Reprice a single exact route cohort against its independently identified,
 * cached OpenRouter model-catalog record. Session IDs and attempts are counted once.
 */
export function calculateModelDecisionReferenceEstimate(input: {
  route: ReferenceRoute
  acceptedTaskCount: number
  relatedTaskCount: number
  unknownRouteTaskCount: number
  relatedSessions: readonly ReferenceEstimateSession[]
  unattributedSessionCount: number
  missingAttribution: boolean
  settings: ModelPriceSourceSettings
  identityCatalogSource?: ModelEvidenceComparisonSourceRead
  identityNativeSource?: ModelEvidenceComparisonSourceRead
}): ModelDecisionReferenceEstimate {
  const route = ReferenceRouteSchema.parse(input.route)
  const relatedSessions = uniqueSessions(input.relatedSessions)
  const matchedSessions = relatedSessions.filter(
    (session) => session.routeStatus === "single-observed-route" && sameRoute(session.route, route),
  )
  const includedSessions = matchedSessions.filter(
    (session) => !session.shared && session.attributable,
  )
  const coverage = emptyCoverage({
    relatedTaskCount: input.relatedTaskCount,
    unknownRouteTaskCount: input.unknownRouteTaskCount,
    relatedSessions,
    matchedSessions,
    includedSessions,
    unattributedSessionCount: input.unattributedSessionCount,
    missingAttribution:
      input.missingAttribution ||
      matchedSessions.some((session) => session.shared) ||
      matchedSessions.some((session) => !session.attributable) ||
      relatedSessions.some(
        (session) =>
          session.routeStatus === "mixed-observed-routes" ||
          session.routeStatus === "identity-unavailable" ||
          session.routeStatus === "unavailable",
      ),
  })
  const access = input.settings.access.openrouter
  const enabled = input.settings.policy.sources.includes("openrouter")
  if (!enabled || access !== "configured")
    return emptyEstimate({
      route,
      acceptedTaskCount: input.acceptedTaskCount,
      settings: input.settings,
      availability: enabled ? "unavailable" : "disabled",
      access,
      freshness: "unavailable",
      identityStatus: "not-checked",
      reason: enabled ? "openrouter-unavailable" : "openrouter-disabled",
      coverage,
      status: "unavailable",
    })

  const source = input.identityCatalogSource
  const snapshot =
    source?.snapshotState === "available" && source.snapshot?.source === "openrouter-models"
      ? source.snapshot
      : null
  if (!snapshot)
    return emptyEstimate({
      route,
      acceptedTaskCount: input.acceptedTaskCount,
      settings: input.settings,
      availability: "unavailable",
      access,
      freshness: "unavailable",
      identityStatus: "source-unavailable",
      reason: "catalog-unavailable",
      coverage,
      source,
      status: "unavailable",
    })

  const identity = resolveModelIdentity({
    route: { providerID: route.providerID, modelID: route.modelID },
    nativeEvidence: exactNativeEvidence(route, input.identityNativeSource),
    catalogSource: source!,
  })
  const freshness = sourceFreshness(source)
  const identityReasons = {
    ambiguous: "identity-ambiguous",
    unsupported: "identity-unsupported",
    "supported-but-absent": "identity-absent",
    "source-unavailable": "identity-unavailable",
  } as const
  if (identity.resolution.status !== "exact" || identity.catalogMatches.length !== 1) {
    const identityReason =
      identity.resolution.status === "exact"
        ? "identity-unavailable"
        : identityReasons[identity.resolution.status]
    return emptyEstimate({
      route,
      acceptedTaskCount: input.acceptedTaskCount,
      settings: input.settings,
      availability: "available",
      access,
      freshness,
      identityStatus: identity.resolution.status,
      reason: identityReason,
      coverage,
      source,
      status: "unavailable",
    })
  }

  const match = identity.catalogMatches[0]!
  const record = match.record
  const common = {
    route,
    acceptedTaskCount: input.acceptedTaskCount,
    settings: input.settings,
    availability: "available" as const,
    access,
    freshness,
    identityStatus: identity.resolution.status,
    coverage,
    source,
    recordID: record.id,
    recordIndex: match.recordIndex,
  }
  if (!record.prices || record.prices.tiers.length === 0)
    return emptyEstimate({
      ...common,
      reason: "missing-rates",
      status: "partial",
    })

  const schedules = record.prices.tiers.map((tier): Schedule => ({
    minPromptTokens: tier.minPromptTokens ?? null,
    utcStart: tier.utcStart ?? null,
    utcEnd: tier.utcEnd ?? null,
    prompt: tier.prompt,
    completion: tier.completion,
    inputCacheRead: tier.inputCacheRead,
    inputCacheWrite: tier.inputCacheWrite,
  }))
  const hasUTCSelector = schedules.some(
    (schedule) => schedule.utcStart !== null || schedule.utcEnd !== null,
  )
  const promptSelectors = schedules.map((schedule) => schedule.minPromptTokens)
  const hasPromptSelector = promptSelectors.some((value) => value !== null)
  const unsupportedPromptSelectors =
    schedules.length > 1 &&
    (promptSelectors[0] !== null || promptSelectors.slice(1).some((value) => value === null))
  const duplicatePromptSelectors =
    new Set(promptSelectors.filter((value): value is number => value !== null)).size !==
    promptSelectors.filter((value) => value !== null).length
  const ambiguousUnselectedTiers = !hasPromptSelector && schedules.length > 1 && !hasUTCSelector
  const unsupportedSelector =
    hasUTCSelector ||
    duplicatePromptSelectors ||
    ambiguousUnselectedTiers ||
    unsupportedPromptSelectors
  const usage = aggregateUsage(includedSessions)
  const calculation = rangesFromSchedules(usage.categories, schedules, usage.hasObserved)
  calculation.nonfinite ||= usage.nonfinite
  const attributionComplete =
    coverage.attribution.status === "complete" &&
    coverage.retries.status === "complete" &&
    coverage.attribution.unattributedSessionCount === 0
  const usageComplete = usage.complete
  const complete = calculation.complete && usageComplete && attributionComplete
  const isConditional = hasPromptSelector && !unsupportedSelector
  const reasons = new Set<
    z.infer<typeof ModelDecisionReferenceEstimateSchema.shape.reasons.element>
  >()
  if (calculation.missingUsage || !usageComplete) reasons.add("missing-usage")
  if (calculation.missingRate) reasons.add("missing-rate")
  if (unsupportedSelector) reasons.add("unsupported-selector")
  if (!attributionComplete) reasons.add("partial-attribution")
  if (calculation.nonfinite) reasons.add("nonfinite-arithmetic")
  if (freshness === "stale") reasons.add("stale-source")
  if (freshness === "unknown") reasons.add("source-freshness-unknown")
  if (input.acceptedTaskCount === 0) reasons.add("zero-accepted")

  let status: ModelDecisionReferenceEstimate["status"]
  let numeratorUSD: number | null = null
  let numeratorRangeUSD: { minimum: number; maximum: number } | null = null
  let knownSubtotalUSD: { minimum: number; maximum: number } | null = unsupportedSelector
    ? null
    : calculation.knownSubtotal

  if (complete && !unsupportedSelector && calculation.completeRange) {
    if (isConditional) numeratorRangeUSD = calculation.completeRange
    else if (schedules.length === 1) numeratorUSD = calculation.completeRange.minimum
    else reasons.add("unsupported-selector")
  }

  if (numeratorUSD !== null || numeratorRangeUSD !== null) {
    knownSubtotalUSD = null
    status =
      input.acceptedTaskCount === 0 ? "zero-accepted" : numeratorRangeUSD ? "conditional" : "exact"
  } else status = input.acceptedTaskCount === 0 ? "zero-accepted" : "partial"

  if (calculation.nonfinite) {
    numeratorUSD = null
    numeratorRangeUSD = null
    status = input.acceptedTaskCount === 0 ? "zero-accepted" : "partial"
  }

  const result = emptyEstimate({
    ...common,
    reason: "missing-rates",
    status,
    ...(numeratorUSD === null ? {} : { numeratorUSD }),
    ...(numeratorRangeUSD === null ? {} : { numeratorRangeUSD }),
    ...(knownSubtotalUSD === null ? {} : { knownSubtotalUSD }),
    coverage: {
      ...coverage,
      categories: Object.fromEntries(
        CATEGORIES.map((category) => [category, calculation.rateCoverage[category]]),
      ) as z.infer<typeof ReferenceCoverageSchema>["categories"],
    },
  })
  return ModelDecisionReferenceEstimateSchema.parse({
    ...result,
    reasons: [
      ...new Set([...result.reasons.filter((reason) => reason === "zero-accepted"), ...reasons]),
    ],
  })
}
