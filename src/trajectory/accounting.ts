export type AccountingRoute = {
  providerID: string
  modelID: string
  variant: string | null
  /** Exact private comparison identity; null means the source identity was lost. */
  identity?: {
    providerID: string
    modelID: string
    variant: string | null
  } | null
}

type AccountingRouteSource = {
  attemptID: string | null
  source: string
  sourceType: string
  observedAt: number | null
  recordedAt: number | null
  eventID: string | null
}

type AccountingStepRoute = {
  sessionID: string
  messageID: string | null
  route: AccountingRoute
  /** Internal provenance for unavailable route keys; omitted from the public view. */
  sourceOccurrence: string
  sources: AccountingRouteSource[]
}

export type AccountingAttempt = {
  id: string
  sessionID: string
  state: string
  legacyTokenCount: number | null
  recordedCostUSD: number | null
  planRoute: AccountingRoute | null
  planRouteStatus: "explicit" | "inherited" | "unavailable"
  frozenRoute: AccountingRoute | null
  frozenRouteSource: string | null
  personaRequested: string | null
  personaFrozen: string | null
  sessionStatus: "available" | "missing" | "unavailable"
  contextStatus: "available" | "not-read" | "unavailable"
  currentRoute: AccountingRoute | null
  currentRouteObservedAt: number | null
  sessionUsage: Record<string, unknown> | null
  sessionUsageObservedAt: number | null
  stepRoutes: Array<{
    messageID: string
    route: AccountingRoute
    observedAt: number | null
  }>
}

type UsageCategory = "uncachedInput" | "output" | "reasoning" | "cacheRead" | "cacheWrite"
type UsageStatus = "observed" | "partial" | "missing" | "unavailable"
type UsageBasis =
  | "native-session-cumulative-snapshot"
  | "retained-progress-cumulative-snapshot"
  | "retained-progress-additive-steps"
  | "unavailable"

type UsageObservation = {
  source: string | null
  sourceType: string | null
  observedAt: number | null
  observationTimeBasis: string | null
  recordedAt: number | null
  value: number | null
  missingness: string | null
}

type CategoryMeasure = {
  value: number | null
  unit: "tokens"
  status: UsageStatus
  basis: UsageBasis
  valueScope: "selected-cumulative-snapshot" | "retained-additive-subtotal" | "unknown"
  source: string | null
  sourceTypes: string[]
  observedAt: number | null
  observationTimeBasis: string | null
  observationTimeRange: { earliest: number | null; latest: number | null }
  observationCount: number
  missingObservations: number
  observationDetailsTruncated: boolean
  observations: UsageObservation[]
}

type ProgressUsageFact = {
  id: string
  sequence: number | null
  attemptID: string
  sessionID: string
  kind: string
  source: string
  sources: string[]
  at: number | null
  usageObservedAt: number | null
  usageObservedAtSourceType: string | null
  recordedAt: number | null
  messageID: string | null
  eventIDs: string[]
  measurementBasis: string | null
  usage: Record<string, unknown> | null
}

const CATEGORIES: readonly UsageCategory[] = [
  "uncachedInput",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
]

const CATEGORY_FIELDS: Record<UsageCategory, string> = {
  uncachedInput: "input",
  output: "output",
  reasoning: "reasoning",
  cacheRead: "cacheRead",
  cacheWrite: "cacheWrite",
}

