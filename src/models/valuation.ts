import {
  attemptsKey,
  digestAccountingFacts,
  memoizedOnDigest,
  projectTaskEffortUsage,
  type AccountingAttempt,
  type AccountingRoute,
  type EffortUsageBasis,
  type MemoizedAccountingDigest,
} from "../trajectory/accounting.ts"
import { CurrentPriceIndexSchema, TaskValuationSchema } from "./valuation-schema.ts"
import type { CurrentPriceIndex, CurrentPricePin, TaskValuation } from "./valuation-schema.ts"
import type { CurrentPriceApplicability } from "./current-price-index.ts"
import type { KnownUsagePerCall, MarketRangeRoute } from "./market-range.ts"

export type Decimal = { coefficient: bigint; scale: number }
type ProgressFact = {
  id: string
  sequence: number | null
  sessionID: string
  messageID: string | null
  kind: string
  at: number | null
  recordedAt: number | null
  measurementBasis: string | null
  usage: Record<string, unknown> | null
  /** Position in the project's global fact order. */
  ord: number
}

const USAGE_CATEGORIES = [
  "uncachedInput",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
] as const
type UsageCategory = (typeof USAGE_CATEGORIES)[number]

const RATE_FOR_CATEGORY = {
  uncachedInput: "uncachedInput",
  output: "completion",
  reasoning: "completion",
  cacheRead: "cacheRead",
  cacheWrite: "cacheWrite",
} as const

const USAGE_FIELD_FOR_CATEGORY = {
  uncachedInput: "input",
  output: "output",
  reasoning: "reasoning",
  cacheRead: "cacheRead",
  cacheWrite: "cacheWrite",
} as const

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

export function decimal(value: number | string): Decimal | null {
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) return null
  const text = String(value)
  const match = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!match) return null
  const fraction = match[2] ?? ""
  const exponent = Number(match[3] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) return null
  let coefficient = BigInt(`${match[1]}${fraction}`)
  let scale = fraction.length - exponent
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale)
    scale = 0
  }
  while (scale > 0 && coefficient !== 0n && coefficient % 10n === 0n) {
    coefficient /= 10n
    scale--
  }
  return { coefficient, scale }
}

export function addDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale)
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale)
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale)
  let coefficient = leftCoefficient + rightCoefficient
  let normalizedScale = scale
  while (normalizedScale > 0 && coefficient !== 0n && coefficient % 10n === 0n) {
    coefficient /= 10n
    normalizedScale--
  }
  return { coefficient, scale: normalizedScale }
}

export function multiplyDecimal(left: Decimal, right: Decimal): Decimal {
  let coefficient = left.coefficient * right.coefficient
  let scale = left.scale + right.scale
  while (scale > 0 && coefficient !== 0n && coefficient % 10n === 0n) {
    coefficient /= 10n
    scale--
  }
  return { coefficient, scale }
}

function decimalText(value: Decimal): string {
  if (value.scale === 0) return value.coefficient.toString()
  const digits = value.coefficient.toString().padStart(value.scale + 1, "0")
  const split = digits.length - value.scale
  return `${digits.slice(0, split)}.${digits.slice(split)}`
}

export function decimalNumber(value: Decimal): number | null {
  const parsed = Number(decimalText(value))
  if (!Number.isFinite(parsed) || parsed < 0 || (value.coefficient > 0n && parsed === 0))
    return null
  return parsed
}

function perTokenRate(pin: CurrentPricePin, category: UsageCategory): Decimal | null {
  const key = RATE_FOR_CATEGORY[category]
  const raw = pin.rates[key]
  if (raw === null) return null
  const parsed = decimal(raw)
  if (!parsed) return null
  if (pin.rates.unit === "USD per million tokens")
    return { coefficient: parsed.coefficient, scale: parsed.scale + 6 }
  return parsed
}

function costForTokens(tokens: number, rate: Decimal): Decimal | null {
  const amount = decimal(tokens)
  return amount ? multiplyDecimal(amount, rate) : null
}

function sourceRouteIdentity(route: AccountingRoute): {
  providerID: string
  modelID: string
  variant: string | null
} | null {
  if (Object.hasOwn(route, "identity")) return route.identity ?? null
  const parts = [route.providerID, route.modelID, route.variant]
  if (parts.some((part) => part?.endsWith("…[truncated]") || part?.includes("[REDACTED]")))
    return null
  return { providerID: route.providerID, modelID: route.modelID, variant: route.variant }
}

function routeKey(route: { providerID: string; modelID: string; variant: string | null }) {
  return JSON.stringify([route.providerID, route.modelID, route.variant])
}

function publicRoute(route: AccountingRoute) {
  return {
    providerID: route.providerID,
    modelID: route.modelID,
    variant: route.variant,
  }
}

function progressRoute(value: unknown): AccountingRoute | null {
  const data = object(value)
  if (!data) return null
  const providerID = typeof data.providerID === "string" ? data.providerID : null
  const modelID =
    typeof data.modelID === "string" ? data.modelID : typeof data.id === "string" ? data.id : null
  if (!providerID || !modelID) return null
  const rawVariant = data.variant
  const variant = typeof rawVariant === "string" ? rawVariant : null
  const invalidVariant =
    rawVariant !== undefined && rawVariant !== null && typeof rawVariant !== "string"
  const identityLost = [providerID, modelID, variant].some(
    (part) => part?.endsWith("…[truncated]") || part?.includes("[REDACTED]"),
  )
  const route: AccountingRoute = { providerID, modelID, variant }
  if (Object.hasOwn(data, "identity")) {
    const rawIdentity = object(data.identity)
    const identityProviderID =
      typeof rawIdentity?.providerID === "string" ? rawIdentity.providerID : null
    const identityModelID = typeof rawIdentity?.modelID === "string" ? rawIdentity.modelID : null
    const identityVariant = rawIdentity?.variant
    const validIdentity =
      identityProviderID !== null &&
      identityModelID !== null &&
      (identityVariant === null || typeof identityVariant === "string") &&
      ![identityProviderID, identityModelID, identityVariant].some(
        (part) =>
          typeof part === "string" &&
          (part.endsWith("…[truncated]") || part.includes("[REDACTED]")),
      )
    return {
      ...route,
      identity: validIdentity
        ? {
            providerID: identityProviderID,
            modelID: identityModelID,
            variant: identityVariant as string | null,
          }
        : null,
    }
  }
  if (invalidVariant || identityLost) return { ...route, identity: null }
  return { ...route, identity: { providerID, modelID, variant } }
}

type CallRouteEvidence = { routes: AccountingRoute[]; unavailable: boolean }
type RouteEvidence = {
  calls: Map<string, CallRouteEvidence>
  unscopedRoutes: Array<AccountingRoute | null>
}

function callKey(sessionID: string, messageID: string) {
  return `${sessionID}\u0000${messageID}`
}

