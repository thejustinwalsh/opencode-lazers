import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { firstAttemptID, makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import { taskEventsProjection } from "../events/task-events-refresh.ts"
import { startProjection } from "../projections/owner.ts"
import { ensureTranscriptMetaSchema } from "../transcript-meta/schema.ts"
import { registerTrajectoryTools } from "./tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
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

type Page = {
  taskID: string
  trajectory: { events: { ref: string; attempt_id: string | null }[]; nextCursor: string | null }
}

async function setup(permission: (action: string) => Effect.Effect<void, Error>) {
  const fixture = makeFixture()
  cleanups.push(() => fixture.close())
  ensureTranscriptMetaSchema(fixture.repository)
  const lease = startProjection(fixture.repository.path, fixture.directory, taskEventsProjection, {
    pacing: {
      startMs: 60_000,
      quiet: { sliceMs: 1, waitMs: 1 },
      busy: { sliceMs: 1, waitMs: 1 },
      retryMs: 60_000,
    },
  })
  cleanups.push(() => lease.release())
  await lease.owner.settle()
  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const context = {
    permission: { assert: ({ action }: { action: string }) => permission(action) },
    tool: {
      transform: (callback: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  }
  await Effect.runPromise(Effect.scoped(registerTrajectoryTools(context as never, fixture.store)))
  const tool = tools.get("lz-inspect-trajectory")!
  const call = async (input: Record<string, unknown>) =>
    (await Effect.runPromise(tool.execute(input as never, callContext()))).output as Page
  return { fixture, call, tool }
}

test("one window and a continue marker; the next call continues at the edge", async () => {
  const { call } = await setup(() => Effect.void)
  const all = (await call({ taskID, limit: 50 })).trajectory
  expect(all.nextCursor).toBeNull()
  expect(all.events.length).toBeGreaterThan(4)

  const first = await call({ taskID, limit: 2 })
  expect(first.trajectory.events.map((row) => row.ref)).toEqual(
    all.events.slice(0, 2).map((row) => row.ref),
  )
  // The marker is the edge: the last row's key.
  expect(first.trajectory.nextCursor).toBe(first.trajectory.events[1]!.ref)

  const seen = [...first.trajectory.events]
  let cursor = first.trajectory.nextCursor
  while (cursor) {
    const page = await call({ taskID, limit: 2, cursor })
    // Never repeats the marker row, never skips one.
    expect(page.trajectory.events[0]!.ref).not.toBe(cursor)
    seen.push(...page.trajectory.events)
    cursor = page.trajectory.nextCursor
  }
  expect(seen.map((row) => row.ref)).toEqual(all.events.map((row) => row.ref))
  await expect(call({ taskID, limit: 2, cursor: "no-such-row" })).rejects.toThrow()
})

test("an attempt's view keeps its rows and the plan-level ones; the task must belong to the project", async () => {
  const { call } = await setup(() => Effect.void)
  const page = await call({ attemptID: firstAttemptID, limit: 50 })
  expect(page.taskID).toBe(taskID)
  expect(
    page.trajectory.events.every(
      (row) => row.attempt_id === firstAttemptID || row.attempt_id === null,
    ),
  ).toBe(true)
  await expect(call({ taskID: "11111111-1111-4111-8111-111111111111", limit: 5 })).rejects.toThrow(
    "No observation in this scope",
  )
})

test("the tool authorizes before it reads", async () => {
  let denied = false
  const calls: string[] = []
  const { call } = await setup((action) => {
    calls.push(action)
    return denied ? Effect.fail(new Error("permission denied")) : Effect.void
  })
  await call({ taskID, limit: 2 })
  denied = true
  await expect(call({ taskID, limit: 2 })).rejects.toThrow("permission denied")
  expect(calls).toEqual(["lz-inspect-trajectory", "lz-inspect-trajectory"])
})
