import { expect, test } from "bun:test"
import { projectTaskEffortBasis } from "./accounting.ts"
import type { AccountingAttempt, AccountingRoute } from "./accounting.ts"

const routeA: AccountingRoute = {
  providerID: "openai",
  modelID: "model-a",
  variant: "high",
}
const routeB: AccountingRoute = {
  providerID: "anthropic",
  modelID: "model-b",
  variant: null,
}

function attempt(overrides: Partial<AccountingAttempt> = {}): AccountingAttempt {
  return {
    id: "attempt-a",
    sessionID: "session-a",
    state: "failed",
    legacyTokenCount: 99,
    recordedCostUSD: null,
    planRoute: routeA,
    planRouteStatus: "explicit",
    frozenRoute: routeA,
    frozenRouteSource: "runner_attempt.policy.model",
    personaRequested: "ui",
    personaFrozen: "ui",
    sessionStatus: "available",
    contextStatus: "available",
    currentRoute: routeA,
    currentRouteObservedAt: 500,
    sessionUsage: {
      input: 4,
      output: 2,
      reasoning: 1,
      cacheRead: 3,
      cacheWrite: 0,
    },
    sessionUsageObservedAt: 500,
    stepRoutes: [],
    ...overrides,
  }
}

function progressFact(input: {
  id: string
  sequence: number
  attemptID?: string
  sessionID?: string
  kind: "worker-usage-snapshot" | "worker-step"
  at: number
  messageID?: string | null
  usage: Record<string, unknown>
  measurementBasis: "cumulative-session-snapshot" | "additive-step-measurement"
  route?: AccountingRoute
}) {
  const routeObservation = input.route
    ? {
        source: "native-event",
        eventID: `evt-${input.id}`,
        eventType: "session.step.started",
        at: input.at,
        messageID: input.messageID ?? null,
        route: input.route,
      }
    : null
  return {
    id: `progress:${input.id}`,
    sequence: input.sequence,
    attemptID: input.attemptID ?? "attempt-a",
    sessionID: input.sessionID ?? "session-a",
    kind: input.kind,
    source: "native-event",
    sources: ["native-event"],
    at: input.at,
    recordedAt: input.at + 10,
    messageID: input.messageID ?? null,
    eventIDs: [`evt-${input.id}`],
    measurementBasis: input.measurementBasis,
    usage: input.usage,
    ...(input.route ? { route: input.route } : {}),
    ...(routeObservation ? { observations: [routeObservation] } : {}),
  }
}

function project(
  attempts: AccountingAttempt[],
  facts: unknown[] = [],
  options: { progressTruncated?: boolean; truncatedContextSessionIDs?: string[] } = {},
) {
  return projectTaskEffortBasis({
    attempts,
    progressFacts: facts,
    progressTruncated: options.progressTruncated ?? false,
    truncatedContextSessionIDs: options.truncatedContextSessionIDs ?? [],
  })
}

test("shared-session steps compare only with their exact retained attempt owner", () => {
  const first = attempt({
    id: "attempt-a",
    planRoute: routeA,
    frozenRoute: routeA,
    currentRoute: routeB,
  })
  const second = attempt({
    id: "attempt-b",
    planRoute: routeB,
    frozenRoute: routeB,
    currentRoute: routeB,
  })
  const report = project(
    [first, second],
    [
      progressFact({
        id: "a",
        sequence: 1,
        attemptID: first.id,
        kind: "worker-step",
        at: 100,
        messageID: "message-a",
        usage: { input: 1 },
        measurementBasis: "additive-step-measurement",
        route: routeA,
      }),
      progressFact({
        id: "b",
        sequence: 2,
        attemptID: second.id,
        kind: "worker-step",
        at: 200,
        messageID: "message-b",
        usage: { input: 1 },
        measurementBasis: "additive-step-measurement",
        route: routeB,
      }),
    ],
  )
  expect(report.routes.assessments.map((x) => [x.attemptID, x.messageID])).toEqual([
    [first.id, "message-a"],
    [second.id, "message-b"],
  ])
  expect(report.routes.mismatches).toEqual([])
  expect(report.usage.coverage.totalUniqueSessions).toBe(1)
})

test("shared-session context and current selection remain visible without invented historical attempt ownership", () => {
  const steps = [
    { messageID: "message-a", route: routeA, observedAt: 100 },
    { messageID: "message-b", route: routeB, observedAt: 200 },
  ]
  const first = attempt({
    id: "attempt-a",
    planRoute: routeA,
    frozenRoute: routeA,
    currentRoute: routeB,
    stepRoutes: steps,
  })
  const second = attempt({
    id: "attempt-b",
    planRoute: routeB,
    frozenRoute: routeB,
    currentRoute: routeB,
    stepRoutes: steps,
  })
  const report = project([first, second])
  expect(report.routes.observedSessionRoutes).toHaveLength(1)
  expect(report.routes.observedStepRoutes).toHaveLength(2)
  expect(report.routes.assessments).toEqual([])
  expect(report.routes.mismatches).toEqual([])
})