/** The route evidence the facts of one session carry; it does not depend on any attempt. */
function buildRouteEvidence(sessionID: string, facts: readonly unknown[]): RouteEvidence {
  const calls = new Map<string, CallRouteEvidence>()
  const unscopedRoutes: Array<AccountingRoute | null> = []
  const getCall = (messageID: string) => {
    const key = callKey(sessionID, messageID)
    const existing = calls.get(key)
    if (existing) return existing
    const created = { routes: [], unavailable: false }
    calls.set(key, created)
    return created
  }
  const addRoute = (target: CallRouteEvidence, value: unknown) => {
    const route = progressRoute(value)
    if (!route) {
      target.unavailable = true
      return
    }
    target.routes.push(route)
  }
  const addEvidence = (target: CallRouteEvidence, value: unknown) => {
    const evidence = object(value)
    if (!evidence) {
      target.unavailable = true
      return
    }
    if (evidence.status !== "observed") {
      target.unavailable = true
      return
    }
    addRoute(target, evidence.route)
  }

  for (const raw of facts) {
    const fact = object(raw)
    const kind = typeof fact?.kind === "string" ? fact.kind : ""
    const normalizedKind = kind.startsWith("worker-") ? kind.slice("worker-".length) : kind
    if (fact?.sessionID !== sessionID || normalizedKind !== "step") continue
    const payload = object(fact.payload)
    const hasCallEvidence =
      typeof fact.status === "string" ||
      (Array.isArray(fact.observations) && fact.observations.length > 0) ||
      (fact.route !== undefined && fact.route !== null) ||
      object(fact.routeEvidence) !== null ||
      typeof payload?.status === "string" ||
      (Array.isArray(payload?.observations) && payload.observations.length > 0) ||
      (payload?.route !== undefined && payload.route !== null) ||
      object(payload?.routeEvidence) !== null
    if (!hasCallEvidence) continue
    const messageID = typeof fact.messageID === "string" && fact.messageID ? fact.messageID : null
    const target = messageID ? getCall(messageID) : null
    if (!target) unscopedRoutes.push(null)
    const sources = [fact, payload].filter((value): value is Record<string, unknown> =>
      Boolean(value),
    )
    for (const source of sources) {
      if (Object.hasOwn(source, "routeEvidence") && source.routeEvidence !== null)
        target ? addEvidence(target, source.routeEvidence) : unscopedRoutes.push(null)
      if (source.route !== undefined && source.route !== null)
        target ? addRoute(target, source.route) : unscopedRoutes.push(progressRoute(source.route))
      if (!Array.isArray(source.observations)) continue
      for (const rawObservation of source.observations) {
        const observation = object(rawObservation)
        if (!observation) continue
        if (Object.hasOwn(observation, "routeEvidence") && observation.routeEvidence !== null)
          target ? addEvidence(target, observation.routeEvidence) : unscopedRoutes.push(null)
        if (observation.route !== undefined && observation.route !== null)
          target
            ? addRoute(target, observation.route)
            : unscopedRoutes.push(progressRoute(observation.route))
      }
    }
  }
  return { calls, unscopedRoutes }
}

/** The facts' evidence plus the routes the attempts saw in native context; the input is not changed. */
function evidenceWithAttempts(
  evidence: RouteEvidence,
  sessionID: string,
  attempts: AccountingAttempt[],
): RouteEvidence {
  if (!attempts.some((attempt) => attempt.stepRoutes.length)) return evidence
  const calls = new Map(
    [...evidence.calls].map(([key, call]) => [
      key,
      { routes: [...call.routes], unavailable: call.unavailable },
    ]),
  )
  for (const attempt of attempts)
    for (const step of attempt.stepRoutes) {
      const key = callKey(sessionID, step.messageID)
      let target = calls.get(key)
      if (!target) {
        target = { routes: [], unavailable: false }
        calls.set(key, target)
      }
      target.routes.push(step.route)
    }
  return { calls, unscopedRoutes: evidence.unscopedRoutes }
}

function routeEvidenceForCall(evidence: RouteEvidence) {
  const routes = [...evidence.unscopedRoutes]
  for (const call of evidence.calls.values()) {
    const distinctCallRoutes = new Map<string, AccountingRoute | null>()
    for (const route of call.routes) {
      const identity = sourceRouteIdentity(route)
      distinctCallRoutes.set(identity ? routeKey(identity) : "identity-unavailable", route)
    }
    routes.push(...distinctCallRoutes.values())
    if (call.unavailable || call.routes.length === 0) routes.push(null)
  }
  return routes
}

function sessionRouteAllocation(attempts: AccountingAttempt[], evidence: RouteEvidence) {
  const exact = new Map<
    string,
    { identity: NonNullable<ReturnType<typeof sourceRouteIdentity>>; route: AccountingRoute }
  >()
  let unavailableIdentityCount = 0
  let observedCount = 0
  const routes: Array<AccountingRoute | null> = []
  for (const attempt of attempts) {
    routes.push(
      ...(attempt.sessionStatus === "available" && attempt.currentRoute
        ? [attempt.currentRoute]
        : []),
    )
  }
  routes.push(...routeEvidenceForCall(evidence))
  for (const route of routes) {
    observedCount++
    if (!route) {
      unavailableIdentityCount++
      continue
    }
    const identity = sourceRouteIdentity(route)
    if (!identity) {
      unavailableIdentityCount++
      continue
    }
    exact.set(routeKey(identity), { identity, route })
  }
  if (unavailableIdentityCount)
    return {
      status: "identity-unavailable" as const,
      route: null,
      observedRouteCount: observedCount,
      identity: null,
    }
  if (exact.size > 1)
    return {
      status: "mixed-observed-routes" as const,
      route: null,
      observedRouteCount: observedCount,
      identity: null,
    }
  const only = [...exact.values()][0]
  if (!only)
    return {
      status: "unavailable" as const,
      route: null,
      observedRouteCount: observedCount,
      identity: null,
    }
  return {
    status: "single-observed-route" as const,
    route: publicRoute(only.route),
    observedRouteCount: observedCount,
    identity: only.identity,
  }
}

function pinMatches(
  pin: CurrentPricePin,
  identity: { providerID: string; modelID: string; variant: string | null },
) {
  return Boolean(
    pin.route &&
    pin.route.providerID === identity.providerID &&
    pin.route.modelID === identity.modelID &&
    pin.route.variant === identity.variant,
  )
}

export function currentPricePinBlockers(pin: CurrentPricePin): string[] {
  const blockers: string[] = []
  if (pin.resolution.route !== "resolved" || !pin.route) blockers.push("route")
  if (pin.resolution.sku !== "resolved" || !pin.productID) blockers.push("sku")
  if (
    pin.resolution.configuration === "unresolved" ||
    (pin.resolution.configuration === "resolved" && !pin.configurationID)
  )
    blockers.push("configuration")
  if (pin.resolution.tier === "unresolved") blockers.push("tier")
  if (pin.resolution.schedule === "unresolved") blockers.push("schedule")
  return blockers
}

