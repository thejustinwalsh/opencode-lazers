import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Exit, Fiber, Queue, Stream } from "effect"
import { ObservationReadChangedError, ObservationReads } from "./read.ts"
import { registerObservability } from "./rpc.ts"
import { operationalReads } from "../../test/radar/operational.ts"
import { sharedScheduler } from "../runner/scheduler-coordinator.ts"
import {
  makeFixture,
  taskID,
  firstAttemptID,
  secondAttemptID,
} from "../../test/trajectory/fixture.ts"
import type { RadarNativeSession, RadarSessionHost } from "./native.ts"
import {
  LiveHistoryOutput,
  LiveRadarOutput,
  SnapshotOutput,
  type RadarRequestInput,
} from "./contract.ts"

type LiveScope = { kind: "session"; sessionID: string } | { kind: "project"; sessionID: string }
type LiveHandlers = {
  liveRadar(input: { scope: LiveScope; includeUnmanagedSessions: boolean }): Effect.Effect<unknown>
  liveHistory(
    input: { scope: LiveScope; sessionID: string; limit: number; cursor?: string },
    context: { error(type: string, message: string, data: unknown): unknown },
  ): Effect.Effect<unknown, unknown>
}
type RegisteredHandlers = LiveHandlers & {
  snapshot(input: { scope: LiveScope }): Effect.Effect<unknown>
}

test.each([2, 3])(
  "S8-1 destructive Radar retries at most three reads after %s changes",
  async (changes) => {
    const fixture = makeFixture()
    const reads = operationalReads(fixture, "project", new Uint8Array(32).fill(82))
    const original = reads.radar.bind(reads)
    let calls = 0
    reads.radar = async (...args) => {
      if (++calls <= changes) throw new ObservationReadChangedError("native")
      return original(...args)
    }
    type Handler = (
      input: RadarRequestInput,
      context: {
        error(type: string, message: string, data: unknown): unknown
      },
    ) => Effect.Effect<unknown, unknown>
    let radar: Handler | undefined
    const ctx = {
      rpc: {
        register: (_definition: unknown, methods: { radar: Handler }) => {
          radar = methods.radar
          return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
        },
      },
      session: {
        get: ({ sessionID }: { sessionID: string }) =>
          Effect.succeed({
            id: sessionID,
            projectID: "project",
            agent: "architect",
            time: {},
          }),
      },
      permission: { assert: () => Effect.void },
      event: { subscribe: () => Stream.never },
    } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerObservability(ctx, reads, "project")
            return yield* radar!(
              { scope: { kind: "project", sessionID: "ses-owner" } },
              {
                error: (type, message, data) => ({ type, message, data }),
              },
            ).pipe(
              Effect.match({
                onFailure: (error) => ({ error }),
                onSuccess: () => ({ success: true }),
              }),
            )
          }),
        ),
      )
      expect(calls).toBe(3)
      if (changes === 2) expect(result).toEqual({ success: true })
      else
        expect(result).toMatchObject({
          error: {
            type: "observation_changed",
            data: { source: "native", recovery: "retry" },
          },
        })
    } finally {
      fixture.close()
    }
  },
)

function insertLiveProgress(
  fixture: ReturnType<typeof makeFixture>,
  input: {
    sessionID?: string
    attemptID?: string
    kind: "step" | "tool" | "commentary"
    callID?: string | null
    messageID?: string | null
    eventIDs?: string[]
    at: number
    payload: unknown
    dedupeKey: string
  },
) {
  const sessionID = input.sessionID ?? "ses-failed"
  const attemptID = input.attemptID ?? firstAttemptID
  fixture.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_progress(
           project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
           source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        fixture.directory,
        "project",
        fixture.receipt.planID,
        taskID,
        attemptID,
        sessionID,
        input.at,
        input.at + 1,
        "native-event",
        JSON.stringify(["native-event"]),
        input.kind,
        JSON.stringify(input.eventIDs ?? []),
        input.callID ?? null,
        input.messageID ?? null,
        input.dedupeKey,
        JSON.stringify(input.payload),
      ),
  )
}

