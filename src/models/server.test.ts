import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { registerModelTools } from "./tools.ts"
import type { ModelEvidenceFetcher } from "./source-refresh.ts"
import { registerModelsServer } from "./server.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]
type ModelRPC = {
  settings(input: unknown): Effect.Effect<unknown, unknown>
  configure(input: unknown): Effect.Effect<unknown, unknown>
  catalog(input: unknown): Effect.Effect<unknown, unknown>
  sourceEvidence(input: unknown): Effect.Effect<unknown, unknown>
  refreshSources(input: unknown): Effect.Effect<unknown, unknown>
}
type NativeSession = {
  id: string
  projectID: string
  agent: string | null
  time: { archived?: number }
}

const projectID = "project-id"
const projectDirectory = "/project"

function directory() {
  return mkdtempSync(join(tmpdir(), "lazers-model-rpc-"))
}

function makeTask(repository: TaskRepository, id = crypto.randomUUID()) {
  repository.insert({
    schemaVersion: 1,
    id,
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    proposal: validProposal(),
    provenance: {
      projectID,
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: repository.projectDirectory,
      sessionID: "task-owner",
      startingRevision: { kind: "unborn" },
    },
  })
  return id
}

function toolContext(agent = "architect") {
  return {
    sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))("ses-tool"),
    agent: Agent.ID.make(agent),
    messageID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
      "msg",
    ),
    id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))("call"),
    progress: () => Effect.void,
  } satisfies Parameters<RegisteredTool["execute"]>[1]
}

function registeredEditor() {
  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  return { tools, editor }
}

function modelContext(options: {
  actor?: NativeSession | null
  denied?: () => boolean
  catalogFailure?: () => boolean
  permissionCalls?: unknown[]
  permissionWait?: () => Effect.Effect<void>
  sourceAccessCalls?: { active: number; resolve: number }
}) {
  let actor: NativeSession | null = options.actor ?? {
    id: "ses-native",
    projectID,
    agent: "desktop-settings-user",
    time: {},
  }
  const permissionCalls = options.permissionCalls ?? []
  const sourceAccessCalls = options.sourceAccessCalls ?? { active: 0, resolve: 0 }
  const server: ModelRPC = {
    settings: () => Effect.die(new Error("RPC not registered")),
    configure: () => Effect.die(new Error("RPC not registered")),
    catalog: () => Effect.die(new Error("RPC not registered")),
    sourceEvidence: () => Effect.die(new Error("RPC not registered")),
    refreshSources: () => Effect.die(new Error("RPC not registered")),
  }
  let registered: ModelRPC | undefined
  const rpc = {
    register: (_contract: unknown, methods: ModelRPC) => {
      registered = methods
      Object.assign(server, methods)
      return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
    },
  }
  const context = {
    rpc,
    permission: {
      assert: (input: unknown) => {
        permissionCalls.push(input)
        return options.denied?.()
          ? Effect.fail(new Error("native permission denied"))
          : (options.permissionWait?.() ?? Effect.void)
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) => {
        if (!actor || actor.id !== sessionID)
          return Effect.fail(Object.assign(new Error("missing"), { _tag: "SessionNotFoundError" }))
        return Effect.succeed(actor)
      },
    },
    location: { project: { id: projectID, canonical: projectDirectory } },
    model: {
      list: () =>
        options.catalogFailure?.()
          ? Effect.fail(new Error("native catalog unavailable"))
          : Effect.succeed({ data: [] }),
    },
    integration: {
      connection: {
        active: () => {
          sourceAccessCalls.active += 1
          return Effect.succeed(undefined)
        },
        resolve: () => {
          sourceAccessCalls.resolve += 1
          return Effect.succeed(undefined)
        },
      },
    },
    agent: { get: () => Effect.succeed({ data: { model: null } }) },
  }
  return {
    context,
    server,
    methods: () => registered ?? server,
    setActor: (next: NativeSession | null) => {
      actor = next
    },
    permissionCalls,
    sourceAccessCalls,
  }
}

async function register(
  repository: TaskRepository,
  options: Parameters<typeof modelContext>[0] & { fetcher?: ModelEvidenceFetcher } = {},
) {
  const native = modelContext(options)
  const { tools, editor } = registeredEditor()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerModelsServer(native.context as never, repository, options.fetcher)
        yield* registerModelTools(
          {
            permission: native.context.permission,
            tool: {
              transform: (callback: (editor: ToolEditor) => void) =>
                Effect.sync(() => {
                  callback(editor)
                  return { dispose: Effect.void }
                }),
            },
          } as never,
          repository,
        )
      }),
    ),
  )
  return { ...native, tools }
}

