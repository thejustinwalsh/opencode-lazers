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
import { buildCurrentPriceIndex } from "./current-price-index.ts"
import { ModelPriceSourceSettingsSchema } from "./price-source-settings.ts"
import { registerModelsServer } from "./server.ts"
import { createModelsTaskValuationProvider } from "./server.ts"
import type { ProjectTaskValuationRequest } from "./valuation.ts"
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"
import { ENDPOINT_PRICING_PRODUCTS, EndpointPricingRecordSchema } from "./endpoint-pricing.ts"
import type { EndpointPricingProductID, EndpointPricingRecord } from "./endpoint-pricing.ts"
import {
  ModelDecisionConfigurationsOutputSchema,
  ModelDecisionInspectOutputSchema,
  ModelDecisionOverviewAllOutputSchema,
  ModelDecisionOverviewOutputSchema,
  ModelDecisionRowsAllOutputSchema,
  ModelDecisionRowsOutputSchema,
} from "./decision-contract.ts"
import { modelConfigurationID } from "./model-identity.ts"
import capturedGo from "../../test/models-identity/fixtures/captured-go-openrouter-20261103.json" with { type: "json" }

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
  onModelList?: () => void
  permissionCalls?: unknown[]
  permissionWait?: () => Effect.Effect<void>
  sourceAccessCalls?: { active: number; resolve: number }
  sourceConnections?: Record<string, unknown>
  sourceAccessFailure?: () => boolean
  nativeModels?: unknown[]
  locationDirectory?: string
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
  const sourceAccessIDs: string[] = []
  const inferenceCalls = { prompt: 0, generate: 0 }
  const storage = options.storage ?? new Map<string, unknown>()
  const storageCalls = options.storageCalls ?? { get: 0, set: 0 }
  const modelListCalls = { count: 0 }
  const agentReloads = { count: 0 }
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
      prompt: () => {
        inferenceCalls.prompt += 1
        return Effect.die(new Error("Models reads must not prompt"))
      },
      generate: () => {
        inferenceCalls.generate += 1
        return Effect.die(new Error("Models reads must not generate"))
      },
    },
    location: {
      directory: options.locationDirectory ?? projectDirectory,
      project: { id: projectID, canonical: projectDirectory },
    },
    model: {
      list: () => {
        modelListCalls.count += 1
        options.onModelList?.()
        return options.catalogFailure?.()
          ? Effect.fail(new Error("native catalog unavailable"))
          : Effect.succeed({ data: options.nativeModels ?? [] })
      },
    },
    integration: {
      connection: {
        active: (integrationID: string) => {
          sourceAccessCalls.active += 1
          sourceAccessIDs.push(integrationID)
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
    agent: {
      get: () => Effect.succeed({ data: { model: null } }),
      reload: () => {
        agentReloads.count += 1
        return Effect.void
      },
    },
  }
  return {
    agentReloads,
    context,
    server,
    methods: () => registered ?? server,
    setActor: (next: NativeSession | null) => {
      actor = next
    },
    permissionCalls,
    sourceAccessCalls,
    sourceAccessIDs,
    inferenceCalls,
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

function writeMarketIdentityEvidence(
  path: string,
  projectDirectory: string,
  options: {
    duplicateLuna?: boolean
    includeKimi?: boolean
    promptRate?: string
    withoutPrices?: readonly string[]
  } = {},
) {
  const directNative = ModelEvidenceSnapshotSchema.parse(captured.native.snapshot)
  const directCatalog = ModelEvidenceSnapshotSchema.parse(captured.openrouter.snapshot)
  const goNative = ModelEvidenceSnapshotSchema.parse(capturedGo.native.snapshot)
  const goCatalog = ModelEvidenceSnapshotSchema.parse(capturedGo.openrouter.snapshot)
  if (
    directNative.source !== "native-catalog" ||
    directCatalog.source !== "openrouter-models" ||
    goNative.source !== "native-catalog" ||
    goCatalog.source !== "openrouter-models"
  )
    throw new Error("Captured market identity sources have unexpected types")

  const nativeRecords = [
    ...directNative.records.filter(
      (record) => record.providerID === "openai" && record.id === "gpt-6-luna",
    ),
    ...goNative.records.filter(
      (record) =>
        record.providerID === "opencode-go" &&
        ["kimi-k3.1-pro", "qwen3.8-flash"].includes(record.id),
    ),
  ]
  const catalogRecords = [
    ...directCatalog.records.filter((record) => record.id === "openai/gpt-6-luna"),
    ...goCatalog.records.filter(
      (record) =>
        (options.includeKimi !== false && record.id === "moonshotai/kimi-k3.1-pro") ||
        record.id === "qwen/qwen3.8-flash",
    ),
  ]
  if (options.duplicateLuna)
    catalogRecords.push(catalogRecords.find((record) => record.id === "openai/gpt-6-luna")!)
  const savedCatalogRecords = catalogRecords.map((record) => {
    if (options.withoutPrices?.includes(record.id)) return { ...record, prices: null }
    if (record.id === "openai/gpt-6-luna" && record.prices && options.promptRate)
      return {
        ...record,
        prices: {
          ...record.prices,
          tiers: record.prices.tiers.map((tier) => ({ ...tier, prompt: options.promptRate! })),
        },
      }
    return record
  })

  const store = new ModelEvidenceStore(path, projectDirectory)
  try {
    const generations = store.beginRefresh()
    const nativeSnapshot = ModelEvidenceSnapshotSchema.parse({
      ...directNative,
      snapshotID: crypto.randomUUID(),
      projectDirectory,
      generation: generations["native-catalog"],
      retrievedAt: new Date(Date.now() + generations["native-catalog"]).toISOString(),
      records: nativeRecords,
    })
    const catalogSnapshot = ModelEvidenceSnapshotSchema.parse({
      ...directCatalog,
      snapshotID: crypto.randomUUID(),
      projectDirectory,
      generation: generations["openrouter-models"],
      retrievedAt: new Date(Date.now() + generations["openrouter-models"]).toISOString(),
      records: savedCatalogRecords,
    })
    store.saveSnapshot(nativeSnapshot)
    store.saveSnapshot(catalogSnapshot)
  } finally {
    store.close()
  }
}

function writeMarketEndpointEvidence(
  path: string,
  projectDirectory: string,
  products: Array<{
    productID: EndpointPricingProductID
    providerName: string
    tag: string
    pricing: EndpointPricingRecord["pricing"]
  }>,
) {
  const store = new ModelEvidenceStore(path, projectDirectory)
  try {
    const generations = store.beginEndpointPricingRefresh()
    for (const item of products) {
      const source = ENDPOINT_PRICING_PRODUCTS.find(
        (candidate) => candidate.productID === item.productID,
      )!
      const record = EndpointPricingRecordSchema.parse({
        productID: item.productID,
        name: `${item.providerName} market endpoint`,
        providerName: item.providerName,
        tag: item.tag,
        serviceTier: null,
        pricing: item.pricing,
        cacheWriteDocumentation: null,
      })
      store.saveEndpointPricingSnapshot({
        snapshotID: crypto.randomUUID(),
        projectDirectory,
        productID: item.productID,
        generation: generations[item.productID],
        retrievedAt: new Date(Date.now() + generations[item.productID]).toISOString(),
        sourceURL: source.sourceURL,
        httpStatus: 200,
        records: [record],
      })
    }
    return { store, generations }
  } catch (error) {
    store.close()
    throw error
  }
}

function rewriteAttemptForMarket(
  path: string,
  projectID: string,
  attemptID: string,
  route: { providerID: string; modelID: string; variant: string | null },
  inputTokens: readonly number[],
) {
  const db = new Database(path, { strict: true })
  try {
    const rows = db
      .query<{ seq: number; kind: string; payload: string }, [string]>(
        "SELECT seq,kind,payload FROM runner_progress WHERE attempt_id=? ORDER BY seq",
      )
      .all(attemptID)
    let stepIndex = 0
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      payload.route = route
      payload.routeEvidence = { status: "observed", route }
      const input =
        row.kind === "usage-snapshot"
          ? inputTokens.reduce((sum, value) => sum + value, 0)
          : (inputTokens[Math.min(stepIndex, inputTokens.length - 1)] ?? 0)
      payload.usage = {
        input,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }
      db.query("UPDATE runner_progress SET payload=?,message_id=? WHERE seq=?").run(
        JSON.stringify(payload),
        `rpc-market-call-${row.seq}`,
        row.seq,
      )
      if (row.kind === "step") stepIndex++
    }
    const owner = db
      .query<
        { task_id: string; plan_id: string; session_id: string; project_directory: string },
        [string]
      >(
        `SELECT a.task_id,a.plan_id,a.session_id,p.project_directory
         FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id WHERE a.id=?`,
      )
      .get(attemptID)
    if (!owner) throw new Error("Fixture attempt is unavailable")
    const insertFact = (
      kind: "step" | "usage-snapshot",
      payload: Record<string, unknown>,
      suffix: string,
    ) => {
      db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
          source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        owner.project_directory,
        projectID,
        owner.plan_id,
        owner.task_id,
        attemptID,
        owner.session_id,
        4_000,
        4_011,
        "runtime",
        JSON.stringify(["runtime"]),
        kind,
        JSON.stringify([]),
        null,
        kind === "step" ? `rpc-market-${suffix}-${attemptID}` : null,
        `rpc-market-${suffix}-${attemptID}`,
        JSON.stringify(payload),
      )
    }
    if (!rows.some((row) => row.kind === "usage-snapshot") && inputTokens.length) {
      insertFact(
        "usage-snapshot",
        {
          additive: false,
          measurementBasis: "cumulative-session-snapshot",
          usage: {
            input: inputTokens.reduce((sum, value) => sum + value, 0),
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
        "usage",
      )
    }
    if (!rows.some((row) => row.kind === "step"))
      insertFact("step", { routeEvidence: { status: "observed", route }, route }, "route")
  } finally {
    db.close()
  }
}

function saveLunaEndpointSnapshot(
  store: ModelEvidenceStore,
  projectDirectory: string,
  generation: number,
  rates: { prompt: string; overridePrompt: string } = {
    prompt: "0.0000001",
    overridePrompt: "0.0000002",
  },
) {
  const productID = "openai/gpt-6-luna" as const
  const product = ENDPOINT_PRICING_PRODUCTS.find((item) => item.productID === productID)!
  const record = EndpointPricingRecordSchema.parse({
    productID,
    name: "OpenAI GPT-6 Luna",
    providerName: "OpenAI",
    tag: "openai",
    serviceTier: null,
    pricing: {
      unit: "USD per token",
      prompt: rates.prompt,
      completion: "0.0000005",
      inputCacheRead: "0.00000001",
      inputCacheWrite: "0.000000125",
      overrides: [
        {
          minPromptTokens: 272_000,
          prompt: rates.overridePrompt,
          completion: "0.00000075",
          inputCacheRead: "0.00000002",
          inputCacheWrite: "0.00000025",
        },
      ],
    },
    cacheWriteDocumentation: null,
  })
  store.saveEndpointPricingSnapshot({
    snapshotID: crypto.randomUUID(),
    projectDirectory,
    productID,
    generation,
    retrievedAt: new Date(Date.now() + generation).toISOString(),
    sourceURL: product.sourceURL,
    httpStatus: 200,
    records: [record],
  })
}

function writeLunaEndpointSnapshot(
  path: string,
  projectDirectory: string,
  rates?: { prompt: string; overridePrompt: string },
) {
  const store = new ModelEvidenceStore(path, projectDirectory)
  try {
    const productID = "openai/gpt-6-luna" as const
    const generation = store.beginEndpointPricingRefresh()[productID]
    saveLunaEndpointSnapshot(store, projectDirectory, generation, rates)
    return { store, generation, productID }
  } catch (error) {
    store.close()
    throw error
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
        .execute({ target: { scope: "shared" }, persona: "systems", route: shared }, toolContext()),
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

    // The Desktop editor keeps its revision guard; only the model tool writes unguarded.
    const conflict = await Effect.runPromise(
      methods.configure({
        sessionID: "ses-native",
        target: { scope: "project" },
        persona: "systems",
        expectedRevision: 0,
        route: project,
      }),
    )
    expect(conflict).toMatchObject({
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
        sources: ["openrouter", "opencode", "models-dev"],
        fallback: "whole-model",
      },
      access: { openrouter: "configured", opencode: "unknown" },
    })
    expect(JSON.stringify(initial)).not.toContain("credential")
    expect(sourceAccessCalls).toEqual({ active: 1, resolve: 0 })
    expect(harness.sourceAccessIDs).toEqual(["openrouter"])
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
      current: { sources: ["opencode", "models-dev"] },
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
    ).toMatchObject({ policy: { revision: 2, sources: ["opencode", "models-dev"] } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Models task valuation uses the configured cached market index, not worker subscription cost", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  writeCapturedModelEvidence(path)
  const harness = modelContext({})
  const provider = createModelsTaskValuationProvider(harness.context as never, repository)
  const route = {
    providerID: "openrouter",
    modelID: "anthropic/claude-sonnet-5.5",
    variant: null,
  }
  const request: ProjectTaskValuationRequest = {
    attempts: [
      {
        id: crypto.randomUUID(),
        sessionID: "ses-priced-task",
        state: "failed",
        legacyTokenCount: 999,
        recordedCostUSD: 9876,
        planRoute: route,
        planRouteStatus: "explicit",
        frozenRoute: route,
        frozenRouteSource: "runner_attempt.policy.model",
        personaRequested: null,
        personaFrozen: null,
        sessionStatus: "available",
        contextStatus: "available",
        currentRoute: route,
        currentRouteObservedAt: 1_000,
        sessionUsage: { input: 10, output: 3, reasoning: 2, cacheRead: 5, cacheWrite: 0 },
        sessionUsageObservedAt: 1_000,
        stepRoutes: [],
      },
    ],
    progressFacts: [],
    progressTruncated: false,
    truncatedContextSessionIDs: [],
  }

  try {
    const valuation = await provider(request, new AbortController().signal)
    expect(valuation.valueUSD).toBeCloseTo(0.0000705, 12)
    expect(valuation.currentIndex).toMatchObject({
      freshness: "current",
      sources: [
        {
          source: "native-catalog",
          snapshotID: expect.any(String),
          generation: 5,
          priceBasis: "quote",
          rateUnit: "USD per million tokens",
        },
      ],
    })
    expect(harness.sourceAccessIDs).toEqual(["openrouter"])
    expect(harness.sourceAccessCalls.resolve).toBe(0)
    expect(harness.modelListCalls.count).toBe(0)
    expect(harness.inferenceCalls).toEqual({ prompt: 0, generate: 0 })
    expect(harness.storageCalls.set).toBe(0)
    expect(valuation.valueUSD).not.toBe(request.attempts[0]!.recordedCostUSD)

    const changedSubscription = await provider(
      {
        ...request,
        attempts: request.attempts.map((attempt) => ({ ...attempt, recordedCostUSD: 0 })),
      },
      new AbortController().signal,
    )
    expect(changedSubscription.valueUSD).toBe(valuation.valueUSD)
    expect(changedSubscription.currentIndex?.indexID).toBe(valuation.currentIndex?.indexID)
    expect(changedSubscription.currentIndex?.sources).toEqual(valuation.currentIndex?.sources)

    const failedSourceProvider = createModelsTaskValuationProvider(
      harness.context as never,
      repository,
      () => {
        throw new Error("private cached-source path")
      },
    )
    const unavailable = await failedSourceProvider(request, new AbortController().signal)
    expect(unavailable).toMatchObject({
      valueUSD: null,
      status: "unavailable",
      currentIndex: null,
    })
  } finally {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("registered price reads use the recorded native catalog outcome and preserve stale provenance", async () => {
  const fixture = makeLedgerFixture()
  const route = { providerID: "openai", modelID: "price-test", variant: null }
  rewriteAttemptForMarket(fixture.path, fixture.projectID, fixture.attempts.failed.id, route, [100])
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    route,
    [200],
  )
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const sourceConnections: Record<string, unknown> = {}
  const sourceAccessCalls = { active: 0, resolve: 0 }
  const permissionCalls: unknown[] = []
  let nativeReadFails = false
  let fetchCalls = 0
  const harness = await register(repository, {
    sourceConnections,
    sourceAccessCalls,
    permissionCalls,
    locationDirectory: fixture.projectDirectory,
    nativeModels: [
      {
        providerID: "openai",
        id: "price-test",
        name: "Native price test",
        enabled: true,
        type: "language",
        limit: { context: 400_000 },
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: null,
        cost: [{ input: 2, output: 8, cache: { read: 0.2, write: 2 }, tier: {} }],
      },
    ],
    catalogFailure: () => nativeReadFails,
    fetcher: async (input, init) => {
      // The public sources are not what this test is about; they are unreachable here.
      if (/models\.dev|epoch\.ai/.test(String(input))) return new Response("n/a", { status: 404 })
      fetchCalls += 1
      expect(String(input)).toBe("https://openrouter.ai/api/v1/models")
      expect(new Headers(init?.headers).get("authorization")).toBeNull()
      return Response.json({
        data: [
          {
            id: "openai/price-test",
            name: "OpenRouter price test",
            pricing: {
              prompt: null,
              completion: "0.000008",
              input_cache_read: "0.0000002",
              input_cache_write: "0.000002",
            },
          },
        ],
      })
    },
  })
  repository.close()
  const methods = harness.methods()
  const decisionInput = {
    sessionID: "ses-native",
    scope: { projectDirectory: fixture.projectDirectory },
    filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  }

  try {
    expect(
      await Effect.runPromise(methods.priceSources({ sessionID: "ses-native" })),
    ).toMatchObject({ access: { openrouter: "not-configured", opencode: "unknown" } })
    expect(harness.modelListCalls.count).toBe(0)

    const refreshed = (await Effect.runPromise(
      methods.refreshSources({ sessionID: "ses-native", force: true }),
    )) as {
      sources: Array<{
        source: string
        state: string
        errorCode: string | null
        latestSnapshotID: string | null
        latestRecordCount: number | null
      }>
    }
    const nativeRefresh = refreshed.sources.find(({ source }) => source === "native-catalog")!
    expect(nativeRefresh).toMatchObject({ state: "succeeded", latestRecordCount: 1 })
    const nativeSnapshotID = nativeRefresh.latestSnapshotID!
    expect(refreshed.sources.find(({ source }) => source === "openrouter-models")).toMatchObject({
      state: "succeeded",
      latestRecordCount: 1,
    })
    expect(harness.modelListCalls.count).toBe(1)
    expect(sourceAccessCalls.resolve).toBe(0)
    expect(harness.sourceAccessIDs).not.toContain("opencode")

    // OpenRouter is the preferred price source, but its published route is incomplete.
    // This connection is only an access marker; quote reads must not resolve credentials.
    sourceConnections.openrouter = { id: "configured-openrouter-source" }
    const priceSettings = ModelPriceSourceSettingsSchema.parse(
      await Effect.runPromise(methods.priceSources({ sessionID: "ses-native" })),
    )
    expect(priceSettings).toMatchObject({
      policy: { sources: ["openrouter", "opencode", "models-dev"], fallback: "whole-model" },
      access: { openrouter: "configured", opencode: "configured" },
    })

    const readStore = new ModelEvidenceReadStore(fixture.path, fixture.projectDirectory)
    try {
      const index = buildCurrentPriceIndex({
        sourceStore: readStore,
        priceSources: priceSettings,
        observedRoutes: [{ route }],
      })
      expect(index.pins).toHaveLength(1)
      expect(index.pins[0]).toMatchObject({
        route,
        semantics: "quote",
        rates: {
          unit: "USD per million tokens",
          uncachedInput: 2,
          completion: 8,
          cacheRead: 0.2,
          cacheWrite: 2,
        },
        provenance: {
          source: "native-catalog",
          snapshotID: nativeSnapshotID,
          generation: 1,
          sourceURL: "https://opencode.ai/v2/docs/models/",
          recordIndex: 0,
          recordID: "price-test",
        },
      })
    } finally {
      readStore.close()
    }

    const currentOverview = (await Effect.runPromise(methods.overview(decisionInput))) as {
      context: { priceIndex: { source: string; freshness: string; pins: unknown[] } }
    }
    expect(currentOverview.context.priceIndex).toMatchObject({
      source: "opencode",
      freshness: "current",
      pins: [
        {
          source: "opencode",
          snapshotID: nativeSnapshotID,
          freshness: "current",
          semantics: "exact-native-model-quotes",
        },
      ],
    })
    expect(fetchCalls).toBe(1)
    expect(harness.modelListCalls.count).toBe(1)

    // A later failed native read keeps the last-good snapshot, but decisions identify it as stale.
    nativeReadFails = true
    delete sourceConnections.openrouter
    const failedRefresh = (await Effect.runPromise(
      methods.refreshSources({ sessionID: "ses-native", force: true }),
    )) as { sources: Array<{ source: string; state: string; latestSnapshotID: string | null }> }
    expect(failedRefresh.sources.find(({ source }) => source === "native-catalog")).toMatchObject({
      state: "failed",
      latestSnapshotID: nativeSnapshotID,
    })
    expect(
      await Effect.runPromise(methods.priceSources({ sessionID: "ses-native" })),
    ).toMatchObject({ access: { openrouter: "not-configured", opencode: "configured" } })
    const staleOverview = (await Effect.runPromise(methods.overview(decisionInput))) as {
      context: { priceIndex: { source: string; freshness: string; pins: unknown[] } }
    }
    expect(staleOverview.context.priceIndex).toMatchObject({
      source: "opencode",
      freshness: "stale",
      pins: [
        {
          source: "opencode",
          snapshotID: nativeSnapshotID,
          freshness: "stale",
        },
      ],
    })

    // The snapshot alone is not a successful read outcome. Without its refresh record it is unknown.
    const db = new Database(fixture.path, { strict: true })
    try {
      db.query(
        "DELETE FROM model_evidence_refreshes WHERE project_directory=? AND source='native-catalog'",
      ).run(fixture.projectDirectory)
    } finally {
      db.close()
    }
    expect(
      await Effect.runPromise(methods.priceSources({ sessionID: "ses-native" })),
    ).toMatchObject({ access: { opencode: "unknown" } })
    const cacheOnlyOverview = (await Effect.runPromise(methods.overview(decisionInput))) as {
      context: { priceIndex: { source: string; freshness: string; pins: unknown[] } }
    }
    expect(cacheOnlyOverview.context.priceIndex).toMatchObject({
      source: "unavailable",
      freshness: "unavailable",
      pins: [],
    })

    expect(harness.modelListCalls.count).toBe(2)
    expect(sourceAccessCalls.resolve).toBe(0)
    expect(harness.sourceAccessIDs).not.toContain("opencode")
    expect(harness.inferenceCalls).toEqual({ prompt: 0, generate: 0 })
    expect(
      permissionCalls.filter(
        (call) => (call as { action: string }).action === "lz-refresh-model-evidence",
      ),
    ).toHaveLength(2)
  } finally {
    fixture.close()
  }
})

test("never-read, pending, cancelled, failed and empty native catalogs stay unknown", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const evidence = new ModelEvidenceStore(path, projectDirectory)
  const sourceAccessCalls = { active: 0, resolve: 0 }
  const harness = await register(repository, {
    sourceAccessCalls,
    fetcher: async () => Response.json({ data: [] }),
  })
  repository.close()
  const methods = harness.methods()
  const readPriceSettings = () => methods.priceSources({ sessionID: "ses-native" })

  try {
    expect(await Effect.runPromise(readPriceSettings())).toMatchObject({
      access: { opencode: "unknown" },
    })

    const pendingGeneration = evidence.beginRefresh()["native-catalog"]
    expect(evidence.read().sources[0]).toMatchObject({
      state: "refreshing",
      latestSnapshotID: null,
    })
    expect(await Effect.runPromise(readPriceSettings())).toMatchObject({
      access: { opencode: "unknown" },
    })

    evidence.cancelRefresh("native-catalog", pendingGeneration)
    expect(evidence.read().sources[0]).toMatchObject({ state: "cancelled", latestSnapshotID: null })
    expect(await Effect.runPromise(readPriceSettings())).toMatchObject({
      access: { opencode: "unknown" },
    })

    const failedGeneration = evidence.beginRefresh()["native-catalog"]
    evidence.failRefresh("native-catalog", failedGeneration, "native-unavailable")
    expect(evidence.read().sources[0]).toMatchObject({ state: "failed", latestSnapshotID: null })
    expect(await Effect.runPromise(readPriceSettings())).toMatchObject({
      access: { opencode: "unknown" },
    })

    const refreshed = (await Effect.runPromise(
      methods.refreshSources({ sessionID: "ses-native", force: true }),
    )) as { sources: Array<{ source: string; state: string; latestRecordCount: number | null }> }
    expect(refreshed.sources.find(({ source }) => source === "native-catalog")).toMatchObject({
      state: "succeeded",
      latestRecordCount: 0,
    })
    const settings = ModelPriceSourceSettingsSchema.parse(
      await Effect.runPromise(readPriceSettings()),
    )
    expect(settings.access.opencode).toBe("unknown")

    const readStore = new ModelEvidenceReadStore(path, projectDirectory)
    try {
      expect(
        buildCurrentPriceIndex({
          sourceStore: readStore,
          priceSources: settings,
          observedRoutes: [
            { route: { providerID: "openai", modelID: "settling-model", variant: null } },
          ],
        }).pins,
      ).toEqual([])
    } finally {
      readStore.close()
    }

    expect(harness.modelListCalls.count).toBe(1)
    expect(sourceAccessCalls.resolve).toBe(0)
    expect(harness.sourceAccessIDs).not.toContain("opencode")
    expect(harness.inferenceCalls).toEqual({ prompt: 0, generate: 0 })
  } finally {
    evidence.close()
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
      policy: { sources: ["openrouter", "opencode", "models-dev"] },
    })
    expect(JSON.stringify(output)).not.toContain("credential-value")
    expect(harness.sourceAccessCalls).toEqual({ active: 1, resolve: 0 })
    expect(harness.sourceAccessIDs).toEqual(["openrouter"])
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
    expect(empty.sources.map(({ state }) => state)).toEqual([
      "never",
      "never",
      "never",
      "never",
      "never",
    ])
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })

    const refreshed = (await Effect.runPromise(
      methods.refreshSources({ sessionID: "ses-native", force: true }),
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
      expect(
        await rejects(methods.refreshSources({ sessionID: "ses-native", force: true })),
      ).toBeInstanceOf(Error)
      expect(await rejects(methods.sourceEvidence({ sessionID: "ses-native" }))).toBeInstanceOf(
        Error,
      )
    }
    harness.setActor({ id: "ses-native", projectID, agent: "desktop-settings-user", time: {} })
    denied = true
    expect(
      await rejects(methods.refreshSources({ sessionID: "ses-native", force: true })),
    ).toMatchObject({
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
    expect(output.sources).toHaveLength(5)
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
  const marketRoute = {
    providerID: "openai",
    modelID: "gpt-6-luna",
    variant: "max",
  }
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.failed.id,
    marketRoute,
    [100],
  )
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    marketRoute,
    [20, 30],
  )
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.adoption.id,
    { ...marketRoute, variant: "high" },
    [40],
  )
  writeMarketIdentityEvidence(fixture.path, fixture.projectDirectory)
  const endpointEvidence = writeLunaEndpointSnapshot(fixture.path, fixture.projectDirectory)
  const sourceWriter = new Database(fixture.path, { strict: true })
  sourceWriter
    .query("UPDATE runner_progress SET message_id='decision-server-' || seq WHERE kind='step'")
    .run()
  sourceWriter.close()
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const harness = await register(repository, {
    sourceConnections: { openrouter: { status: { status: "connected" } } },
  })
  repository.close()
  try {
    const input = {
      sessionID: "ses-native",
      scope: { projectDirectory: fixture.projectDirectory },
      filters: { persona: null, taskKind: null, period: { from: null, to: null } },
    }
    const overview = ModelDecisionOverviewOutputSchema.parse(
      await Effect.runPromise(harness.methods().overview(input)),
    )
    expect(overview.context.availability).toBe("partial")
    expect(overview.graph.scope).toBe("global-filtered-snapshot")

    const rows = ModelDecisionRowsOutputSchema.parse(
      await Effect.runPromise(harness.methods().rows({ ...input, limit: 100 })),
    )
    const firstPage = ModelDecisionRowsOutputSchema.parse(
      await Effect.runPromise(
        harness.methods().rows({ ...input, snapshotID: overview.context.snapshotID, limit: 1 }),
      ),
    )
    const configurations = ModelDecisionConfigurationsOutputSchema.parse(
      await Effect.runPromise(
        harness.methods().configurations({
          ...input,
          snapshotID: overview.context.snapshotID,
          limit: 100,
        }),
      ),
    )
    expect(rows.context.snapshotID).toBe(overview.context.snapshotID)
    expect(configurations.context.snapshotID).toBe(overview.context.snapshotID)
    expect(rows.totalCount).toBe(overview.configurationCount)
    expect(configurations.totalCount).toBe(overview.configurationCount)
    expect(rows.rows.length).toBeGreaterThan(0)
    expect(firstPage.rows).toHaveLength(1)
    const globalReferenceEstimates = overview.graph.referenceEstimates
    if (!globalReferenceEstimates) throw new Error("Overview reference estimates are absent")
    expect(globalReferenceEstimates).toHaveLength(overview.configurationCount)
    expect(globalReferenceEstimates.length).toBeGreaterThan(firstPage.rows.length)
    const marketRow = rows.rows.find(
      (row) =>
        row.configuration.route.providerID === marketRoute.providerID &&
        row.configuration.route.modelID === marketRoute.modelID &&
        row.configuration.route.variant === marketRoute.variant,
    )
    expect(marketRow).toBeDefined()
    if (!marketRow) throw new Error("OpenAI market configuration row is absent")
    expect(marketRow?.efficiency).toBeDefined()
    expect(marketRow?.nativeReportedCost).toBeDefined()
    const marketEstimate = marketRow.referenceEstimate
    if (!marketEstimate) throw new Error("Reference estimate is absent from the market row")
    expect(marketEstimate).toMatchObject({
      route: marketRoute,
      acceptedTaskCount: marketRow?.cohort.acceptedTaskCount,
      provenance: {
        source: "openrouter-models",
        recordID: "openai/gpt-6-luna",
        freshness: "current",
      },
    })
    expect(marketRow.configuration.referenceEstimate).toEqual(marketEstimate)
    expect(globalReferenceEstimates).toContainEqual({
      configurationID: marketRow.configuration.configurationID,
      label: marketRow.configuration.label,
      tokensPerAcceptedTask: marketRow.efficiency.tokensPerAcceptedTask,
      estimate: marketEstimate,
    })
    expect(
      configurations.configurations.find(
        (configuration) =>
          configuration.configurationID === marketRow.configuration.configurationID,
      )?.referenceEstimate,
    ).toEqual(marketEstimate)

    const inspection = await Effect.runPromise(
      harness.methods().inspect({
        ...input,
        snapshotID: overview.context.snapshotID,
        configurationID: marketRow.configuration.configurationID,
        selectedTaskID: fixture.tasks.retry!.id,
        contributorLimit: 100,
      }),
    )
    const parsedInspection = ModelDecisionInspectOutputSchema.parse(inspection)
    expect(parsedInspection).toMatchObject({
      status: "found",
      knownUsageMarket: {
        schemaVersion: 1,
        scope: "known-retained-token-usage-only",
        route: marketRoute,
        identity: {
          status: "exact",
          productID: "openai/gpt-6-luna",
          basis: "provider-owner-qualification",
          rules: [{ id: "provider-owner-qualified-local-id-v1" }],
        },
        status: "range",
        scenarios: [
          {
            id: "configured-current-market",
            status: "range",
            freshness: "current",
            tierAttribution: {
              status: "unresolved",
              basis: "aggregate-tier-envelope",
              promptThresholds: [272_000],
            },
            provenance: {
              source: "openrouter-models",
              productID: "openai/gpt-6-luna",
              priceBasis: "average",
              snapshotGeneration: expect.any(Number),
            },
            coverage: {
              scope: "known-route-matched-retained-usage",
              wholeTaskBound: false,
              categories: { uncachedInput: { tokens: 150, status: "observed" } },
              retries: {
                status: "complete",
                attemptCount: 2,
                failedAttemptCount: 1,
                retryAttemptCount: 1,
              },
              route: { matchedRouteSessionCount: 2, includedSessionCount: 2 },
            },
          },
        ],
      },
    })
    if (parsedInspection.status === "found")
      expect(parsedInspection.referenceEstimate).toEqual(marketEstimate)
    if (parsedInspection.status === "found") {
      expect(parsedInspection.knownUsageMarket?.scenarios[0]?.rangeUSD?.minimum).toBeCloseTo(
        0.000015,
        12,
      )
      expect(parsedInspection.knownUsageMarket?.scenarios[0]?.rangeUSD?.maximum).toBeCloseTo(
        0.00003,
        12,
      )
    }
    expect(harness.permissionCalls).toHaveLength(5)
    expect(harness.permissionCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "lz-read-model-decision",
          resources: [fixture.projectDirectory],
        }),
      ]),
    )
  } finally {
    endpointEvidence.store.close()
    fixture.close()
  }
})

