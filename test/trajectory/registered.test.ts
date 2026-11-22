import { expect, test } from "bun:test"
import { renameSync } from "node:fs"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { registerTrajectoryTools } from "../../src/trajectory/tools.ts"
import { taskEventsProjection } from "../../src/events/task-events-refresh.ts"
import { startProjection } from "../../src/projections/owner.ts"
import { ensureTranscriptMetaSchema } from "../../src/transcript-meta/schema.ts"
import { TaskRepository } from "../../src/storage.ts"
import { firstAttemptID, makeFixture, taskID } from "./fixture.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

const context = {
  sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))("ses-owner"),
  agent: Agent.ID.make("architect"),
  messageID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
    "msg-inspect",
  ),
  id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))("call-inspect"),
  progress: () => Effect.void,
} satisfies Parameters<RegisteredTool["execute"]>[1]

async function setup(options: { deny?: boolean } = {}) {
  const fixture = makeFixture()
  ensureTranscriptMetaSchema(fixture.repository)
  const lease = startProjection(fixture.repository.path, fixture.directory, taskEventsProjection, {
    pacing: {
      startMs: 60_000,
      quiet: { sliceMs: 1, waitMs: 1 },
      busy: { sliceMs: 1, waitMs: 1 },
      retryMs: 60_000,
    },
  })
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
  const permissionOrder: string[] = []
  const transform = ((callback: Parameters<Plugin.Context["tool"]["transform"]>[0]) =>
    Effect.sync(() => {
      callback(editor)
      return { dispose: Effect.void }
    })) as Plugin.Context["tool"]["transform"]
  const fakeContext = {
    permission: {
      assert: (input: Parameters<Plugin.Context["permission"]["assert"]>[0]) => {
        permissionOrder.push(String(input.action))
        return options.deny ? Effect.die(new Error("Permission denied")) : Effect.void
      },
    },
    tool: { transform },
  } as unknown as Pick<Plugin.Context, "permission" | "tool">
  await Effect.runPromise(Effect.scoped(registerTrajectoryTools(fakeContext, fixture.store)))
  const close = () => {
    lease.release()
    fixture.close()
  }
  return { ...fixture, close, tools, permissionOrder }
}

test("registered trajectory tool is permission-first, structured, and pages exact stable events", async () => {
  const fixture = await setup()
  try {
    const tool = fixture.tools.get("lz-inspect-trajectory")!
    expect(tool.options?.codemode).toBe(true)
    expect(tool.options?.pinned).toBe(true)
    expect(tool.options?.permission).toBe("lz-inspect-trajectory")
    const firstResult = await Effect.runPromise(tool.execute({ taskID, limit: 2 }, context))
    expect(fixture.permissionOrder).toEqual(["lz-inspect-trajectory"])
    const first = firstResult.output as {
      trajectory: { events: Array<Record<string, unknown>>; nextCursor: string | null }
    }
    expect(firstResult.output).toEqual(JSON.parse(String(firstResult.content)))
    expect(first.trajectory.events).toHaveLength(2)
    const events = [...first.trajectory.events]
    let cursor = first.trajectory.nextCursor
    while (cursor) {
      const result = await Effect.runPromise(tool.execute({ taskID, limit: 2, cursor }, context))
      const page = result.output as {
        trajectory: { events: Array<Record<string, unknown>>; nextCursor: string | null }
      }
      expect(page).toEqual(JSON.parse(String(result.content)))
      events.push(...page.trajectory.events)
      cursor = page.trajectory.nextCursor
    }
    const completeResult = await Effect.runPromise(tool.execute({ taskID, limit: 50 }, context))
    const complete = completeResult.output as {
      trajectory: { events: Array<Record<string, unknown>> }
    }
    expect(events).toEqual(complete.trajectory.events)
    expect(fixture.permissionOrder).toHaveLength(Math.ceil(events.length / 2) + 1)
  } finally {
    fixture.close()
  }
})

test("permission denial precedes input validation, and database reopen", async () => {
  const fixture = await setup({ deny: true })
  fixture.repository.close()
  renameSync(fixture.repository.path, `${fixture.repository.path}.unavailable`)
  try {
    const tool = fixture.tools.get("lz-inspect-trajectory")!
    for (const input of [{ invalid: true }, { taskID }])
      await expect(Effect.runPromise(tool.execute(input, context))).rejects.toThrow(
        "Permission denied",
      )
    expect(fixture.permissionOrder).toEqual(["lz-inspect-trajectory", "lz-inspect-trajectory"])
  } finally {
    fixture.close()
  }
})

test("Architect, implementor, and another permitted agent can read owned reports", async () => {
  const fixture = await setup()
  try {
    const tool = fixture.tools.get("lz-inspect-trajectory")!
    const callers = [
      { agent: Agent.ID.make("architect"), input: { taskID } },
      { agent: Agent.ID.make("lazers-implementor"), input: { attemptID: firstAttemptID } },
      { agent: Agent.ID.make("lazers-reviewer"), input: { taskID } },
    ]
    for (const caller of callers) {
      const result = await Effect.runPromise(
        tool.execute(caller.input, { ...context, agent: caller.agent }),
      )
      const report = result.output as {
        taskID: string
        focusedAttemptID: string | null
        trajectory: { events: Array<{ attempt_id: string | null }> }
      }
      expect(report.taskID).toBe(taskID)
      expect(report).toEqual(JSON.parse(String(result.content)))
      if (caller.agent === "lazers-implementor") {
        expect(report.focusedAttemptID).toBe(firstAttemptID)
        expect(
          report.trajectory.events.every(
            (event) => event.attempt_id === firstAttemptID || event.attempt_id === null,
          ),
        ).toBe(true)
      }
    }
    expect(fixture.permissionOrder).toEqual([
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
    ])
  } finally {
    fixture.close()
  }
})

test("retained callback survives setup connection disposal without changing durable read state", async () => {
  const fixture = await setup()
  const before = fixture.repository.atomic((db) => ({
    watermark: fixture.repository.version(),
    attempts: db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_attempts")
      .get()!.count,
    transitions: db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_transitions")
      .get()!.count,
  }))
  try {
    fixture.repository.close()
    const result = await Effect.runPromise(
      fixture.tools.get("lz-inspect-trajectory")!.execute({ taskID }, context),
    )
    expect(JSON.parse(String(result.content)).taskID).toBe(taskID)
    const reopened = new TaskRepository(
      fixture.repository.path,
      fixture.repository.projectDirectory,
    )
    try {
      const after = reopened.atomic((db) => ({
        watermark: reopened.version(),
        attempts: db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_attempts")
          .get()!.count,
        transitions: db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_transitions")
          .get()!.count,
      }))
      expect(after).toEqual(before)
    } finally {
      reopened.close()
    }
  } finally {
    fixture.close()
  }
})
