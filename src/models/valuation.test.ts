import { expect, test } from "bun:test"
import type { AccountingAttempt, AccountingRoute } from "../trajectory/accounting.ts"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "../runner/store.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { projectProgressFact } from "../progress/projection.ts"
import { makeFixture, firstAttemptID, secondAttemptID } from "../../test/trajectory/fixture.ts"
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
const routeB: AccountingRoute = {
  providerID: "openai",
  modelID: "other-model",
  variant: null,
}

function modelForRoute(value: AccountingRoute) {
  return { providerID: value.providerID, id: value.modelID, variant: value.variant }
}

function stepEvent(input: {
  sessionID: string
  messageID: string
  type: string
  id: string
  created: number
  model?: unknown
  includeModel?: boolean
}) {
  return {
    id: input.id,
    type: input.type,
    created: input.created,
    data: {
      sessionID: input.sessionID,
      assistantMessageID: input.messageID,
      ...(input.includeModel ? { model: input.model } : {}),
    },
  }
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

function projectStoredProgress(
  fixture: ReturnType<typeof makeFixture>,
  attemptIDs: string[] = [firstAttemptID],
) {
  return fixture.store.progressFacts(attemptIDs).map(projectProgressFact)
}

function indexWithRouteB(): CurrentPriceIndex {
  const index: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  index.pins.push({
    ...structuredClone(index.pins[0]!),
    route: routeB,
    productID: routeB.modelID,
    configurationID: `${routeB.modelID}-default`,
    rates: {
      unit: "USD per million tokens",
      uncachedInput: 3,
      completion: 20,
      cacheRead: 0.1,
      cacheWrite: 1,
    },
  })
  return index
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

test("route-less retained assistant recovery preserves its same-call start route across replay and reopen", () => {
  const messageID = "msg-same-call-recovery"
  const recoveryMessage = {
    id: messageID,
    type: "assistant",
    time: { created: 10_000, streamed: 10_020, completed: 10_030 },
    content: [],
  }
  const startEvent = stepEvent({
    sessionID: "ses-failed",
    messageID,
    type: "session.step.started",
    id: "evt-same-call-start",
    created: 10_000,
    model: modelForRoute(route),
    includeModel: true,
  })
  const usageAttempt = attempt({ sessionID: "ses-failed", currentRoute: null })
  const baseline = project([usageAttempt])

  for (const recoveryFirst of [false, true]) {
    const fixture = makeFixture()
    let reopenedRepository: TaskRepository | undefined
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      if (recoveryFirst) {
        recorder.reconcileMessages("ses-failed", [recoveryMessage])
        recorder.recordNativeEvent(startEvent)
      } else {
        recorder.recordNativeEvent(startEvent)
        recorder.reconcileMessages("ses-failed", [recoveryMessage])
      }

      const rows = fixture.store.progressFacts([firstAttemptID])
      const stepRow = rows.find((row) => row.kind === "step")!
      expect(rows.filter((row) => row.kind === "step")).toHaveLength(1)
      const stepPayload = JSON.parse(stepRow.payload) as Record<string, unknown>
      expect(stepPayload.routeEvidence).toEqual({ status: "observed", route })
      const projected = rows.map(projectProgressFact)
      const valuation = project([usageAttempt], projected)
      expect(valuation.marketEquivalentCost.sessions[0]?.routeAllocation).toMatchObject({
        status: "single-observed-route",
        route,
      })
      expect(valuation.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual(
        nativeMillionTokenIndex.pins,
      )
      expect(valuation.marketEquivalentCost.valueUSD).toBe(0.000346)
      expect(valuation.usage.categories).toEqual(baseline.usage.categories)
      expect(valuation.usage.sessions[0]?.categories).toEqual(
        baseline.usage.sessions[0]?.categories,
      )
      expect(valuation.reportedWorkerCost).toEqual(baseline.reportedWorkerCost)

      const stableRows = (store: RunnerStore) =>
        store
          .progressFacts([firstAttemptID])
          .map((row) => [
            row.seq,
            row.at,
            row.recorded_at,
            row.payload,
            row.event_ids_json,
            row.sources_json,
          ])
      const beforeReplay = stableRows(fixture.store)
      recorder.reconcileMessages("ses-failed", [recoveryMessage])
      expect(stableRows(fixture.store)).toEqual(beforeReplay)

      const dbPath = fixture.repository.path
      const projectDirectory = fixture.repository.projectDirectory
      fixture.repository.close()
      reopenedRepository = new TaskRepository(dbPath, projectDirectory)
      const reopenedStore = new RunnerStore(reopenedRepository)
      const reopenedRecorder = new ProgressRecorder(reopenedStore, "project")
      reopenedRecorder.recordNativeEvent(startEvent)
      reopenedRecorder.reconcileMessages("ses-failed", [recoveryMessage])
      expect(stableRows(reopenedStore)).toEqual(beforeReplay)
      const reopenedValuation = project(
        [usageAttempt],
        projectStoredProgress({
          ...fixture,
          store: reopenedStore,
        }),
      )
      expect(reopenedValuation.marketEquivalentCost.valueUSD).toBe(0.000346)
      expect(reopenedValuation.usage.categories).toEqual(baseline.usage.categories)
      expect(reopenedValuation.usage.sessions[0]?.categories).toEqual(
        baseline.usage.sessions[0]?.categories,
      )
      expect(reopenedValuation.reportedWorkerCost).toEqual(baseline.reportedWorkerCost)
    } finally {
      reopenedRepository?.close()
      fixture.close()
    }
  }
})

test("orphan calls cannot borrow current or unrelated routes, while matching call evidence can resolve them", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const knownMessageID = "msg-known-route-a"
    recorder.recordNativeEvent(
      stepEvent({
        sessionID: "ses-failed",
        messageID: knownMessageID,
        type: "session.step.started",
        id: "evt-known-route-a",
        created: 11_000,
        model: modelForRoute(route),
        includeModel: true,
      }),
    )
    const orphanTypes = [
      ["session.step.streamed", "msg-orphan-streamed"],
      ["session.step.ended", "msg-orphan-ended"],
      ["session.step.failed", "msg-orphan-failed"],
    ] as const
    for (const [index, [type, messageID]] of orphanTypes.entries())
      recorder.recordNativeEvent(
        stepEvent({
          sessionID: "ses-failed",
          messageID,
          type,
          id: `evt-${messageID}`,
          created: 11_100 + index,
        }),
      )
    recorder.recordNativeEvent(
      stepEvent({
        sessionID: "ses-accepted",
        messageID: "msg-other-session-route-a",
        type: "session.step.started",
        id: "evt-other-session-route-a",
        created: 11_200,
        model: modelForRoute(route),
        includeModel: true,
      }),
    )

    const facts = projectStoredProgress(fixture, [firstAttemptID, secondAttemptID])
    for (const [type, messageID] of orphanTypes) {
      const relevant = facts.filter(
        (fact) =>
          fact.messageID === knownMessageID ||
          fact.messageID === messageID ||
          fact.messageID === "msg-other-session-route-a",
      )
      const result = project([attempt({ sessionID: "ses-failed" })], relevant)
      expect(result.marketEquivalentCost.sessions[0]?.routeAllocation.status, type).toBe(
        "identity-unavailable",
      )
      expect(result.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual([])
      expect(result.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
        tokens: 60,
        valueUSD: null,
        status: "unknown",
      })
      expect(result.marketEquivalentCost.valueUSD).toBeNull()
      expect(result.marketEquivalentCost.status).not.toBe("observed")
    }

    const contextMessageID = "msg-context-resolved-orphan"
    recorder.recordNativeEvent(
      stepEvent({
        sessionID: "ses-failed",
        messageID: contextMessageID,
        type: "session.step.ended",
        id: "evt-context-resolved-orphan",
        created: 11_300,
      }),
    )
    const contextFacts = projectStoredProgress(fixture).filter(
      (fact) => fact.messageID === contextMessageID,
    )
    const contextResult = project(
      [
        attempt({
          sessionID: "ses-failed",
          currentRoute: null,
          stepRoutes: [{ messageID: contextMessageID, route: routeB, observedAt: 11_300 }],
        }),
      ],
      contextFacts,
      indexWithRouteB(),
    )
    expect(contextResult.marketEquivalentCost.sessions[0]?.routeAllocation).toMatchObject({
      status: "single-observed-route",
      route: routeB,
    })
    expect(contextResult.marketEquivalentCost.valueUSD).toBe(0.000593)
  } finally {
    fixture.close()
  }
})