test("registered first-page snapshot pins keep rows, configurations, and reference estimates coherent across usage and catalog updates", async () => {
  const fixture = makeLedgerFixture()
  const marketRoute = { providerID: "openai", modelID: "gpt-6-luna", variant: "max" }
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.failed.id,
    marketRoute,
    [100],
  )
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    marketRoute,
    [20, 30],
  )
  writeMarketIdentityEvidence(fixture.path, fixture.projectDirectory)
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const harness = await register(repository, {
    sourceConnections: { openrouter: { status: { status: "connected" } } },
  })
  repository.close()
  const input = {
    sessionID: "ses-native",
    scope: { projectDirectory: fixture.projectDirectory },
    filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  }
  const configurationID = `configuration:${modelConfigurationID(
    marketRoute.providerID,
    marketRoute.modelID,
    marketRoute.variant,
  )}`
  try {
    const overviewA = ModelDecisionOverviewOutputSchema.parse(
      await Effect.runPromise(harness.methods().overview(input)),
    )
    const estimateA = overviewA.graph.referenceEstimates?.find(
      (item) => item.configurationID === configurationID,
    )?.estimate
    expect(estimateA?.status).toBe("conditional")
    expect(estimateA?.provenance.freshness).toBe("current")
    const numeratorA = estimateA?.numeratorRangeUSD
    expect(numeratorA).not.toBeNull()

    // Change relevant retained effort and the published price catalog before any first-page read.
    rewriteAttemptForMarket(
      fixture.path,
      fixture.projectID,
      fixture.attempts.failed.id,
      marketRoute,
      [1_000],
    )
    writeMarketIdentityEvidence(fixture.path, fixture.projectDirectory, {
      promptRate: "0.000001",
    })

    const pinnedRows = ModelDecisionRowsOutputSchema.parse(
      await Effect.runPromise(
        harness.methods().rows({ ...input, snapshotID: overviewA.context.snapshotID, limit: 100 }),
      ),
    )
    const pinnedConfigurations = ModelDecisionConfigurationsOutputSchema.parse(
      await Effect.runPromise(
        harness.methods().configurations({
          ...input,
          snapshotID: overviewA.context.snapshotID,
          limit: 100,
        }),
      ),
    )
    const pinnedRow = pinnedRows.rows.find(
      (row) => row.configuration.configurationID === configurationID,
    )
    expect(pinnedRows.context.snapshotID).toBe(overviewA.context.snapshotID)
    expect(pinnedConfigurations.context.snapshotID).toBe(overviewA.context.snapshotID)
    expect(pinnedRow?.referenceEstimate).toEqual(estimateA)
    expect(pinnedRow?.configuration.referenceEstimate).toEqual(estimateA)
    expect(
      pinnedConfigurations.configurations.find((item) => item.configurationID === configurationID)
        ?.referenceEstimate,
    ).toEqual(estimateA)

    const pinnedInspection = ModelDecisionInspectOutputSchema.parse(
      await Effect.runPromise(
        harness.methods().inspect({
          ...input,
          snapshotID: overviewA.context.snapshotID,
          configurationID,
          selectedTaskID: fixture.tasks.retry!.id,
          contributorLimit: 100,
        }),
      ),
    )
    expect(pinnedInspection.status).toBe("found")
    if (pinnedInspection.status === "found")
      expect(pinnedInspection.referenceEstimate).toEqual(estimateA)

    const pinnedGlobalEstimate = overviewA.graph.referenceEstimates?.find(
      (item) => item.configurationID === configurationID,
    )
    expect(pinnedGlobalEstimate).toMatchObject({
      label: expect.any(String),
      tokensPerAcceptedTask: expect.any(Number),
      estimate: estimateA,
    })

    const refreshedRows = ModelDecisionRowsOutputSchema.parse(
      await Effect.runPromise(harness.methods().rows({ ...input, limit: 100 })),
    )
    const refreshedRow = refreshedRows.rows.find(
      (row) => row.configuration.configurationID === configurationID,
    )
    expect(refreshedRows.context.snapshotID).not.toBe(overviewA.context.snapshotID)
    expect(refreshedRow?.referenceEstimate?.provenance.snapshotID).not.toBe(
      estimateA?.provenance.snapshotID,
    )
    expect(refreshedRow?.referenceEstimate?.numeratorRangeUSD).not.toEqual(numeratorA)
  } finally {
    fixture.close()
  }
})

