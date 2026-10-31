import { expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import workerInstructions from "../implementor.md" with { type: "text" }
import { delegationTool, registerWorker } from "./roles.ts"
import type { RunnerStore } from "./store.ts"

test("worker personas share the normal tool core and cannot inspect catalogs or delegate", async () => {
  const model = { providerID: "custom-provider", id: "selected", variant: "deep" }
  const agent = { model, permissions: [] as unknown[] }
  let contextHook: ((context: never) => Effect.Effect<void>) | undefined
  let executeHook: ((call: never) => Effect.Effect<void>) | undefined
  const store = {
    atomic: (run: (db: never) => unknown) =>
      run({
        query: () => ({
          get: () => ({ id: "attempt", task_id: "task", tool_count: 0, retry_count: 0 }),
          run: () => {},
        }),
      } as never),
  } as unknown as RunnerStore
  const ctx = {
    agent: {
      transform: (transform: (editor: unknown) => void) =>
        Effect.sync(() =>
          transform({
            update: (_id: string, update: (value: typeof agent) => void) => update(agent),
          }),
        ),
    },
    session: {
      hook: (name: string, callback: (context: never) => Effect.Effect<void>) => {
        if (name === "context") contextHook = callback
        return Effect.void
      },
    },
    tool: {
      hook: (_name: string, callback: (call: never) => Effect.Effect<void>) => {
        executeHook = callback
        return Effect.void
      },
    },
  } as unknown as Plugin.Context

  await Effect.runPromise(Effect.scoped(registerWorker(ctx, store)))
  expect(agent.model).toEqual(model)
  expect(agent).toHaveProperty("system", workerInstructions.trim())
  expect(agent.permissions).toContainEqual({
    action: "lazers_worker_catalog",
    resource: "*",
    effect: "deny",
  })
  const context = {
    sessionID: "worker",
    tools: {
      read: {},
      edit: {},
      bash: {},
      "subagent.list": {},
      lazers_worker_catalog: {},
      lazers_plan_command: {},
    },
  }
  await Effect.runPromise(contextHook!(context as never))
  expect(delegationTool("subagent.list")).toBe(true)
  expect(delegationTool("lazers_worker_catalog")).toBe(true)
  expect(Object.keys(context.tools)).toEqual(["read", "edit", "bash"])
  await Effect.runPromise(
    executeHook!({
      sessionID: "worker",
      agent: Agent.ID.make("lazers-implementor"),
      tool: "bash",
    } as never),
  )
  await expect(
    Effect.runPromise(
      executeHook!({
        sessionID: "worker",
        agent: Agent.ID.make("lazers-implementor"),
        tool: "subagent.list",
      } as never),
    ),
  ).rejects.toThrow("Only the LAZERS runtime may dispatch agents")
})