function radarNativeSession(
  id: string,
  projectID = "project",
  model: RadarNativeSession["model"] = {
    providerID: "google",
    id: "gemini-current",
    variant: "high",
  },
  directory = "/private/workspace/worker",
): RadarNativeSession {
  return {
    id,
    projectID,
    parentID: null,
    directory,
    agent: "architect",
    model,
    archived: false,
    busy: true,
    createdAt: 1_000,
    updatedAt: 4_000,
  }
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
    const initialRadar = LiveRadarOutput.parse(
      await Effect.runPromise(handlers[1]!.liveRadar({ scope, includeUnmanagedSessions: true })),
    )

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
    const recoveredRadar = LiveRadarOutput.parse(
      await Effect.runPromise(handlers[1]!.liveRadar({ scope, includeUnmanagedSessions: true })),
    )
    expect(recoveredRadar.streamEpoch).not.toBe(initialRadar.streamEpoch)
    expect(recoveredRadar.boundary.eventSequence).toBe(3)
    expect(recoveredRadar.freshness.nativeEvents).toBe("gap-or-unavailable")
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
        topology(input: unknown): Effect.Effect<unknown>
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
    expect(await Effect.runPromise(handlers!.topology({ scope }))).toMatchObject({
      plans: [{ nodes: [{ taskID }] }],
    })
    expect(permissionCalls.at(-1)).toBe("read")
    denied = true
    await expect(Effect.runPromise(handlers!.topology({ scope }))).rejects.toThrow(
      "native permission denied",
    )
    denied = false
    foreignProject = true
    await expect(Effect.runPromise(handlers!.topology({ scope }))).rejects.toThrow(
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

test("registered live RPCs keep current reads bounded and page selected progress separately", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(71)
  const model = { providerID: "google", id: "gemini-current", variant: "high" }
  const inventory = [
    radarNativeSession("ses-failed", "project", model, fixture.directory),
    radarNativeSession("ses-accepted", "project", model, fixture.directory),
    radarNativeSession("ses-foreign-private", "another-project", model, fixture.directory),
  ]
  const byID = new Map(inventory.map((session) => [session.id, session]))
  let projectReads = 0
  let inventoryUnavailable = false
  let nativeGetReads = 0
  let trajectoryContextReads = 0
  let denied = true
  let delayNextGet = false
  const getStarted = Promise.withResolvers<void>()
  const getAborted = Promise.withResolvers<void>()
  const nativeHost: RadarSessionHost = {
    get: async (sessionID, signal) => {
      nativeGetReads++
      if (!delayNextGet) return byID.get(sessionID) ?? null
      delayNextGet = false
      return await new Promise<RadarNativeSession | null>((_resolve, reject) => {
        if (signal.aborted) {
          getAborted.resolve()
          reject(signal.reason)
          return
        }
        signal.addEventListener(
          "abort",
          () => {
            getAborted.resolve()
            reject(signal.reason)
          },
          { once: true },
        )
        getStarted.resolve()
      })
    },
    project: async (_projectID, _includeArchived, limit) => {
      projectReads++
      if (inventoryUnavailable) throw new Error("native session inventory unavailable")
      return { sessions: inventory.slice(0, limit), truncated: inventory.length > limit }
    },
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(
    fixture.store,
    {
      session: async (sessionID) => {
        trajectoryContextReads++
        return fixture.host.session(sessionID)
      },
    },
    "project",
    secret,
    nativeHost,
  )
  const observedRoute = {
    providerID: "openai",
    modelID: "gpt-6-luna",
    variant: "max",
  }
  const privateMarker = "ghp_123456789012345678901234567890"
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    insertLiveProgress(fixture, {
      kind: "tool",
      callID: "call-buried-outstanding",
      messageID: "msg-old-outstanding",
      at: 9_000,
      dedupeKey: "old-outstanding-tool",
      payload: {
        tool: "Bash",
        status: "running",
        callID: "call-buried-outstanding",
        execution: { status: "executed" },
        content: "awaiting terminal update",
      },
    })
    const unrelatedPayload = JSON.stringify({ content: "x".repeat(5_000) })
    fixture.store.atomic((db) => {
      const insert = db.query(
        `INSERT INTO runner_progress(
           project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
           source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      for (let index = 0; index < 300; index++)
        insert.run(
          fixture.directory,
          "project",
          fixture.receipt.planID,
          taskID,
          secondAttemptID,
          "ses-accepted",
          10_000 + index,
          10_001 + index,
          "runtime",
          JSON.stringify(["runtime"]),
          "commentary",
          "[]",
          null,
          `unrelated-${index}`,
          `unrelated-retained-${index}`,
          unrelatedPayload,
        )
    })

    const stepObservation = {
      source: "native-event",
      eventID: "evt-live-step-start",
      eventType: "session.step.started",
      at: 20_000,
      status: "started",
      messageID: "msg-live",
      route: observedRoute,
      routeEvidence: { status: "observed", route: observedRoute },
      startedAt: 20_000,
    }
    insertLiveProgress(fixture, {
      kind: "step",
      messageID: "msg-live",
      eventIDs: ["evt-live-step-start"],
      at: 20_000,
      dedupeKey: "live-step",
      payload: {
        status: "running",
        route: observedRoute,
        routeEvidence: { status: "observed", route: observedRoute },
        observations: [stepObservation],
        timing: {
          endpoints: {
            startedAt: { at: 20_000, source: "native-event", sourceType: "session.step.started" },
          },
        },
      },
    })
    const toolPayload = (callID: string, eventID: string, at: number) => ({
      tool: "Bash",
      status: "running",
      callID,
      messageID: "msg-live",
      execution: { status: "executed", source: "native-event" },
      content: `running ${callID}`,
      timing: {
        endpoints: {
          inputAt: {
            at: at - 20,
            source: "native-event",
            sourceType: "session.tool.input.started",
          },
          calledAt: { at: at - 10, source: "native-event", sourceType: "session.tool.called" },
        },
      },
      observations: [
        {
          source: "native-event",
          eventID,
          eventType: "session.tool.called",
          at,
          status: "running",
          messageID: "msg-live",
          callID,
          tool: "Bash",
        },
      ],
    })
    insertLiveProgress(fixture, {
      kind: "tool",
      callID: "call-live-a",
      messageID: "msg-live",
      eventIDs: ["evt-live-tool-a"],
      at: 20_010,
      dedupeKey: "live-tool-a",
      payload: toolPayload("call-live-a", "evt-live-tool-a", 20_010),
    })
    insertLiveProgress(fixture, {
      kind: "tool",
      callID: "call-live-b",
      messageID: "msg-live",
      eventIDs: ["evt-live-tool-b"],
      at: 20_020,
      dedupeKey: "live-tool-b",
      payload: toolPayload("call-live-b", "evt-live-tool-b", 20_020),
    })

    let handlers: LiveHandlers | undefined
    const rpcContext = {
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    }
    const ctx = {
      rpc: {
        register: (_definition: unknown, methods: LiveHandlers) => {
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
      permission: {
        assert: () => (denied ? Effect.fail(new Error("native permission denied")) : Effect.void),
      },
      event: { subscribe: () => Stream.never },
    } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )

    const scope = { kind: "project" as const, sessionID: "ses-owner" }
    await expect(
      Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: true })),
    ).rejects.toThrow("native permission denied")
    await expect(
      Effect.runPromise(
        handlers!.liveHistory({ scope, sessionID: "ses-failed", limit: 2 }, rpcContext),
      ),
    ).rejects.toThrow("native permission denied")
    expect(projectReads).toBe(0)
    expect(nativeGetReads).toBe(0)
    denied = false

    const first = LiveRadarOutput.parse(
      await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: true })),
    )
    expect(first.scope).toEqual({ kind: "project" })
    expect(first.freshness).toMatchObject({ runner: "current", nativeInventory: "complete" })
    expect(first.coverage).toMatchObject({
      foreignSessionsExcluded: 1,
      nativeInventoryReads: 1,
      nativeSessionReads: 1,
      nativeContextLoads: 0,
      retainedStateEntries: 3,
      nativeMetadataBoundary: "raw-selected-fields-after-adapter",
      journal: "legacy-or-unavailable",
      journalTruncated: true,
    })
    expect(first.sessions.map((session) => session.sessionID).sort()).toEqual([
      "ses-accepted",
      "ses-failed",
    ])
    // The exact view lookup is counted, but an unavailable session is not invented.
    expect(first.sessions.find((session) => session.sessionID === "ses-owner")).toBeUndefined()
    expect(first.sessions.some((session) => session.sessionID === "ses-foreign-private")).toBe(
      false,
    )
    const liveSession = first.sessions.find((session) => session.sessionID === "ses-failed")!
    expect(liveSession).toMatchObject({
      availability: "available",
      freshness: "current",
      classification: "managed",
      assignment: { attemptID: firstAttemptID, state: "running" },
      routeCoverage: { selected: "available", configured: "available", observed: "available" },
    })
    const selectedRoute = first.routes.find((route) => route.id === liveSession.selectedRouteID)
    const configuredRoute = first.routes.find((route) => route.id === liveSession.configuredRouteID)
    const observedRouteFact = first.routes.find((route) => route.id === liveSession.observedRouteID)
    expect(selectedRoute).toMatchObject({ source: "session-selection", providerID: "google" })
    expect(configuredRoute).toMatchObject({ source: "attempt-policy", providerID: "openai" })
    expect(observedRouteFact).toMatchObject({
      source: "step-event",
      providerID: "openai",
      modelID: "gpt-6-luna",
      messageID: "msg-live",
      eventID: "evt-live-step-start",
    })
    expect(first.calls.map((call) => call.callID).sort()).toEqual([
      "call-buried-outstanding",
      "call-live-a",
      "call-live-b",
    ])
    expect(first.calls.find((call) => call.callID === "call-buried-outstanding")).toMatchObject({
      status: "running",
      execution: "executed",
      messageID: "msg-old-outstanding",
    })
    expect(
      first.calls.every((call) => call.status === "running" && call.execution === "executed"),
    ).toBe(true)
    const modelFlow = first.flow.find((edge) => edge.kind === "model-request")!
    expect(modelFlow).toMatchObject({
      from: liveSession.id,
      to: observedRouteFact!.id,
      routeID: observedRouteFact!.id,
      sourceEventID: "evt-live-step-start",
      sourceEventType: "session.step.started",
    })
    const originalCallFlow = first.flow.find((edge) => edge.callID === "call-live-a")!
    expect(first.coverage.sourceRowsRead).toBeLessThanOrEqual(first.limits.sourceRows)
    expect(first.coverage.sourceBytesRead).toBeLessThanOrEqual(first.limits.sourceBytes)
    expect(first.coverage.sourceQueries).toBeLessThanOrEqual(first.limits.sourceQueries)
    expect(first.coverage.nativeMetadataBytesInspected).toBeLessThanOrEqual(
      first.limits.nativeMetadataBytes,
    )
    expect(first.coverage.sourcePayloadBytesRead).toBeLessThan(100_000)
    expect(first.coverage.responseBytes).toBeLessThanOrEqual(first.limits.responseBytes)
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(
      first.limits.responseBytes,
    )
    expect(JSON.stringify(first)).not.toContain(privateMarker)
    expect(JSON.stringify(first)).not.toContain(fixture.directory)
    expect(JSON.stringify(first)).not.toContain("ses-foreign-private")
    expect(projectReads).toBe(1)
    expect(trajectoryContextReads).toBe(0)

    insertLiveProgress(fixture, {
      kind: "step",
      messageID: "msg-concurrent-b",
      eventIDs: ["evt-concurrent-a", "evt-concurrent-b"],
      at: 20_100,
      dedupeKey: "concurrent-messages",
      payload: {
        observations: [
          {
            source: "native-event",
            eventID: "evt-concurrent-a",
            eventType: "session.step.started",
            at: 20_100,
            status: "started",
            messageID: "msg-concurrent-a",
            route: observedRoute,
            routeEvidence: { status: "observed", route: observedRoute },
          },
          {
            source: "native-event",
            eventID: "evt-concurrent-b",
            eventType: "session.step.started",
            at: 20_110,
            status: "started",
            messageID: "msg-concurrent-b",
            route: observedRoute,
            routeEvidence: {
              status: "identity-unavailable",
              route: { ...observedRoute, identity: null },
            },
          },
          {
            source: "native-event",
            eventID: "evt-concurrent-c",
            eventType: "session.step.started",
            at: 20_120,
            status: "started",
            messageID: "msg-concurrent-c",
            route: observedRoute,
            routeEvidence: {
              status: "observed",
              route: { ...observedRoute, identity: { ...observedRoute, modelID: "conflict" } },
            },
          },
        ],
      },
    })
    const conflictingRoutes = LiveRadarOutput.parse(
      await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: true })),
    )
    const conflictingSession = conflictingRoutes.sessions.find(
      (session) => session.sessionID === "ses-failed",
    )!
    const concurrentRouteA = conflictingRoutes.routes.find(
      (route) => route.messageID === "msg-concurrent-a",
    )!
    expect(conflictingSession).toMatchObject({
      observedRouteID: null,
      routeCoverage: { observed: "identity-unavailable" },
    })
    expect(
      conflictingRoutes.flow.find((edge) => edge.messageID === "msg-concurrent-a"),
    ).toMatchObject({ to: concurrentRouteA.id, routeID: concurrentRouteA.id })
    expect(
      conflictingRoutes.flow.find((edge) => edge.messageID === "msg-concurrent-b"),
    ).toMatchObject({ to: null, routeID: null, sourceEventID: "evt-concurrent-b" })
    expect(
      conflictingRoutes.flow.find((edge) => edge.messageID === "msg-concurrent-c"),
    ).toMatchObject({ to: null, routeID: null, sourceEventID: "evt-concurrent-c" })

    for (const length of [239, 240, 241])
      insertLiveProgress(fixture, {
        kind: "tool",
        callID: `call-cap-${length}`,
        messageID: "msg-live",
        at: 22_100 + length,
        dedupeKey: `cap-tool-${length}`,
        payload: {
          tool: "Bash",
          status: "succeeded",
          callID: `call-cap-${length}`,
          execution: { status: "executed" },
          content: "r".repeat(length),
          error: { type: "ToolError", message: "e".repeat(length) },
        },
      })
    insertLiveProgress(fixture, {
      kind: "tool",
      callID: "call-cap-astral",
      messageID: "msg-live",
      at: 22_500,
      dedupeKey: "cap-tool-astral",
      payload: {
        tool: "Bash",
        status: "succeeded",
        callID: "call-cap-astral",
        execution: { status: "executed" },
        content: "😀".repeat(121),
        error: { type: "ToolError", message: "😀".repeat(121) },
      },
    })
    for (const length of [599, 600, 601])
      insertLiveProgress(fixture, {
        kind: "tool",
        callID: `call-history-cap-${length}`,
        messageID: "msg-live",
        at: 23_100 + length,
        dedupeKey: `history-cap-tool-${length}`,
        payload: {
          tool: "Bash",
          status: "succeeded",
          callID: `call-history-cap-${length}`,
          execution: { status: "executed" },
          content: "h".repeat(length),
          error: { type: "ToolError", message: "j".repeat(length) },
        },
      })
    insertLiveProgress(fixture, {
      kind: "tool",
      callID: "call-history-cap-astral",
      messageID: "msg-live",
      at: 23_800,
      dedupeKey: "history-cap-tool-astral",
      payload: {
        tool: "Bash",
        status: "succeeded",
        callID: "call-history-cap-astral",
        execution: { status: "executed" },
        content: "😀".repeat(301),
        error: { type: "ToolError", message: "😀".repeat(301) },
      },
    })
    const cappedFields = LiveRadarOutput.parse(
      await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: true })),
    )
    for (const length of [239, 240, 241]) {
      const call = cappedFields.calls.find((item) => item.callID === `call-cap-${length}`)!
      const expectedLength = Math.min(length, 240)
      expect(call.result).toHaveLength(expectedLength)
      expect(call.error).toHaveLength(expectedLength)
      if (length > 240) {
        expect(call.result).toEndWith("…[truncated]")
        expect(call.error).toEndWith("…[truncated]")
      } else {
        expect(call.result).toBe("r".repeat(length))
        expect(call.error).toBe("e".repeat(length))
      }
    }
    const astralCall = cappedFields.calls.find((item) => item.callID === "call-cap-astral")!
    expect(astralCall.result).toHaveLength(240)
    expect(astralCall.error).toHaveLength(240)
    expect(astralCall.result).toEndWith("…[truncated]")
    expect(astralCall.error).toEndWith("…[truncated]")
    expect(astralCall.result!.slice(0, -"…[truncated]".length)).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(astralCall.error!.slice(0, -"…[truncated]".length)).not.toMatch(/[\uD800-\uDBFF]$/)

    fixture.store.atomic((db) => {
      const insert = db.query(
        `INSERT INTO runner_progress(
           project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
           source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      for (let index = 0; index < 30; index++)
        insert.run(
          fixture.directory,
          "project",
          fixture.receipt.planID,
          taskID,
          firstAttemptID,
          "ses-failed",
          21_000 + index,
          21_001 + index,
          "runtime",
          JSON.stringify(["runtime"]),
          "commentary",
          "[]",
          null,
          `recent-${index}`,
          `recent-progress-${index}`,
          JSON.stringify({ text: `recent progress ${index}` }),
        )
      db.query(
        `UPDATE runner_progress SET at=?,recorded_at=?,payload=?,event_ids_json=?
            WHERE project_directory=? AND attempt_id=? AND call_id=?`,
      ).run(
        22_000,
        22_001,
        JSON.stringify({
          tool: "Bash",
          status: "succeeded",
          callID: "call-live-a",
          messageID: "msg-live",
          execution: { status: "executed", source: "native-event" },
          content: `completed but private ${privateMarker}`,
          timing: {
            endpoints: {
              inputAt: { at: 19_990, source: "native-event" },
              calledAt: { at: 20_000, source: "native-event" },
              completedAt: { at: 22_000, source: "native-event" },
            },
          },
          observations: [
            {
              source: "native-event",
              eventID: "evt-live-tool-a",
              eventType: "session.tool.called",
              at: 20_010,
              status: "running",
              messageID: "msg-live",
              callID: "call-live-a",
              tool: "Bash",
            },
            {
              source: "native-event",
              eventID: "evt-live-tool-a-terminal",
              eventType: "session.tool.success",
              at: 22_000,
              status: "succeeded",
              messageID: "msg-live",
              callID: "call-live-a",
              tool: "Bash",
            },
          ],
        }),
        JSON.stringify(["evt-live-tool-a", "evt-live-tool-a-terminal"]),
        fixture.directory,
        firstAttemptID,
        "call-live-a",
      )
    })
    insertLiveProgress(fixture, {
      kind: "commentary",
      messageID: "msg-large-live-payload",
      at: 21_500,
      dedupeKey: "large-live-payload",
      payload: { text: `${"bounded-".repeat(1_000)}${privateMarker}` },
    })
    const executionStateBeforeReads = fixture.store.atomic((db) => ({
      attempt: db
        .query<{ state: string; tool_count: number }, [string]>(
          "SELECT state,tool_count FROM runner_attempts WHERE id=?",
        )
        .get(firstAttemptID),
      effects: db.query("SELECT id FROM runner_effects ORDER BY id").all(),
      outbox: db.query("SELECT id FROM runner_outbox ORDER BY id").all(),
      observationRevision: db
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM observation_revisions WHERE project_directory=?",
        )
        .get(fixture.directory),
    }))

    const updated = LiveRadarOutput.parse(
      await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: true })),
    )
    expect(updated.coverage).toMatchObject({
      progressTruncated: true,
      payloadTruncated: true,
      journalTruncated: true,
    })
    expect(updated.calls.find((call) => call.callID === "call-live-a")).toMatchObject({
      status: "succeeded",
      completedAt: 22_000,
    })
    expect(updated.flow.find((edge) => edge.callID === "call-live-a")?.id).toBe(originalCallFlow.id)
    expect(updated.flow.find((edge) => edge.callID === "call-live-a")).toMatchObject({
      status: "succeeded",
      sourceEventID: "evt-live-tool-a-terminal",
      sourceEventType: "session.tool.success",
    })
    expect(JSON.stringify(updated)).not.toContain(privateMarker)
    expect(updated.coverage.sourceRowsRead).toBeLessThanOrEqual(updated.limits.sourceRows)
    expect(updated.coverage.sourceBytesRead).toBeLessThanOrEqual(updated.limits.sourceBytes)
    expect(updated.coverage.sourcePayloadBytesRead).toBeLessThan(100_000)

    const managedOnly = LiveRadarOutput.parse(
      await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: false })),
    )
    expect(managedOnly.sessions.map((session) => session.sessionID)).toEqual(["ses-failed"])
    const changedScope = LiveRadarOutput.parse(
      await Effect.runPromise(
        handlers!.liveRadar({
          scope: { kind: "session", sessionID: "ses-accepted" },
          includeUnmanagedSessions: false,
        }),
      ),
    )
    expect(changedScope.scope).toEqual({ kind: "session", sessionID: "ses-accepted" })
    expect(changedScope.sessions.map((session) => session.sessionID)).toEqual(["ses-accepted"])
    expect(changedScope.flow.every((edge) => edge.sessionID === "ses-accepted")).toBe(true)

    const historyInput = { scope, sessionID: "ses-failed", limit: 2 }
    const firstPage = LiveHistoryOutput.parse(
      await Effect.runPromise(handlers!.liveHistory(historyInput, rpcContext)),
    )
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.nextCursor).not.toBeNull()
    expect(firstPage.coverage.nativeInventoryReads).toBe(0)
    expect(firstPage.coverage.nativeContextLoads).toBe(0)
    expect(firstPage.coverage.responseBytes).toBeLessThanOrEqual(firstPage.limits.responseBytes)
    expect(firstPage.coverage.sourceQueries).toBeLessThanOrEqual(firstPage.limits.sourceQueries)
    expect(firstPage.coverage.sourceRowsRead).toBeLessThanOrEqual(firstPage.limits.sourceRows)
    expect(firstPage.coverage.sourceBytesRead).toBeLessThanOrEqual(firstPage.limits.sourceBytes)
    const secondPage = LiveHistoryOutput.parse(
      await Effect.runPromise(
        handlers!.liveHistory({ ...historyInput, cursor: firstPage.nextCursor! }, rpcContext),
      ),
    )
    expect(secondPage.items).toHaveLength(2)
    expect(secondPage.items.map((item) => item.sequence)).not.toEqual(
      firstPage.items.map((item) => item.sequence),
    )
    await expect(
      Effect.runPromise(
        handlers!.liveHistory(
          {
            ...historyInput,
            scope: { kind: "session", sessionID: "ses-accepted" },
            sessionID: "ses-accepted",
            cursor: firstPage.nextCursor!,
          },
          rpcContext,
        ),
      ),
    ).rejects.toMatchObject({
      type: "live_history_unavailable",
      data: { reason: "invalid-cursor", recovery: "restart" },
    })
    await expect(
      Effect.runPromise(
        handlers!.liveHistory(
          { ...historyInput, limit: 3, cursor: firstPage.nextCursor! },
          rpcContext,
        ),
      ),
    ).rejects.toMatchObject({
      type: "live_history_unavailable",
      data: { reason: "invalid-cursor", recovery: "restart" },
    })
    const allHistoryItems = [...firstPage.items, ...secondPage.items]
    let historyCursor = secondPage.nextCursor
    while (historyCursor) {
      const page = LiveHistoryOutput.parse(
        await Effect.runPromise(
          handlers!.liveHistory({ ...historyInput, cursor: historyCursor }, rpcContext),
        ),
      )
      allHistoryItems.push(...page.items)
      historyCursor = page.nextCursor
    }
    const historySequences = allHistoryItems.map((item) => item.sequence)
    expect(new Set(historySequences).size).toBe(historySequences.length)
    expect(historySequences).toHaveLength(
      fixture.store.atomic(
        (db) =>
          db
            .query<{ count: number }, [string, string, string, string]>(
              `SELECT COUNT(*) AS count FROM runner_progress
              WHERE project_directory=? AND attempt_id=? AND session_id=? AND project_id=?`,
            )
            .get(fixture.directory, firstAttemptID, "ses-failed", "project")!.count,
      ),
    )
    for (const length of [599, 600, 601]) {
      const item = allHistoryItems.find(
        (history) => history.callID === `call-history-cap-${length}`,
      )!
      expect(item.result).toHaveLength(Math.min(length, 600))
      expect(item.error).toHaveLength(Math.min(length, 600))
      if (length > 600) {
        expect(item.result).toEndWith("…[truncated]")
        expect(item.error).toEndWith("…[truncated]")
      }
    }
    const historyAstral = allHistoryItems.find(
      (history) => history.callID === "call-history-cap-astral",
    )!
    expect(historyAstral.result).toHaveLength(600)
    expect(historyAstral.error).toHaveLength(600)
    expect(historyAstral.result).toEndWith("…[truncated]")
    expect(historyAstral.error).toEndWith("…[truncated]")
    expect(historyAstral.result!.slice(0, -"…[truncated]".length)).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(historyAstral.error!.slice(0, -"…[truncated]".length)).not.toMatch(/[\uD800-\uDBFF]$/)
    await expect(
      Effect.runPromise(
        handlers!.liveHistory(
          { ...historyInput, cursor: `${firstPage.nextCursor!.slice(0, -1)}x` },
          rpcContext,
        ),
      ),
    ).rejects.toMatchObject({
      type: "live_history_unavailable",
      data: { reason: "invalid-cursor", recovery: "restart" },
    })
    await expect(
      Effect.runPromise(
        handlers!.liveHistory(
          {
            scope: { kind: "session", sessionID: "ses-accepted" },
            sessionID: "ses-failed",
            limit: 2,
          },
          rpcContext,
        ),
      ),
    ).rejects.toMatchObject({
      type: "live_history_unavailable",
      data: { reason: "session-unavailable", recovery: "restart" },
    })
    inventoryUnavailable = true
    const unavailableInventory = LiveRadarOutput.parse(
      await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: true })),
    )
    expect(unavailableInventory.freshness.nativeInventory).toBe("unavailable")
    expect(unavailableInventory.sessions).toHaveLength(2)
    expect(
      unavailableInventory.sessions.find((session) => session.sessionID === "ses-owner"),
    ).toMatchObject({
      isViewSession: true,
      availability: "unavailable",
    })
    expect(
      unavailableInventory.sessions.find((session) => session.sessionID === "ses-failed"),
    ).toMatchObject({
      sessionID: "ses-failed",
      classification: "managed",
      availability: "available",
    })
    expect(unavailableInventory.coverage.inventoryTruncated).toBe(false)
    inventoryUnavailable = false

    for (let index = 0; index < 40; index++)
      inventory.push(radarNativeSession(`ses-extra-${index}`, "project", model, fixture.directory))
    const boundedInventory = LiveRadarOutput.parse(
      await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: true })),
    )
    expect(boundedInventory.freshness.nativeInventory).toBe("complete")
    expect(boundedInventory.coverage.inventoryTruncated).toBe(true)
    expect(boundedInventory.sessions).toHaveLength(32)
    expect(boundedInventory.coverage.nativeInventoryReads).toBe(1)
    expect(boundedInventory.coverage.nativeMetadataBytesInspected).toBeLessThanOrEqual(
      boundedInventory.limits.nativeMetadataBytes,
    )
    expect(projectReads).toBe(7)
    // Each inventory read also looks up its exact view; two managed misses add two reads.
    expect(nativeGetReads).toBe(projectReads + 2)
    expect(trajectoryContextReads).toBe(0)

    delayNextGet = true
    const cancelled = Effect.runFork(
      handlers!.liveRadar({
        scope: { kind: "session", sessionID: "ses-failed" },
        includeUnmanagedSessions: false,
      }),
    )
    await getStarted.promise
    await Effect.runPromise(Fiber.interrupt(cancelled))
    await getAborted.promise
    expect(trajectoryContextReads).toBe(0)
    expect(
      fixture.store.atomic((db) => ({
        attempt: db
          .query<{ state: string; tool_count: number }, [string]>(
            "SELECT state,tool_count FROM runner_attempts WHERE id=?",
          )
          .get(firstAttemptID),
        effects: db.query("SELECT id FROM runner_effects ORDER BY id").all(),
        outbox: db.query("SELECT id FROM runner_outbox ORDER BY id").all(),
        observationRevision: db
          .query<{ revision: number }, [string]>(
            "SELECT revision FROM observation_revisions WHERE project_directory=?",
          )
          .get(fixture.directory),
      })),
    ).toEqual(executionStateBeforeReads)
    fixture.store.atomic((db) =>
      db
        .query(
          "UPDATE runner_progress SET payload=? WHERE project_directory=? AND attempt_id=? AND call_id=?",
        )
        .run(
          JSON.stringify({
            tool: "Bash",
            status: "succeeded",
            callID: "call-live-b",
            content: "updated after the first page",
          }),
          fixture.directory,
          firstAttemptID,
          "call-live-b",
        ),
    )
    await expect(
      Effect.runPromise(
        handlers!.liveHistory({ ...historyInput, cursor: firstPage.nextCursor! }, rpcContext),
      ),
    ).rejects.toMatchObject({
      type: "live_history_unavailable",
      data: { reason: "changed-during-read", recovery: "restart" },
    })

    let lastRetainedState: ReturnType<typeof LiveRadarOutput.parse> | undefined
    for (let index = 0; index < 33; index++)
      lastRetainedState = LiveRadarOutput.parse(
        await Effect.runPromise(
          handlers!.liveRadar({
            scope: { kind: "session", sessionID: `ses-retained-${index}` },
            includeUnmanagedSessions: false,
          }),
        ),
      )
    expect(lastRetainedState!.coverage.retainedStateEntries).toBe(
      lastRetainedState!.limits.retainedStateEntries,
    )
    expect(lastRetainedState!.coverage.retainedStateTruncated).toBe(true)
    expect(lastRetainedState!.sessions.map((session) => session.sessionID)).toEqual([
      "ses-retained-32",
    ])
  } finally {
    fixture.close()
  }
})

