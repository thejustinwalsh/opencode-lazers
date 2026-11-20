import { expect, test } from "bun:test"
import { Schema } from "effect"
import { captureTrajectoryHistory, inspectTrajectory, inspectTrajectoryStatus } from "./read.ts"
import { InspectTrajectoryInput } from "./schema.ts"
import { makeFixture, cursorSecret, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"
import { DETECTOR_ACTOR } from "../recovery/detector.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { projectProgressFact } from "../progress/projection.ts"
import { openReadOnlyTrajectoryStore } from "./store.ts"
import { createTaskValuationReader } from "../models/task-valuation.ts"
import { nativeMillionTokenIndex } from "../../test/models-valuation/fixtures/current-indexes.ts"
import type { CurrentPriceIndex } from "../models/valuation-schema.ts"
import {
  lz137ValuationProvider,
  prepareLz137RetainedData,
} from "../../test/trajectory-panel/lz137-market-fixture.ts"

const pricingRoute = { providerID: "openrouter", modelID: "vendor/model", variant: null }
const pricingModel = {
  providerID: pricingRoute.providerID,
  id: pricingRoute.modelID,
}

function pricingHost(fixture: ReturnType<typeof makeFixture>) {
  return {
    session: async (id: string) => {
      const session = await fixture.host.session(id)
      if (!session) return null
      return {
        ...session,
        model: pricingModel,
        messages: session.messages?.map((message) => {
          const record = message as { model?: unknown }
          return record.model ? { ...message, model: pricingModel } : message
        }) as never,
      }
    },
  }
}

function pricedIndex(generation: number, retrievedAt: string, partial = false): CurrentPriceIndex {
  const base: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  const pin = base.pins[0]!
  pin.route = pricingRoute
  pin.productID = pricingRoute.modelID
  pin.configurationID = "vendor-model-default"
  pin.provenance = {
    ...pin.provenance,
    snapshotID:
      generation === 1
        ? "30000000-0000-4000-8000-000000000001"
        : "30000000-0000-4000-8000-000000000002",
    generation,
    retrievedAt: generation === 1 ? "2026-11-03T12:00:00.000Z" : "2026-11-04T12:00:00.000Z",
    recordID: "private-record-id-not-projected",
  }
  if (generation > 1) {
    pin.rates.uncachedInput = Number(pin.rates.uncachedInput) * 2
    pin.rates.completion = Number(pin.rates.completion) * 2
    pin.rates.cacheRead = Number(pin.rates.cacheRead) * 2
    pin.rates.cacheWrite = Number(pin.rates.cacheWrite) * 2
  }
  if (partial) pin.rates.completion = null
  return { ...base, indexID: `test-index-${generation}`, retrievedAt }
}

function parse(input: unknown) {
  return InspectTrajectoryInput.parse(input)
}

test("full capture preserves every paged event and live status reads metadata only", async () => {
  const fixture = makeFixture()
  try {
    const input = parse({ taskID, limit: 2 })
    const capture = await captureTrajectoryHistory(
      fixture.store,
      fixture.host,
      "project",
      input,
      cursorSecret,
    )
    const events = []
    let cursor: string | undefined
    do {
      const page = await inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        { ...input, cursor },
        cursorSecret,
      )
      events.push(...page.trajectory.events)
      cursor = page.trajectory.nextCursor ?? undefined
    } while (cursor)
    expect(events.length).toBeGreaterThan(input.limit)
    expect(capture.trajectory.events).toEqual(events)
    expect(capture.trajectory.nextCursor).toBeNull()
    expect(capture.trajectory.hasMore).toBe(false)
    await expect(
      captureTrajectoryHistory(
        fixture.store,
        fixture.host,
        "project",
        { ...input, cursor: "invalid" },
        cursorSecret,
      ),
    ).rejects.toThrow("Invalid or stale trajectory cursor")

    const calls: string[] = []
    const status = await inspectTrajectoryStatus(
      fixture.store,
      {
        session: async () => {
          throw new Error("Status must not load transcript context")
        },
        status: async (id) => {
          calls.push(id)
          const session = await fixture.host.session(id)
          return session && { ...session, messages: null, messageStatus: "not-read" as const }
        },
      },
      "project",
      taskID,
      cursorSecret,
    )
    expect(calls.length).toBeGreaterThan(0)
    expect(status.trajectory.nextCursor).toBeNull()
    expect(status.trajectory.hasMore).toBe(false)
    expect(status.attempts).toHaveLength(capture.attempts.length)
  } finally {
    fixture.close()
  }
})

function configureFailedAttemptRoute(
  fixture: ReturnType<typeof makeFixture>,
  modelID: string,
  observedModelID = modelID,
) {
  const nativeModel = { providerID: "openai", id: modelID, variant: "high" }
  const observedModel = { ...nativeModel, id: observedModelID }
  const plan = fixture.store.plan(fixture.receipt.planID)!
  const body = JSON.parse(plan.body) as Record<string, unknown>
  body.workerModel = nativeModel
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_plans SET body=?,model=? WHERE id=?").run(
      JSON.stringify(body),
      JSON.stringify(nativeModel),
      fixture.receipt.planID,
    )
    db.query("UPDATE runner_attempts SET policy=? WHERE id=?").run(
      JSON.stringify({ model: nativeModel, repairAttempt: false }),
      firstAttemptID,
    )
  })

  const session = fixture.sessions.get("ses-failed")!
  session.model = observedModel
  session.messages = [
    {
      id: "msg-long-route",
      type: "assistant",
      model: observedModel,
      time: { created: 1_300 },
      content: [],
    },
  ] as never
  const recorder = new ProgressRecorder(fixture.store, "project")
  recorder.recordNativeEvent({
    id: "evt-long-route-step",
    type: "session.step.started",
    created: 1_300,
    data: {
      sessionID: "ses-failed",
      assistantMessageID: "msg-long-route",
      agent: "lazers-implementor",
      model: observedModel,
    },
  })
}

function recordUnavailableRouteOccurrences(
  fixture: ReturnType<typeof makeFixture>,
  source: string,
) {
  const sameDisplayPrefix = "s".repeat(300)
  const modelIDs = [
    `${sameDisplayPrefix}PRIVATE_ROUTE_TAIL_A`,
    `${sameDisplayPrefix}PRIVATE_ROUTE_TAIL_B`,
    ...Array.from({ length: 10 }, (_, index) => {
      const prefix = `route-${String(index).padStart(2, "0")}-`
      return `${prefix}${"x".repeat(300 - prefix.length)}PRIVATE_ROUTE_TAIL_${String(index).padStart(2, "0")}`
    }),
  ]
  const session = fixture.sessions.get("ses-failed")!
  session.model = null as never
  session.messages = [] as never
  const recorder = new ProgressRecorder(fixture.store, "project")
  for (const [index, modelID] of modelIDs.entries())
    recorder.recordNativeEvent({
      id: `${source}-route-event-${index}`,
      type: "session.step.started",
      created: 5_000 + index,
      data: {
        sessionID: "ses-failed",
        assistantMessageID:
          index < 2 ? `${source}-same-route-message` : `${source}-route-message-${index}`,
        agent: "lazers-implementor",
        model: { providerID: "openai", id: modelID, variant: "high" },
      },
    })
  return { modelIDs, sameDisplayPrefix }
}

