import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { AssociationTaskReads } from "../../src/observability/task-reads.ts"
import { ObservationReads } from "../../src/observability/read.ts"
import { registerObservability } from "../../src/observability/rpc.ts"
import type { RadarNativeSession, RadarSessionHost } from "../../src/observability/native.ts"
import { registerTaskReads } from "../../src/tasks/rpc.ts"
import type { TaskRuntime } from "../../src/runner/runtime.ts"
import { TaskRepository } from "../../src/storage.ts"
import { validProposal } from "../proposal.ts"
import { firstAttemptID, makeFixture, taskID } from "../trajectory/fixture.ts"

test("registered Tasks RPC discovers durable worker links without widening project scope", async () => {
  const fixture = makeFixture()
  const foreignRepository = new TaskRepository(fixture.repository.path, "/foreign-project")
  const foreignTaskID = crypto.randomUUID()
  foreignRepository.insert({
    schemaVersion: 1,
    id: foreignTaskID,
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "foreign-project",
      projectDirectory: "/foreign-project",
      workspaceDirectory: "/foreign-project",
      sessionID: "ses-failed",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  })
  let handlers:
    | {
        query(input: unknown): Effect.Effect<unknown>
        get(input: unknown): Effect.Effect<unknown>
      }
    | undefined
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: typeof handlers) => {
        handlers = methods
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
      },
    },
    permission: { assert: () => Effect.void },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission">
  const runtime = { projectID: "project" } as TaskRuntime
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskReads(ctx, new AssociationTaskReads(fixture.repository), runtime)
        }),
      ),
    )
    expect(handlers).toBeDefined()
    const workerQuery = (await Effect.runPromise(
      handlers!.query({ sessionID: "ses-failed", limit: 20, includeCompleted: true }),
    )) as { tasks: Array<{ taskID: string }> }
    expect(workerQuery.tasks.map((item) => item.taskID)).toEqual([taskID])
    expect(
      await Effect.runPromise(handlers!.get({ taskID, sessionID: "ses-failed" })),
    ).toMatchObject({ status: "found", task: { id: taskID } })
    expect(
      await Effect.runPromise(handlers!.query({ sessionID: "ses-unrelated", limit: 20 })),
    ).toMatchObject({ count: 0, tasks: [] })
    expect(await Effect.runPromise(handlers!.get({ taskID, sessionID: "ses-unrelated" }))).toEqual({
      status: "not_found",
    })
    expect(
      await Effect.runPromise(handlers!.get({ taskID: foreignTaskID, sessionID: "ses-failed" })),
    ).toEqual({ status: "not_found" })
  } finally {
    foreignRepository.close()
    fixture.close()
  }
})