test("first inventory preserves selected unmanaged events and retrieves managed sessions beyond its cap", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(73)
  const managedNative = radarNativeSession("ses-failed", "project", null, fixture.directory)
  const selectedUnmanaged = {
    ...radarNativeSession("ses-selected-unmanaged", "project", null, fixture.directory),
    directory: `/private/${"d".repeat(5_000)}`,
    agent: "a".repeat(250),
    model: { providerID: "p".repeat(210), id: "m".repeat(310), variant: null },
  }
  const inventory = [
    selectedUnmanaged,
    ...Array.from({ length: 256 }, (_, index) =>
      radarNativeSession(`ses-unmanaged-${index}`, "project", null, fixture.directory),
    ),
    managedNative,
  ]
  const inventoryStarted = Promise.withResolvers<void>()
  const delayedInventory = Promise.withResolvers<{
    sessions: RadarNativeSession[]
    truncated: boolean
  }>()
  const firstSubscription = Promise.withResolvers<void>()
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const published: Array<{ cause: string; sequence: number }> = []
  const selectedMetadataBytes = new TextEncoder().encode(
    JSON.stringify({
      id: selectedUnmanaged.id,
      projectID: selectedUnmanaged.projectID,
      parentID: selectedUnmanaged.parentID,
      directory: selectedUnmanaged.directory,
      agent: selectedUnmanaged.agent,
      model: selectedUnmanaged.model,
      archived: selectedUnmanaged.archived,
      busy: selectedUnmanaged.busy,
      createdAt: selectedUnmanaged.createdAt,
      updatedAt: selectedUnmanaged.updatedAt,
    }),
  ).byteLength
  let inventoryReads = 0
  let managedReads = 0
  let handlers: LiveHandlers | undefined
  const nativeHost: RadarSessionHost = {
    get: async (sessionID) => {
      if (sessionID === "ses-failed") {
        managedReads++
        return managedNative
      }
      return null
    },
    project: async () => {
      inventoryReads++
      if (inventoryReads === 1) {
        inventoryStarted.resolve()
        return delayedInventory.promise
      }
      return { sessions: inventory, truncated: true }
    },
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, nativeHost)
  fixture.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
  )
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: LiveHandlers) => {
        handlers = methods
        return Effect.succeed({
          dispose: Effect.void,
          events: {
            emit: (_name: string, change: { cause: string; sequence: number }) =>
              Effect.sync(() => published.push(change)),
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
        firstSubscription.resolve()
        return Stream.fromQueue(eventQueue)
      },
    },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
  const service = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerObservability(ctx, reads, "project")
        yield* Effect.never
      }),
    ),
  )

  try {
    await firstSubscription.promise
    const scope = { kind: "project" as const, sessionID: "ses-owner" }
    const firstRead = Effect.runPromise(
      handlers!.liveRadar({ scope, includeUnmanagedSessions: true }),
    )
    await inventoryStarted.promise
    await Effect.runPromise(
      Queue.offer(eventQueue, {
        id: "evt-selected-unmanaged-first-read",
        type: "session.tool.progress",
        durable: { aggregateID: "ses-selected-unmanaged", seq: 1 },
        data: { sessionID: "ses-selected-unmanaged" },
      }),
    )
    await Bun.sleep(20)
    expect(published).toEqual([])
    delayedInventory.resolve({ sessions: inventory, truncated: true })
    // S8-1: a consistent snapshot remains usable; later events drive catch-up.
    const firstResponse = LiveRadarOutput.parse(await firstRead)
    expect(firstResponse.boundary.eventSequence).toBe(0)
    await Effect.runPromise(
      Effect.promise(async () => {
        for (let index = 0; index < 400 && !published.length; index++) await Bun.sleep(5)
      }),
    )
    expect(published).toMatchObject([{ cause: "native", sequence: 1 }])

    const response = LiveRadarOutput.parse(
      await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: true })),
    )
    expect(response.coverage.inventoryTruncated).toBe(true)
    expect(response.coverage.nativeSessionReads).toBe(2)
    expect(managedReads).toBe(2)
    expect(response.sessions.some((session) => session.sessionID === "ses-failed")).toBe(true)
    const unmanaged = response.sessions.find(
      (session) => session.sessionID === "ses-selected-unmanaged",
    )!
    expect(unmanaged).toMatchObject({
      classification: "unmanaged",
      agent: null,
      routeCoverage: { selected: "unavailable" },
    })
    expect(response.coverage.nativeMetadataBoundary).toBe("raw-selected-fields-after-adapter")
    expect(response.coverage.nativeMetadataBytesInspected).toBeGreaterThan(selectedMetadataBytes)
    expect(response.coverage.nativeMetadataBytesInspected).toBeLessThanOrEqual(
      response.limits.nativeMetadataBytes,
    )
  } finally {
    await Effect.runPromise(Fiber.interrupt(service))
    fixture.close()
  }
})

