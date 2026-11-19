import { expect, test } from "bun:test"
import { Effect } from "effect"
import { registerDelegatedAgentCapacity } from "./delegated-agent-capacity-rpc.ts"
import type { DelegatedAgentStatus } from "./delegated-agent-capacity.ts"

type RegisteredMethods = {
  read(input: unknown): Effect.Effect<unknown>
  configure(input: unknown): Effect.Effect<unknown>
}
type SessionActor = {
  id: string
  projectID: string
  agent: string
  time: { archived?: number }
}

function fixture(
  options: {
    denied?: boolean
    afterPermission?: (actor: SessionActor) => void
  } = {},
) {
  let actor: SessionActor | undefined = {
    id: "ses-architect",
    projectID: "project",
    agent: "architect",
    time: {},
  }
  let methods: RegisteredMethods | undefined
  let settings: DelegatedAgentStatus = {
    projectDirectory: "/canonical/project",
    revision: 0,
    limit: 3,
    active: 0,
    queued: 0,
    reason: null,
  }
  const permissionCalls: unknown[] = []
  const configureCalls: unknown[] = []
  let settingsReads = 0
  const rpc = {
    register: (_definition: unknown, handlers: RegisteredMethods) => {
      methods = handlers
      return Effect.succeed({
        dispose: Effect.void,
        events: { emit: () => Effect.void },
      })
    },
  }
  const context = {
    rpc,
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        actor?.id === sessionID
          ? Effect.succeed(actor)
          : Effect.fail(Object.assign(new Error("missing"), { _tag: "SessionNotFoundError" })),
    },
    permission: {
      assert: (input: unknown) => {
        permissionCalls.push(input)
        if (actor) options.afterPermission?.(actor)
        return options.denied ? Effect.fail(new Error("native permission denied")) : Effect.void
      },
    },
  }
  const runtime = {
    projectID: "project",
    store: { repository: { projectDirectory: "/canonical/project" } },
    delegatedAgentCapacity: {
      settings: async () => {
        settingsReads += 1
        return settings
      },
      configure: async (input: { expectedRevision: number; limit: number }) => {
        configureCalls.push(input)
        if (input.expectedRevision !== settings.revision)
          return {
            status: "conflict" as const,
            expectedRevision: input.expectedRevision,
            currentRevision: settings.revision,
            current: {
              projectDirectory: settings.projectDirectory,
              revision: settings.revision,
              limit: settings.limit,
            },
          }
        settings = { ...settings, revision: settings.revision + 1, limit: input.limit }
        return {
          status: "updated" as const,
          settings: {
            projectDirectory: settings.projectDirectory,
            revision: settings.revision,
            limit: settings.limit,
          },
        }
      },
    },
  }
  const ready = Effect.runPromise(
    Effect.scoped(registerDelegatedAgentCapacity(context as never, runtime as never)),
  )
  return {
    ready,
    get methods() {
      if (!methods) throw new Error("RPC was not registered")
      return methods
    },
    permissionCalls,
    configureCalls,
    get settingsReads() {
      return settingsReads
    },
    setActor(next: SessionActor | undefined) {
      actor = next
    },
  }
}

const run = (effect: Effect.Effect<unknown>) => Effect.runPromise(effect)

test("registered capacity RPC defaults to three and validates revisioned positive-integer writes", async () => {
  const f = fixture()
  await f.ready
  expect(await run(f.methods.read({ sessionID: "ses-architect" }))).toEqual({
    projectDirectory: "/canonical/project",
    revision: 0,
    limit: 3,
    active: 0,
    queued: 0,
    reason: null,
  })
  expect(f.permissionCalls).toEqual([
    {
      sessionID: "ses-architect",
      agent: "architect",
      action: "lz-get-agent-capacity",
      resources: ["/canonical/project"],
    },
  ])

  const write = (input: unknown) => run(f.methods.configure(input))
  for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await expect(
      write({ sessionID: "ses-architect", expectedRevision: 0, limit }),
    ).rejects.toThrow()
  await expect(
    write({ sessionID: "ses-architect", expectedRevision: -1, limit: 2 }),
  ).rejects.toThrow()
  await expect(
    write({
      sessionID: "ses-architect",
      expectedRevision: 0,
      limit: 2,
      projectDirectory: "/different/project",
    }),
  ).rejects.toThrow()
  expect(f.configureCalls).toEqual([])

  expect(await write({ sessionID: "ses-architect", expectedRevision: 0, limit: 4 })).toMatchObject({
    status: "updated",
    settings: { revision: 1, limit: 4 },
  })
  expect(await write({ sessionID: "ses-architect", expectedRevision: 0, limit: 2 })).toMatchObject({
    status: "conflict",
    expectedRevision: 0,
    currentRevision: 1,
  })
})

test("registered capacity writes require live project permission and revalidate the session after authorization", async () => {
  const denied = fixture({ denied: true })
  await denied.ready
  await expect(
    run(
      denied.methods.configure({
        sessionID: "ses-architect",
        expectedRevision: 0,
        limit: 4,
      }),
    ),
  ).rejects.toThrow("native permission denied")
  expect(denied.configureCalls).toEqual([])
  expect(denied.settingsReads).toBe(0)

  const changed = fixture({
    afterPermission: (actor) => {
      actor.projectID = "other-project"
    },
  })
  await changed.ready
  await expect(
    run(
      changed.methods.configure({
        sessionID: "ses-architect",
        expectedRevision: 0,
        limit: 4,
      }),
    ),
  ).rejects.toThrow("scope is unavailable")
  expect(changed.configureCalls).toEqual([])
})

test("registered capacity read rejects archived, missing, and cross-project sessions", async () => {
  const f = fixture()
  await f.ready
  const read = (sessionID: string) => run(f.methods.read({ sessionID }))
  f.setActor({ id: "ses-architect", projectID: "other-project", agent: "architect", time: {} })
  await expect(read("ses-architect")).rejects.toThrow("scope is unavailable")
  f.setActor({
    id: "ses-architect",
    projectID: "project",
    agent: "architect",
    time: { archived: 1 },
  })
  await expect(read("ses-architect")).rejects.toThrow("scope is unavailable")
  f.setActor(undefined)
  await expect(read("ses-architect")).rejects.toThrow("scope is unavailable")
  expect(f.settingsReads).toBe(0)
})
