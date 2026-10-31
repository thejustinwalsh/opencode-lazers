import { expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Tool } from "@opencode/schema/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { registerInferenceTools } from "./tools.ts"

test("agent tools enforce permissions before RPC and apply bounded defaults", async () => {
  const tools = new Map<string, Parameters<ToolEditor["add"]>[0]>()
  const calls: unknown[] = []
  let denied = false
  const rpc = (() => ({
    ask: (input: unknown) => {
      calls.push(input)
      return Effect.succeed({
        ok: true,
        text: "local answer",
        error: "",
        promptTokens: 3,
        completionTokens: 2,
      })
    },
    decide: (input: unknown) => {
      calls.push(input)
      return Effect.succeed({ ok: true, kind: "boolean", value: true })
    },
  })) as unknown as Plugin.Context["rpc"]
  await Effect.runPromise(
    Effect.scoped(
      registerInferenceTools({
        rpc,
        permission: {
          assert: () => (denied ? Effect.die(new Error("Permission denied")) : Effect.void),
        },
        tool: {
          transform: (callback) =>
            Effect.sync(() => {
              callback({
                add: (tool) => tools.set(tool.name, tool),
                list: () => [],
                get: () => undefined,
                namespace: () => {},
                update: () => {},
                remove: () => {},
              })
              return { dispose: Effect.void }
            }),
        },
      }),
    ),
  )
  const context = {
    sessionID: Session.ID.create(),
    agent: Agent.ID.make("architect"),
    messageID: SessionMessage.ID.create(),
    id: Tool.CallID.make("call"),
    progress: () => Effect.void,
  }
  const answer = await Effect.runPromise(
    tools.get("lazers_local_ask")!.execute({ prompt: "q" }, context),
  )
  expect(JSON.parse(String(answer.content)).text).toBe("local answer")
  expect(calls[0]).toEqual({ prompt: "q", timeoutMs: 60_000, maxTokens: 256 })
  const decision = await Effect.runPromise(
    tools
      .get("lazers_local_decide")!
      .execute({ question: "q", context: "evidence", decision: { kind: "boolean" } }, context),
  )
  expect(JSON.parse(String(decision.content))).toEqual({ ok: true, kind: "boolean", value: true })
  denied = true
  await expect(
    Effect.runPromise(tools.get("lazers_local_ask")!.execute({ prompt: "denied" }, context)),
  ).rejects.toThrow("Permission denied")
  expect(calls).toHaveLength(2)
})