test("registered ModelsDecision reuses revision-bound unavailable contexts and invalidates on price or ledger changes", async () => {
  const fixture = makeLedgerFixture()
  const storage = new Map<string, unknown>()
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const harness = await register(repository, { storage })
  repository.close()
  const writer = new Database(fixture.path, { strict: true })
  const revision = () =>
    writer
      .query<{ revision: number }, [string]>(
        "SELECT revision FROM observation_revisions WHERE project_directory=?",
      )
      .get(fixture.projectDirectory)?.revision
  const input = {
    sessionID: "ses-native",
    scope: { projectDirectory: fixture.projectDirectory },
    filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  }
  try {
    const beforeRename = revision()
    if (beforeRename === undefined) throw new Error("Fixture observation revision is absent")
    writer.exec("ALTER TABLE tasks RENAME TO unavailable_tasks")
    expect(revision()).toBe(beforeRename)

    const overview = (await Effect.runPromise(harness.methods().overview(input))) as {
      context: { snapshotID: string; availability: string; priceIndex: { note: string } }
      configurationCount: number
    }
    const rows = (await Effect.runPromise(harness.methods().rows({ ...input, limit: 100 }))) as {
      context: { snapshotID: string; availability: string; priceIndex: { note: string } }
      rows: unknown[]
      totalCount: number
    }
    const configurations = (await Effect.runPromise(
      harness.methods().configurations({ ...input, limit: 100 }),
    )) as {
      context: { snapshotID: string; availability: string; priceIndex: { note: string } }
      configurations: unknown[]
      totalCount: number
    }
    expect(overview.context.availability).toBe("backend-not-ready")
    expect(overview.context.priceIndex.note).toContain(
      `project observation revision ${beforeRename}`,
    )
    expect(rows.context.snapshotID).toBe(overview.context.snapshotID)
    expect(configurations.context.snapshotID).toBe(overview.context.snapshotID)
    expect(rows.context.availability).toBe("backend-not-ready")
    expect(configurations.context.availability).toBe("backend-not-ready")
    expect(rows.rows).toEqual([])
    expect(configurations.configurations).toEqual([])
    expect(rows.totalCount).toBe(overview.configurationCount)
    expect(configurations.totalCount).toBe(overview.configurationCount)

    expect(
      await Effect.runPromise(
        harness.methods().configurePriceSources({
          sessionID: "ses-native",
          expectedRevision: 0,
          sources: ["opencode"],
        }),
      ),
    ).toMatchObject({ status: "updated", policy: { revision: 1, sources: ["opencode"] } })
    const afterPriceChange = (await Effect.runPromise(harness.methods().overview(input))) as {
      context: { snapshotID: string; priceIndex: { sourcePolicyRevision: number; note: string } }
    }
    const afterPriceRows = (await Effect.runPromise(
      harness.methods().rows({ ...input, limit: 100 }),
    )) as { context: { snapshotID: string } }
    expect(afterPriceChange.context.snapshotID).not.toBe(overview.context.snapshotID)
    expect(afterPriceChange.context.priceIndex.sourcePolicyRevision).toBe(1)
    expect(afterPriceChange.context.priceIndex.note).toContain(
      `project observation revision ${beforeRename}`,
    )
    expect(afterPriceRows.context.snapshotID).toBe(afterPriceChange.context.snapshotID)

    writer
      .query("UPDATE observation_revisions SET revision=revision+1 WHERE project_directory=?")
      .run(fixture.projectDirectory)
    const afterRevisionChange = (await Effect.runPromise(harness.methods().overview(input))) as {
      context: { snapshotID: string; priceIndex: { note: string } }
    }
    const afterRevisionRows = (await Effect.runPromise(
      harness.methods().rows({ ...input, limit: 100 }),
    )) as { context: { snapshotID: string } }
    expect(afterRevisionChange.context.snapshotID).not.toBe(afterPriceChange.context.snapshotID)
    expect(afterRevisionChange.context.priceIndex.note).toContain(
      `project observation revision ${beforeRename + 1}`,
    )
    expect(afterRevisionRows.context.snapshotID).toBe(afterRevisionChange.context.snapshotID)
  } finally {
    writer.close()
    fixture.close()
  }
})

