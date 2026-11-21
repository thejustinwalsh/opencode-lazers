import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Fiber, Queue, Stream } from "effect"
import { ObservationReads } from "./read.ts"
import { registerObservability } from "./rpc.ts"
import { sharedScheduler } from "../runner/scheduler-coordinator.ts"
import { sharedConnectionCount } from "../storage.ts"
import { closeSourceStampConnections } from "./changes.ts"
import { makeFixture, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { SnapshotOutput } from "./contract.ts"

type LiveScope = { kind: "session"; sessionID: string } | { kind: "project"; sessionID: string }
type RegisteredHandlers = {
  snapshot(input: { scope: LiveScope }): Effect.Effect<unknown>
}

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

test("cancelled targeted status reads cannot publish stale success and release their connection", async () => {
  const fixture = makeFixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let statusStarted = false
  const reads = new ObservationReads(
    fixture.store,
    {
      session: (id) => fixture.host.session(id),
      status: async (id) => {
        if (id === "ses-failed") {
          statusStarted = true
          started.resolve()
          await release.promise
        }
        const session = fixture.sessions.get(id)
        return session
          ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
          : null
      },
    },
    "project",
    new Uint8Array(32).fill(26),
  )
  let handlers: { trajectoryStatus(input: unknown): Effect.Effect<unknown> } | undefined
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
          projectID: "project",
          agent: "architect",
          time: { archived: undefined },
        }),
    },
    permission: { assert: () => Effect.void },
    event: { subscribe: () => Stream.empty },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
  const scope = { kind: "project" as const, sessionID: "ses-owner" }

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )
    let connectionsBeforeRelease: number | undefined
    try {
      const cancelled = Effect.runFork(handlers!.trajectoryStatus({ scope, taskID }))
      await started.promise
      // The source-stamp pool shares this read-only connection. Release its
      // leases so the pending status read owns the final handle under test.
      closeSourceStampConnections()
      connectionsBeforeRelease = sharedConnectionCount()
      fixture.store.atomic((db) =>
        db
          .query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?")
          .run(firstAttemptID),
      )
      await Effect.runPromise(Fiber.interrupt(cancelled))
      expect((await Effect.runPromise(Fiber.await(cancelled)))._tag).toBe("Failure")

      release.resolve()
      for (
        let attempt = 0;
        attempt < 100 && sharedConnectionCount() !== connectionsBeforeRelease - 1;
        attempt++
      )
        await Bun.sleep(5)
      expect(sharedConnectionCount()).toBe(connectionsBeforeRelease - 1)
    } finally {
      release.resolve()
      if (statusStarted)
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            connectionsBeforeRelease === undefined ||
            sharedConnectionCount() === connectionsBeforeRelease - 1
          )
            break
          await Bun.sleep(5)
        }
    }
  } finally {
    release.resolve()
    fixture.close()
  }
})