function recordIDlessUnavailableRouteOccurrences(
  fixture: ReturnType<typeof makeFixture>,
  source: string,
) {
  const sharedPrefix = "s".repeat(300)
  const modelIDs = [
    `${sharedPrefix}${"A".repeat(101)}`,
    `${sharedPrefix}${"B".repeat(101)}`,
    `${"A".repeat(300)}${"C".repeat(101)}`,
    `${"B".repeat(300)}${"D".repeat(101)}`,
  ]
  const session = fixture.sessions.get("ses-failed")!
  session.model = null as never
  session.messages = [] as never
  const recorder = new ProgressRecorder(fixture.store, "project")
  for (const [index, modelID] of modelIDs.entries())
    recorder.recordNativeEvent({
      type: "session.step.started",
      created: 1_300 + index,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: `${source}-idless-route-message`,
        agent: "lazers-implementor",
        model: { providerID: "openai", id: modelID, variant: "high" },
      },
    })
  return { modelIDs, sharedPrefix }
}

test("trajectory specifications preserve legacy policy references and omit absent ones", async () => {
  for (const withoutPolicy of [false, true]) {
    const fixture = makeFixture({ withoutPolicy })
    try {
      const before = JSON.stringify(fixture.repository.get(taskID))
      const report = await inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID }),
        cursorSecret,
      )
      const specification = report.task.specification as { requirements: Record<string, unknown> }
      expect(Object.hasOwn(specification.requirements, "policyReference")).toBe(!withoutPolicy)
      if (!withoutPolicy) expect(specification.requirements.policyReference).toBe("AGENTS.md")
      expect(JSON.stringify(fixture.repository.get(taskID))).toBe(before)
    } finally {
      fixture.close()
    }
  }
})

test("trajectory with default check timing is encodable by the native JSON RPC boundary", async () => {
  const fixture = makeFixture({ defaultVerificationTiming: true })
  try {
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )
    expect(report.task.specification.verification).toEqual([
      { id: "attempt-check", command: "bun test" },
    ])
    expect(Schema.is(Schema.Json)(report)).toBe(true)
  } finally {
    fixture.close()
  }
})

test("trajectory presents commentary separately from automatic worker facts without granting authority", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const executionBefore = fixture.store.execution(taskID)
    const recorder = new ProgressRecorder(fixture.store, "project")
    recorder.report({
      sessionID: "ses-failed",
      agent: "lazers-implementor",
      callID: "read-progress-call",
      messageID: "msg_progress_note",
      message: "The implementation and checks are complete.",
    })
    recorder.recordNativeEvent({
      id: "read-tool-event",
      type: "session.tool.success",
      created: 4000,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg_auto_tool",
        id: "auto-tool-call",
        executed: true,
        content: [{ type: "text", text: "check completed" }],
      },
    })
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )
    const commentary = report.trajectory.events.find((event) => event.kind === "commentary")
    const automatic = report.trajectory.events.find((event) => event.kind === "worker-tool")
    expect(commentary).toMatchObject({
      attemptID: firstAttemptID,
      text: "The implementation and checks are complete.",
    })
    expect(automatic).toMatchObject({
      attemptID: firstAttemptID,
      tool: null,
      status: "succeeded",
      recordedAt: expect.any(Number),
      execution: { status: "executed", source: "native-event" },
      timing: {
        unit: "unix-epoch-ms",
        endpoints: {
          inputAt: { at: null, source: null },
          calledAt: { at: null, source: null },
          completedAt: { at: 4000, source: "native-event" },
        },
      },
    })
    expect(automatic).not.toHaveProperty("result")
    expect(report.coverage.workerProgress).toMatchObject({
      commentary: 1,
      automaticFacts: 1,
      recoveryGaps: expect.any(Number),
      facts: expect.any(Number),
    })
    expect(fixture.store.execution(taskID)).toEqual(executionBefore)
  } finally {
    fixture.close()
  }
})

test("native-context timing keeps unknown endpoints null instead of using parent creation time", async () => {
  const fixture = makeFixture()
  try {
    const session = fixture.sessions.get("ses-failed")!
    session.messages = [
      ...(session.messages ?? []),
      {
        id: "msg-timing-context",
        type: "assistant",
        time: { created: 10_000, streamed: 10_500 },
        content: [
          {
            type: "tool",
            id: "call-no-run-time",
            name: "Bash",
            executed: false,
            time: { created: 10_100, completed: 10_300 },
            state: { status: "error", input: {}, error: { message: "not executed" } },
          },
          {
            type: "tool",
            id: "call-ran-only",
            name: "Bash",
            time: { ran: 10_250 },
            state: { status: "running", input: {} },
          },
        ],
      } as never,
    ]
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 50 }),
      cursorSecret,
    )
    const tool = report.trajectory.events.find(
      (event) => event.id === "msg-timing-context:tool:call-no-run-time",
    )!
    expect(tool.at).toBeNull()
    expect(tool).toMatchObject({
      execution: { status: "not-executed", source: "native-context" },
      timing: {
        unit: "unix-epoch-ms",
        endpoints: {
          inputAt: { at: 10_100, source: "native-context" },
          calledAt: { at: null, source: null },
          completedAt: { at: 10_300, source: "native-context" },
        },
      },
    })
    const ranOnlyTool = report.trajectory.events.find(
      (event) => event.id === "msg-timing-context:tool:call-ran-only",
    )!
    expect(ranOnlyTool).toMatchObject({
      at: 10_250,
      execution: { status: "unknown", source: null },
      timing: {
        endpoints: {
          calledAt: { at: 10_250, source: "native-context" },
          completedAt: { at: null, source: null },
        },
      },
    })
    const step = report.trajectory.events.find(
      (event) => event.id === "msg-timing-context:assistant-step",
    )!
    expect(step).toMatchObject({
      status: "streamed",
      timing: {
        endpoints: {
          startedAt: { at: 10_000 },
          streamedAt: { at: 10_500 },
          completedAt: { at: null, source: null },
        },
      },
    })
  } finally {
    fixture.close()
  }
})

test("read-only trajectory access tolerates a pre-recorded_at progress table without migration", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) => {
      db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,
          sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        fixture.directory,
        "project",
        fixture.attempts[0]!.plan_id,
        taskID,
        firstAttemptID,
        "ses-failed",
        4321,
        "recovery",
        '["recovery"]',
        "commentary",
        "[]",
        null,
        "msg-legacy-readonly",
        "legacy-readonly-row",
        '{"text":"legacy note"}',
      )
      db.exec("ALTER TABLE runner_progress DROP COLUMN recorded_at")
    })

    const connection = openReadOnlyTrajectoryStore(
      fixture.repository.path,
      fixture.repository.projectDirectory,
    )
    try {
      const rows = connection.store.progressFacts([firstAttemptID])
      expect(rows).toHaveLength(1)
      expect(projectProgressFact(rows[0]!)).toMatchObject({
        sequence: rows[0]!.seq,
        at: 4321,
        recordedAt: null,
        text: "legacy note",
      })
    } finally {
      connection.close()
    }
    const columns = fixture.store.atomic((db) =>
      db.query<{ name: string }, []>("PRAGMA table_info(runner_progress)").all(),
    )
    expect(columns.some((column) => column.name === "recorded_at")).toBe(false)
  } finally {
    fixture.close()
  }
})

