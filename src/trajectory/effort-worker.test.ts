import { expect, test } from "bun:test"
import { Effect } from "effect"
import captured from "../../test/models-identity/fixtures/captured-20261103.json" with { type: "json" }
import {
  cursorSecret,
  makeFixture,
  secondAttemptID,
  taskID,
} from "../../test/trajectory/fixture.ts"
import { prepareLz137RetainedData } from "../../test/trajectory-panel/lz137-market-fixture.ts"
import { writeHostSession } from "../host-sessions/state.ts"
import { defaultModelPriceSourcePolicy } from "../models/price-source-settings.ts"
import { ModelEvidenceSnapshotSchema } from "../models/source-schema.ts"
import { ModelEvidenceStore } from "../models/source-store.ts"
import { createModelsTaskValuationProvider } from "../models/server.ts"
import { computeTaskEffort, effortSummary, storedPriceProvider } from "./effort-compute.ts"
import { ensureTaskEffortSchema, readTaskEffort, TaskEffortFold } from "./effort-store.ts"
import { workerTaskEffort } from "./effort-worker-client.ts"
import { inspectTrajectory } from "./read.ts"

type Fixture = ReturnType<typeof makeFixture>

const inputs = { policy: defaultModelPriceSourcePolicy(), openrouter: "configured" as const }

/** The captured native and OpenRouter catalogs, stored as a price refresh stores them. */
function writeCapturedEvidence(fixture: Fixture) {
  const store = new ModelEvidenceStore(fixture.repository.path, fixture.directory)
  try {
    for (let index = 0; index < 5; index += 1) store.beginRefresh()
    for (const raw of [captured.native.snapshot, captured.openrouter.snapshot])
      store.saveSnapshot({
        ...ModelEvidenceSnapshotSchema.parse(raw),
        projectDirectory: fixture.directory,
        generation: 5,
      })
  } finally {
    store.close()
  }
}

/** The Models provider the core builds, over a host whose settings are the defaults. */
function modelsProvider(fixture: Fixture) {
  const context = {
    storage: {
      get: () => Effect.succeed(undefined),
      set: () => Effect.void,
    },
    integration: {
      connection: { active: () => Effect.succeed({ status: { status: "connected" } }) },
    },
  }
  return createModelsTaskValuationProvider(context as never, fixture.repository)
}

function prepare(fixture: Fixture) {
  prepareLz137RetainedData(fixture)
  writeCapturedEvidence(fixture)
  ensureTaskEffortSchema(fixture.repository)
  fixture.repository.atomic((db) => {
    for (const session of fixture.sessions.values())
      writeHostSession(db, fixture.directory, "project", session.id, {
        id: session.id,
        projectID: "project",
        parentID: session.parentID,
        agent: "lazers-implementor",
        title: null,
        directory: null,
        archived: false,
        busy: session.busy,
        outcome: session.outcome,
        model: session.model ? { ...session.model, variant: session.model.variant ?? null } : null,
        tokensIn: session.tokens?.input ?? null,
        tokensOut: session.tokens?.output ?? null,
        tokensReasoning: session.tokens?.reasoning ?? null,
        tokensCacheRead: session.tokens?.cache.read ?? null,
        tokensCacheWrite: session.tokens?.cache.write ?? null,
        createdAt: session.time.created,
        updatedAt: session.time.updated,
      })
  })
}

