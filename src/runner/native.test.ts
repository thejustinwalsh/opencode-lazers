import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { TaskRepository } from "../storage.ts"
import workerInstructions from "../implementor.md" with { type: "text" }
import { nativeHost } from "./native.ts"
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

test("scope instructions use native durable keyed entries with lost-reply recovery and no model work", async () => {
  const entries = new Map<string, unknown>([["other-plugin", "preserve"]])
  let puts = 0
  let loseReply = true
  const host = nativeHost(
    {
      location: { project: { id: "project" } },
      session: {
        get: () =>
          Effect.succeed({
            id: "ses_worker",
            agent: "lazers-implementor",
            projectID: "project",
            location: { directory: "/worker" },
            metadata: { lazersAttemptID: "attempt" },
            time: {},
          }),
        instructions: {
          entry: {
            list: () => Effect.sync(() => [...entries].map(([key, value]) => ({ key, value }))),
            put: (input: { sessionID: string; key: string; value: unknown }) =>
              Effect.sync(() => {
                expect(input.sessionID).toBe("ses_worker")
                puts++
                entries.set(input.key, input.value)
                if (loseReply) throw new Error("Lost native put response")
              }),
          },
        },
        prompt: () => {
          throw new Error("Must not prompt")
        },
        synthetic: () => {
          throw new Error("Must not enqueue input")
        },
        move: () => {
          throw new Error("Must not move")
        },
        interrupt: () => {
          throw new Error("Must not interrupt")
        },
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  const input = {
    sessionID: "ses_worker",
    projectID: "project",
    directory: "/worker",
    attemptID: "attempt",
    key: "lazers-scope-attempt-authorization",
    text: "Reviewed additive execution scope; original checks still apply.",
  }
  await expect(host.updateInstruction(input)).rejects.toThrow("Lost native put response")
  loseReply = false
  await host.updateInstruction(input)
  await host.updateInstruction(input)
  expect(puts).toBe(1)
  expect(entries.get("other-plugin")).toBe("preserve")
  expect(entries.get(input.key)).toBe(input.text)
})

test("scope instruction ownership rejects foreign, moved, replaced and archived targets before native mutation", async () => {
  for (const mismatch of [
    "session",
    "agent",
    "project",
    "directory",
    "attempt",
    "archived",
    "host-project",
  ]) {
    let instructionCalls = 0
    const host = nativeHost(
      {
        location: { project: { id: mismatch === "host-project" ? "foreign" : "project" } },
        session: {
          get: () =>
            Effect.succeed({
              id: mismatch === "session" ? "ses_foreign" : "ses_worker",
              agent: mismatch === "agent" ? "architect" : "lazers-implementor",
              projectID: mismatch === "project" ? "foreign" : "project",
              location: { directory: mismatch === "directory" ? "/elsewhere" : "/worker" },
              metadata: { lazersAttemptID: mismatch === "attempt" ? "replaced" : "attempt" },
              time: mismatch === "archived" ? { archived: DateTime.nowUnsafe() } : {},
            }),
          instructions: {
            entry: {
              list: () =>
                Effect.sync(() => {
                  instructionCalls++
                  return []
                }),
              put: () =>
                Effect.sync(() => {
                  instructionCalls++
                }),
            },
          },
        },
      } as unknown as Plugin.Context,
      {} as TaskRepository,
    )
    await expect(
      host.updateInstruction({
        sessionID: "ses_worker",
        projectID: "project",
        directory: "/worker",
        attemptID: "attempt",
        key: "scope",
        text: "Allow test",
      }),
    ).rejects.toThrow("owned worker attempt")
    expect(instructionCalls).toBe(0)
  }
})

test("scope instructions require matching readback rather than trusting a successful native reply", async () => {
  let puts = 0
  const host = nativeHost(
    {
      location: { project: { id: "project" } },
      session: {
        get: () =>
          Effect.succeed({
            id: "ses_worker",
            agent: "lazers-implementor",
            projectID: "project",
            location: { directory: "/worker" },
            metadata: { lazersAttemptID: "attempt" },
            time: {},
          }),
        instructions: {
          entry: {
            list: () => Effect.succeed([{ key: "scope", value: "old value" }]),
            put: () =>
              Effect.sync(() => {
                puts++
              }),
          },
        },
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  await expect(
    host.updateInstruction({
      sessionID: "ses_worker",
      projectID: "project",
      directory: "/worker",
      attemptID: "attempt",
      key: "scope",
      text: "Allow test",
    }),
  ).rejects.toThrow("no native readback")
  expect(puts).toBe(1)
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

test("actionable notifications use native queued synthetic resume with the durable message identity", async () => {
  let received: unknown
  const host = nativeHost(
    {
      session: {
        synthetic: (input: unknown) =>
          Effect.sync(() => {
            received = input
          }),
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  await host.notify({
    sessionID: "ses_owner",
    id: "msg_durable",
    text: "Review accepted artifact now",
    resume: true,
  })
  expect(received).toEqual({
    sessionID: "ses_owner",
    id: "msg_durable",
    text: "Review accepted artifact now",
    resume: true,
    delivery: "queue",
    description: "LAZERS task outcome",
  })
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