test("task reports include unsuccessful and accepted attempts, usage categories, checks and unknown cost", async () => {
  const fixture = makeFixture()
  try {
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )
    expect(report.task.id).toBe(taskID)
    expect(report.task.specification.objective).toContain("Inspect a worker attempt")
    expect(report.task.specification).toHaveProperty("guidance")
    expect(JSON.stringify(report.task.specification)).toContain("Reuse src/runner/store.ts")
    expect(JSON.stringify(report.task.specification)).not.toContain("fake-guidance-secret")
    expect(report.plans[0]?.taskState).toBe("accepted")
    expect(report.plans[0]).toHaveProperty("taskReason", null)
    expect(report.plans[0]?.baseCommit).toBe("a".repeat(40))
    expect(report.plans[0]?.taskResultCommit).toBe("b".repeat(40))
    expect(report.effort.accepted).toBe(true)
    expect(report.effort.ongoing).toBe(false)
    expect(report.effort.wallClockSpanMs).toBe(3000)
    expect(report.attempts.map((attempt) => attempt.state)).toEqual(["failed", "accepted"])
    expect(report.attempts[0]?.admittedModel).toEqual({
      providerID: "openai",
      id: "gpt-6-luna",
      variant: "max",
    })
    expect(report.attempts[1]?.observedCurrentModel).toEqual({
      providerID: "openai",
      id: "gpt-6.1-sol",
      variant: "high",
    })
    expect(report.effort.tokenUsage.measuredSubtotal).toEqual({
      uncachedInput: 30,
      cacheRead: 12,
      cacheWrite: 1,
      output: 7,
      reasoning: 5,
    })
    expect(report.effort.tokenUsage.total).toEqual(report.effort.tokenUsage.measuredSubtotal)
    expect(report.effort.tokenUsage.legacyAttemptScalarsNotAdded).toHaveLength(2)
    expect(report.effort.toolCalls.count).toBe(5)
    expect(report.effort.providerRetries.count).toBe(1)
    // S9-1: an entirely unknown cost is not an observed zero.
    expect(report.effort.recordedCost.workerAttemptSubtotalUsd).toBeNull()
    expect(report.effort.recordedCost.status).toBe("missing")
    expect(report.effort.recordedCost.apiEquivalentTotalUsd).toBeNull()
    expect(report.effort.recordedCost.unknownContributions).toHaveLength(2)
    expect(report.plans[0]?.checks.map((check) => check.result)).toContain("failed")
    expect(report.plans[0]?.checks.map((check) => check.result)).toContain("passed")
    const toolEvents = report.trajectory.events.filter((event) => event.kind === "tool")
    expect(
      toolEvents.map((event) => ({
        id: event.id,
        status: event.status,
        completedAt: event.completedAt,
      })),
    ).toEqual([
      { id: "msg-old-tool:tool:call-failed", status: "error", completedAt: 1040 },
      { id: "msg-new-tool:tool:call-success", status: "completed", completedAt: 2030 },
    ])
    expect(report.coverage.transcript).toContain("paged host message list")
    expect(report.coverage.compacted).toBe(true)
  } finally {
    fixture.close()
  }
})

test("versioned task effort accounting survives task, attempt, paged, and read-only reopened reads", async () => {
  const fixture = makeFixture()
  let reopened: ReturnType<typeof openReadOnlyTrajectoryStore> | undefined
  try {
    const taskReport = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 2 }),
      cursorSecret,
    )
    const basis = taskReport.effort.taskEffortBasis
    expect(basis.schemaVersion).toBe(1)
    expect(basis.attempts).toMatchObject({
      count: 2,
      states: [
        { attemptID: firstAttemptID, state: "failed" },
        { attemptID: "509e5ba7-6b7e-40eb-8f49-25b3789c1ba6", state: "accepted" },
      ],
    })
    expect(basis.usage.coverage.totalUniqueSessions).toBe(2)
    expect(basis.usage.categories.uncachedInput.bySession).toEqual([
      expect.objectContaining({
        sessionID: "ses-accepted",
        source: "native-session",
        observedAt: 2100,
        status: "observed",
      }),
      expect.objectContaining({
        sessionID: "ses-failed",
        source: "native-session",
        observedAt: 1200,
        status: "observed",
      }),
    ])
    expect(basis.routes.assignments[0]).toMatchObject({
      planSelection: {
        route: { providerID: "openai", modelID: "gpt-6-luna", variant: "max" },
        status: "explicit",
      },
      frozenAttemptRoute: {
        route: { providerID: "openai", modelID: "gpt-6-luna", variant: "max" },
        source: "runner_attempt.policy.model",
      },
    })
    expect(basis.routes.mixedRoutes).toBe(true)
    expect(basis.routes.mismatches.length).toBeGreaterThan(0)
    expect(basis.routes.usageAttribution).toContain("Mixed observed routes")
    expect(basis.cost).toMatchObject({
      fullTaskCostUSD: { valueUSD: null, status: "unknown" },
      marketEquivalentCostUSD: { valueUSD: null, status: "unknown" },
      architectReviewIntegrationOverheadUSD: { valueUSD: null, status: "unallocated" },
    })
    expect(basis.quality).toEqual({
      status: "not-recorded",
      value: null,
      meaning: "No quality score or task-class value is inferred by trajectory accounting",
    })

    const focused = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ attemptID: firstAttemptID, limit: 2 }),
      cursorSecret,
    )
    expect(focused.attempts).toHaveLength(1)
    expect(focused.effort.taskEffortBasis).toEqual(basis)

    const nextPage = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 2, cursor: taskReport.trajectory.nextCursor! }),
      cursorSecret,
    )
    expect(nextPage.effort.taskEffortBasis).toEqual(basis)

    reopened = openReadOnlyTrajectoryStore(fixture.repository.path, fixture.directory)
    const reopenedReport = await inspectTrajectory(
      reopened.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 2 }),
      cursorSecret,
    )
    expect(reopenedReport.effort.taskEffortBasis).toEqual(basis)
  } finally {
    reopened?.close()
    fixture.close()
  }
})

test("market valuation shares unique-session usage, exposes source provenance, and keeps cursor identity stable", async () => {
  const fixture = makeFixture()
  let generation = 1
  let readNumber = 0
  const provider = createTaskValuationReader(async (_routes, signal) => {
    signal.throwIfAborted()
    readNumber += 1
    return {
      index: pricedIndex(
        generation,
        new Date(Date.UTC(2026, 10, 6, 12, 0, readNumber)).toISOString(),
      ),
      freshness: "current",
    }
  })
  try {
    const input = parse({ taskID, limit: 2 })
    const first = await inspectTrajectory(
      fixture.store,
      pricingHost(fixture),
      "project",
      input,
      cursorSecret,
      { taskValuationProvider: provider },
    )
    expect(first.effort.recordedCost.apiEquivalentTotalUsd).toBeCloseTo(0.0001844, 9)
    expect(first.effort.marketEquivalentCost).toMatchObject({
      valueUSD: 0.0001844,
      status: "observed",
      coverage: { totalUniqueSessions: 2, pricedSessions: 2 },
      currentIndex: {
        indexID: "test-index-1",
        freshness: "current",
        sources: [
          {
            source: "native-catalog",
            snapshotID: "30000000-0000-4000-8000-000000000001",
            generation: 1,
            priceBasis: "quote",
          },
        ],
      },
    })
    expect(typeof first.trajectory.nextCursor).toBe("string")
    const sources = first.effort.marketEquivalentCost!.sessions[0]!.sources[0]!
    expect(sources).not.toHaveProperty("recordID")
    expect(sources).not.toHaveProperty("sourceURL")
    expect(sources).not.toHaveProperty("route")

    const second = await inspectTrajectory(
      fixture.store,
      pricingHost(fixture),
      "project",
      { ...input, cursor: first.trajectory.nextCursor! },
      cursorSecret,
      { taskValuationProvider: provider },
    )
    expect(second.trajectory.page).toBe(2)
    expect(second.effort.recordedCost.apiEquivalentTotalUsd).toBe(
      first.effort.recordedCost.apiEquivalentTotalUsd,
    )

    generation = 2
    const repriced = await inspectTrajectory(
      fixture.store,
      pricingHost(fixture),
      "project",
      input,
      cursorSecret,
      { taskValuationProvider: provider },
    )
    expect(repriced.effort.recordedCost.apiEquivalentTotalUsd).toBeCloseTo(0.0003688, 9)
    expect(repriced.effort.marketEquivalentCost!.currentIndex).toMatchObject({
      indexID: "test-index-2",
      sources: [{ snapshotID: "30000000-0000-4000-8000-000000000002", generation: 2 }],
    })
    await expect(
      inspectTrajectory(
        fixture.store,
        pricingHost(fixture),
        "project",
        { ...input, cursor: first.trajectory.nextCursor! },
        cursorSecret,
        { taskValuationProvider: provider },
      ),
    ).rejects.toThrow("Stale trajectory cursor")
  } finally {
    fixture.close()
  }
})

