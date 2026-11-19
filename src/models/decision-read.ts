import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import type {
  ModelDecisionConfiguration,
  ModelDecisionConfigurations,
  ModelDecisionConfigurationsInput,
  ModelDecisionContext,
  ModelDecisionContributor,
  ModelDecisionEstimate,
  ModelDecisionInspect,
  ModelDecisionInspectInput,
  ModelDecisionOverview,
  ModelDecisionReadInput,
  ModelDecisionReader,
  ModelDecisionRows,
  ModelDecisionRowsInput,
  ModelDecisionRoute,
  ModelDecisionRow,
} from "./decision-contract.ts"
import {
  MODELS_DECISION_ACCOUNTING_BASIS,
  MODELS_DECISION_TASK_KIND_CATALOG,
  MODELS_DECISION_TASK_KINDS,
  ModelDecisionConfigurationsInputSchema,
  ModelDecisionConfigurationsOutputSchema,
  ModelDecisionInspectInputSchema,
  ModelDecisionInspectOutputSchema,
  ModelDecisionOverviewOutputSchema,
  ModelDecisionReadInputSchema,
  ModelDecisionRowsInputSchema,
  ModelDecisionRowsOutputSchema,
} from "./decision-contract.ts"
import type { CurrentPriceApplicability } from "./current-price-index.ts"
import type { CurrentPriceIndex, CurrentPricePin, TaskValuation } from "./valuation-schema.ts"
import type { ModelPriceSourceSettings } from "./price-source-settings.ts"
import type { EndpointPricingRead } from "./endpoint-pricing.ts"
import { calculateConfiguredKnownUsageMarket, calculateKnownUsageMarket } from "./market-range.ts"
import type { KnownUsageMarket, KnownUsageMarketSession } from "./market-range.ts"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import { projectTaskEffortBasis } from "../trajectory/accounting.ts"
import type {
  ObservationLedgerDecisionCapture,
  ObservationLedgerDecisionRead,
  ObservationLedgerDecisionTask,
  ReadOnlyObservationLedger,
} from "./observation-ledger-read.ts"
import { projectTaskValuation, taskValuationPerCallUsage } from "./valuation.ts"
import { calculateModelDecisionReferenceEstimate } from "./reference-estimate.ts"
import type { ReferenceEstimateSession } from "./reference-estimate.ts"
import {
  modelConfigurationID,
  modelIdentityReference,
  resolveModelIdentity,
} from "./model-identity.ts"

const MAX_SNAPSHOTS = 4
const MAX_CURSOR_BYTES = 8192
const CATEGORIES = ["uncachedInput", "output", "reasoning", "cacheRead", "cacheWrite"] as const

export type ModelDecisionLedgerReader = Pick<
  ReadOnlyObservationLedger,
  "close" | "decisionRevision" | "readDecision"
>

export type ModelDecisionPriceState = {
  settings: ModelPriceSourceSettings
  index: CurrentPriceIndex
  endpointPricing?: EndpointPricingRead
  identityCatalogSource?: ModelEvidenceComparisonSourceRead
  identityNativeSource?: ModelEvidenceComparisonSourceRead
  sources?: readonly ModelEvidenceComparisonSourceRead[]
  freshness: "current" | "stale" | "unknown"
  note?: string
}

export type ModelDecisionReaderDependencies = {
  projectDirectory: string
  openLedger(): ModelDecisionLedgerReader
  readPriceState(
    routes: readonly CurrentPriceApplicability[],
    signal?: AbortSignal,
  ): Promise<ModelDecisionPriceState>
}

function readCurrentDecisionRevision(dependencies: ModelDecisionReaderDependencies) {
  const ledger = dependencies.openLedger()
  try {
    return ledger.decisionRevision()
  } finally {
    ledger.close()
  }
}

type CursorPayload = {
  version: 1
  kind: "rows" | "configurations" | "contributors"
  snapshotID: string
  offset: number
  limit: number
  configurationID?: string
  selectedTaskID?: string | null
  inputFingerprint: string
}

type SessionData = {
  sessionID: string
  attemptIDs: string[]
  attempts: ObservationLedgerDecisionCapture["tasks"][number]["attempts"]
  attemptsByTask: Map<string, ObservationLedgerDecisionCapture["tasks"][number]["attempts"]>
  taskIDs: string[]
  selectedTaskIDs: string[]
  route: ModelDecisionRoute | null
  routeKey: string | null
  tokens: number | null
  tokensComplete: boolean
  marketUSD: number | null
  marketComplete: boolean
  routeStatus: KnownUsageMarketSession["routeStatus"]
  usageCategories: KnownUsageMarketSession["categories"]
  nativeUSD: number | null
  nativeComplete: boolean
  nativeUnmetered: boolean
  observedAt: number | null
  shared: boolean
}

type AcceptedHistory = {
  tokens: number | null
  currentMarketUSD: number | null
  tokensComplete: boolean
  marketComplete: boolean
  shared: boolean
  routeScope: "same-route" | "cross-route" | "unknown"
  routeKeys: Set<string>
  sessions: SessionData[]
}

type DecisionSnapshot = {
  context: ModelDecisionContext
  sourceRevision: number | null
  routes: CurrentPriceApplicability[]
  priceState: ModelDecisionPriceState
  inputFingerprint: string
  rows: ModelDecisionRow[]
  configurations: ModelDecisionConfiguration[]
  graph: ModelDecisionOverview["graph"]
  contributors: Map<string, ModelDecisionContributor[]>
  estimates: Map<string, ModelDecisionEstimate>
  /** Median first-attempt-to-acceptance time of a cohort's accepted tasks; absent without records. */
  medianAcceptedDurationMs: Map<string, number>
  knownUsageMarkets: Map<string, KnownUsageMarket>
}

