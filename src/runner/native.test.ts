import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { TaskRepository } from "../storage.ts"
import workerInstructions from "../implementor.md" with { type: "text" }
import { nativeHost } from "./native.ts"
import type { NativeInboxClient, NativeInboxDependencies } from "./native.ts"
import type { OutcomeInboxEntry, OutcomeOwnership } from "./inbox.ts"
import { registerWorker } from "./roles.ts"
import type { RunnerStore } from "./store.ts"

test("native worktrees use the host lifecycle with the admitted ref and returned directory", async () => {
  let removed: unknown
  let created: unknown
  let refreshed = false
  const host = nativeHost(
    {
      location: { directory: "/project", project: { id: "project" } },
      worktree: {
        create: (input: unknown) =>
          Effect.sync(() => {
            created = input
            return { directory: "/work/attempt-2" }
          }),
        refresh: () =>
          Effect.sync(() => {
            refreshed = true
          }),
        list: () => Effect.succeed([{ directory: "/work/attempt-2", strategy: "git" }]),
        remove: (input: unknown) =>
          Effect.sync(() => {
            removed = input
          }),
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  expect(await host.worktree({ directory: "/work/attempt", base: "a".repeat(40) })).toBe(
    "/work/attempt-2",
  )
  expect(created).toEqual({
    projectID: "project",
    from: "/project",
    directory: "/work",
    name: "attempt",
    branch: "a".repeat(40),
  })
  expect(await host.worktrees()).toEqual(["/work/attempt-2"])
  expect(refreshed).toBe(true)
  await host.removeWorktree("/work/attempt-2")
  expect(removed).toEqual({ projectID: "project", directory: "/work/attempt-2", force: false })
})

test("child prompt uses native move and verifies location before any model work", async () => {
  const calls: string[] = []
  let directory = "/parent"
  const host = nativeHost(
    {
      session: {
        get: () => Effect.sync(() => ({ location: { directory } })),
        instructions: { entry: { remove: () => Effect.void } },
        move: (_input: { directory: string }) =>
          Effect.sync(() => {
            calls.push("move")
          }),
        wait: () =>
          Effect.sync(() => {
            calls.push("wait")
            directory = "/worker"
          }),
        prompt: () =>
          Effect.sync(() => {
            calls.push("prompt")
            expect(directory).toBe("/worker")
          }),
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  await host.prompt({
    sessionID: "ses_worker",
    id: "msg_work",
    directory: "/worker",
    text: "Fetch the task and implement it.",
  })
  expect(calls).toEqual(["move", "wait", "prompt"])
  await host.prompt({
    sessionID: "ses_worker",
    id: "msg_next",
    directory: "/worker",
    text: "Continue.",
  })
  expect(calls).toEqual(["move", "wait", "prompt", "prompt"])
})

test("worker guidance teaches focused LAZERS discovery and optional progressive skill use", () => {
  expect(workerInstructions).toContain("lazers_project_index")
  expect(workerInstructions).toContain("lazers_project_read")
  expect(workerInstructions).toContain("optional\nnative skill")
  expect(workerInstructions).toContain("unavailable suggestion does not block")
  expect(workerInstructions).toContain("Do not launch subagents")
})

test("optional skills are not resolved, and only the legacy LAZERS entry is removed before prompting", async () => {
  const entries = new Map<string, unknown>([
    ["lazers-required-skills", "SECRET_SKILL_BODY_CANARY"],
    ["other-plugin", "keep this entry"],
  ])
  let prompts = 0
  let skillLists = 0
  let skillPermissions = 0
  let removals = 0
  const host = nativeHost(
    {
      skill: {
        list: () => {
          skillLists++
          throw new Error("A suggestion is unavailable")
        },
      },
      permission: {
        assert: () => {
          skillPermissions++
          throw new Error("Skill permission denied")
        },
      },
      session: {
        get: () => Effect.succeed({ location: { directory: "/worker" } }),
        instructions: {
          entry: {
            remove: (input: { key: string }) =>
              Effect.sync(() => {
                removals++
                expect(input.key).toBe("lazers-required-skills")
                entries.delete(input.key)
              }),
          },
        },
        prompt: () =>
          Effect.sync(() => {
            expect(entries.has("lazers-required-skills")).toBe(false)
            prompts++
          }),
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  const input = {
    sessionID: "ses_worker",
    id: "msg_worker",
    directory: "/worker",
    text: "Implement the task",
  }
  await host.prompt(input)
  await host.prompt(input)
  expect(entries).toEqual(new Map([["other-plugin", "keep this entry"]]))
  expect(removals).toBe(2)
  expect(skillLists).toBe(0)
  expect(skillPermissions).toBe(0)
  expect(prompts).toBe(2)
})

test("a host that fails to move the child cannot receive its work prompt", async () => {
  let prompted = false
  const host = nativeHost(
    {
      session: {
        get: () => Effect.succeed({ location: { directory: "/parent" } }),
        move: () => Effect.void,
        wait: () => Effect.void,
        prompt: () =>
          Effect.sync(() => {
            prompted = true
          }),
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  await expect(
    host.prompt({
      sessionID: "ses_worker",
      id: "msg_work",
      directory: "/worker",
      text: "Implement.",
    }),
  ).rejects.toThrow("assigned worktree")
  expect(prompted).toBe(false)
})

test("native worker selection survives role registration and reaches native creation unchanged", async () => {
  const model = { providerID: "custom-provider", id: "native-selected", variant: "deep" }
  const routes = [
    model,
    { providerID: "opencode-go", id: "qwen3.8-flash", variant: "xhigh" },
    { providerID: "private-provider", id: "missing-capability-metadata", variant: "max" },
    { providerID: "custom-provider", id: "empty-variant-route", variant: "" },
  ]
  const agent = { model, permissions: [] }
  const created: { model: unknown }[] = []
  let catalogReads = 0
  let fail = false
  const ctx = {
    agent: {
      get: () => Effect.succeed({ data: agent }),
      transform: (transform: (editor: unknown) => void) =>
        Effect.sync(() =>
          transform({
            update: (_id: string, update: (value: typeof agent) => void) => update(agent),
          }),
        ),
    },
    model: {
      list: () =>
        Effect.sync(() => {
          catalogReads++
          return {
            data: [
              {
                providerID: "opencode-go",
                id: "qwen3.8-flash",
                enabled: false,
                capabilities: { tools: false, input: ["text"], output: ["text"] },
              },
              {
                providerID: "private-provider",
                id: "missing-capability-metadata",
                enabled: true,
              },
            ],
          }
        }),
    },
    session: {
      hook: () => Effect.void,
      create: (input: { model: unknown }) =>
        Effect.sync(() => {
          if (fail) throw new Error("Native route error")
          created.push(input)
        }),
    },
    tool: { hook: () => Effect.void },
  } as unknown as Plugin.Context
  await Effect.runPromise(Effect.scoped(registerWorker(ctx, {} as RunnerStore)))
  const host = nativeHost(ctx, {} as TaskRepository)
  for (const [index, route] of routes.entries()) {
    agent.model = route
    expect(await host.workerModel!()).toEqual(route)
    await host.create({
      id: `ses_child_${index}`,
      parentID: "ses_owner",
      agent: "lazers-implementor",
      model: route,
      directory: "/work",
      title: "task",
      attemptID: "attempt",
    })
  }
  expect(created.map(({ model: selected }) => selected)).toEqual(routes)
  // Catalog metadata is advice; native create forwards each selected route directly.
  expect(catalogReads).toBe(0)
  fail = true
  await expect(
    host.create({
      id: "ses_child",
      parentID: "ses_owner",
      agent: "lazers-implementor",
      model,
      directory: "/work",
      title: "task",
      attemptID: "attempt",
    }),
  ).rejects.toThrow("Native route error")
  expect(created).toHaveLength(routes.length)
})

function nativeOutcomeFixture(options: {
  pid?: number
  unavailable?: boolean
  inbox?: OutcomeInboxEntry[]
  onCancel?: (inboxID: string) => void
  onSynthetic?: (input: unknown) => void
}) {
  const entries = options.inbox ?? []
  let listCalls = 0
  const client = {
    server: { info: async () => ({ pid: options.pid ?? 42, version: "2.2.5" }) },
    session: {
      get: async () => ({ projectID: "project", agent: "architect" }),
      synthetic: async (input: unknown) => options.onSynthetic?.(input),
      inbox: {
        list: async () => {
          listCalls++
          return entries.map((entry) => ({
            id: entry.id,
            sessionID: "ses_owner",
            time: { created: 1 },
            type: entry.type,
            delivery: entry.delivery,
            payload: { text: "fixture", ...(entry.metadata ? { metadata: entry.metadata } : {}) },
          }))
        },
        cancel: async (input: { inboxID: string }) => {
          options.onCancel?.(input.inboxID)
          const index = entries.findIndex((entry) => entry.id === input.inboxID)
          if (index >= 0) entries.splice(index, 1)
        },
      },
    },
  } as unknown as NativeInboxClient
  const dependencies = {
    discover: async () =>
      options.unavailable ? undefined : { url: "https://opencode.localhost", auth: undefined },
    make: () => client,
    processID: () => 42,
  } as NativeInboxDependencies
  const host = nativeHost(
    {
      app: { version: "2.2.5" },
      location: { project: { id: "project" } },
    } as unknown as Plugin.Context,
    { projectDirectory: "/project" } as TaskRepository,
    dependencies,
  )
  return {
    host,
    entries,
    get listCalls() {
      return listCalls
    },
  }
}

const ownership: OutcomeOwnership = {
  lazersKind: "runner-outcome",
  lazersProjectID: "project",
  lazersProjectDirectory: "/project",
  lazersPlanID: "plan-1",
  lazersOutboxID: "outbox-1",
  lazersMessageID: "msg_durable",
  lazersSessionID: "ses_owner",
  lazersStatus: "accepted",
  lazersVersion: 7,
}

test("actionable notifications use the authenticated native client with durable ownership", async () => {
  let received: unknown
  const { host } = nativeOutcomeFixture({ onSynthetic: (input) => (received = input) })
  await host.notify({
    sessionID: "ses_owner",
    id: "msg_durable",
    text: "Review accepted artifact now",
    resume: true,
    metadata: ownership,
  })
  expect(received).toEqual({
    sessionID: "ses_owner",
    id: "msg_durable",
    text: "Review accepted artifact now",
    metadata: ownership,
    resume: true,
    delivery: "queue",
    description: "LAZERS task outcome",
  })
})

test("native cancellation rechecks exact ownership and preserves user, worker, and foreign inputs", async () => {
  const user: OutcomeInboxEntry = { id: "msg_user", type: "user", delivery: "queue" }
  const worker: OutcomeInboxEntry = {
    id: "msg_worker",
    type: "synthetic",
    delivery: "queue",
    metadata: { lazersKind: "worker-prompt" },
  }
  const foreign: OutcomeInboxEntry = {
    id: "msg_foreign",
    type: "synthetic",
    delivery: "queue",
    metadata: { ...ownership, lazersPlanID: "foreign-plan", lazersMessageID: "msg_foreign" },
  }
  const owned: OutcomeInboxEntry = {
    id: ownership.lazersMessageID,
    type: "synthetic",
    delivery: "queue",
    metadata: ownership,
  }
  const cancelled: string[] = []
  const fixture = nativeOutcomeFixture({
    inbox: [user, worker, foreign, owned],
    onCancel: (id) => cancelled.push(id),
  })
  expect(await fixture.host.outcomeInbox!("ses_owner")).toHaveLength(4)
  await fixture.host.cancelOutcome!({
    sessionID: "ses_owner",
    inboxID: owned.id,
    ownership,
  })
  expect(cancelled).toEqual([owned.id])
  expect(fixture.entries).toEqual([user, worker, foreign])
  await expect(
    fixture.host.cancelOutcome!({ sessionID: "ses_owner", inboxID: user.id, ownership }),
  ).rejects.toThrow("mismatched durable ownership")
  expect(cancelled).toEqual([owned.id])
})

test("native inbox refuses a discovered service owned by another process", async () => {
  const fixture = nativeOutcomeFixture({ pid: 900 })
  await expect(fixture.host.outcomeInbox!("ses_owner")).rejects.toThrow(
    "not this OpenCode host process",
  )
  expect(fixture.listCalls).toBe(0)
})

test("native inbox does not start or substitute an unavailable service", async () => {
  const fixture = nativeOutcomeFixture({ unavailable: true })
  await expect(fixture.host.outcomeInbox!("ses_owner")).rejects.toThrow(
    "Native outcome inbox is unavailable",
  )
  expect(fixture.listCalls).toBe(0)
})

test("native session heartbeat reads metadata without context and opts into messages explicitly", async () => {
  let contextReads = 0
  const now = DateTime.nowUnsafe()
  const host = nativeHost(
    {
      session: {
        get: () =>
          Effect.succeed({
            id: "ses_worker",
            parentID: "ses_owner",
            projectID: "project",
            agent: "lazers-implementor",
            metadata: {},
            location: { directory: "/worker" },
            time: { busy: now, idle: now, archived: undefined },
            tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
            model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
            outcome: "succeeded",
          }),
        context: () => {
          contextReads++
          return Effect.succeed([
            { id: "msg_user", type: "user", text: "Implement it" },
            {
              id: "msg_done",
              type: "assistant",
              content: [
                { type: "tool", name: "edit", state: "completed" },
                { type: "text", text: "Done" },
              ],
            },
          ])
        },
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )

  const heartbeat = await host.session("ses_worker")
  expect(contextReads).toBe(0)
  expect(heartbeat?.tokens).toBe(20)
  expect(heartbeat?.tools).toBe(0)
  expect(heartbeat?.messages).toEqual([])

  const detailed = await host.session("ses_worker", { messages: true })
  expect(contextReads).toBe(1)
  expect(detailed?.tools).toBe(1)
  expect(detailed?.messages).toEqual([
    { id: "msg_user", text: "Implement it" },
    { id: "msg_done", text: "Done" },
  ])
})
