import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  defaultModelPriceSourcePolicy,
  ModelPriceSourceSettingsSchema,
} from "./price-source-settings.ts"
import { createModelDecisionReader } from "./decision-read.ts"
import type { ModelDecisionRoute } from "./decision-contract.ts"
import { ModelDecisionReadInputSchema } from "./decision-contract.ts"
import { modelConfigurationID } from "./model-identity.ts"
import { CurrentPriceApplicabilitySchema, buildCurrentPriceIndex } from "./current-price-index.ts"
import type { CurrentPriceApplicability } from "./current-price-index.ts"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import type { CurrentPriceIndex } from "./valuation-schema.ts"
import { ModelEvidenceSnapshotSchema } from "./source-schema.ts"
import { ENDPOINT_PRICING_PRODUCTS, EndpointPricingRecordSchema } from "./endpoint-pricing.ts"
import type { EndpointPricingProductID } from "./endpoint-pricing.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"
import { projectTaskValuation } from "./valuation.ts"
import { readEndpointPricingEvidence } from "./market-range-evidence.ts"
import capturedCatalogs from "../../test/models-current-price-index/fixtures/captured-catalogs.json" with { type: "json" }
import capturedIdentity from "../../test/models-identity/fixtures/captured-20261103.json" with { type: "json" }
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
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

function rewriteAttemptUsage(
  path: string,
  attemptID: string,
  input: number,
  output = 0,
  cacheWrite: number | null = 0,
) {
  const db = new Database(path, { strict: true })
  try {
    const rows = db
      .query<{ seq: number; payload: string }, [string]>(
        "SELECT seq,payload FROM runner_progress WHERE attempt_id=? ORDER BY seq",
      )
      .all(attemptID)
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      payload.usage = { ...completeUsage(input), output, cacheWrite }
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

function pinWithMissingCompletionRate(route: ModelDecisionRoute, generation: number) {
  const quote = pin(route, "0.000001", generation)
  return { ...quote, rates: { ...quote.rates, completion: null } }
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
  missingCacheWriteRate = false,
  tieredPromptTiers = false,
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
          tiers: record.prices.tiers.flatMap((tier) => {
            const updated = {
              ...tier,
              prompt: promptRate,
              ...(missingCacheWriteRate ? { inputCacheWrite: null } : {}),
            }
            return tieredPromptTiers
              ? [
                  { ...updated, minPromptTokens: null },
                  { ...updated, minPromptTokens: 100_000, prompt: "0.000004" },
                ]
              : [updated]
          }),
        },
      }
    }),
  })
  if (snapshot.source !== "openrouter-models") throw new Error("Expected OpenRouter snapshot")
  store.saveSnapshot(snapshot)
}

function saveLunaEndpointSnapshot(
  store: ModelEvidenceStore,
  projectDirectory: string,
  promptRate: string,
  overridePromptRate: string,
) {
  const productID: EndpointPricingProductID = "openai/gpt-6-luna"
  const generation = store.beginEndpointPricingRefresh()[productID]
  const product = ENDPOINT_PRICING_PRODUCTS.find((item) => item.productID === productID)!
  const record = EndpointPricingRecordSchema.parse({
    productID,
    name: "OpenAI GPT-6 Luna",
    providerName: "OpenAI",
    tag: "openai",
    serviceTier: null,
    pricing: {
      unit: "USD per token",
      prompt: promptRate,
      completion: "0.0000005",
      inputCacheRead: "0.00000001",
      inputCacheWrite: "0.000000125",
      overrides: [
        {
          minPromptTokens: 272_000,
          prompt: overridePromptRate,
          completion: "0.00000075",
          inputCacheRead: "0.00000002",
          inputCacheWrite: "0.00000025",
        },
      ],
    },
    cacheWriteDocumentation: null,
  })
  store.saveEndpointPricingSnapshot({
    snapshotID: crypto.randomUUID(),
    projectDirectory,
    productID,
    generation,
    retrievedAt: new Date(Date.now() + generation).toISOString(),
    sourceURL: product.sourceURL,
    httpStatus: 200,
    records: [record],
  })
  return generation
}

function saveIdentityCatalogSnapshots(store: ModelEvidenceStore, projectDirectory: string) {
  const native = ModelEvidenceSnapshotSchema.parse(capturedIdentity.native.snapshot)
  const catalog = ModelEvidenceSnapshotSchema.parse(capturedIdentity.openrouter.snapshot)
  if (native.source !== "native-catalog" || catalog.source !== "openrouter-models")
    throw new Error("Expected captured native and OpenRouter identity sources")
  const generations = store.beginRefresh()
  store.saveSnapshot({
    ...native,
    snapshotID: crypto.randomUUID(),
    projectDirectory,
    generation: generations["native-catalog"],
    retrievedAt: new Date(Date.now() + generations["native-catalog"]).toISOString(),
  })
  store.saveSnapshot({
    ...catalog,
    snapshotID: crypto.randomUUID(),
    projectDirectory,
    generation: generations["openrouter-models"],
    retrievedAt: new Date(Date.now() + generations["openrouter-models"]).toISOString(),
  })
}

function readIdentitySources(
  path: string,
  projectDirectory: string,
): {
  identityCatalogSource: ModelEvidenceComparisonSourceRead | undefined
  identityNativeSource: ModelEvidenceComparisonSourceRead | undefined
} {
  const store = new ModelEvidenceReadStore(path, projectDirectory)
  try {
    const sources = store.readComparisonSources()
    return {
      identityCatalogSource: sources.find((source) => source.source === "openrouter-models"),
      identityNativeSource: sources.find((source) => source.source === "native-catalog"),
    }
  } finally {
    store.close()
  }
}

