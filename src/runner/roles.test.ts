import { expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, Queue, Stream } from "effect"
import workerInstructions from "../implementor.md" with { type: "text" }
import { delegationTool, registerWorker } from "./roles.ts"
import type { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
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

test("registered native helper hooks admit only LAZERS parents and bind failed children by identity", async () => {
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const admitted: unknown[] = []
  const createdBindings: unknown[] = []
  const childBindings: Array<{ requestID: string; sessionID: string }> = []
  const releasedChildren: string[] = []
  let schedulerWakes = 0
  let resolveCreatedBinding!: () => void
  const createdBinding = new Promise<void>((resolve) => {
    resolveCreatedBinding = resolve
  })
  let resolveChildWait!: () => void
  const childWait = new Promise<void>((resolve) => {
    resolveChildWait = resolve
  })
  let resolveChildRelease!: () => void
  const childRelease = new Promise<void>((resolve) => {
    resolveChildRelease = resolve
  })
  let resolveSchedulerWake!: () => void
  const schedulerWake = new Promise<void>((resolve) => {
    resolveSchedulerWake = resolve
  })
  let beforeHook: ((call: never) => Effect.Effect<void>) | undefined
  let afterHook: ((call: never) => Effect.Effect<void>) | undefined
  const capacity = {
    admittedNativeExecutions: async () => [],
    nativeExecution: async (sessionID: string) => ({
      id: "native-admission",
      sessionID,
      createdAt: 0,
    }),
    isLazersNativeParent: async (sessionID: string) => sessionID === "lazers-parent",
    ensureNativeQueued: async (input: unknown) => {
      admitted.push(input)
      return "native-admission"
    },
    waitForNative: async () => {},
    bindNativeChildFromCreatedSession: async (input: unknown) => {
      createdBindings.push(input)
      resolveCreatedBinding()
      return "native-admission"
    },
    nativeRequest: async () => ({ id: "native-admission" }),
    bindNativeChild: async (requestID: string, sessionID: string) => {
      childBindings.push({ requestID, sessionID })
      return true
    },
    releaseNativeRequest: async () => {
      if (releasedChildren.length) return false
      releasedChildren.push("ses_child-helper")
      resolveChildRelease()
      return true
    },
  } as unknown as DelegatedAgentCapacity
  const store = {
    repository: { path: "/synthetic/roles-capacity.sqlite", projectDirectory: "/work" },
    atomic: (run: (db: never) => unknown) =>
      run({
        query: () => ({ get: () => null }),
      } as never),
  } as unknown as RunnerStore
  const ctx = {
    agent: {
      transform: (transform: (editor: unknown) => void) =>
        Effect.sync(() =>
          transform({
            update: () => {},
          }),
        ),
    },
    event: {
      subscribe: () => Stream.fromQueue(eventQueue),
    },
    session: {
      hook: () => Effect.void,
      get: () => Effect.succeed({ time: { busy: DateTime.makeUnsafe(1000) } }),
      wait: () => Effect.promise(() => childWait),
    },
    tool: {
      hook: (name: string, callback: (call: never) => Effect.Effect<void>) => {
        if (name === "execute.before") beforeHook = callback
        if (name === "execute.after") afterHook = callback
        return Effect.void
      },
    },
  } as unknown as Plugin.Context

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerWorker(ctx, store, undefined, capacity, () => {
          schedulerWakes++
          resolveSchedulerWake()
        })
        yield* beforeHook!({
          sessionID: "external-parent",
          agent: Agent.ID.make("research"),
          tool: "subagent",
          id: "external-call",
          input: { agent: "research", description: "external helper" },
        } as never)
        expect(admitted).toHaveLength(0)

        yield* beforeHook!({
          sessionID: "lazers-parent",
          agent: Agent.ID.make("architect"),
          tool: "subagent",
          id: "native-call",
          input: { agent: "research", description: "background helper", background: true },
        } as never)
        expect(admitted).toEqual([
          {
            parentSessionID: "lazers-parent",
            toolCallID: "native-call",
            agent: "research",
            description: "background helper",
          },
        ])

        yield* Queue.offer(eventQueue, {
          type: "session.created",
          data: {
            sessionID: "ses_child-helper",
            parentID: "lazers-parent",
            agent: "research",
            title: "background helper",
          },
        })
        yield* Effect.promise(() => createdBinding)
        expect(createdBindings).toEqual([
          {
            sessionID: "ses_child-helper",
            parentSessionID: "lazers-parent",
            agent: "research",
            description: "background helper",
          },
        ])

        yield* afterHook!({
          sessionID: "lazers-parent",
          agent: Agent.ID.make("architect"),
          tool: "subagent",
          id: "native-call",
          input: { agent: "research", description: "background helper", background: true },
          status: "error",
          error: { message: "Subagent failed (sessionID: ses_child-helper): helper failed" },
        } as never)
        expect(childBindings).toEqual([
          { requestID: "native-admission", sessionID: "ses_child-helper" },
        ])
        yield* Queue.offer(eventQueue, {
          type: "session.execution.interrupted",
          data: { sessionID: "ses_child-helper" },
        })
        resolveChildWait()
        yield* Effect.promise(() => childRelease)
        yield* Effect.promise(() => schedulerWake)
        expect(releasedChildren).toEqual(["ses_child-helper"])
        expect(schedulerWakes).toBe(1)
        yield* beforeHook!({
          sessionID: "fresh-architect-with-no-plan",
          agent: Agent.ID.make("architect"),
          tool: "subagent",
          id: "fresh-call",
          input: { agent: "research", description: "pre-plan research" },
        } as never)
        expect(admitted).toHaveLength(2)
      }),
    ),
  )
})
