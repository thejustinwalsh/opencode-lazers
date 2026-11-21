import { expect, test } from "bun:test"
import {
  cursorSecret,
  firstAttemptID,
  makeFixture,
  secondAttemptID,
  taskID,
} from "../../test/trajectory/fixture.ts"
import {
  lz137ValuationProvider,
  prepareLz137RetainedData,
} from "../../test/trajectory-panel/lz137-market-fixture.ts"
import { nativeMillionTokenIndex } from "../../test/models-valuation/fixtures/current-indexes.ts"
import { storeSessions } from "../../test/trajectory/stored-sessions.ts"
import { createTaskValuationReader, type TaskValuationProvider } from "../models/task-valuation.ts"
import type { CurrentPriceIndex } from "../models/valuation-schema.ts"
import { startProjection } from "../projections/owner.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import {
  readTaskEffort,
  TASK_EFFORT_QUEUE,
  TaskEffortFold,
  taskEffortSeedProjection,
} from "./effort-store.ts"
import { computeTaskEffort, effortSummary } from "./effort-compute.ts"
import type { TrajectoryHost } from "./native.ts"
import { inspectTrajectory } from "./read.ts"

type Fixture = ReturnType<typeof makeFixture>

const pricingRoute = { providerID: "openai", modelID: "gpt-6-luna", variant: "max" }

/** One priced pin for the fixture's route; generation 2 doubles every rate. */
function pricedIndex(generation: number): CurrentPriceIndex {
  const base: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  const pin = base.pins[0]!
  pin.route = pricingRoute
  pin.productID = pricingRoute.modelID
  pin.configurationID = "gpt-6-luna-default"
  pin.provenance = {
    ...pin.provenance,
    snapshotID: `30000000-0000-4000-8000-00000000000${generation}`,
    generation,
    retrievedAt: `2026-11-0${generation + 2}T12:00:00.000Z`,
  }
  if (generation > 1)
    for (const key of ["uncachedInput", "completion", "cacheRead", "cacheWrite"] as const)
      pin.rates[key] = String(Number(pin.rates[key]) * 2)
  return { ...base, indexID: `test-index-${generation}`, retrievedAt: "2026-11-06T12:00:00.000Z" }
}

function pricedProvider(generation: () => number): TaskValuationProvider {
  return createTaskValuationReader(async (_routes, signal) => {
    signal.throwIfAborted()
    return { index: pricedIndex(generation()), freshness: "current" }
  })
}

/** The status read the panel made (host `status`, no transcript), with the valuation run. */
function statusHost(fixture: Fixture, missing: readonly string[] = []): TrajectoryHost {
  return {
    session: async () => {
      throw new Error("The status read never loads a transcript")
    },
    status: async (id) => {
      const session = missing.includes(id) ? undefined : fixture.sessions.get(id)
      return session ? { ...session, messages: null, messageStatus: "not-read" as const } : null
    },
  }
}

/** The fold's computation on this thread, valued by `provider`. */
const inThread =
  (fixture: Fixture, provider: TaskValuationProvider) => (task: string, signal: AbortSignal) =>
    computeTaskEffort(fixture.repository.path, fixture.directory, "project", task, provider, signal)

async function oracle(
  fixture: Fixture,
  provider: TaskValuationProvider,
  missing: readonly string[] = [],
) {
  return inspectTrajectory(
    fixture.store,
    statusHost(fixture, missing),
    "project",
    { taskID, limit: 50 },
    cursorSecret,
    { allEvents: true, includeMessages: false, taskValuationProvider: provider },
  )
}

async function storedEffort(fixture: Fixture, provider: TaskValuationProvider) {
  const fold = new TaskEffortFold(fixture.repository, inThread(fixture, provider), { spacingMs: 0 })
  fold.start()
  try {
    fold.touch(taskID)
    await fold.settle()
    return {
      fold,
      stored: fixture.repository.read((db) => readTaskEffort(db, fixture.directory, taskID)),
    }
  } finally {
    fold.close()
  }
}

