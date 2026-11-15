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
  for (const tool of tools.values()) expect(tool.options?.codemode).toBe(true)
  const context = {
    sessionID: Session.ID.create(),
    agent: Agent.ID.make("architect"),
    messageID: SessionMessage.ID.create(),
    id: Tool.CallID.make("call"),
    progress: () => Effect.void,
  }
  const answer = await Effect.runPromise(
    tools.get("lz-local-ask")!.execute({ prompt: "q" }, context),
  )
  expect(JSON.parse(String(answer.content)).text).toBe("local answer")
  expect(calls[0]).toEqual({ prompt: "q", timeoutMs: 120_000, maxTokens: 256 })
  const decision = await Effect.runPromise(
    tools
      .get("lz-local-decide")!
      .execute({ question: "q", context: "evidence", decision: { kind: "boolean" } }, context),
  )
  expect(JSON.parse(String(decision.content))).toEqual({ ok: true, kind: "boolean", value: true })
  const systemOne = tools.get("lz-local-system-one")!
  expect(systemOne.description).toContain("64,000-character serialized transport envelope")
  expect(systemOne.description).toContain("8,192-token context")
  expect(systemOne.description).not.toContain("8,000 serialized characters")
  denied = true
  await expect(
    Effect.runPromise(tools.get("lz-local-ask")!.execute({ prompt: "denied" }, context)),
  ).rejects.toThrow("Permission denied")
  expect(calls).toHaveLength(2)
})

test("registered tools forward native identity and preserve failure semantics", async () => {
  const tools = new Map<string, Parameters<ToolEditor["add"]>[0]>()
  const asserts: Array<{ sessionID: unknown; agent: unknown; action: string }> = []
  const rpcCalls: Array<{ method: string; input: unknown }> = []
  let denyPermission = false
  const failure: { ask?: unknown } = {}
  const features: Record<string, boolean> = { questions: true, decisions: true }
  const rpc = (() => ({
    ask: (input: unknown) => {
      rpcCalls.push({ method: "ask", input })
      return failure.ask !== undefined
        ? Effect.fail(failure.ask)
        : Effect.succeed({
            ok: true,
            text: "answer",
            error: "",
            promptTokens: 1,
            completionTokens: 1,
          })
    },
    decide: (input: unknown) => {
      rpcCalls.push({ method: "decide", input })
      return Effect.succeed({ ok: true, kind: "boolean", value: false })
    },
    systemOne: (input: unknown) => {
      rpcCalls.push({ method: "systemOne", input })
      return Effect.succeed({
        model: "d1-omni-2b",
        answers: {},
        usage: { input_tokens: 1, output_tokens: 0 },
      })
    },
  })) as unknown as Plugin.Context["rpc"]
  await Effect.runPromise(
    Effect.scoped(
      registerInferenceTools(
        {
          rpc,
          permission: {
            assert: (input: { sessionID: unknown; agent?: unknown; action: string }) => {
              asserts.push({ sessionID: input.sessionID, agent: input.agent, action: input.action })
              return denyPermission
                ? Effect.fail(new Tool.Error({ message: "denied by policy" }))
                : Effect.void
            },
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
        },
        (feature) => features[feature] !== false,
      ),
    ),
  )
  const context = {
    sessionID: Session.ID.create(),
    agent: Agent.ID.make("architect"),
    messageID: SessionMessage.ID.create(),
    id: Tool.CallID.make("call"),
    progress: () => Effect.void,
  }
  const systemOneInput = {
    model: "d1-omni-2b" as const,
    state: "shared state",
    questions: { q: { type: "noul" as const, instructions: "Is it usable?" } },
  }
  await Effect.runPromise(tools.get("lz-local-system-one")!.execute(systemOneInput, context))
  await Effect.runPromise(tools.get("lz-local-ask")!.execute({ prompt: "hello" }, context))
  await Effect.runPromise(
    tools
      .get("lz-local-decide")!
      .execute({ question: "q", context: "evidence", decision: { kind: "boolean" } }, context),
  )
  expect(asserts.map((entry) => entry.action)).toEqual([
    "lz-local-system-one",
    "lz-local-ask",
    "lz-local-decide",
  ])
  for (const entry of asserts) {
    expect(entry.sessionID).toBe(context.sessionID)
    expect(entry.agent).toBe(context.agent)
  }
  expect(rpcCalls.map((call) => call.method)).toEqual(["systemOne", "ask", "decide"])
  const rpcBeforeDenied = rpcCalls.length
  denyPermission = true
  await expect(
    Effect.runPromise(tools.get("lz-local-ask")!.execute({ prompt: "blocked" }, context)),
  ).rejects.toThrow("denied by policy")
  expect(rpcCalls).toHaveLength(rpcBeforeDenied)
  denyPermission = false
  features.questions = false
  await expect(
    Effect.runPromise(tools.get("lz-local-ask")!.execute({ prompt: "off" }, context)),
  ).rejects.toThrow("turned off")
  expect(rpcCalls).toHaveLength(rpcBeforeDenied)
  features.questions = true
  failure.ask = new Error("boom transport")
  await expect(
    Effect.runPromise(tools.get("lz-local-ask")!.execute({ prompt: "failing" }, context)),
  ).rejects.toThrow("boom transport")
  expect(rpcCalls).toHaveLength(rpcBeforeDenied + 1)
})
