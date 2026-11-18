import { timedRpc } from "../diagnostics/stall-probe.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Integration } from "@opencode/schema/integration"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { nativeWorkerOptions } from "../runner/catalog.ts"
import { TaskRepository } from "../storage.ts"
import {
  ModelCatalogOutputSchema,
  ModelComparisonRPCInputSchema,
  ModelConfigureRPCInputSchema,
  ModelEvidenceRPCInputSchema,
  ModelPriceSourceConfigureRPCInputSchema,
  ModelPriceSourceSettingsRPCInputSchema,
  ModelMappingWriteOutputSchema,
  ModelSourceRefreshRPCInputSchema,
  ModelSettingsOutputSchema,
  ModelSettingsRPCInputSchema,
  ModelCatalogRPCInputSchema,
  Models,
  ModelConfigurationsRPCInputSchema,
  ModelGroupsRPCInputSchema,
} from "./contract.ts"
import { ModelComparisonOutputSchema } from "./comparison-schema.ts"
import { ModelConfigurationsOutputSchema, ModelGroupsOutputSchema } from "./model-group-schema.ts"
import { ModelEvidenceOutputSchema } from "./source-schema.ts"
import { readAgentRoutes } from "./agent-routes.ts"
import { ModelEvidenceRefresher, createRefreshGate } from "./source-refresh.ts"

/** A background refresh gives up after this long. */
const BACKGROUND_REFRESH_TIMEOUT_MS = 120_000
import type { ModelEvidenceFetcher } from "./source-refresh.ts"
import { readModelComparison } from "./comparison-read.ts"
import { readModelConfigurations, readModelGroups } from "./model-group-read.ts"
import { buildCurrentPriceIndex } from "./current-price-index.ts"
import type { CurrentPriceApplicability } from "./current-price-index.ts"
import { createTaskValuationReader, currentPriceIndexFreshness } from "./task-valuation.ts"
import type { TaskValuationProvider } from "./task-valuation.ts"
import { createThreadedDecisionReader } from "./decision-worker-client.ts"
import {
  ModelsDecision,
  ModelDecisionConfigurationsOutputSchema,
  ModelDecisionConfigurationsRPCInputSchema,
  ModelDecisionInspectOutputSchema,
  ModelDecisionInspectRPCInputSchema,
  ModelDecisionOverviewOutputSchema,
  ModelDecisionOverviewRPCInputSchema,
  ModelDecisionRowsOutputSchema,
  ModelDecisionRowsRPCInputSchema,
} from "./decision-contract.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import { readEndpointPricingEvidence } from "./market-range-evidence.ts"
import { ModelSettingsService } from "./service.ts"
import {
  ModelPriceSourceSettingsSchema,
  ModelPriceSourceSettingsStore,
  ModelPriceSourceWriteOutputSchema,
} from "./price-source-settings.ts"
import type {
  ModelPriceSource,
  ModelPriceSourcePolicy,
  ModelPriceSourceSettings,
} from "./price-source-settings.ts"

type ModelsContext = Pick<
  Plugin.Context,
  "agent" | "integration" | "location" | "model" | "permission" | "rpc" | "session" | "storage"
>
type EvidenceReadStore = Pick<
  ModelEvidenceReadStore,
  "close" | "projectDirectory" | "readComparisonSources"
>
type EvidenceReadStoreFactory = (path: string, projectDirectory: string) => EvidenceReadStore

function isSessionNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "SessionNotFoundError"
  )
}

