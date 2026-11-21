import { afterAll, beforeAll, expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import type { HostMessageClient } from "../core/host-messages.ts"
import { taskEventsProjection } from "../events/task-events-refresh.ts"
import { createTaskValuationReader, type TaskValuationProvider } from "../models/task-valuation.ts"
import type { CurrentPriceIndex } from "../models/valuation-schema.ts"
import { startProjection } from "../projections/owner.ts"
import { TranscriptMetaFold } from "../transcript-meta/fold.ts"
import { ensureTranscriptMetaSchema, TRANSCRIPT_META_QUEUE } from "../transcript-meta/schema.ts"
import { nativeMillionTokenIndex } from "../../test/models-valuation/fixtures/current-indexes.ts"
import { cursorSecret, firstAttemptID, makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import { storeSessions } from "../../test/trajectory/stored-sessions.ts"
import { computeTaskEffort, effortSummary } from "./effort-compute.ts"
import { TaskEffortFold } from "./effort-store.ts"
import { inspectTrajectory } from "./read.ts"
import { InspectTrajectoryInput } from "./schema.ts"
import { registerTrajectoryTools } from "./tools.ts"

/**
 * `lz-inspect-trajectory` against the pre-stream tool's output (`inspectTrajectory`, which the old
 * tool returned whole) on the trajectory fixture, one section at a time. The new tool reads stored
 * rows only; the old one read the host. Every difference left is listed where it is asserted.
 */
type RegisteredTool = Parameters<ToolEditor["add"]>[0]
type Output = Record<string, unknown> & {
  trajectory: Record<string, unknown> & { events: Record<string, unknown>[] }
}

let made: ReturnType<typeof makeFixture>
let release: () => void
let folding: TranscriptMetaFold
let tool: RegisteredTool

/** One priced route: the fixture's sessions all ran it. */
const provider: TaskValuationProvider = createTaskValuationReader(async (_routes, signal) => {
  signal.throwIfAborted()
  const index: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  const pin = index.pins[0]!
  pin.route = { providerID: "openai", modelID: "gpt-6-luna", variant: "max" }
  pin.productID = "gpt-6-luna"
  return { index: { ...index, indexID: "parity-index" }, freshness: "current" }
})

function callContext() {
  return {
    sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))("ses-tool"),
    agent: Agent.ID.make("lazers-implementor"),
    messageID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
      "msg-tool",
    ),
    id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))("call-tool"),
    progress: () => Effect.void,
  } satisfies Parameters<RegisteredTool["execute"]>[1]
}

beforeAll(async () => {
  made = makeFixture()
  for (const session of made.sessions.values())
    session.model = { providerID: "openai", id: "gpt-6-luna", variant: "max" }
  storeSessions(made)
  const lease = startProjection(made.repository.path, made.directory, taskEventsProjection, {
    pacing: {
      startMs: 60_000,
      quiet: { sliceMs: 1, waitMs: 1 },
      busy: { sliceMs: 1, waitMs: 1 },
      retryMs: 60_000,
    },
  })
  release = () => lease.release()
  await lease.owner.settle()
  // The transcript metadata, folded from the same messages the old read listed.
  ensureTranscriptMetaSchema(made.repository)
  const transcripts = new Map(
    [...made.sessions.values()].map((session) => [session.id, [...session.messages!]]),
  )
  folding = new TranscriptMetaFold(
    made.repository,
    {
      message: {
        async list(input: { sessionID: string }) {
          return { data: transcripts.get(input.sessionID) ?? [], cursor: {} }
        },
      },
    } as unknown as HostMessageClient,
    { spacingMs: 0 },
  )
  folding.start()
  made.repository.atomic((db) => {
    for (const id of transcripts.keys())
      db.query(`INSERT OR IGNORE INTO ${TRANSCRIPT_META_QUEUE}(ref,next_at) VALUES(?,0)`).run(
        `${made.directory}\u0000${id}`,
      )
  })
  await folding.settle()
  await made.index()
  // The stored effort, computed by the fold with the same valuation the old tool ran.
  const fold = new TaskEffortFold(
    made.repository,
    (task, signal) =>
      computeTaskEffort(made.repository.path, made.directory, "project", task, provider, signal),
    { spacingMs: 0 },
  )
  fold.start()
  fold.touch(taskID)
  await fold.settle()
  fold.close()

  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    add: (entry) => tools.set(entry.name, entry),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  await Effect.runPromise(
    Effect.scoped(
      registerTrajectoryTools(
        {
          permission: { assert: () => Effect.void },
          tool: {
            transform: (callback: (editor: ToolEditor) => void) =>
              Effect.sync(() => {
                callback(editor)
                return { dispose: Effect.void }
              }),
          },
        } as never,
        made.store,
      ),
    ),
  )
  tool = tools.get("lz-inspect-trajectory")!
})

afterAll(() => {
  folding.close()
  release()
  made.close()
})

const call = async (input: Record<string, unknown>) =>
  (await Effect.runPromise(tool.execute(input as never, callContext()))).output as Output

/** The old tool's output: the whole report the pre-stream tool returned. */
const old = (input: Record<string, unknown>) =>
  inspectTrajectory(
    made.store,
    made.host,
    "project",
    InspectTrajectoryInput.parse(input),
    cursorSecret,
    {
      taskValuationProvider: provider,
    },
  ) as unknown as Promise<Output>