test("independent registrations share read boundaries and recover a failed gap on publisher handoff", async () => {
  const fixture = makeFixture()
  const reads = [
    new ObservationReads(
      fixture.store,
      { session: async (id) => fixture.host.session(id) },
      "project",
      crypto.getRandomValues(new Uint8Array(32)),
    ),
    new ObservationReads(
      fixture.store,
      { session: async (id) => fixture.host.session(id) },
      "project",
      crypto.getRandomValues(new Uint8Array(32)),
    ),
  ]
  const registrationReady = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const subscriptionReady = Promise.withResolvers<void>()
  const failedGapAttempt = Promise.withResolvers<void>()
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const deliveries: Array<Array<{ cause: string; sequence: number; resnapshotRequired: boolean }>> =
    [[], []]
  const handlers: Array<RegisteredHandlers | undefined> = []
  let registrationIndex = 0
  let subscriptionIndex = 0
  let failedGapOnce = false
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: RegisteredHandlers) => {
        const index = registrationIndex++
        handlers[index] = methods
        registrationReady[index]!.resolve()
        return Effect.succeed({
          dispose: Effect.void,
          events: {
            emit: (
              _name: string,
              change: { cause: string; sequence: number; resnapshotRequired: boolean },
            ) =>
              Effect.sync(() => {
                if (index === 0 && change.cause === "gap" && !failedGapOnce) {
                  failedGapOnce = true
                  failedGapAttempt.resolve()
                  throw new Error("gap delivery failed")
                }
                deliveries[index]!.push(change)
              }),
          },
        })
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed({
          id: sessionID,
          projectID: "project",
          agent: "architect",
          time: { archived: undefined },
        }),
    },
    permission: { assert: () => Effect.void },
    event: {
      subscribe: () => {
        if (subscriptionIndex++ === 0) {
          subscriptionReady.resolve()
          return Stream.fromQueue(eventQueue).pipe(Stream.take(1))
        }
        return Stream.never
      },
    },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
  const launch = (index: number) =>
    Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads[index]!, "project")
          yield* Effect.never
        }),
      ),
    )
  const waitFor = async (predicate: () => boolean) => {
    for (let index = 0; index < 400 && !predicate(); index++) await Bun.sleep(5)
    expect(predicate()).toBe(true)
  }

  const first = launch(0)
  await registrationReady[0]!.promise
  const second = launch(1)
  await registrationReady[1]!.promise
  await subscriptionReady.promise
  try {
    const scope = { kind: "project" as const, sessionID: "ses-owner" }
    const snapshot = async (index: number) =>
      SnapshotOutput.parse(await Effect.runPromise(handlers[index]!.snapshot({ scope })))
    let firstSnapshot = await snapshot(0)
    let secondSnapshot = await snapshot(1)
    for (let index = 0; index < 3; index++) {
      expect(firstSnapshot.boundary).toEqual(secondSnapshot.boundary)
      expect(firstSnapshot.boundary.sourceFingerprint).toBe(
        secondSnapshot.boundary.sourceFingerprint,
      )
      firstSnapshot = await snapshot(0)
      secondSnapshot = await snapshot(1)
    }
    expect(deliveries.flat()).toEqual([])
    await Effect.runPromise(
      Queue.offer(eventQueue, {
        id: "native-event-before-failed-gap",
        type: "session.tool.progress",
        durable: { aggregateID: "ses-failed", seq: 1 },
        data: { sessionID: "ses-failed" },
      }),
    )
    await waitFor(() => deliveries[0]!.some((change) => change.cause === "native"))
    await failedGapAttempt.promise
    await Bun.sleep(20)

    await Effect.runPromise(Fiber.interrupt(first))
    await waitFor(() => deliveries[1]!.some((change) => change.cause === "gap"))
    expect(deliveries).toMatchObject([
      [{ cause: "native", sequence: 1, resnapshotRequired: false }],
      [{ cause: "gap", sequence: 3, resnapshotRequired: true }],
    ])
    const recoveredSnapshot = await snapshot(1)
    expect(recoveredSnapshot.boundary.eventSequence).toBe(3)
    expect(recoveredSnapshot.boundary.nativeRevision).toBeGreaterThan(
      secondSnapshot.boundary.nativeRevision,
    )
  } finally {
    await Effect.runPromise(Fiber.interrupt(first))
    await Effect.runPromise(Fiber.interrupt(second))
    fixture.close()
  }
})

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
        snapshot(input: unknown): Effect.Effect<unknown>
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
    expect(await Effect.runPromise(handlers!.snapshot({ scope }))).toMatchObject({
      plans: [{ nodes: [{ taskID }] }],
    })
    expect(permissionCalls.at(-1)).toBe("read")
    denied = true
    await expect(Effect.runPromise(handlers!.snapshot({ scope }))).rejects.toThrow(
      "native permission denied",
    )
    denied = false
    foreignProject = true
    await expect(Effect.runPromise(handlers!.snapshot({ scope }))).rejects.toThrow(
      "Observation scope is unavailable",
    )
    foreignProject = false
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
      "read",
      "read",
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
    // S8: archival retires execution, not permission to read project telemetry.
    expect(await Effect.runPromise(handlers!.progressDiagnostics({ scope }))).toMatchObject({
      processSchedulerTotals: { status: "available" },
    })
    expect(processSamples).toBe(2)
    archived = false

    agent = "lazers-implementor"
    const nonArchitect = (await Effect.runPromise(handlers!.progressDiagnostics({ scope }))) as {
      processSchedulerTotals: { status: string; reason?: string }
    }
    expect(nonArchitect.processSchedulerTotals).toEqual({
      status: "unavailable",
      reason: "architect-only",
    })
    expect(processSamples).toBe(2)

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
    expect(processSamples).toBe(2)
  } finally {
    sharedScheduler.snapshot = originalSnapshot
    fixture.close()
  }
})
