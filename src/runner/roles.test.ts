import { expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import workerInstructions from "../implementor.md" with { type: "text" }
import { delegationTool, registerWorker } from "./roles.ts"
import type { RunnerStore } from "./store.ts"
import { sourceGuardInstalled } from "./source-quarantine.ts"

test("worker personas retain read-only catalog access but cannot delegate", async () => {
  const model = { providerID: "custom-provider", id: "selected", variant: "deep" }
  const agent = { model, permissions: [] as unknown[] }
  let contextHook: ((context: never) => Effect.Effect<void>) | undefined
  let executeHook: ((call: never) => Effect.Effect<void>) | undefined
  let quarantined = false
  let activeAssignment = true
  const store = {
    repository: { path: "/synthetic/roles.sqlite", projectDirectory: "/work" },
    atomic: (run: (db: never) => unknown) =>
      run({
        query: (sql: string) => ({
          get: () =>
            sql.includes("runner_source_quarantines")
              ? quarantined
                ? { session_id: "worker" }
                : null
              : activeAssignment
                ? { id: "attempt", task_id: "task", tool_count: 0, retry_count: 0 }
                : null,
          run: () => {},
        }),
      } as never),
  } as unknown as RunnerStore
  const ctx = {
    location: { directory: "/work" },
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

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerWorker(ctx, store)
        expect(sourceGuardInstalled(store, "/work")).toBe(true)
      }),
    ),
  )
  expect(sourceGuardInstalled(store, "/work")).toBe(false)
  expect(agent.model).toEqual(model)
  expect(agent).toHaveProperty("system", workerInstructions.trim())
  expect(agent.permissions).not.toContainEqual({
    action: "lz-worker-catalog",
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
      "lz-worker-catalog": {},
      "lz-plan-command": {},
    },
  }
  await Effect.runPromise(contextHook!(context as never))
  expect(delegationTool("subagent.list")).toBe(true)
  expect(delegationTool("lz-worker-catalog")).toBe(false)
  expect(Object.keys(context.tools)).toEqual(["read", "edit", "bash", "lz-worker-catalog"])
  await Effect.runPromise(
    executeHook!({
      sessionID: "worker",
      agent: Agent.ID.make("lazers-implementor"),
      tool: "bash",
    } as never),
  )
  await Effect.runPromise(
    executeHook!({
      sessionID: "worker",
      agent: Agent.ID.make("lazers-implementor"),
      tool: "lz-worker-catalog",
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

  quarantined = true
  activeAssignment = false
  for (const tool of ["edit", "bash", "execute"]) {
    await expect(
      Effect.runPromise(
        executeHook!({
          sessionID: "worker",
          agent: Agent.ID.make("lazers-implementor"),
          tool,
        } as never),
      ),
    ).rejects.toThrow("source workspace is quarantined")
  }
  for (const tool of [
    "read",
    "lz-get-task-instructions",
    "lz-verify-handoff",
    "lz-submit-handoff",
  ]) {
    await Effect.runPromise(
      executeHook!({
        sessionID: "worker",
        agent: Agent.ID.make("lazers-implementor"),
        tool,
      } as never),
    )
  }
})
