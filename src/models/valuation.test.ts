import { expect, test } from "bun:test"
import type { AccountingAttempt, AccountingRoute } from "../trajectory/accounting.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { projectProgressFact } from "../progress/projection.ts"
import { makeFixture, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { projectTaskValuation } from "./valuation.ts"
import type { CurrentPriceIndex } from "./valuation-schema.ts"
import {
  nativeMillionTokenIndex,
  openRouterPerTokenIndex,
  repricedOpenRouterIndex,
} from "../../test/models-valuation/fixtures/current-indexes.ts"

const route: AccountingRoute = {
  providerID: "openrouter",
  modelID: "vendor/model",
  variant: null,
}

function attempt(overrides: Partial<AccountingAttempt> = {}): AccountingAttempt {
  return {
    id: "attempt-a",
    sessionID: "session-a",
    state: "failed",
    legacyTokenCount: 999,
    recordedCostUSD: 0.75,
    planRoute: route,
    planRouteStatus: "explicit",
    frozenRoute: route,
    frozenRouteSource: "runner_attempt.policy.model",
    personaRequested: null,
    personaFrozen: null,
    sessionStatus: "available",
    contextStatus: "available",
    currentRoute: route,
    currentRouteObservedAt: 1_000,
    sessionUsage: {
      input: 60,
      output: 15,
      reasoning: 5,
      cacheRead: 30,
      cacheWrite: 10,
    },
    sessionUsageObservedAt: 1_000,
    stepRoutes: [],
    ...overrides,
  }
}

function usageSnapshot(input: {
  id: string
  sequence: number
  sessionID?: string
  at: number
  costUSD: number | null
  measurementBasis?: string
}) {
  return {
    id: input.id,
    sequence: input.sequence,
    sessionID: input.sessionID ?? "session-a",
    attemptID: "attempt-a",
    kind: "worker-usage-snapshot",
    at: input.at,
    recordedAt: input.at + 1,
    measurementBasis: input.measurementBasis ?? "cumulative-session-snapshot",
    usage: {
      input: 60,
      output: 15,
      reasoning: 5,
      cacheRead: 30,
      cacheWrite: 10,
      costUSD: input.costUSD,
    },
  }
}

function stepCost(input: { id: string; messageID: string; at: number; costUSD: number | null }) {
  return {
    id: input.id,
    sequence: input.at,
    sessionID: "session-a",
    attemptID: "attempt-a",
    messageID: input.messageID,
    kind: "worker-step",
    at: input.at,
    recordedAt: input.at + 1,
    measurementBasis: "additive-step-measurement",
    usage: { input: 1, output: 1, costUSD: input.costUSD },
  }
}

function progressStep(route: unknown, id = "progress-step") {
  return {
    id,
    sequence: 1,
    sessionID: "session-a",
    attemptID: "attempt-a",
    messageID: "step-one",
    kind: "worker-step",
    at: 1_100,
    recordedAt: 1_101,
    measurementBasis: "additive-step-measurement",
    usage: { input: 1, output: 1 },
    route,
    observations: [
      {
        source: "native-event",
        eventType: "session.step.started",
        at: 1_100,
        messageID: "step-one",
        route,
      },
    ],
  }
}

function projectedStepLifecycleFacts(
  steps: Array<{
    messageID: string
    lifecycleType: "session.step.streamed" | "session.step.ended" | "session.step.failed"
    route?: AccountingRoute
  }>,
) {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    for (const [index, step] of steps.entries()) {
      const record = (type: string, suffix: string, model?: Record<string, unknown>) =>
        recorder.recordNativeEvent({
          id: `evt-${step.messageID}-${suffix}`,
          type,
          created: 10_000 + index * 100 + (suffix === "start" ? 0 : 1),
          data: {
            sessionID: "ses-failed",
            assistantMessageID: step.messageID,
            ...(model ? { model } : {}),
          },
        })
      record(
        "session.step.started",
        "start",
        step.route
          ? {
              providerID: step.route.providerID,
              id: step.route.modelID,
              ...(step.route.variant === null ? {} : { variant: step.route.variant }),
            }
          : undefined,
      )
      record(step.lifecycleType, "lifecycle")
    }
    return fixture.store.progressFacts([firstAttemptID]).map(projectProgressFact)
  } finally {
    fixture.close()
  }
}