/**
 * Every field, exactly: the stored JSON is the summary of the report's effort serialized. With no
 * transcript folded, a session's context is `not-read`, as in the status report.
 */
function expectSameEffort(stored: unknown, report: Awaited<ReturnType<typeof oracle>>) {
  expect(JSON.stringify(stored)).toBe(JSON.stringify(effortSummary(report.effort)))
}

test("stored effort equals the report's effort basis and market valuation on every field", async () => {
  const scenarios: Array<{
    name: string
    prepare(fixture: Fixture): void
    provider(): TaskValuationProvider
    missing?: string[]
  }> = [
    {
      name: "native snapshots, priced",
      prepare: (fixture) => {
        for (const session of fixture.sessions.values())
          session.model = { providerID: "openai", id: "gpt-6-luna", variant: "max" }
      },
      provider: () => pricedProvider(() => 1),
    },
    {
      name: "LZ-137 retained steps and recovery gaps, sourced estimate",
      prepare: prepareLz137RetainedData,
      provider: () => lz137ValuationProvider({ withStrictOpenCodePrice: true }),
    },
    {
      name: "a missing session falls back to retained progress",
      prepare: prepareLz137RetainedData,
      provider: () => lz137ValuationProvider({ withStrictOpenCodePrice: true }),
      missing: ["ses-failed"],
    },
    {
      name: "mixed observed routes, unpriced",
      prepare: (fixture) => {
        const recorder = new ProgressRecorder(fixture.store, "project")
        recorder.recordNativeEvent({
          id: "evt-mixed-route",
          type: "session.step.started",
          created: 1_300,
          data: {
            sessionID: "ses-failed",
            assistantMessageID: "msg-mixed",
            agent: "lazers-implementor",
            model: { providerID: "openai", id: "gpt-6.1-sol", variant: "high" },
          },
        })
      },
      provider: () => pricedProvider(() => 1),
    },
  ]
  for (const scenario of scenarios) {
    const fixture = makeFixture()
    try {
      scenario.prepare(fixture)
      const provider = scenario.provider()
      const missing = scenario.missing ?? []
      storeSessions(
        fixture,
        [...fixture.sessions.keys()].filter((id) => !missing.includes(id)),
      )
      const report = await oracle(fixture, provider, missing)
      const { stored } = await storedEffort(fixture, provider)
      expect(stored, scenario.name).toBeDefined()
      expectSameEffort(stored!.effort, report)
      expect(stored!.effort.marketEquivalentCost, scenario.name).toBeDefined()
    } finally {
      fixture.close()
    }
  }
})

test("a price change reprices the stored effort; usage is unchanged", async () => {
  const fixture = makeFixture()
  let generation = 1
  const provider = pricedProvider(() => generation)
  try {
    for (const session of fixture.sessions.values())
      session.model = { providerID: "openai", id: "gpt-6-luna", variant: "max" }
    storeSessions(fixture)
    const fold = new TaskEffortFold(fixture.repository, inThread(fixture, provider), {
      spacingMs: 0,
    })
    fold.start()
    try {
      fold.touch(taskID)
      await fold.settle()
      const first = fixture.repository.read((db) => readTaskEffort(db, fixture.directory, taskID))!
      expect(first.effort.marketEquivalentCost?.valueUSD).toBeGreaterThan(0)

      generation = 2
      await fold.reprice()
      await fold.settle()
      const second = fixture.repository.read((db) => readTaskEffort(db, fixture.directory, taskID))!
      expectSameEffort(second.effort, await oracle(fixture, provider))
      expect(second.effort.tokenUsage).toEqual(first.effort.tokenUsage)
      expect(second.effort.taskEffortBasis).toEqual(first.effort.taskEffortBasis)
      expect(second.effort.marketEquivalentCost?.currentIndex?.indexID).toBe("test-index-2")
      expect(second.effort.marketEquivalentCost!.valueUSD).toBe(
        first.effort.marketEquivalentCost!.valueUSD! * 2,
      )
      const row = fixture.repository.read((db) =>
        db
          .query<{ market_value: string; price_index: string }, []>(
            "SELECT market_value,price_index FROM trajectory_task_effort",
          )
          .get(),
      )!
      expect(row).toEqual({
        market_value: String(second.effort.marketEquivalentCost!.valueUSD),
        price_index: "test-index-2",
      })

      // Nothing changed: recomputing writes nothing.
      const written = fold.counts.written
      await fold.reprice()
      await fold.settle()
      expect(fold.counts.written).toBe(written)
    } finally {
      fold.close()
    }
  } finally {
    fixture.close()
  }
})

