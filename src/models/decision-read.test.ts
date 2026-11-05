import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import {
  defaultModelPriceSourcePolicy,
  ModelPriceSourceSettingsSchema,
} from "./price-source-settings.ts"
import { createModelDecisionReader } from "./decision-read.ts"
import type { ModelDecisionRoute } from "./decision-contract.ts"
import { ModelDecisionReadInputSchema } from "./decision-contract.ts"
import { modelConfigurationID } from "./model-identity.ts"
import { CurrentPriceApplicabilitySchema, buildCurrentPriceIndex } from "./current-price-index.ts"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import type { CurrentPriceIndex } from "./valuation-schema.ts"
import { ModelEvidenceSnapshotSchema } from "./source-schema.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"
import capturedCatalogs from "../../test/models-current-price-index/fixtures/captured-catalogs.json" with { type: "json" }
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"

const completeUsage = (input: number) => ({
  input,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

function observedRoute(route: ModelDecisionRoute) {
  return { status: "observed", route }
}

function rewriteAttemptFacts(
  path: string,
  projectID: string,
  attemptID: string,
  route: ModelDecisionRoute,
  inputBySequence?: readonly number[],
) {
  const db = new Database(path, { strict: true })
  try {
    const rows = db
      .query<{ seq: number; kind: string; payload: string }, [string]>(
        "SELECT seq,kind,payload FROM runner_progress WHERE attempt_id=? ORDER BY seq",
      )
      .all(attemptID)
    let stepIndex = 0
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      if (row.kind === "step") {
        const input = inputBySequence?.[stepIndex]
        if (input !== undefined) payload.usage = completeUsage(input)
        payload.routeEvidence = observedRoute(route)
        payload.route = route
        stepIndex++
      } else if (row.kind === "usage-snapshot") {
        payload.usage = completeUsage(inputBySequence?.[0] ?? 100)
        payload.routeEvidence = observedRoute(route)
        payload.route = route
      }
      db.query("UPDATE runner_progress SET payload=?,message_id=? WHERE seq=?").run(
        JSON.stringify(payload),
        `decision-test-call-${row.seq}`,
        row.seq,
      )
    }

    const owner = db
      .query<{ task_id: string; session_id: string }, [string]>(
        "SELECT task_id,session_id FROM runner_attempts WHERE id=?",
      )
      .get(attemptID)
    const plan = db
      .query<{ plan_id: string; project_directory: string }, [string]>(
        "SELECT a.plan_id,p.project_directory FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id WHERE a.id=?",
      )
      .get(attemptID)
    assert.ok(owner && plan)
    const insertProgress = (
      kind: "step" | "usage-snapshot",
      payload: Record<string, unknown>,
      suffix: string,
    ) => {
      db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
          source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        plan.project_directory,
        projectID,
        plan.plan_id,
        owner.task_id,
        attemptID,
        owner.session_id,
        4_000,
        4_011,
        "runtime",
        JSON.stringify(["runtime"]),
        kind,
        JSON.stringify([]),
        null,
        kind === "step" ? `decision-test-call-${attemptID}` : null,
        `decision-test-${suffix}-${attemptID}`,
        JSON.stringify(payload),
      )
    }

    if (!rows.some((row) => row.kind === "usage-snapshot") && inputBySequence?.length) {
      const cumulativeInput = inputBySequence.reduce((total, value) => total + value, 0)
      insertProgress(
        "usage-snapshot",
        {
          additive: false,
          measurementBasis: "cumulative-session-snapshot",
          usage: completeUsage(cumulativeInput),
        },
        "usage",
      )
    }

    if (!rows.some((row) => row.kind === "step")) {
      insertProgress("step", { routeEvidence: observedRoute(route), route }, "route")
    }
  } finally {
    db.close()
  }
}

function rewriteAttemptUsage(path: string, attemptID: string, input: number) {
  const db = new Database(path, { strict: true })
  try {
    const rows = db
      .query<{ seq: number; payload: string }, [string]>(
        "SELECT seq,payload FROM runner_progress WHERE attempt_id=? ORDER BY seq",
      )
      .all(attemptID)
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      payload.usage = completeUsage(input)
      db.query("UPDATE runner_progress SET payload=? WHERE seq=?").run(
        JSON.stringify(payload),
        row.seq,
      )
    }
  } finally {
    db.close()
  }
}

