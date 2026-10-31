import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { AssociationTaskReads } from "../../src/observability/task-reads.ts"
import { ObservationReads } from "../../src/observability/read.ts"
import { registerObservability } from "../../src/observability/rpc.ts"
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
  let handlers:
    | {
        snapshot(input: unknown): Effect.Effect<unknown>
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
      action: "lazers_inspect_trajectory",
      resources: ["*"],
    })
  } finally {
    fixture.close()
  }
})