test("registered inspector maps exact configured Go routes to independently sourced market scenarios", async () => {
  const fixture = makeLedgerFixture()
  const kimiRoute = {
    providerID: "opencode-go",
    modelID: "kimi-k3.1-pro",
    variant: "high",
  }
  const qwenRoute = {
    providerID: "opencode-go",
    modelID: "qwen3.8-flash",
    variant: "medium",
  }
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.failed.id,
    kimiRoute,
    [10],
  )
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    kimiRoute,
    [20],
  )
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.adoption.id,
    qwenRoute,
    [20],
  )
  writeMarketIdentityEvidence(fixture.path, fixture.projectDirectory)
  const endpointEvidence = writeMarketEndpointEvidence(fixture.path, fixture.projectDirectory, [
    {
      productID: "moonshotai/kimi-k3.1-pro",
      providerName: "Moonshot AI",
      tag: "moonshotai/mxfp4",
      pricing: {
        unit: "USD per token",
        prompt: "0.000002",
        completion: "0.00001",
        inputCacheRead: "0.0000002",
      },
    },
    {
      productID: "qwen/qwen3.8-flash",
      providerName: "Alibaba",
      tag: "alibaba",
      pricing: {
        unit: "USD per token",
        prompt: "0.00000015",
        completion: "0.00000047",
        inputCacheRead: "0.000000016",
        inputCacheWrite: "0.0000002",
      },
    },
  ])
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const harness = await register(repository, {
    sourceConnections: { openrouter: { status: { status: "connected" } } },
  })
  repository.close()
  const input = {
    sessionID: "ses-native",
    scope: { projectDirectory: fixture.projectDirectory },
    filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  }

  try {
    const overview = (await Effect.runPromise(harness.methods().overview(input))) as {
      context: { snapshotID: string }
    }
    const rows = (await Effect.runPromise(harness.methods().rows({ ...input, limit: 100 }))) as {
      rows: Array<{ configuration: { configurationID: string; route: typeof kimiRoute } }>
    }
    const cases = [
      {
        route: kimiRoute,
        productID: "moonshotai/kimi-k3.1-pro",
        scenarioID: "configured-current-market",
        selectedTaskID: fixture.tasks.retry!.id,
        value: 0.00006,
      },
      {
        route: qwenRoute,
        productID: "qwen/qwen3.8-flash",
        scenarioID: "configured-current-market",
        selectedTaskID: fixture.tasks.adoption!.id,
        value: 0.000003,
      },
    ] as const
    for (const item of cases) {
      const configurationID = `configuration:${modelConfigurationID(
        item.route.providerID,
        item.route.modelID,
        item.route.variant,
      )}`
      expect(rows.rows.some((row) => row.configuration.configurationID === configurationID)).toBe(
        true,
      )
      const inspection = ModelDecisionInspectOutputSchema.parse(
        await Effect.runPromise(
          harness.methods().inspect({
            ...input,
            snapshotID: overview.context.snapshotID,
            configurationID,
            selectedTaskID: item.selectedTaskID,
            contributorLimit: 100,
          }),
        ),
      )
      expect(inspection).toMatchObject({
        status: "found",
        knownUsageMarket: {
          route: item.route,
          identity: {
            status: "exact",
            productID: item.productID,
            basis: "verified-source-backed-route-alias",
            evidence: {
              catalog: [expect.objectContaining({ recordID: item.productID })],
            },
          },
          status: "exact",
          scenarios: [
            {
              id: item.scenarioID,
              status: "exact",
              provenance: {
                source: "openrouter-models",
                productID: item.productID,
                priceBasis: "average",
                snapshotGeneration: expect.any(Number),
              },
            },
          ],
        },
      })
      if (inspection.status === "found")
        expect(inspection.knownUsageMarket?.scenarios[0]?.valueUSD).toBeCloseTo(item.value, 12)
    }
  } finally {
    endpointEvidence.store.close()
    fixture.close()
  }
})

