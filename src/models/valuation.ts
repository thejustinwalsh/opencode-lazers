import {
  projectTaskEffortBasis,
  type AccountingAttempt,
  type AccountingRoute,
} from "../trajectory/accounting.ts"
import { CurrentPriceIndexSchema, TaskValuationSchema } from "./valuation-schema.ts"
import type { CurrentPriceIndex, CurrentPricePin, TaskValuation } from "./valuation-schema.ts"

type Decimal = { coefficient: bigint; scale: number }
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

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function decimal(value: number | string): Decimal | null {
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

function addDecimal(left: Decimal, right: Decimal): Decimal {
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

function multiplyDecimal(left: Decimal, right: Decimal): Decimal {
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

function decimalNumber(value: Decimal): number | null {
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

function sessionRouteAllocation(attempts: AccountingAttempt[]) {
  const exact = new Map<
    string,
    { identity: NonNullable<ReturnType<typeof sourceRouteIdentity>>; route: AccountingRoute }
  >()
  let unavailableIdentityCount = 0
  let observedCount = 0
  for (const attempt of attempts) {
    const routes = [
      ...(attempt.sessionStatus === "available" && attempt.currentRoute
        ? [attempt.currentRoute]
        : []),
      ...attempt.stepRoutes.map((step) => step.route),
    ]
    for (const route of routes) {
      observedCount++
      const identity = sourceRouteIdentity(route)
      if (!identity) {
        unavailableIdentityCount++
        continue
      }
      exact.set(routeKey(identity), { identity, route })
    }
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

function pinBlockers(pin: CurrentPricePin): string[] {
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

function parseProgressFacts(values: readonly unknown[]): ProgressFact[] {
  return values.flatMap((raw) => {
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
      },
    ]
  })
}

function compareFacts(left: ProgressFact, right: ProgressFact) {
  return (
    (right.at ?? Number.MIN_SAFE_INTEGER) - (left.at ?? Number.MIN_SAFE_INTEGER) ||
    (right.recordedAt ?? Number.MIN_SAFE_INTEGER) - (left.recordedAt ?? Number.MIN_SAFE_INTEGER) ||
    (right.sequence ?? Number.MIN_SAFE_INTEGER) - (left.sequence ?? Number.MIN_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  )
}

function costContributions(input: {
  attempts: AccountingAttempt[]
  progressFacts: readonly unknown[]
  sessions: ReturnType<typeof projectTaskEffortBasis>["usage"]["sessions"]
}) {
  const facts = parseProgressFacts(input.progressFacts)
  return input.sessions.map((session) => {
    const attempts = input.attempts.filter((attempt) => attempt.sessionID === session.sessionID)
    const sessionFacts = facts.filter((fact) => fact.sessionID === session.sessionID)
    const cumulative = sessionFacts
      .filter(
        (fact) =>
          fact.kind === "usage-snapshot" && fact.measurementBasis === "cumulative-session-snapshot",
      )
      .sort(compareFacts)[0]
    const additiveByIdentity = new Map<string, ProgressFact>()
    for (const fact of sessionFacts) {
      if (fact.kind !== "step" || fact.measurementBasis !== "additive-step-measurement") continue
      const identity = fact.messageID ?? fact.id
      const previous = additiveByIdentity.get(identity)
      if (!previous || compareFacts(previous, fact) > 0) additiveByIdentity.set(identity, fact)
    }
    const additiveSteps = [...additiveByIdentity.values()]
    const cumulativeValue = cumulative?.usage?.costUSD
    const cumulativeCost =
      typeof cumulativeValue === "number" &&
      Number.isFinite(cumulativeValue) &&
      cumulativeValue >= 0
        ? cumulativeValue
        : null
    if (
      cumulative &&
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
        ignoredAdditiveStepCount: additiveSteps.length,
      }
    }
    if (cumulativeCost !== null) {
      return {
        sessionID: session.sessionID,
        attemptIDs: session.attemptIDs,
        basis: "cumulative-session-snapshot" as const,
        valueUSD: cumulativeCost,
        status: "observed" as const,
        source: "runner-progress-store cumulative session snapshot",
        measurementCount: 1,
        missingMeasurements: 0,
        ignoredAdditiveStepCount: additiveSteps.length,
      }
    }

    const attemptCosts = attempts.flatMap((attempt) => {
      const cost = attempt.recordedCostUSD
      if (cost === null) return []
      return [{ value: cost, valid: Number.isFinite(cost) && cost >= 0 }]
    })
    if (attemptCosts.some((cost) => !cost.valid)) {
      return {
        sessionID: session.sessionID,
        attemptIDs: session.attemptIDs,
        basis: "unavailable" as const,
        valueUSD: null,
        status: "unavailable" as const,
        source: "runner_attempt.cost contains a nonfinite or negative contribution",
        measurementCount: attemptCosts.length,
        missingMeasurements: 0,
        ignoredAdditiveStepCount: additiveSteps.length,
      }
    }
    if (attemptCosts.length) {
      return {
        sessionID: session.sessionID,
        attemptIDs: session.attemptIDs,
        basis: "attempt-session-cumulative-snapshot" as const,
        valueUSD: attemptCosts.reduce((largest, cost) => Math.max(largest, cost.value), 0),
        status: "observed" as const,
        source:
          "largest retained runner_attempt.cost for this unique session; contributions are not summed",
        measurementCount: attemptCosts.length,
        missingMeasurements: 0,
        ignoredAdditiveStepCount: additiveSteps.length,
      }
    }

    if (additiveSteps.length) {
      let subtotal: Decimal = { coefficient: 0n, scale: 0 }
      let observed = 0
      let missing = 0
      let invalid = false
      for (const step of additiveSteps) {
        const value = step.usage?.costUSD
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
        valueUSD: observed ? subtotalUSD : null,
        status: observed ? ("partial" as const) : ("missing" as const),
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
  const status = overflow
    ? "unavailable"
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

function projectUsage(effort: ReturnType<typeof projectTaskEffortBasis>): TaskValuation["usage"] {
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
  const blockers = pin ? pinBlockers(pin) : []
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
  currentIndex: CurrentPriceIndex
}) {
  const sessions = input.usage.sessions.map((session) => {
    const attempts = input.attempts.filter((attempt) => attempt.sessionID === session.sessionID)
    const allocation = sessionRouteAllocation(attempts)
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
  progressFacts: readonly unknown[]
  progressTruncated: boolean
  truncatedContextSessionIDs: readonly string[]
  currentIndex: CurrentPriceIndex
}

/** Revalue one deduplicated effort projection from explicitly supplied current product/price pins. */
export function projectTaskValuation(input: ProjectTaskValuationInput): TaskValuation {
  const currentIndex = CurrentPriceIndexSchema.parse(input.currentIndex)
  const effort = projectTaskEffortBasis({
    attempts: input.attempts,
    progressFacts: input.progressFacts,
    progressTruncated: input.progressTruncated,
    truncatedContextSessionIDs: input.truncatedContextSessionIDs,
  })
  const usage = projectUsage(effort)
  const costFacts = costContributions({
    attempts: input.attempts,
    progressFacts: input.progressFacts,
    sessions: effort.usage.sessions,
  })
  const output = {
    schemaVersion: 1 as const,
    usage,
    reportedWorkerCost: reportedWorkerCost(costFacts),
    marketEquivalentCost: marketEquivalentCost({
      usage,
      attempts: input.attempts,
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