async function authorize(
  ctx: ModelsContext,
  sessionID: string,
  projectID: string,
  action: string,
  resources: string[],
  signal: AbortSignal,
) {
  const readEligibleSession = async () => {
    const session = await Effect.runPromise(
      ctx.session
        .get({ sessionID: Session.ID.make(sessionID) })
        .pipe(
          Effect.catch((error) =>
            isSessionNotFound(error) ? Effect.succeed(null) : Effect.fail(error),
          ),
        ),
      { signal },
    )
    if (
      !session ||
      String(session.id) !== sessionID ||
      session.projectID !== projectID ||
      session.time.archived !== undefined ||
      !session.agent
    )
      throw new Error("Models scope is unavailable")
    return { session, agent: session.agent }
  }

  const eligible = await readEligibleSession()

  const agent = Agent.ID.make(eligible.agent)
  await Effect.runPromise(
    ctx.permission.assert({
      sessionID: Session.ID.make(eligible.session.id),
      agent,
      action,
      resources,
    }),
    { signal },
  )
  signal.throwIfAborted()
  const currentSession = await readEligibleSession()
  if (currentSession.agent !== eligible.agent) throw new Error("Models scope is unavailable")
  return currentSession.session
}

async function configuredAccess(ctx: ModelsContext, source: ModelPriceSource, signal: AbortSignal) {
  try {
    const connection = await Effect.runPromise(
      ctx.integration.connection.active(Integration.ID.make(source)),
      { signal },
    )
    signal.throwIfAborted()
    if (!connection) return "not-configured" as const
    return connection.status?.status === "needs_auth"
      ? ("reauthentication-required" as const)
      : ("configured" as const)
  } catch {
    signal.throwIfAborted()
    return "unknown" as const
  }
}

/** OpenCode quotes use an authorized, recorded native catalog read, not its execution login. */
function nativeCatalogAccess(
  source: ModelEvidenceComparisonSourceRead | undefined,
): "configured" | "unknown" {
  const snapshot = source?.snapshot
  const refresh = source?.refresh
  if (
    source?.storage !== "ready" ||
    source.snapshotState !== "available" ||
    snapshot?.source !== "native-catalog" ||
    snapshot.records.length === 0 ||
    !refresh ||
    refresh.state === "never" ||
    refresh.generation === 0 ||
    refresh.latestSnapshotID !== snapshot.snapshotID ||
    refresh.latestRetrievedAt !== snapshot.retrievedAt ||
    refresh.latestRecordCount !== snapshot.records.length
  )
    return "unknown"

  const matchingOutcome =
    refresh.state === "succeeded"
      ? refresh.generation === snapshot.generation
      : refresh.generation > snapshot.generation
  return matchingOutcome ? "configured" : "unknown"
}

function createPriceSourceSettingsStore(ctx: ModelsContext, projectDirectory: string) {
  return new ModelPriceSourceSettingsStore(
    {
      get: (key, signal) =>
        Effect.runPromise(ctx.storage.get(key), signal ? { signal } : undefined),
      set: (key, value, signal) =>
        Effect.runPromise(ctx.storage.set(key, value), signal ? { signal } : undefined),
    },
    projectDirectory,
  )
}

function priceIndexFromSources(input: {
  sources: readonly ModelEvidenceComparisonSourceRead[]
  policy: ModelPriceSourcePolicy
  openrouter: ModelPriceSourceSettings["access"]["openrouter"]
  routes: readonly CurrentPriceApplicability[]
}) {
  const opencode = nativeCatalogAccess(
    input.sources.find((source) => source.source === "native-catalog"),
  )
  const settings = ModelPriceSourceSettingsSchema.parse({
    policy: input.policy,
    access: { openrouter: input.openrouter, opencode },
  })
  const index = buildCurrentPriceIndex({
    sourceStore: { readComparisonSources: () => [...input.sources] },
    priceSources: settings,
    observedRoutes: input.routes,
  })
  return { settings, opencode, index }
}

async function authorizeDecisionRead(
  ctx: ModelsContext,
  request: { scope: { projectDirectory: string }; sessionID: string },
  projectDirectory: string,
  projectID: string,
  signal: AbortSignal,
) {
  if (request.scope.projectDirectory !== projectDirectory)
    throw new Error("Models scope is unavailable")
  await authorize(
    ctx,
    request.sessionID,
    projectID,
    "lz-read-model-decision",
    [projectDirectory],
    signal,
  )
  signal.throwIfAborted()
}

