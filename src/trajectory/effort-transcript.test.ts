import { expect, test } from "bun:test"
import { cursorSecret, makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import {
  lz137ValuationProvider,
  prepareLz137RetainedData,
} from "../../test/trajectory-panel/lz137-market-fixture.ts"
import { nativeMillionTokenIndex } from "../../test/models-valuation/fixtures/current-indexes.ts"
import { storeSessions } from "../../test/trajectory/stored-sessions.ts"
import type { HostMessageClient } from "../core/host-messages.ts"
import { createTaskValuationReader, type TaskValuationProvider } from "../models/task-valuation.ts"
import type { CurrentPriceIndex } from "../models/valuation-schema.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { TranscriptMetaFold } from "../transcript-meta/fold.ts"
import { TRANSCRIPT_META_QUEUE } from "../transcript-meta/schema.ts"
import { computeTaskEffort, computeTaskEffortDetail, effortSummary } from "./effort-compute.ts"
import { readTaskEffort, TaskEffortFold } from "./effort-store.ts"
import type { TrajectoryHost } from "./native.ts"
import { inspectTrajectory } from "./read.ts"

/** The whole event projection in one read: `inspectTrajectory` with every event (the old capture). */
const captureTrajectoryHistory = (
  store: Parameters<typeof inspectTrajectory>[0],
  host: Parameters<typeof inspectTrajectory>[1],
  projectID: string,
  input: Parameters<typeof inspectTrajectory>[3],
  cursorSecret: Uint8Array,
  options: NonNullable<Parameters<typeof inspectTrajectory>[5]> = {},
) => inspectTrajectory(store, host, projectID, input, cursorSecret, { ...options, allEvents: true })

type Fixture = ReturnType<typeof makeFixture>

const route = { providerID: "openai", modelID: "gpt-6-luna", variant: "max" }

function pricedProvider(): TaskValuationProvider {
  const index: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  const pin = index.pins[0]!
  pin.route = route
  pin.productID = route.modelID
  pin.configurationID = "gpt-6-luna-default"
  return createTaskValuationReader(async (_routes, signal) => {
    signal.throwIfAborted()
    return { index: { ...index, indexID: "test-index" }, freshness: "current" }
  })
}

/** The host's message list over the fixture's transcripts, paged as OpenCode pages it (live). */
function messageClient(fixture: Fixture): HostMessageClient {
  return {
    message: {
      async list(input: { sessionID: string; limit?: number; cursor?: string; order?: string }) {
        if (input.cursor && input.order) throw new Error("Cursor cannot be combined with order")
        const all = (fixture.sessions.get(input.sessionID)?.messages ?? []) as unknown[]
        const offset = input.cursor ? Number(input.cursor) : 0
        const limit = input.limit ?? 50
        // As the real host pages: a keyset `next` on every page that has messages, the last one
        // too; past the end an empty page with no cursors.
        const data = all.slice(offset, offset + limit)
        const next = data.length > 0 ? String(offset + data.length) : null
        return { data, cursor: { next, previous: null } }
      },
    },
  } as unknown as HostMessageClient
}

/** Fold every fixture transcript into the stored metadata, as the project core's fold does. */
async function foldTranscripts(fixture: Fixture) {
  const fold = new TranscriptMetaFold(fixture.repository, messageClient(fixture), { spacingMs: 0 })
  fold.start()
  fixture.repository.atomic((db) => {
    for (const id of fixture.sessions.keys())
      db.query(`INSERT OR IGNORE INTO ${TRANSCRIPT_META_QUEUE}(ref,next_at) VALUES(?,0)`).run(
        `${fixture.directory}\u0000${id}`,
      )
  })
  const started = performance.now()
  await fold.settle()
  const elapsed = performance.now() - started
  fold.close()
  return { pages: fold.reads.pages, elapsed }
}

/** The history capture: the host read with every transcript, paged into the report's fold. */
function historyHost(fixture: Fixture, missing: readonly string[]): TrajectoryHost {
  return {
    session: async (id, _attempt, sink) => {
      const session = missing.includes(id) ? undefined : fixture.sessions.get(id)
      if (!session) return null
      if (!sink) return session
      const messages = session.messages ?? []
      for (let offset = 0; offset < Math.min(messages.length, 10_001); offset += 50)
        sink(messages.slice(offset, Math.min(offset + 50, 10_001)))
      return { ...session, messages: null }
    },
  }
}

const history = (fixture: Fixture, provider: TaskValuationProvider, missing: string[]) =>
  captureTrajectoryHistory(
    fixture.store,
    historyHost(fixture, missing),
    "project",
    { taskID, limit: 50 },
    cursorSecret,
    { taskValuationProvider: provider },
  )

const detail = (fixture: Fixture, provider: TaskValuationProvider) =>
  computeTaskEffortDetail(
    fixture.repository.path,
    fixture.directory,
    "project",
    taskID,
    provider,
    new AbortController().signal,
  )

async function storedSummary(fixture: Fixture, provider: TaskValuationProvider) {
  const fold = new TaskEffortFold(
    fixture.repository,
    (task, signal) =>
      computeTaskEffort(
        fixture.repository.path,
        fixture.directory,
        "project",
        task,
        provider,
        signal,
      ),
    { spacingMs: 0 },
  )
  fold.start()
  try {
    fold.touch(taskID)
    await fold.settle()
    return fixture.repository.read((db) => readTaskEffort(db, fixture.directory, taskID))
  } finally {
    fold.close()
  }
}

/** `count` user messages after the transcript: it passes the report's bound of 10,000. */
function lengthen(fixture: Fixture, count: number) {
  const session = fixture.sessions.get("ses-accepted")!
  session.messages = [
    ...(session.messages ?? []),
    ...Array.from({ length: count }, (_, index) => ({
      id: `msg-pad-${index}`,
      type: "user",
      text: "padding",
    })),
  ] as never
}

test("effort from stored transcript metadata equals the history capture on every field", async () => {
  const scenarios: Array<{
    name: string
    prepare(fixture: Fixture): void
    provider(): TaskValuationProvider
    missing?: string[]
    expectAttribution?: string
  }> = [
    {
      name: "transcript step routes, priced",
      prepare: () => {},
      provider: pricedProvider,
    },
    {
      name: "LZ-137 retained steps and recovery gaps, sourced estimate",
      prepare: prepareLz137RetainedData,
      provider: () => lz137ValuationProvider({ withStrictOpenCodePrice: true }),
    },
    {
      name: "a missing session: its stored transcript is not read",
      prepare: prepareLz137RetainedData,
      provider: () => lz137ValuationProvider({ withStrictOpenCodePrice: true }),
      missing: ["ses-failed"],
    },
    {
      name: "mixed observed routes (transcript and progress disagree)",
      prepare: (fixture) => {
        new ProgressRecorder(fixture.store, "project").recordNativeEvent({
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
      provider: pricedProvider,
      expectAttribution: "Mixed observed routes",
    },
    {
      name: "a transcript past the bound is truncated",
      prepare: (fixture) => lengthen(fixture, 10_010),
      provider: pricedProvider,
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
      await foldTranscripts(fixture)
      const report = await history(fixture, provider, missing)
      const composed = await detail(fixture, provider)
      expect(JSON.stringify(composed), scenario.name).toBe(JSON.stringify(report.effort))
      const stored = await storedSummary(fixture, provider)
      expect(JSON.stringify(stored?.effort), scenario.name).toBe(
        JSON.stringify(effortSummary(report.effort)),
      )
      const routes = report.effort.taskEffortBasis.routes
      expect(routes.observedStepRoutes.length, scenario.name).toBeGreaterThan(0)
      if (scenario.expectAttribution)
        expect(routes.usageAttribution, scenario.name).toStartWith(scenario.expectAttribution)
      if (scenario.name.includes("bound"))
        expect(JSON.stringify(report.effort), scenario.name).toContain(
          '"truncatedContextSessionIDs":["ses-accepted"]',
        )
    } finally {
      fixture.close()
    }
  }
})

test("measure: a 3,619-step task, transcript fold cost and stored row size", async () => {
  const fixture = makeFixture()
  try {
    prepareLz137RetainedData(fixture)
    const steps = 3_619
    const session = fixture.sessions.get("ses-accepted")!
    session.messages = Array.from({ length: steps }, (_, index) => ({
      id: `msg-step-${String(index).padStart(5, "0")}`,
      type: "assistant",
      time: { created: 10_000 + index, completed: 10_050 + index },
      model: { providerID: route.providerID, id: route.modelID, variant: route.variant },
      tokens: { input: 2_900, output: 100, reasoning: 90, cache: { read: 43_000, write: 0 } },
      content: [{ type: "text", text: "visible" }],
    })) as never
    storeSessions(fixture)
    const fold = await foldTranscripts(fixture)
    const provider = lz137ValuationProvider({ withStrictOpenCodePrice: true })
    const report = await history(fixture, provider, [])
    const full = JSON.stringify(report.effort).length
    const summary = JSON.stringify(effortSummary(report.effort)).length
    const times: number[] = []
    for (let run = 0; run < 3; run++) {
      const started = performance.now()
      await detail(fixture, provider)
      times.push(performance.now() - started)
    }
    times.sort((left, right) => left - right)
    console.info(
      `transcript fold: ${steps} messages in ${fold.pages} pages, ${fold.elapsed.toFixed(1)} ms ` +
        `(${(fold.elapsed / fold.pages).toFixed(2)} ms a page); effort JSON ${full} bytes whole, ` +
        `${summary} bytes stored; composed detail median ${times[1]!.toFixed(1)} ms`,
    )
    expect(JSON.stringify(await detail(fixture, provider))).toBe(JSON.stringify(report.effort))
    // One refresh that changes the row: the bytes the write-ahead log grows by.
    await storedSummary(fixture, provider)
    const wal = () => Bun.file(`${fixture.repository.path}-wal`).size
    const before = wal()
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE task_id=?").run(taskID),
    )
    const queued = wal()
    await storedSummary(fixture, provider)
    const row = fixture.repository.read((db) =>
      db
        .query<{ bytes: number }, []>(
          "SELECT length(CAST(effort AS BLOB)) AS bytes FROM trajectory_task_effort",
        )
        .get(),
    )
    console.info(
      `stored row ${row?.bytes} bytes; one changed refresh wrote ${wal() - queued} WAL bytes ` +
        `(the triggering attempt write: ${queued - before})`,
    )
    expect(report.effort.taskEffortBasis.routes.observedStepRoutes.length).toBeGreaterThan(3_000)
    expect(summary * 20).toBeLessThan(full)
  } finally {
    fixture.close()
  }
})