function pin(route: ModelDecisionRoute, rate: string, generation = 1) {
  const snapshotID = `aaaaaaaa-aaaa-4aaa-8aaa-${generation.toString(16).padStart(12, "0")}`
  return {
    route,
    productID: `${route.providerID}/${route.modelID}`,
    configurationID: modelConfigurationID(route.providerID, route.modelID, route.variant),
    semantics: "quote" as const,
    resolution: {
      route: "resolved" as const,
      sku: "resolved" as const,
      configuration: "resolved" as const,
      tier: "resolved" as const,
      schedule: "not-applicable" as const,
    },
    tier: {
      id: "base",
      contextTierTokens: null,
      minPromptTokens: null,
      utcStart: null,
      utcEnd: null,
    },
    rates: {
      unit: "USD per token" as const,
      uncachedInput: rate,
      completion: rate,
      cacheRead: rate,
      cacheWrite: rate,
    },
    provenance: {
      source: "openrouter-models" as const,
      snapshotID,
      generation,
      retrievedAt: "2026-11-05T12:00:00.000Z",
      asOf: null,
      sourceURL: "https://openrouter.ai/api/v1/models",
      recordIndex: 0,
      recordID: route.modelID,
    },
  }
}

function inputFor(projectDirectory: string) {
  return ModelDecisionReadInputSchema.parse({
    schemaVersion: 2,
    scope: { projectDirectory },
    filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  })
}

function priceSettings() {
  return ModelPriceSourceSettingsSchema.parse({
    policy: defaultModelPriceSourcePolicy(),
    access: { openrouter: "configured", opencode: "not-configured" },
  })
}

function orderedOpenRouterSettings() {
  return ModelPriceSourceSettingsSchema.parse({
    policy: {
      schemaVersion: 1,
      revision: 0,
      sources: ["openrouter"],
      fallback: "whole-model",
    },
    access: { openrouter: "configured", opencode: "not-configured" },
  })
}

function saveCapturedOpenRouterSnapshot(
  store: ModelEvidenceStore,
  projectDirectory: string,
  generation: number,
  promptRate: string,
) {
  const source = ModelEvidenceSnapshotSchema.parse(capturedCatalogs.openrouter)
  if (source.source !== "openrouter-models") throw new Error("Expected captured OpenRouter source")
  const snapshot = ModelEvidenceSnapshotSchema.parse({
    ...source,
    snapshotID: crypto.randomUUID(),
    projectDirectory,
    generation,
    retrievedAt: new Date(Date.now() + generation).toISOString(),
    records: source.records.map((record) => {
      if (record.id !== "openai/fixture-model" || !record.prices) return record
      return {
        ...record,
        prices: {
          ...record.prices,
          tiers: record.prices.tiers.map((tier) => ({ ...tier, prompt: promptRate })),
        },
      }
    }),
  })
  if (snapshot.source !== "openrouter-models") throw new Error("Expected OpenRouter snapshot")
  store.saveSnapshot(snapshot)
}

function makePriceIndex(
  routes: readonly { route: ModelDecisionRoute }[],
  generation = 1,
): CurrentPriceIndex {
  return {
    indexID: `decision-test-price-index:${generation}`,
    retrievedAt: "2026-11-05T12:00:00.000Z",
    pins: routes.map(({ route }) =>
      pin(
        route,
        route.modelID === "b-model" ? "0.00000001" : generation > 1 ? "0.000002" : "0.000001",
        generation,
      ),
    ),
  }
}