test("configured trajectory valuation exposes the sourced 19-call LZ-137 observed estimate despite recovery gaps", async () => {
  const fixture = makeFixture()
  prepareLz137RetainedData(fixture)
  const provider = lz137ValuationProvider()
  try {
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 20 }),
      cursorSecret,
      { taskValuationProvider: provider },
    )
    const market = report.effort.marketEquivalentCost
    expect(report.effort.recordedCost.apiEquivalentTotalUsd).toBeNull()
    expect(report.effort.recordedCost.apiEquivalentSubtotalUsd).toBe(0)
    expect(market).toMatchObject({
      valueUSD: null,
      subtotalUSD: 0,
      observedUsageEstimate: {
        label: "Current-market observed-usage estimate",
        status: "estimate",
        valueUSD: 0.01598662,
        rangeUSD: null,
        basis: "deduplicated-retained-token-usage-at-published-current-rates",
        sources: [
          {
            source: "openrouter-models",
            priceBasis: "average",
            snapshotID: expect.any(String),
            generation: expect.any(Number),
            freshness: "current",
          },
        ],
        tierAttribution: {
          status: "resolved-per-call",
          basis: "complete-per-call-prompt-usage",
          callCount: 19,
          selectedTierIDs: ["base"],
          promptThresholds: [272_000],
        },
        retainedCallCount: 19,
        recoveryGapCount: 2,
      },
    })
    expect(market?.observedUsageEstimate?.categories).toMatchObject({
      uncachedInput: { tokens: 56_452, status: "observed" },
      cacheRead: { tokens: 820_992, status: "observed" },
      cacheWrite: { tokens: 0, status: "observed" },
      output: { tokens: 2_061, status: "observed" },
      reasoning: { tokens: 2_202, status: "observed" },
    })
    expect(market?.observedUsageEstimate?.assumptions.join(" ")).toContain(
      "does not guarantee full historical call coverage",
    )
    expect(market?.observedUsageEstimate?.sources[0]?.sourceURL).toBe(
      "https://openrouter.ai/api/v1/models",
    )
  } finally {
    fixture.close()
  }
})

test("partial prices label the subtotal and leave the legacy complete total null", async () => {
  const fixture = makeFixture()
  const provider = createTaskValuationReader(async (_routes, signal) => {
    signal.throwIfAborted()
    return {
      index: pricedIndex(1, "2026-11-06T12:00:00.000Z", true),
      freshness: "current",
    }
  })
  try {
    const report = await inspectTrajectory(
      fixture.store,
      pricingHost(fixture),
      "project",
      parse({ taskID, limit: 20 }),
      cursorSecret,
      { taskValuationProvider: provider },
    )
    expect(report.effort.recordedCost.apiEquivalentTotalUsd).toBeNull()
    expect(report.effort.recordedCost.apiEquivalentSubtotalUsd).toBeGreaterThan(0)
    expect(report.effort.recordedCost.apiEquivalentStatus).toBe("partial")
    expect(report.effort.marketEquivalentCost).toMatchObject({
      valueUSD: null,
      status: "partial",
      subtotalUSD: report.effort.recordedCost.apiEquivalentSubtotalUsd,
    })
  } finally {
    fixture.close()
  }
})

test("Models source failure preserves trajectory history and cancellation does not publish valuation", async () => {
  const fixture = makeFixture()
  try {
    const unavailable = createTaskValuationReader(async () => {
      throw new Error("private source path and credential")
    })
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 20 }),
      cursorSecret,
      { taskValuationProvider: unavailable },
    )
    expect(report.trajectory.events.length).toBeGreaterThan(0)
    expect(report.effort.recordedCost.apiEquivalentTotalUsd).toBeNull()
    expect(report.effort.marketEquivalentCost).toMatchObject({
      valueUSD: null,
      status: "unavailable",
      currentIndex: null,
    })
    expect(JSON.stringify(report)).not.toContain("private source path")
    expect(JSON.stringify(report)).not.toContain("credential")

    let markStarted!: () => void
    let finishRead!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const waiting = createTaskValuationReader(async (_routes, signal) => {
      markStarted()
      await new Promise<void>((resolve, reject) => {
        finishRead = resolve
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
      return { index: pricedIndex(1, "2026-11-06T12:00:00.000Z"), freshness: "current" }
    })
    const controller = new AbortController()
    const pending = inspectTrajectory(
      fixture.store,
      pricingHost(fixture),
      "project",
      parse({ taskID, limit: 20 }),
      cursorSecret,
      { taskValuationProvider: waiting, signal: controller.signal },
    )
    await started
    controller.abort()
    finishRead()
    await expect(pending).rejects.toThrow()
  } finally {
    fixture.close()
  }
})

test("trajectory route accounting compares identical 121-character plan, policy, session, and step IDs losslessly", async () => {
  const fixture = makeFixture()
  const modelID = "m".repeat(121)
  try {
    configureFailedAttemptRoute(fixture, modelID)
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )
    const basis = report.effort.taskEffortBasis
    const assessments = basis.routes.assessments.filter(
      (assessment) => assessment.attemptID === firstAttemptID,
    )
    expect(assessments.map(({ scope, status }) => [scope, status])).toEqual([
      ["session", "match"],
      ["step", "match"],
    ])
    expect(basis.routes.assignments[0]?.planSelection.route?.modelID).toBe(
      `${"m".repeat(120)}…[truncated]`,
    )
    expect(JSON.stringify(basis)).not.toContain(modelID)
  } finally {
    fixture.close()
  }
})

test("trajectory route accounting distinguishes 121-character IDs with the same retained prefix", async () => {
  const fixture = makeFixture()
  const prefix = "m".repeat(120)
  const plannedID = `${prefix}a`
  const observedID = `${prefix}b`
  try {
    configureFailedAttemptRoute(fixture, plannedID, observedID)

    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )
    const basis = report.effort.taskEffortBasis
    const assessments = basis.routes.assessments.filter(
      (assessment) => assessment.attemptID === firstAttemptID,
    )
    expect(
      assessments.map(({ scope, status, frozenRouteStatus }) => [scope, status, frozenRouteStatus]),
    ).toEqual([
      ["session", "mismatch", "mismatch"],
      ["step", "mismatch", "mismatch"],
    ])
    expect(
      basis.routes.mismatches
        .filter((assessment) => assessment.attemptID === firstAttemptID)
        .map(({ scope, status, frozenRouteStatus }) => [scope, status, frozenRouteStatus]),
    ).toEqual([
      ["session", "mismatch", "mismatch"],
      ["step", "mismatch", "mismatch"],
    ])
    expect(JSON.stringify(basis)).not.toContain(plannedID)
    expect(JSON.stringify(basis)).not.toContain(observedID)
  } finally {
    fixture.close()
  }
})

test("trajectory accounting keeps long native context identities exact and marks truncated progress identities unavailable", async () => {
  const fixture = makeFixture()
  const modelID = "m".repeat(401)
  try {
    configureFailedAttemptRoute(fixture, modelID)
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )
    const basis = report.effort.taskEffortBasis
    const assessments = basis.routes.assessments.filter(
      (assessment) => assessment.attemptID === firstAttemptID,
    )
    expect(assessments.map(({ scope, status }) => [scope, status])).toEqual([
      ["session", "match"],
      ["step", "match"],
      ["step", "unavailable"],
    ])
    expect(
      basis.routes.mismatches.some((assessment) => assessment.attemptID === firstAttemptID),
    ).toBe(false)
    expect(JSON.stringify(basis)).not.toContain(modelID)
  } finally {
    fixture.close()
  }
})