async function rejects(effect: Effect.Effect<unknown, unknown>) {
  return Effect.runPromise(effect).then(
    () => {
      throw new Error("Expected operation to fail")
    },
    (error: unknown) => error,
  )
}

function tableExists(path: string, name: string) {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    return Boolean(
      db
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(name),
    )
  } finally {
    db.close()
  }
}

test("registered tool and Desktop RPC share exact persisted mappings after setup connection closes", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const taskID = makeTask(repository)
  const permissionCalls: unknown[] = []
  let catalogFailure = false
  const harness = await register(repository, {
    permissionCalls,
    catalogFailure: () => catalogFailure,
  })
  const methods = harness.methods()
  repository.close()

  const shared = {
    providerID: "unknown-shared-provider",
    id: "unknown-shared-model",
    variant: "native/shared",
  }
  const project = {
    providerID: "unknown-project-provider",
    id: "unknown-project-model",
    variant: "effort/project",
  }
  const task = {
    providerID: "unknown-task-provider",
    id: "unknown-task-model",
    variant: "native/task",
  }
  try {
    const toolWrite = await Effect.runPromise(
      harness.tools
        .get("lazers_configure_models")!
        .execute(
          { target: { scope: "shared" }, persona: "systems", expectedRevision: 0, route: shared },
          toolContext(),
        ),
    )
    expect(toolWrite.output).toMatchObject({
      status: "updated",
      mapping: { revision: 1, route: shared },
    })

    const firstRPCRead = await Effect.runPromise(
      methods.settings({ sessionID: "ses-native", taskID }),
    )
    expect(firstRPCRead).toMatchObject({ projectDirectory, taskID })
    const firstSystemSettings = (
      firstRPCRead as { personas: Array<{ persona: string; layers: unknown; resolution: unknown }> }
    ).personas.find((persona) => persona.persona === "systems")
    expect(firstSystemSettings).toMatchObject({
      layers: { task: null, project: null, shared: { revision: 1, route: shared } },
      resolution: { status: "assigned", route: shared, provenance: { revision: 1 } },
    })

    expect(
      await Effect.runPromise(
        methods.configure({
          sessionID: "ses-native",
          target: { scope: "project" },
          persona: "systems",
          expectedRevision: 0,
          route: project,
        }),
      ),
    ).toMatchObject({ status: "updated", mapping: { revision: 1, route: project } })
    expect(
      await Effect.runPromise(
        methods.configure({
          sessionID: "ses-native",
          target: { scope: "task", taskID },
          persona: "systems",
          expectedRevision: 0,
          route: task,
        }),
      ),
    ).toMatchObject({ status: "updated", mapping: { revision: 1, route: task } })

    const toolRead = await Effect.runPromise(
      harness.tools.get("lazers_get_model_settings")!.execute({ taskID }, toolContext()),
    )
    const toolSystemSettings = (
      toolRead.output as {
        personas: Array<{ persona: string; layers: unknown; resolution: unknown }>
      }
    ).personas.find((persona) => persona.persona === "systems")
    expect(toolSystemSettings).toMatchObject({
      layers: {
        task: { revision: 1, route: task },
        project: { revision: 1, route: project },
        shared: { revision: 1, route: shared },
      },
      resolution: { status: "assigned", route: task, provenance: { revision: 1 } },
    })

    expect(
      await Effect.runPromise(
        methods.configure({
          sessionID: "ses-native",
          target: { scope: "task", taskID },
          persona: "systems",
          expectedRevision: 1,
          route: null,
        }),
      ),
    ).toMatchObject({ status: "updated", mapping: { revision: 2, route: null } })
    const inherited = await Effect.runPromise(
      harness.tools.get("lazers_get_model_settings")!.execute({ taskID }, toolContext()),
    )
    const inheritedSystemSettings = (
      inherited.output as {
        personas: Array<{ persona: string; layers: unknown; resolution: unknown }>
      }
    ).personas.find((persona) => persona.persona === "systems")
    expect(inheritedSystemSettings).toMatchObject({
      layers: { task: { revision: 2, route: null }, project: { revision: 1, route: project } },
      resolution: {
        status: "assigned",
        route: project,
        provenance: { target: { scope: "project", projectDirectory }, revision: 1 },
      },
    })

    const conflict = await Effect.runPromise(
      harness.tools
        .get("lazers_configure_models")!
        .execute(
          { target: { scope: "project" }, persona: "systems", expectedRevision: 0, route: project },
          toolContext(),
        ),
    )
    expect(conflict.output).toMatchObject({
      status: "conflict",
      expectedRevision: 0,
      currentRevision: 1,
      current: { revision: 1, route: project },
    })

    expect(await Effect.runPromise(methods.catalog({ sessionID: "ses-native" }))).toMatchObject({
      source: "Live native OpenCode model catalog",
      advisoryOnly: true,
      configuredImplementor: null,
      options: [],
    })
    const savedSettings = await Effect.runPromise(
      methods.settings({ sessionID: "ses-native", taskID }),
    )
    catalogFailure = true
    const failedCatalog = await rejects(methods.catalog({ sessionID: "ses-native" }))
    expect(failedCatalog).toBeInstanceOf(Error)
    expect(savedSettings).toMatchObject({ projectDirectory, taskID })
    expect(
      await Effect.runPromise(methods.settings({ sessionID: "ses-native", taskID })),
    ).toMatchObject({ projectDirectory, taskID })
    expect(permissionCalls.map((entry) => (entry as { agent: string }).agent)).toContain(
      "desktop-settings-user",
    )

    const db = new Database(path, { readonly: true, strict: true })
    try {
      const rows = db
        .query<
          {
            scope: string
            project_directory: string
            task_id: string
            persona: string
            revision: number
            payload: string
          },
          []
        >(
          "SELECT scope, project_directory, task_id, persona, revision, payload FROM model_mappings ORDER BY scope, revision",
        )
        .all()
      expect(rows).toHaveLength(4)
      expect(rows.map(({ scope, revision }) => [scope, revision])).toEqual([
        ["project", 1],
        ["shared", 1],
        ["task", 1],
        ["task", 2],
      ])
      expect(rows.map(({ payload }) => JSON.parse(payload))).toEqual([
        expect.objectContaining({
          target: { scope: "project", projectDirectory },
          persona: "systems",
          revision: 1,
          route: project,
        }),
        expect.objectContaining({
          target: { scope: "shared" },
          persona: "systems",
          revision: 1,
          route: shared,
        }),
        expect.objectContaining({
          target: { scope: "task", projectDirectory, taskID },
          persona: "systems",
          revision: 1,
          route: task,
        }),
        expect.objectContaining({
          target: { scope: "task", projectDirectory, taskID },
          persona: "systems",
          revision: 2,
          route: null,
        }),
      ])
      const runnerTables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_%'",
        )
        .all()
      expect(runnerTables).toEqual([])
    } finally {
      db.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("RPC validates live native session and permission before any settings access or mutation", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const otherRepository = new TaskRepository(path, "/other-project")
  const foreignTaskID = makeTask(otherRepository)
  let denied = false
  const harness = await register(repository, {
    denied: () => denied,
  })
  const methods = harness.methods()
  repository.close()
  otherRepository.close()
  const write = (taskID: string) =>
    methods.configure({
      sessionID: "ses-native",
      target: { scope: "task", taskID },
      persona: "ui",
      expectedRevision: 0,
      route: { providerID: "private", id: "private-model" },
    })

  try {
    for (const invalidActor of [
      null,
      { id: "ses-native", projectID, agent: "desktop-settings-user", time: { archived: 10 } },
      { id: "ses-native", projectID: "foreign-project", agent: "desktop-settings-user", time: {} },
    ]) {
      harness.setActor(invalidActor)
      expect(await rejects(write(crypto.randomUUID()))).toBeInstanceOf(Error)
    }

    harness.setActor({ id: "ses-native", projectID, agent: "desktop-settings-user", time: {} })
    denied = true
    expect(await rejects(write(crypto.randomUUID()))).toMatchObject({
      message: "native permission denied",
    })
    denied = false
    expect(await rejects(write(foreignTaskID))).toMatchObject({
      message: "Task is unavailable in this project",
    })
    expect(await rejects(write(crypto.randomUUID()))).toMatchObject({
      message: "Task is unavailable in this project",
    })
    expect(tableExists(path, "model_mappings")).toBe(false)
    expect(harness.permissionCalls.map((entry) => (entry as { agent: string }).agent)).toEqual([
      "desktop-settings-user",
      "desktop-settings-user",
      "desktop-settings-user",
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("cancelled Desktop configuration cannot save a route after a late permission grant", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let grant!: () => void
  let interrupted = false
  const harness = await register(repository, {
    permissionWait: () =>
      Effect.callback<void>((resume) => {
        grant = () => resume(Effect.void)
        enter()
        return Effect.sync(() => {
          interrupted = true
        })
      }),
  })
  repository.close()
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    harness.methods().configure({
      sessionID: "ses-native",
      target: { scope: "project" },
      persona: "ui",
      expectedRevision: 0,
      route: { providerID: "private", id: "exact-model", variant: "high" },
    }),
    { signal: controller.signal },
  )
  try {
    await entered
    controller.abort()
    await pending
    grant()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tableExists(path, "model_mappings")).toBe(false)
    expect(interrupted).toBe(true)
  } finally {
    grant?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Models evidence RPC reads cached state without credentials and refreshes only after authorization", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const permissionCalls: unknown[] = []
  const sourceAccessCalls = { active: 0, resolve: 0 }
  const harness = await register(repository, {
    permissionCalls,
    sourceAccessCalls,
    fetcher: async (input, init) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/models")
      expect(init?.method).toBe("GET")
      expect(new Headers(init?.headers).get("authorization")).toBeNull()
      return new Response(JSON.stringify({ data: [] }))
    },
  })
  repository.close()
  const methods = harness.methods()
  try {
    const empty = (await Effect.runPromise(
      methods.sourceEvidence({ sessionID: "ses-native" }),
    )) as { sources: Array<{ source: string; state: string; latestSnapshotID: string | null }> }
    expect(empty.sources.map(({ state }) => state)).toEqual(["never", "never", "never"])
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })

    const refreshed = (await Effect.runPromise(
      methods.refreshSources({ sessionID: "ses-native" }),
    )) as {
      sources: Array<{
        source: string
        state: string
        errorCode: string | null
        latestSnapshotID: string | null
        latestRecordCount: number | null
      }>
    }
    expect(refreshed.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "native-catalog",
          state: "succeeded",
          latestRecordCount: 0,
        }),
        expect.objectContaining({
          source: "openrouter-models",
          state: "succeeded",
          latestRecordCount: 0,
        }),
        expect.objectContaining({
          source: "openrouter-benchmarks",
          state: "failed",
          errorCode: "missing-credentials",
        }),
      ]),
    )
    expect(sourceAccessCalls).toEqual({ active: 1, resolve: 0 })
    const nativeSnapshotID = refreshed.sources.find(
      ({ source }) => source === "native-catalog",
    )!.latestSnapshotID!
    expect(
      await Effect.runPromise(
        methods.sourceEvidence({ sessionID: "ses-native", snapshotID: nativeSnapshotID }),
      ),
    ).toMatchObject({
      snapshot: {
        snapshot: { snapshotID: nativeSnapshotID, source: "native-catalog", recordCount: 0 },
        records: [],
      },
    })
    expect(sourceAccessCalls).toEqual({ active: 1, resolve: 0 })
    expect(permissionCalls.map((entry) => (entry as { action: string }).action)).toEqual([
      "lazers_read_model_evidence",
      "lazers_refresh_model_evidence",
      "lazers_read_model_evidence",
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Models evidence denial, foreign and archived sessions do not initialize or access sources", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const permissionCalls: unknown[] = []
  const sourceAccessCalls = { active: 0, resolve: 0 }
  let denied = false
  const harness = await register(repository, {
    permissionCalls,
    sourceAccessCalls,
    denied: () => denied,
  })
  repository.close()
  const methods = harness.methods()
  try {
    for (const actor of [
      null,
      { id: "ses-native", projectID: "foreign-project", agent: "desktop-settings-user", time: {} },
      { id: "ses-native", projectID, agent: "desktop-settings-user", time: { archived: 10 } },
    ]) {
      harness.setActor(actor)
      expect(await rejects(methods.refreshSources({ sessionID: "ses-native" }))).toBeInstanceOf(
        Error,
      )
      expect(await rejects(methods.sourceEvidence({ sessionID: "ses-native" }))).toBeInstanceOf(
        Error,
      )
    }
    harness.setActor({ id: "ses-native", projectID, agent: "desktop-settings-user", time: {} })
    denied = true
    expect(await rejects(methods.refreshSources({ sessionID: "ses-native" }))).toMatchObject({
      message: "native permission denied",
    })
    expect(await rejects(methods.sourceEvidence({ sessionID: "ses-native" }))).toMatchObject({
      message: "native permission denied",
    })

    expect(tableExists(path, "model_evidence_snapshots")).toBe(false)
    expect(tableExists(path, "model_evidence_refreshes")).toBe(false)
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(permissionCalls).toHaveLength(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("cancelled Models source refresh stops after late permission and writes no source state", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let interrupted = false
  const sourceAccessCalls = { active: 0, resolve: 0 }
  const harness = await register(repository, {
    sourceAccessCalls,
    permissionWait: () =>
      Effect.callback<void>((resume) => {
        enter()
        return Effect.sync(() => {
          interrupted = true
          resume(Effect.void)
        })
      }),
  })
  repository.close()
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    harness.methods().refreshSources({ sessionID: "ses-native" }),
    { signal: controller.signal },
  )
  try {
    await entered
    controller.abort()
    await pending
    expect(interrupted).toBe(true)
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(tableExists(path, "model_evidence_snapshots")).toBe(false)
    expect(tableExists(path, "model_evidence_refreshes")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
