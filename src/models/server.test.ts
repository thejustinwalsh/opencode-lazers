import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import captured from "../../test/models-identity/fixtures/captured-20261103.json" with { type: "json" }
import capturedAnthropicAliases from "../../test/models-identity/fixtures/captured-anthropic-aliases-20261103.json" with { type: "json" }
import { TaskRepository } from "../storage.ts"
import { registerModelTools } from "./tools.ts"
import type { ModelEvidenceFetcher } from "./source-refresh.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"
import { ModelEvidenceSnapshotSchema } from "./source-schema.ts"
import { registerModelsServer } from "./server.ts"
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]
type ModelRPC = {
  settings(input: unknown): Effect.Effect<unknown, unknown>
  configure(input: unknown): Effect.Effect<unknown, unknown>
  catalog(input: unknown): Effect.Effect<unknown, unknown>
  sourceEvidence(input: unknown): Effect.Effect<unknown, unknown>
  comparison(input: unknown): Effect.Effect<unknown, unknown>
  modelGroups(input: unknown): Effect.Effect<unknown, unknown>
  modelConfigurations(input: unknown): Effect.Effect<unknown, unknown>
  priceSources(input: unknown): Effect.Effect<unknown, unknown>
  configurePriceSources(input: unknown): Effect.Effect<unknown, unknown>
  refreshSources(input: unknown): Effect.Effect<unknown, unknown>
  overview(input: unknown): Effect.Effect<unknown, unknown>
  rows(input: unknown): Effect.Effect<unknown, unknown>
  configurations(input: unknown): Effect.Effect<unknown, unknown>
  inspect(input: unknown): Effect.Effect<unknown, unknown>
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
  sourceConnections?: Record<string, unknown>
  sourceAccessFailure?: () => boolean
  storage?: Map<string, unknown>
  storageCalls?: { get: number; set: number }
}) {
  let actor: NativeSession | null = options.actor ?? {
    id: "ses-native",
    projectID,
    agent: "desktop-settings-user",
    time: {},
  }
  const permissionCalls = options.permissionCalls ?? []
  const sourceAccessCalls = options.sourceAccessCalls ?? { active: 0, resolve: 0 }
  const sourceConnections = options.sourceConnections ?? {}
  const storage = options.storage ?? new Map<string, unknown>()
  const storageCalls = options.storageCalls ?? { get: 0, set: 0 }
  const modelListCalls = { count: 0 }
  const server: ModelRPC = {
    settings: () => Effect.die(new Error("RPC not registered")),
    configure: () => Effect.die(new Error("RPC not registered")),
    catalog: () => Effect.die(new Error("RPC not registered")),
    sourceEvidence: () => Effect.die(new Error("RPC not registered")),
    comparison: () => Effect.die(new Error("RPC not registered")),
    modelGroups: () => Effect.die(new Error("RPC not registered")),
    modelConfigurations: () => Effect.die(new Error("RPC not registered")),
    priceSources: () => Effect.die(new Error("RPC not registered")),
    configurePriceSources: () => Effect.die(new Error("RPC not registered")),
    refreshSources: () => Effect.die(new Error("RPC not registered")),
    overview: () => Effect.die(new Error("RPC not registered")),
    rows: () => Effect.die(new Error("RPC not registered")),
    configurations: () => Effect.die(new Error("RPC not registered")),
    inspect: () => Effect.die(new Error("RPC not registered")),
  }
  let registered: ModelRPC | undefined
  const rpc = {
    register: (_contract: unknown, methods: ModelRPC) => {
      registered = Object.assign(registered ?? ({} as ModelRPC), methods)
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
      list: () => {
        modelListCalls.count += 1
        return options.catalogFailure?.()
          ? Effect.fail(new Error("native catalog unavailable"))
          : Effect.succeed({ data: [] })
      },
    },
    integration: {
      connection: {
        active: (integrationID: string) => {
          sourceAccessCalls.active += 1
          if (options.sourceAccessFailure?.())
            return Effect.fail(new Error("provider metadata contained secret credential-value"))
          return Effect.succeed(sourceConnections[integrationID] as never)
        },
        resolve: () => {
          sourceAccessCalls.resolve += 1
          return Effect.succeed(undefined)
        },
      },
    },
    storage: {
      get: (key: string) => {
        storageCalls.get += 1
        return Effect.succeed(storage.get(key))
      },
      set: (key: string, value: unknown) => {
        storageCalls.set += 1
        return Effect.sync(() => {
          storage.set(key, value)
        })
      },
      remove: () => Effect.void,
      scan: () => Effect.succeed({ entries: [] }),
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
    modelListCalls,
    storage,
    storageCalls,
  }
}

async function register(
  repository: TaskRepository,
  options: Parameters<typeof modelContext>[0] & {
    fetcher?: ModelEvidenceFetcher
    evidenceReadStoreFactory?: Parameters<typeof registerModelsServer>[3]
  } = {},
) {
  const native = modelContext(options)
  const { tools, editor } = registeredEditor()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerModelsServer(
          native.context as never,
          repository,
          options.fetcher,
          options.evidenceReadStoreFactory,
        )
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

function writeCapturedModelEvidence(path: string) {
  const native = ModelEvidenceSnapshotSchema.parse(captured.native.snapshot)
  const catalog = ModelEvidenceSnapshotSchema.parse(captured.openrouter.snapshot)
  if (native.source !== "native-catalog" || catalog.source !== "openrouter-models")
    throw new Error("Captured model identity fixture has an unexpected source")
  const store = new ModelEvidenceStore(path, projectDirectory)
  try {
    for (let index = 0; index < 5; index += 1) store.beginRefresh()
    store.saveSnapshot({ ...native, projectDirectory, generation: 5 })
    store.saveSnapshot({ ...catalog, projectDirectory, generation: 5 })
  } finally {
    store.close()
  }
}

function writeCapturedAnthropicAliasEvidence(path: string) {
  const baseNative = ModelEvidenceSnapshotSchema.parse(captured.native.snapshot)
  const catalog = ModelEvidenceSnapshotSchema.parse(captured.openrouter.snapshot)
  const aliases = ModelEvidenceSnapshotSchema.parse(capturedAnthropicAliases.native.snapshot)
  if (
    baseNative.source !== "native-catalog" ||
    catalog.source !== "openrouter-models" ||
    aliases.source !== "native-catalog"
  )
    throw new Error("Captured model identity fixture has an unexpected source")
  const store = new ModelEvidenceStore(path, projectDirectory)
  try {
    for (let index = 0; index < 5; index += 1) store.beginRefresh()
    store.saveSnapshot({
      ...baseNative,
      projectDirectory,
      generation: 5,
      records: [...baseNative.records, ...aliases.records],
    })
    store.saveSnapshot({ ...catalog, projectDirectory, generation: 5 })
  } finally {
    store.close()
  }
}

function capturedReadStoreFactory(path: string, directory: string, includeAliases = false) {
  return {
    projectDirectory: directory,
    readComparisonSources: (
      selection?: Parameters<ModelEvidenceReadStore["readComparisonSources"]>[0],
    ) => {
      const reader = new ModelEvidenceReadStore(path, directory)
      try {
        return reader.readComparisonSources(selection).map((source) => {
          if (source.source === "native-catalog" && source.snapshot?.source === "native-catalog")
            return {
              ...source,
              recordIndexes: includeAliases
                ? [
                    ...captured.native.originalRecordIndices,
                    ...capturedAnthropicAliases.native.originalRecordIndices,
                  ]
                : captured.native.originalRecordIndices,
            }
          if (
            source.source === "openrouter-models" &&
            source.snapshot?.source === "openrouter-models"
          )
            return { ...source, recordIndexes: captured.openrouter.originalRecordIndices }
          return source
        })
      } finally {
        reader.close()
      }
    },
    close: () => {},
  }
}

function capturedAliasReadStoreFactory(path: string, directory: string) {
  return capturedReadStoreFactory(path, directory, true)
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
        .get("lz-configure-models")!
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
      harness.tools.get("lz-get-model-settings")!.execute({ taskID }, toolContext()),
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
      harness.tools.get("lz-get-model-settings")!.execute({ taskID }, toolContext()),
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
        .get("lz-configure-models")!
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

test("price-source settings persist an ordered whole-model policy without changing model routes or exposing credentials", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const storage = new Map<string, unknown>()
  const sourceAccessCalls = { active: 0, resolve: 0 }
  const sourceConnections = {
    openrouter: { id: "credential-record", label: "secret credential-value" },
    opencode: {
      id: "another-credential-record",
      status: { status: "needs_auth", message: "secret credential-value" },
    },
  }
  const harness = await register(repository, {
    storage,
    sourceConnections,
    sourceAccessCalls,
  })
  repository.close()
  const methods = harness.methods()

  try {
    const initial = await Effect.runPromise(methods.priceSources({ sessionID: "ses-native" }))
    expect(initial).toMatchObject({
      policy: {
        schemaVersion: 1,
        revision: 0,
        sources: ["openrouter", "opencode"],
        fallback: "whole-model",
      },
      access: { openrouter: "configured", opencode: "reauthentication-required" },
    })
    expect(JSON.stringify(initial)).not.toContain("credential")
    expect(sourceAccessCalls).toEqual({ active: 2, resolve: 0 })
    expect(harness.modelListCalls.count).toBe(0)

    const route = { providerID: "openai", id: "gpt-6", variant: "high" }
    expect(
      await Effect.runPromise(
        methods.configure({
          sessionID: "ses-native",
          target: { scope: "project" },
          persona: "systems",
          expectedRevision: 0,
          route,
        }),
      ),
    ).toMatchObject({ status: "updated", mapping: { route } })

    expect(
      await Effect.runPromise(
        methods.configurePriceSources({
          sessionID: "ses-native",
          expectedRevision: 0,
          sources: ["opencode", "openrouter"],
        }),
      ),
    ).toMatchObject({
      status: "updated",
      policy: { revision: 1, sources: ["opencode", "openrouter"], fallback: "whole-model" },
    })
    expect(
      await Effect.runPromise(
        methods.configurePriceSources({
          sessionID: "ses-native",
          expectedRevision: 1,
          sources: ["opencode"],
        }),
      ),
    ).toMatchObject({ status: "updated", policy: { revision: 2, sources: ["opencode"] } })

    const stale = await Effect.runPromise(
      methods.configurePriceSources({
        sessionID: "ses-native",
        expectedRevision: 0,
        sources: ["openrouter"],
      }),
    )
    expect(stale).toMatchObject({
      status: "conflict",
      expectedRevision: 0,
      currentRevision: 2,
      current: { sources: ["opencode"] },
    })
    expect(harness.storageCalls.set).toBe(2)
    expect(
      [...storage.values()].every((value) => !JSON.stringify(value).includes("credential")),
    ).toBe(true)

    const settings = (await Effect.runPromise(methods.settings({ sessionID: "ses-native" }))) as {
      personas: Array<{ persona: string; layers: { project: { route: unknown } | null } }>
    }
    expect(
      settings.personas.find(({ persona }) => persona === "systems")?.layers.project,
    ).toMatchObject({ route })

    const reopenedRepository = new TaskRepository(path, projectDirectory)
    const reopened = await register(reopenedRepository, { storage, sourceConnections })
    reopenedRepository.close()
    expect(
      await Effect.runPromise(reopened.methods().priceSources({ sessionID: "ses-native" })),
    ).toMatchObject({ policy: { revision: 2, sources: ["opencode"] } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("price-source RPCs authorize the live project session before storage or host metadata access", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const storageCalls = { get: 0, set: 0 }
  const storage = new Map<string, unknown>()
  const sourceAccessCalls = { active: 0, resolve: 0 }
  const permissionCalls: unknown[] = []
  let denied = false
  const harness = await register(repository, {
    denied: () => denied,
    permissionCalls,
    sourceAccessCalls,
    storage,
    storageCalls,
  })
  repository.close()
  const methods = harness.methods()
  const read = () => methods.priceSources({ sessionID: "ses-native" })
  const write = () =>
    methods.configurePriceSources({
      sessionID: "ses-native",
      expectedRevision: 0,
      sources: ["opencode"],
    })

  try {
    for (const invalidActor of [
      null,
      { id: "ses-native", projectID, agent: "desktop-settings-user", time: { archived: 10 } },
      { id: "ses-native", projectID: "foreign-project", agent: "desktop-settings-user", time: {} },
    ]) {
      harness.setActor(invalidActor)
      expect(await rejects(read())).toBeInstanceOf(Error)
      expect(await rejects(write())).toBeInstanceOf(Error)
    }

    harness.setActor({ id: "ses-native", projectID, agent: "desktop-settings-user", time: {} })
    denied = true
    expect(await rejects(read())).toMatchObject({ message: "native permission denied" })
    expect(await rejects(write())).toMatchObject({ message: "native permission denied" })
    expect(storageCalls).toEqual({ get: 0, set: 0 })
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })

    denied = false
    expect(await Effect.runPromise(write())).toMatchObject({
      status: "updated",
      policy: { revision: 1 },
    })
    expect(permissionCalls.map((entry) => (entry as { action: string }).action)).toEqual([
      "lz-get-model-settings",
      "lz-configure-models",
      "lz-configure-models",
    ])
    expect(permissionCalls.slice(-1)[0]).toMatchObject({
      resources: [projectDirectory],
      action: "lz-configure-models",
    })
    expect(harness.storageCalls.set).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("price-source access reports uncertainty from host metadata without leaking provider errors", async () => {
  const root = directory()
  const repository = new TaskRepository(join(root, "tasks.sqlite"), projectDirectory)
  const harness = await register(repository, {
    sourceAccessFailure: () => true,
  })
  repository.close()

  try {
    const output = await Effect.runPromise(
      harness.methods().priceSources({ sessionID: "ses-native" }),
    )
    expect(output).toMatchObject({
      access: { openrouter: "unknown", opencode: "unknown" },
      policy: { sources: ["openrouter", "opencode"] },
    })
    expect(JSON.stringify(output)).not.toContain("credential-value")
    expect(harness.sourceAccessCalls).toEqual({ active: 2, resolve: 0 })
    expect(harness.modelListCalls.count).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("cancelled price-source write cannot persist after a late native permission grant", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let grant!: () => void
  let interrupted = false
  const storage = new Map<string, unknown>()
  const storageCalls = { get: 0, set: 0 }
  const sourceAccessCalls = { active: 0, resolve: 0 }
  const harness = await register(repository, {
    permissionWait: () =>
      Effect.callback<void>((resume) => {
        grant = () => resume(Effect.void)
        enter()
        return Effect.sync(() => {
          interrupted = true
        })
      }),
    sourceAccessCalls,
    storage,
    storageCalls,
  })
  repository.close()
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    harness.methods().configurePriceSources({
      sessionID: "ses-native",
      expectedRevision: 0,
      sources: ["opencode"],
    }),
    { signal: controller.signal },
  )
  try {
    await entered
    controller.abort()
    await pending
    grant()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(storageCalls).toEqual({ get: 0, set: 0 })
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect([...storage.values()]).toEqual([])
    expect(interrupted).toBe(true)
  } finally {
    grant?.()
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
      "lz-read-model-evidence",
      "lz-refresh-model-evidence",
      "lz-read-model-evidence",
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

test("Models comparison is an authorized read-only projection with honest missing-source state", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const permissionCalls: unknown[] = []
  const sourceAccessCalls = { active: 0, resolve: 0 }
  let fetchCalls = 0
  let readStoreOpens = 0
  const harness = await register(repository, {
    permissionCalls,
    sourceAccessCalls,
    fetcher: async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({ data: [] }))
    },
    evidenceReadStoreFactory: (databasePath, directory) => {
      readStoreOpens += 1
      return new ModelEvidenceReadStore(databasePath, directory)
    },
  })
  repository.close()
  const methods = harness.methods()
  try {
    const output = (await Effect.runPromise(
      methods.comparison({
        sessionID: "ses-native",
        filters: { providerID: "openrouter" },
        limit: 1,
      }),
    )) as {
      filters: { providerID?: string }
      sources: Array<{
        storage: string
        snapshotState: string
        refresh: unknown
        snapshot: unknown
      }>
      candidates: unknown[]
      nextCursor: string | null
    }
    expect(output).toMatchObject({
      filters: { providerID: "openrouter" },
      candidates: [],
      nextCursor: null,
    })
    expect(output.sources).toHaveLength(3)
    expect(output.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storage: "missing-both-tables",
          snapshotState: "missing-table",
          refresh: null,
          snapshot: null,
        }),
      ]),
    )
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(fetchCalls).toBe(0)
    expect(readStoreOpens).toBe(1)
    expect(harness.modelListCalls.count).toBe(0)
    expect(tableExists(path, "model_evidence_snapshots")).toBe(false)
    expect(tableExists(path, "model_evidence_refreshes")).toBe(false)
    expect(permissionCalls).toEqual([
      expect.objectContaining({
        action: "lz-read-model-comparison",
        resources: [projectDirectory],
      }),
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("registered model group RPCs resolve captured direct routes without credential or catalog access", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  writeCapturedModelEvidence(path)
  const permissionCalls: unknown[] = []
  const sourceAccessCalls = { active: 0, resolve: 0 }
  let fetchCalls = 0
  let readStoreOpens = 0
  const harness = await register(repository, {
    permissionCalls,
    sourceAccessCalls,
    fetcher: async () => {
      fetchCalls += 1
      throw new Error("group reads must not refresh model sources")
    },
    evidenceReadStoreFactory: (databasePath, directory) => {
      readStoreOpens += 1
      return capturedReadStoreFactory(databasePath, directory)
    },
  })
  repository.close()
  try {
    const groups = (await Effect.runPromise(
      harness.methods().modelGroups({ sessionID: "ses-native", limit: 100 }),
    )) as {
      context: unknown
      groups: Array<{ groupID: string; configurationCount: number }>
      totalGroups: number
    }
    expect(groups.totalGroups).toBe(4)
    expect(groups.groups.reduce((count, group) => count + group.configurationCount, 0)).toBe(33)

    const configurations = (await Effect.runPromise(
      harness.methods().modelConfigurations({
        sessionID: "ses-native",
        groupID: "openai/gpt-6-luna",
        context: groups.context,
        limit: 100,
      }),
    )) as {
      totalConfigurations: number
      configurations: Array<{
        configurationID: string
        route: { providerID: string; variant: string | null }
        identity: { status: string; productID: string | null; rules: Array<{ id: string }> } & {
          evidence: {
            native: Array<{ recordIndex: number; recordID: string }>
            catalog: Array<{ recordIndex: number; recordID: string }>
          }
        }
        native: { contextTokens: number | null; prices: unknown }
        externalCatalog: { source: string; model: { contextLength: number | null } | null }
      }>
    }
    expect(configurations.totalConfigurations).toBe(12)
    const direct = configurations.configurations.find(
      ({ route }) => route.providerID === "openai" && route.variant === "none",
    )!
    expect(direct).toMatchObject({
      identity: {
        status: "exact",
        productID: "openai/gpt-6-luna",
        rules: [{ id: "provider-owner-qualified-local-id-v1" }],
        evidence: {
          native: [expect.objectContaining({ recordIndex: 67, recordID: "gpt-6-luna" })],
          catalog: [expect.objectContaining({ recordIndex: 51, recordID: "openai/gpt-6-luna" })],
        },
      },
      native: { contextTokens: 400000, prices: null },
      externalCatalog: {
        source: "openrouter-models",
        model: { contextLength: 1050000 },
      },
    })
    const routed = configurations.configurations.find(
      ({ route }) => route.providerID === "openrouter" && route.variant === "none",
    )!
    expect(direct.configurationID).not.toBe(routed.configurationID)
    expect(routed.native).toMatchObject({
      contextTokens: 1050000,
      prices: { unit: "USD per million tokens" },
    })
    expect(routed.identity.evidence).toMatchObject({
      native: [expect.objectContaining({ recordIndex: 63, recordID: "openai/gpt-6-luna" })],
      catalog: [expect.objectContaining({ recordIndex: 51, recordID: "openai/gpt-6-luna" })],
    })

    const fable = (await Effect.runPromise(
      harness.methods().modelConfigurations({
        sessionID: "ses-native",
        groupID: "anthropic/claude-fable-5",
        context: groups.context,
        limit: 100,
      }),
    )) as {
      totalConfigurations: number
      configurations: Array<{
        route: { providerID: string; variant: string | null }
        identity: {
          status: string
          productID: string | null
          rules: Array<{ id: string }>
          evidence: {
            native: Array<{ recordIndex: number; recordID: string }>
            catalog: Array<{ recordIndex: number; recordID: string }>
          }
        }
      }>
    }
    expect(fable.totalConfigurations).toBe(10)
    for (const configuration of fable.configurations) {
      expect(configuration.identity).toMatchObject({
        status: "exact",
        productID: "anthropic/claude-fable-5",
        rules: [
          {
            id:
              configuration.route.providerID === "anthropic"
                ? "provider-owner-qualified-local-id-v1"
                : "owner-qualified-catalog-id-v1",
          },
        ],
        evidence: {
          catalog: [
            expect.objectContaining({ recordIndex: 166, recordID: "anthropic/claude-fable-5" }),
          ],
        },
      })
      expect(configuration.identity.evidence.native).toEqual([
        expect.objectContaining({
          recordIndex: configuration.route.providerID === "anthropic" ? 202 : 201,
          recordID:
            configuration.route.providerID === "anthropic"
              ? "claude-fable-5"
              : "anthropic/claude-fable-5",
        }),
      ])
    }
    expect(permissionCalls.map((entry) => (entry as { action: string }).action)).toEqual([
      "lz-read-model-groups",
      "lz-read-model-configurations",
      "lz-read-model-configurations",
    ])
    expect(readStoreOpens).toBe(3)
    expect(fetchCalls).toBe(0)
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(harness.modelListCalls.count).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("registered model RPCs group captured direct Anthropic aliases with exact OpenRouter products and rule provenance", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  writeCapturedAnthropicAliasEvidence(path)
  const permissionCalls: unknown[] = []
  const sourceAccessCalls = { active: 0, resolve: 0 }
  let fetchCalls = 0
  let readStoreOpens = 0
  const harness = await register(repository, {
    permissionCalls,
    sourceAccessCalls,
    fetcher: async () => {
      fetchCalls += 1
      throw new Error("group reads must not fetch credentials or refresh sources")
    },
    evidenceReadStoreFactory: (databasePath, directory) => {
      readStoreOpens += 1
      return capturedAliasReadStoreFactory(databasePath, directory)
    },
  })
  repository.close()
  try {
    const groups = (await Effect.runPromise(
      harness.methods().modelGroups({ sessionID: "ses-native", limit: 100 }),
    )) as {
      context: unknown
      groups: Array<{ groupID: string; configurationCount: number }>
      totalGroups: number
    }
    expect(groups.groups).toEqual([
      expect.objectContaining({ groupID: "anthropic/claude-fable-5", configurationCount: 10 }),
      expect.objectContaining({ groupID: "anthropic/claude-haiku-5.5", configurationCount: 12 }),
      expect.objectContaining({ groupID: "anthropic/claude-sonnet-5.5", configurationCount: 10 }),
      expect.objectContaining({ groupID: "openai/gpt-6-luna", configurationCount: 12 }),
    ])
    expect(groups.totalGroups).toBe(4)

    for (const [groupID, directID, catalogRecordID, nativeIndex, catalogIndex, expectedCount] of [
      ["anthropic/claude-haiku-5.5", "claude-haiku-5-5", "anthropic/claude-haiku-5.5", 38, 30, 12],
      [
        "anthropic/claude-sonnet-5.5",
        "claude-sonnet-5-5",
        "anthropic/claude-sonnet-5.5",
        50,
        39,
        10,
      ],
    ] as const) {
      const result = (await Effect.runPromise(
        harness.methods().modelConfigurations({
          sessionID: "ses-native",
          groupID,
          context: groups.context,
          limit: 100,
        }),
      )) as {
        totalConfigurations: number
        configurations: Array<{
          route: { providerID: string; modelID: string; variant: string | null }
          identity: {
            status: string
            productID: string | null
            rules: Array<{
              id: string
              version: number
              citations?: Array<{
                url: string
                excerpt: string
                snapshotID: string | null
                recordID: string | null
              }>
            }>
            evidence: {
              native: Array<{ recordIndex: number; recordID: string }>
              catalog: Array<{ recordIndex: number; recordID: string }>
            }
          }
          externalCatalog: { model: { id: string } | null }
        }>
      }
      expect(result.totalConfigurations).toBe(expectedCount)
      expect(result.configurations).toHaveLength(expectedCount)
      const direct = result.configurations.filter(({ route }) => route.providerID === "anthropic")
      const routed = result.configurations.filter(({ route }) => route.providerID === "openrouter")
      expect(direct).toHaveLength(expectedCount / 2)
      expect(routed).toHaveLength(expectedCount / 2)
      expect(new Set(direct.map(({ route }) => route.variant)).size).toBe(expectedCount / 2)
      expect(new Set(routed.map(({ route }) => route.variant)).size).toBe(expectedCount / 2)
      for (const configuration of direct) {
        expect(configuration).toMatchObject({
          route: { providerID: "anthropic", modelID: directID },
          identity: {
            status: "exact",
            productID: groupID,
            rules: [
              {
                id: `anthropic-${groupID.includes("haiku") ? "haiku" : "sonnet"}-5-5-to-openrouter-${groupID.includes("haiku") ? "haiku" : "sonnet"}-5-5-v1`,
                version: 1,
                citations: expect.arrayContaining([
                  expect.objectContaining({
                    url: "https://platform.claude.com/docs/en/models/overview",
                    excerpt: expect.stringContaining(directID),
                  }),
                  expect.objectContaining({
                    url: "https://openrouter.ai/api/v1/models",
                    snapshotID: captured.openrouter.snapshot.snapshotID,
                    recordID: catalogRecordID,
                    excerpt: expect.stringContaining(catalogRecordID),
                  }),
                ]),
              },
            ],
            evidence: {
              native: [expect.objectContaining({ recordIndex: nativeIndex, recordID: directID })],
              catalog: [
                expect.objectContaining({ recordIndex: catalogIndex, recordID: catalogRecordID }),
              ],
            },
          },
          externalCatalog: { model: { id: catalogRecordID } },
        })
      }
      for (const configuration of routed) {
        expect(configuration.identity).toMatchObject({
          status: "exact",
          productID: groupID,
          rules: [{ id: "owner-qualified-catalog-id-v1", version: 1 }],
        })
      }
    }
    expect(permissionCalls.map((entry) => (entry as { action: string }).action)).toEqual([
      "lz-read-model-groups",
      "lz-read-model-configurations",
      "lz-read-model-configurations",
    ])
    expect(readStoreOpens).toBe(3)
    expect(fetchCalls).toBe(0)
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(harness.modelListCalls.count).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("registered model group reads do not create a missing database", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  repository.close()
  expect(existsSync(path)).toBe(true)
  rmSync(path)
  const permissionCalls: unknown[] = []
  const harness = await register(repository, { permissionCalls })
  try {
    const exit = await Effect.runPromiseExit(
      harness.methods().modelGroups({ sessionID: "ses-native", limit: 100 }),
    )
    expect(exit._tag).toBe("Failure")
    expect(existsSync(path)).toBe(false)
    expect(permissionCalls).toEqual([
      expect.objectContaining({
        action: "lz-read-model-groups",
        resources: [projectDirectory],
      }),
    ])
    expect(harness.sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(harness.modelListCalls.count).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Models comparison denial, foreign or archived sessions and cancellation avoid source reads", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  let denied = false
  const sourceAccessCalls = { active: 0, resolve: 0 }
  let readStoreOpens = 0
  const harness = await register(repository, {
    denied: () => denied,
    sourceAccessCalls,
    evidenceReadStoreFactory: (databasePath, directory) => {
      readStoreOpens += 1
      return new ModelEvidenceReadStore(databasePath, directory)
    },
  })
  repository.close()
  const methods = harness.methods()
  try {
    for (const actor of [
      null,
      { id: "ses-native", projectID: "foreign-project", agent: "desktop-settings-user", time: {} },
      { id: "ses-native", projectID, agent: "desktop-settings-user", time: { archived: 20 } },
    ]) {
      harness.setActor(actor)
      expect(await rejects(methods.comparison({ sessionID: "ses-native" }))).toBeInstanceOf(Error)
      expect(await rejects(methods.modelGroups({ sessionID: "ses-native" }))).toBeInstanceOf(Error)
    }
    harness.setActor({ id: "ses-native", projectID, agent: "desktop-settings-user", time: {} })
    denied = true
    expect(await rejects(methods.comparison({ sessionID: "ses-native" }))).toMatchObject({
      message: "native permission denied",
    })
    expect(await rejects(methods.modelGroups({ sessionID: "ses-native" }))).toMatchObject({
      message: "native permission denied",
    })
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(readStoreOpens).toBe(0)
    expect(tableExists(path, "model_evidence_snapshots")).toBe(false)
    expect(tableExists(path, "model_evidence_refreshes")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Models group RPC rechecks session archival after awaited permission before opening evidence storage", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let grant!: () => void
  let readStoreOpens = 0
  const harness = await register(repository, {
    permissionWait: () =>
      Effect.callback<void>((resume) => {
        grant = () => resume(Effect.void)
        enter()
      }),
    evidenceReadStoreFactory: (databasePath, directory) => {
      readStoreOpens += 1
      return new ModelEvidenceReadStore(databasePath, directory)
    },
  })
  repository.close()
  try {
    const pending = Effect.runPromiseExit(
      harness.methods().modelGroups({ sessionID: "ses-native" }),
    )
    await entered
    harness.setActor({
      id: "ses-native",
      projectID,
      agent: "desktop-settings-user",
      time: { archived: 30 },
    })
    grant()
    const exit = await pending
    expect(exit._tag).toBe("Failure")
    expect(readStoreOpens).toBe(0)
    expect(tableExists(path, "model_evidence_snapshots")).toBe(false)
    expect(tableExists(path, "model_evidence_refreshes")).toBe(false)
  } finally {
    grant?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test("cancelled Models group RPC cannot open evidence storage after a late permission grant", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const controller = new AbortController()
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let grant!: () => void
  let interrupted = false
  let readStoreOpens = 0
  const harness = await register(repository, {
    permissionWait: () =>
      Effect.callback<void>((resume) => {
        grant = () => resume(Effect.void)
        enter()
        return Effect.sync(() => {
          interrupted = true
        })
      }),
    evidenceReadStoreFactory: (databasePath, directory) => {
      readStoreOpens += 1
      return new ModelEvidenceReadStore(databasePath, directory)
    },
  })
  repository.close()
  const pending = Effect.runPromiseExit(
    harness.methods().modelGroups({ sessionID: "ses-native" }),
    {
      signal: controller.signal,
    },
  )
  try {
    await entered
    controller.abort()
    const exit = await pending
    grant()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(exit._tag).toBe("Failure")
    expect(interrupted).toBe(true)
    expect(readStoreOpens).toBe(0)
    expect(tableExists(path, "model_evidence_snapshots")).toBe(false)
    expect(tableExists(path, "model_evidence_refreshes")).toBe(false)
  } finally {
    grant?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Models group RPC cancellation after source reads cannot publish a successful result", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const controller = new AbortController()
  const harness = await register(repository, {
    evidenceReadStoreFactory: (databasePath, directory) => {
      const reader = new ModelEvidenceReadStore(databasePath, directory)
      return {
        projectDirectory: directory,
        readComparisonSources: (selection) => {
          const sources = reader.readComparisonSources(selection)
          controller.abort()
          return sources
        },
        close: () => reader.close(),
      }
    },
  })
  repository.close()
  try {
    const exit = await Effect.runPromiseExit(
      harness.methods().modelGroups({ sessionID: "ses-native" }),
      { signal: controller.signal },
    )
    expect(exit._tag).toBe("Failure")
    expect(tableExists(path, "model_evidence_snapshots")).toBe(false)
    expect(tableExists(path, "model_evidence_refreshes")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("ModelsDecision registers and serves coherent production overview, rows, configurations and inspect", async () => {
  const fixture = makeLedgerFixture()
  const sourceWriter = new Database(fixture.path, { strict: true })
  sourceWriter
    .query("UPDATE runner_progress SET message_id='decision-server-' || seq WHERE kind='step'")
    .run()
  sourceWriter.close()
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const harness = await register(repository)
  repository.close()
  try {
    const input = {
      sessionID: "ses-native",
      scope: { projectDirectory: fixture.projectDirectory },
      filters: { persona: null, taskKind: null, period: { from: null, to: null } },
    }
    const overview = (await Effect.runPromise(harness.methods().overview(input))) as {
      context: { snapshotID: string; availability: string }
      graph: { scope: string; points: unknown[] }
      configurationCount: number
    }
    expect(overview.context.availability).toBe("partial")
    expect(overview.graph.scope).toBe("global-filtered-snapshot")

    const rows = (await Effect.runPromise(harness.methods().rows({ ...input, limit: 100 }))) as {
      context: { snapshotID: string }
      rows: Array<{ configuration: { configurationID: string } }>
      totalCount: number
    }
    const configurations = (await Effect.runPromise(
      harness.methods().configurations({ ...input, limit: 100 }),
    )) as {
      context: { snapshotID: string }
      configurations: Array<{ configurationID: string }>
      totalCount: number
    }
    expect(rows.context.snapshotID).toBe(overview.context.snapshotID)
    expect(configurations.context.snapshotID).toBe(overview.context.snapshotID)
    expect(rows.totalCount).toBe(overview.configurationCount)
    expect(configurations.totalCount).toBe(overview.configurationCount)
    expect(rows.rows.length).toBeGreaterThan(0)

    const inspection = await Effect.runPromise(
      harness.methods().inspect({
        ...input,
        snapshotID: overview.context.snapshotID,
        configurationID: rows.rows[0]!.configuration.configurationID,
        selectedTaskID: null,
        contributorLimit: 100,
      }),
    )
    expect(inspection).toMatchObject({ status: "found" })
    expect(harness.permissionCalls).toHaveLength(4)
    expect(harness.permissionCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "lz-read-model-decision",
          resources: [fixture.projectDirectory],
        }),
      ]),
    )
  } finally {
    fixture.close()
  }
})

test("ModelsDecision foreign scope, denial and pre-abort do not read price sources", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  let denied = false
  const harness = await register(repository, { denied: () => denied })
  repository.close()
  const input = {
    sessionID: "ses-native",
    scope: { projectDirectory },
    filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  }
  try {
    await expect(
      Effect.runPromise(
        harness.methods().overview({
          ...input,
          scope: { projectDirectory: `${projectDirectory}/foreign` },
        }),
      ),
    ).rejects.toThrow()
    expect(harness.permissionCalls).toHaveLength(0)

    denied = true
    await expect(Effect.runPromise(harness.methods().overview(input))).rejects.toThrow(
      "native permission denied",
    )
    expect(harness.sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(harness.storageCalls.get).toBe(0)

    denied = false
    const controller = new AbortController()
    controller.abort()
    await expect(
      Effect.runPromise(harness.methods().overview(input), { signal: controller.signal }),
    ).rejects.toThrow()
    expect(harness.sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
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