function compareFacts(left: ProgressFact, right: ProgressFact) {
  return (
    (right.at ?? Number.MIN_SAFE_INTEGER) - (left.at ?? Number.MIN_SAFE_INTEGER) ||
    (right.recordedAt ?? Number.MIN_SAFE_INTEGER) - (left.recordedAt ?? Number.MIN_SAFE_INTEGER) ||
    (right.sequence ?? Number.MIN_SAFE_INTEGER) - (left.sequence ?? Number.MIN_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  )
}

/** A fact with its place in the project's global fact order (its sequence; an index in an array). */
export type OrderedFact = { ord: number; fact: unknown }

/** A route a fact or one of its observations named, for the decision's price selectors. */
export type RouteCandidate = {
  ord: number
  attemptID: string
  providerID: string
  modelID: string
  variant: string | null
}

type CallDigest = {
  messageID: string
  /** Order of the call's first additive fact: calls come out in the order they first appeared. */
  ord: number
  categories: Record<UsageCategory, number | null>
  usageDiffers: boolean
}

/** What the valuation reads from one session's facts; it never depends on an attempt. */
export type ValuationFactDigest = {
  /** The latest cumulative snapshot's reported cost, as retained (unvalidated). */
  cumulativeCost: { value: unknown } | null
  /** Numeric `costUSD` values over the session's facts, and whether every one is zero. */
  factCosts: { count: number; allZero: boolean }
  /** The reported cost of each unique additive step, in first-seen order. */
  additiveCosts: unknown[]
  evidence: RouteEvidence
  calls: CallDigest[]
  /** An additive step with no message id: its call cannot be told apart. */
  unscopedAdditive: boolean
}

/** Every attempt-independent reduction of one session's retained facts. */
export type SessionFactDigest = {
  sessionID: string
  factCount: number
  accounting: MemoizedAccountingDigest
  valuation: ValuationFactDigest
  routeCandidates: RouteCandidate[]
  /** Results derived from this digest and a session's attempts; absent on throwaway digests. */
  memo?: Map<string, unknown>
  /** Estimated retained size, for the cache budget. */
  bytes: number
}

export type SessionFactDigests = ReadonlyMap<string, SessionFactDigest>

/** Raw facts, or the digests of an incremental read. */
export type ProgressFactInput = readonly unknown[] | SessionFactDigests

function parseOrderedFacts(entries: readonly OrderedFact[]): ProgressFact[] {
  return entries.flatMap(({ ord, fact: raw }) => {
    const fact = object(raw)
    if (!fact) return []
    const usage = object(fact.usage) ?? object(object(fact.payload)?.usage)
    const kind = typeof fact.kind === "string" ? fact.kind : ""
    const normalizedKind = kind.startsWith("worker-") ? kind.slice("worker-".length) : kind
    if (normalizedKind !== "usage-snapshot" && normalizedKind !== "step") return []
    return [
      {
        id: typeof fact.id === "string" ? fact.id : "unknown-progress-fact",
        sequence: finiteNonnegative(fact.sequence),
        sessionID: typeof fact.sessionID === "string" ? fact.sessionID : "",
        messageID: typeof fact.messageID === "string" ? fact.messageID : null,
        kind: normalizedKind,
        at: finiteNonnegative(fact.at),
        recordedAt: finiteNonnegative(fact.recordedAt),
        measurementBasis: typeof fact.measurementBasis === "string" ? fact.measurementBasis : null,
        usage,
        ord,
      },
    ]
  })
}

/** The route a fact or observation names, when it is a well-formed provider and model. */
function routeCandidate(value: unknown): Omit<RouteCandidate, "ord" | "attemptID"> | null {
  const item = object(value)
  if (!item) return null
  const routeValue =
    typeof item.routeEvidence === "object" && item.routeEvidence !== null
      ? (item.routeEvidence as Record<string, unknown>).status === "observed"
        ? (item.routeEvidence as Record<string, unknown>).route
        : null
      : item.route
  const raw = object(routeValue)
  if (!raw) return null
  const modelID = raw.modelID ?? raw.id
  if (
    typeof raw.providerID !== "string" ||
    typeof modelID !== "string" ||
    (raw.variant !== null && raw.variant !== undefined && typeof raw.variant !== "string")
  )
    return null
  return {
    providerID: raw.providerID,
    modelID,
    variant: typeof raw.variant === "string" ? raw.variant : null,
  }
}

function digestRouteCandidates(entries: readonly OrderedFact[]): RouteCandidate[] {
  const found = new Map<string, RouteCandidate>()
  for (const { ord, fact } of entries) {
    const record = object(fact)
    if (!record) continue
    const attemptID = String(record.attemptID ?? "")
    const candidates = [record, ...(Array.isArray(record.observations) ? record.observations : [])]
    for (const candidate of candidates) {
      const route = routeCandidate(candidate)
      if (!route) continue
      const key = JSON.stringify([attemptID, route.providerID, route.modelID, route.variant])
      if (!found.has(key)) found.set(key, { ord, attemptID, ...route })
    }
  }
  return [...found.values()]
}

function digestValuationFacts(
  sessionID: string,
  entries: readonly OrderedFact[],
): ValuationFactDigest {
  const facts = parseOrderedFacts(entries)
  const costs = facts.flatMap((fact) =>
    typeof fact.usage?.costUSD === "number" ? [fact.usage.costUSD] : [],
  )
  const cumulative = facts
    .filter(
      (fact) =>
        fact.kind === "usage-snapshot" && fact.measurementBasis === "cumulative-session-snapshot",
    )
    .sort(compareFacts)[0]
  const additiveByIdentity = new Map<string, ProgressFact>()
  const callFacts = new Map<string, ProgressFact[]>()
  let unscopedAdditive = false
  for (const fact of facts) {
    if (fact.kind !== "step" || fact.measurementBasis !== "additive-step-measurement") continue
    const identity = fact.messageID ?? fact.id
    const previous = additiveByIdentity.get(identity)
    if (!previous || compareFacts(previous, fact) > 0) additiveByIdentity.set(identity, fact)
    if (!fact.messageID) {
      unscopedAdditive = true
      continue
    }
    const group = callFacts.get(fact.messageID)
    if (group) group.push(fact)
    else callFacts.set(fact.messageID, [fact])
  }
  const calls = [...callFacts].map(([messageID, group]): CallDigest => {
    const selected = [...group].sort(compareFacts)[0]!
    return {
      messageID,
      ord: group[0]!.ord,
      categories: Object.fromEntries(
        USAGE_CATEGORIES.map((category) => [
          category,
          finiteNonnegative(selected.usage?.[USAGE_FIELD_FOR_CATEGORY[category]]),
        ]),
      ) as Record<UsageCategory, number | null>,
      usageDiffers: group.some((fact) => !sameUsage(fact.usage, selected.usage)),
    }
  })
  return {
    cumulativeCost: cumulative ? { value: cumulative.usage?.costUSD } : null,
    factCosts: { count: costs.length, allZero: costs.every((value) => value === 0) },
    additiveCosts: [...additiveByIdentity.values()].map((fact) => fact.usage?.costUSD),
    evidence: buildRouteEvidence(
      sessionID,
      entries.map((entry) => entry.fact),
    ),
    calls,
    unscopedAdditive,
  }
}

/** Retained size of a digest in bytes (UTF-16 serialized length), to budget the cache. */
function estimateDigestBytes(digest: Omit<SessionFactDigest, "bytes" | "memo">) {
  return (
    2 *
    JSON.stringify(digest, (_key, value: unknown) => (value instanceof Map ? [...value] : value))
      .length
  )
}

/**
 * Reduce one session's facts, in their retained order, to everything the valuation derives from
 * them. `shared` digests (the cache's) carry a memo for per-attempt-set results; throwaway ones
 * (a raw array) do not, so results derived from them are never shared between calls.
 */
export function digestSessionFacts(
  sessionID: string,
  entries: readonly OrderedFact[],
  options: { shared?: boolean } = {},
): SessionFactDigest {
  const memo = options.shared ? new Map<string, unknown>() : undefined
  const accounting: MemoizedAccountingDigest = {
    ...digestAccountingFacts(entries.map((entry) => entry.fact)),
    ...(memo ? { memo } : {}),
  }
  const parts = {
    sessionID,
    factCount: entries.length,
    accounting,
    valuation: digestValuationFacts(sessionID, entries),
    routeCandidates: digestRouteCandidates(entries),
  }
  // Derived results roughly double what a digest holds once its memo fills.
  return { ...parts, ...(memo ? { memo } : {}), bytes: estimateDigestBytes(parts) * 2 }
}

const digestsOfArrays = new WeakMap<readonly unknown[], SessionFactDigests>()

/** Digest a raw fact array by session, once per array. */
function digestsOfFacts(values: readonly unknown[]): SessionFactDigests {
  const cached = digestsOfArrays.get(values)
  if (cached) return cached
  const groups = new Map<string, OrderedFact[]>()
  values.forEach((fact, ord) => {
    const raw = object(fact)?.sessionID
    const key = typeof raw === "string" ? raw : ""
    const group = groups.get(key)
    if (group) group.push({ ord, fact })
    else groups.set(key, [{ ord, fact }])
  })
  const digests = new Map(
    [...groups].map(([sessionID, entries]) => [sessionID, digestSessionFacts(sessionID, entries)]),
  )
  digestsOfArrays.set(values, digests)
  return digests
}

function digestsOf(input: ProgressFactInput): SessionFactDigests {
  return Array.isArray(input)
    ? digestsOfFacts(input as readonly unknown[])
    : (input as SessionFactDigests)
}

const noFacts = (sessionID: string) => digestSessionFacts(sessionID, [])

/** The attempts of each session of `attempts`. */
function attemptsBySession(attempts: readonly AccountingAttempt[]) {
  const grouped = new Map<string, AccountingAttempt[]>()
  for (const attempt of attempts) {
    const group = grouped.get(attempt.sessionID)
    if (group) group.push(attempt)
    else grouped.set(attempt.sessionID, [attempt])
  }
  return grouped
}

/** The route evidence of a session with its attempts' native context folded in; memoized. */
function evidenceFor(
  sessionID: string,
  attempts: AccountingAttempt[],
  key: string,
  digest: SessionFactDigest,
) {
  return memoizedOnDigest(digest, `evidence:${key}`, () =>
    evidenceWithAttempts(digest.valuation.evidence, sessionID, attempts),
  )
}

function allocationFor(
  sessionID: string,
  attempts: AccountingAttempt[],
  key: string,
  digest: SessionFactDigest,
) {
  return memoizedOnDigest(digest, `allocation:${key}`, () =>
    sessionRouteAllocation(attempts, evidenceFor(sessionID, attempts, key, digest)),
  )
}

function costContribution(
  session: EffortUsageBasis["usage"]["sessions"][number],
  attempts: AccountingAttempt[],
  digest: SessionFactDigest,
) {
  const facts = digest.valuation
  const attemptCosts = attempts
    .map((attempt) => attempt.recordedCostUSD)
    .filter((value): value is number => typeof value === "number")
  const numericCount = facts.factCosts.count + attemptCosts.length
  const unmetered =
    numericCount > 0 &&
    (facts.factCosts.count === 0 || facts.factCosts.allZero) &&
    attemptCosts.every((value) => value === 0) &&
    USAGE_CATEGORIES.some((category) => (session.categories[category].value ?? 0) > 0)
  const cumulativeValue = facts.cumulativeCost?.value
  const cumulativeCost =
    typeof cumulativeValue === "number" && Number.isFinite(cumulativeValue) && cumulativeValue >= 0
      ? cumulativeValue
      : null
  const ignoredAdditive = facts.additiveCosts.length
  if (
    facts.cumulativeCost &&
    cumulativeValue !== null &&
    cumulativeValue !== undefined &&
    cumulativeCost === null
  ) {
    return {
      sessionID: session.sessionID,
      attemptIDs: session.attemptIDs,
      basis: "unavailable" as const,
      valueUSD: null,
      status: "unavailable" as const,
      source:
        "runner-progress-store cumulative session snapshot contains a nonfinite or negative cost",
      measurementCount: 1,
      missingMeasurements: 0,
      ignoredAdditiveStepCount: ignoredAdditive,
    }
  }
  if (cumulativeCost !== null) {
    return {
      sessionID: session.sessionID,
      attemptIDs: session.attemptIDs,
      basis: "cumulative-session-snapshot" as const,
      valueUSD: unmetered ? null : cumulativeCost,
      status: unmetered ? ("unmetered" as const) : ("observed" as const),
      source: "runner-progress-store cumulative session snapshot",
      measurementCount: 1,
      missingMeasurements: 0,
      ignoredAdditiveStepCount: ignoredAdditive,
    }
  }

  const attemptCostRows = attempts.flatMap((attempt) => {
    const cost = attempt.recordedCostUSD
    if (cost === null) return []
    return [{ value: cost, valid: Number.isFinite(cost) && cost >= 0 }]
  })
  if (attemptCostRows.some((cost) => !cost.valid)) {
    return {
      sessionID: session.sessionID,
      attemptIDs: session.attemptIDs,
      basis: "unavailable" as const,
      valueUSD: null,
      status: "unavailable" as const,
      source: "runner_attempt.cost contains a nonfinite or negative contribution",
      measurementCount: attemptCostRows.length,
      missingMeasurements: 0,
      ignoredAdditiveStepCount: ignoredAdditive,
    }
  }
  if (attemptCostRows.length) {
    return {
      sessionID: session.sessionID,
      attemptIDs: session.attemptIDs,
      basis: "attempt-session-cumulative-snapshot" as const,
      valueUSD: unmetered
        ? null
        : attemptCostRows.reduce((largest, cost) => Math.max(largest, cost.value), 0),
      status: unmetered ? ("unmetered" as const) : ("observed" as const),
      source:
        "largest retained runner_attempt.cost for this unique session; contributions are not summed",
      measurementCount: attemptCostRows.length,
      missingMeasurements: 0,
      ignoredAdditiveStepCount: ignoredAdditive,
    }
  }

  if (ignoredAdditive) {
    let subtotal: Decimal = { coefficient: 0n, scale: 0 }
    let observed = 0
    let missing = 0
    let invalid = false
    for (const value of facts.additiveCosts) {
      if (value === null || value === undefined) {
        missing++
        continue
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        invalid = true
        continue
      }
      const parsed = decimal(value)
      if (!parsed) {
        invalid = true
        continue
      }
      subtotal = addDecimal(subtotal, parsed)
      observed++
    }
    const subtotalUSD = decimalNumber(subtotal)
    if (invalid || (observed && subtotalUSD === null)) {
      return {
        sessionID: session.sessionID,
        attemptIDs: session.attemptIDs,
        basis: "unavailable" as const,
        valueUSD: null,
        status: "unavailable" as const,
        source:
          "worker-progress unique-step cost subtotal overflowed or contained an invalid value",
        measurementCount: observed,
        missingMeasurements: missing,
        ignoredAdditiveStepCount: 0,
      }
    }
    return {
      sessionID: session.sessionID,
      attemptIDs: session.attemptIDs,
      basis: observed ? ("retained-additive-step-subtotal" as const) : ("unavailable" as const),
      valueUSD: observed && !unmetered ? subtotalUSD : null,
      status: unmetered
        ? ("unmetered" as const)
        : observed
          ? ("partial" as const)
          : ("missing" as const),
      source: observed
        ? "deduplicated worker-progress additive steps; subtotal only, not a cumulative session cost"
        : "No numeric cost was present in the retained additive steps",
      measurementCount: observed,
      missingMeasurements: missing,
      ignoredAdditiveStepCount: 0,
    }
  }

  return {
    sessionID: session.sessionID,
    attemptIDs: session.attemptIDs,
    basis: "unavailable" as const,
    valueUSD: null,
    status: "missing" as const,
    source: null,
    measurementCount: 0,
    missingMeasurements: 1,
    ignoredAdditiveStepCount: 0,
  }
}

function costContributions(input: {
  attempts: AccountingAttempt[]
  digests: SessionFactDigests
  sessions: EffortUsageBasis["usage"]["sessions"]
}) {
  const bySession = attemptsBySession(input.attempts)
  return input.sessions.map((session) => {
    const attempts = bySession.get(session.sessionID) ?? []
    const digest = input.digests.get(session.sessionID) ?? noFacts(session.sessionID)
    return memoizedOnDigest(digest, `cost:${attemptsKey(attempts)}`, () =>
      costContribution(session, attempts, digest),
    )
  })
}

function reportedWorkerCost(
  contributions: ReturnType<typeof costContributions>,
): TaskValuation["reportedWorkerCost"] {
  if (!contributions.length)
    return {
      valueUSD: null,
      subtotalUSD: null,
      unit: "USD",
      status: "missing",
      meaning:
        "Reported worker-session cost only; not invoice-confirmed, API-equivalent, or full-task cost. Architect, review, and integration overhead are unallocated.",
      selection:
        "Select one cumulative session contribution per unique worker session; only when no cumulative cost is available, expose a deduplicated additive-step subtotal.",
      totalUniqueSessions: 0,
      cumulativeSessions: 0,
      additiveSubtotalSessions: 0,
      missingSessionIDs: [],
      contributions: [],
    }

  let subtotal: Decimal = { coefficient: 0n, scale: 0 }
  let hasSubtotal = false
  let overflow = false
  for (const contribution of contributions) {
    if (contribution.valueUSD === null) continue
    const parsed = decimal(contribution.valueUSD)
    if (!parsed) {
      overflow = true
      continue
    }
    subtotal = addDecimal(subtotal, parsed)
    hasSubtotal = true
  }
  const subtotalUSD = overflow ? null : decimalNumber(subtotal)
  if (hasSubtotal && subtotalUSD === null) overflow = true
  const cumulativeSessions = contributions.filter(
    (item) =>
      item.basis === "cumulative-session-snapshot" ||
      item.basis === "attempt-session-cumulative-snapshot",
  ).length
  const additiveSubtotalSessions = contributions.filter(
    (item) => item.basis === "retained-additive-step-subtotal",
  ).length
  const missingSessionIDs = contributions
    .filter((item) => item.status === "missing" || item.status === "unavailable")
    .map((item) => item.sessionID)
  const allCumulative =
    cumulativeSessions === contributions.length &&
    contributions.every((item) => item.status === "observed")
  const allMissing = contributions.every((item) => item.status === "missing")
  const allUnmetered = contributions.every((item) => item.status === "unmetered")
  const status = overflow
    ? "unavailable"
    : allUnmetered
      ? "unmetered"
      : allCumulative
        ? "observed"
        : allMissing
          ? "missing"
          : "partial"
  return {
    valueUSD: status === "observed" ? subtotalUSD : null,
    subtotalUSD: overflow ? null : hasSubtotal ? subtotalUSD : null,
    unit: "USD",
    status,
    meaning:
      "Reported worker-session cost only; not invoice-confirmed, API-equivalent, or full-task cost. Architect, review, and integration overhead are unallocated.",
    selection:
      "Select one cumulative session contribution per unique worker session (latest retained cumulative snapshot, otherwise the largest retained attempt cumulative value); only when no cumulative cost is available, expose a deduplicated additive-step subtotal. Never add per-step costs to a cumulative snapshot or add retries.",
    totalUniqueSessions: contributions.length,
    cumulativeSessions,
    additiveSubtotalSessions,
    missingSessionIDs,
    contributions,
  }
}

function safeUsageValue(value: unknown) {
  return finiteNonnegative(value)
}

function projectUsage(effort: EffortUsageBasis): TaskValuation["usage"] {
  const categories = Object.fromEntries(
    USAGE_CATEGORIES.map((category) => {
      const measure = effort.usage.categories[category]
      const value = safeUsageValue(measure.value)
      const invalid = measure.value !== null && value === null
      return [
        category,
        {
          value,
          unit: "tokens" as const,
          status: invalid ? ("unavailable" as const) : measure.status,
          meaning: measure.meaning,
          valueScope: invalid ? ("unknown" as const) : measure.valueScope,
          sources: measure.sources,
          sourceTypes: measure.sourceTypes,
          missingSessionIDs: measure.missingSessionIDs,
        },
      ]
    }),
  ) as TaskValuation["usage"]["categories"]
  const sessions = effort.usage.sessions.map((session) => {
    const categories = Object.fromEntries(
      USAGE_CATEGORIES.map((category) => {
        const measure = session.categories[category]
        const value = safeUsageValue(measure.value)
        const invalid = measure.value !== null && value === null
        return [
          category,
          {
            value,
            unit: "tokens" as const,
            status: invalid ? ("unavailable" as const) : measure.status,
            basis: measure.basis,
            valueScope: invalid ? ("unknown" as const) : measure.valueScope,
            source: measure.source,
            sourceTypes: measure.sourceTypes,
          },
        ]
      }),
    ) as TaskValuation["usage"]["sessions"][number]["categories"]
    return {
      sessionID: session.sessionID,
      attemptIDs: session.attemptIDs,
      attemptStates: session.attemptStates,
      sessionStatus:
        session.sessionStatus as TaskValuation["usage"]["sessions"][number]["sessionStatus"],
      selectedBasis:
        session.selectedBasis as TaskValuation["usage"]["sessions"][number]["selectedBasis"],
      additiveStepCount: session.additiveStepCount,
      categories,
    }
  })
  return {
    unit: "tokens",
    categories,
    sessions,
    coverage: effort.usage.coverage,
    routeCoverage: {
      observedSessionRouteCount: effort.routes.coverage.observedSessionRouteCount,
      observedStepRouteCount: effort.routes.coverage.observedStepRouteCount,
      sessionsWithoutCurrentRoute: effort.routes.coverage.sessionsWithoutCurrentRoute,
      stepContextsByStatus: effort.routes.coverage.stepContextsByStatus,
      progressTruncated: effort.routes.coverage.progressTruncated,
      truncatedContextSessionIDs: effort.routes.coverage.truncatedContextSessionIDs,
    },
  }
}

function marketCategory(input: {
  measure: TaskValuation["usage"]["sessions"][number]["categories"][UsageCategory]
  category: UsageCategory
  routeStatus: ReturnType<typeof sessionRouteAllocation>["status"]
  pin: CurrentPricePin | null
  blockers: string[]
  pinIssue: "ambiguous" | "missing" | null
}): TaskValuation["marketEquivalentCost"]["sessions"][number]["categories"][UsageCategory] {
  const { measure, category } = input
  const tokens = measure.value
  if (measure.status === "unavailable")
    return {
      tokens,
      rateUSDPerToken: null,
      valueUSD: null,
      status: "unavailable",
      reason: "Token usage is nonfinite, negative, or otherwise unavailable.",
    }
  if (tokens === null)
    return {
      tokens: null,
      rateUSDPerToken: null,
      valueUSD: null,
      status: "unknown",
      reason: "Token usage is missing; missing is not zero.",
    }
  if (tokens === 0) {
    if (measure.status === "observed")
      return {
        tokens,
        rateUSDPerToken: null,
        valueUSD: 0,
        status: "zero-usage",
        reason: null,
      }
    return {
      tokens,
      rateUSDPerToken: null,
      valueUSD: 0,
      status: "unknown",
      reason: "The observed zero is only a partial usage subtotal, not complete zero usage.",
    }
  }
  if (input.routeStatus !== "single-observed-route")
    return {
      tokens,
      rateUSDPerToken: null,
      valueUSD: null,
      status: "unknown",
      reason: `Positive usage has no single exact observed route allocation (${input.routeStatus}).`,
    }
  if (input.pinIssue)
    return {
      tokens,
      rateUSDPerToken: null,
      valueUSD: null,
      status: "unknown",
      reason:
        input.pinIssue === "ambiguous"
          ? "More than one current price pin matches the exact route; no pin was selected."
          : "No supplied current price pin matches the exact observed route.",
    }
  if (!input.pin || input.blockers.length)
    return {
      tokens,
      rateUSDPerToken: null,
      valueUSD: null,
      status: "unknown",
      reason: `The current product/price pin is unresolved: ${input.blockers.join(", ") || "pin unavailable"}.`,
    }
  const rate = perTokenRate(input.pin, category)
  if (!rate)
    return {
      tokens,
      rateUSDPerToken: null,
      valueUSD: null,
      status: "unknown",
      reason: `The current price pin has no applicable ${RATE_FOR_CATEGORY[category]} rate.`,
    }
  const rateUSDPerToken = decimalNumber(rate)
  const cost = costForTokens(tokens, rate)
  const valueUSD = cost ? decimalNumber(cost) : null
  if (rateUSDPerToken === null || valueUSD === null)
    return {
      tokens,
      rateUSDPerToken: null,
      valueUSD: null,
      status: "unavailable",
      reason: "Usage-times-rate overflowed the finite USD output range.",
    }
  return {
    tokens,
    rateUSDPerToken,
    valueUSD,
    status: "valued",
    reason:
      measure.status === "observed"
        ? null
        : "Priced observed token subtotal; token usage coverage is partial.",
  }
}

function sessionMarketValue(input: {
  session: TaskValuation["usage"]["sessions"][number]
  routeAllocation: ReturnType<typeof sessionRouteAllocation>
  candidates: CurrentPricePin[]
  progressTruncated: boolean
  routeContextTruncated: boolean
}) {
  const pinIssue =
    input.candidates.length > 1
      ? ("ambiguous" as const)
      : input.candidates.length === 0
        ? ("missing" as const)
        : null
  const pin = input.candidates.length === 1 ? input.candidates[0]! : null
  const blockers = pin ? currentPricePinBlockers(pin) : []
  const categories = Object.fromEntries(
    USAGE_CATEGORIES.map((category) => [
      category,
      marketCategory({
        measure: input.session.categories[category],
        category,
        routeStatus: input.routeAllocation.status,
        pin,
        blockers,
        pinIssue,
      }),
    ]),
  ) as TaskValuation["marketEquivalentCost"]["sessions"][number]["categories"]

  const categoryValues = USAGE_CATEGORIES.map((category) => categories[category])
  const knownValues = categoryValues.flatMap((item) =>
    item.valueUSD === null ? [] : [decimal(item.valueUSD)!],
  )
  let subtotal: Decimal = { coefficient: 0n, scale: 0 }
  for (const value of knownValues) subtotal = addDecimal(subtotal, value)
  const numericSubtotal = knownValues.length ? decimalNumber(subtotal) : null
  const overflow =
    categoryValues.some((item) => item.status === "unavailable") ||
    (knownValues.length > 0 && numericSubtotal === null)
  const subtotalUSD = overflow ? null : numericSubtotal
  const positiveUsage = USAGE_CATEGORIES.some(
    (category) => (input.session.categories[category].value ?? 0) > 0,
  )
  const routeAndPinResolved =
    !positiveUsage ||
    (input.routeAllocation.status === "single-observed-route" &&
      pin !== null &&
      blockers.length === 0 &&
      !input.progressTruncated &&
      !input.routeContextTruncated)
  const allUsageObserved = USAGE_CATEGORIES.every(
    (category) => input.session.categories[category].status === "observed",
  )
  const allCategoriesKnown = categoryValues.every(
    (item) => item.status === "valued" || item.status === "zero-usage",
  )
  const status: TaskValuation["marketEquivalentCost"]["sessions"][number]["status"] = overflow
    ? "unavailable"
    : routeAndPinResolved && allUsageObserved && allCategoriesKnown
      ? "observed"
      : knownValues.length
        ? "partial"
        : categoryValues.some((item) => item.status === "unknown")
          ? "missing"
          : "partial"
  return {
    sessionID: input.session.sessionID,
    attemptIDs: input.session.attemptIDs,
    routeAllocation: {
      status: input.routeAllocation.status,
      route: input.routeAllocation.route,
      observedRouteCount: input.routeAllocation.observedRouteCount,
      meaning:
        "Only observed current-session and retained-step routes are used. Full provider-call route coverage is not guaranteed; plan/frozen assignments do not stand in for observed product identity.",
    },
    pinStatus: pinIssue ?? (blockers.length ? "unresolved" : "resolved"),
    pinCandidates: input.candidates,
    categories,
    valueUSD: status === "observed" ? subtotalUSD : null,
    subtotalUSD,
    status,
  }
}

function marketEquivalentCost(input: {
  usage: TaskValuation["usage"]
  attempts: AccountingAttempt[]
  digests: SessionFactDigests
  currentIndex: CurrentPriceIndex
}) {
  const bySession = attemptsBySession(input.attempts)
  const sessions = input.usage.sessions.map((session) => {
    const attempts = bySession.get(session.sessionID) ?? []
    const digest = input.digests.get(session.sessionID) ?? noFacts(session.sessionID)
    const allocation = allocationFor(session.sessionID, attempts, attemptsKey(attempts), digest)
    const candidates = allocation.identity
      ? input.currentIndex.pins.filter((pin) => pinMatches(pin, allocation.identity!))
      : []
    return sessionMarketValue({
      session,
      routeAllocation: allocation,
      candidates,
      progressTruncated: input.usage.coverage.progressTruncated,
      routeContextTruncated: input.usage.routeCoverage.truncatedContextSessionIDs.includes(
        session.sessionID,
      ),
    })
  })
  const contributions = sessions.flatMap((session) => {
    if (session.subtotalUSD === null) return []
    const parsed = decimal(session.subtotalUSD)
    return parsed ? [parsed] : []
  })
  let subtotal: Decimal = { coefficient: 0n, scale: 0 }
  for (const value of contributions) subtotal = addDecimal(subtotal, value)
  const numericSubtotal = contributions.length ? decimalNumber(subtotal) : null
  const overflow =
    sessions.some((session) => session.status === "unavailable") ||
    (contributions.length > 0 && numericSubtotal === null)
  const subtotalUSD = overflow ? null : numericSubtotal
  const anyValue = sessions.some((session) => session.subtotalUSD !== null)
  const allObserved =
    sessions.length > 0 && sessions.every((session) => session.status === "observed")
  const allMissing =
    sessions.length > 0 && sessions.every((session) => session.status === "missing")
  const status: TaskValuation["marketEquivalentCost"]["status"] = overflow
    ? "unavailable"
    : allObserved
      ? "observed"
      : allMissing
        ? "missing"
        : anyValue
          ? "partial"
          : sessions.length
            ? "partial"
            : "missing"
  const unpricedSessionIDs = sessions
    .filter((session) => session.status !== "observed")
    .map((session) => session.sessionID)
  return {
    valueUSD: status === "observed" ? subtotalUSD : null,
    subtotalUSD,
    unit: "USD" as const,
    status,
    basis: "supplied-current-price-index" as const,
    meaning:
      "Current-index market-equivalent valuation of observed worker-session token usage only. It is not reported worker cost, a provider invoice, a full-task cost, or an attribution to one model when routes are mixed or unresolved.",
    currentIndex: {
      indexID: input.currentIndex.indexID,
      retrievedAt: input.currentIndex.retrievedAt,
    },
    coverage: {
      totalUniqueSessions: sessions.length,
      pricedSessions: sessions.filter((session) => session.status === "observed").length,
      partialSessions: sessions.filter((session) => session.status === "partial").length,
      unpricedSessionIDs,
      progressTruncated: input.usage.coverage.progressTruncated,
      routeEvidence: input.usage.routeCoverage,
      routeHistory:
        "observed-session-and-retained-step-routes; full-call-coverage-not-guaranteed" as const,
    },
    sessions,
  }
}

export type ProjectTaskValuationInput = {
  attempts: AccountingAttempt[]
  /** Raw retained facts, or the per-session digests of an incremental read. */
  progressFacts: ProgressFactInput
  progressTruncated: boolean
  truncatedContextSessionIDs: readonly string[]
  currentIndex: CurrentPriceIndex
  /**
   * The usage and route coverage of exactly these attempts and facts, when the caller already
   * composed it, so one snapshot composes it once.
   */
  effort?: EffortUsageBasis
}

export type ProjectTaskValuationRequest = Omit<ProjectTaskValuationInput, "currentIndex">

function sameUsage(left: Record<string, unknown> | null, right: Record<string, unknown> | null) {
  return USAGE_CATEGORIES.every(
    (category) =>
      left?.[USAGE_FIELD_FOR_CATEGORY[category]] === right?.[USAGE_FIELD_FOR_CATEGORY[category]],
  )
}

function effortOf(input: ProjectTaskValuationRequest, digests: SessionFactDigests) {
  return (
    input.effort ??
    projectTaskEffortUsage({
      attempts: input.attempts,
      progressFacts: digests,
      progressTruncated: input.progressTruncated,
      truncatedContextSessionIDs: input.truncatedContextSessionIDs,
    })
  )
}

/** The priced calls of one session, assuming its single observed route is the one asked about. */
type SessionCalls = {
  rows: Array<{ ord: number; call: KnownUsagePerCall }>
  /** A call of the session cannot be priced for that route. */
  incomplete: boolean
  totals: Record<UsageCategory, number>
}

function sessionCalls(
  sessionID: string,
  digest: SessionFactDigest,
  evidence: RouteEvidence,
  identity: NonNullable<ReturnType<typeof sourceRouteIdentity>>,
): SessionCalls {
  const rows: SessionCalls["rows"] = []
  let incomplete = false
  const totals = Object.fromEntries(USAGE_CATEGORIES.map((category) => [category, 0])) as Record<
    UsageCategory,
    number
  >
  for (const call of digest.valuation.calls) {
    const routeEvidence = evidence.calls.get(callKey(sessionID, call.messageID))
    const distinctRoutes = new Map<string, AccountingRoute>()
    for (const observed of routeEvidence?.routes ?? []) {
      const observedIdentity = sourceRouteIdentity(observed)
      if (observedIdentity) distinctRoutes.set(routeKey(observedIdentity), observed)
    }
    if (
      routeEvidence?.unavailable ||
      !routeEvidence ||
      distinctRoutes.size !== 1 ||
      routeEvidence.routes.length === 0
    ) {
      incomplete = true
      continue
    }
    const observedIdentity = sourceRouteIdentity([...distinctRoutes.values()][0]!)
    if (!observedIdentity) {
      incomplete = true
      continue
    }
    if (
      observedIdentity.providerID !== identity.providerID ||
      observedIdentity.modelID !== identity.modelID ||
      observedIdentity.variant !== identity.variant
    ) {
      // A different exact route is evidence of a mixed-call session, not a selector for this route.
      incomplete = true
      continue
    }
    if (call.usageDiffers) incomplete = true
    if (Object.values(call.categories).some((value) => value === null)) {
      incomplete = true
      continue
    }
    rows.push({
      ord: call.ord,
      call: {
        callID: `${sessionID}\u0000${call.messageID}`,
        route: observedIdentity,
        categories: call.categories as Record<UsageCategory, number>,
      },
    })
    for (const category of USAGE_CATEGORIES) totals[category] += call.categories[category]!
  }
  return { rows, incomplete, totals }
}

type PerCallIndex = {
  /** No route can be complete: truncated facts, calls nobody owns, or calls without one route. */
  blocked: boolean
  /** The selected sessions whose one observed route is the key, with their calls if any. */
  byRoute: Map<
    string,
    Array<{ session: TaskValuation["usage"]["sessions"][number]; calls: SessionCalls | undefined }>
  >
}

/** Route-independent state of one request: built once, then each route reads only its sessions. */
const perCallIndexes = new WeakMap<ProjectTaskValuationRequest, PerCallIndex>()

function perCallIndex(input: ProjectTaskValuationRequest): PerCallIndex {
  const cached = perCallIndexes.get(input)
  if (cached) return cached
  const digests = digestsOf(input.progressFacts)
  const usage = projectUsage(effortOf(input, digests))
  const bySession = attemptsBySession(input.attempts)
  const selected = new Set(usage.sessions.map((session) => session.sessionID))
  let blocked = input.progressTruncated
  const callsBySession = new Map<string, SessionCalls>()
  for (const [sessionID, digest] of digests) {
    if (digest.valuation.unscopedAdditive) blocked = true
    if (!digest.valuation.calls.length) continue
    // Calls of a session no selected attempt owns cannot be attributed to any route.
    if (!sessionID || !selected.has(sessionID)) {
      blocked = true
      continue
    }
    const attempts = bySession.get(sessionID) ?? []
    const key = attemptsKey(attempts)
    const allocation = allocationFor(sessionID, attempts, key, digest)
    if (allocation.status !== "single-observed-route" || !allocation.identity) {
      blocked = true
      continue
    }
    const identity = allocation.identity
    callsBySession.set(
      sessionID,
      memoizedOnDigest(digest, `calls:${key}`, () =>
        sessionCalls(sessionID, digest, evidenceFor(sessionID, attempts, key, digest), identity),
      ),
    )
  }
  const byRoute: PerCallIndex["byRoute"] = new Map()
  for (const session of usage.sessions) {
    const attempts = bySession.get(session.sessionID) ?? []
    const digest = digests.get(session.sessionID) ?? noFacts(session.sessionID)
    const allocation = allocationFor(session.sessionID, attempts, attemptsKey(attempts), digest)
    if (allocation.status !== "single-observed-route" || !allocation.identity) continue
    const route = routeKey(allocation.identity)
    const entry = { session, calls: callsBySession.get(session.sessionID) }
    const group = byRoute.get(route)
    if (group) group.push(entry)
    else byRoute.set(route, [entry])
  }
  const index = { blocked, byRoute }
  perCallIndexes.set(input, index)
  return index
}

/** Deduplicate retained additive call measurements and require exact route/category evidence. */
export function taskValuationPerCallUsage(
  input: ProjectTaskValuationRequest,
  route: MarketRangeRoute,
): { calls: KnownUsagePerCall[]; complete: boolean } {
  const index = perCallIndex(input)
  const matched = index.byRoute.get(routeKey(route)) ?? []
  let complete = !index.blocked
  const rows: SessionCalls["rows"] = []
  let sessionsWithCalls = 0
  for (const { session, calls } of matched) {
    if (calls) {
      if (calls.incomplete) complete = false
      if (calls.rows.length) sessionsWithCalls++
      rows.push(...calls.rows)
    }
    for (const category of USAGE_CATEGORIES) {
      const measure = session.categories[category]
      if (
        measure.status !== "observed" ||
        measure.value === null ||
        (calls?.totals[category] ?? 0) !== measure.value
      )
        complete = false
    }
  }
  // Each session's calls are in call order; calls come out in the order they first appeared.
  if (sessionsWithCalls > 1) rows.sort((left, right) => left.ord - right.ord)
  return { calls: rows.map((row) => row.call), complete }
}

/** Build price selectors from the same deduplicated usage and exact route allocation as valuation. */
export function taskValuationApplicabilities(
  input: ProjectTaskValuationRequest,
): CurrentPriceApplicability[] {
  const digests = digestsOf(input.progressFacts)
  const usage = projectUsage(effortOf(input, digests))
  const bySession = attemptsBySession(input.attempts)
  return usage.sessions.flatMap((session) => {
    const attempts = bySession.get(session.sessionID) ?? []
    const digest = digests.get(session.sessionID) ?? noFacts(session.sessionID)
    const allocation = allocationFor(session.sessionID, attempts, attemptsKey(attempts), digest)
    if (allocation.status !== "single-observed-route" || !allocation.identity) return []
    return [
      {
        route: allocation.identity,
        usage: Object.fromEntries(
          USAGE_CATEGORIES.map((category) => {
            const measure = session.categories[category]
            return [category, { value: measure.value, status: measure.status }]
          }),
        ) as NonNullable<CurrentPriceApplicability["usage"]>,
      },
    ]
  })
}

/** Revalue one deduplicated effort projection from explicitly supplied current product/price pins. */
export function projectTaskValuation(input: ProjectTaskValuationInput): TaskValuation {
  const currentIndex = CurrentPriceIndexSchema.parse(input.currentIndex)
  const digests = digestsOf(input.progressFacts)
  const effort = effortOf(input, digests)
  const usage = projectUsage(effort)
  const costFacts = costContributions({
    attempts: input.attempts,
    digests,
    sessions: effort.usage.sessions,
  })
  const output = {
    schemaVersion: 1 as const,
    usage,
    reportedWorkerCost: reportedWorkerCost(costFacts),
    marketEquivalentCost: marketEquivalentCost({
      usage,
      attempts: input.attempts,
      digests,
      currentIndex,
    }),
    architectReviewIntegrationOverheadUSD: {
      valueUSD: null,
      status: "unallocated" as const,
      components: ["Architect", "review", "integration"] as ["Architect", "review", "integration"],
    },
  }
  return TaskValuationSchema.parse(output)
}