test("recovered message.model is call-local and current route B conflicts remain unallocated", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const recoveredMessageID = "msg-recovery-route-b"
    const orphanMessageID = "msg-recovery-orphan"
    recorder.reconcileMessages("ses-failed", [
      {
        id: recoveredMessageID,
        type: "assistant",
        model: modelForRoute(routeB),
        time: { created: 12_000, completed: 12_050 },
        content: [],
      },
    ])
    recorder.recordNativeEvent(
      stepEvent({
        sessionID: "ses-failed",
        messageID: orphanMessageID,
        type: "session.step.ended",
        id: "evt-recovery-orphan",
        created: 12_100,
      }),
    )
    const facts = projectStoredProgress(fixture)
    const recoveredFacts = facts.filter((fact) => fact.messageID === recoveredMessageID)
    expect(recoveredFacts[0]?.routeEvidence).toEqual({ status: "observed", route: routeB })

    const withoutCurrentRoute = attempt({ sessionID: "ses-failed", currentRoute: null })
    const recoveredOnly = project([withoutCurrentRoute], recoveredFacts, indexWithRouteB())
    expect(recoveredOnly.marketEquivalentCost.sessions[0]?.routeAllocation).toMatchObject({
      status: "single-observed-route",
      route: routeB,
    })
    expect(recoveredOnly.marketEquivalentCost.valueUSD).toBe(0.000593)

    const conflictingCurrent = project(
      [attempt({ sessionID: "ses-failed" })],
      recoveredFacts,
      indexWithRouteB(),
    )
    expect(conflictingCurrent.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
      "mixed-observed-routes",
    )
    expect(conflictingCurrent.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual([])
    expect(conflictingCurrent.marketEquivalentCost.valueUSD).toBeNull()

    const recoveredCannotResolveOtherCall = project(
      [withoutCurrentRoute],
      facts.filter(
        (fact) => fact.messageID === recoveredMessageID || fact.messageID === orphanMessageID,
      ),
      indexWithRouteB(),
    )
    expect(
      recoveredCannotResolveOtherCall.marketEquivalentCost.sessions[0]?.routeAllocation.status,
    ).toBe("identity-unavailable")
    expect(recoveredCannotResolveOtherCall.marketEquivalentCost.valueUSD).toBeNull()
  } finally {
    fixture.close()
  }
})