test("deduplicates session references and never fills a current cumulative snapshot from older or additive observations", () => {
  const first = attempt({
    sessionUsage: {
      input: 4,
      output: null,
      reasoning: 1,
      cacheRead: 3,
      cacheWrite: null,
    },
  })
  const repeated = attempt({
    id: "attempt-cancelled",
    state: "cancelled",
    sessionUsage: first.sessionUsage,
  })
  const report = project(
    [first, repeated],
    [
      progressFact({
        id: "old-snapshot",
        sequence: 1,
        kind: "worker-usage-snapshot",
        at: 400,
        measurementBasis: "cumulative-session-snapshot",
        usage: { input: 40, output: 50, reasoning: 20, cacheRead: 30, cacheWrite: 10 },
      }),
      progressFact({
        id: "step",
        sequence: 2,
        kind: "worker-step",
        at: 450,
        messageID: "message-step",
        measurementBasis: "additive-step-measurement",
        usage: { input: 1, output: 1, reasoning: 1, cacheRead: 1, cacheWrite: 1 },
      }),
    ],
  )

  expect(report.attempts).toMatchObject({
    count: 2,
    states: [
      { attemptID: "attempt-a", state: "failed" },
      { attemptID: "attempt-cancelled", state: "cancelled" },
    ],
    legacyTokenScalars: [
      { value: 99, status: "retained-not-added", addedToCategorizedUsage: false },
      { value: 99, status: "retained-not-added", addedToCategorizedUsage: false },
    ],
  })
  expect(report.usage.coverage.totalUniqueSessions).toBe(1)
  expect(report.usage.sessions[0]).toMatchObject({
    attemptIDs: ["attempt-a", "attempt-cancelled"],
    attemptStates: ["failed", "cancelled"],
    selectedBasis: "native-session-cumulative-snapshot",
    ignoredAdditiveStepCount: 1,
  })
  expect(report.usage.categories.uncachedInput).toMatchObject({ value: 4, status: "observed" })
  expect(report.usage.categories.output).toMatchObject({
    value: null,
    status: "missing",
    bySession: [
      {
        source: "native-session",
        observedAt: 500,
        status: "missing",
        missingObservations: 1,
      },
    ],
  })
  expect(report.usage.categories.cacheWrite.value).toBeNull()
})

test("selects the latest retained cumulative snapshot deterministically without category gap filling", () => {
  const facts = [
    progressFact({
      id: "latest",
      sequence: 4,
      kind: "worker-usage-snapshot",
      at: 200,
      measurementBasis: "cumulative-session-snapshot",
      usage: { input: 7, output: null, reasoning: 3, cacheRead: 2, cacheWrite: 1 },
    }),
    progressFact({
      id: "older",
      sequence: 3,
      kind: "worker-usage-snapshot",
      at: 100,
      measurementBasis: "cumulative-session-snapshot",
      usage: { input: 70, output: 9, reasoning: 30, cacheRead: 20, cacheWrite: 10 },
    }),
    progressFact({
      id: "additive",
      sequence: 5,
      kind: "worker-step",
      at: 250,
      messageID: "message-step",
      measurementBasis: "additive-step-measurement",
      usage: { input: 1, output: 1, reasoning: 1, cacheRead: 1, cacheWrite: 1 },
    }),
  ]
  const report = project(
    [
      attempt({
        sessionStatus: "unavailable",
        currentRoute: null,
        sessionUsage: null,
        sessionUsageObservedAt: null,
      }),
    ],
    facts,
  )

  expect(report.usage.sessions[0]).toMatchObject({
    selectedBasis: "retained-progress-cumulative-snapshot",
    selectedSnapshot: {
      observedAt: 200,
      recordedAt: 210,
      source: "runner-progress-store",
    },
    ignoredAdditiveStepCount: 1,
  })
  expect(report.usage.categories.uncachedInput.value).toBe(7)
  expect(report.usage.categories.output).toMatchObject({
    value: null,
    status: "missing",
    bySession: [
      {
        observedAt: 200,
        missingObservations: 1,
        observations: [{ recordedAt: 210 }],
      },
    ],
  })
  expect(report.usage.categories.output.bySession[0]?.observations[0]?.sourceType).toBe(
    "usage-snapshot:cumulative-session-snapshot",
  )
})