test("a price write re-queues every stored task", async () => {
  const fixture = makeFixture()
  try {
    storeSessions(fixture)
    const fold = new TaskEffortFold(
      fixture.repository,
      inThread(
        fixture,
        pricedProvider(() => 1),
      ),
      {
        spacingMs: 0,
      },
    )
    fold.start()
    try {
      fold.touch(taskID)
      await fold.settle()
      const reprices = fold.counts.reprices
      fixture.repository.atomic((db) => {
        db.exec("CREATE TABLE IF NOT EXISTS model_evidence_refreshes (id INTEGER PRIMARY KEY)")
        db.exec("INSERT INTO model_evidence_refreshes DEFAULT VALUES")
      })
      await Bun.sleep(10)
      expect(fold.counts.reprices).toBe(reprices + 1)
      await fold.settle()
      expect(
        fixture.repository.read((db) =>
          db.query(`SELECT COUNT(*) AS n FROM ${TASK_EFFORT_QUEUE}`).get(),
        ),
      ).toEqual({ n: 0 })
    } finally {
      fold.close()
    }
  } finally {
    fixture.close()
  }
})

test("no source prices it: the market value is NULL, never a zero or unknown", async () => {
  const fixture = makeFixture()
  const unpriced = createTaskValuationReader(async () => {
    throw new Error("No configured price source is readable")
  })
  try {
    storeSessions(fixture)
    const report = await oracle(fixture, unpriced)
    const { stored } = await storedEffort(fixture, unpriced)
    expectSameEffort(stored!.effort, report)
    expect(stored!.effort.marketEquivalentCost?.valueUSD).toBeNull()
    const row = fixture.repository.read((db) =>
      db
        .query<{ market_value: string | null; market_status: string }, []>(
          "SELECT market_value,market_status FROM trajectory_task_effort",
        )
        .get(),
    )!
    expect(row.market_value).toBeNull()
    expect(row.market_status).toBe(stored!.effort.marketEquivalentCost!.status)
    expect(row.market_status).not.toBe("unknown")
  } finally {
    fixture.close()
  }
})

