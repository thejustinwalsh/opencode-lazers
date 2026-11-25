import { Database } from "bun:sqlite"
import { ARCHIVED_SESSION_MESSAGE } from "../session-archived.ts"
import { expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Exit, Schema, Scope } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import captured from "../../test/models-identity/fixtures/captured-20261103.json" with { type: "json" }
import { TaskRepository } from "../storage.ts"
import { registerModelTools } from "./tools.ts"
import type { ModelEvidenceFetcher } from "./source-refresh.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"
import { ModelEvidenceSnapshotSchema } from "./source-schema.ts"
import { buildCurrentPriceIndex } from "./current-price-index.ts"
import { ModelPriceSourceSettingsSchema } from "./price-source-settings.ts"
import { authorizeModels, registerModelsServer } from "./server.ts"
import { readerPool } from "../streams/pool.ts"
import { openStream } from "../streams/client.ts"
import type { StreamContext } from "../streams/source.ts"
import {
  modelContributorsSource,
  modelAssignmentsSource,
  modelPointsSource,
  modelPricePolicySource,
  modelViewSource,
} from "../streams/sources/models.ts"
import type { ModelPointsFilter, ModelViewFilter } from "../streams/sources/models-ref.ts"
import type { DecisionInspectionFacts } from "./decision-read.ts"
import { assignmentSettingsOf, type AssignmentLayerRow } from "./assignment-settings.ts"
import { ensureModelAssignmentViewSchema } from "./assignment-view.ts"
import type { ModelDecisionContributor, ModelDecisionOverview } from "./decision-contract.ts"
import {
  createModelsManagedUsagePriceProvider,
  createModelsTaskValuationProvider,
} from "./server.ts"
import type { ProjectTaskValuationRequest } from "./valuation.ts"
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"
import { ENDPOINT_PRICING_PRODUCTS, EndpointPricingRecordSchema } from "./endpoint-pricing.ts"
import type { EndpointPricingProductID, EndpointPricingRecord } from "./endpoint-pricing.ts"
import { modelConfigurationID } from "./model-identity.ts"
import capturedGo from "../../test/models-identity/fixtures/captured-go-openrouter-20261103.json" with { type: "json" }

type RegisteredTool = Parameters<ToolEditor["add"]>[0]
type ModelRPC = {
  /** Test-side: the settings the assignments stream composes (`withStreamedReads`). */
  settings(input: unknown): Effect.Effect<unknown, unknown>
  configure(input: unknown): Effect.Effect<unknown, unknown>
  priceSources(input: unknown): Effect.Effect<unknown, unknown>
  configurePriceSources(input: unknown): Effect.Effect<unknown, unknown>
  refreshSources(input: unknown): Effect.Effect<unknown, unknown>
}

/**
 * The settings read the Models panel takes from a stream now, rebuilt for these registration
 * tests: the assignments stream's composition of the stored layer rows.
 */