function addAdoptedUsage(fixture: ReturnType<typeof makeLedgerFixture>, route: ModelDecisionRoute) {
  rewriteAttemptFacts(fixture.path, fixture.projectID, fixture.attempts.failed.id, {
    providerID: "openrouter",
    modelID: "a-model",
    variant: "medium",
  })
  rewriteAttemptFacts(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    { providerID: "openrouter", modelID: "b-model", variant: "medium" },
    [20, 30],
  )
  const db = new Database(fixture.path, { strict: true })
  try {
    const attempt = fixture.attempts.adoption
    const planID = fixture.plans.adoption!
    const plan = db
      .query<{ project_directory: string }, [string]>(
        "SELECT project_directory FROM runner_plans WHERE id=?",
      )
      .get(planID)
    assert.ok(plan)
    db.query(
      `INSERT INTO runner_progress
       (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
        source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      plan.project_directory,
      fixture.projectID,
      planID,
      fixture.tasks.adoption!.id,
      attempt.id,
      attempt.session_id,
      3_900,
      3_911,
      "runtime",
      JSON.stringify(["runtime"]),
      "usage-snapshot",
      JSON.stringify([]),
      null,
      null,
      `decision-adopted-usage-${attempt.id}`,
      JSON.stringify({
        additive: false,
        measurementBasis: "cumulative-session-snapshot",
        usage: completeUsage(50),
      }),
    )
  } finally {
    db.close()
  }
  rewriteAttemptFacts(fixture.path, fixture.projectID, fixture.attempts.adoption.id, route, [50])
}

test("production decision projection preserves exact route effort, adopted acceptance, retry history and global frontier before paging", async () => {
  const fixture = makeLedgerFixture()
  const alpha = { providerID: "openrouter", modelID: "a-model", variant: "medium" }
  const beta = { providerID: "openrouter", modelID: "b-model", variant: "medium" }
  let priceGeneration = 1
  addAdoptedUsage(fixture, alpha)
  const captures = { count: 0, closes: 0 }
  const reader = createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger() {
      const ledger = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory)
      return {
        decisionRevision: () => ledger.decisionRevision(),
        readDecision(signal) {
          captures.count++
          return ledger.readDecision(signal)
        },
        close() {
          captures.closes++
          ledger.close()
        },
      }
    },
    async readPriceState(routes) {
      return {
        settings: priceSettings(),
        index: makePriceIndex(routes, priceGeneration),
        freshness: "current",
      }
    },
  })
  try {
    const input = inputFor(fixture.projectDirectory)
    const overview = await reader.overview(input)
    expect(overview.context.availability).toBe("partial")
    expect(overview.graph.scope).toBe("global-filtered-snapshot")
    expect(overview.graph.frontierConfigurationIDs).toEqual([
      `configuration:${modelConfigurationID(beta.providerID, beta.modelID, beta.variant)}`,
    ])

    const firstPage = await reader.rows({ ...input, limit: 1 })
    expect(firstPage.rows).toHaveLength(1)
    expect(firstPage.rows[0]?.configuration.route).toEqual(alpha)
    expect(firstPage.rows[0]).toMatchObject({
      cohort: { acceptedTaskCount: 1, failedAttemptCount: 2 },
      efficiency: {
        status: "single-observation",
        tokensPerAcceptedTask: 150,
      },
    })
    expect(firstPage.rows[0]?.efficiency.currentMarketUSDPerAcceptedTask).toBeCloseTo(0.00015)
    expect(firstPage.context.snapshotID).toBe(overview.context.snapshotID)
    expect(firstPage.nextCursor).toBeTruthy()

    const betaID = `configuration:${modelConfigurationID(beta.providerID, beta.modelID, beta.variant)}`
    const inspected = await reader.inspect({
      ...input,
      snapshotID: overview.context.snapshotID,
      configurationID: betaID,
      selectedTaskID: null,
      contributorLimit: 100,
    })
    expect(inspected.status).toBe("found")
    if (inspected.status !== "found") return
    expect(inspected.estimate).toMatchObject({
      status: "single-observation",
      observationCount: 1,
      range: { tokens: { minimum: 150, maximum: 150 } },
      historyScope: {
        completeness: "complete-accepted-logical-task-retry-history",
        routeScope: "cross-route",
      },
    })
    expect(inspected.contributorPage.contributors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskReference: "LZ-1",
          route: alpha,
          contribution: "failed",
          membership: "empirical-history",
          tokens: 100,
        }),
        expect.objectContaining({
          taskReference: "LZ-1",
          route: beta,
          contribution: "accepted",
          membership: "both",
          tokens: 50,
        }),
      ]),
    )

    const originalPinID = overview.context.priceIndex.pins[0]?.snapshotID
    assert.ok(originalPinID)
    priceGeneration++
    const remaining = await reader.rows({ ...input, cursor: firstPage.nextCursor!, limit: 1 })
    expect(remaining.rows[0]?.configuration.route).toEqual(beta)
    expect(remaining.context.snapshotID).toBe(overview.context.snapshotID)
    expect(remaining.context.priceIndex.pins[0]?.snapshotID).toBe(originalPinID)
    expect(captures.count).toBe(1)
    expect(captures.closes).toBeGreaterThanOrEqual(1)

    const refreshed = await reader.overview(input)
    expect(refreshed.context.snapshotID).not.toBe(overview.context.snapshotID)
    expect(refreshed.context.priceIndex.pins[0]?.snapshotID).not.toBe(originalPinID)
    expect(captures.count).toBe(2)
    const oldSnapshotInspection = await reader.inspect({
      ...input,
      snapshotID: overview.context.snapshotID,
      configurationID: betaID,
      selectedTaskID: null,
      contributorLimit: 100,
    })
    expect(oldSnapshotInspection.context.snapshotID).toBe(overview.context.snapshotID)
    expect(oldSnapshotInspection.context.priceIndex.pins[0]?.snapshotID).toBe(originalPinID)
  } finally {
    reader.close()
    fixture.close()
  }
})

test("unrelated SQLite commits during capture, pricing and cached pages do not invalidate a project snapshot", async () => {
  const fixture = makeLedgerFixture()
  addAdoptedUsage(fixture, {
    providerID: "openrouter",
    modelID: "a-model",
    variant: "medium",
  })
  const writer = new Database(fixture.path, { strict: true })
  writer.exec(
    "CREATE TABLE unrelated_decision_test(value INTEGER); INSERT INTO unrelated_decision_test VALUES(0)",
  )
  const openCaptures = { count: 0 }
  let unrelatedWrites = 0
  const writeUnrelated = () => {
    writer.query("UPDATE unrelated_decision_test SET value=value+1").run()
    unrelatedWrites++
  }
  const reader = createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger() {
      const ledger = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory)
      return {
        decisionRevision: () => ledger.decisionRevision(),
        readDecision(signal) {
          openCaptures.count++
          const capture = ledger.readDecision(signal)
          if (openCaptures.count === 1) writeUnrelated()
          return capture
        },
        close: () => ledger.close(),
      }
    },
    async readPriceState(routes) {
      writeUnrelated()
      return { settings: priceSettings(), index: makePriceIndex(routes), freshness: "current" }
    },
  })
  try {
    const input = inputFor(fixture.projectDirectory)
    const overview = await reader.overview(input)
    const first = await reader.rows({ ...input, limit: 1 })
    expect(first.context.snapshotID).toBe(overview.context.snapshotID)
    expect(first.nextCursor).toBeTruthy()
    writeUnrelated()
    const second = await reader.rows({ ...input, cursor: first.nextCursor!, limit: 1 })
    expect(second.context.snapshotID).toBe(overview.context.snapshotID)
    expect(openCaptures.count).toBe(1)
    expect(unrelatedWrites).toBeGreaterThanOrEqual(4)
  } finally {
    reader.close()
    writer.close()
    fixture.close()
  }
})

test("relevant concurrent updates preserve pinned pages and the next read refreshes the whole snapshot", async () => {
  const fixture = makeLedgerFixture()
  const route = { providerID: "openrouter", modelID: "a-model", variant: "medium" }
  addAdoptedUsage(fixture, route)
  const writer = new Database(fixture.path, { strict: true })
  let captureCount = 0
  let priceReads = 0
  let capturedRevision: number | null = null
  const reader = createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger() {
      const ledger = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory)
      return {
        decisionRevision: () => ledger.decisionRevision(),
        readDecision(signal) {
          captureCount++
          const capture = ledger.readDecision(signal)
          if (capture.status === "captured") capturedRevision = capture.sourceRevision
          if (captureCount === 1) rewriteAttemptUsage(fixture.path, fixture.attempts.failed.id, 201)
          return capture
        },
        close: () => ledger.close(),
      }
    },
    async readPriceState(routes) {
      priceReads++
      if (priceReads === 1) {
        await Promise.resolve()
        rewriteAttemptUsage(fixture.path, fixture.attempts.failed.id, 301)
      }
      return { settings: priceSettings(), index: makePriceIndex(routes), freshness: "current" }
    },
  })
  try {
    const input = inputFor(fixture.projectDirectory)
    const first = await reader.rows({ ...input, limit: 1 })
    assert.ok(first.nextCursor)
    const pinnedTokens = first.rows[0]?.efficiency.tokensPerAcceptedTask
    expect(first.rows[0]?.configuration.route).toEqual(route)
    expect(pinnedTokens).toBeGreaterThan(0)
    expect(first.context.priceIndex.note).toContain(
      `project observation revision ${capturedRevision}`,
    )

    rewriteAttemptUsage(fixture.path, fixture.attempts.failed.id, 401)
    const second = await reader.rows({ ...input, cursor: first.nextCursor, limit: 1 })
    expect(second.context.snapshotID).toBe(first.context.snapshotID)
    expect(second.context.priceIndex.note).toBe(first.context.priceIndex.note)
    expect(captureCount).toBe(1)

    const refreshed = await reader.overview(input)
    expect(refreshed.context.snapshotID).not.toBe(first.context.snapshotID)
    const refreshedRows = await reader.rows({ ...input, limit: 100 })
    const refreshedRoute = refreshedRows.rows.find(
      (row) => row.configuration.configurationID === first.rows[0]!.configuration.configurationID,
    )
    assert.ok(refreshedRoute)
    expect(refreshedRoute.efficiency.tokensPerAcceptedTask).not.toBe(pinnedTokens)
    expect(refreshed.context.priceIndex.note).toContain("project observation revision")
    expect(captureCount).toBe(2)
  } finally {
    reader.close()
    writer.close()
    fixture.close()
  }
})

test("malformed retained evidence stays visibly partial rather than becoming an empty success", async () => {
  const fixture = makeLedgerFixture()
  const writer = new Database(fixture.path, { strict: true })
  const row = writer
    .query<{ seq: number }, []>("SELECT seq FROM runner_progress ORDER BY seq LIMIT 1")
    .get()
  assert.ok(row)
  writer.query("UPDATE runner_progress SET payload='not-json' WHERE seq=?").run(row.seq)
  writer.close()
  const reader = createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger: () => openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory),
    async readPriceState(routes) {
      return { settings: priceSettings(), index: makePriceIndex(routes), freshness: "current" }
    },
  })
  try {
    const overview = await reader.overview(inputFor(fixture.projectDirectory))
    expect(overview.context.availability).toBe("partial")
  } finally {
    reader.close()
    fixture.close()
  }
})

test("an ordered-source quote refresh reprices market efficiency without changing retained work or charges", async () => {
  const fixture = makeLedgerFixture()
  const route = { providerID: "openai", modelID: "fixture-model", variant: "high" }
  rewriteAttemptFacts(fixture.path, fixture.projectID, fixture.attempts.failed.id, route)
  rewriteAttemptFacts(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    route,
    [20, 30],
  )
  const sourceStore = new ModelEvidenceStore(fixture.path, fixture.projectDirectory)
  const firstGeneration = sourceStore.beginRefresh()["openrouter-models"]
  saveCapturedOpenRouterSnapshot(sourceStore, fixture.projectDirectory, firstGeneration, "0.000002")
  const settings = orderedOpenRouterSettings()
  let captures = 0
  const reader = createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger() {
      const ledger = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory)
      return {
        decisionRevision: () => ledger.decisionRevision(),
        readDecision(signal) {
          captures++
          return ledger.readDecision(signal)
        },
        close: () => ledger.close(),
      }
    },
    async readPriceState(routes) {
      const store = new ModelEvidenceReadStore(fixture.path, fixture.projectDirectory)
      try {
        const sources = store.readComparisonSources()
        const index = buildCurrentPriceIndex({
          sourceStore: { readComparisonSources: () => sources },
          priceSources: settings,
          observedRoutes: routes.map(({ route: observed }) =>
            CurrentPriceApplicabilitySchema.parse({ route: observed }),
          ),
        })
        return { settings, index, freshness: "current" }
      } finally {
        store.close()
      }
    },
  })
  try {
    const input = inputFor(fixture.projectDirectory)
    const first = await reader.overview(input)
    const originalPriceSnapshot = first.context.priceIndex.pins[0]?.snapshotID
    assert.ok(originalPriceSnapshot)
    const configurationID = `configuration:${modelConfigurationID(
      route.providerID,
      route.modelID,
      route.variant,
    )}`
    const beforeInspection = await reader.inspect({
      ...input,
      snapshotID: first.context.snapshotID,
      configurationID,
      selectedTaskID: fixture.tasks.retry!.id,
      contributorLimit: 100,
    })
    expect(beforeInspection.status).toBe("found")
    if (beforeInspection.status !== "found") return
    const beforeRow = (await reader.rows({ ...input, limit: 100 })).rows.find(
      (candidate) => candidate.configuration.configurationID === configurationID,
    )
    assert.ok(beforeRow)

    const nextGeneration = sourceStore.beginRefresh()["openrouter-models"]
    saveCapturedOpenRouterSnapshot(
      sourceStore,
      fixture.projectDirectory,
      nextGeneration,
      "0.000004",
    )
    const next = await reader.overview(input)
    const afterInspection = await reader.inspect({
      ...input,
      snapshotID: next.context.snapshotID,
      configurationID,
      selectedTaskID: fixture.tasks.retry!.id,
      contributorLimit: 100,
    })
    expect(afterInspection.status).toBe("found")
    if (afterInspection.status !== "found") return
    const afterRow = (await reader.rows({ ...input, limit: 100 })).rows.find(
      (candidate) => candidate.configuration.configurationID === configurationID,
    )
    assert.ok(afterRow)

    expect(next.context.snapshotID).not.toBe(first.context.snapshotID)
    expect(next.context.priceIndex.pins[0]?.snapshotID).not.toBe(originalPriceSnapshot)
    expect(beforeRow.efficiency.tokensPerAcceptedTask).toBe(
      afterRow.efficiency.tokensPerAcceptedTask,
    )
    expect(beforeRow.efficiency.currentMarketUSDPerAcceptedTask).toBeGreaterThan(0)
    expect(afterRow.efficiency.currentMarketUSDPerAcceptedTask).toBeCloseTo(
      beforeRow.efficiency.currentMarketUSDPerAcceptedTask! * 2,
    )
    expect(afterRow.nativeReportedCost).toEqual(beforeRow.nativeReportedCost)
    expect(afterInspection.estimate.range.tokens).toEqual(beforeInspection.estimate.range.tokens)
    expect(afterInspection.estimate.range.currentMarketUSD).toEqual({
      minimum: beforeInspection.estimate.range.currentMarketUSD!.minimum * 2,
      maximum: beforeInspection.estimate.range.currentMarketUSD!.maximum * 2,
    })
    expect(
      afterInspection.contributorPage.contributors.map((contributor) => ({
        taskID: contributor.taskID,
        route: contributor.route,
        contribution: contributor.contribution,
        membership: contributor.membership,
        tokens: contributor.tokens,
      })),
    ).toEqual(
      beforeInspection.contributorPage.contributors.map((contributor) => ({
        taskID: contributor.taskID,
        route: contributor.route,
        contribution: contributor.contribution,
        membership: contributor.membership,
        tokens: contributor.tokens,
      })),
    )
    expect(captures).toBe(2)
  } finally {
    reader.close()
    sourceStore.close()
    fixture.close()
  }
})

test("pre-abort avoids capture and cancellation after awaited pricing rejects without leaking the ledger reader", async () => {
  const fixture = makeLedgerFixture()
  let captures = 0
  let closes = 0
  let priceReads = 0
  const controller = new AbortController()
  const reader = createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger() {
      const ledger = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory)
      return {
        decisionRevision: () => ledger.decisionRevision(),
        readDecision(signal) {
          captures++
          return ledger.readDecision(signal)
        },
        close() {
          closes++
          ledger.close()
        },
      }
    },
    async readPriceState(routes) {
      priceReads++
      if (priceReads === 1) controller.abort()
      return { settings: priceSettings(), index: makePriceIndex(routes), freshness: "current" }
    },
  })
  try {
    const input = inputFor(fixture.projectDirectory)
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(reader.overview(input, { signal: alreadyAborted.signal })).rejects.toThrow()
    expect(captures).toBe(0)
    expect(closes).toBe(0)

    await expect(reader.overview(input, { signal: controller.signal })).rejects.toThrow()
    expect(captures).toBe(1)
    expect(closes).toBe(1)

    const successful = await reader.overview(input)
    expect(successful.context.snapshotID).toContain("models-decision-v2:")
    expect(captures).toBe(2)
    expect(closes).toBeGreaterThanOrEqual(2)
  } finally {
    reader.close()
    fixture.close()
  }
})