test("unavailable-route cursors remain stable across trajectory reads", async () => {
  if (process.env.LAZERS_TRAJECTORY_CURSOR_REGRESSION !== "1") {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        "--test-name-pattern=unavailable-route cursors remain stable",
        "src/trajectory/read.test.ts",
      ],
      cwd: process.cwd(),
      env: { ...process.env, LAZERS_TRAJECTORY_CURSOR_REGRESSION: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = `${new TextDecoder().decode(child.stdout)}\n${new TextDecoder().decode(child.stderr)}`
    if (child.exitCode !== 0) throw new Error(output)
    return
  }

  const fixture = makeFixture()
  const unrelated = makeFixture()
  let reopened: ReturnType<typeof openReadOnlyTrajectoryStore> | undefined
  const originalProgressFacts = fixture.store.progressFacts.bind(fixture.store)
  try {
    const { modelIDs, sameDisplayPrefix } = recordUnavailableRouteOccurrences(fixture, "primary")
    const idless = recordIDlessUnavailableRouteOccurrences(fixture, "primary")
    recordUnavailableRouteOccurrences(unrelated, "interleaved")

    const inspect = (options: { attemptID?: string; cursor?: string } = {}) =>
      inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID, limit: 2, ...options }),
        cursorSecret,
      )
    const first = await inspect()
    const cursor = first.trajectory.nextCursor!
    expect(cursor).toBeTruthy()

    const routeOrder = (report: Awaited<ReturnType<typeof inspect>>) =>
      report.effort.taskEffortBasis.routes.distinctObservedRoutes.filter(
        (route): route is NonNullable<typeof route> => route !== null,
      )
    const routes = routeOrder(first)
    const unavailable = routes.filter((route) => route.modelID.endsWith("…[truncated]"))
    const expectedModelIDs = [...modelIDs, ...idless.modelIDs]
    const expectedDisplays = new Set(
      expectedModelIDs.map((modelID) => `${modelID.slice(0, 300)}…[truncated]`),
    )
    expect(unavailable).toHaveLength(expectedModelIDs.length)
    expect(new Set(unavailable.map((route) => route.modelID)).size).toBe(expectedDisplays.size)
    expect(
      unavailable.filter((route) => route.modelID === `${sameDisplayPrefix}…[truncated]`),
    ).toHaveLength(4)
    const sameMessageRoutes = first.effort.taskEffortBasis.routes.observedStepRoutes.filter(
      (route) => route.messageID === "primary-same-route-message",
    )
    expect(sameMessageRoutes).toHaveLength(2)
    expect(sameMessageRoutes.map((route) => route.sources[0]?.eventID)).toEqual([
      "primary-route-event-0",
      "primary-route-event-1",
    ])
    expect(idless.modelIDs.every((modelID) => modelID.length === 401)).toBe(true)
    const idlessRoutes = first.effort.taskEffortBasis.routes.observedStepRoutes.filter(
      (route) => route.messageID === "primary-idless-route-message",
    )
    expect(idlessRoutes).toHaveLength(4)
    expect(idlessRoutes.map((route) => [route.route?.modelID ?? null, route.sources[0]])).toEqual(
      idless.modelIDs.map((modelID, index) => [
        `${modelID.slice(0, 300)}…[truncated]`,
        {
          attemptID: firstAttemptID,
          source: "native-event",
          sourceType: "session.step.started",
          observedAt: 1_300 + index,
          recordedAt: expect.any(Number),
          eventID: null,
        },
      ]),
    )
    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain("sourceOccurrence")
    for (const modelID of expectedModelIDs) expect(serialized).not.toContain(modelID)
    expect(serialized).not.toContain(`${idless.sharedPrefix}${"A".repeat(101)}`)

    const repeated = await inspect()
    expect(routeOrder(repeated)).toEqual(routes)
    expect((await inspect({ cursor })).trajectory.page).toBe(2)

    await inspectTrajectory(
      unrelated.store,
      unrelated.host,
      "project",
      parse({ taskID, limit: 2 }),
      cursorSecret,
    )
    expect(routeOrder(await inspect())).toEqual(routes)
    expect((await inspect({ cursor })).trajectory.page).toBe(2)

    fixture.store.progressFacts = (attemptIDs, limit) =>
      originalProgressFacts(attemptIDs, limit).toReversed()
    const reorderedFacts = await inspect({ cursor })
    expect(reorderedFacts.trajectory.page).toBe(2)
    expect(routeOrder(reorderedFacts)).toEqual(routes)
    fixture.store.progressFacts = originalProgressFacts

    const filtered = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ attemptID: firstAttemptID, limit: 2 }),
      cursorSecret,
    )
    expect(routeOrder(filtered)).toEqual(routes)
    expect(
      (
        await inspectTrajectory(
          fixture.store,
          fixture.host,
          "project",
          parse({ attemptID: firstAttemptID, limit: 2, cursor: filtered.trajectory.nextCursor! }),
          cursorSecret,
        )
      ).trajectory.page,
    ).toBe(2)

    reopened = openReadOnlyTrajectoryStore(fixture.repository.path, fixture.directory)
    const reopenedPage = await inspectTrajectory(
      reopened.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 2, cursor }),
      cursorSecret,
    )
    expect(reopenedPage.trajectory.page).toBe(2)
    expect(routeOrder(reopenedPage)).toEqual(routes)
  } finally {
    fixture.store.progressFacts = originalProgressFacts
    reopened?.close()
    unrelated.close()
    fixture.close()
  }
})

test("bounded pages preserve exact event order and reject stale or foreign continuations", async () => {
  const fixture = makeFixture()
  try {
    const first = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 2 }),
      cursorSecret,
    )
    expect(first.trajectory.hasMore).toBe(true)
    const paged = [...first.trajectory.events]
    let cursor = first.trajectory.nextCursor
    while (cursor) {
      const page = await inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID, limit: 2, cursor }),
        cursorSecret,
      )
      paged.push(...page.trajectory.events)
      cursor = page.trajectory.nextCursor
    }
    const complete = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 50 }),
      cursorSecret,
    )
    expect(paged).toEqual(complete.trajectory.events)
    expect(new Set(paged.map((event) => event.id)).size).toBe(paged.length)
    expect(paged.map((event) => event.id)).toEqual(
      [...paged]
        .sort((a, b) => {
          const left = typeof a.at === "number" ? a.at : Number.MAX_SAFE_INTEGER
          const right = typeof b.at === "number" ? b.at : Number.MAX_SAFE_INTEGER
          return left - right || String(a.id).localeCompare(String(b.id))
        })
        .map((event) => event.id),
    )

    const cursorFromFirst = first.trajectory.nextCursor!
    await expect(
      inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID, limit: 3, cursor: cursorFromFirst }),
        cursorSecret,
      ),
    ).rejects.toThrow("Stale trajectory cursor")

    await expect(
      inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ attemptID: firstAttemptID, limit: 2, cursor: cursorFromFirst }),
        cursorSecret,
      ),
    ).rejects.toThrow("Stale trajectory cursor")

    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET token_count=100 WHERE id=?").run(firstAttemptID),
    )
    await expect(
      inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID, limit: 2, cursor: cursorFromFirst }),
        cursorSecret,
      ),
    ).rejects.toThrow("Stale trajectory cursor")
  } finally {
    fixture.close()
  }
})