function makePriceIndex(
  routes: readonly { route: ModelDecisionRoute }[],
  generation = 1,
  pins?: CurrentPriceIndex["pins"],
): CurrentPriceIndex {
  return {
    indexID: `decision-test-price-index:${generation}`,
    retrievedAt: "2026-11-05T12:00:00.000Z",
    pins:
      pins ??
      [
        ...new Map(
          routes.map(({ route }) => [
            modelConfigurationID(route.providerID, route.modelID, route.variant),
            route,
          ]),
        ).values(),
      ].map((route) =>
        pin(
          route,
          route.modelID === "b-model" ? "0.00000001" : generation > 1 ? "0.000002" : "0.000001",
          generation,
        ),
      ),
  }
}

function fixtureDecisionReader(
  fixture: ReturnType<typeof makeLedgerFixture>,
  makeIndex: (routes: readonly { route: ModelDecisionRoute }[]) => CurrentPriceIndex,
) {
  return createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger: () => openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory),
    async readPriceState(routes) {
      return { settings: priceSettings(), index: makeIndex(routes), freshness: "current" }
    },
  })
}

function valueFixture(
  fixture: ReturnType<typeof makeLedgerFixture>,
  currentIndex: CurrentPriceIndex,
) {
  const ledger = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory)
  try {
    const capture = ledger.readDecision()
    if (capture.status !== "captured") throw new Error("Decision fixture was not captured")
    return projectTaskValuation({
      attempts: capture.tasks.flatMap((task) => task.attempts.map((attempt) => attempt.accounting)),
      progressFacts: capture.progressFacts,
      progressTruncated: false,
      truncatedContextSessionIDs: [],
      currentIndex,
    })
  } finally {
    ledger.close()
  }
}

type RetainedFactInput = {
  at: number
  kind: "step" | "usage-snapshot"
  messageID: string | null
  payload: Record<string, unknown>
}