function project(
  attempts: AccountingAttempt[] = [attempt()],
  progressFacts: unknown[] = [],
  currentIndex: CurrentPriceIndex = nativeMillionTokenIndex,
  progressTruncated = false,
  truncatedContextSessionIDs: string[] = [],
) {
  return projectTaskValuation({
    attempts,
    progressFacts,
    progressTruncated,
    truncatedContextSessionIDs,
    currentIndex,
  })
}

test("prices each public token category once with exact units and visible output plus reasoning", () => {
  const native = project()
  const router = project([attempt()], [], openRouterPerTokenIndex)

  expect(native.marketEquivalentCost.valueUSD).toBe(0.000346)
  expect(router.marketEquivalentCost.valueUSD).toBe(0.000346)
  expect(native.marketEquivalentCost.sessions[0]?.categories).toMatchObject({
    uncachedInput: { tokens: 60, rateUSDPerToken: 0.000002, valueUSD: 0.00012 },
    output: { tokens: 15, rateUSDPerToken: 0.00001, valueUSD: 0.00015 },
    reasoning: { tokens: 5, rateUSDPerToken: 0.00001, valueUSD: 0.00005 },
    cacheRead: { tokens: 30, rateUSDPerToken: 0.0000002, valueUSD: 0.000006 },
    cacheWrite: { tokens: 10, rateUSDPerToken: 0.000002, valueUSD: 0.00002 },
  })
  expect(native.marketEquivalentCost.status).toBe("observed")
  expect(native.marketEquivalentCost.sessions[0]?.pinCandidates[0]).toMatchObject({
    semantics: "quote",
    rates: { unit: "USD per million tokens" },
    provenance: { source: "native-catalog" },
  })
  expect(router.marketEquivalentCost.sessions[0]?.pinCandidates[0]).toMatchObject({
    semantics: "average",
    productID: "vendor/model",
    configurationID: "vendor/model-default",
    rates: { unit: "USD per token" },
    provenance: { source: "openrouter-models" },
  })
})

test("reprices identical deduplicated usage from the supplied current index without changing reported cost", () => {
  const progress = [
    usageSnapshot({ id: "snapshot-old", sequence: 1, at: 1_100, costUSD: 0.6 }),
    usageSnapshot({ id: "snapshot-current", sequence: 2, at: 1_200, costUSD: 0.75 }),
    stepCost({ id: "step-cost", messageID: "message-one", at: 1_150, costUSD: 0.25 }),
  ]
  const attempts = [
    attempt({ id: "attempt-failed", state: "failed", recordedCostUSD: 0.25 }),
    attempt({ id: "attempt-retry", state: "accepted", recordedCostUSD: 0.5 }),
  ]
  const before = project(attempts, progress, nativeMillionTokenIndex)
  const after = project(attempts, progress, repricedOpenRouterIndex)

  expect(before.marketEquivalentCost.valueUSD).toBe(0.000346)
  expect(after.marketEquivalentCost.valueUSD).toBe(0.000692)
  expect(after.usage).toEqual(before.usage)
  expect(after.reportedWorkerCost).toEqual(before.reportedWorkerCost)
  expect(before.reportedWorkerCost).toMatchObject({
    valueUSD: 0.75,
    subtotalUSD: 0.75,
    status: "observed",
    totalUniqueSessions: 1,
    cumulativeSessions: 1,
    additiveSubtotalSessions: 0,
  })
  expect(before.reportedWorkerCost.contributions).toHaveLength(1)
  expect(before.reportedWorkerCost.contributions[0]).toMatchObject({
    valueUSD: 0.75,
    basis: "cumulative-session-snapshot",
    ignoredAdditiveStepCount: 1,
  })
  const attemptScalarOnly = project(attempts, [], nativeMillionTokenIndex)
  expect(attemptScalarOnly.reportedWorkerCost).toMatchObject({
    valueUSD: 0.5,
    subtotalUSD: 0.5,
    status: "observed",
    totalUniqueSessions: 1,
    cumulativeSessions: 1,
  })
  expect(attemptScalarOnly.reportedWorkerCost.contributions).toHaveLength(1)
  expect(attemptScalarOnly.reportedWorkerCost.contributions[0]).toMatchObject({
    valueUSD: 0.5,
    basis: "attempt-session-cumulative-snapshot",
    measurementCount: 2,
  })
  expect(before.marketEquivalentCost.sessions[0]?.pinCandidates[0]?.provenance).toMatchObject({
    source: "native-catalog",
    retrievedAt: "2026-11-03T12:00:00.000Z",
  })
  expect(after.marketEquivalentCost.sessions[0]?.pinCandidates[0]?.provenance).toMatchObject({
    source: "openrouter-models",
    retrievedAt: "2026-11-03T16:00:00.000Z",
  })
  expect(before.usage.sessions[0]).toMatchObject({
    attemptIDs: ["attempt-failed", "attempt-retry"],
    attemptStates: ["failed", "accepted"],
    categories: { uncachedInput: { value: 60 } },
  })
  expect(before.reportedWorkerCost.meaning).toContain("not invoice-confirmed")
  expect(before.marketEquivalentCost.meaning).toContain("a full-task cost")
})

