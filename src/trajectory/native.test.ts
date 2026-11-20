import { expect, test } from "bun:test"
import { assertHostListQuery } from "../../test/host-list-fake.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, DateTime } from "effect"
import { nativeTrajectoryHost } from "./native.ts"
import type { HostMessageClient } from "../core/host-messages.ts"

/** The host's message list: pages of `pageSize` over `history`, every read pushed to `reads`. */
function messageClient(
  reads: string[],
  options: { history?: unknown[]; fail?: Error; label?: string } = {},
) {
  return {
    message: {
      list: async (input: {
        sessionID: string
        limit?: number
        cursor?: string
        order?: string
      }) => {
        assertHostListQuery(input)
        reads.push(`${options.label ?? "messages"}:${input.sessionID}`)
        if (options.fail) throw options.fail
        const all = options.history ?? []
        const limit = input.limit ?? 50
        const start = input.cursor ? Number(input.cursor) : 0
        const next = start + limit < all.length ? String(start + limit) : undefined
        return { data: all.slice(start, start + limit), cursor: { ...(next ? { next } : {}) } }
      },
    },
  } as unknown as HostMessageClient
}

const sessionRecord = (projectID = "project") => ({
  id: "ses-owned",
  projectID,
  parentID: "ses-owner",
  model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
  outcome: "succeeded",
  time: {
    created: DateTime.nowUnsafe(),
    updated: DateTime.nowUnsafe(),
    busy: undefined,
    idle: DateTime.nowUnsafe(),
  },
  tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 4, write: 1 } },
})

test("native adapter reads only the owned session context and projects public times/usage", async () => {
  const calls: string[] = []
  const host = nativeTrajectoryHost(
    {
      session: {
        get: (input: { sessionID: string }) =>
          Effect.sync(() => {
            calls.push(`get:${input.sessionID}`)
            return sessionRecord()
          }),
      },
    } as unknown as Plugin.Context,
    "project",
    undefined,
    messageClient(calls),
  )
  const result = await host.session("ses-owned")
  expect(calls).toEqual(["get:ses-owned", "messages:ses-owned"])
  expect(result?.projectID).toBe("project")
  expect(result?.model).toEqual({ providerID: "openai", id: "gpt-6-luna", variant: "max" })
  expect(result?.tokens).toEqual({
    input: 12,
    output: 3,
    reasoning: 2,
    cache: { read: 4, write: 1 },
  })
  expect(result?.time.created).toBeGreaterThan(0)
  expect(result?.messages).toEqual([])
})

test("native adapter refuses a foreign project before reading its transcript", async () => {
  const calls: string[] = []
  const host = nativeTrajectoryHost(
    {
      session: {
        get: () =>
          Effect.sync(() => {
            calls.push("get")
            return sessionRecord("foreign-project")
          }),
      },
    } as unknown as Plugin.Context,
    "project",
    undefined,
    messageClient(calls),
  )
  await expect(host.session("ses-owned")).rejects.toThrow("outside this project")
  expect(calls).toEqual(["get"])
})

test("a retained worker can be inspected after its recorded workspace changes project ID", async () => {
  const attempt = { id: "retained-attempt", workspace: "/repo.worktrees/worker" }
  const session = {
    ...sessionRecord("old-project"),
    agent: "lazers-implementor",
    location: { directory: attempt.workspace },
    metadata: { lazersAttemptID: attempt.id },
  }
  let currentWorkspace = true
  const reads: string[] = []
  let locationReads = 0
  const host = nativeTrajectoryHost(
    {
      session: {
        get: () => Effect.succeed(session),
      },
    } as unknown as Plugin.Context,
    "project",
    (directory) => {
      locationReads++
      return currentWorkspace && directory === attempt.workspace
    },
    messageClient(reads),
  )

  await expect(host.session("ses-owned", { ...attempt, id: "different-attempt" })).rejects.toThrow(
    "outside this project",
  )
  await expect(host.session("ses-owned", { ...attempt, workspace: "/other" })).rejects.toThrow(
    "outside this project",
  )
  expect(locationReads).toBe(0)
  currentWorkspace = false
  await expect(host.session("ses-owned", attempt)).rejects.toThrow("outside this project")
  expect(reads).toHaveLength(0)

  currentWorkspace = true
  expect(await host.status!("ses-owned", attempt)).toMatchObject({
    projectID: "project",
    messageStatus: "not-read",
  })
  expect(reads).toHaveLength(0)
  expect(await host.session("ses-owned", attempt)).toMatchObject({
    projectID: "project",
    messages: [],
  })
  expect(reads).toHaveLength(1)
})

test("lightweight native status reads current session facts without loading context", async () => {
  const calls: string[] = []
  const host = nativeTrajectoryHost(
    {
      session: {
        get: ({ sessionID }: { sessionID: string }) =>
          Effect.sync(() => {
            calls.push(`get:${sessionID}`)
            return sessionRecord()
          }),
      },
    } as unknown as Plugin.Context,
    "project",
    undefined,
    messageClient(calls),
  )
  const status = await host.status!("ses-owned")
  expect(calls).toEqual(["get:ses-owned"])
  expect(status?.messageStatus).toBe("not-read")
  expect(status?.messages).toBeNull()
  expect(status?.tokens?.input).toBe(12)
  expect(status?.model?.id).toBe("gpt-6-luna")
})

test("lightweight status rejects a foreign session before returning live metadata", async () => {
  const calls: string[] = []
  const host = nativeTrajectoryHost(
    {
      session: {
        get: () =>
          Effect.sync(() => {
            calls.push("get")
            return sessionRecord("foreign-project")
          }),
      },
    } as unknown as Plugin.Context,
    "project",
    undefined,
    messageClient(calls),
  )
  await expect(host.status!("ses-owned")).rejects.toThrow("outside this project")
  expect(calls).toEqual(["get"])
})

test("native context access failures remain explicit and redact credentials", async () => {
  const host = nativeTrajectoryHost(
    {
      session: {
        get: () => Effect.succeed(sessionRecord()),
      },
    } as unknown as Plugin.Context,
    "project",
    undefined,
    messageClient([], { fail: new Error("Authorization: Bearer native-secret-value") }),
  )
  const result = await host.session("ses-owned")
  expect(result?.messageStatus).toBe("unavailable")
  expect(result?.messageError).toContain("[REDACTED]")
  expect(result?.messageError).not.toContain("native-secret-value")
})

test("a long transcript is paged in, bounded, and flagged one past the bound", async () => {
  const reads: string[] = []
  const history = Array.from({ length: 10_050 }, (_, index) => ({ id: `m${index}`, type: "user" }))
  const host = nativeTrajectoryHost(
    { session: { get: () => Effect.succeed(sessionRecord()) } } as unknown as Plugin.Context,
    "project",
    undefined,
    messageClient(reads, { history }),
  )
  const result = await host.session("ses-owned")
  // One past the 10,000 bound, so the report can say it is truncated; 50 per page.
  expect(result?.messages).toHaveLength(10_001)
  expect(reads).toHaveLength(Math.ceil(10_001 / 50))
})