test("live snapshot epochs roll over at a stream gap without replaying persisted flow identities", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(72)
  const nativeSession = radarNativeSession(
    "ses-failed",
    "project",
    { providerID: "google", id: "gemini-current", variant: "high" },
    fixture.directory,
  )
  const nativeHost: RadarSessionHost = {
    get: async () => nativeSession,
    project: async () => ({ sessions: [nativeSession], truncated: false }),
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, nativeHost)
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const firstSubscription = Promise.withResolvers<void>()
  const streamGapPublished = Promise.withResolvers<void>()
  const nativePublished = Promise.withResolvers<void>()
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  let subscriptionCount = 0
  const publishedCauses: string[] = []
  let handlers: LiveHandlers | undefined
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: LiveHandlers) => {
        handlers = methods
        return Effect.succeed({
          dispose: Effect.void,
          events: {
            emit: (_name: string, change: { cause: string }) =>
              Effect.sync(() => {
                publishedCauses.push(change.cause)
                if (change.cause === "native") nativePublished.resolve()
                if (change.cause === "gap") streamGapPublished.resolve()
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
        subscriptionCount++
        if (subscriptionCount === 1) {
          firstSubscription.resolve()
          return Stream.fromQueue(eventQueue).pipe(Stream.take(1))
        }
        return Stream.never
      },
    },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">

  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    insertLiveProgress(fixture, {
      kind: "step",
      messageID: "msg-reconnect",
      eventIDs: ["evt-reconnect-step"],
      at: 30_000,
      dedupeKey: "reconnect-step",
      payload: {
        status: "running",
        route: { providerID: "openai", modelID: "gpt-6-luna", variant: "max" },
        routeEvidence: {
          status: "observed",
          route: { providerID: "openai", modelID: "gpt-6-luna", variant: "max" },
        },
        observations: [
          {
            source: "native-event",
            eventID: "evt-reconnect-step",
            eventType: "session.step.started",
            at: 30_000,
            status: "started",
            messageID: "msg-reconnect",
            route: { providerID: "openai", modelID: "gpt-6-luna", variant: "max" },
            routeEvidence: {
              status: "observed",
              route: { providerID: "openai", modelID: "gpt-6-luna", variant: "max" },
            },
          },
        ],
      },
    })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
          yield* Effect.promise(() =>
            Promise.race([
              firstSubscription.promise,
              Bun.sleep(2_000).then(() => {
                throw new Error(`Initial native subscription missing (${subscriptionCount})`)
              }),
            ]),
          )
          const first = LiveRadarOutput.parse(
            yield* handlers!.liveRadar({ scope, includeUnmanagedSessions: true }),
          )
          yield* Queue.offer(eventQueue, {
            id: "native-event-reconnect",
            type: "session.step.started",
            data: { sessionID: "ses-failed" },
          })
          yield* Effect.promise(() =>
            Promise.race([
              nativePublished.promise,
              Bun.sleep(2_000).then(() => {
                throw new Error(
                  `Native event missing (subscriptions=${subscriptionCount}; changes=${publishedCauses.join(",")})`,
                )
              }),
            ]),
          )
          yield* Effect.promise(() =>
            Promise.race([
              streamGapPublished.promise,
              Bun.sleep(2_000).then(() => {
                throw new Error(
                  `Stream gap missing (subscriptions=${subscriptionCount}; changes=${publishedCauses.join(",")})`,
                )
              }),
            ]),
          )
          const afterReconnect = LiveRadarOutput.parse(
            yield* handlers!.liveRadar({ scope, includeUnmanagedSessions: true }),
          )
          return { first, afterReconnect }
        }),
      ),
    )
    expect(result.afterReconnect.streamEpoch).not.toBe(result.first.streamEpoch)
    expect(result.afterReconnect.boundary.eventSequence).toBeGreaterThan(
      result.first.boundary.eventSequence,
    )
    expect(result.afterReconnect.freshness.nativeEvents).toBe("gap-or-unavailable")
    expect(result.afterReconnect.flow.map((edge) => edge.id)).toEqual(
      result.first.flow.map((edge) => edge.id),
    )
  } finally {
    fixture.close()
  }
})

