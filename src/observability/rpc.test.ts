import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Fiber, Stream } from "effect"
import { ObservationReads } from "./read.ts"
import { registerObservability } from "./rpc.ts"
import { sharedScheduler } from "../runner/scheduler-coordinator.ts"
import { makeFixture, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"

test.each([false, true])(
  "durable writes publish without idle scans and recover delivery loss=%s",
  async (loseDelivery) => {
    const fixture = makeFixture()
    const changes: Array<{ cause: string; resnapshotRequired: boolean }> = []
    let failed = false
    const reads = new ObservationReads(
      fixture.store,
      { session: async (id) => fixture.host.session(id) },
      "project",
      new Uint8Array(32).fill(12),
    )
    const ctx = {
      rpc: {
        register: () =>
          Effect.succeed({
            dispose: Effect.void,
            events: {
              emit: (_name: string, change: { cause: string; resnapshotRequired: boolean }) =>
                Effect.sync(() => {
                  if (loseDelivery && !failed) {
                    failed = true
                    throw new Error("notification delivery failed")
                  }
                  changes.push(change)
                }),
            },
          }),
      },
      event: { subscribe: () => Stream.never },
    } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerObservability(ctx, reads, "project")
            yield* Effect.sleep(20)
            expect(changes).toEqual([])
            expect(() =>
              fixture.store.atomic((db) => {
                db.query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?").run(
                  firstAttemptID,
                )
                throw new Error("rollback")
              }),
            ).toThrow("rollback")
            yield* Effect.sleep(20)
            expect(changes).toEqual([])
            fixture.store.atomic((db) =>
              db
                .query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?")
                .run(firstAttemptID),
            )
            yield* Effect.promise(async () => {
              for (let i = 0; i < 400 && !changes.length; i++) await Bun.sleep(5)
            })
            expect(changes).toMatchObject([
              { cause: loseDelivery ? "gap" : "runner", resnapshotRequired: loseDelivery },
            ])
            yield* Effect.sleep(1_050)
            expect(changes).toHaveLength(1)
          }),
        ),
      )
    } finally {
      fixture.close()
    }
  },
)

test("history cache hits remain permission-first and continuation data stays scoped", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(2)
  let denied = false
  let foreignProject = false
  let contextReads = 0
  const permissionCalls: string[] = []
  const reads = new ObservationReads(
    fixture.store,
    {
      session: async (id) => {
        contextReads++
        return fixture.host.session(id)
      },
      status: async (id) => {
        const session = fixture.sessions.get(id)
        return session
          ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
          : null
      },
    },
    "project",
    secret,
  )
  let handlers:
    | {
        trajectoryHistory(
          input: unknown,
          context: {
            error(type: string, message: string, data: unknown): unknown
          },
        ): Effect.Effect<unknown, unknown>
        trajectoryStatus(input: unknown): Effect.Effect<unknown>
      }
    | undefined
  const rpcContext = {
    error: (type: string, message: string, data: unknown) => ({ type, message, data }),
  }
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: typeof handlers) => {
        handlers = methods
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed({
          id: sessionID,
          projectID: foreignProject ? "foreign-project" : "project",
          agent: "architect",
          time: { archived: undefined },
        }),
    },
    permission: {
      assert: (input: { action: string }) => {
        permissionCalls.push(input.action)
        return denied ? Effect.fail(new Error("native permission denied")) : Effect.void
      },
    },
    event: { subscribe: () => Stream.empty },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )
    const scope = { kind: "project" as const, sessionID: "ses-owner" }
    const first = (await Effect.runPromise(
      handlers!.trajectoryHistory({ scope, taskID, limit: 2 }, rpcContext),
    )) as {
      report: { trajectory: { events: unknown[]; nextCursor: string | null } }
      eventIDs: string[]
    }
    expect(first.report.trajectory.events).toHaveLength(2)
    expect(first.report.trajectory.nextCursor).not.toBeNull()
    expect(contextReads).toBe(2)

    denied = true
    await expect(
      Effect.runPromise(
        handlers!.trajectoryHistory(
          {
            scope,
            taskID,
            limit: 2,
            cursor: first.report.trajectory.nextCursor,
          },
          rpcContext,
        ),
      ),
    ).rejects.toThrow("native permission denied")
    expect(contextReads).toBe(2)
    denied = false

    const second = (await Effect.runPromise(
      handlers!.trajectoryHistory(
        {
          scope,
          taskID,
          limit: 2,
          cursor: first.report.trajectory.nextCursor,
        },
        rpcContext,
      ),
    )) as { report: { trajectory: { page: number; events: unknown[] } } }
    expect(second.report.trajectory.page).toBe(2)
    expect(second.report.trajectory.events).toHaveLength(2)
    expect(contextReads).toBe(2)

    const originalCursor = first.report.trajectory.nextCursor!
    const tamperedCursor = `${originalCursor.slice(0, -1)}${originalCursor.endsWith("A") ? "B" : "A"}`
    await expect(
      Effect.runPromise(
        handlers!.trajectoryHistory(
          { scope, taskID, limit: 2, cursor: tamperedCursor },
          rpcContext,
        ),
      ),
    ).rejects.toMatchObject({
      type: "trajectory_history_unavailable",
      data: { reason: "invalid-cursor", recovery: "recapture" },
    })
    expect(contextReads).toBe(2)

    await expect(
      Effect.runPromise(
        handlers!.trajectoryHistory(
          {
            scope: { kind: "session", sessionID: "ses-unrelated" },
            taskID,
            limit: 2,
            cursor: first.report.trajectory.nextCursor,
          },
          rpcContext,
        ),
      ),
    ).rejects.toThrow("No observation in this scope")

    foreignProject = true
    await expect(
      Effect.runPromise(
        handlers!.trajectoryHistory(
          {
            scope,
            taskID,
            limit: 2,
            cursor: first.report.trajectory.nextCursor,
          },
          rpcContext,
        ),
      ),
    ).rejects.toThrow("Observation scope is unavailable")
    expect(permissionCalls).toEqual([
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
    ])
  } finally {
    fixture.close()
  }
})