const CATEGORY_MEANINGS: Record<UsageCategory, string> = {
  uncachedInput: "OpenCode input tokens; cache read and write tokens are reported separately",
  output: "OpenCode output tokens; reasoning is reported separately",
  reasoning: "OpenCode reasoning tokens as reported by the source",
  cacheRead: "OpenCode cache-read tokens as reported by the source",
  cacheWrite: "OpenCode cache-write tokens as reported by the source",
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function epoch(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function route(value: unknown): AccountingRoute | null {
  const data = object(value)
  const providerID = text(data?.providerID)
  const modelID = text(data?.modelID) ?? text(data?.id)
  if (!providerID || !modelID) return null
  const variant = text(data?.variant)
  const identityLost = [providerID, modelID, variant].some(
    (part) => part?.endsWith("…[truncated]") || part?.includes("[REDACTED]"),
  )
  return {
    providerID,
    modelID,
    variant,
    identity: identityLost ? null : { providerID, modelID, variant },
  }
}

function exactRouteIdentity(value: AccountingRoute) {
  if (Object.hasOwn(value, "identity")) return value.identity ?? null
  return { providerID: value.providerID, modelID: value.modelID, variant: value.variant }
}

/** Keep exact model identity authoritative; unavailable routes use source provenance, never display text. */
function routeKey(value: AccountingRoute, sourceOccurrence: string) {
  const identity = exactRouteIdentity(value)
  if (identity)
    return JSON.stringify(["exact", identity.providerID, identity.modelID, identity.variant])
  return JSON.stringify(["unavailable", sourceOccurrence])
}

function routeView(value: AccountingRoute | null) {
  return value
    ? { providerID: value.providerID, modelID: value.modelID, variant: value.variant }
    : null
}

function emptyCategory(basis: UsageBasis, status: UsageStatus): CategoryMeasure {
  return {
    value: null,
    unit: "tokens",
    status,
    basis,
    valueScope: "unknown",
    source: null,
    sourceTypes: [],
    observedAt: null,
    observationTimeBasis: null,
    observationTimeRange: { earliest: null, latest: null },
    observationCount: 0,
    missingObservations: 0,
    observationDetailsTruncated: false,
    observations: [],
  }
}

function cumulativeCategory(
  category: UsageCategory,
  usage: Record<string, unknown>,
  basis: Exclude<UsageBasis, "retained-progress-additive-steps" | "unavailable">,
  source: string,
  sourceType: string,
  observedAt: number | null,
  recordedAt: number | null,
): CategoryMeasure {
  const value = finite(usage[CATEGORY_FIELDS[category]])
  const missingness =
    value === null ? "Category was absent or not numeric in the selected cumulative snapshot" : null
  const observationTimeBasis =
    basis === "native-session-cumulative-snapshot"
      ? "native session time.updated; exact token-snapshot change time is unavailable"
      : "runner_progress.at; retained observation time, with recorded_at as local persistence time"
  return {
    value,
    unit: "tokens",
    status: value === null ? "missing" : "observed",
    basis,
    valueScope: "selected-cumulative-snapshot",
    source,
    sourceTypes: [sourceType],
    observedAt,
    observationTimeBasis,
    observationTimeRange: { earliest: observedAt, latest: observedAt },
    observationCount: 1,
    missingObservations: value === null ? 1 : 0,
    observationDetailsTruncated: false,
    observations: [
      { source, sourceType, observedAt, observationTimeBasis, recordedAt, value, missingness },
    ],
  }
}

function parseProgressFacts(values: readonly unknown[]): ProgressUsageFact[] {
  return values.flatMap((value) => {
    const fact = object(value)
    if (!fact) return []
    const usage = object(fact.usage)
    const endpoints = object(object(fact.timing)?.endpoints)
    const completedAt = object(endpoints?.completedAt)
    const at = epoch(fact.at)
    return [
      {
        id: text(fact.id) ?? "unknown-progress-fact",
        sequence: finite(fact.sequence),
        attemptID: text(fact.attemptID) ?? "",
        sessionID: text(fact.sessionID) ?? "",
        kind: text(fact.kind) ?? "",
        source: text(fact.source) ?? "unknown-progress-source",
        sources: list(fact.sources),
        at,
        usageObservedAt: epoch(completedAt?.at) ?? at,
        usageObservedAtSourceType: text(completedAt?.sourceType),
        recordedAt: epoch(fact.recordedAt),
        messageID: text(fact.messageID),
        eventIDs: list(fact.eventIDs),
        measurementBasis: text(fact.measurementBasis),
        usage,
      },
    ]
  })
}

function compareProgressSnapshots(left: ProgressUsageFact, right: ProgressUsageFact) {
  return (
    (right.at ?? Number.MIN_SAFE_INTEGER) - (left.at ?? Number.MIN_SAFE_INTEGER) ||
    (right.recordedAt ?? Number.MIN_SAFE_INTEGER) - (left.recordedAt ?? Number.MIN_SAFE_INTEGER) ||
    (right.sequence ?? Number.MIN_SAFE_INTEGER) - (left.sequence ?? Number.MIN_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  )
}

/** What a session's usage needs of one additive step; the rest of the fact is not kept. */
type AdditiveStep = {
  values: Record<UsageCategory, number | null>
  sourceTypes: string[]
  usageObservedAt: number | null
  usageObservedAtSourceType: string | null
  recordedAt: number | null
}

function additiveCategory(category: UsageCategory, steps: AdditiveStep[]): CategoryMeasure {
  if (!steps.length) return emptyCategory("unavailable", "missing")

  const observations = steps.map((step): UsageObservation => {
    const value = step.values[category]
    const sourceTypes = step.sourceTypes
    return {
      source: "worker-progress-step",
      sourceType: step.usageObservedAtSourceType ?? sourceTypes.join("+"),
      observedAt: step.usageObservedAt,
      observationTimeBasis: step.usageObservedAtSourceType
        ? `${step.usageObservedAtSourceType}; retained completion endpoint, with recorded_at as local persistence time`
        : "runner_progress.at; retained step timestamp because a completion endpoint is unavailable, with recorded_at as local persistence time",
      recordedAt: step.recordedAt,
      value,
      missingness:
        value === null
          ? "Category was absent or not numeric in this additive step measurement"
          : null,
    }
  })
  const observed = observations.flatMap((item) => (item.value === null ? [] : [item.value]))
  const times = observations.flatMap((item) => (item.observedAt === null ? [] : [item.observedAt]))
  const sourceTypes = [
    ...new Set(observations.flatMap((item) => (item.sourceType ? [item.sourceType] : []))),
  ].toSorted()
  return {
    value: observed.length ? observed.reduce((total, value) => total + value, 0) : null,
    unit: "tokens",
    // A retained set of additive steps is a subtotal, never asserted to be a complete session.
    status: observed.length ? "partial" : "missing",
    basis: "retained-progress-additive-steps",
    valueScope: "retained-additive-subtotal",
    source: "worker-progress-step",
    sourceTypes,
    observedAt: times.length ? Math.max(...times) : null,
    observationTimeBasis:
      "runner_progress.at; retained step observation time, with recorded_at as local persistence time",
    observationTimeRange: {
      earliest: times.length ? Math.min(...times) : null,
      latest: times.length ? Math.max(...times) : null,
    },
    observationCount: observations.length,
    missingObservations: observations.filter((item) => item.value === null).length,
    observationDetailsTruncated: observations.length > 100,
    observations: observations.slice(0, 100),
  }
}

/**
 * What one session's retained facts contribute to accounting, independent of which attempts
 * select the session: the latest cumulative snapshot, the additive steps (one per call, in usage
 * time order) and the routes the steps observed. Reduced once per change of the session's facts.
 */
export type AccountingFactDigest = {
  cumulative: ProgressUsageFact | null
  additive: AdditiveStep[]
  /** Every observed step route of the session; only digests built with `routes: "full"` have them. */
  stepRoutes?: AccountingStepRoute[]
  /** Keys of the session's step routes, which merging with attempts' own routes counts. */
  stepRouteKeys: string[]
}

const EMPTY_DIGEST: AccountingFactDigest = {
  cumulative: null,
  additive: [],
  stepRoutes: [],
  stepRouteKeys: [],
}

/**
 * Reduce the facts of one session, in their retained order. `routes: "full"` keeps every observed
 * step route (the whole effort basis lists them); `"keys"` keeps what counting them needs.
 */
export function digestAccountingFacts(
  values: readonly unknown[],
  options: { routes: "full" | "keys" } = { routes: "full" },
): AccountingFactDigest {
  const progress = parseProgressFacts(values)
  const cumulative =
    progress
      .filter(
        (fact) =>
          fact.kind === "worker-usage-snapshot" &&
          fact.measurementBasis === "cumulative-session-snapshot" &&
          fact.usage !== null,
      )
      .sort(compareProgressSnapshots)[0] ?? null
  const additiveByIdentity = new Map<string, ProgressUsageFact>()
  for (const fact of progress) {
    if (
      fact.kind !== "worker-step" ||
      fact.measurementBasis !== "additive-step-measurement" ||
      !fact.usage
    )
      continue
    const identity = fact.messageID ?? fact.id
    const previous = additiveByIdentity.get(identity)
    if (!previous || compareProgressSnapshots(previous, fact) > 0)
      additiveByIdentity.set(identity, fact)
  }
  const additive = [...additiveByIdentity.values()].sort(
    (left, right) =>
      (left.usageObservedAt ?? Number.MIN_SAFE_INTEGER) -
        (right.usageObservedAt ?? Number.MIN_SAFE_INTEGER) ||
      (left.sequence ?? Number.MIN_SAFE_INTEGER) - (right.sequence ?? Number.MIN_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
  )
  const stepRoutes = parseObservedProgressRoutes(values, progress)
  return {
    cumulative,
    additive: additive.map((step): AdditiveStep => ({
      values: Object.fromEntries(
        CATEGORIES.map((category) => [category, finite(step.usage?.[CATEGORY_FIELDS[category]])]),
      ) as Record<UsageCategory, number | null>,
      sourceTypes: step.sources.length ? step.sources : [step.source],
      usageObservedAt: step.usageObservedAt,
      usageObservedAtSourceType: step.usageObservedAtSourceType,
      recordedAt: step.recordedAt,
    })),
    ...(options.routes === "full" ? { stepRoutes } : {}),
    stepRouteKeys: [
      ...new Set(
        stepRoutes.flatMap((observed) =>
          observed.sources.map((source) =>
            routeSourceKey({
              sessionID: observed.sessionID,
              messageID: observed.messageID,
              route: observed.route,
              source: source.source,
              eventID: source.eventID,
              sourceOccurrence: observed.sourceOccurrence,
            }),
          ),
        ),
      ),
    ],
  }
}

/** Per-session digests keyed by session id; a session absent from the map has no retained facts. */
type AccountingFactDigests = ReadonlyMap<string, { accounting: AccountingFactDigest }>

const digestsOfArray = new WeakMap<
  readonly unknown[],
  Map<string, { accounting: AccountingFactDigest }>
>()

/** Group raw facts by session and digest each group; once per array. */
function accountingDigestsOf(values: readonly unknown[]): AccountingFactDigests {
  const cached = digestsOfArray.get(values)
  if (cached) return cached
  const groups = new Map<string, unknown[]>()
  for (const value of values) {
    const key = text(object(value)?.sessionID) ?? ""
    const group = groups.get(key)
    if (group) group.push(value)
    else groups.set(key, [value])
  }
  const digests = new Map(
    [...groups].map(([session, facts]) => [session, { accounting: digestAccountingFacts(facts) }]),
  )
  digestsOfArray.set(values, digests)
  return digests
}

function sessionUsage(
  sessionID: string,
  attempts: AccountingAttempt[],
  digest: AccountingFactDigest,
) {
  const native = attempts.find(
    (attempt) => attempt.sessionStatus === "available" && attempt.sessionUsage !== null,
  )
  const cumulative = digest.cumulative
  const additive = digest.additive

  let basis: UsageBasis
  let sourceUsage: Record<string, unknown> | null = null
  let source: string | null = null
  let sourceType: string | null = null
  let observedAt: number | null = null
  let recordedAt: number | null = null
  if (native?.sessionUsage) {
    basis = "native-session-cumulative-snapshot"
    sourceUsage = native.sessionUsage
    source = "native-session"
    sourceType = "session.tokens"
    observedAt = native.sessionUsageObservedAt
  } else if (cumulative?.usage) {
    basis = "retained-progress-cumulative-snapshot"
    sourceUsage = cumulative.usage
    source = "runner-progress-store"
    sourceType = "usage-snapshot:cumulative-session-snapshot"
    observedAt = cumulative.at
    recordedAt = cumulative.recordedAt
  } else if (additive.length) {
    basis = "retained-progress-additive-steps"
  } else {
    basis = "unavailable"
  }

  const status = attempts.some((attempt) => attempt.sessionStatus === "available")
    ? "available"
    : attempts.some((attempt) => attempt.sessionStatus === "unavailable")
      ? "unavailable"
      : "missing"
  const categories = Object.fromEntries(
    CATEGORIES.map((category) => {
      if (sourceUsage && source && sourceType)
        return [
          category,
          cumulativeCategory(
            category,
            sourceUsage,
            basis as Exclude<UsageBasis, "retained-progress-additive-steps" | "unavailable">,
            source,
            sourceType,
            observedAt,
            recordedAt,
          ),
        ]
      if (basis === "retained-progress-additive-steps")
        return [category, additiveCategory(category, additive)]
      return [category, emptyCategory(basis, status === "available" ? "missing" : "unavailable")]
    }),
  ) as Record<UsageCategory, CategoryMeasure>

  return {
    sessionID,
    attemptIDs: attempts.map((attempt) => attempt.id),
    attemptStates: attempts.map((attempt) => attempt.state),
    sessionStatus: status,
    selectedBasis: basis,
    selectedSnapshot: source
      ? {
          source,
          sourceType,
          observedAt,
          observationTimeBasis:
            basis === "native-session-cumulative-snapshot"
              ? "native session time.updated; exact token-snapshot change time is unavailable"
              : "runner_progress.at; retained observation time, with recorded_at as local persistence time",
          recordedAt,
          selection:
            basis === "native-session-cumulative-snapshot"
              ? "current native session snapshot takes precedence"
              : basis === "retained-progress-cumulative-snapshot"
                ? "latest retained cumulative snapshot by event time, persistence time, then sequence"
                : "no cumulative snapshot; retained additive steps are reported as a partial subtotal",
        }
      : null,
    additiveStepCount: additive.length,
    ignoredAdditiveStepCount: basis === "retained-progress-additive-steps" ? 0 : additive.length,
    categories,
  }
}

type SessionUsage = ReturnType<typeof sessionUsage>

/** The fields of a category total the decision valuation reads; the sum folds sessions in order. */
function aggregateCore(category: UsageCategory, sessions: readonly SessionUsage[]) {
  const measures = sessions.map((session) => session.categories[category])
  const known = measures.flatMap((measure) => (measure.value === null ? [] : [measure.value]))
  const sources = [
    ...new Set(measures.flatMap((measure) => (measure.source ? [measure.source] : []))),
  ].toSorted()
  const sourceTypes = [...new Set(measures.flatMap((measure) => measure.sourceTypes))].toSorted()
  const missingSessions = sessions
    .filter((session) => session.categories[category].status !== "observed")
    .map((session) => session.sessionID)
  const status: UsageStatus =
    known.length === 0
      ? measures.some((measure) => measure.status === "unavailable")
        ? "unavailable"
        : "missing"
      : missingSessions.length > 0
        ? "partial"
        : "observed"
  return {
    value: known.length ? known.reduce((total, value) => total + value, 0) : null,
    unit: "tokens" as const,
    status,
    meaning: CATEGORY_MEANINGS[category],
    valueScope:
      status === "observed"
        ? "sum-of-selected-session-snapshots"
        : known.length
          ? "observed-subtotal"
          : "unknown",
    sources,
    sourceTypes,
    missingSessionIDs: missingSessions,
  }
}

function aggregateCategory(category: UsageCategory, sessions: SessionUsage[]) {
  const core = aggregateCore(category, sessions)
  const measures = sessions.map((session) => session.categories[category])
  const observedAt = measures.flatMap((measure) =>
    measure.observedAt === null ? [] : [measure.observedAt],
  )
  const observationTimeBases = [
    ...new Set(
      measures.flatMap((measure) =>
        measure.observationTimeBasis ? [measure.observationTimeBasis] : [],
      ),
    ),
  ].toSorted()
  return {
    ...core,
    observationTimeBases,
    observedAtRange: {
      earliest: observedAt.length ? Math.min(...observedAt) : null,
      latest: observedAt.length ? Math.max(...observedAt) : null,
    },
    observationCount: measures.reduce((total, measure) => total + measure.observationCount, 0),
    missingObservations: measures.reduce(
      (total, measure) => total + measure.missingObservations,
      0,
    ),
    observationDetailsTruncated: measures.some((measure) => measure.observationDetailsTruncated),
    bySession: sessions.map((session) => ({
      sessionID: session.sessionID,
      ...session.categories[category],
    })),
  }
}

function routeComparison(expected: AccountingRoute | null, observed: AccountingRoute) {
  if (!expected) return "unavailable" as const
  const expectedIdentity = exactRouteIdentity(expected)
  const observedIdentity = exactRouteIdentity(observed)
  if (!expectedIdentity || !observedIdentity) return "unavailable" as const
  if (
    expectedIdentity.providerID !== observedIdentity.providerID ||
    expectedIdentity.modelID !== observedIdentity.modelID
  )
    return "mismatch" as const
  if (expectedIdentity.variant !== null && observedIdentity.variant === null)
    return "unavailable" as const
  if (expectedIdentity.variant !== null && expectedIdentity.variant !== observedIdentity.variant)
    return "mismatch" as const
  return "match" as const
}

function distinctRoutes(routes: { route: AccountingRoute; sourceOccurrence: string }[]) {
  const unique = new Map<string, { route: AccountingRoute; sourceOccurrence: string }>()
  for (const value of routes) {
    const key = routeKey(value.route, value.sourceOccurrence)
    if (!unique.has(key)) unique.set(key, value)
  }
  return [...unique.values()].sort((left, right) =>
    routeKey(left.route, left.sourceOccurrence).localeCompare(
      routeKey(right.route, right.sourceOccurrence),
    ),
  )
}

function routeSourceOccurrence(value: {
  attemptID: string | null
  sessionID: string
  messageID: string | null
  source: string
  sourceType: string
  eventID: string | null
  factID?: string | null
  observationIndex?: number | null
}) {
  if (value.source === "native-session-context")
    return JSON.stringify(["session-context", value.sessionID, value.messageID])
  if (value.eventID)
    return JSON.stringify(["source-event", value.sessionID, value.source, value.eventID])
  if (value.factID)
    return JSON.stringify([
      "source-observation-slot",
      value.sessionID,
      value.factID,
      value.observationIndex ?? null,
    ])
  return JSON.stringify([
    "source-record",
    value.sessionID,
    value.source,
    value.sourceType,
    value.messageID,
    value.attemptID,
  ])
}

/** The identity of one observed route of one call: where sources of the same route merge. */
function routeSourceKey(value: {
  sessionID: string
  messageID: string | null
  route: AccountingRoute
  source: string
  eventID: string | null
  sourceOccurrence: string
}) {
  const identity = value.messageID ?? `${value.source}:${value.eventID ?? "unknown"}`
  return `${value.sessionID}\u0000${identity}\u0000${routeKey(value.route, value.sourceOccurrence)}`
}

function addRouteSource(
  map: Map<string, AccountingStepRoute>,
  value: {
    attemptID: string | null
    sessionID: string
    messageID: string | null
    route: AccountingRoute
    source: string
    sourceType: string
    observedAt: number | null
    recordedAt: number | null
    eventID: string | null
    factID?: string | null
    observationIndex?: number | null
    sourceOccurrence?: string
  },
) {
  const sourceOccurrence = value.sourceOccurrence ?? routeSourceOccurrence(value)
  const key = routeSourceKey({ ...value, sourceOccurrence })
  const existing = map.get(key)
  const source: AccountingRouteSource = {
    attemptID: value.attemptID,
    source: value.source,
    sourceType: value.sourceType,
    observedAt: value.observedAt,
    recordedAt: value.recordedAt,
    eventID: value.eventID,
  }
  if (!existing) {
    map.set(key, {
      sessionID: value.sessionID,
      messageID: value.messageID,
      route: value.route,
      sourceOccurrence,
      sources: [source],
    })
    return
  }
  if (
    !existing.sources.some(
      (item) =>
        item.attemptID === source.attemptID &&
        item.source === source.source &&
        item.sourceType === source.sourceType &&
        item.eventID === source.eventID &&
        item.observedAt === source.observedAt,
    )
  )
    existing.sources.push(source)
}

function parseObservedProgressRoutes(values: readonly unknown[], progress: ProgressUsageFact[]) {
  const byID = new Map(progress.map((fact) => [fact.id, fact]))
  const routes = new Map<string, AccountingStepRoute>()
  for (const value of values) {
    const fact = object(value)
    const routeFact = route(fact?.route)
    const record = byID.get(text(fact?.id) ?? "")
    if (!record || record.kind !== "worker-step") continue
    const observations = Array.isArray(fact?.observations) ? fact.observations : []
    const routedObservations = observations.flatMap((raw, observationIndex) => {
      const observation = object(raw)
      const observedRoute = route(observation?.route)
      if (!observedRoute) return []
      return [
        {
          attemptID: record.attemptID || null,
          sessionID: record.sessionID,
          messageID: text(observation?.messageID) ?? record.messageID,
          route: observedRoute,
          source: text(observation?.source) ?? "runner-progress-store",
          sourceType: text(observation?.eventType) ?? "worker-progress-step.route",
          observedAt: epoch(observation?.at) ?? record.at,
          recordedAt: record.recordedAt,
          eventID: text(observation?.eventID),
          factID: record.id,
          observationIndex,
        },
      ]
    })
    if (routedObservations.length) {
      for (const observation of routedObservations) addRouteSource(routes, observation)
    } else {
      if (!routeFact) continue
      const sourceTypes = record.sources.length ? record.sources : [record.source]
      addRouteSource(routes, {
        attemptID: record.attemptID || null,
        sessionID: record.sessionID,
        messageID: record.messageID,
        route: routeFact,
        source: "runner-progress-store",
        sourceType: sourceTypes.join("+"),
        observedAt: record.at,
        recordedAt: record.recordedAt,
        eventID: record.eventIDs[0] ?? null,
        factID: record.id,
        observationIndex: null,
      })
    }
  }
  return [...routes.values()].sort(
    (left, right) =>
      left.sessionID.localeCompare(right.sessionID) ||
      (left.messageID ?? "").localeCompare(right.messageID ?? "") ||
      routeKey(left.route, left.sourceOccurrence).localeCompare(
        routeKey(right.route, right.sourceOccurrence),
      ),
  )
}

type SessionRouteObservation = {
  sessionID: string
  attemptIDs: string[]
  route: AccountingRoute
  sourceOccurrence: string
  source: string
  sourceType: string
  observedAt: number | null
}

/** The routes one session contributes, from its attempts and its digest, each list sorted. */
type SessionRoutePieces = {
  sessionRoutes: SessionRouteObservation[]
  /** The merged step routes, when the digest kept them. */
  stepRoutes?: AccountingStepRoute[]
  stepRouteCount: number
}

function sortedSessionRoutes(routes: Map<string, SessionRouteObservation>) {
  return [...routes.values()].sort(
    (left, right) =>
      left.sessionID.localeCompare(right.sessionID) ||
      routeKey(left.route, left.sourceOccurrence).localeCompare(
        routeKey(right.route, right.sourceOccurrence),
      ),
  )
}

function sessionRoutePieces(
  attempts: AccountingAttempt[],
  digest: AccountingFactDigest,
): SessionRoutePieces {
  const sessionRoutes = new Map<string, SessionRouteObservation>()
  for (const attempt of attempts) {
    if (attempt.sessionStatus !== "available" || !attempt.currentRoute) continue
    const sourceOccurrence = JSON.stringify(["session-model", attempt.sessionID])
    const key = `${attempt.sessionID}\u0000${routeKey(attempt.currentRoute, sourceOccurrence)}`
    const existing = sessionRoutes.get(key)
    if (existing) {
      if (!existing.attemptIDs.includes(attempt.id)) existing.attemptIDs.push(attempt.id)
    } else {
      sessionRoutes.set(key, {
        sessionID: attempt.sessionID,
        attemptIDs: [attempt.id],
        route: attempt.currentRoute,
        sourceOccurrence,
        source: "native-session",
        sourceType: "session.model",
        observedAt: attempt.currentRouteObservedAt,
      })
    }
  }
  const stepRoutes = new Map<string, AccountingStepRoute>()
  for (const attempt of attempts)
    for (const observed of attempt.stepRoutes)
      addRouteSource(stepRoutes, {
        attemptID: attempts.length === 1 ? attempt.id : null,
        sessionID: attempt.sessionID,
        messageID: observed.messageID,
        route: observed.route,
        source: "native-session-context",
        sourceType: "session-message.assistant.model",
        observedAt: observed.observedAt,
        recordedAt: null,
        eventID: null,
      })
  for (const observed of digest.stepRoutes ?? [])
    for (const source of observed.sources)
      addRouteSource(stepRoutes, {
        sessionID: observed.sessionID,
        messageID: observed.messageID,
        route: observed.route,
        ...source,
        sourceOccurrence: observed.sourceOccurrence,
      })
  if (!digest.stepRoutes)
    return {
      sessionRoutes: sortedSessionRoutes(sessionRoutes),
      stepRouteCount: new Set([...digest.stepRouteKeys, ...stepRoutes.keys()]).size,
    }
  return {
    sessionRoutes: sortedSessionRoutes(sessionRoutes),
    stepRouteCount: stepRoutes.size,
    stepRoutes: [...stepRoutes.values()].sort(
      (left, right) =>
        left.sessionID.localeCompare(right.sessionID) ||
        (left.messageID ?? "").localeCompare(right.messageID ?? "") ||
        routeKey(left.route, left.sourceOccurrence).localeCompare(
          routeKey(right.route, right.sourceOccurrence),
        ),
    ),
  }
}

/** A digest of a cached session carries a memo of what is derived from it and the attempts. */
export type MemoizedAccountingDigest = AccountingFactDigest & { memo?: Map<string, unknown> }

/** Derived results are shared between reads, so only cached digests (which carry a memo) memoize. */
export function memoizedOnDigest<T>(
  digest: { memo?: Map<string, unknown> } | undefined,
  key: string,
  compute: () => T,
): T {
  const memo = digest?.memo
  if (!memo) return compute()
  if (memo.has(key)) return memo.get(key) as T
  // A session's attempts rarely vary; a different filter adds a key, so keep a few.
  if (memo.size >= 8) memo.clear()
  const value = compute()
  memo.set(key, value)
  return value
}

/** Identifies the attempts of one session for memo keys. */
export const attemptsKey = (attempts: readonly AccountingAttempt[]) =>
  Bun.hash(JSON.stringify(attempts)).toString(36)

/** The usage and routes of one session as selected by `attempts`, memoized per digest. */
function sessionDerived(
  sessionID: string,
  attempts: AccountingAttempt[],
  digest: MemoizedAccountingDigest | undefined,
) {
  const facts = digest ?? EMPTY_DIGEST
  const compute = () => ({
    usage: attempts.length ? sessionUsage(sessionID, attempts, facts) : null,
    routes: sessionRoutePieces(attempts, facts),
  })
  return digest?.memo
    ? memoizedOnDigest(digest, `effort:${attemptsKey(attempts)}`, compute)
    : compute()
}

type EffortFactDigests = ReadonlyMap<string, { accounting: MemoizedAccountingDigest }>

type EffortInput = {
  attempts: AccountingAttempt[]
  /** Raw facts, or the per-session digests of an incremental read. */
  progressFacts: readonly unknown[] | EffortFactDigests
  progressTruncated: boolean
  truncatedContextSessionIDs: readonly string[]
}

/** Everything about the sessions and routes; `full` also lists every observed step route. */
function composeEffort(input: EffortInput, full: boolean) {
  const digests = Array.isArray(input.progressFacts)
    ? accountingDigestsOf(input.progressFacts as readonly unknown[])
    : (input.progressFacts as EffortFactDigests)
  const bySession = new Map<string, AccountingAttempt[]>()
  for (const attempt of input.attempts) {
    const group = bySession.get(attempt.sessionID) ?? []
    group.push(attempt)
    bySession.set(attempt.sessionID, group)
  }
  const attemptSessionIDs = [...bySession.keys()].sort((left, right) => left.localeCompare(right))
  const derived = new Map(
    attemptSessionIDs.map((sessionID) => [
      sessionID,
      sessionDerived(sessionID, bySession.get(sessionID)!, digests.get(sessionID)?.accounting),
    ]),
  )
  const sessions = attemptSessionIDs.map((sessionID) => derived.get(sessionID)!.usage!)
  const sessionRoutes = attemptSessionIDs.flatMap(
    (sessionID) => derived.get(sessionID)!.routes.sessionRoutes,
  )
  // Sessions only the facts know about still count toward the observed step routes.
  const stepSessionIDs = [...new Set([...attemptSessionIDs, ...digests.keys()])].sort(
    (left, right) => left.localeCompare(right),
  )
  const stepPieces = (sessionID: string) =>
    (derived.get(sessionID) ?? sessionDerived(sessionID, [], digests.get(sessionID)?.accounting))
      .routes
  const stepRoutesBySession = new Map<string, AccountingStepRoute[]>()
  if (full)
    for (const sessionID of stepSessionIDs) {
      const routes = stepPieces(sessionID).stepRoutes
      if (!routes) throw new Error("A full effort basis needs digests that keep step routes")
      stepRoutesBySession.set(sessionID, routes)
    }
  const sessionsWithCurrentRoute = new Set(sessionRoutes.map((item) => item.sessionID))
  const uniqueSessionAttempts = [...bySession.values()].flatMap((attempts) =>
    attempts.length ? [attempts[0]!] : [],
  )
  const contextCounts = {
    available: uniqueSessionAttempts.filter((attempt) => attempt.contextStatus === "available")
      .length,
    notRead: uniqueSessionAttempts.filter((attempt) => attempt.contextStatus === "not-read").length,
    unavailable: uniqueSessionAttempts.filter((attempt) => attempt.contextStatus === "unavailable")
      .length,
  }
  const missingSessionIDs = sessions
    .filter((session) => session.sessionStatus === "missing")
    .map((session) => session.sessionID)
  const unavailableSessionIDs = sessions
    .filter((session) => session.sessionStatus === "unavailable")
    .map((session) => session.sessionID)
  const usageCoverage = {
    totalUniqueSessions: sessions.length,
    nativeCumulativeSnapshots: sessions.filter(
      (session) => session.selectedBasis === "native-session-cumulative-snapshot",
    ).length,
    retainedCumulativeSnapshots: sessions.filter(
      (session) => session.selectedBasis === "retained-progress-cumulative-snapshot",
    ).length,
    additiveStepSubtotals: sessions.filter(
      (session) => session.selectedBasis === "retained-progress-additive-steps",
    ).length,
    missingSessions: missingSessionIDs,
    unavailableSessions: unavailableSessionIDs,
    progressTruncated: input.progressTruncated,
  }
  const routeCoverage = {
    totalUniqueSessions: sessions.length,
    observedSessionRouteCount: sessionRoutes.length,
    sessionsWithoutCurrentRoute: sessions
      .filter((session) => !sessionsWithCurrentRoute.has(session.sessionID))
      .map((session) => session.sessionID),
    observedStepRouteCount: stepSessionIDs.reduce(
      (total, sessionID) => total + stepPieces(sessionID).stepRouteCount,
      0,
    ),
    stepContextsByStatus: contextCounts,
    stepRouteCoverage:
      "Observed retained native context and progress only; complete call history is not guaranteed.",
    progressTruncated: input.progressTruncated,
    truncatedContextSessionIDs: [...new Set(input.truncatedContextSessionIDs)].toSorted(),
    missingSessionIDs,
    unavailableSessionIDs,
  }
  return {
    bySession,
    sessions,
    sessionRoutes,
    stepRoutesBySession,
    stepSessionIDs,
    usageCoverage,
    routeCoverage,
  }
}

/** The part of the effort basis a decision valuation reads. */
export type EffortUsageBasis = {
  usage: {
    categories: Record<UsageCategory, ReturnType<typeof aggregateCore>>
    sessions: SessionUsage[]
    coverage: ReturnType<typeof composeEffort>["usageCoverage"]
  }
  routes: { coverage: ReturnType<typeof composeEffort>["routeCoverage"] }
}

/**
 * Usage and route coverage of the sessions of `attempts`, composed from per-session pieces. It
 * returns what `projectTaskEffortBasis` returns for `usage.categories`, `usage.sessions`,
 * `usage.coverage` and `routes.coverage`, without building the lists that grow with every call.
 */
export function projectTaskEffortUsage(input: EffortInput): EffortUsageBasis {
  const composed = composeEffort(input, false)
  return {
    usage: {
      categories: Object.fromEntries(
        CATEGORIES.map((category) => [category, aggregateCore(category, composed.sessions)]),
      ) as Record<UsageCategory, ReturnType<typeof aggregateCore>>,
      sessions: composed.sessions,
      coverage: composed.usageCoverage,
    },
    routes: { coverage: composed.routeCoverage },
  }
}

/** Versioned, read-only task-wide accounting from frozen attempts and retained observations. */
export function projectTaskEffortBasis(input: EffortInput) {
  const composed = composeEffort(input, true)
  const { bySession, sessions } = composed
  const categories = Object.fromEntries(
    CATEGORIES.map((category) => [category, aggregateCategory(category, sessions)]),
  ) as Record<UsageCategory, ReturnType<typeof aggregateCategory>>
  const observedSessionRoutes = composed.sessionRoutes
  const observedStepRoutes = composed.stepSessionIDs.flatMap((sessionID) =>
    composed.stepRoutesBySession.get(sessionID)!,
  )

  const sessionRoutesByID = new Map<string, typeof observedSessionRoutes>()
  for (const observation of observedSessionRoutes) {
    const group = sessionRoutesByID.get(observation.sessionID) ?? []
    group.push(observation)
    sessionRoutesByID.set(observation.sessionID, group)
  }
  const stepRoutesByID = composed.stepRoutesBySession

  const routeAssessments = input.attempts.flatMap((attempt) => {
    const requestedRoute =
      attempt.planRouteStatus === "explicit" ? attempt.planRoute : attempt.frozenRoute
    const requestedRouteSource =
      attempt.planRouteStatus === "explicit"
        ? "runner_plans.body.workerModel"
        : attempt.frozenRouteSource
    const observations = [
      ...(bySession.get(attempt.sessionID)?.length === 1
        ? (sessionRoutesByID.get(attempt.sessionID) ?? [])
        : []
      ).map((item) => ({
        scope: "session" as const,
        route: item.route,
        source: item.source,
        sourceType: item.sourceType,
        observedAt: item.observedAt,
        messageID: null,
      })),
      ...(stepRoutesByID.get(attempt.sessionID) ?? [])
        .filter((item) => {
          const owners = new Set(
            item.sources.flatMap((source) => (source.attemptID ? [source.attemptID] : [])),
          )
          return owners.size === 1 && owners.has(attempt.id)
        })
        .map((item) => ({
          scope: "step" as const,
          route: item.route,
          source: item.sources.map((source) => source.source).join("+"),
          sourceType: item.sources.map((source) => source.sourceType).join("+"),
          observedAt: item.sources.reduce<number | null>(
            (latest, source) =>
              source.observedAt === null
                ? latest
                : latest === null
                  ? source.observedAt
                  : Math.max(latest, source.observedAt),
            null,
          ),
          messageID: item.messageID,
        })),
    ]
    return observations.map((observation) => ({
      attemptID: attempt.id,
      sessionID: attempt.sessionID,
      requestedRoute: routeView(requestedRoute),
      requestedRouteSource,
      observedRoute: routeView(observation.route),
      scope: observation.scope,
      messageID: observation.messageID,
      source: observation.source,
      sourceType: observation.sourceType,
      observedAt: observation.observedAt,
      status: routeComparison(requestedRoute, observation.route),
      frozenRouteStatus: routeComparison(attempt.frozenRoute, observation.route),
    }))
  })

  const distinctObservedRoutes = distinctRoutes([
    ...observedSessionRoutes.map((item) => ({
      route: item.route,
      sourceOccurrence: item.sourceOccurrence,
    })),
    ...observedStepRoutes.map((item) => ({
      route: item.route,
      sourceOccurrence: item.sourceOccurrence,
    })),
  ])
  const distinctFrozenRoutes = distinctRoutes(
    input.attempts.flatMap((attempt) =>
      attempt.frozenRoute
        ? [
            {
              route: attempt.frozenRoute,
              sourceOccurrence: JSON.stringify(["attempt-frozen-route", attempt.id]),
            },
          ]
        : [],
    ),
  )
  const distinctRequestedRoutes = distinctRoutes(
    input.attempts.flatMap((attempt) => {
      const requested =
        attempt.planRouteStatus === "explicit" ? attempt.planRoute : attempt.frozenRoute
      return requested
        ? [
            {
              route: requested,
              sourceOccurrence: JSON.stringify([
                attempt.planRouteStatus === "explicit"
                  ? "attempt-plan-route"
                  : "attempt-frozen-route",
                attempt.id,
              ]),
            },
          ]
        : []
    }),
  )
  const recordedCosts = input.attempts.flatMap((attempt) =>
    attempt.recordedCostUSD === null
      ? []
      : [{ attemptID: attempt.id, valueUSD: attempt.recordedCostUSD }],
  )
  const missingCostAttemptIDs = input.attempts
    .filter((attempt) => attempt.recordedCostUSD === null)
    .map((attempt) => attempt.id)
  const quality = {
    status: "not-recorded",
    value: null,
    meaning: "No quality score or task-class value is inferred by trajectory accounting",
  }

  return {
    schemaVersion: 1,
    basis: "session-deduplicated-observed-worker-usage-and-routes",
    attempts: {
      count: input.attempts.length,
      ids: input.attempts.map((attempt) => attempt.id),
      states: input.attempts.map((attempt) => ({ attemptID: attempt.id, state: attempt.state })),
      legacyTokenScalars: input.attempts.map((attempt) => ({
        attemptID: attempt.id,
        value: attempt.legacyTokenCount,
        unit: "tokens",
        source: "runner_attempt.token_count",
        sourceType: "legacy attempt aggregate",
        observedAt: null,
        status: attempt.legacyTokenCount === null ? "missing" : "retained-not-added",
        addedToCategorizedUsage: false,
      })),
    },
    usage: {
      unit: "tokens",
      deduplication:
        "One selected contribution per unique worker session; attempts sharing a session do not multiply usage",
      selection: [
        "Use the current native session cumulative token snapshot when present, even when individual categories are missing.",
        "Otherwise use the deterministically latest retained cumulative progress snapshot; do not fill missing categories from other snapshots.",
        "Only when no cumulative snapshot exists, expose retained additive steps as a partial subtotal.",
        "Legacy runner_attempt.token_count values remain visible per attempt and are never added to categorized totals.",
      ],
      categories,
      sessions,
      coverage: composed.usageCoverage,
    },
    routes: {
      assignments: input.attempts.map((attempt) => ({
        attemptID: attempt.id,
        sessionID: attempt.sessionID,
        state: attempt.state,
        planSelection: {
          route: routeView(attempt.planRoute),
          status: attempt.planRouteStatus,
          frozenComparison:
            attempt.planRouteStatus === "explicit"
              ? attempt.frozenRoute
                ? routeComparison(attempt.planRoute, attempt.frozenRoute)
                : "unavailable"
              : attempt.planRouteStatus,
          source: "runner_plans.body.workerModel",
          meaning:
            attempt.planRouteStatus === "explicit"
              ? "Exact route explicitly selected in the immutable plan"
              : attempt.planRouteStatus === "inherited"
                ? "No explicit plan route; native implementor route was resolved at admission"
                : "Plan route selection could not be recovered",
        },
        frozenAttemptRoute: {
          route: routeView(attempt.frozenRoute),
          status: attempt.frozenRoute ? "recorded" : "unavailable",
          source: attempt.frozenRouteSource,
          selectionSource:
            attempt.planRouteStatus === "explicit"
              ? "explicit-plan-selection"
              : attempt.frozenRoute
                ? "native-agent-selection"
                : "unknown",
        },
        persona: {
          requested: attempt.personaRequested,
          requestedStatus: attempt.personaRequested ? "assigned" : "not-assigned",
          requestedSource: "runner_plans.body.nodes[].persona",
          frozen: attempt.personaFrozen,
          frozenStatus: attempt.personaFrozen
            ? "recorded"
            : attempt.personaRequested
              ? "unavailable"
              : "not-assigned",
          frozenSource: attempt.personaFrozen ? "runner_attempt.policy.persona" : null,
          comparison:
            attempt.personaRequested === null
              ? "not-assigned"
              : attempt.personaFrozen === null
                ? "unavailable"
                : attempt.personaRequested === attempt.personaFrozen
                  ? "match"
                  : "mismatch",
        },
      })),
      distinctRequestedRoutes: distinctRequestedRoutes.map(({ route }) => routeView(route)),
      distinctFrozenRoutes: distinctFrozenRoutes.map(({ route }) => routeView(route)),
      observedSessionRoutes: observedSessionRoutes.map((item) => ({
        sessionID: item.sessionID,
        attemptIDs: item.attemptIDs,
        route: routeView(item.route),
        source: item.source,
        sourceType: item.sourceType,
        observedAt: item.observedAt,
      })),
      observedStepRoutes: observedStepRoutes.map((item) => ({
        sessionID: item.sessionID,
        messageID: item.messageID,
        route: routeView(item.route),
        sources: item.sources,
      })),
      distinctObservedRoutes: distinctObservedRoutes.map(({ route }) => routeView(route)),
      mixedRoutes: distinctObservedRoutes.length > 1,
      assessments: routeAssessments,
      mismatches: routeAssessments.filter(
        (item) => item.status === "mismatch" || item.frozenRouteStatus === "mismatch",
      ),
      usageAttribution:
        distinctObservedRoutes.length > 1
          ? "Mixed observed routes; task-wide usage and outcome are not attributed to the final model or split by model."
          : distinctObservedRoutes.length === 1
            ? "One observed route does not split cumulative session usage by call; task-wide usage remains session-aggregate."
            : "Observed route coverage is unavailable; no model attribution is made.",
      coverage: composed.routeCoverage,
    },
    cost: {
      recordedWorkerAttemptSubtotalUSD: {
        valueUSD: recordedCosts.length
          ? recordedCosts.reduce((total, item) => total + item.valueUSD, 0)
          : null,
        status:
          recordedCosts.length === 0
            ? "missing"
            : missingCostAttemptIDs.length
              ? "partial"
              : "worker-attempt-only",
        source: "runner_attempt.cost",
        observedAttempts: recordedCosts,
        missingAttemptIDs: missingCostAttemptIDs,
      },
      fullTaskCostUSD: {
        valueUSD: null,
        status: "unknown",
        meaning: "Worker-attempt scalar costs do not cover a complete task cost basis",
      },
      marketEquivalentCostUSD: {
        valueUSD: null,
        status: "unknown",
        meaning: "No dated price or complete route/category pricing basis is available",
      },
      architectReviewIntegrationOverheadUSD: {
        valueUSD: null,
        status: "unallocated",
        components: ["Architect", "review", "integration"],
      },
    },
    quality,
  }
}