test("managed sessions stay visible when unmanaged inventory precedes the bounded page", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(73)
  const assigned = radarNativeSession(
    "ses-failed",
    "project",
    { providerID: "google", id: "gemini-current", variant: "high" },
    fixture.directory,
  )
  const unmanaged = Array.from({ length: 300 }, (_value, index) =>
    radarNativeSession(`ses-unmanaged-${index}`, "project", null, fixture.directory),
  )
  const nativeByID = new Map([
    [assigned.id, assigned],
    ...unmanaged.map((row) => [row.id, row] as const),
  ])
  let projectReads = 0
  let exactReads = 0
  const nativeHost: RadarSessionHost = {
    get: async (sessionID) => {
      exactReads++
      return nativeByID.get(sessionID) ?? null
    },
    project: async (_projectID, _includeArchived, limit) => {
      projectReads++
      return { sessions: unmanaged.slice(0, limit), truncated: true }
    },
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, nativeHost)
  let handlers: LiveHandlers | undefined
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: LiveHandlers) => {
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
    event: { subscribe: () => Stream.never },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )
    const response = LiveRadarOutput.parse(
      await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: false })),
    )
    expect(response.freshness.nativeInventory).toBe("bounded")
    expect(response.coverage.inventoryTruncated).toBe(true)
    expect(response.sessions.map((session) => session.sessionID)).toEqual([
      "ses-owner",
      "ses-failed",
    ])
    expect(response.sessions.find((session) => session.sessionID === "ses-failed")).toMatchObject({
      classification: "managed",
      availability: "available",
    })
    expect(response.coverage.nativeInventoryReads).toBe(1)
    expect(response.coverage.nativeSessionReads).toBe(2)
    expect(response.coverage.retainedStateEntries).toBe(2)
    expect(projectReads).toBe(1)
    expect(exactReads).toBe(2)
  } finally {
    fixture.close()
  }
})