test("falls back only to a labelled unique-step cost subtotal when cumulative cost is absent", () => {
  const result = project(
    [attempt({ recordedCostUSD: null })],
    [
      stepCost({ id: "first-copy", messageID: "step-one", at: 100, costUSD: 0.25 }),
      stepCost({ id: "duplicate-copy", messageID: "step-one", at: 200, costUSD: 0.25 }),
      stepCost({ id: "step-two", messageID: "step-two", at: 300, costUSD: 0.125 }),
    ],
  )

  expect(result.reportedWorkerCost).toMatchObject({
    valueUSD: null,
    subtotalUSD: 0.375,
    status: "partial",
    totalUniqueSessions: 1,
    cumulativeSessions: 0,
    additiveSubtotalSessions: 1,
  })
  expect(result.reportedWorkerCost.contributions[0]).toMatchObject({
    valueUSD: 0.375,
    basis: "retained-additive-step-subtotal",
    measurementCount: 2,
  })
  expect(result.reportedWorkerCost.selection).toContain("additive-step subtotal")
})

test("keeps missing usage and missing rates distinct from a known zero", () => {
  const index: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  index.pins[0]!.rates.uncachedInput = null
  index.pins[0]!.rates.cacheRead = null
  const result = project(
    [
      attempt({
        sessionUsage: {
          input: 60,
          output: 15,
          reasoning: 5,
          cacheRead: 0,
          cacheWrite: 10,
        },
      }),
    ],
    [],
    index,
  )

  expect(result.marketEquivalentCost.valueUSD).toBeNull()
  expect(result.marketEquivalentCost.status).toBe("partial")
  expect(result.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
    tokens: 60,
    valueUSD: null,
    status: "unknown",
  })
  expect(result.marketEquivalentCost.sessions[0]?.categories.cacheRead).toMatchObject({
    tokens: 0,
    valueUSD: 0,
    status: "zero-usage",
  })

  const missingUsage = project([
    attempt({
      sessionUsage: { input: null, output: 15, reasoning: 5, cacheRead: 30, cacheWrite: 10 },
    }),
  ])
  expect(missingUsage.usage.sessions[0]?.categories.uncachedInput).toMatchObject({
    value: null,
    status: "missing",
  })
  expect(missingUsage.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
    tokens: null,
    valueUSD: null,
    status: "unknown",
  })
})

test("unresolved SKU, configuration, tier, or schedule never applies a supplied rate", () => {
  for (const field of ["sku", "configuration", "tier", "schedule"] as const) {
    const index: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
    index.pins[0]!.resolution[field] = "unresolved"
    const result = project([attempt()], [], index)
    expect(result.marketEquivalentCost.sessions[0]?.pinStatus).toBe("unresolved")
    expect(result.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
      valueUSD: null,
      status: "unknown",
    })
    expect(result.marketEquivalentCost.valueUSD).toBeNull()
  }

  const missingConfiguration: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  missingConfiguration.pins[0]!.configurationID = null
  const unresolved = project([attempt()], [], missingConfiguration)
  expect(unresolved.marketEquivalentCost.sessions[0]?.pinStatus).toBe("unresolved")
  expect(unresolved.marketEquivalentCost.sessions[0]?.categories.uncachedInput.status).toBe(
    "unknown",
  )
})