test("same-call route conflicts stay durable through observation eviction, recovery replay, and reopen", () => {
  const messageID = "msg-durable-route-conflict"
  const recoveryMessage = {
    id: messageID,
    type: "assistant",
    model: modelForRoute(route),
    time: { created: 13_000, completed: 13_100 },
    content: [],
  }
  const eventSet = (first: AccountingRoute, second: AccountingRoute) => [
    stepEvent({
      sessionID: "ses-failed",
      messageID,
      type: "session.step.started",
      id: "evt-conflict-first",
      created: 13_000,
      model: modelForRoute(first),
      includeModel: true,
    }),
    stepEvent({
      sessionID: "ses-failed",
      messageID,
      type: "session.step.started",
      id: "evt-conflict-second",
      created: 13_001,
      model: modelForRoute(second),
      includeModel: true,
    }),
    ...Array.from({ length: 30 }, (_, index) =>
      stepEvent({
        sessionID: "ses-failed",
        messageID,
        type: "session.step.streamed",
        id: `evt-conflict-streamed-${index}`,
        created: 13_100 + index,
      }),
    ),
  ]

  for (const order of [
    [route, routeB],
    [routeB, route],
  ] as const) {
    const fixture = makeFixture()
    let reopenedRepository: TaskRepository | undefined
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      const events = eventSet(order[0], order[1])
      for (const event of events) recorder.recordNativeEvent(event)
      recorder.reconcileMessages("ses-failed", [recoveryMessage])
      const row = fixture.store.progressFacts([firstAttemptID])[0]!
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      expect(payload.routeEvidence).toEqual({ status: "identity-unavailable" })
      expect(payload.observations).toHaveLength(25)

      const beforeReopen = fixture.store
        .progressFacts([firstAttemptID])
        .map((fact) => [
          fact.seq,
          fact.at,
          fact.recorded_at,
          fact.payload,
          fact.event_ids_json,
          fact.sources_json,
        ])
      const dbPath = fixture.repository.path
      const projectDirectory = fixture.repository.projectDirectory
      fixture.repository.close()
      reopenedRepository = new TaskRepository(dbPath, projectDirectory)
      const reopenedStore = new RunnerStore(reopenedRepository)
      const reopenedRecorder = new ProgressRecorder(reopenedStore, "project")
      reopenedRecorder.reconcileMessages("ses-failed", [recoveryMessage])
      expect(
        reopenedStore
          .progressFacts([firstAttemptID])
          .map((fact) => [
            fact.seq,
            fact.at,
            fact.recorded_at,
            fact.payload,
            fact.event_ids_json,
            fact.sources_json,
          ]),
      ).toEqual(beforeReopen)

      const facts = reopenedStore.progressFacts([firstAttemptID]).map(projectProgressFact)
      expect(facts[0]?.routeEvidence).toEqual({ status: "identity-unavailable" })
      const valuation = project([attempt({ sessionID: "ses-failed" })], facts)
      expect(valuation.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
        "identity-unavailable",
      )
      expect(valuation.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual([])
      expect(valuation.marketEquivalentCost.valueUSD).toBeNull()
    } finally {
      reopenedRepository?.close()
      fixture.close()
    }
  }
})