type SnapshotEntry = {
  snapshot: DecisionSnapshot
  filterKey: string
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .flatMap((key) =>
        record[key] === undefined ? [] : [`${JSON.stringify(key)}:${stable(record[key])}`],
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function endpointPricingIdentity(endpointPricing: EndpointPricingRead | undefined) {
  if (!endpointPricing) return null
  return {
    state: endpointPricing.state,
    generation: endpointPricing.generation,
    complete: endpointPricing.complete,
    scenarios: endpointPricing.scenarios.map((scenario) => ({
      productID: scenario.productID,
      state: scenario.state,
      generation: scenario.generation,
      latestSnapshotID: scenario.latestSnapshotID,
      latestRetrievedAt: scenario.latestRetrievedAt,
      latestRecordCount: scenario.latestRecordCount,
      errorCode: scenario.errorCode,
      httpStatus: scenario.httpStatus,
      snapshotGeneration: scenario.snapshot?.generation ?? null,
    })),
  }
}

function modelIdentitySourceIdentity(source: ModelEvidenceComparisonSourceRead | undefined) {
  if (!source) return null
  return {
    source: source.source,
    storage: source.storage,
    snapshotState: source.snapshotState,
    snapshotID: source.snapshotID,
    snapshotGeneration: source.snapshot?.generation ?? null,
    refresh: source.refresh,
  }
}

function fingerprint(value: unknown) {
  return createHmac("sha256", "lazers-model-decision-fingerprint-v1")
    .update(stable(value))
    .digest("hex")
}

function exactRoute(
  route:
    | {
        providerID: string
        modelID: string
        variant: string | null
        identity?: { providerID: string; modelID: string; variant: string | null } | null
      }
    | null
    | undefined,
): ModelDecisionRoute | null {
  if (!route || route.identity === null) return null
  const values = [route.providerID, route.modelID, route.variant]
  if (
    values.some(
      (value) =>
        typeof value === "string" &&
        (value.length === 0 ||
          value.length > 512 ||
          value.includes("[REDACTED]") ||
          value.endsWith("…[truncated]")),
    )
  )
    return null
  return {
    providerID: route.providerID,
    modelID: route.modelID,
    variant: route.variant,
  }
}

function routeID(route: ModelDecisionRoute | null) {
  return route ? modelConfigurationID(route.providerID, route.modelID, route.variant) : null
}

function collectRoutes(
  capture: ObservationLedgerDecisionCapture,
  tasks: readonly ObservationLedgerDecisionTask[] = capture.tasks,
  usageSessions: readonly Pick<
    TaskValuation["usage"]["sessions"][number],
    "sessionID" | "categories"
  >[],
): CurrentPriceApplicability[] {
  const routes = new Map<string, ModelDecisionRoute>()
  const observedRoutesBySession = new Map<string, Set<string>>()
  const attempts = tasks.flatMap((task) => task.attempts)
  const attemptIDs = new Set(attempts.map((attempt) => attempt.accounting.id))
  const sessionIDs = new Set(attempts.map((attempt) => attempt.accounting.sessionID))
  const add = (value: unknown, sessionID?: string) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return
    const item = value as Record<string, unknown>
    const routeValue =
      typeof item.routeEvidence === "object" && item.routeEvidence !== null
        ? (item.routeEvidence as Record<string, unknown>).status === "observed"
          ? (item.routeEvidence as Record<string, unknown>).route
          : null
        : item.route
    if (typeof routeValue !== "object" || routeValue === null || Array.isArray(routeValue)) return
    const raw = routeValue as Record<string, unknown>
    if (
      typeof raw.providerID !== "string" ||
      typeof (raw.modelID ?? raw.id) !== "string" ||
      (raw.variant !== null && raw.variant !== undefined && typeof raw.variant !== "string")
    )
      return
    const route = exactRoute({
      providerID: raw.providerID,
      modelID: (raw.modelID ?? raw.id) as string,
      variant: typeof raw.variant === "string" ? raw.variant : null,
    })
    if (!route) return
    const id = routeID(route)!
    routes.set(id, route)
    if (sessionID) {
      const sessionRoutes = observedRoutesBySession.get(sessionID) ?? new Set<string>()
      sessionRoutes.add(id)
      observedRoutesBySession.set(sessionID, sessionRoutes)
    }
  }
  for (const attempt of attempts) {
    add({ route: attempt.accounting.planRoute })
    add({ route: attempt.accounting.frozenRoute })
  }
  for (const fact of capture.progressFacts) {
    const progress = fact as Record<string, unknown>
    if (
      !attemptIDs.has(String(progress.attemptID ?? "")) &&
      !sessionIDs.has(String(progress.sessionID ?? ""))
    )
      continue
    const sessionID = typeof progress.sessionID === "string" ? progress.sessionID : undefined
    add(fact, sessionID)
    const observations = (fact as Record<string, unknown>).observations
    if (Array.isArray(observations))
      for (const observation of observations) add(observation, sessionID)
  }
  const usageBySession = new Map(usageSessions.map((session) => [session.sessionID, session]))
  const observedSessionsByRoute = new Map<string, Set<string>>()
  for (const [sessionID, sessionRoutes] of observedRoutesBySession)
    for (const id of sessionRoutes) {
      const sessions = observedSessionsByRoute.get(id) ?? new Set<string>()
      sessions.add(sessionID)
      observedSessionsByRoute.set(id, sessions)
    }
  const applicability: CurrentPriceApplicability[] = []
  for (const [id, route] of routes) {
    const sessions = [...(observedSessionsByRoute.get(id) ?? [])].sort((left, right) =>
      left.localeCompare(right),
    )
    if (!sessions.length) {
      applicability.push({ route })
      continue
    }
    for (const sessionID of sessions) {
      const usageSession = usageBySession.get(sessionID)
      const soleObservedRoute = observedRoutesBySession.get(sessionID)?.size === 1
      // Session totals only support route-level applicability when the retained route is exact
      // and singular. Tier/context selectors are never inferred from aggregate token counts.
      const usage =
        soleObservedRoute && usageSession
          ? Object.fromEntries(
              CATEGORIES.map((category) => {
                const measure = usageSession.categories[category]
                return [category, { value: measure.value, status: measure.status }]
              }),
            )
          : undefined
      applicability.push({ route, ...(usage ? { usage } : {}) })
    }
  }
  return applicability.sort(
    (left, right) =>
      routeID(left.route)!.localeCompare(routeID(right.route)!) ||
      stable(left).localeCompare(stable(right)),
  )
}

function categoryTokenValue(session: TaskValuation["usage"]["sessions"][number]) {
  let total = 0
  let observed = false
  let complete = true
  for (const category of CATEGORIES) {
    const measurement = session.categories[category]
    if (measurement.value !== null) {
      total += measurement.value
      observed = true
    }
    if (measurement.status !== "observed") complete = false
  }
  return {
    value: observed && Number.isFinite(total) ? total : null,
    complete,
  }
}

function routeOfMarketSession(session: TaskValuation["marketEquivalentCost"]["sessions"][number]) {
  return session.routeAllocation.status === "single-observed-route"
    ? exactRoute(session.routeAllocation.route)
    : null
}

const unavailableIdentityCatalogSource: ModelEvidenceComparisonSourceRead = {
  source: "openrouter-models",
  storage: "missing-both-tables",
  snapshotState: "none",
  snapshotID: null,
  refresh: null,
  snapshot: null,
}

function resolveMarketIdentity(route: ModelDecisionRoute, priceState: ModelDecisionPriceState) {
  const nativeSource = priceState.identityNativeSource
  const nativeSnapshot =
    nativeSource?.snapshot?.source === "native-catalog" ? nativeSource.snapshot : null
  const nativeEvidence = nativeSnapshot
    ? nativeSnapshot.records.flatMap((record, recordIndex) =>
        record.providerID === route.providerID && record.id === route.modelID
          ? [modelIdentityReference("native-catalog", nativeSnapshot, recordIndex, record.id)]
          : [],
      )
    : []
  return resolveModelIdentity({
    route: { providerID: route.providerID, modelID: route.modelID },
    nativeEvidence,
    catalogSource: priceState.identityCatalogSource ?? unavailableIdentityCatalogSource,
  }).resolution
}

function decimalParts(value: number) {
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e")
  const exponent = exponentText ? Number(exponentText) : 0
  const decimalIndex = mantissa!.indexOf(".")
  const fractionalDigits = decimalIndex < 0 ? 0 : mantissa!.length - decimalIndex - 1
  const digits = mantissa!.replace(".", "")
  let coefficient = BigInt(digits)
  let scale = fractionalDigits - exponent
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale)
    scale = 0
  }
  return { coefficient, scale }
}

function sumValues(values: Array<number | null>) {
  const present = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  )
  if (!present.length) return null
  const parts = present.map(decimalParts)
  const scale = Math.max(...parts.map((part) => part.scale))
  const coefficient = parts.reduce(
    (total, part) => total + part.coefficient * 10n ** BigInt(scale - part.scale),
    0n,
  )
  const digits = coefficient.toString().padStart(scale + 1, "0")
  const exact = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
  const output = Number(exact)
  return Number.isFinite(output) ? output : null
}

function taskByID(capture: ObservationLedgerDecisionCapture) {
  return new Map(capture.tasks.map((task) => [task.taskID, task]))
}

function taskSessions(
  tasks: readonly ObservationLedgerDecisionTask[],
  bySession: Map<string, SessionData>,
) {
  const output = new Map<string, SessionData[]>()
  for (const task of tasks) {
    const seen = new Set<string>()
    for (const attempt of task.attempts) {
      const session = bySession.get(attempt.accounting.sessionID)
      if (!session || seen.has(session.sessionID)) continue
      seen.add(session.sessionID)
      const values = output.get(task.taskID) ?? []
      values.push(session)
      output.set(task.taskID, values)
    }
  }
  return output
}

function nativeCostIndex(valuation: TaskValuation) {
  return new Map(
    valuation.reportedWorkerCost.contributions.map((contribution) => [
      contribution.sessionID,
      contribution,
    ]),
  )
}

function buildSessionData(
  capture: ObservationLedgerDecisionCapture,
  valuation: TaskValuation,
  selectedTasks: readonly ObservationLedgerDecisionTask[],
): Map<string, SessionData> {
  const allTaskIDsBySession = new Map<string, Set<string>>()
  const attemptsBySessionAndTask = new Map<
    string,
    Map<string, ObservationLedgerDecisionTask["attempts"]>
  >()
  const selectedTaskSet = new Set(selectedTasks.map((task) => task.taskID))
  for (const task of capture.tasks)
    for (const attempt of task.attempts) {
      const sessionID = attempt.accounting.sessionID
      const owners = allTaskIDsBySession.get(sessionID) ?? new Set<string>()
      owners.add(task.taskID)
      allTaskIDsBySession.set(sessionID, owners)
      if (!selectedTaskSet.has(task.taskID)) continue
      const tasks = attemptsBySessionAndTask.get(sessionID) ?? new Map()
      const attempts = tasks.get(task.taskID) ?? []
      attempts.push(attempt)
      tasks.set(task.taskID, attempts)
      attemptsBySessionAndTask.set(sessionID, tasks)
    }

  const usageBySession = new Map(
    valuation.usage.sessions.map((session) => [session.sessionID, session]),
  )
  const marketBySession = new Map(
    valuation.marketEquivalentCost.sessions.map((session) => [session.sessionID, session]),
  )
  const nativeBySession = nativeCostIndex(valuation)
  const sessionIDs = new Set([...usageBySession.keys(), ...marketBySession.keys()])
  for (const sessionID of attemptsBySessionAndTask.keys()) sessionIDs.add(sessionID)
  const output = new Map<string, SessionData>()
  for (const sessionID of sessionIDs) {
    const usage = usageBySession.get(sessionID)
    const market = marketBySession.get(sessionID)
    const native = nativeBySession.get(sessionID)
    const tokenValue = usage ? categoryTokenValue(usage) : { value: null, complete: false }
    const route = market ? routeOfMarketSession(market) : null
    const routeStatus = market?.routeAllocation.status ?? "unavailable"
    const usageCategories = Object.fromEntries(
      CATEGORIES.map((category) => [
        category,
        {
          tokens: usage?.categories[category].value ?? null,
          status: usage?.categories[category].status ?? "missing",
        },
      ]),
    ) as KnownUsageMarketSession["categories"]
    const tasks = attemptsBySessionAndTask.get(sessionID) ?? new Map()
    const attempts = [...tasks.values()].flat()
    const nativeValue = native?.valueUSD ?? null
    const taskIDs = [...(allTaskIDsBySession.get(sessionID) ?? [])].sort()
    const attemptsByTask = new Map(tasks)
    output.set(sessionID, {
      sessionID,
      attemptIDs: [...new Set(attempts.map((attempt) => attempt.accounting.id))].sort(),
      attempts,
      attemptsByTask,
      taskIDs,
      selectedTaskIDs: [...tasks.keys()].sort(),
      route,
      routeKey: routeID(route),
      tokens: tokenValue.value,
      tokensComplete: tokenValue.complete,
      marketUSD: market?.subtotalUSD ?? null,
      marketComplete: market?.status === "observed" && market.valueUSD !== null,
      routeStatus,
      usageCategories,
      nativeUSD: nativeValue,
      nativeComplete: native?.status === "observed" && native.valueUSD !== null,
      nativeUnmetered: native?.status === "unmetered",
      observedAt: attempts.length
        ? Math.max(...attempts.map((attempt) => attempt.startedAt))
        : null,
      shared: taskIDs.length > 1,
    })
  }
  return output
}