test("registered observation RPC resolves scope through native sessions and enforces permission", async () => {
  const fixture = makeFixture()
  const permissionCalls: unknown[] = []
  let denied = false
  let foreign = false
  let archived = false
  const nativeMetadataReads: string[] = []
  const radarSessions: RadarSessionHost = {
    get: async (id): Promise<RadarNativeSession> => {
      nativeMetadataReads.push(id)
      return {
        id,
        projectID: "project",
        parentID: id === "ses-failed" ? "ses-owner" : null,
        directory: fixture.directory,
        agent: "architect",
        model: { providerID: "openai", id: "gpt-6-luna", variant: null },
        archived: false,
        busy: false,
        createdAt: 1_000,
        updatedAt: 2_000,
      }
    },
    project: async () => ({ sessions: [], truncated: false }),
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  let handlers:
    | {
        snapshot(input: unknown): Effect.Effect<unknown>
        radar(input: unknown): Effect.Effect<unknown>
        trajectory(input: unknown): Effect.Effect<unknown>
      }
    | undefined
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
          projectID: foreign ? "another-project" : "project",
          agent: "architect",
          time: { archived: archived ? 1 : undefined },
        }),
    },
    permission: {
      assert: (input: unknown) => {
        permissionCalls.push(input)
        return denied ? Effect.fail(new Error("native permission denied")) : Effect.void
      },
    },
    event: { subscribe: () => Stream.empty },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(
            ctx,
            new ObservationReads(
              fixture.store,
              fixture.host,
              "project",
              new Uint8Array(32).fill(4),
              radarSessions,
            ),
            "project",
          )
        }),
      ),
    )
    const scope = { kind: "session" as const, sessionID: "ses-failed" }
    expect(await Effect.runPromise(handlers!.snapshot({ scope }))).toMatchObject({
      scope,
      plans: [{ nodes: [{ taskID }] }],
    })
    expect(
      await Effect.runPromise(
        handlers!.snapshot({ scope: { kind: "project", sessionID: "ses-failed" } }),
      ),
    ).toMatchObject({ scope: { kind: "project" }, plans: [{ nodes: [{ taskID }] }] })
    expect(permissionCalls.at(-1)).toMatchObject({
      sessionID: "ses-failed",
      agent: "architect",
      action: "read",
      resources: [fixture.repository.projectDirectory],
    })

    const radar = await Effect.runPromise(handlers!.radar({ scope }))
    expect((radar as { scope: unknown }).scope).toEqual(scope)
    expect(
      (radar as { sessions: Array<{ sessionID: string }> }).sessions
        .map((session) => session.sessionID)
        .sort(),
    ).toEqual(["ses-accepted", "ses-failed", "ses-owner"])
    expect(
      (radar as { sessions: Array<{ sessionID: string; availability: string }> }).sessions.find(
        (session) => session.sessionID === "ses-failed",
      )?.availability,
    ).toBe("available")
    const projectRadar = (await Effect.runPromise(
      handlers!.radar({ scope: { kind: "project", sessionID: "ses-failed" } }),
    )) as { sessions: Array<{ sessionID: string }> }
    expect(projectRadar.sessions.map((session) => session.sessionID).sort()).toEqual([
      "ses-accepted",
      "ses-failed",
      "ses-owner",
    ])
    expect(permissionCalls.at(-1)).toMatchObject({
      sessionID: "ses-failed",
      action: "read",
      resources: [fixture.repository.projectDirectory],
    })

    denied = true
    await expect(Effect.runPromise(handlers!.snapshot({ scope }))).rejects.toThrow()
    const readsBeforeDeniedRadar = nativeMetadataReads.length
    await expect(
      Effect.runPromise(handlers!.radar({ scope, includeUnmanagedSessions: false })),
    ).rejects.toThrow()
    expect(nativeMetadataReads).toHaveLength(readsBeforeDeniedRadar)
    denied = false
    foreign = true
    await expect(Effect.runPromise(handlers!.snapshot({ scope }))).rejects.toThrow(
      "Observation scope is unavailable",
    )
    const readsBeforeForeignRadar = nativeMetadataReads.length
    await expect(
      Effect.runPromise(handlers!.radar({ scope, includeUnmanagedSessions: false })),
    ).rejects.toThrow("Observation scope is unavailable")
    expect(nativeMetadataReads).toHaveLength(readsBeforeForeignRadar)
    foreign = false
    archived = true
    await expect(Effect.runPromise(handlers!.snapshot({ scope }))).rejects.toThrow(
      "Observation scope is unavailable",
    )
    archived = false

    const review = await Effect.runPromise(
      handlers!.trajectory({ scope, attemptID: firstAttemptID, limit: 20 }),
    )
    expect(review).toMatchObject({ scope, report: { focusedAttemptID: firstAttemptID } })
    expect(permissionCalls.at(-1)).toMatchObject({
      action: "lz-inspect-trajectory",
      resources: ["*"],
    })
  } finally {
    fixture.close()
  }
})