test("visible export redacts nested credentials before truncation and fails closed on private parts", async () => {
  const fixture = makeFixture()
  try {
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 50 }),
      cursorSecret,
    )
    const serialized = JSON.stringify(report)
    for (const secret of [
      "sk-proj-12345678901234567890",
      "private.invalid/path",
      "never-export-this",
      "sk-secret-key-12345678901234567890",
      "credential-value",
      "serialized-json-secret",
      "RAW RESPONSE BODY MUST NOT EXPORT",
      "PRIVATE REASONING DO NOT EXPORT",
      "Another private chain of thought",
      "PRIVATE COMPACTION SUMMARY",
      "REPLAY DATA",
      "SYSTEM INSTRUCTIONS MUST NOT EXPORT",
      "unknown part should fail closed",
      "unknown message payload must not export",
      "hidden-after-the-boundary",
      "logged-secret",
      "123456789012345678901234567890",
    ])
      expect(serialized).not.toContain(secret)
    expect(serialized).toContain("[REDACTED]")
    expect(serialized).toContain("[path omitted]")
    expect(report.privacy.redactedValues).toBeGreaterThan(0)
    expect(report.privacy.truncatedValues).toBeGreaterThan(0)
    expect(report.privacy.omittedAttachments).toBeGreaterThan(0)
    expect(report.privacy.omittedReasoning).toBeGreaterThan(0)
    expect(report.privacy.omittedSystemOrSkillMessages).toBeGreaterThan(0)
    expect(report.privacy.omittedUnknownParts).toBeGreaterThan(0)
    expect(report.coverage.compacted).toBe(true)
  } finally {
    fixture.close()
  }
})

test("native tool arguments, JSON results and errors omit nested private state", async () => {
  const fixture = makeFixture()
  try {
    const arrayLimit: unknown[] = Array.from({ length: 45 }, (_, index) => ({ index }))
    arrayLimit[39] = { type: "text", text: "safe array summary retained" }
    arrayLimit[40] = { type: "reasoning", text: "ARRAY_LIMIT_PRIVATE_CANARY" }

    let nestingLimit: unknown = { type: "reasoning", text: "NESTING_LIMIT_PRIVATE_CANARY" }
    for (let index = 0; index < 9; index++) nestingLimit = { child: nestingLimit }

    const fieldLimit = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`field${index}`, index]),
    )
    Object.assign(fieldLimit, { late: "FIELD_LIMIT_PRIVATE_CANARY" })

    const session = fixture.sessions.get("ses-failed")!
    session.messages = [
      ...(session.messages ?? []),
      {
        id: "nested-private-tool",
        type: "assistant",
        time: { created: 1150 },
        content: [
          {
            type: "tool",
            id: "nested-private-call",
            name: "Inspect",
            state: {
              status: "error",
              input: {
                command: "bun test src/trajectory",
                source: "src/trajectory/read.ts",
                summary: "safe argument summary retained",
                arguments: JSON.stringify({
                  visible: "safe nested argument retained",
                  context: {
                    messages: [
                      { type: "reasoning", text: "AUDIT_PRIVATE_INPUT_CANARY" },
                      { type: "system", text: "AUDIT_PRIVATE_SYSTEM_CANARY" },
                      { type: "skill", instructions: "AUDIT_PRIVATE_SKILL_CANARY" },
                    ],
                  },
                  native: { replay: "AUDIT_PRIVATE_NATIVE_CANARY" },
                  attachments: [{ type: "file", data: "AUDIT_PRIVATE_ATTACHMENT_CANARY" }],
                  state: { input: "AUDIT_FULL_INPUT_CANARY" },
                }),
                arrayLimit,
                nestingLimit,
                fieldLimit,
                unsupported: new Map([["private", "UNSUPPORTED_STRUCTURE_PRIVATE_CANARY"]]),
              },
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    summary: "safe JSON result retained",
                    details: [
                      { type: "reasoning", text: "AUDIT_PRIVATE_RESULT_CANARY" },
                      { type: "system", text: "JSON_RESULT_SYSTEM_PRIVATE_CANARY" },
                      { type: "skill", instructions: "JSON_RESULT_SKILL_PRIVATE_CANARY" },
                      {
                        type: "tool",
                        name: "nested-tool",
                        state: { input: "AUDIT_FULL_INPUT_CANARY" },
                      },
                    ],
                  }),
                },
              ],
              error: {
                type: "ToolError",
                message: JSON.stringify({
                  summary: "safe JSON error retained",
                  details: [
                    { kind: "reasoning", text: "AUDIT_PRIVATE_ERROR_CANARY" },
                    { type: "skill", instructions: "JSON_ERROR_SKILL_PRIVATE_CANARY" },
                    { arguments: { state: { input: "AUDIT_FULL_INPUT_CANARY" } } },
                  ],
                }),
                response: { body: "AUDIT_PRIVATE_ERROR_BODY_CANARY" },
              },
            },
            time: { ran: 1151, completed: 1160 },
          },
        ],
      } as never,
    ]

    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 50 }),
      cursorSecret,
    )
    const serialized = JSON.stringify(report)
    for (const canary of [
      "AUDIT_PRIVATE_INPUT_CANARY",
      "AUDIT_PRIVATE_RESULT_CANARY",
      "AUDIT_FULL_INPUT_CANARY",
      "AUDIT_PRIVATE_ERROR_CANARY",
      "AUDIT_PRIVATE_SYSTEM_CANARY",
      "AUDIT_PRIVATE_SKILL_CANARY",
      "AUDIT_PRIVATE_NATIVE_CANARY",
      "AUDIT_PRIVATE_ATTACHMENT_CANARY",
      "JSON_RESULT_SYSTEM_PRIVATE_CANARY",
      "JSON_RESULT_SKILL_PRIVATE_CANARY",
      "JSON_ERROR_SKILL_PRIVATE_CANARY",
      "AUDIT_PRIVATE_ERROR_BODY_CANARY",
      "ARRAY_LIMIT_PRIVATE_CANARY",
      "NESTING_LIMIT_PRIVATE_CANARY",
      "FIELD_LIMIT_PRIVATE_CANARY",
      "UNSUPPORTED_STRUCTURE_PRIVATE_CANARY",
    ])
      expect(serialized).not.toContain(canary)

    const toolEvent = report.trajectory.events.find(
      (event) => event.id === "nested-private-tool:tool:nested-private-call",
    )!
    expect(toolEvent).toMatchObject({ tool: "Inspect", status: "error" })
    expect(JSON.stringify(toolEvent.input)).toContain("bun test src/trajectory")
    expect(JSON.stringify(toolEvent.input)).toContain("src/trajectory/read.ts")
    expect(JSON.stringify(toolEvent.input)).toContain("safe argument summary retained")
    expect(JSON.stringify(toolEvent.input)).toContain("safe nested argument retained")
    expect(JSON.stringify(toolEvent.input)).toContain("safe array summary retained")
    expect(toolEvent.result).toContain("safe JSON result retained")
    expect(toolEvent.error).toMatchObject({ type: "ToolError" })
    expect((toolEvent.error as { message?: string }).message).toContain("safe JSON error retained")
    expect(report.plans[0]?.checks.map((check) => check.result)).toContain("passed")
    expect(report.coverage.transcript).toContain("paged host message list")
    expect(report.privacy.warnings.join(" ")).toContain("System instructions")
    expect(report.privacy.truncatedValues).toBeGreaterThan(0)
    expect(report.privacy.omittedUnknownParts).toBeGreaterThan(0)
  } finally {
    fixture.close()
  }
})