function insertRetainedFacts(
  fixture: ReturnType<typeof makeLedgerFixture>,
  attemptID: string,
  facts: Iterable<RetainedFactInput>,
) {
  const db = new Database(fixture.path, { strict: true })
  const batchID = randomUUID()
  try {
    const owner = db
      .query<
        { task_id: string; plan_id: string; session_id: string; project_directory: string },
        [string]
      >(
        `SELECT a.task_id,a.plan_id,a.session_id,p.project_directory
         FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id WHERE a.id=?`,
      )
      .get(attemptID)
    assert.ok(owner)
    const insert = db.query(
      `INSERT INTO runner_progress
       (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
        source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    db.exec("BEGIN IMMEDIATE")
    try {
      let index = 0
      for (const fact of facts) {
        insert.run(
          owner.project_directory,
          fixture.projectID,
          owner.plan_id,
          owner.task_id,
          attemptID,
          owner.session_id,
          fact.at,
          fact.at + 1,
          "runtime",
          '["runtime"]',
          fact.kind,
          "[]",
          null,
          fact.messageID,
          `decision-history-${attemptID}-${batchID}-${index}`,
          JSON.stringify(fact.payload),
        )
        index++
      }
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  } finally {
    db.close()
  }
}

async function observeDecisionProgressPages<T>(
  action: () => Promise<T>,
  options: { fail?: boolean; afterPage?: (page: number) => void } = {},
) {
  const pages: number[] = []
  const prototype = Database.prototype
  const originalQuery = prototype.query as unknown as (
    this: Database,
    sql: string,
    ...parameters: unknown[]
  ) => unknown
  Object.defineProperty(prototype, "query", {
    configurable: true,
    writable: true,
    value: function (this: Database, sql: string, ...parameters: unknown[]) {
      if (sql.includes("FROM runner_progress r") && sql.includes("ORDER BY r.seq LIMIT ?")) {
        if (options.fail) throw new Error("injected decision progress read failure")
        const statement = originalQuery.call(this, sql, ...parameters) as {
          all(...values: unknown[]): unknown
        }
        return new Proxy(statement, {
          get(target, property) {
            if (property === "all")
              return (...values: unknown[]) => {
                pages.push(Number(values.at(-1)))
                const rows = target.all(...values)
                options.afterPage?.(pages.length)
                return rows
              }
            const value = Reflect.get(target, property, target)
            return typeof value === "function" ? value.bind(target) : value
          },
        })
      }
      return originalQuery.call(this, sql, ...parameters)
    },
  })
  try {
    const value = await action()
    return { value, pages }
  } finally {
    Object.defineProperty(prototype, "query", {
      configurable: true,
      writable: true,
      value: originalQuery,
    })
  }
}

function cachedOpenRouterReader(
  fixture: ReturnType<typeof makeLedgerFixture>,
  options: {
    missingCacheWriteRate?: boolean
    tieredPromptTiers?: boolean
    onRoutes?: (routes: readonly CurrentPriceApplicability[]) => void
    onIndex?: (index: CurrentPriceIndex) => void
  } = {},
) {
  const sourceStore = new ModelEvidenceStore(fixture.path, fixture.projectDirectory)
  const generation = sourceStore.beginRefresh()["openrouter-models"]
  saveCapturedOpenRouterSnapshot(
    sourceStore,
    fixture.projectDirectory,
    generation,
    "0.000002",
    options.missingCacheWriteRate,
    options.tieredPromptTiers,
  )
  const settings = orderedOpenRouterSettings()
  const reader = createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger: () => openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory),
    async readPriceState(routes) {
      options.onRoutes?.(routes)
      const evidence = new ModelEvidenceReadStore(fixture.path, fixture.projectDirectory)
      try {
        const sources = evidence.readComparisonSources()
        const index = buildCurrentPriceIndex({
          sourceStore: { readComparisonSources: () => sources },
          priceSources: settings,
          observedRoutes: routes,
        })
        options.onIndex?.(index)
        return {
          settings,
          index,
          freshness: "current",
        }
      } finally {
        evidence.close()
      }
    },
  })
  return {
    reader,
    close() {
      reader.close()
      sourceStore.close()
    },
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

test("decision capture streams complete progress beyond 15,000 facts and the former 64 MiB bound", async () => {
  const fixture = makeLedgerFixture()
  const routeA = { providerID: "openrouter", modelID: "boundary-model-a", variant: "high" }
  const routeB = { providerID: "anthropic", modelID: "boundary-model-b", variant: null }
  const ballast = "x".repeat(5_000)
  try {
    insertRetainedFacts(
      fixture,
      fixture.attempts.failed.id,
      (function* () {
        for (let index = 0; index < 7_500; index++) {
          if (index < 3) {
            const route = index === 0 ? routeB : null
            const routeEvidence =
              index === 0 ? observedRoute(routeB) : { status: "identity-unavailable" as const }
            yield {
              at: 5_000 + index,
              kind: "step" as const,
              messageID: `failed-boundary-step-${index}`,
              payload: {
                measurementBasis: "additive-step-measurement",
                usage: {
                  input: 1,
                  output: null,
                  reasoning: null,
                  cacheRead: null,
                  cacheWrite: null,
                },
                route: route ?? null,
                routeEvidence,
                ballast,
              },
            }
            continue
          }
          const route = index === 7_498 ? routeB : routeA
          yield {
            at: 10_000 + index,
            kind: "usage-snapshot" as const,
            messageID: null,
            payload: {
              additive: false,
              measurementBasis: "cumulative-session-snapshot",
              usage: {
                input: index === 7_499 ? 0 : 100 + index,
                output: 0,
                reasoning: null,
                cacheRead: 2,
                cacheWrite: 0,
              },
              route,
              routeEvidence: observedRoute(route),
              ballast,
            },
          }
        }
      })(),
    )
    insertRetainedFacts(
      fixture,
      fixture.attempts.accepted.id,
      (function* () {
        for (let index = 0; index < 7_501; index++) {
          let messageID: string
          let route: ModelDecisionRoute | null = routeA
          let routeEvidence: Record<string, unknown> = observedRoute(routeA)
          let input = 1
          if (index < 1_000) {
            messageID = "repeated-progress-message"
            input = index + 1
          } else if (index < 7_498) {
            messageID = `accepted-boundary-message-${index}`
          } else if (index === 7_498) {
            messageID = "accepted-boundary-route-b"
            route = routeB
            routeEvidence = observedRoute(routeB)
          } else if (index === 7_499) {
            messageID = "accepted-boundary-conflict"
            route = null
            routeEvidence = { status: "identity-unavailable" }
          } else {
            messageID = "accepted-boundary-unknown"
            route = null
            routeEvidence = { status: "identity-unavailable" }
          }
          yield {
            at: 20_000 + index,
            kind: "step" as const,
            messageID,
            payload: {
              measurementBasis: "additive-step-measurement",
              usage: { input, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
              route,
              routeEvidence,
              ballast,
            },
          }
        }
      })(),
    )

    const byteReader = new Database(fixture.path, { readonly: true, strict: true })
    const storedPayloadBytes = byteReader
      .query<{ bytes: number }, [string]>(
        "SELECT SUM(length(payload)) AS bytes FROM runner_progress WHERE project_directory=?",
      )
      .get(fixture.projectDirectory)?.bytes
    byteReader.close()
    assert.ok(storedPayloadBytes)
    expect(storedPayloadBytes).toBeGreaterThan(64 * 1024 * 1024)

    const ledger = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory)
    let capture: ReturnType<typeof ledger.readDecision>
    try {
      capture = ledger.readDecision()
    } finally {
      ledger.close()
    }
    if (capture.status !== "captured") throw new Error("Large decision history was not captured")
    expect(capture.progressFacts).toHaveLength(15_007)
    expect(capture.progressFacts.some((fact) => JSON.stringify(fact).includes(ballast))).toBe(false)

    const currentIndex = makePriceIndex([{ route: routeA }, { route: routeB }])
    const valuation = projectTaskValuation({
      attempts: capture.tasks.flatMap((task) => task.attempts.map((attempt) => attempt.accounting)),
      progressFacts: capture.progressFacts,
      progressTruncated: false,
      truncatedContextSessionIDs: [],
      currentIndex,
    })
    const usageFor = (sessionID: string) => {
      const value = valuation.usage.sessions.find((session) => session.sessionID === sessionID)
      assert.ok(value, `Usage for ${sessionID} is retained`)
      return value
    }
    const failedUsage = usageFor(fixture.attempts.failed.session_id)
    expect(failedUsage).toMatchObject({
      selectedBasis: "retained-progress-cumulative-snapshot",
      categories: {
        uncachedInput: {
          value: 0,
          status: "observed",
          basis: "retained-progress-cumulative-snapshot",
          valueScope: "selected-cumulative-snapshot",
        },
        output: { value: 0, status: "observed" },
        reasoning: { value: null, status: "missing" },
        cacheRead: { value: 2, status: "observed" },
        cacheWrite: { value: 0, status: "observed" },
      },
    })
    const acceptedUsage = usageFor(fixture.attempts.accepted.session_id)
    expect(acceptedUsage).toMatchObject({
      selectedBasis: "retained-progress-additive-steps",
      additiveStepCount: 6_504,
      categories: {
        uncachedInput: {
          value: 7_551,
          status: "partial",
          valueScope: "retained-additive-subtotal",
        },
        output: { value: null, status: "missing" },
        reasoning: { value: null, status: "missing" },
        cacheRead: { value: null, status: "missing" },
        cacheWrite: { value: null, status: "missing" },
      },
    })
    const sharedUsage = usageFor("ses-shared-session")
    expect(sharedUsage.attemptIDs).toHaveLength(2)
    expect(sharedUsage.categories.uncachedInput.value).toBe(70)
    expect(valuation.usage.categories.uncachedInput.value).toBe(7_621)
    for (const sessionID of [
      fixture.attempts.failed.session_id,
      fixture.attempts.accepted.session_id,
    ]) {
      const market = valuation.marketEquivalentCost.sessions.find(
        (session) => session.sessionID === sessionID,
      )
      expect(market?.routeAllocation.status).not.toBe("single-observed-route")
      expect(market?.valueUSD).toBeNull()
    }
    const retryTask = capture.tasks.find((task) => task.taskID === fixture.tasks.retry!.id)
    expect(retryTask).toMatchObject({
      acceptance: { accepted: true, acceptedAt: 400 },
      attempts: [{ accounting: { state: "failed" } }, { accounting: { state: "accepted" } }],
    })

    const priceReads: CurrentPriceApplicability[][] = []
    let opens = 0
    const reader = createModelDecisionReader({
      projectDirectory: fixture.projectDirectory,
      openLedger() {
        opens++
        return openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory)
      },
      async readPriceState(routes) {
        priceReads.push([...routes])
        return { settings: priceSettings(), index: makePriceIndex(routes), freshness: "current" }
      },
    })
    try {
      const input = inputFor(fixture.projectDirectory)
      const observed = await observeDecisionProgressPages(() => reader.overview(input))
      expect(observed.pages.length).toBeGreaterThan(29)
      expect(observed.pages.every((size) => size > 0 && size <= 512)).toBe(true)
      expect(observed.value.configurationCount).toBe(0)
      expect(observed.value.graph.points).toEqual([])
      expect(observed.value.graph.frontierConfigurationIDs).toEqual([])
      const firstPriceRead = priceReads[0]!
      for (const route of [routeA, routeB])
        expect(
          firstPriceRead.find(
            (item) =>
              item.route.providerID === route.providerID && item.route.modelID === route.modelID,
          )?.usage,
        ).toBeUndefined()

      const rowPage = await reader.rows({ ...input, limit: 100 })
      expect(rowPage.context.snapshotID).toBe(observed.value.context.snapshotID)
      expect(rowPage.rows).toEqual([])
      expect(opens).toBeGreaterThan(0)

      insertRetainedFacts(fixture, fixture.attempts.accepted.id, [
        {
          at: 100_000,
          kind: "step",
          messageID: "late-complete-history-fact",
          payload: {
            measurementBasis: "additive-step-measurement",
            usage: { input: 10, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
            route: routeA,
            routeEvidence: observedRoute(routeA),
          },
        },
      ])
      const next = await reader.overview(input)
      expect(next.context.snapshotID).not.toBe(observed.value.context.snapshotID)
      expect(next.context.priceIndex.note).toContain("project observation revision")
      expect(next.graph.points).toEqual([])
      expect(next.graph.frontierConfigurationIDs).toEqual([])

      const updatedLedger = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory)
      try {
        const updated = updatedLedger.readDecision()
        if (updated.status !== "captured") throw new Error("Late progress fact was not captured")
        const updatedValuation = projectTaskValuation({
          attempts: updated.tasks.flatMap((task) =>
            task.attempts.map((attempt) => attempt.accounting),
          ),
          progressFacts: updated.progressFacts,
          progressTruncated: false,
          truncatedContextSessionIDs: [],
          currentIndex,
        })
        expect(
          updatedValuation.usage.sessions.find(
            (session) => session.sessionID === fixture.attempts.accepted.session_id,
          )?.categories.uncachedInput.value,
        ).toBe(7_561)
      } finally {
        updatedLedger.close()
      }
    } finally {
      reader.close()
    }
  } finally {
    fixture.close()
  }
}, 30_000)

test("unavailable and incomplete market totals stay unknown while a sourced complete zero remains rankable", async () => {
  const route = { providerID: "openrouter", modelID: "a-model", variant: "medium" }
  const routeID = `configuration:${modelConfigurationID(route.providerID, route.modelID, route.variant)}`

  const absentFixture = makeLedgerFixture()
  addAdoptedUsage(absentFixture, route)
  const absentReader = fixtureDecisionReader(absentFixture, (routes) =>
    makePriceIndex(routes, 1, []),
  )
  try {
    const input = inputFor(absentFixture.projectDirectory)
    const overview = await absentReader.overview(input)
    const rows = await absentReader.rows({ ...input, limit: 100 })
    const row = rows.rows.find((candidate) => candidate.configuration.configurationID === routeID)
    assert.ok(row)
    expect(row.cohort.acceptedTaskCount).toBeGreaterThan(0)
    expect(row.efficiency).toMatchObject({
      status: "partial",
      currentMarketUSDPerAcceptedTask: null,
      missing: ["current-price"],
    })
    expect(row.configuration.currentPrice).toMatchObject({
      source: null,
      semantics: "unknown",
      freshness: "unavailable",
    })
    expect(overview.graph.points.some((point) => point.configurationID === routeID)).toBe(false)
    expect(overview.graph.frontierConfigurationIDs).not.toContain(routeID)
    const configurations = await absentReader.configurations({ ...input, limit: 100 })
    expect(
      configurations.configurations.find(
        (configuration) => configuration.configurationID === routeID,
      )?.currentPrice.source,
    ).toBeNull()
    const inspected = await absentReader.inspect({
      ...input,
      snapshotID: overview.context.snapshotID,
      configurationID: routeID,
      selectedTaskID: null,
      contributorLimit: 100,
    })
    expect(inspected.status).toBe("found")
    if (inspected.status === "found")
      expect(inspected.efficiency.currentMarketUSDPerAcceptedTask).toBeNull()
  } finally {
    absentReader.close()
    absentFixture.close()
  }

  const partialFixture = makeLedgerFixture()
  addAdoptedUsage(partialFixture, route)
  rewriteAttemptUsage(partialFixture.path, partialFixture.attempts.adoption.id, 50, 10)
  const partialReader = fixtureDecisionReader(partialFixture, (routes) =>
    makePriceIndex(
      routes,
      1,
      routes.map(({ route: observed }) => pinWithMissingCompletionRate(observed, 1)),
    ),
  )
  try {
    const input = inputFor(partialFixture.projectDirectory)
    const routes = [{ route }]
    const index = makePriceIndex(
      routes,
      1,
      routes.map(({ route: observed }) => pinWithMissingCompletionRate(observed, 1)),
    )
    const sourceValuation = valueFixture(partialFixture, index)
    expect(
      sourceValuation.marketEquivalentCost.sessions.some(
        (session) =>
          session.status === "partial" &&
          session.routeAllocation.route?.modelID === route.modelID &&
          session.subtotalUSD !== null &&
          session.subtotalUSD > 0 &&
          session.valueUSD === null,
      ),
    ).toBe(true)

    const overview = await partialReader.overview(input)
    const rows = await partialReader.rows({ ...input, limit: 100 })
    const row = rows.rows.find((candidate) => candidate.configuration.configurationID === routeID)
    assert.ok(row)
    expect(row.cohort.acceptedTaskCount).toBeGreaterThan(0)
    expect(row.efficiency).toMatchObject({
      status: "partial",
      currentMarketUSDPerAcceptedTask: null,
      missing: ["current-price"],
    })
    expect(overview.graph.points.some((point) => point.configurationID === routeID)).toBe(false)
    expect(overview.graph.frontierConfigurationIDs).not.toContain(routeID)
    const inspected = await partialReader.inspect({
      ...input,
      snapshotID: overview.context.snapshotID,
      configurationID: routeID,
      selectedTaskID: null,
      contributorLimit: 100,
    })
    expect(inspected.status).toBe("found")
    if (inspected.status === "found")
      expect(inspected.efficiency.currentMarketUSDPerAcceptedTask).toBeNull()
  } finally {
    partialReader.close()
    partialFixture.close()
  }

  const zeroRoute = { providerID: "openai", modelID: "zero-model", variant: null }
  const zeroRouteID = `configuration:${modelConfigurationID(
    zeroRoute.providerID,
    zeroRoute.modelID,
    zeroRoute.variant,
  )}`
  const zeroFixture = makeLedgerFixture()
  rewriteAttemptFacts(
    zeroFixture.path,
    zeroFixture.projectID,
    zeroFixture.attempts.failed.id,
    zeroRoute,
  )
  rewriteAttemptFacts(
    zeroFixture.path,
    zeroFixture.projectID,
    zeroFixture.attempts.accepted.id,
    zeroRoute,
    [20, 30],
  )
  const zeroReader = cachedOpenRouterReader(zeroFixture)
  try {
    const input = inputFor(zeroFixture.projectDirectory)
    const overview = await zeroReader.reader.overview(input)
    const rows = await zeroReader.reader.rows({ ...input, limit: 100 })
    const row = rows.rows.find(
      (candidate) => candidate.configuration.configurationID === zeroRouteID,
    )
    assert.ok(row)
    expect(row.cohort.acceptedTaskCount).toBeGreaterThan(0)
    expect(row.efficiency).toMatchObject({
      status: "single-observation",
      currentMarketUSDPerAcceptedTask: 0,
    })
    expect(row.configuration.currentPrice).toMatchObject({
      source: "openrouter",
      sourceRecordID: "openai/zero-model",
    })
    expect(overview.graph.points).toContainEqual(
      expect.objectContaining({
        configurationID: zeroRouteID,
        currentMarketUSDPerAcceptedTask: 0,
      }),
    )
    expect(overview.graph.frontierConfigurationIDs).toContain(zeroRouteID)
  } finally {
    zeroReader.close()
    zeroFixture.close()
  }
})

test("current price applicability uses retained usage and leaves incomplete, mixed, or tier-ambiguous inputs unknown", async () => {
  const route = { providerID: "openai", modelID: "fixture-model", variant: "high" }
  const routeID = `configuration:${modelConfigurationID(route.providerID, route.modelID, route.variant)}`
  const completeFixture = makeLedgerFixture()
  rewriteAttemptFacts(
    completeFixture.path,
    completeFixture.projectID,
    completeFixture.attempts.failed.id,
    route,
  )
  rewriteAttemptFacts(
    completeFixture.path,
    completeFixture.projectID,
    completeFixture.attempts.accepted.id,
    route,
    [20, 30],
  )
  let collected: readonly CurrentPriceApplicability[] = []
  const completeIndex: { current: CurrentPriceIndex | null } = { current: null }
  const complete = cachedOpenRouterReader(completeFixture, {
    missingCacheWriteRate: true,
    onRoutes: (routes) => (collected = routes),
    onIndex: (index) => (completeIndex.current = index),
  })
  try {
    const input = inputFor(completeFixture.projectDirectory)
    const overview = await complete.reader.overview(input)
    const rows = await complete.reader.rows({ ...input, limit: 100 })
    const row = rows.rows.find((candidate) => candidate.configuration.configurationID === routeID)
    assert.ok(row)
    expect(row.configuration.currentPrice).toMatchObject({
      source: "openrouter",
      sourceRecordID: "openai/fixture-model",
    })
    expect(row.efficiency.currentMarketUSDPerAcceptedTask).toBeGreaterThan(0)
    expect(overview.context.priceIndex.pins).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "openrouter" })]),
    )
    assert.ok(completeIndex.current)
    expect(completeIndex.current.pins).toContainEqual(
      expect.objectContaining({
        route,
        rates: expect.objectContaining({
          unit: "USD per token",
          uncachedInput: "0.000002",
          completion: "0.000010",
          cacheRead: "0.0000005",
          cacheWrite: null,
        }),
        provenance: expect.objectContaining({
          source: "openrouter-models",
          recordID: "openai/fixture-model",
        }),
      }),
    )
    expect(
      collected.some((applicability) => {
        const cacheWrite = applicability.usage?.cacheWrite
        return (
          applicability.route.modelID === route.modelID &&
          cacheWrite?.value === 0 &&
          cacheWrite.status === "observed"
        )
      }),
    ).toBe(true)
  } finally {
    complete.close()
    completeFixture.close()
  }

  const incompleteFixture = makeLedgerFixture()
  rewriteAttemptFacts(
    incompleteFixture.path,
    incompleteFixture.projectID,
    incompleteFixture.attempts.failed.id,
    route,
  )
  rewriteAttemptFacts(
    incompleteFixture.path,
    incompleteFixture.projectID,
    incompleteFixture.attempts.accepted.id,
    route,
    [20, 30],
  )
  rewriteAttemptUsage(incompleteFixture.path, incompleteFixture.attempts.accepted.id, 50, 0, null)
  let incompleteInputs: readonly CurrentPriceApplicability[] = []
  const incomplete = cachedOpenRouterReader(incompleteFixture, {
    missingCacheWriteRate: true,
    onRoutes: (routes) => (incompleteInputs = routes),
  })
  try {
    const input = inputFor(incompleteFixture.projectDirectory)
    const overview = await incomplete.reader.overview(input)
    const row = (await incomplete.reader.rows({ ...input, limit: 100 })).rows.find(
      (candidate) => candidate.configuration.configurationID === routeID,
    )
    assert.ok(row)
    expect(row.configuration.currentPrice.source).toBeNull()
    expect(row.efficiency.currentMarketUSDPerAcceptedTask).toBeNull()
    expect(overview.graph.points.some((point) => point.configurationID === routeID)).toBe(false)
    expect(
      incompleteInputs.some((applicability) => {
        const cacheWrite = applicability.usage?.cacheWrite
        return (
          applicability.route.modelID === route.modelID &&
          cacheWrite !== undefined &&
          cacheWrite.status !== "observed"
        )
      }),
    ).toBe(true)
  } finally {
    incomplete.close()
    incompleteFixture.close()
  }

  const mixedFixture = makeLedgerFixture()
  const mixedRoute = { providerID: "openai", modelID: "different-model", variant: "high" }
  rewriteAttemptFacts(
    mixedFixture.path,
    mixedFixture.projectID,
    mixedFixture.attempts.sharedFeature.id,
    route,
  )
  rewriteAttemptFacts(
    mixedFixture.path,
    mixedFixture.projectID,
    mixedFixture.attempts.sharedTesting.id,
    mixedRoute,
  )
  let mixedInputs: readonly CurrentPriceApplicability[] = []
  const mixedIndex: { current: CurrentPriceIndex | null } = { current: null }
  const mixed = cachedOpenRouterReader(mixedFixture, {
    missingCacheWriteRate: true,
    onRoutes: (routes) => (mixedInputs = routes),
    onIndex: (index) => (mixedIndex.current = index),
  })
  try {
    await mixed.reader.overview(inputFor(mixedFixture.projectDirectory))
    expect(
      mixedInputs.some(
        (applicability) =>
          applicability.route.modelID === route.modelID && applicability.usage === undefined,
      ),
    ).toBe(true)
    assert.ok(mixedIndex.current)
    expect(mixedIndex.current.pins.some((pin) => pin.route?.modelID === route.modelID)).toBe(false)
  } finally {
    mixed.close()
    mixedFixture.close()
  }

  const tieredFixture = makeLedgerFixture()
  rewriteAttemptFacts(
    tieredFixture.path,
    tieredFixture.projectID,
    tieredFixture.attempts.failed.id,
    route,
  )
  rewriteAttemptFacts(
    tieredFixture.path,
    tieredFixture.projectID,
    tieredFixture.attempts.accepted.id,
    route,
    [20, 30],
  )
  let tieredInputs: readonly CurrentPriceApplicability[] = []
  const tieredIndex: { current: CurrentPriceIndex | null } = { current: null }
  const tiered = cachedOpenRouterReader(tieredFixture, {
    tieredPromptTiers: true,
    onRoutes: (routes) => (tieredInputs = routes),
    onIndex: (index) => (tieredIndex.current = index),
  })
  try {
    const overview = await tiered.reader.overview(inputFor(tieredFixture.projectDirectory))
    expect(
      tieredInputs.some((applicability) => {
        const input = applicability.usage?.uncachedInput
        return (
          applicability.route.modelID === route.modelID &&
          input?.status === "observed" &&
          input.value !== null &&
          applicability.openRouterMinPromptTokens === undefined
        )
      }),
    ).toBe(true)
    assert.ok(tieredIndex.current)
    expect(tieredIndex.current.pins.some((pin) => pin.route?.modelID === route.modelID)).toBe(false)
    expect(overview.context.priceIndex.note).toContain(
      "No configured ordered source supplied an exact applicable quote",
    )
  } finally {
    tiered.close()
    tieredFixture.close()
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

test("first-page pins reject expired or mismatched contexts while retaining legacy and cursor reads", async () => {
  const fixture = makeLedgerFixture()
  addAdoptedUsage(fixture, { providerID: "openrouter", modelID: "adopted-model", variant: null })
  const reader = fixtureDecisionReader(fixture, (routes) => makePriceIndex(routes))
  try {
    const input = inputFor(fixture.projectDirectory)
    const overviewA = await reader.overview(input)
    const first = await reader.rows({
      ...input,
      snapshotID: overviewA.context.snapshotID,
      limit: 1,
    })
    expect(first.context.snapshotID).toBe(overviewA.context.snapshotID)
    expect(first.nextCursor).toBeTruthy()

    const legacy = await reader.rows({ ...input, limit: 1 })
    expect(legacy.context.snapshotID).toBe(overviewA.context.snapshotID)

    await expect(
      reader.rows({
        ...input,
        snapshotID: overviewA.context.snapshotID,
        filters: { ...input.filters, persona: "ui" },
        limit: 1,
      }),
    ).rejects.toThrow("scope or filters do not match")
    await expect(
      reader.configurations({ ...input, snapshotID: "models-decision-v2:expired", limit: 1 }),
    ).rejects.toThrow("unavailable or expired")

    rewriteAttemptUsage(fixture.path, fixture.attempts.failed.id, 901)
    const overviewB = await reader.overview(input)
    expect(overviewB.context.snapshotID).not.toBe(overviewA.context.snapshotID)
    await expect(
      reader.rows({
        ...input,
        snapshotID: overviewB.context.snapshotID,
        cursor: first.nextCursor!,
        limit: 1,
      }),
    ).rejects.toThrow("cursor and snapshot pin do not match")

    const continued = await reader.rows({ ...input, cursor: first.nextCursor!, limit: 1 })
    expect(continued.context.snapshotID).toBe(overviewA.context.snapshotID)
  } finally {
    reader.close()
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

test("endpoint scenarios reuse one coherent capture, pin pages, and reprice without changing v2 valuation", async () => {
  const fixture = makeLedgerFixture()
  const route = { providerID: "openai", modelID: "gpt-6-luna", variant: "max" }
  rewriteAttemptFacts(fixture.path, fixture.projectID, fixture.attempts.failed.id, route)
  rewriteAttemptUsage(fixture.path, fixture.attempts.failed.id, 100, 1, 2)
  rewriteAttemptFacts(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    route,
    [20, 30],
  )

  const endpointStore = new ModelEvidenceStore(fixture.path, fixture.projectDirectory)
  saveIdentityCatalogSnapshots(endpointStore, fixture.projectDirectory)
  saveLunaEndpointSnapshot(endpointStore, fixture.projectDirectory, "0.0000001", "0.0000002")
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
    async readPriceState(routes, signal) {
      signal?.throwIfAborted()
      return {
        settings: priceSettings(),
        index: makePriceIndex(routes),
        endpointPricing: readEndpointPricingEvidence(
          fixture.path,
          fixture.projectDirectory,
          signal,
        ),
        ...readIdentitySources(fixture.path, fixture.projectDirectory),
        freshness: "current",
      }
    },
  })
  try {
    const input = inputFor(fixture.projectDirectory)
    const firstOverview = await reader.overview(input)
    const routeConfigurationID = `configuration:${modelConfigurationID(
      route.providerID,
      route.modelID,
      route.variant,
    )}`
    const firstInspection = await reader.inspect({
      ...input,
      snapshotID: firstOverview.context.snapshotID,
      configurationID: routeConfigurationID,
      selectedTaskID: fixture.tasks.retry!.id,
      contributorLimit: 1,
    })
    expect(firstInspection.status).toBe("found")
    if (firstInspection.status !== "found") return
    const firstRow = (await reader.rows({ ...input, limit: 100 })).rows.find(
      (row) => row.configuration.configurationID === routeConfigurationID,
    )
    assert.ok(firstRow)
    const firstMarket = firstInspection.knownUsageMarket
    expect(firstMarket).toMatchObject({
      schemaVersion: 1,
      status: "range",
      scenarios: [
        {
          status: "range",
          freshness: "current",
          tierAttribution: { status: "unresolved", basis: "aggregate-tier-envelope" },
          coverage: {
            scope: "known-route-matched-retained-usage",
            wholeTaskBound: false,
            categories: { uncachedInput: { tokens: 150, status: "observed" } },
            retries: { status: "complete", failedAttemptCount: 1 },
          },
        },
      ],
    })
    expect(firstMarket?.scenarios[0]?.rangeUSD?.minimum).toBeCloseTo(0.00001575, 12)
    expect(firstMarket?.scenarios[0]?.rangeUSD?.maximum).toBeCloseTo(0.00003125, 12)
    expect(firstInspection.contributorPage.nextCursor).not.toBeNull()
    expect(firstMarket?.scenarios[0]?.provenance.snapshotGeneration).toBe(1)
    expect(firstRow.efficiency.tokensPerAcceptedTask).toBe(153)
    expect(captures).toBe(1)

    saveLunaEndpointSnapshot(endpointStore, fixture.projectDirectory, "0.0000002", "0.0000004")
    const pinnedInspection = await reader.inspect({
      ...input,
      snapshotID: firstOverview.context.snapshotID,
      configurationID: routeConfigurationID,
      selectedTaskID: fixture.tasks.retry!.id,
      contributorLimit: 1,
      contributorCursor: firstInspection.contributorPage.nextCursor!,
    })
    expect(pinnedInspection).toMatchObject({
      status: "found",
      knownUsageMarket: {
        scenarios: [
          {
            provenance: { snapshotGeneration: 1 },
          },
        ],
      },
    })
    if (pinnedInspection.status === "found") {
      expect(pinnedInspection.knownUsageMarket?.scenarios[0]?.rangeUSD?.minimum).toBeCloseTo(
        0.00001575,
        12,
      )
      expect(pinnedInspection.knownUsageMarket?.scenarios[0]?.rangeUSD?.maximum).toBeCloseTo(
        0.00003125,
        12,
      )
    }
    expect(captures).toBe(1)

    const refreshedOverview = await reader.overview(input)
    const refreshedInspection = await reader.inspect({
      ...input,
      snapshotID: refreshedOverview.context.snapshotID,
      configurationID: routeConfigurationID,
      selectedTaskID: fixture.tasks.retry!.id,
      contributorLimit: 1,
    })
    const refreshedRow = (await reader.rows({ ...input, limit: 100 })).rows.find(
      (row) => row.configuration.configurationID === routeConfigurationID,
    )
    assert.ok(refreshedRow)
    expect(refreshedInspection).toMatchObject({
      status: "found",
      knownUsageMarket: {
        scenarios: [
          {
            provenance: { snapshotGeneration: 2 },
          },
        ],
      },
    })
    if (refreshedInspection.status === "found") {
      expect(refreshedInspection.knownUsageMarket?.scenarios[0]?.rangeUSD?.minimum).toBeCloseTo(
        0.00003075,
        12,
      )
      expect(refreshedInspection.knownUsageMarket?.scenarios[0]?.rangeUSD?.maximum).toBeCloseTo(
        0.00006125,
        12,
      )
    }
    expect(refreshedRow.efficiency).toEqual(firstRow.efficiency)
    expect(refreshedRow.nativeReportedCost).toEqual(firstRow.nativeReportedCost)
    expect(refreshedInspection.status).toBe("found")
    if (refreshedInspection.status !== "found") return
    expect(refreshedInspection.estimate).toEqual(firstInspection.estimate)
    expect(refreshedInspection.contributorPage.contributors).toEqual(
      firstInspection.contributorPage.contributors,
    )
    expect(captures).toBe(2)
  } finally {
    reader.close()
    endpointStore.close()
    fixture.close()
  }
})

test("decision traversal cancellation and injected page failure publish no partial snapshot and close readers", async () => {
  const fixture = makeLedgerFixture()
  const route = { providerID: "openrouter", modelID: "page-failure-model", variant: "medium" }
  insertRetainedFacts(
    fixture,
    fixture.attempts.failed.id,
    (function* () {
      for (let index = 0; index < 1_100; index++)
        yield {
          at: 5_000 + index,
          kind: "step" as const,
          messageID: `page-failure-message-${index}`,
          payload: {
            measurementBasis: "additive-step-measurement",
            usage: { input: 1 },
            route,
            routeEvidence: observedRoute(route),
          },
        }
    })(),
  )
  let opened = 0
  let closed = 0
  let priceReads = 0
  const makeReader = () =>
    createModelDecisionReader({
      projectDirectory: fixture.projectDirectory,
      openLedger() {
        opened++
        const ledger = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory)
        return {
          decisionRevision: () => ledger.decisionRevision(),
          readDecision: (signal) => ledger.readDecision(signal),
          close() {
            closed++
            ledger.close()
          },
        }
      },
      async readPriceState(routes) {
        priceReads++
        return { settings: priceSettings(), index: makePriceIndex(routes), freshness: "current" }
      },
    })
  const input = inputFor(fixture.projectDirectory)
  try {
    const controller = new AbortController()
    const cancelledReader = makeReader()
    let cancelledPageCount = 0
    try {
      await expect(
        observeDecisionProgressPages(
          () => cancelledReader.overview(input, { signal: controller.signal }),
          {
            afterPage(page) {
              cancelledPageCount = page
              if (page === 2) controller.abort()
            },
          },
        ),
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(cancelledPageCount).toBe(2)
      expect(opened).toBe(1)
      expect(closed).toBe(1)
      expect(priceReads).toBe(0)
      const recovered = await cancelledReader.overview(input)
      expect(recovered.context.priceIndex.note).toContain("project observation revision")
      expect(opened).toBe(2)
      expect(closed).toBe(2)
      expect(priceReads).toBe(1)
    } finally {
      cancelledReader.close()
    }

    const failedReader = makeReader()
    try {
      await expect(
        observeDecisionProgressPages(() => failedReader.overview(input), { fail: true }),
      ).rejects.toThrow("injected decision progress read failure")
      expect(opened).toBe(3)
      expect(closed).toBe(3)
      expect(priceReads).toBe(1)
    } finally {
      failedReader.close()
    }
  } finally {
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