function configurationFromRoute(
  route: ModelDecisionRoute,
  pin: CurrentPricePin | undefined,
  referenceEstimate: ModelDecisionRow["referenceEstimate"],
  policyRevision: number,
  freshness: ModelDecisionPriceState["freshness"],
): ModelDecisionConfiguration {
  const source = pin
    ? pin.provenance.source === "native-catalog"
      ? "opencode"
      : "openrouter"
    : null
  const semantics = !pin
    ? "unknown"
    : pin.semantics === "average"
      ? "observed-endpoint-average"
      : source === "opencode"
        ? "exact-native-model-quote"
        : "exact-route-quote"
  const routeIDValue = routeID(route)!
  return {
    configurationID: `configuration:${routeIDValue}`,
    groupID: `route:${routeIDValue}`,
    label:
      `${route.providerID}/${route.modelID}${route.variant ? ` · ${route.variant}` : ""}`.slice(
        0,
        512,
      ),
    route,
    referenceEstimate,
    currentPrice: {
      source,
      sourcePolicyRevision: policyRevision,
      sourceRecordID: pin?.provenance.recordID ?? null,
      snapshotID: pin?.provenance.snapshotID ?? null,
      retrievedAt: pin?.provenance.retrievedAt ?? null,
      semantics,
      freshness: pin ? (freshness === "stale" ? "stale" : "current") : "unavailable",
    },
  }
}

function sourceForPin(pin: CurrentPricePin) {
  return pin.provenance.source === "native-catalog" ? "opencode" : "openrouter"
}

function priceContext(
  state: ModelDecisionPriceState,
  sourceRevision?: number,
): ModelDecisionContext["priceIndex"] {
  type PriceSource = ModelDecisionContext["priceIndex"]["pins"][number]["source"]
  const bySource = new Map<PriceSource, Array<ModelDecisionContext["priceIndex"]["pins"][number]>>()
  for (const pin of state.index.pins) {
    const source = sourceForPin(pin)
    const values = bySource.get(source) ?? []
    values.push({
      source,
      snapshotID: pin.provenance.snapshotID,
      retrievedAt: pin.provenance.retrievedAt,
      freshness: state.freshness === "stale" ? "stale" : "current",
      semantics:
        pin.semantics === "average"
          ? "observed-endpoint-averages"
          : source === "opencode"
            ? "exact-native-model-quotes"
            : "exact-published-route-quotes",
    })
    bySource.set(source, values)
  }
  const pins = [...bySource.entries()]
    .map(([source, values]) => {
      const semantics = new Set(values.map((pin) => pin.semantics))
      return {
        source,
        snapshotID: values[0]!.snapshotID,
        retrievedAt: values[0]!.retrievedAt,
        freshness: values.some((pin) => pin.freshness === "stale")
          ? ("stale" as const)
          : ("current" as const),
        semantics: semantics.size === 1 ? values[0]!.semantics : ("mixed" as const),
      }
    })
    .sort((left, right) => left.source.localeCompare(right.source))
  const sources = new Set(pins.map((pin) => pin.source))
  const semantics = new Set(pins.map((pin) => pin.semantics))
  const source: ModelDecisionContext["priceIndex"]["source"] =
    sources.size === 0 ? "unavailable" : sources.size === 1 ? pins[0]!.source : "mixed"
  const note =
    state.note ??
    (pins.length
      ? "Current ordered-source quotes revalue retained usage; native charges remain diagnostics."
      : "No configured ordered source supplied an exact applicable quote; market values remain unknown.")
  const asOfNote =
    sourceRevision === undefined
      ? ""
      : ` This decision snapshot pins retained facts at project observation revision ${sourceRevision}; freshness is evaluated at capture time and its market values use only the listed source snapshots. Page continuations remain on this identity; new reads refresh to newer data.`
  return {
    source,
    sourcePolicyRevision: state.settings.policy.revision,
    pins,
    freshness:
      pins.length === 0
        ? "unavailable"
        : pins.some((pin) => pin.freshness === "stale")
          ? "stale"
          : "current",
    semantics:
      semantics.size === 0 ? "unknown" : semantics.size === 1 ? pins[0]!.semantics : "mixed",
    note: `${note.slice(0, Math.max(0, 2000 - asOfNote.length))}${asOfNote}`,
  }
}

function contextFor(input: {
  projectDirectory: string
  filters: ModelDecisionReadInput["filters"]
  snapshotID: string
  producedAt: string
  classification: ModelDecisionContext["classification"]
  availability: ModelDecisionContext["availability"]
  freshness: ModelDecisionContext["freshness"]
  unavailableReason: string | null
  priceState: ModelDecisionPriceState
  sourceRevision?: number
}): ModelDecisionContext {
  return {
    schemaVersion: 2,
    snapshotID: input.snapshotID,
    producedAt: input.producedAt,
    scope: { projectDirectory: input.projectDirectory },
    filters: input.filters,
    priceSourcePolicy: input.priceState.settings.policy,
    availability: input.availability,
    freshness: input.freshness,
    unavailableReason: input.unavailableReason,
    accounting: {
      id: MODELS_DECISION_ACCOUNTING_BASIS,
      numerator: "all-attributable-cohort-failed-retry-and-accepted-effort",
      denominator: "accepted-logical-tasks",
      acceptanceThreshold: null,
      sampleSizeThreshold: null,
      valuation: "current-ordered-whole-model-price-source-pins",
      nativeReportedCosts: "retained-separately-not-market-equivalent",
    },
    taskKindCatalog: {
      id: MODELS_DECISION_TASK_KIND_CATALOG,
      kinds: [...MODELS_DECISION_TASK_KINDS],
    },
    classification: input.classification,
    priceIndex: priceContext(input.priceState, input.sourceRevision),
  }
}

function taskMatchesPersona(task: ObservationLedgerDecisionTask, persona: string) {
  return task.attempts.some(
    (attempt) =>
      attempt.accounting.personaRequested === persona ||
      attempt.accounting.personaFrozen === persona,
  )
}

function withinPeriod(task: ObservationLedgerDecisionTask, from: string | null, to: string | null) {
  const created = Date.parse(task.createdAt)
  if (!Number.isFinite(created)) return false
  return (
    (from === null || created >= Date.parse(from)) && (to === null || created <= Date.parse(to))
  )
}

function acceptedHistoryForTask(
  task: ObservationLedgerDecisionTask,
  sessionsForTask: readonly SessionData[],
  acceptedRoute: string,
): AcceptedHistory {
  const routes = new Set(
    sessionsForTask.flatMap((session) => (session.routeKey ? [session.routeKey] : [])),
  )
  const unknownRoute = sessionsForTask.some((session) => session.routeKey === null)
  const shared = sessionsForTask.some((session) => session.shared)
  const routeScope =
    unknownRoute || shared || !routes.size
      ? "unknown"
      : routes.size > 1 || !routes.has(acceptedRoute)
        ? "cross-route"
        : "same-route"
  const tokensComplete =
    sessionsForTask.length > 0 &&
    sessionsForTask.every(
      (session) => session.tokensComplete && session.tokens !== null && !session.shared,
    )
  const marketComplete =
    sessionsForTask.length > 0 &&
    sessionsForTask.every(
      (session) => session.marketComplete && session.marketUSD !== null && !session.shared,
    )
  return {
    tokens: tokensComplete ? sumValues(sessionsForTask.map((session) => session.tokens)) : null,
    currentMarketUSD: marketComplete
      ? sumValues(sessionsForTask.map((session) => session.marketUSD))
      : null,
    tokensComplete,
    marketComplete,
    shared,
    routeScope,
    routeKeys: routes,
    sessions: [...sessionsForTask],
  }
}

function historyScope(values: readonly AcceptedHistory[]): {
  completeness: "complete-accepted-logical-task-retry-history"
  routeScope: "same-route" | "cross-route" | "mixed" | "unknown"
} {
  const scopes = new Set(values.map((value) => value.routeScope))
  const known = [...scopes].filter((scope) => scope !== "unknown")
  const routeScope =
    known.includes("same-route") && known.includes("cross-route")
      ? "mixed"
      : known.length === 1 && scopes.size === 1
        ? known[0]!
        : "unknown"
  return {
    completeness: "complete-accepted-logical-task-retry-history" as const,
    routeScope,
  }
}