/** Read-only Models-owned task valuation provider using the same configured cached price path. */
export function createModelsTaskValuationProvider(
  ctx: ModelsContext,
  repository: TaskRepository,
  evidenceReadStoreFactory: EvidenceReadStoreFactory = (databasePath, directory) =>
    new ModelEvidenceReadStore(databasePath, directory),
): TaskValuationProvider {
  const projectDirectory = repository.projectDirectory
  const priceSourceSettings = createPriceSourceSettingsStore(ctx, projectDirectory)
  const readPriceIndex = createTaskValuationReader(async (routes, signal) => {
    signal.throwIfAborted()
    const [policy, openrouter] = await Promise.all([
      priceSourceSettings.read(signal),
      configuredAccess(ctx, "openrouter", signal),
    ])
    signal.throwIfAborted()
    const store = evidenceReadStoreFactory(repository.path, projectDirectory)
    try {
      signal.throwIfAborted()
      const sources = store.readComparisonSources()
      signal.throwIfAborted()
      const { index, settings } = priceIndexFromSources({ sources, policy, openrouter, routes })
      return {
        index,
        freshness: currentPriceIndexFreshness(index, sources),
        settings,
        sources,
      }
    } finally {
      store.close()
    }
  })
  return readPriceIndex
}

/** Desktop RPC and Code Mode tools share the same project-scoped SQLite mappings. */
export function registerModelsServer(
  ctx: ModelsContext,
  repository: TaskRepository,
  fetcher?: ModelEvidenceFetcher,
  evidenceReadStoreFactory: EvidenceReadStoreFactory = (databasePath, directory) =>
    new ModelEvidenceReadStore(databasePath, directory),
) {
  const path = repository.path
  const projectDirectory = repository.projectDirectory
  const projectID = ctx.location.project.id
  const priceSourceSettings = createPriceSourceSettingsStore(ctx, projectDirectory)
  const withService = <T>(run: (service: ModelSettingsService) => T): T => {
    const connection = new TaskRepository(path, projectDirectory)
    try {
      return run(new ModelSettingsService(connection))
    } finally {
      connection.close()
    }
  }
  const withEvidenceStore = <T>(run: (store: ModelEvidenceStore) => T): T => {
    const store = new ModelEvidenceStore(path, projectDirectory)
    try {
      return run(store)
    } finally {
      store.close()
    }
  }
  /** The one source refresh in flight for this project; every panel and request shares it. */
  const refreshGate = createRefreshGate()
  const withEvidenceStoreAsync = async <T>(
    run: (store: ModelEvidenceStore) => Promise<T>,
  ): Promise<T> => {
    const store = new ModelEvidenceStore(path, projectDirectory)
    try {
      return await run(store)
    } finally {
      store.close()
    }
  }
  const withEvidenceReadStore = <T>(run: (store: EvidenceReadStore) => T): T => {
    const store = evidenceReadStoreFactory(path, projectDirectory)
    try {
      return run(store)
    } finally {
      store.close()
    }
  }
  const failure = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

  return Effect.gen(function* () {
    const decisionReader = createThreadedDecisionReader({
      path,
      projectDirectory,
      readPriceState: async (routes: readonly CurrentPriceApplicability[], signal) => {
        signal?.throwIfAborted()
        const [policy, openrouter] = await Promise.all([
          priceSourceSettings.read(signal),
          configuredAccess(ctx, "openrouter", signal ?? new AbortController().signal),
        ])
        signal?.throwIfAborted()
        const state = withEvidenceReadStore((store) => {
          const sources = store.readComparisonSources()
          const { settings, opencode, index } = priceIndexFromSources({
            sources,
            policy,
            openrouter,
            routes,
          })
          return {
            settings,
            opencode,
            index,
            sources,
            freshness: currentPriceIndexFreshness(index, sources),
          }
        })
        const endpointPricing = readEndpointPricingEvidence(path, projectDirectory, signal)
        signal?.throwIfAborted()
        return {
          settings: state.settings,
          index: state.index,
          endpointPricing,
          identityCatalogSource: state.sources.find(
            (source) => source.source === "openrouter-models",
          ),
          identityNativeSource: state.sources.find((source) => source.source === "native-catalog"),
          sources: state.sources,
          freshness: state.freshness,
          note: `Ordered source access: OpenRouter ${openrouter}; OpenCode ${state.opencode}. ${state.index.pins.length ? "Quotes are pinned to the selected cached whole-model sources." : "No applicable configured cached quote is available."}`,
        }
      },
    })
    yield* timedRpc(ctx.rpc).register(Models, {
      settings: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelSettingsRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-get-model-settings",
              [request.taskID ?? projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            const output = withService((service) => service.settings({ taskID: request.taskID }))
            const agents = await readAgentRoutes(ctx, signal)
            return ModelSettingsOutputSchema.parse({ ...output, agents })
          },
          catch: failure,
        }).pipe(Effect.orDie),
      configure: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelConfigureRPCInputSchema.parse(input)
            const resource =
              request.target.scope === "task" ? request.target.taskID : projectDirectory
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-configure-models",
              [resource],
              signal,
            )
            signal.throwIfAborted()
            const update = {
              target: request.target,
              persona: request.persona,
              expectedRevision: request.expectedRevision,
              route: request.route,
            }
            return ModelMappingWriteOutputSchema.parse(
              withService((service) => service.configure(update)),
            )
          },
          catch: failure,
        }).pipe(Effect.orDie),
      priceSources: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelPriceSourceSettingsRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-get-model-settings",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            const [policy, openrouter] = await Promise.all([
              priceSourceSettings.read(signal),
              configuredAccess(ctx, "openrouter", signal),
            ])
            signal.throwIfAborted()
            const opencode = withEvidenceReadStore((store) => {
              signal.throwIfAborted()
              const sources = store.readComparisonSources()
              signal.throwIfAborted()
              return nativeCatalogAccess(
                sources.find((source) => source.source === "native-catalog"),
              )
            })
            signal.throwIfAborted()
            return ModelPriceSourceSettingsSchema.parse({
              policy,
              access: { openrouter, opencode },
            })
          },
          catch: failure,
        }).pipe(Effect.orDie),
      configurePriceSources: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelPriceSourceConfigureRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-configure-models",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            const result = await priceSourceSettings.configure(
              { expectedRevision: request.expectedRevision, sources: request.sources },
              signal,
            )
            return ModelPriceSourceWriteOutputSchema.parse(result)
          },
          catch: failure,
        }).pipe(Effect.orDie),
      catalog: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelCatalogRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-models-catalog",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            return ModelCatalogOutputSchema.parse(await nativeWorkerOptions(ctx))
          },
          catch: failure,
        }).pipe(Effect.orDie),
      sourceEvidence: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelEvidenceRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-read-model-evidence",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            return ModelEvidenceOutputSchema.parse(
              withEvidenceStore((store) =>
                store.read({
                  snapshotID: request.snapshotID,
                  cursor: request.cursor,
                  limit: request.limit,
                }),
              ),
            )
          },
          catch: failure,
        }).pipe(Effect.orDie),
      comparison: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelComparisonRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-read-model-comparison",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            const result = withEvidenceReadStore((store) =>
              readModelComparison(store, {
                cursor: request.cursor,
                filters: request.filters,
                limit: request.limit,
              }),
            )
            signal.throwIfAborted()
            const output = ModelComparisonOutputSchema.parse(result)
            signal.throwIfAborted()
            return output
          },
          catch: failure,
        }).pipe(Effect.orDie),
      modelGroups: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelGroupsRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-read-model-groups",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            const result = withEvidenceReadStore((store) =>
              readModelGroups(store, {
                cursor: request.cursor,
                filters: request.filters,
                limit: request.limit,
              }),
            )
            signal.throwIfAborted()
            const output = ModelGroupsOutputSchema.parse(result)
            signal.throwIfAborted()
            return output
          },
          catch: failure,
        }).pipe(Effect.orDie),
      modelConfigurations: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelConfigurationsRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-read-model-configurations",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            const result = withEvidenceReadStore((store) =>
              readModelConfigurations(store, {
                groupID: request.groupID,
                context: request.context,
                cursor: request.cursor,
                filters: request.filters,
                limit: request.limit,
              }),
            )
            signal.throwIfAborted()
            const output = ModelConfigurationsOutputSchema.parse(result)
            signal.throwIfAborted()
            return output
          },
          catch: failure,
        }).pipe(Effect.orDie),
      refreshSources: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelSourceRefreshRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-refresh-model-evidence",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            // The stored snapshots are served at once. Only sources past their TTL are fetched,
            // in the background and once at a time; a forced refresh (the header button) waits.
            const force = request.force === true
            if (force) await refreshGate.wait()
            if (!refreshGate.busy) {
              const plan = await withEvidenceStoreAsync(async (store) =>
                new ModelEvidenceRefresher(ctx, store, fetcher).due(force),
              )
              if (plan.size > 0) {
                const run = refreshGate.start(() =>
                  withEvidenceStoreAsync((store) =>
                    new ModelEvidenceRefresher(ctx, store, fetcher).refresh(
                      AbortSignal.timeout(BACKGROUND_REFRESH_TIMEOUT_MS),
                      plan,
                    ),
                  ),
                )
                if (force) await run
              }
            }
            return ModelEvidenceOutputSchema.parse(
              await withEvidenceStoreAsync(async (store) => store.read()),
            )
          },
          catch: failure,
        }).pipe(Effect.orDie),
    })

    yield* timedRpc(ctx.rpc).register(ModelsDecision, {
      overview: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelDecisionOverviewRPCInputSchema.parse(input)
            await authorizeDecisionRead(ctx, request, projectDirectory, projectID, signal)
            const output = await decisionReader.overview(
              {
                schemaVersion: request.schemaVersion,
                scope: request.scope,
                filters: request.filters,
              },
              { signal },
            )
            signal.throwIfAborted()
            return ModelDecisionOverviewOutputSchema.parse(output)
          },
          catch: failure,
        }).pipe(Effect.orDie),
      rows: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelDecisionRowsRPCInputSchema.parse(input)
            await authorizeDecisionRead(ctx, request, projectDirectory, projectID, signal)
            const output = await decisionReader.rows(
              {
                schemaVersion: request.schemaVersion,
                scope: request.scope,
                filters: request.filters,
                snapshotID: request.snapshotID,
                cursor: request.cursor,
                limit: request.limit,
              },
              { signal },
            )
            signal.throwIfAborted()
            return ModelDecisionRowsOutputSchema.parse(output)
          },
          catch: failure,
        }).pipe(Effect.orDie),
      configurations: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelDecisionConfigurationsRPCInputSchema.parse(input)
            await authorizeDecisionRead(ctx, request, projectDirectory, projectID, signal)
            const output = await decisionReader.configurations(
              {
                schemaVersion: request.schemaVersion,
                scope: request.scope,
                filters: request.filters,
                snapshotID: request.snapshotID,
                cursor: request.cursor,
                limit: request.limit,
              },
              { signal },
            )
            signal.throwIfAborted()
            return ModelDecisionConfigurationsOutputSchema.parse(output)
          },
          catch: failure,
        }).pipe(Effect.orDie),
      inspect: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelDecisionInspectRPCInputSchema.parse(input)
            await authorizeDecisionRead(ctx, request, projectDirectory, projectID, signal)
            const output = await decisionReader.inspect(
              {
                schemaVersion: request.schemaVersion,
                scope: request.scope,
                filters: request.filters,
                snapshotID: request.snapshotID,
                configurationID: request.configurationID,
                selectedTaskID: request.selectedTaskID,
                contributorCursor: request.contributorCursor,
                contributorLimit: request.contributorLimit,
              },
              { signal },
            )
            signal.throwIfAborted()
            return ModelDecisionInspectOutputSchema.parse(output)
          },
          catch: failure,
        }).pipe(Effect.orDie),
    })
  })
}