test("every section of the old output is present", async () => {
  const [before, after] = await Promise.all([old({ taskID, limit: 5 }), call({ taskID, limit: 5 })])
  for (const key of Object.keys(before)) expect(Object.keys(after)).toContain(key)
  for (const key of Object.keys(before.trajectory))
    expect(Object.keys(after.trajectory)).toContain(key)
  // A superset of the branch's version 2 (taskID, focusedAttemptID, trajectory), reported as 2:
  // version 1's sections, with events as stream rows and the row key as the continue marker.
  expect([before.schemaVersion, after.schemaVersion, after.taskID]).toEqual([1, 2, taskID])
})

test("task and plans: equal to the old output", async () => {
  const [before, after] = await Promise.all([old({ taskID, limit: 5 }), call({ taskID, limit: 5 })])
  expect(after.task).toEqual(before.task)
  // Plans carry their checks from the stored check events; waitingOn is the schedule row's list.
  expect(after.plans).toEqual(before.plans)
  expect((after.plans as { checks: unknown[] }[]).flatMap((plan) => plan.checks).length).toBe(3)
})

test("attempts: equal to the old output, busy and idle endpoints included", async () => {
  for (const input of [{ taskID }, { attemptID: firstAttemptID }]) {
    const [before, after] = await Promise.all([
      old({ ...input, limit: 5 }),
      call({ ...input, limit: 5 }),
    ])
    expect(after.focusedAttemptID).toBe(before.focusedAttemptID)
    type Attempt = Record<string, unknown> & {
      times: Record<string, unknown> | null
      intervals: { modelActivity: Record<string, unknown> }
    }
    expect((after.attempts as Attempt[]).length).toBeGreaterThan(0)
    expect(after.attempts).toEqual(before.attempts)
    // The fixture's sessions have both endpoints: the comparison covers real values.
    for (const attempt of after.attempts as Attempt[]) {
      expect(attempt.times?.lastBusyAt).toBeNumber()
      expect(attempt.times?.lastIdleAt).toBeNumber()
      expect(attempt.intervals.modelActivity.startedAt).toBeNumber()
    }
  }
})

test("effort: the stored summary of the old output's effort", async () => {
  const [before, after] = await Promise.all([old({ taskID, limit: 5 }), call({ taskID, limit: 5 })])
  const effort = before.effort as Parameters<typeof effortSummary>[0]
  // Every field of the old effort; the per-call route lists are their counts, and each call's
  // route is its assistant-step row in the paged events.
  const strip = (value: unknown) => {
    const copy = structuredClone(value) as {
      marketEquivalentCost?: { currentIndex?: { retrievedAt?: unknown } }
    }
    if (copy.marketEquivalentCost?.currentIndex)
      delete copy.marketEquivalentCost.currentIndex.retrievedAt
    return copy
  }
  expect(strip(after.effort)).toEqual(strip(effortSummary(effort)))
  const routes = effort.taskEffortBasis.routes
  const steps = (await call({ taskID, limit: 50 })).trajectory.events.filter(
    (row) => row.kind === "assistant-step" && row.route_model !== null,
  )
  // The same calls and routes; the events are in time order, the old list grouped by session.
  const key = (value: unknown[]) => JSON.stringify(value)
  expect(
    steps.map((row) => key([row.session_id, row.message_id, row.route_model])).toSorted(),
  ).toEqual(
    routes.observedStepRoutes
      .map((item) => key([item.sessionID, item.messageID, item.route?.modelID]))
      .toSorted(),
  )
  expect(steps.length).toBe(
    (after.effort as { taskEffortBasis: { routes: { observedStepRouteCount: number } } })
      .taskEffortBasis.routes.observedStepRouteCount,
  )
  expect(typeof after.effortRefreshedAt).toBe("number")
  expect(after.effortState).toBe("stored")
})

test("coverage and privacy: the old fields; reads of the host are stored-fact reads", async () => {
  const [before, after] = await Promise.all([old({ taskID, limit: 5 }), call({ taskID, limit: 5 })])
  const was = before.coverage as Record<string, unknown>
  const now = after.coverage as Record<string, unknown>
  expect(Object.keys(now).toSorted()).toEqual(Object.keys(was).toSorted())
  for (const key of [
    "availableSessionContexts",
    "unavailableSessionContexts",
    "fullSessionHistory",
    "ongoing",
    "attemptsWithoutRecordedSessions",
    "workerProgress",
    "compacted",
  ])
    expect([key, now[key]]).toEqual([key, was[key]])
  // The source descriptions name the stored tables. The fixture's accepted transcript holds a
  // compaction: the comparison covers a true value.
  expect(now.sessionRead).toContain("host_session_state")
  expect(now.compacted).toBe(true)
  const privacy = after.privacy as Record<string, unknown>
  expect(Object.keys(privacy).toSorted()).toEqual(Object.keys(before.privacy as object).toSorted())
  expect(privacy.warnings).toEqual((before.privacy as Record<string, unknown>).warnings)
})

test("trajectory: one window, its page and the timeline's stored total", async () => {
  const first = await call({ taskID, limit: 3 })
  expect(first.trajectory).toMatchObject({ page: 1, limit: 3, hasMore: true })
  const second = await call({ taskID, limit: 3, cursor: first.trajectory.nextCursor })
  expect(second.trajectory.page).toBe(2)
  const all = await call({ taskID, limit: 50 })
  expect(all.trajectory.totalEvents).toBe(all.trajectory.events.length)
  expect(first.trajectory.totalEvents).toBe(all.trajectory.events.length)
  // Documented: the old total counted message-text events too (`trajectory.transcript` now).
  const before = await old({ taskID, limit: 50 })
  expect(Number(before.trajectory.totalEvents)).toBeGreaterThan(Number(all.trajectory.totalEvents))
})