test("tool multipart JSON and nesting-limit strings omit private reasoning while retaining safe siblings", async () => {
  const fixture = makeFixture()
  try {
    const privateJson = JSON.stringify({
      type: "reasoning",
      text: "REVIEW_PRIVATE_MULTIPART_CANARY",
    })
    const encodedPrivateJson = JSON.stringify(privateJson)
    let depthString: unknown = JSON.stringify({
      type: "reasoning",
      text: "REVIEW_DEPTH_STRING_CANARY",
    })
    for (let index = 0; index < 7; index++) depthString = { child: depthString }

    let belowDepthLimit: unknown = JSON.stringify({
      type: "reasoning",
      text: "REVIEW_DEPTH_BELOW_LIMIT_CANARY",
    })
    for (let index = 0; index < 6; index++) belowDepthLimit = { child: belowDepthLimit }

    const session = fixture.sessions.get("ses-failed")!
    session.messages = [
      ...(session.messages ?? []),
      {
        id: "multipart-private-tool",
        type: "assistant",
        time: { created: 1170 },
        content: [
          {
            type: "tool",
            id: "multipart-private-call",
            name: "Inspect",
            state: {
              status: "completed",
              input: {
                command: "bun test src/trajectory/read.test.ts",
                source: "src/trajectory/read.ts",
                summary: "safe argument summary retained",
                depthString,
                belowDepthLimit,
              },
              content: [
                { type: "text", text: "safe multipart prose retained" },
                { type: "text", text: privateJson },
                {
                  type: "text",
                  text: JSON.stringify({
                    summary: "safe multipart JSON summary retained",
                    details: [{ type: "reasoning", text: "REVIEW_PRIVATE_MULTIPART_CANARY" }],
                  }),
                },
                { type: "text", text: encodedPrivateJson },
                { type: "text", text: "Code: bun test src/trajectory/read.test.ts" },
              ],
            },
            time: { ran: 1171, completed: 1180 },
          },
        ],
      } as never,
    ]

    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 50 }),
      cursorSecret,
    )
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain("REVIEW_PRIVATE_MULTIPART_CANARY")
    expect(serialized).not.toContain("REVIEW_DEPTH_STRING_CANARY")
    expect(serialized).not.toContain("REVIEW_DEPTH_BELOW_LIMIT_CANARY")

    const toolEvent = report.trajectory.events.find(
      (event) => event.id === "multipart-private-tool:tool:multipart-private-call",
    )!
    expect(toolEvent).toMatchObject({ tool: "Inspect", status: "completed" })
    expect(JSON.stringify(toolEvent.input)).toContain("bun test src/trajectory/read.test.ts")
    expect(JSON.stringify(toolEvent.input)).toContain("src/trajectory/read.ts")
    expect(JSON.stringify(toolEvent.input)).toContain("safe argument summary retained")
    expect(toolEvent.result).toContain("safe multipart prose retained")
    expect(toolEvent.result).toContain("safe multipart JSON summary retained")
    expect(toolEvent.result).toContain("Code: bun test src/trajectory/read.test.ts")
    expect(report.privacy.omittedReasoning).toBeGreaterThan(0)
  } finally {
    fixture.close()
  }
})

test("attempt lookup rejects foreign IDs and session identity mismatches without exporting data", async () => {
  const fixture = makeFixture()
  try {
    const foreignTask = fixture.repository.insert({
      ...fixture.task,
      id: crypto.randomUUID(),
      provenance: { ...fixture.task.provenance, projectID: "foreign-project" },
    })
    await expect(
      inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID: foreignTask.id }),
        cursorSecret,
      ),
    ).rejects.toThrow("Task is not owned by this project")

    let sessionReads = 0
    const countingHost = {
      session: async (id: string) => {
        sessionReads++
        return fixture.host.session(id)
      },
    }
    await expect(
      inspectTrajectory(
        fixture.store,
        countingHost,
        "project",
        parse({ attemptID: crypto.randomUUID() }),
        cursorSecret,
      ),
    ).rejects.toThrow("No project-owned attempt")
    expect(sessionReads).toBe(0)

    const foreignHost = {
      session: async (id: string) => {
        const session = await fixture.host.session(id)
        return session ? { ...session, projectID: "foreign-project" } : null
      },
    }
    await expect(
      inspectTrajectory(fixture.store, foreignHost, "project", parse({ taskID }), cursorSecret),
    ).rejects.toThrow("outside this project")
  } finally {
    fixture.close()
  }
})

test("continuation cursors are bound to the project-owned source snapshot", async () => {
  const fixture = makeFixture()
  const otherProject = makeFixture()
  try {
    const first = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 2 }),
      cursorSecret,
    )
    expect(first.trajectory.nextCursor).not.toBeNull()

    await expect(
      inspectTrajectory(
        otherProject.store,
        otherProject.host,
        "project",
        parse({ taskID, limit: 2, cursor: first.trajectory.nextCursor! }),
        cursorSecret,
      ),
    ).rejects.toThrow("Stale trajectory cursor")
  } finally {
    fixture.close()
    otherProject.close()
  }
})

test("native session errors are redacted before appearing in the report", async () => {
  const fixture = makeFixture()
  try {
    const host = {
      session: async () => {
        throw new Error(JSON.stringify({ authorization: "error-secret-value", visible: true }))
      },
    }
    const report = await inspectTrajectory(
      fixture.store,
      host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain("error-secret-value")
    expect(serialized).toContain("[REDACTED]")
    expect(report.effort.tokenUsage.total).toBeNull()
    expect(report.effort.tokenUsage.unknownAttempts).toHaveLength(2)
  } finally {
    fixture.close()
  }
})

test("trajectory reads leave seeded task, attempt, progress, effect, transition, audit rows and watermark unchanged", async () => {
  const fixture = makeFixture()
  try {
    new ProgressRecorder(fixture.store, "project").recordNativeEvent({
      id: "read-only-seeded-progress",
      type: "session.step.started",
      created: 1_500,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "read-only-seeded-message",
        agent: "lazers-implementor",
        model: { providerID: "openai", id: "seeded-model", variant: "high" },
      },
    })
    const before = fixture.repository.atomic((db) => ({
      taskChanges: fixture.repository.version(),
      taskRows: JSON.stringify(db.query("SELECT * FROM tasks ORDER BY rowid").all()),
      attemptRows: JSON.stringify(db.query("SELECT * FROM runner_attempts ORDER BY rowid").all()),
      transitionRows: JSON.stringify(
        db.query("SELECT * FROM runner_transitions ORDER BY rowid").all(),
      ),
      effectRows: JSON.stringify(db.query("SELECT * FROM runner_effects ORDER BY rowid").all()),
      tasks: db.query<{ count: number }, []>("SELECT count(*) AS count FROM tasks").get()!.count,
      attempts: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_attempts")
        .get()!.count,
      transitions: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_transitions")
        .get()!.count,
      effects: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_effects")
        .get()!.count,
      progress: JSON.stringify(db.query("SELECT * FROM runner_progress ORDER BY seq").all()),
      progressCount: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_progress")
        .get()!.count,
    }))
    const oldAudit = fixture.store.audit.bind(fixture.store)
    fixture.store.audit = () => {
      throw new Error("audit must not run during a trajectory read")
    }
    await inspectTrajectory(fixture.store, fixture.host, "project", parse({ taskID }), cursorSecret)
    fixture.store.audit = oldAudit
    const after = fixture.repository.atomic((db) => ({
      taskChanges: fixture.repository.version(),
      taskRows: JSON.stringify(db.query("SELECT * FROM tasks ORDER BY rowid").all()),
      attemptRows: JSON.stringify(db.query("SELECT * FROM runner_attempts ORDER BY rowid").all()),
      transitionRows: JSON.stringify(
        db.query("SELECT * FROM runner_transitions ORDER BY rowid").all(),
      ),
      effectRows: JSON.stringify(db.query("SELECT * FROM runner_effects ORDER BY rowid").all()),
      tasks: db.query<{ count: number }, []>("SELECT count(*) AS count FROM tasks").get()!.count,
      attempts: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_attempts")
        .get()!.count,
      transitions: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_transitions")
        .get()!.count,
      effects: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_effects")
        .get()!.count,
      progress: JSON.stringify(db.query("SELECT * FROM runner_progress ORDER BY seq").all()),
      progressCount: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_progress")
        .get()!.count,
    }))
    expect(after).toEqual(before)
  } finally {
    fixture.close()
  }
})

