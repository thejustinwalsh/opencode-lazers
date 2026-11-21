import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { ObservationReads } from "../../src/observability/read.ts"
import { registerObservability } from "../../src/observability/rpc.ts"
import { Tasks } from "../../src/tasks/contract.ts"
import { openStream } from "../../src/streams/client.ts"
import { acquireReaderPool } from "../../src/streams/pool.ts"
import "../../src/streams/sources/index.ts"
import { taskScheduleSource } from "../../src/streams/sources/tasks.ts"
import { registerTaskReads } from "../../src/tasks/rpc.ts"
import { getTaskDetail } from "../../src/tasks/stream-query.ts"
import type { TaskRuntime } from "../../src/runner/runtime.ts"
import { TaskRepository } from "../../src/storage.ts"
import { validProposal } from "../proposal.ts"
import { firstAttemptID, makeFixture, taskID } from "../trajectory/fixture.ts"

test("registered Tasks reads discover durable worker links without widening project scope", async () => {
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
        start(input: unknown): Effect.Effect<unknown>
      }
    | undefined
  const ctx = {
    rpc: {
      // registerTaskReads also registers the scheduling RPC; keep only the Tasks handlers.
      register: (definition: unknown, methods: typeof handlers) => {
        if (definition === Tasks) handlers = methods
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
          yield* registerTaskReads(ctx, fixture.repository, runtime)
        }),
      ),
    )
    expect(handlers).toBeDefined()
    // The list is the `tasks.schedule` stream: `authorize` forces the session view and the
    // project, and the session filter lists the tasks the session is linked to.
    await fixture.index()
    const lease = acquireReaderPool(fixture.repository.path)
    const context = {
      projectID: "project",
      projectDirectory: fixture.repository.projectDirectory,
      projectIds: (id: string) => [id],
      assertRead: async () => {},
    }
    const listed = async (sessionID: string, extra: object = {}) => {
      const filter = await taskScheduleSource.authorize!(
        { scope: { kind: "session", sessionID }, state: "all", ...extra } as never,
        context,
      )
      const stream = openStream(lease.pool, taskScheduleSource, {
        filter,
        order: "schedule",
        window: 20,
      })
      try {
        await stream.ready()
        return stream.items.map((row) => String(row.task_id))
      } finally {
        stream.close()
      }
    }
    try {
      expect(await listed("ses-failed")).toEqual([taskID])
      expect(await listed("ses-unrelated")).toEqual([])
      // A caller cannot widen the scope by naming another project in the filter.
      expect(await listed("ses-failed", { project: "/foreign-project" })).toEqual([taskID])
    } finally {
      lease.release()
    }
    // The detail read (`getTaskDetail`, which the Tasks.get RPC served before the streams) keeps
    // the same session and project scope.
    expect(
      await getTaskDetail(fixture.repository, { taskID, session: "ses-failed" }),
    ).toMatchObject({ status: "found", task: { id: taskID } })
    expect(await getTaskDetail(fixture.repository, { taskID, session: "ses-unrelated" })).toEqual({
      status: "not_found",
    })
    expect(
      await getTaskDetail(fixture.repository, { taskID: foreignTaskID, session: "ses-failed" }),
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
  let handlers:
    | {
        snapshot(input: unknown): Effect.Effect<unknown>
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

    denied = true
    await expect(Effect.runPromise(handlers!.snapshot({ scope }))).rejects.toThrow()
    denied = false
    foreign = true
    await expect(Effect.runPromise(handlers!.snapshot({ scope }))).rejects.toThrow(
      "Observation scope is unavailable",
    )
    foreign = false
    // Archived sessions stay readable (60ba858c); native permission still gates them.
    archived = true
    expect(await Effect.runPromise(handlers!.snapshot({ scope }))).toMatchObject({ scope })
    denied = true
    await expect(Effect.runPromise(handlers!.snapshot({ scope }))).rejects.toThrow()
    denied = false
    archived = false
  } finally {
    fixture.close()
  }
})

test("native event coverage is connected once the subscription is attached, before any event", () => {
  const fixture = makeFixture()
  try {
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(4),
      "project",
    )
    tracker.initialize()
    expect(tracker.hasConnectedEventStream).toBe(false)
    tracker.streamAttached()
    expect(tracker.hasConnectedEventStream).toBe(true)
    tracker.streamGap()
    expect(tracker.hasConnectedEventStream).toBe(false)
  } finally {
    fixture.close()
  }
})