function estimateForHistories(
  histories: readonly AcceptedHistory[],
  acceptedTaskCount: number,
): ModelDecisionEstimate {
  const scope = historyScope(histories)
  if (!acceptedTaskCount)
    return {
      status: "zero-accepted",
      basis: "no-successful-task-efficiency",
      observationCount: 0,
      range: { tokens: null, currentMarketUSD: null },
      confidenceInterval: null,
      historyScope: scope,
    }

  const tokenValues = histories.flatMap((history) =>
    history.tokensComplete && history.tokens !== null ? [history.tokens] : [],
  )
  const marketValues = histories.flatMap((history) =>
    history.marketComplete && history.currentMarketUSD !== null ? [history.currentMarketUSD] : [],
  )
  const measuredCount = histories.filter(
    (history) => history.tokens !== null || history.currentMarketUSD !== null,
  ).length
  const missing = new Set<"tokens" | "current-price" | "attribution">()
  if (histories.some((history) => !history.tokensComplete)) missing.add("tokens")
  if (histories.some((history) => !history.marketComplete)) missing.add("current-price")
  if (histories.some((history) => history.shared)) missing.add("attribution")
  const tokenRange = tokenValues.length
    ? { minimum: Math.min(...tokenValues), maximum: Math.max(...tokenValues) }
    : null
  const marketRange = marketValues.length
    ? { minimum: Math.min(...marketValues), maximum: Math.max(...marketValues) }
    : null
  if (!measuredCount && !tokenRange && !marketRange)
    return {
      status: "unknown",
      basis: "unavailable",
      observationCount: 0,
      range: { tokens: null, currentMarketUSD: null },
      confidenceInterval: null,
      reason: "Accepted tasks have no complete retained usage or current-market observation.",
      historyScope: scope,
    }
  if (missing.size)
    return {
      status: "partial",
      basis: "empirical-observed-spread",
      observationCount: measuredCount,
      range: { tokens: tokenRange, currentMarketUSD: marketRange },
      confidenceInterval: null,
      missing: [...missing],
      historyScope: scope,
    }
  if (acceptedTaskCount === 1)
    return {
      status: "single-observation",
      basis: "empirical-observed-spread",
      observationCount: 1,
      range: {
        tokens: tokenRange ?? { minimum: histories[0]!.tokens!, maximum: histories[0]!.tokens! },
        currentMarketUSD: marketRange ?? {
          minimum: histories[0]!.currentMarketUSD!,
          maximum: histories[0]!.currentMarketUSD!,
        },
      },
      confidenceInterval: null,
      historyScope: scope,
    }
  return {
    status: "available",
    basis: "empirical-observed-spread",
    observationCount: acceptedTaskCount,
    range: { tokens: tokenRange!, currentMarketUSD: marketRange! },
    confidenceInterval: null,
    historyScope: scope,
  }
}

