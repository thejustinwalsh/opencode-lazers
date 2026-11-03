import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { registerRunnerTools } from "./tools.ts"
import type { TaskRuntime } from "./runtime.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

const callContext = (agent: string) =>
  ({
    sessionID: Session.ID.make("ses_test"),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_test"),
    id: Tool.CallID.make("call_test"),
    progress: () => Effect.void,
  }) as Parameters<RegisteredTool["execute"]>[1]

test("authorized callers read native catalog advice; only orchestration requires Architect", async () => {
  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const permissionChecks: string[] = []
  const continuityCalls: { sessionID: string; input: unknown }[] = []
  let catalogCalls = 0
  let denied = false
  const ctx = {
    location: { directory: "/project" },
    agent: {
      get: () =>
        Effect.succeed({
          data: { model: { providerID: "opencode-go", id: "qwen3.8-flash", variant: "xhigh" } },
        }),
    },
    model: {
      list: () => {
        catalogCalls++
        return Effect.succeed({
          data: [
            {
              providerID: "opencode-go",
              id: "qwen3.8-flash",
              name: "Qwen3.8 Flash",
              enabled: true,
              capabilities: { tools: false, input: ["text"], output: ["text"] },
              limit: { context: 256_000 },
              cost: [],
              variants: [{ id: "xhigh" }],
            },
          ],
        })
      },
    },
    permission: {
      assert: ({ action }: { action: string }) => {
        permissionChecks.push(action)
        if (denied) return Effect.fail(new Error("permission denied"))
        return Effect.void
      },
    },
    tool: {
      transform: (transform: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          transform(editor)
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Plugin.Context
  const runtime = {
    recordArchitectContinuity: async (sessionID: string, input: unknown) => {
      continuityCalls.push({ sessionID, input })
      return { status: "recorded", sessionID, revision: 1 }
    },
  } as unknown as TaskRuntime
  await Effect.runPromise(Effect.scoped(registerRunnerTools(ctx, runtime)))

  const catalog = tools.get("lz-worker-catalog")!
  expect(catalog.options).toMatchObject({ codemode: false, permission: "lz-worker-catalog" })
  const result = await Effect.runPromise(catalog.execute({}, callContext("architect")))
  const advice = JSON.parse(String(result.content))
  expect(advice.options[0]).toMatchObject({
    providerID: "opencode-go",
    id: "qwen3.8-flash",
    capabilities: { tools: false },
    variants: ["xhigh"],
    pricesUSDPerMillionTokens: null,
  })
  expect(advice.advisoryOnly).toBe(true)
  expect(permissionChecks).toEqual(["lz-worker-catalog"])
  expect(catalogCalls).toBe(1)

  const worker = await Effect.runPromise(catalog.execute({}, callContext("lazers-implementor")))
  const workerAdvice = JSON.parse(String(worker.content))
  expect(workerAdvice.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  expect({ ...workerAdvice, observedAt: advice.observedAt }).toEqual(advice)
  expect(permissionChecks).toEqual(["lz-worker-catalog", "lz-worker-catalog"])
  expect(catalogCalls).toBe(2)
  const continuity = tools.get("lz-record-architect-continuity")!
  expect(continuity.options).toMatchObject({
    codemode: false,
    permission: "lz-record-architect-continuity",
  })
  const checkpoint = {
    decisions: ["Keep the accepted direction."],
    unresolvedQuestions: ["Confirm rollout."],
  }
  const recorded = await Effect.runPromise(continuity.execute(checkpoint, callContext("architect")))
  expect(JSON.parse(String(recorded.content))).toMatchObject({
    status: "recorded",
    sessionID: "ses_test",
    revision: 1,
  })
  expect(continuityCalls).toEqual([{ sessionID: "ses_test", input: checkpoint }])
  await expect(
    Effect.runPromise(continuity.execute(checkpoint, callContext("lazers-implementor"))),
  ).rejects.toThrow("Plan orchestration is restricted to Architect")
  denied = true
  await expect(
    Effect.runPromise(continuity.execute(checkpoint, callContext("architect"))),
  ).rejects.toThrow("permission denied")
  expect(continuityCalls).toHaveLength(1)
  denied = false
  for (const name of ["lz-submit-plan", "lz-plan-command"])
    await expect(
      Effect.runPromise(tools.get(name)!.execute({}, callContext("lazers-implementor"))),
    ).rejects.toThrow("Plan orchestration is restricted to Architect")
  denied = true
  await expect(
    Effect.runPromise(catalog.execute({}, callContext("lazers-implementor"))),
  ).rejects.toThrow("permission denied")
  expect(catalogCalls).toBe(2)
})