test("registered targeted trajectory RPCs remain usable when broad history is over its cap", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(23)
  const reads = new ObservationReads(
    fixture.store,
    {
      session: (id) => fixture.host.session(id),
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
        snapshot(input: unknown): Effect.Effect<unknown>
        trajectory(input: unknown): Effect.Effect<unknown>
        trajectoryHistory(
          input: unknown,
          context: { error(type: string, message: string, data: unknown): unknown },
        ): Effect.Effect<unknown, unknown>
        trajectoryStatus(input: unknown): Effect.Effect<unknown>
      }
    | undefined
  const permissionCalls: string[] = []
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
    permission: {
      assert: (input: { action: string }) => {
        permissionCalls.push(input.action)
        return Effect.void
      },
    },
    event: { subscribe: () => Stream.empty },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">

  try {
    const unrelatedTransitions = JSON.stringify(Array.from({ length: 10_001 }, (_, index) => index))
    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
           SELECT ?,NULL,1,'UNRELATED','{}',5000+CAST(key AS INTEGER) FROM json_each(?)`,
        )
        .run(fixture.receipt.planID, unrelatedTransitions),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )
    const scope = { kind: "project" as const, sessionID: "ses-owner" }
    // S8-2: broad history is bounded; targeted RPCs still read their exact scope.
    const snapshot = (await Effect.runPromise(handlers!.snapshot({ scope }))) as {
      transitions: unknown[]
      coverage: { transitionsTruncated: boolean }
    }
    expect(snapshot.transitions).toHaveLength(10_000)
    expect(snapshot.coverage.transitionsTruncated).toBe(true)

    const maxSequence = fixture.store.atomic(
      (db) =>
        db
          .query<{ sequence: number }, [string]>(
            "SELECT MAX(id) AS sequence FROM runner_transitions WHERE plan_id=?",
          )
          .get(fixture.receipt.planID)!.sequence,
    )
    const trajectory = (await Effect.runPromise(
      handlers!.trajectory({ scope, attemptID: firstAttemptID, limit: 20 }),
    )) as { boundary: { transitionSequence: number }; report: { focusedAttemptID: string } }
    expect(trajectory.boundary.transitionSequence).toBe(maxSequence)
    expect(trajectory.report.focusedAttemptID).toBe(firstAttemptID)

    const rpcContext = {
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    }
    const first = (await Effect.runPromise(
      handlers!.trajectoryHistory({ scope, taskID, limit: 2 }, rpcContext),
    )) as {
      boundary: { transitionSequence: number }
      capturedAt: number
      eventIDs: string[]
      report: { trajectory: { nextCursor: string | null } }
    }
    expect(first.boundary.transitionSequence).toBe(maxSequence)
    expect(first.report.trajectory.nextCursor).not.toBeNull()

    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
           VALUES(?,NULL,1,'UNRELATED','{}',20000)`,
        )
        .run(fixture.receipt.planID),
    )
    const second = (await Effect.runPromise(
      handlers!.trajectoryHistory(
        { scope, taskID, limit: 2, cursor: first.report.trajectory.nextCursor! },
        rpcContext,
      ),
    )) as { boundary: { transitionSequence: number }; capturedAt: number; report: unknown }
    expect(second.capturedAt).toBe(first.capturedAt)
    expect(second.boundary.transitionSequence).toBe(first.boundary.transitionSequence)
    expect(JSON.stringify(second.report)).not.toContain("UNRELATED")

    const status = (await Effect.runPromise(handlers!.trajectoryStatus({ scope, taskID }))) as {
      boundary: { transitionSequence: number }
      report: {
        effort: {
          tokenUsage: {
            totalSessions: number
            total: {
              uncachedInput: number
              cacheRead: number
              cacheWrite: number
              output: number
              reasoning: number
            } | null
          }
        }
      }
    }
    expect(status.boundary.transitionSequence).toBeGreaterThan(maxSequence)
    expect(status.report.effort.tokenUsage).toMatchObject({
      totalSessions: 2,
      total: { uncachedInput: 30, cacheRead: 12, cacheWrite: 1, output: 7, reasoning: 5 },
    })
    expect(permissionCalls).toEqual([
      "read",
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
    ])
  } finally {
    fixture.close()
  }
})