/** From the task's first recorded attempt start to its recorded acceptance; null without both. */
export function acceptedDurationMs(task: ObservationLedgerDecisionTask) {
  const acceptedAt = task.acceptance.acceptedAt
  if (!task.acceptance.accepted || acceptedAt === null || !task.attempts.length) return null
  const duration = acceptedAt - Math.min(...task.attempts.map((attempt) => attempt.startedAt))
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

export function median(values: readonly number[]) {
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function contributorContribution(
  attempts: SessionData["attempts"],
  acceptedAttemptIDs: Set<string>,
): ModelDecisionContributor["contribution"] {
  if (
    attempts.some(
      (attempt) =>
        attempt.accounting.state === "accepted" || acceptedAttemptIDs.has(attempt.accounting.id),
    )
  )
    return "accepted"
  if (attempts.some((attempt) => attempt.number > 1 || attempt.retryCount > 0)) return "retry"
  return "failed"
}

function isoTime(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null
  try {
    return new Date(value).toISOString()
  } catch {
    return null
  }
}

function makeContributors(input: {
  configurationID: string
  acceptedTaskIDs: Set<string>
  tasks: readonly ObservationLedgerDecisionTask[]
  sessionsByTask: Map<string, SessionData[]>
  selectedTaskID: string | null
}) {
  const contributors: ModelDecisionContributor[] = []
  for (const task of input.tasks) {
    const reference = task.taskReference
    if (!reference) continue
    const acceptedHistoryTask = input.acceptedTaskIDs.has(task.taskID)
    const acceptedAttemptIDs = new Set(
      task.acceptance.accepted
        ? task.acceptance.evidence.flatMap((evidence) =>
            evidence.attemptID ? [evidence.attemptID] : [],
          )
        : [],
    )
    for (const session of input.sessionsByTask.get(task.taskID) ?? []) {
      const cohortMember = session.routeKey === input.configurationID
      const historyMember = acceptedHistoryTask
      if (!cohortMember && !historyMember) continue
      const attempts = session.attemptsByTask.get(task.taskID) ?? []
      const uniqueAttemptIDs = [...new Set(attempts.map((attempt) => attempt.accounting.id))]
      const attemptID = uniqueAttemptIDs.length === 1 ? uniqueAttemptIDs[0]! : null
      const selectedOwnerCount = session.taskIDs.filter((taskID) =>
        input.tasks.some((item) => item.taskID === taskID),
      ).length
      const sharedWithOtherTask = session.shared || selectedOwnerCount > 1
      const membership =
        cohortMember && historyMember
          ? "both"
          : cohortMember
            ? "cohort-effort"
            : "empirical-history"
      contributors.push({
        taskID: task.taskID,
        taskReference: reference,
        attemptID: attemptID && /^[0-9a-f-]{36}$/i.test(attemptID) ? attemptID : null,
        sessionID: session.sessionID,
        contribution: contributorContribution(attempts, acceptedAttemptIDs),
        ...(session.route ? { route: session.route } : {}),
        membership,
        tokens: sharedWithOtherTask ? null : session.tokens,
        currentMarketUSD: sharedWithOtherTask ? null : session.marketUSD,
        nativeReportedUSD: sharedWithOtherTask ? null : session.nativeUSD,
        observedAt: isoTime(session.observedAt),
      })
    }
  }
  return contributors
    .filter((contributor) => contributor.sessionID.length <= 200)
    .sort(
      (left, right) =>
        Number(right.taskID === input.selectedTaskID) -
          Number(left.taskID === input.selectedTaskID) ||
        left.taskReference.localeCompare(right.taskReference) ||
        (left.observedAt ?? "").localeCompare(right.observedAt ?? "") ||
        left.sessionID.localeCompare(right.sessionID),
    )
}

type Cohort = {
  route: ModelDecisionRoute
  taskIDs: Set<string>
  acceptedTaskIDs: Set<string>
  terminalTaskIDs: Set<string>
  sessions: Map<string, SessionData>
  attemptIDs: Set<string>
  failedAttemptCount: number
  retryAttemptCount: number
  missingAttribution: boolean
  unknownRouteTaskIDs: Set<string>
  unattributedSessionIDs: Set<string>
}

function classifyTasks(
  baseTasks: ObservationLedgerDecisionTask[],
  selectedTasks: ObservationLedgerDecisionTask[],
  capture: ObservationLedgerDecisionCapture,
) {
  const classifiedTaskCount = baseTasks.filter(
    (task) => task.classification.status === "available" && task.classification.kind !== null,
  ).length
  const unclassifiedTaskCount = baseTasks.filter(
    (task) => task.classification.status === "available" && task.classification.kind === null,
  ).length
  const unavailableTaskCount = baseTasks.filter(
    (task) => task.classification.status === "unavailable",
  ).length
  const allSourcesAvailable = capture.sources.every((source) => source.status === "available")
  const status =
    unavailableTaskCount || unclassifiedTaskCount || !allSourcesAvailable ? "partial" : "complete"
  const classification: ModelDecisionContext["classification"] = {
    status,
    classifiedTaskCount,
    unclassifiedTaskCount,
    excludedTaskCount: baseTasks.length - selectedTasks.length,
    totalTaskCount: baseTasks.length,
  }
  return { classification, status }
}

/** Groups the selected tasks' sessions into one cohort per exact route. */
function buildCohorts(
  selectedTasks: ObservationLedgerDecisionTask[],
  bySession: Map<string, SessionData>,
  sessionsByTask: Map<string, SessionData[]>,
  selectedTaskByID: Map<string, ObservationLedgerDecisionTask>,
  signal: AbortSignal | undefined,
) {
  const cohorts = new Map<string, Cohort>()
  const cohortFor = (route: ModelDecisionRoute) => {
    const id = routeID(route)!
    const existing = cohorts.get(id)
    if (existing) return existing
    const created: Cohort = {
      route,
      taskIDs: new Set(),
      acceptedTaskIDs: new Set(),
      terminalTaskIDs: new Set(),
      sessions: new Map(),
      attemptIDs: new Set(),
      failedAttemptCount: 0,
      retryAttemptCount: 0,
      missingAttribution: false,
      unknownRouteTaskIDs: new Set(),
      unattributedSessionIDs: new Set(),
    }
    cohorts.set(id, created)
    return created
  }

  for (const session of bySession.values()) {
    signal?.throwIfAborted()
    if (!session.route) continue
    const cohort = cohortFor(session.route)
    cohort.sessions.set(session.sessionID, session)
    if (!session.selectedTaskIDs.length) {
      cohort.missingAttribution = true
      cohort.unattributedSessionIDs.add(session.sessionID)
    }
    for (const taskID of session.selectedTaskIDs) {
      const task = selectedTaskByID.get(taskID)
      if (!task) continue
      cohort.taskIDs.add(taskID)
      if (task.terminal) cohort.terminalTaskIDs.add(taskID)
      if (session.shared) cohort.missingAttribution = true
      for (const attempt of session.attemptsByTask.get(taskID) ?? []) {
        cohort.attemptIDs.add(attempt.accounting.id)
        if (attempt.accounting.state === "failed") cohort.failedAttemptCount++
        if (attempt.number > 1 || attempt.retryCount > 0) cohort.retryAttemptCount++
      }
    }
  }
  for (const task of selectedTasks) {
    if (!task.acceptance.accepted) continue
    const evidence = task.acceptance.evidence[0]
    const attempt = evidence?.attemptID
      ? task.attempts.find((candidate) => candidate.accounting.id === evidence.attemptID)
      : undefined
    const session = attempt ? bySession.get(attempt.accounting.sessionID) : undefined
    if (session?.route) cohortFor(session.route).acceptedTaskIDs.add(task.taskID)
  }

  for (const task of selectedTasks) {
    const knownRoutes = new Set(
      (sessionsByTask.get(task.taskID) ?? []).flatMap((session) =>
        session.routeKey ? [session.routeKey] : [],
      ),
    )
    if (!(sessionsByTask.get(task.taskID) ?? []).some((session) => session.routeKey === null))
      continue
    for (const routeKey of knownRoutes) {
      const cohort = cohorts.get(routeKey)
      if (cohort?.taskIDs.has(task.taskID)) {
        cohort.missingAttribution = true
        cohort.unknownRouteTaskIDs.add(task.taskID)
      }
    }
  }
  return cohorts
}

function cohortEfficiency(cohort: Cohort): ModelDecisionRow["efficiency"] {
  const acceptedTaskCount = cohort.acceptedTaskIDs.size
  const sessions = [...cohort.sessions.values()]
  const tokens = sumValues(sessions.map((session) => session.tokens))
  const tokensComplete = sessions.every(
    (session) => session.tokensComplete && session.tokens !== null,
  )
  const shared = sessions.some((session) => session.shared)
  const marketSessionsComplete =
    sessions.length > 0 &&
    sessions.every((session) => session.marketComplete && session.marketUSD !== null)
  const marketSubtotal = marketSessionsComplete
    ? sumValues(sessions.map((session) => session.marketUSD))
    : null
  const marketValueComplete = marketSessionsComplete && marketSubtotal !== null
  const marketAttributionComplete = !cohort.missingAttribution && !shared
  const marketComplete = marketValueComplete && marketAttributionComplete
  const market = marketComplete ? marketSubtotal : null
  const missing = new Set<"tokens" | "current-price" | "attribution">()
  if (!tokensComplete) missing.add("tokens")
  if (!marketValueComplete) missing.add("current-price")
  if (cohort.missingAttribution || shared) missing.add("attribution")
  if (acceptedTaskCount === 0)
    return {
      status: "zero-accepted" as const,
      tokensPerAcceptedTask: null,
      currentMarketUSDPerAcceptedTask: null,
      observationCount: 0,
    }
  if (missing.size)
    return {
      status: "partial" as const,
      tokensPerAcceptedTask: tokens === null ? null : tokens / acceptedTaskCount,
      currentMarketUSDPerAcceptedTask: market === null ? null : market / acceptedTaskCount,
      observationCount: acceptedTaskCount,
      missing: [...missing],
    }
  if (acceptedTaskCount === 1)
    return {
      status: "single-observation" as const,
      tokensPerAcceptedTask: tokens! / acceptedTaskCount,
      currentMarketUSDPerAcceptedTask: market! / acceptedTaskCount,
      observationCount: 1 as const,
    }
  return {
    status: "available" as const,
    tokensPerAcceptedTask: tokens! / acceptedTaskCount,
    currentMarketUSDPerAcceptedTask: market! / acceptedTaskCount,
    observationCount: acceptedTaskCount,
  }
}

function cohortNativeReportedCost(cohort: Cohort): ModelDecisionRow["nativeReportedCost"] {
  const sessions = [...cohort.sessions.values()]
  const nativeValues = sessions.map((session) => session.nativeUSD)
  const nativeComplete =
    sessions.length > 0 &&
    sessions.every((session) => session.nativeComplete && session.nativeUSD !== null)
  return {
    status:
      sessions.length > 0 && sessions.every((session) => session.nativeUnmetered)
        ? ("unmetered" as const)
        : nativeComplete
          ? ("available" as const)
          : nativeValues.some((value) => value !== null)
            ? ("partial" as const)
            : ("unknown" as const),
    totalUSD: nativeComplete ? sumValues(nativeValues) : null,
    source: "native-reported" as const,
    note: "Retained native/session-reported charges are diagnostic and are not market-equivalent prices.",
  }
}

/** Every session the cohort's tasks touched, with the attempts that belong to those tasks. */
function relatedEstimateSessions(
  cohort: Cohort,
  sessionsByTask: Map<string, SessionData[]>,
): ReferenceEstimateSession[] {
  const related = new Map<string, SessionData>()
  for (const taskID of cohort.taskIDs)
    for (const session of sessionsByTask.get(taskID) ?? []) related.set(session.sessionID, session)
  for (const session of cohort.sessions.values()) related.set(session.sessionID, session)
  return [...related.values()].map((session): ReferenceEstimateSession => {
    const attemptsByID = new Map<string, ObservationLedgerDecisionTask["attempts"][number]>()
    for (const taskID of cohort.taskIDs)
      for (const attempt of session.attemptsByTask.get(taskID) ?? [])
        attemptsByID.set(attempt.accounting.id, attempt)
    return {
      sessionID: session.sessionID,
      route: session.route,
      routeStatus: session.routeStatus,
      shared: session.shared,
      attributable: [...session.attemptsByTask.keys()].some((taskID) => cohort.taskIDs.has(taskID)),
      categories: session.usageCategories,
      attempts: [...attemptsByID.values()].map((attempt) => ({
        id: attempt.accounting.id,
        state: attempt.accounting.state,
        retry: attempt.number > 1 || attempt.retryCount > 0,
      })),
    }
  })
}

type CohortContext = {
  priceState: ModelDecisionPriceState
  pinsByRoute: Map<string, ModelDecisionPriceState["index"]["pins"][number]>
  sessionsByTask: Map<string, SessionData[]>
  selectedTaskByID: Map<string, ObservationLedgerDecisionTask>
  selectedTasks: ObservationLedgerDecisionTask[]
  valuationRequest: Parameters<typeof taskValuationPerCallUsage>[0]
}

function cohortRow(ctx: CohortContext, key: string, cohort: Cohort): ModelDecisionRow {
  const { priceState, sessionsByTask, selectedTaskByID } = ctx
  const acceptedTaskCount = cohort.acceptedTaskIDs.size
  const efficiency = cohortEfficiency(cohort)
  const nativeReportedCost = cohortNativeReportedCost(cohort)
  const configuration = configurationFromRoute(
    cohort.route,
    ctx.pinsByRoute.get(key),
    calculateModelDecisionReferenceEstimate({
      route: cohort.route,
      acceptedTaskCount,
      relatedTaskCount: cohort.taskIDs.size,
      unknownRouteTaskCount: cohort.unknownRouteTaskIDs.size,
      relatedSessions: relatedEstimateSessions(cohort, sessionsByTask),
      unattributedSessionCount: cohort.unattributedSessionIDs.size,
      missingAttribution: cohort.missingAttribution,
      settings: priceState.settings,
      identityCatalogSource: priceState.identityCatalogSource,
      identityNativeSource: priceState.identityNativeSource,
    }),
    priceState.settings.policy.revision,
    priceState.freshness,
  )
  return {
    configuration,
    cohort: {
      logicalTaskCount: cohort.taskIDs.size,
      classifiedTaskCount: [...cohort.taskIDs].filter(
        (taskID) => selectedTaskByID.get(taskID)?.classification.kind !== null,
      ).length,
      unclassifiedTaskCount: [...cohort.taskIDs].filter(
        (taskID) => selectedTaskByID.get(taskID)?.classification.kind === null,
      ).length,
      acceptedTaskCount,
      terminalTaskCount: cohort.terminalTaskIDs.size,
      attemptCount: cohort.attemptIDs.size,
      failedAttemptCount: cohort.failedAttemptCount,
      retryAttemptCount: cohort.retryAttemptCount,
    },
    efficiency,
    nativeReportedCost,
    referenceEstimate: configuration.referenceEstimate!,
  }
}

function cohortKnownUsageMarket(ctx: CohortContext, cohort: Cohort): KnownUsageMarket {
  const { priceState } = ctx
  const knownUsageSessions = knownUsageSessionsForTasks(cohort.taskIDs, ctx.sessionsByTask)
  if (!priceState.sources)
    return calculateKnownUsageMarket({
      route: cohort.route,
      identity: resolveMarketIdentity(cohort.route, priceState),
      endpointPricing: priceState.endpointPricing,
      sessions: knownUsageSessions,
    })
  const perCall = taskValuationPerCallUsage(ctx.valuationRequest, cohort.route)
  return calculateConfiguredKnownUsageMarket({
    route: cohort.route,
    identity: resolveMarketIdentity(cohort.route, priceState),
    settings: priceState.settings,
    sources: priceState.sources,
    sessions: knownUsageSessions,
    perCallUsage: perCall.calls,
    perCallCoverageComplete: perCall.complete,
  })
}

function acceptedTaskDurations(ctx: CohortContext, cohort: Cohort) {
  return [...cohort.acceptedTaskIDs].flatMap((taskID) => {
    const task = ctx.selectedTaskByID.get(taskID)
    const duration = task ? acceptedDurationMs(task) : null
    return duration === null ? [] : [duration]
  })
}

function decisionGraph(rows: ModelDecisionRow[]): DecisionSnapshot["graph"] {
  const points = rows.flatMap((row) => {
    const efficiency = row.efficiency
    if (
      row.cohort.acceptedTaskCount === 0 ||
      efficiency.tokensPerAcceptedTask === null ||
      efficiency.currentMarketUSDPerAcceptedTask === null
    )
      return []
    return [
      {
        configurationID: row.configuration.configurationID,
        groupID: row.configuration.groupID,
        label: row.configuration.label,
        tokensPerAcceptedTask: efficiency.tokensPerAcceptedTask,
        currentMarketUSDPerAcceptedTask: efficiency.currentMarketUSDPerAcceptedTask,
        observationCount: efficiency.observationCount,
        acceptedTaskCount: row.cohort.acceptedTaskCount,
        terminalTaskCount: row.cohort.terminalTaskCount,
        partial: efficiency.status === "partial",
      },
    ]
  })
  const completePoints = points.filter((point) => !point.partial)
  const frontier = completePoints.filter(
    (point) =>
      !completePoints.some(
        (other) =>
          other.configurationID !== point.configurationID &&
          other.tokensPerAcceptedTask <= point.tokensPerAcceptedTask &&
          other.currentMarketUSDPerAcceptedTask <= point.currentMarketUSDPerAcceptedTask &&
          (other.tokensPerAcceptedTask < point.tokensPerAcceptedTask ||
            other.currentMarketUSDPerAcceptedTask < point.currentMarketUSDPerAcceptedTask),
      ),
  )
  return {
    scope: "global-filtered-snapshot",
    points,
    frontierConfigurationIDs: frontier
      .map((point) => point.configurationID)
      .sort((left, right) => left.localeCompare(right)),
    referenceEstimates: rows.map((row) => ({
      configurationID: row.configuration.configurationID,
      label: row.configuration.label,
      tokensPerAcceptedTask: row.efficiency.tokensPerAcceptedTask,
      estimate: row.referenceEstimate!,
    })),
  }
}

function buildSnapshotData(
  input: ModelDecisionReadInput,
  capture: ObservationLedgerDecisionCapture,
  priceState: ModelDecisionPriceState,
  routes: CurrentPriceApplicability[],
  signal?: AbortSignal,
): DecisionSnapshot {
  signal?.throwIfAborted()
  const { baseTasks, selectedTasks } = filteredTasks(capture, input)
  const { classification, status: classStatus } = classifyTasks(baseTasks, selectedTasks, capture)
  const inputFingerprint = fingerprint({
    projectDirectory: input.scope.projectDirectory,
    filters: input.filters,
  })
  const attempts = selectedTasks.flatMap((task) =>
    task.attempts.map((attempt) => attempt.accounting),
  )
  const valuationRequest = {
    attempts,
    progressFacts: capture.progressFacts,
    progressTruncated: false,
    truncatedContextSessionIDs: [],
  }
  const valuation = projectTaskValuation({ ...valuationRequest, currentIndex: priceState.index })
  const bySession = buildSessionData(capture, valuation, selectedTasks)
  const sessionsByTask = taskSessions(selectedTasks, bySession)
  const selectedTaskByID = taskByID(capture)
  const hasUnknownRoute = [...bySession.values()].some(
    (session) => session.selectedTaskIDs.length > 0 && session.routeKey === null,
  )
  const snapshotID = `models-decision-v2:${randomUUID()}`
  const unresolvedAcceptance = selectedTasks.some(
    (task) =>
      task.acceptance.accepted && task.acceptance.evidence.some((evidence) => !evidence.attemptID),
  )
  const availability =
    classStatus !== "complete" ||
    capture.notes.length > 0 ||
    unresolvedAcceptance ||
    !priceState.index.pins.length ||
    hasUnknownRoute
      ? "partial"
      : "ready"
  const context = contextFor({
    projectDirectory: input.scope.projectDirectory,
    filters: input.filters,
    snapshotID,
    producedAt: new Date().toISOString(),
    classification,
    availability,
    freshness: priceState.freshness,
    unavailableReason: null,
    priceState,
    sourceRevision: capture.sourceRevision,
  })

  const cohorts = buildCohorts(selectedTasks, bySession, sessionsByTask, selectedTaskByID, signal)
  const pinsByRoute = new Map(
    priceState.index.pins.flatMap((pin) => {
      const route = exactRoute(pin.route)
      return route ? [[routeID(route)!, pin] as const] : []
    }),
  )
  const ctx: CohortContext = {
    priceState,
    pinsByRoute,
    sessionsByTask,
    selectedTaskByID,
    selectedTasks,
    valuationRequest,
  }
  const rows: ModelDecisionRow[] = []
  const contributors = new Map<string, ModelDecisionContributor[]>()
  const medianAcceptedDurationMs = new Map<string, number>()
  const estimates = new Map<string, ModelDecisionEstimate>()
  const knownUsageMarkets = new Map<string, KnownUsageMarket>()
  for (const [key, cohort] of cohorts) {
    signal?.throwIfAborted()
    rows.push(cohortRow(ctx, key, cohort))
    knownUsageMarkets.set(key, cohortKnownUsageMarket(ctx, cohort))
    const acceptedHistories = [...cohort.acceptedTaskIDs].flatMap((taskID) => {
      const task = selectedTaskByID.get(taskID)
      if (!task) return []
      return [acceptedHistoryForTask(task, sessionsByTask.get(taskID) ?? [], key)]
    })
    estimates.set(key, estimateForHistories(acceptedHistories, cohort.acceptedTaskIDs.size))
    const durations = acceptedTaskDurations(ctx, cohort)
    if (durations.length) medianAcceptedDurationMs.set(key, median(durations))
    contributors.set(
      key,
      makeContributors({
        configurationID: key,
        acceptedTaskIDs: cohort.acceptedTaskIDs,
        tasks: selectedTasks,
        sessionsByTask,
        selectedTaskID: null,
      }),
    )
  }
  rows.sort((left, right) =>
    left.configuration.configurationID.localeCompare(right.configuration.configurationID),
  )
  return {
    context,
    sourceRevision: capture.sourceRevision,
    routes,
    priceState,
    inputFingerprint,
    rows,
    configurations: rows.map((row) => row.configuration),
    graph: decisionGraph(rows),
    contributors,
    estimates,
    medianAcceptedDurationMs,
    knownUsageMarkets,
  }
}

function filteredTasks(capture: ObservationLedgerDecisionCapture, input: ModelDecisionReadInput) {
  const baseTasks = capture.tasks.filter(
    (task) =>
      withinPeriod(task, input.filters.period.from, input.filters.period.to) &&
      (input.filters.persona === null || taskMatchesPersona(task, input.filters.persona)),
  )
  const selectedTasks = baseTasks.filter(
    (task) =>
      input.filters.taskKind === null || task.classification.kind === input.filters.taskKind,
  )
  return { baseTasks, selectedTasks }
}

function knownUsageSessionsForTasks(
  taskIDs: ReadonlySet<string>,
  sessionsByTask: Map<string, SessionData[]>,
): KnownUsageMarketSession[] {
  const sessions = new Map<string, SessionData>()
  for (const taskID of taskIDs)
    for (const session of sessionsByTask.get(taskID) ?? []) sessions.set(session.sessionID, session)

  return [...sessions.values()].map((session) => {
    const seenAttempts = new Set<string>()
    const attempts = [...taskIDs].flatMap((taskID) =>
      (session.attemptsByTask.get(taskID) ?? []).flatMap((attempt) => {
        const id = attempt.accounting.id
        if (seenAttempts.has(id)) return []
        seenAttempts.add(id)
        return [
          {
            id,
            state: attempt.accounting.state,
            retry: attempt.number > 1 || attempt.retryCount > 0,
          },
        ]
      }),
    )
    return {
      sessionID: session.sessionID,
      route: session.route,
      routeStatus: session.routeStatus,
      shared: session.shared,
      categories: session.usageCategories,
      attempts,
    }
  })
}

function unavailableSnapshot(
  input: ModelDecisionReadInput,
  result: Exclude<ObservationLedgerDecisionRead, ObservationLedgerDecisionCapture>,
  priceState: ModelDecisionPriceState,
): DecisionSnapshot {
  const reason = result.reason
  const context = contextFor({
    projectDirectory: input.scope.projectDirectory,
    filters: input.filters,
    snapshotID: `models-decision-v2:${randomUUID()}`,
    producedAt: new Date().toISOString(),
    classification: {
      status: "backend-not-ready",
      classifiedTaskCount: 0,
      unclassifiedTaskCount: 0,
      excludedTaskCount: 0,
      totalTaskCount: 0,
    },
    availability: "backend-not-ready",
    freshness: priceState.freshness,
    unavailableReason: reason,
    priceState,
    ...(result.sourceRevision === null ? {} : { sourceRevision: result.sourceRevision }),
  })
  return {
    context,
    sourceRevision: result.sourceRevision,
    routes: [],
    priceState,
    inputFingerprint: fingerprint({ scope: input.scope, filters: input.filters }),
    rows: [],
    configurations: [],
    graph: {
      scope: "global-filtered-snapshot",
      points: [],
      frontierConfigurationIDs: [],
      referenceEstimates: [],
    },
    contributors: new Map(),
    estimates: new Map(),
    medianAcceptedDurationMs: new Map(),
    knownUsageMarkets: new Map(),
  }
}

function inputMatches(snapshot: DecisionSnapshot, input: ModelDecisionReadInput) {
  return (
    snapshot.context.scope.projectDirectory === input.scope.projectDirectory &&
    stable(snapshot.context.filters) === stable(input.filters)
  )
}

function pageCursor(secret: Uint8Array, payload: CursorPayload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", secret).update(body).digest("base64url")
  return `${body}.${signature}`
}

function readPageCursor(secret: Uint8Array, token: string): CursorPayload {
  if (Buffer.byteLength(token, "utf8") > MAX_CURSOR_BYTES)
    throw new Error("Model decision cursor exceeds its bound")
  const [body, signature, extra] = token.split(".")
  if (!body || !signature || extra !== undefined)
    throw new Error("Model decision cursor is malformed")
  const expected = createHmac("sha256", secret).update(body).digest()
  let supplied: Buffer
  try {
    supplied = Buffer.from(signature, "base64url")
  } catch {
    throw new Error("Model decision cursor is malformed")
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new Error("Model decision cursor authentication failed")
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  } catch {
    throw new Error("Model decision cursor is malformed")
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as CursorPayload).version !== 1 ||
    !["rows", "configurations", "contributors"].includes((parsed as CursorPayload).kind) ||
    !Number.isSafeInteger((parsed as CursorPayload).offset) ||
    (parsed as CursorPayload).offset < 0 ||
    !Number.isSafeInteger((parsed as CursorPayload).limit) ||
    (parsed as CursorPayload).limit < 1 ||
    typeof (parsed as CursorPayload).snapshotID !== "string" ||
    typeof (parsed as CursorPayload).inputFingerprint !== "string"
  )
    throw new Error("Model decision cursor is malformed")
  return parsed as CursorPayload
}

function page<T>(items: readonly T[], offset: number, limit: number) {
  return items.slice(offset, offset + limit)
}

function snapshotOverview(snapshot: DecisionSnapshot): ModelDecisionOverview {
  const groups = new Set(snapshot.configurations.map((configuration) => configuration.groupID))
  return ModelDecisionOverviewOutputSchema.parse({
    context: snapshot.context,
    graph: snapshot.graph,
    configurationCount: snapshot.configurations.length,
    groupCount: groups.size,
  })
}

function rowPage(
  snapshot: DecisionSnapshot,
  offset: number,
  limit: number,
  secret: Uint8Array,
): ModelDecisionRows {
  const nextOffset = offset + limit
  const nextCursor =
    nextOffset < snapshot.rows.length
      ? pageCursor(secret, {
          version: 1,
          kind: "rows",
          snapshotID: snapshot.context.snapshotID,
          offset: nextOffset,
          limit,
          inputFingerprint: snapshot.inputFingerprint,
        })
      : null
  return ModelDecisionRowsOutputSchema.parse({
    context: snapshot.context,
    rows: page(snapshot.rows, offset, limit),
    totalCount: snapshot.rows.length,
    nextCursor,
  })
}

function configurationPage(
  snapshot: DecisionSnapshot,
  offset: number,
  limit: number,
  secret: Uint8Array,
): ModelDecisionConfigurations {
  const nextOffset = offset + limit
  const nextCursor =
    nextOffset < snapshot.configurations.length
      ? pageCursor(secret, {
          version: 1,
          kind: "configurations",
          snapshotID: snapshot.context.snapshotID,
          offset: nextOffset,
          limit,
          inputFingerprint: snapshot.inputFingerprint,
        })
      : null
  return ModelDecisionConfigurationsOutputSchema.parse({
    context: snapshot.context,
    configurations: page(snapshot.configurations, offset, limit),
    totalCount: snapshot.configurations.length,
    nextCursor,
  })
}

function inspection(
  snapshot: DecisionSnapshot,
  input: ReturnType<typeof ModelDecisionInspectInputSchema.parse>,
  offset: number,
  secret: Uint8Array,
): ModelDecisionInspect {
  const row = snapshot.rows.find(
    (candidate) => candidate.configuration.configurationID === input.configurationID,
  )
  if (!row)
    return ModelDecisionInspectOutputSchema.parse({
      status: "not-found",
      context: snapshot.context,
      configurationID: input.configurationID,
    })
  const configKey = routeID(row.configuration.route)!
  const contributors = [...(snapshot.contributors.get(configKey) ?? [])].sort(
    (left, right) =>
      Number(right.taskID === input.selectedTaskID) -
        Number(left.taskID === input.selectedTaskID) ||
      left.taskReference.localeCompare(right.taskReference) ||
      (left.observedAt ?? "").localeCompare(right.observedAt ?? "") ||
      left.sessionID.localeCompare(right.sessionID),
  )
  const nextOffset = offset + input.contributorLimit
  const nextCursor =
    nextOffset < contributors.length
      ? pageCursor(secret, {
          version: 1,
          kind: "contributors",
          snapshotID: snapshot.context.snapshotID,
          offset: nextOffset,
          limit: input.contributorLimit,
          configurationID: input.configurationID,
          selectedTaskID: input.selectedTaskID,
          inputFingerprint: snapshot.inputFingerprint,
        })
      : null
  return ModelDecisionInspectOutputSchema.parse({
    status: "found",
    context: snapshot.context,
    configuration: row.configuration,
    cohort: row.cohort,
    efficiency: row.efficiency,
    nativeReportedCost: row.nativeReportedCost,
    selectedTaskID: input.selectedTaskID,
    referenceEstimate: row.referenceEstimate,
    estimate: snapshot.estimates.get(configKey) ?? {
      status: "zero-accepted",
      basis: "no-successful-task-efficiency",
      observationCount: 0,
      range: { tokens: null, currentMarketUSD: null },
      confidenceInterval: null,
      historyScope: {
        completeness: "complete-accepted-logical-task-retry-history",
        routeScope: "unknown",
      },
    },
    knownUsageMarket: snapshot.knownUsageMarkets.get(configKey),
    ...(snapshot.medianAcceptedDurationMs.has(configKey)
      ? { medianAcceptedDurationMs: snapshot.medianAcceptedDurationMs.get(configKey)! }
      : {}),
    contributorPage: {
      contributors: page(contributors, offset, input.contributorLimit),
      totalCount: contributors.length,
      nextCursor,
    },
  })
}

export type ModelDecisionWarmOutcome = "current" | "refreshed"

export function createModelDecisionReader(
  dependencies: ModelDecisionReaderDependencies,
): ModelDecisionReader & {
  /**
   * Keep the cached snapshot for these inputs current: rebuild it when the project's observation
   * revision moved past it, do nothing (no price read) when it has not. Callers use it to take
   * the rebuild off the path of the next open.
   */
  warm(input: ModelDecisionReadInput, signal?: AbortSignal): Promise<ModelDecisionWarmOutcome>
  close(): void
} {
  const secret = randomBytes(32)
  const snapshots = new Map<string, SnapshotEntry>()
  const latestByFilter = new Map<string, string>()
  const pendingByFilter = new Map<string, Promise<DecisionSnapshot>>()
  let disposed = false

  const drop = (snapshotID: string) => {
    const entry = snapshots.get(snapshotID)
    if (!entry) return
    snapshots.delete(snapshotID)
    if (latestByFilter.get(entry.filterKey) === snapshotID) latestByFilter.delete(entry.filterKey)
  }

  const remember = (snapshot: DecisionSnapshot, filterKey: string) => {
    snapshots.set(snapshot.context.snapshotID, { snapshot, filterKey })
    latestByFilter.set(filterKey, snapshot.context.snapshotID)
    while (snapshots.size > MAX_SNAPSHOTS) drop(snapshots.keys().next().value!)
  }

  const touch = (snapshotID: string) => {
    const entry = snapshots.get(snapshotID)
    if (!entry) return
    snapshots.delete(snapshotID)
    snapshots.set(snapshotID, entry)
  }

  const snapshotIsCurrent = async (snapshot: DecisionSnapshot, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (snapshot.sourceRevision === null) return false
    if (readCurrentDecisionRevision(dependencies) !== snapshot.sourceRevision) return false
    const current = await dependencies.readPriceState(snapshot.routes, signal)
    signal?.throwIfAborted()
    return (
      current.index.indexID === snapshot.priceState.index.indexID &&
      current.freshness === snapshot.priceState.freshness &&
      stable(current.settings) === stable(snapshot.priceState.settings) &&
      stable(modelIdentitySourceIdentity(current.identityCatalogSource)) ===
        stable(modelIdentitySourceIdentity(snapshot.priceState.identityCatalogSource)) &&
      stable(modelIdentitySourceIdentity(current.identityNativeSource)) ===
        stable(modelIdentitySourceIdentity(snapshot.priceState.identityNativeSource)) &&
      stable(endpointPricingIdentity(current.endpointPricing)) ===
        stable(endpointPricingIdentity(snapshot.priceState.endpointPricing))
    )
  }

  const createSnapshot = async (
    input: ModelDecisionReadInput,
    signal?: AbortSignal,
  ): Promise<DecisionSnapshot> => {
    signal?.throwIfAborted()
    const ledger = dependencies.openLedger()
    let result: ObservationLedgerDecisionRead
    try {
      result = ledger.readDecision(signal)
    } finally {
      ledger.close()
    }
    signal?.throwIfAborted()
    if (result.status !== "captured") {
      const priceState = await dependencies.readPriceState([], signal)
      signal?.throwIfAborted()
      return unavailableSnapshot(input, result, priceState)
    }
    const { selectedTasks } = filteredTasks(result, input)
    const effort = projectTaskEffortBasis({
      attempts: selectedTasks.flatMap((task) => task.attempts.map((attempt) => attempt.accounting)),
      progressFacts: result.progressFacts,
      progressTruncated: false,
      truncatedContextSessionIDs: [],
    })
    const routes = collectRoutes(result, selectedTasks, effort.usage.sessions)
    if (routes.length > 4_000)
      throw new Error("Decision route coverage exceeds the 4000 exact-route pricing bound")
    const priceState = await dependencies.readPriceState(routes, signal)
    signal?.throwIfAborted()
    const snapshot = buildSnapshotData(input, result, priceState, routes, signal)
    signal?.throwIfAborted()
    return snapshot
  }

  const freshForInput = async (input: ModelDecisionReadInput, signal?: AbortSignal) => {
    if (disposed) throw new Error("Model decision reader is closed")
    signal?.throwIfAborted()
    const key = fingerprint({ scope: input.scope, filters: input.filters })
    const latestID = latestByFilter.get(key)
    if (latestID) {
      const cached = snapshots.get(latestID)?.snapshot
      if (cached) {
        if (!inputMatches(cached, input)) throw new Error("Model decision filters do not match")
        if (await snapshotIsCurrent(cached, signal)) {
          touch(latestID)
          return cached
        }
      }
    }
    let pending = pendingByFilter.get(key)
    if (!pending) {
      pending = createSnapshot(input, signal).then((snapshot) => {
        if (snapshot.sourceRevision !== null) remember(snapshot, key)
        return snapshot
      })
      pendingByFilter.set(key, pending)
      void pending
        .finally(() => {
          if (pendingByFilter.get(key) === pending) pendingByFilter.delete(key)
        })
        .catch(() => {})
    }
    const snapshot = await pending
    signal?.throwIfAborted()
    return snapshot
  }

  const fromCursor = async (
    cursor: CursorPayload,
    input: ModelDecisionReadInput,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted()
    const entry = snapshots.get(cursor.snapshotID)
    if (!entry) throw new Error("Model decision cursor is stale or its snapshot expired")
    const snapshot = entry.snapshot
    if (cursor.inputFingerprint !== snapshot.inputFingerprint || !inputMatches(snapshot, input))
      throw new Error("Model decision cursor scope or filters do not match")
    signal?.throwIfAborted()
    touch(cursor.snapshotID)
    return snapshot
  }

  const fromSnapshot = async (
    snapshotID: string,
    input: ModelDecisionReadInput,
    signal?: AbortSignal,
  ) => {
    if (disposed) throw new Error("Model decision reader is closed")
    signal?.throwIfAborted()
    const entry = snapshots.get(snapshotID)
    if (!entry) throw new Error("Model decision snapshot is unavailable or expired")
    const snapshot = entry.snapshot
    if (!inputMatches(snapshot, input))
      throw new Error("Model decision snapshot scope or filters do not match")
    signal?.throwIfAborted()
    touch(snapshotID)
    return snapshot
  }

  const reader: ReturnType<typeof createModelDecisionReader> = {
    async warm(input, signal) {
      const parsed = ModelDecisionReadInputSchema.parse(input)
      if (parsed.scope.projectDirectory !== dependencies.projectDirectory)
        throw new Error("Model decision scope is unavailable")
      const key = fingerprint({ scope: parsed.scope, filters: parsed.filters })
      const cached = snapshots.get(latestByFilter.get(key) ?? "")?.snapshot
      if (
        cached &&
        cached.sourceRevision !== null &&
        readCurrentDecisionRevision(dependencies) === cached.sourceRevision
      )
        return "current"
      await freshForInput(parsed, signal)
      return "refreshed"
    },
    async overview(input, options) {
      const parsed = ModelDecisionReadInputSchema.parse(input)
      if (parsed.scope.projectDirectory !== dependencies.projectDirectory)
        throw new Error("Model decision scope is unavailable")
      const snapshot = await freshForInput(parsed, options?.signal)
      options?.signal?.throwIfAborted()
      return snapshotOverview(snapshot)
    },
    async rows(input: ModelDecisionRowsInput, options) {
      const parsed = ModelDecisionRowsInputSchema.parse(input)
      if (parsed.scope.projectDirectory !== dependencies.projectDirectory)
        throw new Error("Model decision scope is unavailable")
      let snapshot: DecisionSnapshot
      let offset = 0
      if (parsed.cursor) {
        const cursor = readPageCursor(secret, parsed.cursor)
        if (cursor.kind !== "rows" || cursor.limit !== parsed.limit)
          throw new Error("Model decision row cursor page does not match")
        if (parsed.snapshotID && parsed.snapshotID !== cursor.snapshotID)
          throw new Error("Model decision row cursor and snapshot pin do not match")
        snapshot = await fromCursor(cursor, parsed, options?.signal)
        offset = cursor.offset
      } else
        snapshot = parsed.snapshotID
          ? await fromSnapshot(parsed.snapshotID, parsed, options?.signal)
          : await freshForInput(parsed, options?.signal)
      options?.signal?.throwIfAborted()
      return rowPage(snapshot, offset, parsed.limit, secret)
    },
    async configurations(input: ModelDecisionConfigurationsInput, options) {
      const parsed = ModelDecisionConfigurationsInputSchema.parse(input)
      if (parsed.scope.projectDirectory !== dependencies.projectDirectory)
        throw new Error("Model decision scope is unavailable")
      let snapshot: DecisionSnapshot
      let offset = 0
      if (parsed.cursor) {
        const cursor = readPageCursor(secret, parsed.cursor)
        if (cursor.kind !== "configurations" || cursor.limit !== parsed.limit)
          throw new Error("Model decision configuration cursor page does not match")
        if (parsed.snapshotID && parsed.snapshotID !== cursor.snapshotID)
          throw new Error("Model decision configuration cursor and snapshot pin do not match")
        snapshot = await fromCursor(cursor, parsed, options?.signal)
        offset = cursor.offset
      } else
        snapshot = parsed.snapshotID
          ? await fromSnapshot(parsed.snapshotID, parsed, options?.signal)
          : await freshForInput(parsed, options?.signal)
      options?.signal?.throwIfAborted()
      return configurationPage(snapshot, offset, parsed.limit, secret)
    },
    async inspect(input: ModelDecisionInspectInput, options) {
      const parsed = ModelDecisionInspectInputSchema.parse(input)
      if (parsed.scope.projectDirectory !== dependencies.projectDirectory)
        throw new Error("Model decision scope is unavailable")
      const snapshot = snapshots.get(parsed.snapshotID)?.snapshot
      if (!snapshot || !inputMatches(snapshot, parsed))
        throw new Error("Model decision inspection snapshot is unavailable or mismatched")
      touch(parsed.snapshotID)
      let offset = 0
      if (parsed.contributorCursor) {
        const cursor = readPageCursor(secret, parsed.contributorCursor)
        if (
          cursor.kind !== "contributors" ||
          cursor.limit !== parsed.contributorLimit ||
          cursor.configurationID !== parsed.configurationID ||
          cursor.selectedTaskID !== parsed.selectedTaskID ||
          cursor.snapshotID !== parsed.snapshotID
        )
          throw new Error("Model decision contributor cursor does not match this inspection")
        offset = cursor.offset
        await fromCursor(cursor, parsed, options?.signal)
      } else options?.signal?.throwIfAborted()
      options?.signal?.throwIfAborted()
      return inspection(snapshot, parsed, offset, secret)
    },
    close() {
      if (disposed) return
      disposed = true
      for (const snapshotID of [...snapshots.keys()]) drop(snapshotID)
      pendingByFilter.clear()
    },
  }
  return reader
}