test("registered inspector leaves unsupported, ambiguous, and absent mappings unknown despite endpoint rates", async () => {
  const fixture = makeLedgerFixture()
  const ambiguousRoute = { providerID: "openai", modelID: "gpt-6-luna", variant: "max" }
  const absentRoute = { providerID: "opencode-go", modelID: "kimi-k3.1-pro", variant: "high" }
  const unsupportedRoute = { providerID: "opencode-go", modelID: "unlisted-model", variant: "max" }
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.failed.id,
    ambiguousRoute,
    [10],
  )
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    absentRoute,
    [20],
  )
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.adoption.id,
    unsupportedRoute,
    [30],
  )
  writeMarketIdentityEvidence(fixture.path, fixture.projectDirectory, {
    duplicateLuna: true,
    includeKimi: false,
  })
  const endpointEvidence = writeMarketEndpointEvidence(fixture.path, fixture.projectDirectory, [
    {
      productID: "openai/gpt-6-luna",
      providerName: "OpenAI",
      tag: "openai",
      pricing: {
        unit: "USD per token",
        prompt: "0.0000001",
        completion: "0.0000005",
        inputCacheRead: "0.00000001",
        inputCacheWrite: "0.000000125",
      },
    },
    {
      productID: "moonshotai/kimi-k3.1-pro",
      providerName: "Moonshot AI",
      tag: "moonshotai/mxfp4",
      pricing: { unit: "USD per token", prompt: "0.000002", completion: "0.00001" },
    },
  ])
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const harness = await register(repository, {
    sourceConnections: { openrouter: { status: { status: "connected" } } },
  })
  repository.close()
  const input = {
    sessionID: "ses-native",
    scope: { projectDirectory: fixture.projectDirectory },
    filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  }

  try {
    const overview = ModelDecisionOverviewOutputSchema.parse(
      await Effect.runPromise(harness.methods().overview(input)),
    )
    const rows = ModelDecisionRowsOutputSchema.parse(
      await Effect.runPromise(
        harness.methods().rows({ ...input, snapshotID: overview.context.snapshotID, limit: 100 }),
      ),
    )
    const cases = [
      {
        route: ambiguousRoute,
        selectedTaskID: fixture.tasks.retry!.id,
        identityStatus: "ambiguous",
        estimateStatus: "zero-accepted",
      },
      {
        route: absentRoute,
        selectedTaskID: fixture.tasks.retry!.id,
        identityStatus: "supported-but-absent",
        estimateStatus: "unavailable",
      },
      {
        route: unsupportedRoute,
        selectedTaskID: fixture.tasks.adoption!.id,
        identityStatus: "unsupported",
        estimateStatus: "unavailable",
      },
    ] as const
    for (const item of cases) {
      const configurationID = `configuration:${modelConfigurationID(
        item.route.providerID,
        item.route.modelID,
        item.route.variant,
      )}`
      const inspection = ModelDecisionInspectOutputSchema.parse(
        await Effect.runPromise(
          harness.methods().inspect({
            ...input,
            snapshotID: overview.context.snapshotID,
            configurationID,
            selectedTaskID: item.selectedTaskID,
            contributorLimit: 100,
          }),
        ),
      )
      expect(inspection).toMatchObject({
        status: "found",
        knownUsageMarket: {
          route: item.route,
          status: "not-applicable",
          identity: { status: item.identityStatus },
          scenarios: [],
        },
      })
      const referenceEstimate = rows.rows.find(
        (row) =>
          row.configuration.route.providerID === item.route.providerID &&
          row.configuration.route.modelID === item.route.modelID &&
          row.configuration.route.variant === item.route.variant,
      )?.referenceEstimate
      expect(referenceEstimate).toMatchObject({
        status: item.estimateStatus,
        route: item.route,
        identityStatus: item.identityStatus,
        numeratorUSD: null,
        numeratorRangeUSD: null,
        valueUSDPerAcceptedTask: null,
        rangeUSDPerAcceptedTask: null,
        provenance: {
          source: "openrouter-models",
          recordID: null,
          snapshotID: expect.any(String),
        },
      })
    }
    expect(endpointEvidence.generations["openai/gpt-6-luna"]).toBeGreaterThan(0)
    expect(endpointEvidence.generations["moonshotai/kimi-k3.1-pro"]).toBeGreaterThan(0)
  } finally {
    endpointEvidence.store.close()
    fixture.close()
  }
})