test("progress diagnostics are project-isolated and process scheduler totals are Architect-only", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(4)
  let denied = false
  let foreignProject = false
  let archived = false
  let agent = "architect"
  let contextReads = 0
  let permissionCalls = 0
  let processSamples = 0
  let delayedSessionRead: (() => Effect.Effect<unknown, unknown, never>) | undefined
  let handlers:
    | {
        progressDiagnostics(input: unknown): Effect.Effect<unknown>
      }
    | undefined
  const originalSnapshot = sharedScheduler.snapshot.bind(sharedScheduler)
  sharedScheduler.snapshot = () => {
    processSamples++
    return originalSnapshot()
  }
  const reads = new ObservationReads(
    fixture.store,
    {
      session: async () => {
        contextReads++
        return null
      },
      status: async () => null,
    } as never,
    "project",
    secret,
  )
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: typeof handlers) => {
        handlers = methods
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        delayedSessionRead?.() ??
        Effect.succeed({
          id: sessionID,
          projectID: foreignProject ? "foreign-project" : "project",
          agent,
          time: { archived: archived ? 1 : undefined },
        }),
    },
    permission: {
      assert: () => {
        permissionCalls++
        return denied ? Effect.fail(new Error("native permission denied")) : Effect.void
      },
    },
    event: { subscribe: () => Stream.empty },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
  const scope = { kind: "project" as const, sessionID: "ses-private-anchor" }

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )
    const response = (await Effect.runPromise(handlers!.progressDiagnostics({ scope }))) as Record<
      string,
      unknown
    >
    expect(response.scope).toEqual({ kind: "project" })
    expect(response.state).toBe("absent")
    expect(response.processSchedulerTotals).toMatchObject({
      status: "available",
      scope: "process",
      audience: "architect-only",
      source: "sharedScheduler.snapshot",
      implementation: "scheduler/v2",
    })
    expect((response.processSchedulerTotals as { generation: string }).generation).toMatch(
      /^[0-9a-f-]{36}$/,
    )
    expect(processSamples).toBe(1)
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain("ses-private-anchor")
    expect(serialized).not.toContain(fixture.directory)
    expect(contextReads).toBe(0)

    denied = true
    await expect(Effect.runPromise(handlers!.progressDiagnostics({ scope }))).rejects.toThrow(
      "native permission denied",
    )
    expect(processSamples).toBe(1)
    denied = false

    foreignProject = true
    await expect(Effect.runPromise(handlers!.progressDiagnostics({ scope }))).rejects.toThrow(
      "Observation scope is unavailable",
    )
    expect(processSamples).toBe(1)
    foreignProject = false

    archived = true
    await expect(Effect.runPromise(handlers!.progressDiagnostics({ scope }))).rejects.toThrow(
      "Observation scope is unavailable",
    )
    expect(processSamples).toBe(1)
    archived = false

    agent = "lazers-implementor"
    const nonArchitect = (await Effect.runPromise(handlers!.progressDiagnostics({ scope }))) as {
      processSchedulerTotals: { status: string; reason?: string }
    }
    expect(nonArchitect.processSchedulerTotals).toEqual({
      status: "unavailable",
      reason: "architect-only",
    })
    expect(processSamples).toBe(1)

    agent = "architect"
    const getStarted = Promise.withResolvers<void>()
    const releaseGet = Promise.withResolvers<unknown>()
    delayedSessionRead = () =>
      Effect.promise(() => {
        getStarted.resolve()
        return releaseGet.promise
      })
    const cancelled = Effect.runFork(handlers!.progressDiagnostics({ scope }))
    await getStarted.promise
    await Effect.runPromise(Fiber.interrupt(cancelled))
    releaseGet.resolve({
      id: scope.sessionID,
      projectID: "project",
      agent,
      time: { archived: undefined },
    })
    const permissionCountAfterCancel = permissionCalls + 1
    const deadline = Date.now() + 2_000
    while (permissionCalls < permissionCountAfterCancel && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    expect(permissionCalls).toBe(permissionCountAfterCancel)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(processSamples).toBe(1)
  } finally {
    sharedScheduler.snapshot = originalSnapshot
    fixture.close()
  }
})