test("retained additive steps are a source-stamped subtotal, deduplicated by step and isolated from legacy scalars", () => {
  const first = {
    ...progressFact({
      id: "step-one",
      sequence: 1,
      kind: "worker-step",
      at: 100,
      messageID: "message-one",
      measurementBasis: "additive-step-measurement",
      usage: { input: 3, output: 1, reasoning: null, cacheRead: 2, cacheWrite: 0 },
    }),
    timing: {
      endpoints: {
        completedAt: { at: 150, sourceType: "session.step.ended" },
      },
    },
  }
  const duplicate = {
    ...first,
    id: "progress:duplicate-step-one",
    sequence: 9,
    eventIDs: ["evt-duplicate"],
  }
  const second = progressFact({
    id: "step-two",
    sequence: 2,
    kind: "worker-step",
    at: 200,
    messageID: "message-two",
    measurementBasis: "additive-step-measurement",
    usage: { input: 2, output: null, reasoning: 1, cacheRead: 1, cacheWrite: null },
  })
  const report = project(
    [
      attempt({
        sessionUsage: null,
        sessionUsageObservedAt: null,
        legacyTokenCount: 15,
      }),
    ],
    [first, duplicate, second],
  )

  expect(report.usage.sessions[0]).toMatchObject({
    selectedBasis: "retained-progress-additive-steps",
    additiveStepCount: 2,
  })
  expect(report.usage.categories.uncachedInput.value).toBe(5)
  expect(report.usage.sessions[0]?.categories.uncachedInput).toMatchObject({
    status: "partial",
    source: "worker-progress-step",
    observedAt: 200,
    observationTimeRange: { earliest: 150, latest: 200 },
  })
  expect(report.usage.sessions[0]?.categories.uncachedInput.observations[0]).toMatchObject({
    observedAt: 150,
    sourceType: "session.step.ended",
    observationTimeBasis: expect.stringContaining("completion endpoint"),
  })
  expect(report.usage.categories.output).toMatchObject({ value: 1, status: "partial" })
  expect(report.usage.categories.output.missingObservations).toBe(1)
  expect(report.usage.categories.reasoning).toMatchObject({ value: 1, status: "partial" })
  expect(report.attempts.legacyTokenScalars[0]).toMatchObject({
    value: 15,
    addedToCategorizedUsage: false,
  })
  expect(report.cost).toMatchObject({
    fullTaskCostUSD: { valueUSD: null, status: "unknown" },
    marketEquivalentCostUSD: { valueUSD: null, status: "unknown" },
    architectReviewIntegrationOverheadUSD: { valueUSD: null, status: "unallocated" },
  })
})

test("keeps frozen assignment separate from mixed observed routes and exposes unavailable coverage honestly", () => {
  const first = attempt({
    id: "attempt-preparing",
    state: "preparing",
    frozenRoute: routeA,
    personaRequested: "ui",
    personaFrozen: "systems",
    currentRoute: routeA,
    stepRoutes: [{ messageID: "step-a", route: routeB, observedAt: 120 }],
  })
  const second = attempt({
    id: "attempt-cancelled",
    sessionID: "session-b",
    state: "cancelled",
    frozenRoute: routeB,
    frozenRouteSource: "runner_attempt.policy.model",
    sessionStatus: "missing",
    contextStatus: "not-read",
    currentRoute: null,
    currentRouteObservedAt: null,
    sessionUsage: null,
    sessionUsageObservedAt: null,
    stepRoutes: [],
    planRoute: null,
    planRouteStatus: "inherited",
    personaRequested: null,
    personaFrozen: null,
  })
  const progressStep = progressFact({
    id: "observed-step",
    sequence: 7,
    attemptID: first.id,
    kind: "worker-step",
    at: 130,
    messageID: "step-a",
    measurementBasis: "additive-step-measurement",
    usage: { input: 1 },
    route: routeB,
  })
  const report = project([first, second], [progressStep], {
    progressTruncated: true,
    truncatedContextSessionIDs: ["session-a"],
  })

  expect(report.routes.assignments).toMatchObject([
    {
      attemptID: "attempt-preparing",
      state: "preparing",
      planSelection: { route: routeA, status: "explicit" },
      frozenAttemptRoute: { route: routeA, source: "runner_attempt.policy.model" },
      persona: { requested: "ui", frozen: "systems", comparison: "mismatch" },
    },
    {
      attemptID: "attempt-cancelled",
      state: "cancelled",
      planSelection: { route: null, status: "inherited" },
      frozenAttemptRoute: { route: routeB },
    },
  ])
  expect(report.routes.mixedRoutes).toBe(true)
  expect(report.routes.distinctObservedRoutes).toHaveLength(2)
  expect(report.routes.mismatches).toContainEqual(
    expect.objectContaining({
      attemptID: "attempt-preparing",
      scope: "step",
      status: "mismatch",
    }),
  )
  expect(report.routes.observedStepRoutes[0]?.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "native-session-context" }),
      expect.objectContaining({ source: "native-event", eventID: "evt-observed-step" }),
    ]),
  )
  expect(report.routes.coverage).toMatchObject({
    progressTruncated: true,
    truncatedContextSessionIDs: ["session-a"],
    missingSessionIDs: ["session-b"],
    stepContextsByStatus: { available: 1, notRead: 1, unavailable: 0 },
  })
  expect(report.routes.usageAttribution).toContain("Mixed observed routes")
  expect(report.cost.fullTaskCostUSD.valueUSD).toBeNull()
  expect(report.cost.architectReviewIntegrationOverheadUSD.status).toBe("unallocated")
  expect(report.quality).toMatchObject({ status: "not-recorded", value: null })
})
