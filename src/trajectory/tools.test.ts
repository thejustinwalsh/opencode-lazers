import { expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import type { TaskValuationProvider } from "../models/task-valuation.ts"
import { unavailableTaskValuation } from "../models/task-valuation.ts"
import { makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import { registerTrajectoryTools } from "./tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

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

test("registered trajectory tool returns Models valuation and authorizes before provider access", async () => {
  const fixture = makeFixture()
  const tools = new Map<string, RegisteredTool>()
  const permissionCalls: string[] = []
  let providerCalls = 0
  let denied = false
  const provider: TaskValuationProvider = async (input, signal) => {
    providerCalls += 1
    signal.throwIfAborted()
    return unavailableTaskValuation(input)
  }
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const context = {
    permission: {
      assert: ({ action }: { action: string }) => {
        permissionCalls.push(action)
        return denied ? Effect.fail(new Error("permission denied")) : Effect.void
      },
    },
    tool: {
      transform: (callback: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  }

  try {
    await Effect.runPromise(
      Effect.scoped(
        registerTrajectoryTools(context as never, fixture.store, fixture.host, "project", provider),
      ),
    )
    const tool = tools.get("lz-inspect-trajectory")!
    const result = await Effect.runPromise(tool.execute({ taskID, limit: 20 }, callContext()))
    expect(result.output).toMatchObject({
      effort: {
        marketEquivalentCost: {
          status: "unavailable",
          valueUSD: null,
          currentIndex: null,
        },
      },
    })
    expect(providerCalls).toBe(1)
    expect(permissionCalls).toEqual(["lz-inspect-trajectory"])

    denied = true
    await expect(
      Effect.runPromise(tool.execute({ taskID, limit: 20 }, callContext())),
    ).rejects.toThrow("permission denied")
    expect(providerCalls).toBe(1)
    expect(permissionCalls).toEqual(["lz-inspect-trajectory", "lz-inspect-trajectory"])
  } finally {
    fixture.close()
  }
})