test("a write during the computation is computed again; a failure parks and recovers", async () => {
  const fixture = makeFixture()
  let release: (() => void) | undefined
  const fail = false
  const inner = pricedProvider(() => 1)
  const provider: TaskValuationProvider = async (input, signal) => {
    if (fail) throw new Error("provider broke")
    if (release === undefined) await new Promise<void>((resolve) => (release = resolve))
    return inner(input, signal)
  }
  try {
    for (const session of fixture.sessions.values())
      session.model = { providerID: "openai", id: "gpt-6-luna", variant: "max" }
    storeSessions(fixture)
    const fold = new TaskEffortFold(fixture.repository, inThread(fixture, provider), {
      spacingMs: 0,
    })
    fold.start()
    try {
      fold.touch(taskID)
      const settled = fold.settle()
      while (!release) await Bun.sleep(1)
      // The session's tokens move while the first computation waits on the provider.
      fixture.sessions.get("ses-accepted")!.tokens = {
        input: 40,
        output: 8,
        reasoning: 6,
        cache: { read: 14, write: 2 },
      }
      fixture.sessions.get("ses-accepted")!.time.updated = 2200
      storeSessions(fixture, ["ses-accepted"])
      release()
      await settled
      await fold.settle()
      const stored = fixture.repository.read((db) => readTaskEffort(db, fixture.directory, taskID))!
      expectSameEffort(stored.effort, await oracle(fixture, inner))
      expect(fold.counts.refreshes).toBe(2)

      // The provider's own failure is its unavailable valuation; a database failure parks.
      fixture.repository.atomic((db) =>
        db.exec("ALTER TABLE host_session_state RENAME TO host_session_state_away"),
      )
      fold.touch(taskID)
      await fold.drain()
      const parked = fixture.repository.read((db) =>
        db
          .query<{ attempts: number; error: string | null; next_at: number }, []>(
            `SELECT attempts,error,next_at FROM ${TASK_EFFORT_QUEUE}`,
          )
          .get(),
      )!
      expect(parked.attempts).toBe(1)
      expect(parked.error).toBeTruthy()
      expect(parked.next_at).toBeGreaterThan(Date.now() - 1000)
      expect(fold.idle()).toBe(false)
      fixture.repository.atomic((db) =>
        db.exec("ALTER TABLE host_session_state_away RENAME TO host_session_state"),
      )
      fixture.repository.atomic((db) => db.query(`UPDATE ${TASK_EFFORT_QUEUE} SET next_at=0`).run())
      await fold.settle()
      expect(
        fixture.repository.read((db) =>
          db.query(`SELECT COUNT(*) AS n FROM ${TASK_EFFORT_QUEUE}`).get(),
        ),
      ).toEqual({ n: 0 })
    } finally {
      fold.close()
    }
  } finally {
    fixture.close()
  }
})

test("triggers queue a task's inputs and never a plan-level transition", async () => {
  const fixture = makeFixture()
  try {
    const fold = new TaskEffortFold(
      fixture.repository,
      inThread(
        fixture,
        pricedProvider(() => 1),
      ),
      {
        spacingMs: 0,
      },
    )
    fold.start()
    fold.close()
    const queued = () =>
      fixture.repository.read((db) =>
        db
          .query<{ ref: string }, []>(`SELECT ref FROM ${TASK_EFFORT_QUEUE} ORDER BY ref`)
          .all()
          .map((row) => row.ref.split("\u0000")[1]),
      )
    const clear = () =>
      fixture.repository.atomic((db) => db.exec(`DELETE FROM ${TASK_EFFORT_QUEUE}`))
    clear()
    fixture.repository.atomic((db) => {
      const insert = db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,1,'OUTCOME_OWNER_TRANSFER_UNCERTAIN','{}',?)",
      )
      for (let index = 0; index < 10_000; index++) insert.run(fixture.receipt.planID, index)
    })
    expect(queued()).toEqual([])
    fixture.repository.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,3,'RETRY_REQUESTED','{}',5)",
        )
        .run(fixture.receipt.planID, taskID),
    )
    expect(queued()).toEqual([])
    fixture.repository.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,4,'ACCEPT','{}',6)",
        )
        .run(fixture.receipt.planID, taskID),
    )
    expect(queued()).toEqual([taskID])
    clear()
    fixture.repository.atomic((db) =>
      db.query("UPDATE runner_attempts SET tool_count=9 WHERE id=?").run(firstAttemptID),
    )
    expect(queued()).toEqual([taskID])
    clear()
    storeSessions(fixture, ["ses-failed"])
    expect(queued()).toEqual([taskID])
    clear()
    new ProgressRecorder(fixture.store, "project").recordNativeEvent({
      id: "evt-step",
      type: "session.step.started",
      created: 1_300,
      data: {
        sessionID: "ses-accepted",
        assistantMessageID: "msg-step",
        agent: "lazers-implementor",
        model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
      },
    })
    expect(queued()).toEqual([taskID])
    clear()
    // An update that changes no read column (the integer keys) queues nothing.
    fixture.repository.atomic((db) =>
      db.query("UPDATE runner_attempts SET workspace=workspace WHERE id=?").run(secondAttemptID),
    )
    expect(queued()).toEqual([])
  } finally {
    fixture.close()
  }
})

