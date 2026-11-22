import { expect, spyOn, test } from "bun:test"
import { ARCHIVED_SESSION_MESSAGE } from "../session-archived.ts"
import { Database } from "bun:sqlite"
import { Location } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { validProposal } from "../../test/proposal.ts"
import type { TaskRuntime } from "../runner/runtime.ts"
import { TaskRepository } from "../storage.ts"
import { Tasks } from "./contract.ts"
import type { StartTaskInput, StartTaskResult } from "./contract.ts"
import { registerTaskReads } from "./rpc.ts"
import { getTaskDetail } from "./stream-query.ts"
import { taskInstructions } from "./instructions.ts"
import { registerTaskTools } from "../tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

function toolContext(
  agent: string,
  sessionID = "native-session",
): Parameters<RegisteredTool["execute"]>[1] {
  return { sessionID, agent } as Parameters<RegisteredTool["execute"]>[1]
}

function taskToolDomain(onAdd: (tool: RegisteredTool) => void = () => {}) {
  const editor: ToolEditor = {
    add: onAdd,
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  return {
    transform: (callback: (editor: ToolEditor) => void) =>
      Effect.sync(() => {
        callback(editor)
        return { dispose: Effect.void }
      }),
  }
}

test("fourteen loaded locations publish one project task revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-read-rpc-fanout-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/fanout-project")
  const versions: number[] = []
  const runtime = {
    projectID: "project",
    host: { session: async () => null },
  } as unknown as TaskRuntime
  const ctx = {
    rpc: {
      register: () =>
        Effect.succeed({
          dispose: Effect.void,
          events: {
            emit: (_name: string, event: { version: number }) =>
              Effect.sync(() => {
                versions.push(event.version)
              }),
          },
        }),
    },
    permission: { assert: () => Effect.void },
    tool: taskToolDomain(),
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "tool">
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          for (let i = 0; i < 14; i++) yield* registerTaskReads(ctx, repository, runtime)
          repository.insert({
            schemaVersion: 1,
            id: crypto.randomUUID(),
            revision: 1,
            status: "submitted",
            createdAt: new Date().toISOString(),
            proposal: validProposal(),
            provenance: {
              projectID: "project",
              projectDirectory: repository.projectDirectory,
              workspaceDirectory: "/worker",
              sessionID: "worker",
              startingRevision: { kind: "unborn" },
            },
          })
          yield* Effect.sleep(100)
          expect(versions).toEqual([repository.version()])
        }),
      ),
    )
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

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
    tool: taskToolDomain(),
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "tool">
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskReads(ctx, repository, runtime)
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