test("a selected unmanaged native event invalidates the registered live view", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(74)
  const unmanaged = radarNativeSession(
    "ses-unmanaged-live",
    "project",
    { providerID: "google", id: "gemini-current", variant: "high" },
    fixture.directory,
  )
  const other = radarNativeSession(
    "ses-other-live",
    "project",
    { providerID: "google", id: "gemini-other", variant: "high" },
    fixture.directory,
  )
  const nativeHost: RadarSessionHost = {
    get: async (sessionID) =>
      sessionID === other.id ? other : sessionID === unmanaged.id ? unmanaged : null,
    project: async () => ({ sessions: [unmanaged], truncated: false }),
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, nativeHost)
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const subscribed = Promise.withResolvers<void>()
  const changed = Promise.withResolvers<void>()
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  let handlers: LiveHandlers | undefined
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: LiveHandlers) => {
        handlers = methods
        return Effect.succeed({
          dispose: Effect.void,
          events: {
            emit: (_name: string, change: { cause: string }) =>
              Effect.sync(() => {
                if (change.cause === "native") changed.resolve()
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
        subscribed.resolve()
        return Stream.fromQueue(eventQueue)
      },
    },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
  try {
    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
          const live = LiveRadarOutput.parse(
            yield* handlers!.liveRadar({ scope, includeUnmanagedSessions: true }),
          )
          const otherScope = LiveRadarOutput.parse(
            yield* handlers!.liveRadar({
              scope: { kind: "session", sessionID: other.id },
              includeUnmanagedSessions: false,
            }),
          )
          expect(otherScope.sessions.map((session) => session.sessionID)).toEqual([other.id])
          yield* Effect.promise(() =>
            Promise.race([
              subscribed.promise,
              Bun.sleep(2_000).then(() => {
                throw new Error("Native event stream did not subscribe")
              }),
            ]),
          )
          yield* Queue.offer(eventQueue, {
            id: "evt-selected-unmanaged",
            type: "session.model.selected",
            data: { sessionID: "ses-unmanaged-live" },
          })
          yield* Effect.promise(() =>
            Promise.race([
              changed.promise,
              Bun.sleep(2_000).then(() => {
                throw new Error("Selected unmanaged native event was not published")
              }),
            ]),
          )
          return live
        }),
      ),
    )
    expect(response.sessions.map((session) => session.sessionID)).toEqual([
      "ses-owner",
      "ses-unmanaged-live",
    ])
    expect(response.coverage.retainedStateEntries).toBe(2)
  } finally {
    fixture.close()
  }
})