test("a deleted task's row is deleted", async () => {
  const fixture = makeFixture()
  try {
    storeSessions(fixture)
    const fold = new TaskEffortFold(
      fixture.repository,
      inThread(
        fixture,
        pricedProvider(() => 1),
      ),
      {
        spacingMs: 0,
      },
    )
    fold.start()
    try {
      fold.touch(taskID)
      await fold.settle()
      expect(
        fixture.repository.read((db) => readTaskEffort(db, fixture.directory, taskID)),
      ).toBeDefined()
      fixture.repository.atomic((db) => {
        db.query("DELETE FROM runner_effects WHERE task_id=? OR attempt_id IS NOT NULL").run(taskID)
        db.query("DELETE FROM runner_attempts WHERE task_id=?").run(taskID)
        db.query("DELETE FROM runner_nodes WHERE task_id=?").run(taskID)
        for (const table of ["submission_requests", "task_references", "task_dispositions"])
          db.query(`DELETE FROM ${table} WHERE task_id=?`).run(taskID)
        db.query("DELETE FROM tasks WHERE id=?").run(taskID)
      })
      await fold.settle()
      expect(
        fixture.repository.read((db) => readTaskEffort(db, fixture.directory, taskID)),
      ).toBeUndefined()
    } finally {
      fold.close()
    }
  } finally {
    fixture.close()
  }
})

test("refresh cost: a task with 3,619 progress rows (the largest live attempt)", async () => {
  const fixture = makeFixture()
  try {
    prepareLz137RetainedData(fixture)
    storeSessions(fixture)
    fixture.store.atomic((db) => {
      const insert = db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
          source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
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
                  route: pricingRoute,
                  routeEvidence: { status: "observed", route: pricingRoute },
                },
          ),
        )
      }
    })
    const provider = lz137ValuationProvider({ withStrictOpenCodePrice: true })
    const fold = new TaskEffortFold(fixture.repository, inThread(fixture, provider), {
      spacingMs: 0,
    })
    fold.start()
    try {
      fold.touch(taskID)
      await fold.settle()
      const times: number[] = []
      for (let run = 0; run < 3; run++) {
        fold.touch(taskID)
        const started = performance.now()
        await fold.settle()
        times.push(performance.now() - started)
      }
      times.sort((left, right) => left - right)
      console.info(`effort refresh of 3,619 progress rows: median ${times[1]!.toFixed(1)} ms`)
      expectSameEffort(
        fixture.repository.read((db) => readTaskEffort(db, fixture.directory, taskID))!.effort,
        await oracle(fixture, provider),
      )
    } finally {
      fold.close()
    }
  } finally {
    fixture.close()
  }
})

test("the seed queues every planned task of the project once; the fold computes them", async () => {
  const fixture = makeFixture()
  try {
    storeSessions(fixture)
    const fold = new TaskEffortFold(
      fixture.repository,
      inThread(
        fixture,
        pricedProvider(() => 1),
      ),
      {
        spacingMs: 0,
      },
    )
    fold.start()
    const seed = startProjection(
      fixture.repository.path,
      fixture.directory,
      taskEffortSeedProjection,
      {
        scope: fixture.directory,
      },
    )
    try {
      await seed.owner.settle()
      await fold.settle()
      expect(
        fixture.repository.read((db) => readTaskEffort(db, fixture.directory, taskID)),
      ).toBeDefined()
      expect(fold.idle()).toBe(true)
      expect(seed.owner.status()?.state).toBe("ready")
    } finally {
      seed.release()
      fold.close()
    }
  } finally {
    fixture.close()
  }
})