test("native advice attachment is Architect-only, replay-safe, and returned through task reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-advice-rpc-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    proposal: validProposal(),
    provenance: {
      projectID: "project",
      projectDirectory: "/project",
      workspaceDirectory: "/project",
      sessionID: "submitter-session",
      startingRevision: { kind: "unborn" },
    },
  })
  const registeredTools = new Map<string, RegisteredTool>()
  const permissionActions: string[] = []
  let permitted = true
  const ctx = {
    rpc: {
      register: () => {
        return Effect.succeed({
          dispose: Effect.void,
          events: { emit: () => Effect.void },
        })
      },
    },
    permission: {
      assert: ({ action }: { action: string }) => {
        permissionActions.push(action)
        return permitted ? Effect.void : Effect.fail(new Error("native permission denied"))
      },
    },
    tool: taskToolDomain((tool) => registeredTools.set(tool.name, tool)),
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "tool">
  const location = Schema.decodeUnknownSync(Location.Info)({
    directory: "/project",
    project: { id: "project", directory: "/project", canonical: "/project" },
  })
  const taskToolContext = { location, permission: ctx.permission, tool: ctx.tool }
  const runtime = {
    host: { session: async () => null },
    projectID: "project",
    startTask: async () => ({ status: "started", planID: crypto.randomUUID(), state: "running" }),
  } as unknown as TaskRuntime

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskTools(taskToolContext, repository)
          yield* registerTaskReads(ctx, repository, runtime)
        }),
      ),
    )
    const attach = registeredTools.get("lz-attach-task-advice")!
    expect(attach.options).toMatchObject({
      codemode: true,
      permission: "lz-attach-task-advice",
    })
    const original = {
      taskID: task.id,
      specRevision: 1,
      requestID: "native-advice-1",
      expectedRevision: 0,
      findings: ["Find the existing transactional write boundary."],
      implementationAdvice: ["Keep this note advisory and outside TaskSpec."],
      references: [{ kind: "source", reference: "src/tasks/read.ts" }],
    }
    const query = spyOn(Database.prototype, "query")
    const exec = spyOn(Database.prototype, "exec")
    try {
      permitted = false
      for (const input of [
        original,
        original,
        { ...original, implementationAdvice: ["Changed replay content."] },
      ])
        await expect(
          Effect.runPromise(attach.execute(input, toolContext("architect"))),
        ).rejects.toThrow("native permission denied")
      permitted = true
      for (const input of [
        original,
        original,
        { ...original, implementationAdvice: ["Changed replay content."] },
      ])
        await expect(
          Effect.runPromise(attach.execute(input, toolContext("lazers-implementor"))),
        ).rejects.toThrow("restricted to Architect")
      expect(query).not.toHaveBeenCalled()
      expect(exec).not.toHaveBeenCalled()
    } finally {
      query.mockRestore()
      exec.mockRestore()
    }

    const firstResult = await Effect.runPromise(attach.execute(original, toolContext("architect")))
    expect(firstResult).not.toHaveProperty("output")
    const first = JSON.parse(String(firstResult.content))
    expect(first).toMatchObject({
      status: "recorded",
      advice: {
        revision: 1,
        projectDirectory: "/project",
        taskID: task.id,
        provenance: { sessionID: "native-session", agent: "architect" },
      },
    })
    const replayResult = await Effect.runPromise(attach.execute(original, toolContext("architect")))
    expect(JSON.parse(String(replayResult.content)).status).toBe("replayed")
    expect(
      JSON.parse(
        String(
          (
            await Effect.runPromise(
              attach.execute(
                { ...original, implementationAdvice: ["Changed replay content."] },
                toolContext("architect"),
              ),
            )
          ).content,
        ),
      ),
    ).toMatchObject({ status: "conflict" })

    const correction = await Effect.runPromise(
      attach.execute(
        {
          // No specRevision and no expectedRevision: advice attaches to the current
          // specification and appends to the current advice history.
          taskID: task.id,
          requestID: "native-advice-2",
          references: [],
          findings: ["The current advice supersedes the earlier note."],
          implementationAdvice: ["Read the effective advice before implementing."],
        },
        toolContext("architect"),
      ),
    )
    expect(JSON.parse(String(correction.content))).toMatchObject({
      status: "recorded",
      advice: { revision: 2, specRevision: 1 },
    })
    const detail = await getTaskDetail(repository, { taskID: task.id })
    expect(detail).toMatchObject({
      status: "found",
      task: { id: task.id, revision: 1 },
      advice: {
        current: {
          revision: 2,
          findings: ["The current advice supersedes the earlier note."],
        },
        history: [{ revision: 1 }, { revision: 2 }],
      },
    })
    expect(taskInstructions(detail as Parameters<typeof taskInstructions>[0])).toContain(
      "Task-attached advice (advisory, revision 2)",
    )
    expect(taskInstructions(detail as Parameters<typeof taskInstructions>[0])).not.toContain(
      "Find the existing transactional write boundary.",
    )
    repository.close()
    const structured = await Effect.runPromise(
      registeredTools
        .get("lz-get-task")!
        .execute(
          { taskID: task.id, format: "structured" },
          toolContext("lazers-implementor", "current-worker"),
        ),
    )
    expect(structured.output).toMatchObject({
      status: "found",
      advice: {
        current: { revision: 2, provenance: { sessionID: "native-session", agent: "architect" } },
        history: [{ revision: 1 }, { revision: 2 }],
      },
    })
    const readable = await Effect.runPromise(
      registeredTools
        .get("lz-get-task")!
        .execute({ taskID: task.id }, toolContext("lazers-implementor", "current-worker")),
    )
    expect(typeof readable.output).toBe("string")
    expect(readable.output).toContain("Task-attached advice (advisory, revision 2)")
    expect(readable.output).toContain("Read the effective advice before implementing.")
    expect(readable.output).not.toContain("Find the existing transactional write boundary.")
    const replacementReadable = await Effect.runPromise(
      registeredTools
        .get("lz-get-task")!
        .execute({ taskID: task.id }, toolContext("lazers-implementor", "replacement-worker")),
    )
    expect(replacementReadable.output).toBe(readable.output)
    expect(permissionActions).toEqual([
      ...Array(10).fill("lz-attach-task-advice"),
      "lz-get-task",
      "lz-get-task",
      "lz-get-task",
    ])
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
        contract: unknown,
        methods: {
          start: (input: StartTaskInput) => Effect.Effect<StartTaskResult, Error>
        },
      ) => {
        if ((contract as { id?: string }).id === Tasks.id) invokeStart = methods.start
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
    tool: taskToolDomain(),
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "tool">
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
          yield* registerTaskReads(ctx, repository, runtime)
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

    // A change from an archived session is refused with the plain reason, before any permission.
    actor = { ...actor!, archived: true }
    const archived = await Effect.runPromise(invokeStart!(input)).then(
      () => null,
      (error: unknown) => error,
    )
    expect(archived).toMatchObject({ message: ARCHIVED_SESSION_MESSAGE })
    expect(checks).toHaveLength(2)
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
