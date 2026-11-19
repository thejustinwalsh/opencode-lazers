import { expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import workerInstructions from "../implementor.md" with { type: "text" }
import { delegationTool, registerWorker } from "./roles.ts"
import type { RunnerStore } from "./store.ts"

test("worker personas retain read-only catalog access but cannot delegate", async () => {
  const model = { providerID: "custom-provider", id: "selected", variant: "deep" }
  const customRule = { action: "edit", resource: "protected/**", effect: "ask" }
  const externalRule = {
    action: "edit",
    resource: "/authorized/runntime/packages/runntime/src/zoo/**",
    effect: "ask",
  }
  const agent = { model, permissions: [customRule] as unknown[] }
  const auditor = { permissions: [externalRule] as unknown[], model: undefined as unknown }
  let contextHook: ((context: never) => Effect.Effect<void>) | undefined
  let executeHook: ((call: never) => Effect.Effect<void>) | undefined
  let activeAssignment = true
  const store = {
    repository: { path: "/synthetic/roles.sqlite", projectDirectory: "/work" },
    atomic: (run: (db: never) => unknown) =>
      run({
        query: () => ({
          get: () =>
            activeAssignment
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
            update: (id: string, update: (value: unknown) => void) =>
              update(id === "auditor" ? auditor : agent),
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
      }),
    ),
  )
  expect(auditor).toMatchObject({
    model: { providerID: "opencode-go", id: "muse-spark-1.3-contributor" },
    mode: "subagent",
    hidden: true,
  })
  expect(auditor).toHaveProperty("system", expect.stringContaining("lz-fallow-report"))
  expect(auditor).toHaveProperty("system", expect.stringContaining(workerInstructions.trim()))
  expect(agent.model).toEqual(model)
  expect(agent.permissions).toContainEqual({ action: "*", resource: "*", effect: "allow" })
  expect(agent.permissions).toContainEqual({ action: "read", resource: "*.env", effect: "ask" })
  expect(agent.permissions).toContainEqual(customRule)
  expect(auditor.permissions).toContainEqual(externalRule)
  for (const role of [agent, auditor]) {
    expect(role.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
    expect(role.permissions).toContainEqual({
      action: "lz-fallow-config-set",
      resource: "*",
      effect: "deny",
    })
  }
  expect(agent.permissions).toContainEqual({
    action: "lz-fallow-check",
    resource: "*",
    effect: "deny",
  })
  expect(auditor.permissions).not.toContainEqual({
    action: "lz-fallow-check",
    resource: "*",
    effect: "deny",
  })
  const permissionsBeforeReplay = structuredClone(agent.permissions)
  const auditorPermissionsBeforeReplay = structuredClone(auditor.permissions)
  await Effect.runPromise(Effect.scoped(registerWorker(ctx, store)))
  expect(agent.permissions).toEqual(permissionsBeforeReplay)
  expect(auditor.permissions).toEqual(auditorPermissionsBeforeReplay)
  expect(agent).toHaveProperty("system", workerInstructions.trim())
  expect(agent.permissions).not.toContainEqual({
    action: "lz-worker-catalog",
    resource: "*",
    effect: "deny",
  })
  const context = {
    sessionID: "ses_worker",
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
      sessionID: "ses_worker",
      agent: Agent.ID.make("lazers-implementor"),
      tool: "bash",
    } as never),
  )
  await Effect.runPromise(
    executeHook!({
      sessionID: "ses_worker",
      agent: Agent.ID.make("lazers-implementor"),
      tool: "lz-worker-catalog",
    } as never),
  )
  await expect(
    Effect.runPromise(
      executeHook!({
        sessionID: "ses_worker",
        agent: Agent.ID.make("lazers-implementor"),
        tool: "subagent.list",
      } as never),
    ),
  ).rejects.toThrow("Only the LAZERS runtime may dispatch agents")

  activeAssignment = false
  for (const tool of ["edit", "bash"]) {
    await expect(
      Effect.runPromise(
        executeHook!({
          sessionID: "ses_worker",
          agent: Agent.ID.make("lazers-implementor"),
          tool,
        } as never),
      ),
    ).rejects.toThrow("Implementor requires an admitted runtime assignment")
  }
})