test("mixed, unavailable, or identity-lost observed routes do not inherit the assigned route price", () => {
  const mixed = project([
    attempt({
      stepRoutes: [
        {
          messageID: "step-b",
          route: { providerID: "openai", modelID: "other-model", variant: null },
          observedAt: 2_000,
        },
      ],
    }),
  ])
  expect(mixed.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
    "mixed-observed-routes",
  )
  expect(mixed.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
    status: "unknown",
    valueUSD: null,
  })

  const identityLost = project([attempt({ currentRoute: { ...route, identity: null } })])
  expect(identityLost.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
    "identity-unavailable",
  )
  expect(identityLost.marketEquivalentCost.valueUSD).toBeNull()

  const noRoute = project([attempt({ currentRoute: null, stepRoutes: [] })])
  expect(noRoute.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe("unavailable")
  expect(noRoute.marketEquivalentCost.sessions[0]?.categories.uncachedInput.status).toBe("unknown")
})

test("retained progress routes participate in exact session allocation without multiplying usage", () => {
  const routeB: AccountingRoute = {
    providerID: "openai",
    modelID: "other-model",
    variant: null,
  }
  const index: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  index.pins.push({
    ...structuredClone(index.pins[0]!),
    route: routeB,
    productID: "other-model",
    configurationID: "other-model-default",
    rates: {
      unit: "USD per million tokens",
      uncachedInput: 3,
      completion: 20,
      cacheRead: 0.1,
      cacheWrite: 1,
    },
  })

  const mixed = project([attempt()], [progressStep(routeB)], index)
  expect(mixed.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
    "mixed-observed-routes",
  )
  expect(mixed.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual([])
  expect(mixed.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
    tokens: 60,
    valueUSD: null,
    status: "unknown",
  })
  expect(mixed.marketEquivalentCost.valueUSD).toBeNull()
  expect(mixed.marketEquivalentCost.sessions[0]?.valueUSD).toBeNull()

  const progressOnly = project(
    [attempt({ currentRoute: null, stepRoutes: [] })],
    [progressStep(routeB)],
    index,
  )
  expect(progressOnly.marketEquivalentCost.sessions[0]?.routeAllocation).toMatchObject({
    status: "single-observed-route",
    route: routeB,
  })
  expect(progressOnly.marketEquivalentCost.sessions[0]?.pinCandidates).toHaveLength(1)
  expect(progressOnly.marketEquivalentCost.sessions[0]?.pinCandidates[0]?.route).toEqual(routeB)
  expect(progressOnly.marketEquivalentCost.valueUSD).toBe(0.000593)

  const duplicateA = project(
    [
      attempt({
        stepRoutes: [{ messageID: "step-one", route, observedAt: 1_100 }],
      }),
    ],
    [progressStep(route)],
  )
  expect(duplicateA.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
    "single-observed-route",
  )
  expect(duplicateA.usage.sessions[0]?.categories.uncachedInput.value).toBe(60)
  expect(duplicateA.marketEquivalentCost.valueUSD).toBe(0.000346)
})

test("production-projected route-less lifecycle observations preserve retained start routes", () => {
  const progress = projectedStepLifecycleFacts([
    { messageID: "msg-streamed", lifecycleType: "session.step.streamed", route },
    { messageID: "msg-ended", lifecycleType: "session.step.ended", route },
    { messageID: "msg-failed", lifecycleType: "session.step.failed", route },
  ])
  expect(progress).toHaveLength(3)
  for (const fact of progress) {
    expect(fact).toMatchObject({ route, sessionID: "ses-failed" })
    expect(fact.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "session.step.started", route }),
        expect.objectContaining({ route: null }),
      ]),
    )
  }

  const attempts = [attempt({ sessionID: "ses-failed", currentRoute: null })]
  const baseline = project(attempts)
  const result = project(attempts, progress)
  expect(result.marketEquivalentCost.sessions[0]?.routeAllocation).toMatchObject({
    status: "single-observed-route",
    route,
    observedRouteCount: 3,
  })
  expect(result.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual(
    nativeMillionTokenIndex.pins,
  )
  expect(result.marketEquivalentCost.valueUSD).toBe(0.000346)
  expect(result.usage.categories).toEqual(baseline.usage.categories)
  expect(result.usage.sessions[0]?.categories).toEqual(baseline.usage.sessions[0]?.categories)
  expect(result.reportedWorkerCost).toEqual(baseline.reportedWorkerCost)
})