function withStreamedReads(methods: ModelRPC, repository: TaskRepository): ModelRPC {
  const { path, projectDirectory: directory } = repository
  const settings = (input: unknown) =>
    Effect.promise(async () => {
      const { taskID } = input as { taskID?: string }
      const reader = new TaskRepository(path, directory)
      try {
        ensureModelAssignmentViewSchema(reader)
        const { where, params } = modelAssignmentsSource.filter({
          projectDirectory: directory,
          sessionID: "",
          taskID: taskID ?? null,
        })
        const rows = reader.read((db) =>
          db
            .query<AssignmentLayerRow & { record: string }, string[]>(
              `SELECT * FROM model_assignment_view WHERE ${where} ORDER BY subject, layer, id`,
            )
            .all(...(params as string[]))
            .map((row) => ({ ...row, record: JSON.parse(row.record) as unknown })),
        )
        return assignmentSettingsOf(rows, directory, taskID ?? null)
      } finally {
        reader.close()
      }
    })
  return { ...methods, settings }
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
    priceSources: () => Effect.die(new Error("RPC not registered")),
    configurePriceSources: () => Effect.die(new Error("RPC not registered")),
    refreshSources: () => Effect.die(new Error("RPC not registered")),
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
    /** Keep the registration open (decision views build and are opened through it) until `close`. */
    live?: boolean
    backgroundRefreshMs?: number
  } = {},
) {
  const native = modelContext(options)
  const { tools, editor } = registeredEditor()
  const scope = options.live ? await Effect.runPromise(Scope.make()) : undefined
  const registration = Effect.gen(function* () {
    yield* registerModelsServer(
      native.context as never,
      repository,
      options.fetcher,
      options.evidenceReadStoreFactory,
      options.backgroundRefreshMs === undefined
        ? {}
        : { backgroundRefreshMs: options.backgroundRefreshMs },
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
  })
  await Effect.runPromise(
    scope ? registration.pipe(Scope.provide(scope)) : Effect.scoped(registration),
  )
  return {
    ...native,
    tools,
    methods: () => withStreamedReads(native.methods() as unknown as ModelRPC, repository),
    close: () => (scope ? Effect.runPromise(Scope.close(scope, Exit.void)) : Promise.resolve()),
  }
}

const ALL_FILTERS = { persona: null, taskKind: null, period: { from: null, to: null } } as const

/**
 * The stored decision view, read the way the Models panel reads it: each source's `authorize`
 * (the session and the RPC's own permission, through the registered context) opens the view, the
 * decision worker builds it, and the rows are walked through a reader pool. The view is rebuilt
 * on open; `read(after)` waits for a snapshot other than `after`.
 */
function decisionStreams(
  harness: { context: unknown },
  path: string,
  options: { directory?: string; view?: ModelViewFilter["view"] } = {},
) {
  const directory = options.directory ?? projectDirectory
  const pool = readerPool(path, { workers: 1 })
  const sql = new Database(path, { readonly: true, strict: true })
  const releases: Array<() => void> = []
  const context: StreamContext = {
    projectID,
    projectDirectory: directory,
    projectIds: (id) => [id],
    assertRead: async () => {},
    assertAction: async (sessionID, action) => {
      await authorizeModels(
        harness.context as never,
        sessionID,
        projectID,
        action,
        [directory],
        new AbortController().signal,
      )
    },
  }
  const request = (projectDirectoryInput = directory): ModelPointsFilter => ({
    projectDirectory: projectDirectoryInput,
    sessionID: "ses-native",
    view: options.view ?? { filters: ALL_FILTERS },
  })
  const walk = async (
    source: { columns: Record<string, unknown>; detail?: Record<string, unknown> },
    filter: unknown,
    order: string,
    window: number,
  ) => {
    const stream = openStream(pool, source as never, { filter, order, window, transport: "copy" })
    try {
      await stream.ready()
      const seen = new Map<number, Record<string, unknown>>()
      const take = () => {
        for (const row of stream.items as Record<string, unknown>[]) seen.set(row.id as number, row)
      }
      take()
      while (stream.after !== 0) {
        await stream.slide(window)
        take()
      }
      return [...seen.values()]
    } finally {
      stream.close()
    }
  }
  const settle = async (viewID: number, after: string | null) => {
    const deadline = Date.now() + 60_000
    for (;;) {
      const row = sql
        .query<{ state: string; snapshot_id: string | null; last_error: string | null }, [number]>(
          "SELECT state,snapshot_id,last_error FROM model_decision_views WHERE id=?",
        )
        .get(viewID)
      if (row?.state === "ready" && row.snapshot_id !== after) return
      if (Date.now() > deadline)
        throw new Error(`The decision view did not build: ${row?.last_error ?? row?.state}`)
      await Bun.sleep(20)
    }
  }
  return {
    /** Authorize and open the view through the points source; the build starts. */
    authorize: async (input = request()) => {
      const scoped = await modelPointsSource.authorize!(input, context)
      releases.push(() => modelPointsSource.release!(scoped))
      return scoped
    },
    /** The view once built (a snapshot other than `after`): its context and every configuration. */
    async read(after: string | null = null) {
      const scoped = await this.authorize()
      await settle(scoped.viewID!, after)
      const [view] = await walk(modelViewSource, scoped, "key", 1)
      const rows = await walk(modelPointsSource, scoped, "chart", 100)
      const viewContext = view!.context as ModelDecisionOverview["context"]
      return {
        scoped,
        context: viewContext,
        counts: view!.counts as { configurationCount: number; groupCount: number },
        rows,
        /** The stored inspection facts of each configuration, in the chart's order. */
        points: rows.map((row) => row.inspection as DecisionInspectionFacts),
        find: (configurationID: string) =>
          rows
            .map((row) => row.inspection as DecisionInspectionFacts)
            .find((facts) => facts.configuration.configurationID === configurationID),
      }
    },
    /** One configuration's contributors in the inspection's order. */
    async contributors(scoped: ModelPointsFilter, configurationID: string) {
      const filter = { ...scoped, configurationID }
      const rows = await walk(modelContributorsSource, filter, "inspection", 100)
      return rows.map((row) => row.detail as ModelDecisionContributor)
    },
    close: async () => {
      for (const release of releases) release()
      await pool.close()
      sql.close()
    },
  }
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

test("registered tool and Desktop RPC share exact persisted mappings after setup connection closes", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const taskID = makeTask(repository)
  const permissionCalls: unknown[] = []
  const harness = await register(repository, {
    permissionCalls,
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

    const savedSettings = await Effect.runPromise(
      methods.settings({ sessionID: "ses-native", taskID }),
    )
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
    live: true,
  })
  const methods = harness.methods()
  const policyProjection = () =>
    repository.read((db) =>
      db
        .query<{ revision: number; sources: string }, [string]>(
          "SELECT revision,sources FROM model_price_source_policy WHERE project_directory=?",
        )
        .get(projectDirectory),
    )

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
    expect(policyProjection()).toEqual({
      revision: 1,
      sources: JSON.stringify(["opencode", "openrouter", "models-dev"]),
    })
    const streamContext: StreamContext = {
      projectID,
      projectDirectory,
      projectIds: (id) => [id],
      assertRead: async () => {},
      assertAction: async (sessionID, action) => {
        await authorizeModels(
          harness.context as never,
          sessionID,
          projectID,
          action,
          [projectDirectory],
          new AbortController().signal,
        )
      },
    }
    const streamFilter = await modelPricePolicySource.authorize!(
      { projectDirectory, sessionID: "ses-native" },
      streamContext,
    )
    const policyStream = openStream(
      readerPool(path, { workers: 1 }),
      modelPricePolicySource as never,
      { filter: streamFilter, order: "project", window: 1, transport: "copy" },
    )
    try {
      await policyStream.ready()
      expect(policyStream.items[0]).toMatchObject({
        revision: 1,
        sources: ["opencode", "openrouter", "models-dev"],
      })
      const frameChanged = new Promise<void>((resolve) => {
        policyStream.on("change", resolve)
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
      await frameChanged
      expect(policyStream.items[0]).toMatchObject({
        revision: 2,
        sources: ["opencode", "models-dev"],
      })
      expect(policyProjection()).toEqual({
        revision: 2,
        sources: JSON.stringify(["opencode", "models-dev"]),
      })
    } finally {
      policyStream.close()
    }

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
    expect(policyProjection()).toEqual({
      revision: 2,
      sources: JSON.stringify(["opencode", "models-dev"]),
    })
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
    await harness.close()
    repository.close()
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

    const managedProvider = createModelsManagedUsagePriceProvider(
      harness.context as never,
      repository,
    )
    const managed = await managedProvider(
      [
        {
          sessionID: "ses-managed",
          assistantMessageID: "msg-managed",
          startSequence: 5,
          terminalSequence: 6,
          startEventIDs: ["managed-start"],
          terminalEventIDs: ["managed-end"],
          eventFactCount: 2,
          provenanceTruncated: false,
          route,
          routeStatus: "observed",
          categories: {
            uncachedInput: { tokens: 10, status: "observed" },
            output: { tokens: 3, status: "observed" },
            reasoning: { tokens: 2, status: "observed" },
            cacheRead: { tokens: 5, status: "observed" },
            cacheWrite: { tokens: 0, status: "observed" },
          },
          outcome: "succeeded",
          status: "observed",
          association: { kind: "unallocated" },
          associationRevision: null,
          associationBoundarySequence: null,
          associationReason: "test usage is intentionally unallocated",
        },
      ],
      new AbortController().signal,
    )
    expect(managed.calls[0]?.quote).toMatchObject({
      status: "observed",
      pinStatus: "resolved",
    })
    expect(managed.currentPrice).toMatchObject({
      freshness: "current",
      policy: {
        sources: ["openrouter", "opencode", "models-dev"],
      },
      access: { "models-dev": "configured" },
      pins: [{ provenance: { source: "native-catalog", generation: 5 } }],
    })
    expect(harness.sourceAccessIDs).toEqual(["openrouter", "openrouter", "openrouter"])

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
    live: true,
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
  const streams = decisionStreams(harness, fixture.path, { directory: fixture.projectDirectory })

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
    // A refresh answers with statuses; endpoint pricing bodies come only from an explicit read.
    expect(refreshed).not.toHaveProperty("endpointPricing")
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

    const currentView = await streams.read()
    expect(currentView.context.priceIndex).toMatchObject({
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
    const staleView = await streams.read(currentView.context.snapshotID)
    expect(staleView.context.priceIndex).toMatchObject({
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
    const cacheOnlyView = await streams.read(staleView.context.snapshotID)
    expect(cacheOnlyView.context.priceIndex).toMatchObject({
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
    await streams.close()
    await harness.close()
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
      { id: "ses-native", projectID: "foreign-project", agent: "desktop-settings-user", time: {} },
    ]) {
      harness.setActor(invalidActor)
      expect(await rejects(read())).toBeInstanceOf(Error)
      expect(await rejects(write())).toBeInstanceOf(Error)
    }
    // An archived session writes nothing (its read is covered by the archived-session test).
    harness.setActor({
      id: "ses-native",
      projectID,
      agent: "desktop-settings-user",
      time: { archived: 10 },
    })
    expect(await rejects(write())).toBeInstanceOf(Error)

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

test("Models source refresh fetches without credentials and only after authorization", async () => {
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
    expect(
      refreshed.sources.find(({ source }) => source === "native-catalog")!.latestSnapshotID,
    ).toEqual(expect.any(String))
    expect(permissionCalls.map((entry) => (entry as { action: string }).action)).toEqual([
      "lz-refresh-model-evidence",
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an archived session of this project reads Models as a live one; a change gets the plain archived reason", async () => {
  // Live 2026-11-22: the Architect's renewals archive its session while the Models panel stays
  // open on it, and every read failed with "Models scope is unavailable".
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  const harness = await register(repository)
  repository.close()
  const archived = { id: "ses-native", projectID, agent: "architect", time: { archived: 10 } }
  const authorize = (action: string) =>
    authorizeModels(
      harness.context as never,
      "ses-native",
      projectID,
      action,
      [projectDirectory],
      new AbortController().signal,
    )
  try {
    harness.setActor(archived)
    // The stream sources' checks (`assertAction` in src/index.ts).
    for (const action of [
      "lz-read-model-decision",
      "lz-read-model-comparison",
      "lz-get-model-settings",
    ])
      expect(await authorize(action)).toMatchObject({ id: "ses-native" })
    const methods = harness.methods()
    expect(await Effect.runPromise(methods.priceSources({ sessionID: "ses-native" }))).toBeDefined()
    expect(
      await Effect.runPromise(methods.refreshSources({ sessionID: "ses-native" })),
    ).toBeDefined()
    expect(
      await rejects(methods.refreshSources({ sessionID: "ses-native", force: true })),
    ).toMatchObject({ message: ARCHIVED_SESSION_MESSAGE })
    // A change gets the plain reason, not a scope error.
    await expect(authorize("lz-configure-models")).rejects.toThrow(ARCHIVED_SESSION_MESSAGE)
    // A session of another project, or one without an agent, still reads nothing.
    harness.setActor({ ...archived, projectID: "foreign-project" })
    await expect(authorize("lz-read-model-decision")).rejects.toThrow("Models scope is unavailable")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Models source refresh denial, foreign and archived sessions do not initialize or access sources", async () => {
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
    }
    harness.setActor({ id: "ses-native", projectID, agent: "desktop-settings-user", time: {} })
    denied = true
    expect(
      await rejects(methods.refreshSources({ sessionID: "ses-native", force: true })),
    ).toMatchObject({
      message: "native permission denied",
    })

    expect(tableExists(path, "model_evidence_snapshots")).toBe(false)
    expect(tableExists(path, "model_evidence_refreshes")).toBe(false)
    expect(sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(permissionCalls).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("registered ModelsDecision reuses revision-bound unavailable contexts and invalidates on price or ledger changes", async () => {
  const fixture = makeLedgerFixture()
  const storage = new Map<string, unknown>()
  const repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  const harness = await register(repository, { storage, live: true })
  repository.close()
  new ModelEvidenceStore(fixture.path, fixture.projectDirectory).close()
  const streams = decisionStreams(harness, fixture.path, { directory: fixture.projectDirectory })
  const writer = new Database(fixture.path, { strict: true })
  const revision = () =>
    writer
      .query<{ revision: number }, [string]>(
        "SELECT revision FROM observation_revisions WHERE project_directory=?",
      )
      .get(fixture.projectDirectory)?.revision
  try {
    const beforeRename = revision()
    if (beforeRename === undefined) throw new Error("Fixture observation revision is absent")
    writer.exec("ALTER TABLE tasks RENAME TO unavailable_tasks")
    expect(revision()).toBe(beforeRename)

    const unavailable = await streams.read()
    expect(unavailable.context.availability).toBe("backend-not-ready")
    expect(unavailable.context.priceIndex.note).toContain(
      `project observation revision ${beforeRename}`,
    )
    expect(unavailable.points).toEqual([])
    expect(unavailable.counts.configurationCount).toBe(0)

    expect(
      await Effect.runPromise(
        harness.methods().configurePriceSources({
          sessionID: "ses-native",
          expectedRevision: 0,
          sources: ["opencode"],
        }),
      ),
    ).toMatchObject({ status: "updated", policy: { revision: 1, sources: ["opencode"] } })
    const afterPriceChange = await streams.read(unavailable.context.snapshotID)
    expect(afterPriceChange.context.snapshotID).not.toBe(unavailable.context.snapshotID)
    expect(afterPriceChange.context.priceIndex.sourcePolicyRevision).toBe(1)
    expect(afterPriceChange.context.priceIndex.note).toContain(
      `project observation revision ${beforeRename}`,
    )

    writer
      .query("UPDATE observation_revisions SET revision=revision+1 WHERE project_directory=?")
      .run(fixture.projectDirectory)
    const afterRevisionChange = await streams.read(afterPriceChange.context.snapshotID)
    expect(afterRevisionChange.context.snapshotID).not.toBe(afterPriceChange.context.snapshotID)
    expect(afterRevisionChange.context.priceIndex.note).toContain(
      `project observation revision ${beforeRename + 1}`,
    )
  } finally {
    writer.close()
    await streams.close()
    await harness.close()
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
    live: true,
  })
  repository.close()
  const streams = decisionStreams(harness, fixture.path, { directory: fixture.projectDirectory })

  try {
    const view = await streams.read()
    const cases = [
      {
        route: kimiRoute,
        productID: "moonshotai/kimi-k3.1-pro",
        scenarioID: "configured-current-market",
        value: 0.00006,
      },
      {
        route: qwenRoute,
        productID: "qwen/qwen3.8-flash",
        scenarioID: "configured-current-market",
        value: 0.000003,
      },
    ] as const
    for (const item of cases) {
      const configurationID = `configuration:${modelConfigurationID(
        item.route.providerID,
        item.route.modelID,
        item.route.variant,
      )}`
      const inspection = view.find(configurationID)
      expect(inspection).toBeDefined()
      expect(inspection).toMatchObject({
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
      expect(inspection?.knownUsageMarket?.scenarios[0]?.valueUSD).toBeCloseTo(item.value, 12)
    }
  } finally {
    await streams.close()
    await harness.close()
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
    live: true,
  })
  repository.close()
  const streams = decisionStreams(harness, fixture.path, { directory: fixture.projectDirectory })

  try {
    const view = await streams.read()
    const cases = [
      {
        route: ambiguousRoute,
        identityStatus: "ambiguous",
        estimateStatus: "zero-accepted",
      },
      {
        route: absentRoute,
        identityStatus: "supported-but-absent",
        estimateStatus: "unavailable",
      },
      {
        route: unsupportedRoute,
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
      const inspection = view.find(configurationID)
      expect(inspection).toBeDefined()
      expect(inspection).toMatchObject({
        knownUsageMarket: {
          route: item.route,
          status: "not-applicable",
          identity: { status: item.identityStatus },
          scenarios: [],
        },
      })
      const referenceEstimate = inspection?.referenceEstimate
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
    await streams.close()
    await harness.close()
    endpointEvidence.store.close()
    fixture.close()
  }
})

test("registered inspector keeps a scenario's snapshot generation across retained writes and reprices only market evidence", async () => {
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
    live: true,
  })
  repository.close()
  const streams = decisionStreams(harness, fixture.path, { directory: fixture.projectDirectory })
  const configurationID = `configuration:${modelConfigurationID(
    route.providerID,
    route.modelID,
    route.variant,
  )}`

  try {
    const first = await streams.read()
    const firstFacts = first.find(configurationID)
    expect(firstFacts).toBeDefined()
    const firstScenario = firstFacts?.knownUsageMarket?.scenarios[0]
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

    const staleGeneration = sourceEvidenceStore.beginRefresh()["openrouter-models"]
    rewriteAttemptForMarket(
      fixture.path,
      fixture.projectID,
      fixture.attempts.accepted.id,
      route,
      [40, 60],
    )
    const stale = await streams.read(first.context.snapshotID)
    const staleFacts = stale.find(configurationID)
    expect(staleFacts).toMatchObject({
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
    expect(staleFacts?.knownUsageMarket?.scenarios[0]?.rangeUSD?.minimum).toBeCloseTo(0.00002, 12)
    expect(staleFacts?.knownUsageMarket?.scenarios[0]?.rangeUSD?.maximum).toBeCloseTo(0.00004, 12)

    writeMarketIdentityEvidence(fixture.path, fixture.projectDirectory, {
      promptRate: "0.0000002",
    })
    const refreshed = await streams.read(stale.context.snapshotID)
    const refreshedFacts = refreshed.find(configurationID)
    expect(refreshedFacts).toMatchObject({
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
    expect(refreshedFacts?.knownUsageMarket?.scenarios[0]?.rangeUSD?.minimum).toBeCloseTo(
      0.00004,
      12,
    )
    expect(refreshedFacts?.knownUsageMarket?.scenarios[0]?.rangeUSD?.maximum).toBeCloseTo(
      0.00004,
      12,
    )
    expect(refreshedFacts?.efficiency).toEqual(staleFacts?.efficiency)
    expect(refreshedFacts?.nativeReportedCost).toEqual(staleFacts?.nativeReportedCost)
    expect(firstFacts?.efficiency).not.toEqual(staleFacts?.efficiency)
  } finally {
    await streams.close()
    await harness.close()
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
    live: true,
  })
  repository.close()
  const streams = decisionStreams(harness, fixture.path, { directory: fixture.projectDirectory })
  try {
    const view = await streams.read()
    const configurationID = `configuration:${modelConfigurationID(
      route.providerID,
      route.modelID,
      route.variant,
    )}`
    expect(view.find(configurationID)).toMatchObject({
      knownUsageMarket: {
        identity: { status: "exact", productID: "openai/gpt-6-luna" },
        status: "unavailable",
        scenarios: [],
      },
    })
    expect(tableExists(fixture.path, "model_endpoint_pricing_refreshes")).toBe(true)
    expect(tableExists(fixture.path, "model_endpoint_pricing_snapshots")).toBe(true)
  } finally {
    await streams.close()
    await harness.close()
    fixture.close()
  }
})

test("a decision view stream narrows a foreign scope, denies without a permission and reads no price source on the main thread", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  let denied = false
  let evidenceReads = 0
  const harness = await register(repository, {
    denied: () => denied,
    live: true,
    evidenceReadStoreFactory: (databasePath, directory) => {
      evidenceReads++
      return new ModelEvidenceReadStore(databasePath, directory)
    },
  })
  repository.close()
  const streams = decisionStreams(harness, path)
  try {
    // The project is the service's own, whatever the caller sent.
    const foreign = await streams.authorize({
      projectDirectory: `${projectDirectory}/foreign`,
      sessionID: "ses-native",
      view: { filters: ALL_FILTERS },
    })
    expect(foreign.projectDirectory).toBe(projectDirectory)
    expect(harness.permissionCalls).toHaveLength(1)
    expect(evidenceReads).toBe(0)

    denied = true
    await expect(streams.authorize()).rejects.toThrow("native permission denied")
    expect(harness.sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(evidenceReads).toBe(0)
    expect(harness.storageCalls.get).toBe(0)

    // A session that is not the project's cannot open a view.
    denied = false
    harness.setActor(null)
    await expect(streams.authorize()).rejects.toThrow()
    expect(harness.sourceAccessCalls).toEqual({ active: 0, resolve: 0 })
    expect(evidenceReads).toBe(0)
  } finally {
    await streams.close()
    await harness.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("a decision view builds in the worker without opening evidence on the main thread, and a closed registration opens none", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  let evidenceOpens = 0
  const harness = await register(repository, {
    live: true,
    evidenceReadStoreFactory: (databasePath, directory) => {
      evidenceOpens++
      return new ModelEvidenceReadStore(databasePath, directory)
    },
  })
  repository.close()
  new ModelEvidenceStore(path, projectDirectory).close()
  const streams = decisionStreams(harness, path)
  try {
    const view = await streams.read()
    expect(view.context.availability).toBeDefined()
    // The worker reads catalogs and endpoint pricing from SQLite itself; only price inputs are
    // read here, so the main thread opened no evidence store for the view's build.
    expect(evidenceOpens).toBe(0)

    // Once the registration is closed its opener is gone: no view is opened or published.
    await harness.close()
    await expect(streams.authorize()).rejects.toThrow("Models scope is unavailable")
    expect(evidenceOpens).toBe(0)
  } finally {
    await streams.close()
    await harness.close()
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

test("prices refresh on the service's timer with no panel open; a failed source records why and the others still refresh", async () => {
  // Live 2026-11-22: nothing refreshed the sources from Nov 19 until a panel opened.
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, projectDirectory)
  let openRouterUp = true
  let openRouterCalls = 0
  const harness = await register(repository, {
    live: true,
    backgroundRefreshMs: 40,
    fetcher: async (input) => {
      if (!/openrouter\.ai\/api\/v1\/models/.test(String(input)))
        return new Response("n/a", { status: 404 })
      openRouterCalls += 1
      if (!openRouterUp) return new Response("down", { status: 503 })
      return Response.json({
        data: [
          {
            id: "openai/price-test",
            name: "Price test",
            pricing: { prompt: "0.000002", completion: "0.000008" },
          },
        ],
      })
    },
  })
  repository.close()
  const rows = () => {
    const db = new Database(path, { readonly: true })
    try {
      const exists = db
        .query("SELECT 1 FROM sqlite_master WHERE name='model_evidence_refreshes'")
        .get()
      if (!exists) return {} as Record<string, never>
      return Object.fromEntries(
        db
          .query<
            {
              source: string
              state: string
              latest_retrieved_at: string | null
              error_code: string | null
              http_status: number | null
            },
            []
          >(
            "SELECT source,state,latest_retrieved_at,error_code,http_status FROM model_evidence_refreshes",
          )
          .all()
          .map((row) => [row.source, row]),
      )
    } finally {
      db.close()
    }
  }
  const until = async (done: () => boolean) => {
    for (let waited = 0; waited < 200 && !done(); waited++) await Bun.sleep(25)
    expect(done()).toBe(true)
  }
  try {
    // No RPC call: the timer fetches what is due.
    await until(() => rows()["openrouter-models"]?.state === "succeeded")
    expect(rows()["openrouter-models"]!.latest_retrieved_at).not.toBeNull()
    expect(openRouterCalls).toBe(1)
    // Within the hourly price rule the next checks fetch nothing.
    await Bun.sleep(200)
    expect(openRouterCalls).toBe(1)
    // A forced refresh against a source that is down records its error code and HTTP status.
    openRouterUp = false
    harness.setActor({ id: "ses-native", projectID, agent: "architect", time: {} })
    await Effect.runPromise(
      harness.methods().refreshSources({ sessionID: "ses-native", force: true }),
    )
    expect(rows()["openrouter-models"]).toMatchObject({
      state: "failed",
      error_code: "server-error",
      http_status: 503,
    })
    // The native catalog, a source that answered, still refreshed.
    expect(rows()["native-catalog"]!.state).toBe("succeeded")
  } finally {
    await harness.close()
    rmSync(root, { recursive: true, force: true })
  }
})