test.each([
  { costs: [0, 0], subtotal: 0, status: "worker-attempt-only" },
  { costs: [null, 2.5], subtotal: 2.5, status: "partial" },
  { costs: [1.25, 2.5], subtotal: 3.75, status: "worker-attempt-only" },
])(
  "S9-1 short and full recorded-cost summaries agree for $status / $subtotal",
  async ({ costs, subtotal, status }) => {
    const fixture = makeFixture()
    try {
      fixture.store.atomic((db) => {
        fixture.attempts.forEach((attempt, i) =>
          db
            .query("UPDATE runner_attempts SET cost=? WHERE id=?")
            .run(costs[i] ?? null, attempt.id),
        )
      })
      const report = await inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID }),
        cursorSecret,
      )
      expect(report.effort.recordedCost.workerAttemptSubtotalUsd).toBe(subtotal)
      expect(report.effort.recordedCost.status).toBe(status)
      expect(report.effort.recordedCost.workerAttemptSubtotalUsd).toBe(
        report.effort.taskEffortBasis.cost.recordedWorkerAttemptSubtotalUSD.valueUSD,
      )
      expect(report.effort.recordedCost.status).toBe(
        report.effort.taskEffortBasis.cost.recordedWorkerAttemptSubtotalUSD.status,
      )
    } finally {
      fixture.close()
    }
  },
)

test.each(["cumulative", "additive", "missing"])(
  "S9-2 missing native sessions use the shared %s accounting selection",
  async (basis) => {
    const fixture = makeFixture()
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      if (basis !== "missing")
        for (const attempt of fixture.attempts) {
          recorder.recordNativeEvent({
            id: `retained-${attempt.session_id}`,
            type: basis === "cumulative" ? "session.usage.updated" : "session.step.ended",
            created: 5000,
            data: {
              sessionID: attempt.session_id,
              assistantMessageID: `retained-${attempt.id}`,
              tokens: { input: 1000, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
            },
          })
        }
      fixture.sessions.clear()
      const report = await inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID }),
        cursorSecret,
      )
      const usage = report.effort.tokenUsage
      const categories = report.effort.taskEffortBasis.usage.categories
      for (const key of [
        "uncachedInput",
        "output",
        "reasoning",
        "cacheRead",
        "cacheWrite",
      ] as const)
        expect(usage.measuredSubtotal[key]).toBe(categories[key].value)
      expect(usage.measuredSubtotal.uncachedInput).toBe(basis === "missing" ? null : 2000)
      if (basis === "cumulative") {
        expect(usage.total).toEqual(usage.measuredSubtotal)
        expect(usage.knownSessions).toBe(2)
        expect(usage.unknownAttempts).toEqual([])
      } else {
        expect(usage.total).toBeNull()
        expect(usage.unknownAttempts).toHaveLength(2)
      }
    } finally {
      fixture.close()
    }
  },
)

test("the task report carries the Tasks reference when one exists and omits it otherwise", async () => {
  const fixture = makeFixture()
  try {
    const read = () =>
      inspectTrajectory(fixture.store, fixture.host, "project", parse({ taskID }), cursorSecret)
    const expected = fixture.repository.referenceFor(taskID)
    expect(expected).toMatch(/^LZ-\d+$/)
    expect((await read()).task.reference).toBe(expected)
    fixture.store.atomic((db) => db.query("DELETE FROM task_references").run())
    const bare = await read()
    expect(Object.hasOwn(bare.task, "reference")).toBe(false)
  } finally {
    fixture.close()
  }
})

test("trajectory marks an attempt with an open concern and an Architect takeover attempt", async () => {
  const fixture = makeFixture()
  try {
    const read = async () =>
      (
        (await inspectTrajectory(
          fixture.store,
          fixture.host,
          "project",
          parse({ taskID }),
          cursorSecret,
        )) as { attempts: Array<Record<string, unknown>> }
      ).attempts
    // Nothing recorded: no attempt carries either field.
    for (const attempt of await read()) {
      expect(attempt).not.toHaveProperty("concern")
      expect(attempt).not.toHaveProperty("takeover")
    }
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_nodes SET state='running'").run()
    })
    new HandoffStore(fixture.store.repository).recordConcern(
      {
        requestID: "concern-request",
        concernID: crypto.randomUUID(),
        sourceAttemptID: firstAttemptID,
        ruleID: "verify-rounds-repeated",
        reason: "3 verification rounds",
        evidenceBoundary: { fromSequence: 0, throughSequence: 1 },
        evidence: [
          {
            kind: "trajectory",
            reference: "runner:1",
            note: "n; magnitude=3; action=takeover; because=Rounds keep failing",
          },
        ],
      },
      DETECTOR_ACTOR,
    )
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET policy=? WHERE id<>?").run(
        JSON.stringify({
          agent: "architect",
          takeover: {
            takeoverID: crypto.randomUUID(),
            architectSessionID: "architect",
            fromAttemptID: firstAttemptID,
          },
        }),
        firstAttemptID,
      )
    })
    const attempts = await read()
    const first = attempts.find((attempt) => attempt.id === firstAttemptID)!
    expect(first.concern).toEqual({
      line: "3 verification rounds",
      action: "takeover",
      because: "Rounds keep failing",
    })
    expect(first).not.toHaveProperty("takeover")
    const others = attempts.filter((attempt) => attempt.id !== firstAttemptID)
    expect(others.length).toBeGreaterThan(0)
    for (const attempt of others) {
      expect(attempt.takeover).toEqual({ agent: "architect" })
      expect(attempt).not.toHaveProperty("concern")
    }
  } finally {
    fixture.close()
  }
})

test("an Architect takeover attempt is not read as a missing worker session and adds no unknown usage", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) => {
      db.query(
        "UPDATE runner_attempts SET policy=?,session_id='lazers-takeover:request',token_count=NULL,cost=NULL WHERE id<>?",
      ).run(
        JSON.stringify({
          agent: "architect",
          takeover: { takeoverID: "t", architectSessionID: "a", fromAttemptID: firstAttemptID },
        }),
        firstAttemptID,
      )
    })
    const asked: string[] = []
    const host = {
      ...fixture.host,
      session: (id: string, ...rest: unknown[]) => {
        asked.push(id)
        return (fixture.host.session as (...args: unknown[]) => unknown)(id, ...rest)
      },
    } as typeof fixture.host
    const report = (await inspectTrajectory(
      fixture.store,
      host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )) as {
      attempts: Array<{ id: string; takeover?: unknown }>
      effort: { tokenUsage: { unknownAttempts: string[]; legacyAttemptScalarsNotAdded: unknown[] } }
      coverage: { attemptsWithoutRecordedSessions: number; unavailableSessionContexts: number }
    }
    const takeovers = report.attempts.filter((attempt) => attempt.takeover)
    expect(takeovers.length).toBeGreaterThan(0)
    expect(asked.some((id) => id.startsWith("lazers-takeover:"))).toBe(false)
    for (const attempt of takeovers) {
      expect(report.effort.tokenUsage.unknownAttempts).not.toContain(attempt.id)
      expect(JSON.stringify(report.effort.tokenUsage.legacyAttemptScalarsNotAdded)).not.toContain(
        attempt.id,
      )
    }
    expect(report.coverage.unavailableSessionContexts).toBe(0)
    expect(report.coverage.attemptsWithoutRecordedSessions).toBe(0)
  } finally {
    fixture.close()
  }
})