test("native metadata bounds distinguish raw selected fields from sanitized output", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(75)
  const base = radarNativeSession(
    "ses-failed",
    "project",
    { providerID: "google", id: "gemini-current", variant: "high" },
    fixture.directory,
  )
  let native = base
  const nativeHost: RadarSessionHost = {
    get: async () => native,
    project: async () => ({ sessions: [native], truncated: false }),
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, nativeHost)
  let handlers: LiveHandlers | undefined
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: LiveHandlers) => {
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
    event: { subscribe: () => Stream.never },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )
    const oversized = "raw-private-".repeat(30_000)
    const cases = [
      { ...base, directory: oversized },
      { ...base, agent: oversized },
      { ...base, model: { providerID: "google", id: oversized, variant: "high" } },
    ]
    for (const metadata of cases) {
      native = metadata
      const response = LiveRadarOutput.parse(
        await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: false })),
      )
      expect(response.coverage.nativeMetadataBoundary).toBe("raw-selected-fields-after-adapter")
      expect(response.coverage.nativeMetadataBytesInspected).toBeLessThanOrEqual(
        response.limits.nativeMetadataBytes,
      )
      expect(response.coverage.nativeMetadataTruncated).toBe(true)
      expect(response.coverage.inventoryTruncated).toBe(true)
      expect(JSON.stringify(response)).not.toContain("raw-private-")
      expect(JSON.stringify(response)).not.toContain(fixture.directory)
      expect(response.coverage.nativeContextLoads).toBe(0)
    }
  } finally {
    fixture.close()
  }
})

test("S8-1 a held inventory read returns its captured boundary across events and disconnect", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(76)
  const nativeSession = radarNativeSession(
    "ses-failed",
    "project",
    { providerID: "google", id: "gemini-current", variant: "high" },
    fixture.directory,
  )
  const inventoryStarted = Promise.withResolvers<void>()
  const releaseInventory = Promise.withResolvers<{
    sessions: RadarNativeSession[]
    truncated: boolean
  }>()
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const subscribed = Promise.withResolvers<void>()
  const nativePublished = Promise.withResolvers<void>()
  const gapPublished = Promise.withResolvers<void>()
  const nativeHost: RadarSessionHost = {
    get: async () => nativeSession,
    project: async (_projectID, _includeArchived, _limit, signal) => {
      inventoryStarted.resolve()
      return await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener("abort", abort, { once: true })
        releaseInventory.promise.then((inventory) => {
          signal.removeEventListener("abort", abort)
          resolve(inventory)
        })
      })
    },
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, nativeHost)
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  let handlers: LiveHandlers | undefined
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: LiveHandlers) => {
        handlers = methods
        return Effect.succeed({
          dispose: Effect.void,
          events: {
            emit: (_name: string, change: { cause: string }) =>
              Effect.sync(() => {
                if (change.cause === "native") nativePublished.resolve()
                if (change.cause === "gap") gapPublished.resolve()
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
        subscribed.resolve()
        return Stream.fromQueue(eventQueue).pipe(Stream.take(1))
      },
    },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">

  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
          yield* Effect.promise(() => subscribed.promise)
          const pendingRead = Effect.runFork(
            handlers!.liveRadar({ scope, includeUnmanagedSessions: true }),
          )
          yield* Effect.promise(() => inventoryStarted.promise)
          yield* Queue.offer(eventQueue, {
            id: "evt-held-inventory",
            type: "session.model.selected",
            data: { sessionID: "ses-failed" },
          })
          yield* Effect.promise(() => nativePublished.promise)
          yield* Effect.promise(() => gapPublished.promise)
          yield* Effect.sync(() =>
            releaseInventory.resolve({ sessions: [nativeSession], truncated: false }),
          )
          return yield* Fiber.await(pendingRead)
        }),
      ),
    )
    // S8-1: non-destructive live reads do not reject a coherent older boundary.
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit))
      expect(LiveRadarOutput.parse(exit.value).boundary.eventSequence).toBe(0)
  } finally {
    fixture.close()
  }
})