test("the effort worker computes the report's effort with the Models provider, field for field", async () => {
  const fixture = makeFixture()
  const worker = workerTaskEffort({
    path: fixture.repository.path,
    projectDirectory: fixture.directory,
    projectID: "project",
    readPriceInputs: async () => inputs,
  })
  try {
    prepare(fixture)
    const report = await inspectTrajectory(
      fixture.store,
      {
        session: async () => null,
        status: async (id) => {
          const session = fixture.sessions.get(id)
          return session ? { ...session, messages: null, messageStatus: "not-read" as const } : null
        },
      },
      "project",
      { taskID, limit: 50 },
      cursorSecret,
      { allEvents: true, includeMessages: false, taskValuationProvider: modelsProvider(fixture) },
    )
    // The captured sources price the route: the comparison covers a real valuation.
    expect(report.effort.marketEquivalentCost?.observedUsageEstimate?.valueUSD).toBeGreaterThan(0)
    const row = await worker.compute(taskID, new AbortController().signal)
    // The index read time is per read on both paths; every other byte is the same.
    const readTime = (text: string) =>
      text.replace(/("indexID":"[^"]*","retrievedAt":)"[^"]*"/, '$1"<read time>"')
    // The row stores the summary; the worker's detail is the whole effort.
    expect(readTime(row!.effort)).toBe(readTime(JSON.stringify(effortSummary(report.effort))))
    const whole = await worker.detail(taskID, new AbortController().signal)
    expect(readTime(JSON.stringify(whole))).toBe(readTime(JSON.stringify(report.effort)))
    // The split provider equals the Models provider on this thread too.
    const inThread = await computeTaskEffort(
      fixture.repository.path,
      fixture.directory,
      "project",
      taskID,
      storedPriceProvider(fixture.repository.path, fixture.directory, inputs),
      new AbortController().signal,
    )
    expect(readTime(inThread!.effort)).toBe(readTime(row!.effort))
    expect(inThread!.effort_key).toBe(row!.effort_key)
  } finally {
    worker.release()
    fixture.close()
  }
})

test("main-thread cost of a refresh through the worker: claim and write only", async () => {
  const fixture = makeFixture()
  const worker = workerTaskEffort({
    path: fixture.repository.path,
    projectDirectory: fixture.directory,
    projectID: "project",
    readPriceInputs: async () => inputs,
  })
  try {
    prepare(fixture)
    fixture.store.atomic((db) => {
      const insert = db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
          source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      const route = { providerID: "openai", modelID: "gpt-6-luna", variant: "max" }
      for (let index = 0; index < 3_619 - 21; index++) {
        const messageID = `cost-call-${index}`
        insert.run(
          fixture.directory,
          "project",
          fixture.receipt.planID,
          taskID,
          secondAttemptID,
          "ses-accepted",
          10_000 + index,
          10_100 + index,
          "native-event",
          JSON.stringify(["native-event"]),
          index % 4 === 0 ? "commentary" : "step",
          JSON.stringify([`cost-${index}`]),
          messageID,
          messageID,
          `cost-${index}`,
          JSON.stringify(
            index % 4 === 0
              ? { text: "Reading the store before changing it." }
              : {
                  measurementBasis: "additive-step-measurement",
                  usage: {
                    input: 2_900,
                    cacheRead: 43_000,
                    cacheWrite: 0,
                    output: 100,
                    reasoning: 90,
                  },
                  route,
                  routeEvidence: { status: "observed", route },
                },
          ),
        )
      }
    })
    const fold = new TaskEffortFold(fixture.repository, worker.compute, { spacingMs: 0 })
    fold.start()
    try {
      fold.touch(taskID)
      await fold.settle()
      const longest: number[] = []
      const total: number[] = []
      for (let run = 0; run < 3; run++) {
        // A changed row, so each refresh writes.
        fixture.repository.atomic((db) =>
          db
            .query("UPDATE runner_attempts SET tool_count=? WHERE id=?")
            .run(10 + run, secondAttemptID),
        )
        fold.counts.longestMainMs = 0
        const started = performance.now()
        await fold.settle()
        total.push(performance.now() - started)
        longest.push(fold.counts.longestMainMs)
      }
      longest.sort((left, right) => left - right)
      total.sort((left, right) => left - right)
      console.info(
        `effort refresh of 3,619 progress rows via the worker: longest main-thread step median ` +
          `${longest[1]!.toFixed(2)} ms (max ${longest[2]!.toFixed(2)} ms); wall ${total[1]!.toFixed(1)} ms`,
      )
      const bytes = fixture.repository.read(
        (db) =>
          db
            .query<{ n: number }, []>("SELECT length(effort) AS n FROM trajectory_task_effort")
            .get()!.n,
      )
      console.info(`stored effort row: ${bytes} bytes`)
      expect(fold.counts.written).toBe(4)
      expect(
        fixture.repository.read((db) => readTaskEffort(db, fixture.directory, taskID)),
      ).toBeDefined()
    } finally {
      fold.close()
    }
  } finally {
    worker.release()
    fixture.close()
  }
})
