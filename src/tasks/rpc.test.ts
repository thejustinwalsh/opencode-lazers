import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import { validProposal } from "../../test/proposal.ts"
import { AssociationTaskReads } from "../observability/task-reads.ts"
import type { TaskRuntime } from "../runner/runtime.ts"
import { TaskRepository } from "../storage.ts"
import type { StartTaskInput, StartTaskResult } from "./contract.ts"
import { TaskReads } from "./read.ts"
import { registerTaskReads } from "./rpc.ts"

test("RPC invalidations catch independent connections and retry transient read and delivery failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-read-rpc-"))
  const path = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(path, "/project")
  const other = new TaskRepository(path, "/project")
  const versions: number[] = []
  let attempts = 0
  let failRead = false,
    failedReads = 0
  const version = repository.version.bind(repository)
  repository.version = () => {
    if (failRead) {
      failRead = false
      failedReads++
      throw new Error("temporary read failure")
    }
    return version()
  }
  const runtime = {
    host: { session: async () => null },
    projectID: "project",
    startTask: async (): Promise<StartTaskResult> => ({
      status: "started",
      planID: crypto.randomUUID(),
      state: "running",
    }),
  } as unknown as TaskRuntime
  const ctx = {
    rpc: {
      register: () =>
        Effect.succeed({
          dispose: Effect.void,
          events: {
            emit: (_name: string, event: { version: number }) =>
              Effect.sync(() => {
                attempts++
                if (attempts === 1) throw new Error("lost notification")
                versions.push(event.version)
              }),
          },
        }),
    },
    permission: { assert: () => Effect.void },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission">
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskReads(ctx, new TaskReads(repository), runtime)
          failRead = true
          other.insert({
            schemaVersion: 1,
            id: crypto.randomUUID(),
            revision: 1,
            status: "submitted",
            createdAt: new Date().toISOString(),
            proposal: validProposal(),
            provenance: {
              projectID: "global",
              projectDirectory: "/project",
              workspaceDirectory: "/other-worktree",
              sessionID: "other-session",
              startingRevision: { kind: "unborn" },
            },
          })
          yield* Effect.sleep(2_250)
          expect(attempts).toBeGreaterThanOrEqual(2)
          expect(failedReads).toBe(1)
          expect(versions).toEqual([other.version()])
          expect(() => other.insert({})).toThrow()
        }),
      ),
    )
    const after = attempts
    repository.close()
    await Bun.sleep(1_050)
    expect(attempts).toBe(after)
  } finally {
    other.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Tasks RPC restores persisted references on association-aware query summaries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-reference-rpc-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  const taskID = crypto.randomUUID()
  let query: ((input: unknown) => Effect.Effect<unknown, never>) | undefined
  let get: ((input: unknown) => Effect.Effect<unknown, never>) | undefined
  const ctx = {
    rpc: {
      register: (
        _contract: unknown,
        methods: {
          query: (input: unknown) => Effect.Effect<unknown, never>
          get: (input: unknown) => Effect.Effect<unknown, never>
        },
      ) => {
        query = methods.query
        get = methods.get
        return Effect.succeed({
          dispose: Effect.void,
          events: { emit: () => Effect.void },
        })
      },
    },
    permission: { assert: () => Effect.void },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission">
  const runtime = {
    host: { session: async () => null },
    projectID: "project",
    startTask: async () => ({ status: "started", planID: crypto.randomUUID(), state: "running" }),
  } as unknown as TaskRuntime

  try {
    repository.insert({
      schemaVersion: 1,
      id: taskID,
      revision: 1,
      status: "submitted",
      createdAt: new Date().toISOString(),
      proposal: validProposal(),
      provenance: {
        projectID: "project",
        projectDirectory: "/project",
        workspaceDirectory: "/project",
        sessionID: "owner-session",
        startingRevision: { kind: "unborn" },
      },
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskReads(ctx, new AssociationTaskReads(repository), runtime)
          const page = yield* query!({ sessionID: "owner-session" })
          expect(page).toMatchObject({
            tasks: [{ taskID, reference: "LZ-1" }],
          })
          const byReference = yield* get!({ taskID: "LZ-1", sessionID: "owner-session" })
          const byUUID = yield* get!({ taskID, sessionID: "owner-session" })
          const foreign = yield* get!({ taskID: "LZ-1", sessionID: "other-session" })
          expect(byReference).toMatchObject({
            status: "found",
            reference: "LZ-1",
            task: { id: taskID },
          })
          expect(byUUID).toEqual(byReference)
          expect(foreign).toEqual({ status: "not_found" })
        }),
      ),
    )
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Start RPC checks actor ownership and native permission before entering runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-start-rpc-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  const taskID = crypto.randomUUID()
  const planID = crypto.randomUUID()
  const checks: unknown[] = []
  let permitted = false
  let starts = 0
  let actor: { id: string; projectID: string; archived: boolean; agent: string } | null = {
    id: "ses_actor",
    projectID: "project",
    archived: false,
    agent: "architect",
  }
  let invokeStart: ((input: StartTaskInput) => Effect.Effect<StartTaskResult, Error>) | undefined
  const ctx = {
    rpc: {
      register: (
        _contract: unknown,
        methods: {
          start: (input: StartTaskInput) => Effect.Effect<StartTaskResult, Error>
        },
      ) => {
        invokeStart = methods.start
        return Effect.succeed({
          dispose: Effect.void,
          events: { emit: () => Effect.void },
        })
      },
    },
    permission: {
      assert: (permission: unknown) => {
        checks.push(permission)
        return permitted ? Effect.void : Effect.fail(new Error("native permission denied"))
      },
    },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission">
  const runtime = {
    projectID: "project",
    host: { session: async (sessionID: string) => (sessionID === actor?.id ? actor : null) },
    startTask: async () => {
      starts++
      return { status: "started", planID, state: "running" }
    },
  } as unknown as TaskRuntime
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskReads(ctx, new TaskReads(repository), runtime)
        }),
      ),
    )
    const input: StartTaskInput = { taskID, revision: 1, sessionID: "ses_actor" }
    const denied = await Effect.runPromise(invokeStart!(input)).then(
      () => null,
      (error: unknown) => error,
    )
    expect(denied).toBeInstanceOf(Error)
    expect(starts).toBe(0)
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({
      sessionID: "ses_actor",
      agent: "architect",
      action: "lz-start-task",
      resources: [taskID],
    })

    permitted = true
    expect(await Effect.runPromise(invokeStart!(input))).toEqual({
      status: "started",
      planID,
      state: "running",
    })
    expect(starts).toBe(1)

    actor = null
    const missing = await Effect.runPromise(invokeStart!(input)).then(
      () => null,
      (error: unknown) => error,
    )
    expect(missing).toBeInstanceOf(Error)
    expect(checks).toHaveLength(2)
    expect(starts).toBe(1)
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