test("malformed, invalid-effort, redacted, truncated, and explicitly lost routes stay unresolved", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const invalidModels: unknown[] = [
      null,
      {},
      { providerID: "openrouter", id: "vendor/model", variant: 7 },
      { providerID: "openrouter", id: "vendor/model api_key=sk-secret-canary", variant: null },
      { providerID: "openrouter", id: "x".repeat(350), variant: null },
      { providerID: "openrouter", id: "vendor/model", variant: null, identity: null },
    ]
    for (const [index, model] of invalidModels.entries())
      recorder.recordNativeEvent(
        stepEvent({
          sessionID: "ses-failed",
          messageID: `msg-invalid-route-${index}`,
          type: "session.step.started",
          id: `evt-invalid-route-${index}`,
          created: 14_000 + index,
          model,
          includeModel: true,
        }),
      )

    const facts = projectStoredProgress(fixture)
    expect(facts).toHaveLength(invalidModels.length)
    for (const fact of facts)
      expect(fact.routeEvidence).toMatchObject({ status: "identity-unavailable" })
    expect(facts.some((fact) => JSON.stringify(fact).includes("sk-secret-canary"))).toBe(false)

    const valuation = project([attempt({ sessionID: "ses-failed" })], facts)
    expect(valuation.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
      "identity-unavailable",
    )
    expect(valuation.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual([])
    expect(valuation.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
      tokens: 60,
      status: "unknown",
      valueUSD: null,
    })
    expect(valuation.marketEquivalentCost.valueUSD).toBeNull()
  } finally {
    fixture.close()
  }
})

test("legacy stored route conflicts remain conservative without the durable evidence field", () => {
  const fixture = makeFixture()
  try {
    const messageID = "legacy-conflicting-message"
    const recorder = new ProgressRecorder(fixture.store, "project")
    recorder.recordNativeEvent(
      stepEvent({
        sessionID: "ses-failed",
        messageID,
        type: "session.step.ended",
        id: "evt-legacy-conflict",
        created: 15_002,
      }),
    )
    const row = fixture.store.progressFacts([firstAttemptID])[0]!
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_progress SET payload=? WHERE seq=?").run(
        JSON.stringify({
          status: "ended",
          route: routeB,
          observations: [
            {
              source: "native-event",
              eventType: "session.step.started",
              at: 15_000,
              messageID,
              route,
            },
            {
              source: "native-event",
              eventType: "session.step.started",
              at: 15_001,
              messageID,
              route: routeB,
            },
            {
              source: "recovery",
              eventType: "retained-assistant-message",
              at: 15_002,
              messageID,
            },
          ],
        }),
        row.seq,
      ),
    )
    const legacy = projectProgressFact(fixture.store.progressFacts([firstAttemptID])[0]!)
    const result = project([attempt({ sessionID: "ses-failed" })], [legacy])
    expect(result.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
      "mixed-observed-routes",
    )
    expect(result.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual([])
    expect(result.marketEquivalentCost.valueUSD).toBeNull()
  } finally {
    fixture.close()
  }
})

test("production projection preserves explicit loss of a legacy route identity", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    recorder.recordNativeEvent(
      stepEvent({
        sessionID: "ses-failed",
        messageID: "msg-explicit-identity-loss",
        type: "session.step.ended",
        id: "evt-explicit-identity-loss",
        created: 15_100,
      }),
    )
    const row = fixture.store.progressFacts([firstAttemptID])[0]!
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_progress SET payload=? WHERE seq=?").run(
        JSON.stringify({
          status: "ended",
          route: { ...route, identity: null },
          observations: [
            {
              source: "native-event",
              eventType: "session.step.started",
              at: 15_100,
              messageID: "msg-explicit-identity-loss",
              route: { ...route, identity: null },
            },
          ],
        }),
        row.seq,
      )
    })
    const projected = projectStoredProgress(fixture)[0]!
    expect(projected.route).toEqual({ ...route, identity: null })
    const result = project([attempt({ sessionID: "ses-failed" })], [projected])
    expect(result.marketEquivalentCost.sessions[0]?.routeAllocation.status).toBe(
      "identity-unavailable",
    )
    expect(result.marketEquivalentCost.sessions[0]?.pinCandidates).toEqual([])
    expect(result.marketEquivalentCost.valueUSD).toBeNull()
  } finally {
    fixture.close()
  }
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