test("a production-projected unresolved start stays unallocated despite the current route", () => {
  const progress = projectedStepLifecycleFacts([
    { messageID: "msg-unresolved", lifecycleType: "session.step.ended" },
  ])
  const result = project([attempt({ sessionID: "ses-failed" })], progress)

  expect(result.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
    "identity-unavailable",
  )
  expect(result.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual([])
  expect(result.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
    tokens: 60,
    valueUSD: null,
    status: "unknown",
  })
  expect(result.marketEquivalentCost.valueUSD).toBeNull()
})

test("retained progress with unknown route identities stays unallocated", () => {
  const unknownRoutes: unknown[] = [
    null,
    { providerID: "openrouter" },
    { providerID: "openrouter", modelID: "vendor/model…[truncated]", variant: null },
    { providerID: "openrouter[REDACTED]", modelID: "vendor/model", variant: null },
    { providerID: "openrouter", modelID: "vendor/model", variant: null, identity: null },
  ]

  for (const [index, progressRoute] of unknownRoutes.entries()) {
    const result = project([attempt()], [progressStep(progressRoute, `unknown-${index}`)])
    expect(result.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
      "identity-unavailable",
    )
    expect(result.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual([])
    expect(result.marketEquivalentCost.valueUSD).toBeNull()
  }

  const mismatchedLifecycle = {
    ...progressStep(null, "unrelated-lifecycle"),
    observations: [
      {
        source: "native-event",
        eventType: "session.step.ended",
        at: 1_100,
        messageID: "another-message",
        route: null,
      },
    ],
  }
  const mismatched = project([attempt()], [mismatchedLifecycle])
  expect(mismatched.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
    "identity-unavailable",
  )
  expect(mismatched.marketEquivalentCost.valueUSD).toBeNull()
})

test("ambiguous current pins are not resolved by source preference or record order", () => {
  const index: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  index.pins.push(structuredClone(index.pins[0]!))
  const result = project([attempt()], [], index)

  expect(result.marketEquivalentCost.sessions[0]?.pinStatus).toBe("ambiguous")
  expect(result.marketEquivalentCost.sessions[0]?.pinCandidates).toHaveLength(2)
  expect(result.marketEquivalentCost.sessions[0]?.categories.uncachedInput.status).toBe("unknown")
  expect(result.marketEquivalentCost.valueUSD).toBeNull()
})

test("route matching includes variant and does not borrow a same-model pin for another configuration", () => {
  const index: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  index.pins[0]!.route!.variant = "high"
  const result = project([attempt()], [], index)

  expect(result.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
    "single-observed-route",
  )
  expect(result.marketEquivalentCost.sessions[0]?.pinStatus).toBe("missing")
  expect(result.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
    valueUSD: null,
    status: "unknown",
  })
})

test("truncated route context retains the priced subtotal but does not present it as a complete value", () => {
  const result = project([attempt()], [], nativeMillionTokenIndex, false, ["session-a"])

  expect(result.marketEquivalentCost).toMatchObject({
    valueUSD: null,
    subtotalUSD: 0.000346,
    status: "partial",
    coverage: {
      routeEvidence: { truncatedContextSessionIDs: ["session-a"] },
    },
  })
})

test("nonfinite monetary multiplication is unavailable and never serialized as a fabricated total", () => {
  const index: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  index.pins[0]!.rates.unit = "USD per token"
  index.pins[0]!.rates.uncachedInput = "1e308"
  const result = project(
    [
      attempt({
        sessionUsage: {
          input: Number.MAX_VALUE,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      }),
    ],
    [],
    index,
  )

  expect(result.marketEquivalentCost.valueUSD).toBeNull()
  expect(result.marketEquivalentCost.subtotalUSD).toBeNull()
  expect(result.marketEquivalentCost.status).toBe("unavailable")
  expect(result.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
    valueUSD: null,
    status: "unavailable",
  })
  expect(JSON.stringify(result)).not.toContain("Infinity")
})