test("registered inspector pins scenario pages across retained writes and reprices only market evidence", async () => {
  const fixture = makeLedgerFixture()
  const route = { providerID: "openrouter", modelID: "openai/gpt-6-luna", variant: null }
  rewriteAttemptForMarket(fixture.path, fixture.projectID, fixture.attempts.failed.id, route, [100])
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    route,
    [20, 30],
  )
  writeMarketIdentityEvidence(fixture.path, fixture.projectDirectory)
  const sourceEvidenceStore = new ModelEvidenceStore(fixture.path, fixture.projectDirectory)
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const harness = await register(repository, {
    sourceConnections: { openrouter: { status: { status: "connected" } } },
  })
  repository.close()
  const input = {
    sessionID: "ses-native",
    scope: { projectDirectory: fixture.projectDirectory },
    filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  }
  const configurationID = `configuration:${modelConfigurationID(
    route.providerID,
    route.modelID,
    route.variant,
  )}`
  const inspect = async (snapshotID: string, contributorCursor?: string) =>
    ModelDecisionInspectOutputSchema.parse(
      await Effect.runPromise(
        harness.methods().inspect({
          ...input,
          snapshotID,
          configurationID,
          selectedTaskID: fixture.tasks.retry!.id,
          contributorLimit: 1,
          ...(contributorCursor ? { contributorCursor } : {}),
        }),
      ),
    )

  try {
    const firstOverview = (await Effect.runPromise(harness.methods().overview(input))) as {
      context: { snapshotID: string }
    }
    const firstRows = (await Effect.runPromise(
      harness.methods().rows({ ...input, limit: 100 }),
    )) as {
      rows: Array<{
        configuration: { configurationID: string }
        efficiency: unknown
        nativeReportedCost: unknown
      }>
    }
    const firstRow = firstRows.rows.find(
      (candidate) => candidate.configuration.configurationID === configurationID,
    )
    expect(firstRow).toBeDefined()
    const firstInspection = await inspect(firstOverview.context.snapshotID)
    expect(firstInspection.status).toBe("found")
    if (firstInspection.status !== "found") return
    const firstScenario = firstInspection.knownUsageMarket?.scenarios[0]
    expect(firstScenario).toMatchObject({
      status: "range",
      freshness: "current",
      provenance: { snapshotGeneration: 1, currentGeneration: 1 },
      coverage: {
        categories: { uncachedInput: { tokens: 150, status: "observed" } },
        retries: { status: "complete", attemptCount: 2 },
      },
    })
    expect(firstScenario?.rangeUSD?.minimum).toBeCloseTo(0.000015, 12)
    expect(firstScenario?.rangeUSD?.maximum).toBeCloseTo(0.00003, 12)
    const contributorCursor = firstInspection.contributorPage.nextCursor
    expect(contributorCursor).not.toBeNull()

    const staleGeneration = sourceEvidenceStore.beginRefresh()["openrouter-models"]
    rewriteAttemptForMarket(
      fixture.path,
      fixture.projectID,
      fixture.attempts.accepted.id,
      route,
      [40, 60],
    )
    const pinnedPage = await inspect(firstOverview.context.snapshotID, contributorCursor!)
    expect(pinnedPage).toMatchObject({
      status: "found",
      knownUsageMarket: {
        scenarios: [
          {
            freshness: "current",
            provenance: { snapshotGeneration: 1, currentGeneration: 1 },
            coverage: { categories: { uncachedInput: { tokens: 150 } } },
          },
        ],
      },
    })

    const staleOverview = (await Effect.runPromise(harness.methods().overview(input))) as {
      context: { snapshotID: string }
    }
    const staleRows = (await Effect.runPromise(
      harness.methods().rows({ ...input, limit: 100 }),
    )) as typeof firstRows
    const staleRow = staleRows.rows.find(
      (candidate) => candidate.configuration.configurationID === configurationID,
    )
    expect(staleRow).toBeDefined()
    const staleInspection = await inspect(staleOverview.context.snapshotID)
    expect(staleInspection).toMatchObject({
      status: "found",
      knownUsageMarket: {
        status: "range",
        scenarios: [
          {
            status: "range",
            freshness: "stale",
            provenance: {
              snapshotGeneration: staleGeneration - 1,
              currentGeneration: staleGeneration,
              refreshState: "refreshing",
            },
            coverage: {
              categories: { uncachedInput: { tokens: 200, status: "observed" } },
            },
          },
        ],
      },
    })
    if (staleInspection.status !== "found") return
    expect(staleInspection.knownUsageMarket?.scenarios[0]?.rangeUSD?.minimum).toBeCloseTo(
      0.00002,
      12,
    )
    expect(staleInspection.knownUsageMarket?.scenarios[0]?.rangeUSD?.maximum).toBeCloseTo(
      0.00004,
      12,
    )

    writeMarketIdentityEvidence(fixture.path, fixture.projectDirectory, {
      promptRate: "0.0000002",
    })
    const refreshedOverview = (await Effect.runPromise(harness.methods().overview(input))) as {
      context: { snapshotID: string }
    }
    const refreshedRows = (await Effect.runPromise(
      harness.methods().rows({ ...input, limit: 100 }),
    )) as typeof firstRows
    const refreshedRow = refreshedRows.rows.find(
      (candidate) => candidate.configuration.configurationID === configurationID,
    )
    expect(refreshedRow).toBeDefined()
    const refreshedInspection = await inspect(refreshedOverview.context.snapshotID)
    expect(refreshedInspection).toMatchObject({
      status: "found",
      knownUsageMarket: {
        scenarios: [
          {
            status: "range",
            freshness: "current",
            provenance: {
              snapshotGeneration: staleGeneration + 1,
              currentGeneration: staleGeneration + 1,
            },
            coverage: { categories: { uncachedInput: { tokens: 200 } } },
          },
        ],
      },
    })
    if (refreshedInspection.status === "found") {
      expect(refreshedInspection.knownUsageMarket?.scenarios[0]?.rangeUSD?.minimum).toBeCloseTo(
        0.00004,
        12,
      )
      expect(refreshedInspection.knownUsageMarket?.scenarios[0]?.rangeUSD?.maximum).toBeCloseTo(
        0.00004,
        12,
      )
    }
    expect(refreshedRow?.efficiency).toEqual(staleRow?.efficiency)
    expect(refreshedRow?.nativeReportedCost).toEqual(staleRow?.nativeReportedCost)
    expect(firstRow?.efficiency).not.toEqual(staleRow?.efficiency)
  } finally {
    sourceEvidenceStore.close()
    fixture.close()
  }
})

