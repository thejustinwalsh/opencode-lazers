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

test("Architect's worker catalog tool presents live native route advice, not a validator", async () => {
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
  let catalogCalls = 0
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
  await Effect.runPromise(Effect.scoped(registerRunnerTools(ctx, {} as TaskRuntime)))

  const catalog = tools.get("lazers_worker_catalog")!
  expect(catalog.options).toMatchObject({ codemode: false, permission: "lazers_worker_catalog" })
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
  expect(permissionChecks).toEqual(["lazers_worker_catalog"])
  expect(catalogCalls).toBe(1)

  await expect(
    Effect.runPromise(catalog.execute({}, callContext("lazers-implementor"))),
  ).rejects.toThrow("Plan orchestration is restricted to Architect")
  expect(permissionChecks).toEqual(["lazers_worker_catalog", "lazers_worker_catalog"])
  expect(catalogCalls).toBe(1)
})