test("S8-1 a held inventory read retains its consistent runner snapshot during writes", async () => {
  const fixture = makeFixture()
  const nativeSession = radarNativeSession(
    "ses-failed",
    "project",
    { providerID: "google", id: "gemini-current", variant: "high" },
    fixture.directory,
  )
  const inventoryStarted = Promise.withResolvers<void>()
  const releaseInventory = Promise.withResolvers<{
    sessions: RadarNativeSession[]
    truncated: boolean
  }>()
  const nativeHost: RadarSessionHost = {
    get: async () => nativeSession,
    project: async (_projectID, _includeArchived, _limit, signal) => {
      inventoryStarted.resolve()
      return await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener("abort", abort, { once: true })
        releaseInventory.promise.then((inventory) => {
          signal.removeEventListener("abort", abort)
          resolve(inventory)
        })
      })
    },
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(
    fixture.store,
    { session: async (sessionID) => fixture.host.session(sessionID) },
    "project",
    new Uint8Array(32).fill(78),
    nativeHost,
  )
  let handlers: LiveHandlers | undefined
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: LiveHandlers) => {
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
    event: { subscribe: () => Stream.never },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">

  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )
    const before = fixture.store.atomic(
      (db) =>
        db
          .query<{ revision: number }, [string]>(
            "SELECT revision FROM observation_revisions WHERE project_directory=?",
          )
          .get(fixture.directory)!.revision,
    )
    const pending = Effect.runFork(handlers!.liveRadar({ scope, includeUnmanagedSessions: true }))
    await Promise.race([
      inventoryStarted.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error("Native inventory did not reach the held boundary")
      }),
    ])
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?").run(firstAttemptID),
    )
    const after = fixture.store.atomic(
      (db) =>
        db
          .query<{ revision: number }, [string]>(
            "SELECT revision FROM observation_revisions WHERE project_directory=?",
          )
          .get(fixture.directory)!.revision,
    )
    expect(after).toBeGreaterThan(before)
    releaseInventory.resolve({ sessions: [nativeSession], truncated: false })
    const exit = await Effect.runPromise(Fiber.await(pending))
    // S8-1: WAL supplied a consistent snapshot; later writes do not invalidate it.
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit))
      expect(LiveRadarOutput.parse(exit.value).boundary.runnerRevision).toBe(before)
  } finally {
    fixture.close()
  }
})

test("journal hydration is capped across distinct sessions rather than starving later changes", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(77)
  const assignments = Array.from({ length: 17 }, (_value, index) => ({
    sessionID: `ses-hydration-${index}`,
    attemptID: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    messageID: `msg-hydration-${index}`,
  }))
  const nativeSessions = assignments.map(({ sessionID }) =>
    radarNativeSession(
      sessionID,
      "project",
      { providerID: "google", id: "gemini-current", variant: "high" },
      fixture.directory,
    ),
  )
  const nativeHost: RadarSessionHost = {
    get: async (sessionID) => nativeSessions.find((session) => session.id === sessionID) ?? null,
    project: async (_projectID, _includeArchived, limit) => ({
      sessions: nativeSessions.slice(0, limit),
      truncated: nativeSessions.length > limit,
    }),
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, nativeHost)
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  let handlers: LiveHandlers | undefined
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: LiveHandlers) => {
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
    event: { subscribe: () => Stream.never },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">

  try {
    fixture.store.atomic((db) => {
      const insertAttempt = db.query(
        `INSERT INTO runner_attempts(
           id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,
           policy,state,started_at,token_count,tool_count,retry_count,cost
         ) SELECT ?,plan_id,task_id,?, ?, ?,workspace,base_commit,artifact,policy,
                  'running',started_at,token_count,tool_count,retry_count,cost
             FROM runner_attempts WHERE id=?`,
      )
      for (const [index, assignment] of assignments.entries())
        insertAttempt.run(
          assignment.attemptID,
          index + 3,
          assignment.sessionID,
          assignment.messageID,
          firstAttemptID,
        )
    })

    for (const [index, assignment] of assignments.entries()) {
      const eventID = `evt-hydration-${index}`
      const messageID = `msg-hydration-step-${index}`
      const dedupeKey = `hydration-step-${index}`
      const payload = {
        status: "running",
        observations: [
          {
            source: "native-event",
            eventID,
            eventType: "session.step.started",
            at: 50_000 + index,
            status: "started",
            messageID,
            routeEvidence: { status: "identity-unavailable" },
            route: null,
          },
        ],
      }
      insertLiveProgress(fixture, {
        sessionID: assignment.sessionID,
        attemptID: assignment.attemptID,
        kind: "step",
        messageID,
        eventIDs: [eventID],
        at: 50_000 + index,
        dedupeKey,
        payload,
      })
      for (let recent = 0; recent < 17; recent++)
        insertLiveProgress(fixture, {
          sessionID: assignment.sessionID,
          attemptID: assignment.attemptID,
          kind: "step",
          messageID: `msg-hydration-recent-${index}-${recent}`,
          at: 60_000 + index * 17 + recent,
          dedupeKey: `hydration-recent-${index}-${recent}`,
          payload: {},
        })
    }
    fixture.store.atomic((db) => {
      const update = db.query(
        `UPDATE runner_progress SET payload=?
          WHERE project_directory=? AND attempt_id=? AND dedupe_key=?`,
      )
      for (const [index, assignment] of assignments.entries()) {
        update.run(
          JSON.stringify({
            status: "running",
            observations: [
              {
                source: "native-event",
                eventID: `evt-hydration-${index}`,
                eventType: "session.step.started",
                at: 50_000 + index,
                status: "started",
                messageID: `msg-hydration-step-${index}`,
                routeEvidence: { status: "identity-unavailable" },
                route: null,
              },
            ],
            hydrationUpdate: index,
          }),
          fixture.directory,
          assignment.attemptID,
          `hydration-step-${index}`,
        )
      }
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )
    const response = LiveRadarOutput.parse(
      await Effect.runPromise(handlers!.liveRadar({ scope, includeUnmanagedSessions: false })),
    )
    const hydratedEdges = response.flow.filter(
      (edge) => edge.sourceEventType === "session.step.started",
    )
    const hydratedEventIDs = hydratedEdges.map((edge) => edge.sourceEventID)
    expect(response.sessions).toHaveLength(18)
    expect(response.coverage.journalTruncated).toBe(true)
    expect(hydratedEventIDs).toHaveLength(16)
    expect(new Set(hydratedEventIDs).size).toBe(16)
    expect(new Set(hydratedEdges.map((edge) => edge.sessionID)).size).toBe(16)
    const omittedHydrationEvents = assignments
      .map((_assignment, index) => `evt-hydration-${index}`)
      .filter((eventID) => !hydratedEventIDs.includes(eventID))
    expect(omittedHydrationEvents).toHaveLength(1)
    expect(response.coverage.sourceRowsRead).toBeLessThanOrEqual(response.limits.sourceRows)
    expect(response.coverage.sourceBytesRead).toBeLessThanOrEqual(response.limits.sourceBytes)
    expect(response.coverage.nativeContextLoads).toBe(0)
  } finally {
    fixture.close()
  }
})