test("registered inspector omits an amount when the configured source has no published prices", async () => {
  const fixture = makeLedgerFixture()
  const route = { providerID: "openrouter", modelID: "openai/gpt-6-luna", variant: null }
  rewriteAttemptForMarket(fixture.path, fixture.projectID, fixture.attempts.failed.id, route, [100])
  rewriteAttemptForMarket(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    route,
    [20, 30],
  )
  writeMarketIdentityEvidence(fixture.path, fixture.projectDirectory, {
    withoutPrices: ["openai/gpt-6-luna"],
  })
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const harness = await register(repository, {
    sourceConnections: { openrouter: { status: { status: "connected" } } },
  })
  repository.close()
  try {
    const input = {
      sessionID: "ses-native",
      scope: { projectDirectory: fixture.projectDirectory },
      filters: { persona: null, taskKind: null, period: { from: null, to: null } },
    }
    const overview = (await Effect.runPromise(harness.methods().overview(input))) as {
      context: { snapshotID: string }
    }
    const rows = (await Effect.runPromise(harness.methods().rows({ ...input, limit: 100 }))) as {
      rows: Array<{ configuration: { configurationID: string } }>
    }
    const configurationID = `configuration:${modelConfigurationID(
      route.providerID,
      route.modelID,
      route.variant,
    )}`
    const inspection = ModelDecisionInspectOutputSchema.parse(
      await Effect.runPromise(
        harness.methods().inspect({
          ...input,
          snapshotID: overview.context.snapshotID,
          configurationID,
          selectedTaskID: fixture.tasks.retry!.id,
          contributorLimit: 100,
        }),
      ),
    )
    expect(rows.rows.some((row) => row.configuration.configurationID === configurationID)).toBe(
      true,
    )
    expect(inspection).toMatchObject({
      status: "found",
      knownUsageMarket: {
        identity: { status: "exact", productID: "openai/gpt-6-luna" },
        status: "unavailable",
        scenarios: [],
      },
    })
    expect(tableExists(fixture.path, "model_endpoint_pricing_refreshes")).toBe(true)
    expect(tableExists(fixture.path, "model_endpoint_pricing_snapshots")).toBe(true)
  } finally {
    fixture.close()
  }
})

test("ModelsDecision foreign scope, denial and pre-abort do not read price sources", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  let denied = false
  let evidenceReads = 0
  const harness = await register(repository, {
    denied: () => denied,
    evidenceReadStoreFactory: (databasePath, directory) => {
      evidenceReads++
      return new ModelEvidenceReadStore(databasePath, directory)
    },
  })
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
    expect(evidenceReads).toBe(0)

    denied = true
    await expect(Effect.runPromise(harness.methods().overview(input))).rejects.toThrow(
      "native permission denied",
    )
    expect(harness.sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(evidenceReads).toBe(0)
    expect(harness.storageCalls.get).toBe(0)

    denied = false
    const controller = new AbortController()
    controller.abort()
    await expect(
      Effect.runPromise(harness.methods().overview(input), { signal: controller.signal }),
    ).rejects.toThrow()
    expect(harness.sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(evidenceReads).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("cancelled ModelsDecision price/evidence read closes its source store and cannot publish", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const controller = new AbortController()
  let evidenceOpens = 0
  let evidenceCloses = 0
  const harness = await register(repository, {
    evidenceReadStoreFactory: (databasePath, directory) => {
      evidenceOpens++
      const reader = new ModelEvidenceReadStore(databasePath, directory)
      return {
        projectDirectory: directory,
        readComparisonSources(selection) {
          const sources = reader.readComparisonSources(selection)
          controller.abort()
          return sources
        },
        close() {
          evidenceCloses++
          reader.close()
        },
      }
    },
  })
  repository.close()
  try {
    const exit = await Effect.runPromiseExit(
      harness.methods().overview({
        sessionID: "ses-native",
        scope: { projectDirectory },
        filters: { persona: null, taskKind: null, period: { from: null, to: null } },
      }),
      { signal: controller.signal },
    )
    expect(exit._tag).toBe("Failure")
    expect(evidenceOpens).toBe(1)
    expect(evidenceCloses).toBe(1)
    expect(harness.permissionCalls).toHaveLength(1)
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
    harness.methods().refreshSources({ sessionID: "ses-native", force: true }),
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

test("saving an agent route re-applies the agent transforms and the settings read names its source", async () => {
  const root = directory()
  const repository = new TaskRepository(join(root, "tasks.sqlite"), projectDirectory)
  const harness = await register(repository)
  const methods = harness.methods()
  repository.close()
  try {
    const agents = async () =>
      (
        (await Effect.runPromise(methods.settings({ sessionID: "ses-native" }))) as {
          agents: Array<{ agentID: string; source: string }>
        }
      ).agents
    // Nothing set: no reload, and no LAZERS source.
    expect((await agents()).find((agent) => agent.agentID === "architect")?.source).toBe("none")

    const route = { providerID: "anthropic", id: "claude-opus-5", variant: "max" }
    expect(
      await Effect.runPromise(
        methods.configure({
          sessionID: "ses-native",
          target: { scope: "project" },
          persona: "architect",
          expectedRevision: 0,
          route,
        }),
      ),
    ).toMatchObject({ status: "updated", mapping: { persona: "architect", route } })
    // The agent transforms run again, so the next Architect session starts on the new model.
    expect(harness.agentReloads.count).toBe(1)
    expect((await agents()).find((agent) => agent.agentID === "architect")?.source).toBe("project")

    // A persona route is not an agent route: it does not reload.
    await Effect.runPromise(
      methods.configure({
        sessionID: "ses-native",
        target: { scope: "shared" },
        persona: "ui",
        expectedRevision: 0,
        route,
      }),
    )
    expect(harness.agentReloads.count).toBe(1)

    // A stale write is a conflict and re-applies nothing.
    expect(
      await Effect.runPromise(
        methods.configure({
          sessionID: "ses-native",
          target: { scope: "project" },
          persona: "architect",
          expectedRevision: 0,
          route: null,
        }),
      ),
    ).toMatchObject({ status: "conflict" })
    expect(harness.agentReloads.count).toBe(1)

    // An agent route cannot be task-scoped.
    await expect(
      Effect.runPromise(
        methods.configure({
          sessionID: "ses-native",
          target: { scope: "task", taskID: crypto.randomUUID() },
          persona: "auditor",
          expectedRevision: 0,
          route,
        }),
      ),
    ).rejects.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("ModelsDecision serves an all-projects overview and rows, a page per project with its stamp", async () => {
  const fixture = makeLedgerFixture()
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const { registerProject } = await import("../project-key.ts")
  const first = await registerProject(repository, {
    directory: fixture.projectDirectory,
    opencodeProjectID: fixture.projectID,
  })
  const otherDirectory = "/other-project"
  const other = new TaskRepository(fixture.path, otherDirectory)
  const second = await registerProject(other, {
    directory: otherDirectory,
    opencodeProjectID: "other-opencode-project",
  })
  other.close()
  const harness = await register(repository, {
    sourceConnections: { openrouter: { status: { status: "connected" } } },
  })
  repository.close()
  try {
    const filters = { persona: null, taskKind: null, period: { from: null, to: null } }
    const methods = harness.methods() as unknown as {
      overviewAll(input: unknown): Effect.Effect<unknown, unknown>
      rowsAll(input: unknown): Effect.Effect<unknown, unknown>
    }
    const pages: ReturnType<typeof ModelDecisionOverviewAllOutputSchema.parse>[] = []
    let cursor: string | undefined
    do {
      const page = ModelDecisionOverviewAllOutputSchema.parse(
        await Effect.runPromise(
          methods.overviewAll({ sessionID: "ses-native", filters, ...(cursor ? { cursor } : {}) }),
        ),
      )
      pages.push(page)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect([...new Set(pages.map((page) => page.project.key))]).toEqual([first.key, second.key])
    expect(pages.every((page) => page.project.loaded === false)).toBe(true)
    expect(pages[0]?.overview.context.scope).toEqual({ projectDirectory: fixture.projectDirectory })
    expect(JSON.stringify(pages.map((page) => page.nextCursor))).not.toContain("other-project")
    const rows = ModelDecisionRowsAllOutputSchema.parse(
      await Effect.runPromise(
        methods.rowsAll({
          sessionID: "ses-native",
          unit: pages[0]!.unit,
          filters,
          snapshotID: pages[0]!.overview.context.snapshotID,
          limit: 10,
        }),
      ),
    )
    expect(rows.project.key).toBe(first.key)
    // Looking at one's own projects in a panel never asks for a permission.
    expect(harness.permissionCalls).toEqual([])
    await expect(
      Effect.runPromise(
        methods.rowsAll({ sessionID: "ses-native", unit: "0".repeat(32), filters, limit: 10 }),
      ),
    ).rejects.toThrow("Models scope is unavailable")
  } finally {
    fixture.close()
  }
})
