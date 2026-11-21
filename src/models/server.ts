import { routedModels } from "./catalog-inputs.ts"
import { registerDecisionViewOpener } from "./decision-view-registry.ts"
import { DecisionViewRequestSchema } from "./decision-view.ts"
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
import { LAZERS_AGENTS, isAgentSubject } from "./agent-ids.ts"
import { ModelEvidenceRefresher, createRefreshGate } from "./source-refresh.ts"

/** A background refresh gives up after this long. */
const BACKGROUND_REFRESH_TIMEOUT_MS = 120_000
import type { ModelEvidenceFetcher } from "./source-refresh.ts"
import { readModelComparison } from "./comparison-read.ts"
import { readModelConfigurations, readModelGroups } from "./model-group-read.ts"
import { buildCurrentPriceIndex } from "./current-price-index.ts"
import type { CurrentPriceApplicability } from "./current-price-index.ts"
import { createTaskValuationReader, currentPriceIndexFreshness } from "./task-valuation.ts"
import type { TaskValuationIndexReader, TaskValuationProvider } from "./task-valuation.ts"
import { acquireDecisionWorker } from "./decision-worker-registry.ts"
import { nativeCatalogAccess, priceIndexFromSources } from "./price-state.ts"
import type { PriceInputs } from "./price-state.ts"
import {
  MODELS_DECISION_CONTRACT_VERSION,
  ModelDecisionReadInputSchema,
  ModelsDecision,
  ModelDecisionConfigurationsOutputSchema,
  ModelDecisionConfigurationsRPCInputSchema,
  ModelDecisionInspectOutputSchema,
  ModelDecisionInspectRPCInputSchema,
  ModelDecisionOverviewAllOutputSchema,
  ModelDecisionOverviewAllRPCInputSchema,
  ModelDecisionOverviewOutputSchema,
  ModelDecisionOverviewRPCInputSchema,
  ModelDecisionRowsAllOutputSchema,
  ModelDecisionRowsAllRPCInputSchema,
  ModelDecisionRowsOutputSchema,
  ModelDecisionRowsRPCInputSchema,
} from "./decision-contract.ts"
import { loadedProjectDirectories } from "../core/registry.ts"
import { canonicalPath, pickUnit, projectUnits, unitToken } from "../projects/scope.ts"
import type { ProjectUnit } from "../projects/scope.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import { readEndpointPricingEvidence } from "./market-range-evidence.ts"
import { ModelSettingsService } from "./service.ts"
import {
  ModelPriceSourceSettingsSchema,
  ModelPriceSourceSettingsStore,
  ModelPriceSourceWriteOutputSchema,
} from "./price-source-settings.ts"
import { createManagedUsagePriceProvider } from "./managed-usage-valuation.ts"
import type { ManagedUsageIndexReader } from "./managed-usage-valuation.ts"
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

/** The caller's session: it exists, is not archived, belongs to this project and has an agent. */
async function eligibleSession(
  ctx: ModelsContext,
  sessionID: string,
  projectID: string,
  signal: AbortSignal,
) {
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

export async function authorizeModels(
  ctx: ModelsContext,
  sessionID: string,
  projectID: string,
  action: string,
  resources: string[],
  signal: AbortSignal,
) {
  const readEligibleSession = () => eligibleSession(ctx, sessionID, projectID, signal)

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

function createModelsPriceIndexReader(
  ctx: ModelsContext,
  repository: TaskRepository,
  evidenceReadStoreFactory: EvidenceReadStoreFactory,
): TaskValuationIndexReader {
  const priceSourceSettings = createPriceSourceSettingsStore(ctx, repository.projectDirectory)
  return async (routes, signal) => {
    signal.throwIfAborted()
    const [policy, openrouter] = await Promise.all([
      priceSourceSettings.read(signal),
      configuredAccess(ctx, "openrouter", signal),
    ])
    signal.throwIfAborted()
    const store = evidenceReadStoreFactory(repository.path, repository.projectDirectory)
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
  }
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
  await authorizeModels(
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
  return createTaskValuationReader(
    createModelsPriceIndexReader(ctx, repository, evidenceReadStoreFactory),
  )
}

/** Managed generations use the same configured, cached source path as Models without refreshing it. */
export function createModelsManagedUsagePriceProvider(
  ctx: ModelsContext,
  repository: TaskRepository,
  evidenceReadStoreFactory: EvidenceReadStoreFactory = (databasePath, directory) =>
    new ModelEvidenceReadStore(databasePath, directory),
) {
  const readIndex = createModelsPriceIndexReader(ctx, repository, evidenceReadStoreFactory)
  const managedReadIndex: ManagedUsageIndexReader = async (routes, signal) => {
    const { index, freshness, settings } = await readIndex(routes, signal)
    return { index, freshness, settings }
  }
  return createManagedUsagePriceProvider(managedReadIndex)
}

/** How long after registration the default decision snapshot is built in the background. */
const DECISION_PREWARM_DELAY_MS = 5_000

/** Desktop RPC and Code Mode tools share the same project-scoped SQLite mappings. */
export function registerModelsServer(
  ctx: ModelsContext,
  repository: TaskRepository,
  fetcher?: ModelEvidenceFetcher,
  evidenceReadStoreFactory: EvidenceReadStoreFactory = (databasePath, directory) =>
    new ModelEvidenceReadStore(databasePath, directory),
  options: { prewarmDecision?: boolean; loaded?: () => Iterable<string> } = {},
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

  /**
   * Price sources are global, so every project's decision read prices with whichever location
   * answers. Only the OpenCode-owned inputs are read here; the decision worker reads all
   * evidence from SQLite itself, so no catalog or snapshot body is rebuilt or cloned per request.
   */
  const readPriceInputs = async (signal?: AbortSignal): Promise<PriceInputs> => {
    signal?.throwIfAborted()
    const [policy, openrouter] = await Promise.all([
      priceSourceSettings.read(signal),
      configuredAccess(ctx, "openrouter", signal ?? new AbortController().signal),
    ])
    signal?.throwIfAborted()
    return { policy, openrouter }
  }

  /** The saved model settings of the project (or one task), with the agents' host routes. */
  const readSettings = async (taskID: string | undefined, signal: AbortSignal) => {
    const output = withService((service) => service.settings({ taskID }))
    // The agents' LAZERS routes: the effective model is read back from the host (after the
    // transform applied it), and the source word says whose route it is.
    const set = new Map(
      withService((service) =>
        LAZERS_AGENTS.map((agent) => agent.agentID).flatMap((id) => {
          const route = service.mappings.agentRoute(id)
          return route ? [[id, route] as const] : []
        }),
      ),
    )
    const agents = await readAgentRoutes(ctx, signal, (id: string) => set.get(id as never) ?? null)
    return ModelSettingsOutputSchema.parse({ ...output, agents })
  }

  return Effect.gen(function* () {
    // One decision worker per database per process, shared by every location's registration.
    const lease = acquireDecisionWorker({ path, readPriceInputs })
    yield* Effect.addFinalizer(() => Effect.sync(() => lease.release()))
    // Stored decision views: the routes the panel counts as routed come from this location's
    // settings read, and a Models stream opens a view through the registered opener.
    lease.provideRouted(projectDirectory, async (taskID, signal) =>
      routedModels(await readSettings(taskID ?? undefined, signal ?? new AbortController().signal)),
    )
    const releaseOpener = registerDecisionViewOpener(projectDirectory, {
      open: (request) => lease.openView(projectDirectory, DecisionViewRequestSchema.parse(request)),
      release: (viewID) => lease.releaseView(viewID),
    })
    yield* Effect.addFinalizer(() => Effect.sync(releaseOpener))
    const decisionReader = lease.reader(projectDirectory)
    const readerFor = (unit: ProjectUnit) => {
      if (canonicalPath(unit.directory) === canonicalPath(projectDirectory))
        return { reader: decisionReader, directory: projectDirectory }
      return { reader: lease.reader(unit.directory), directory: unit.directory }
    }
    /**
     * The all-projects Models reads: the caller's session is checked, and no permission is
     * asserted, so the owner is never prompted for looking at their own projects in a panel.
     */
    const decisionAccess = async (sessionID: string, signal: AbortSignal) => {
      await eligibleSession(ctx, sessionID, projectID, signal)
      const registry = new TaskRepository(path, projectDirectory)
      try {
        return { units: projectUnits(registry, options.loaded ?? loadedProjectDirectories) }
      } finally {
        registry.close()
      }
    }
    if (options.prewarmDecision && lease.claimPrewarm(projectDirectory)) {
      // Build the default snapshot once the service has settled, so the first open after a
      // start or reload reads a cached one. The worker keeps it current from then on.
      const prewarm = setTimeout(() => {
        void decisionReader
          .overview(
            ModelDecisionReadInputSchema.parse({
              schemaVersion: MODELS_DECISION_CONTRACT_VERSION,
              scope: { projectDirectory },
              filters: { persona: null, taskKind: null, period: { from: null, to: null } },
            }),
          )
          .catch(() => undefined)
      }, DECISION_PREWARM_DELAY_MS)
      prewarm.unref()
    }
    yield* timedRpc(ctx.rpc).register(Models, {
      settings: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelSettingsRPCInputSchema.parse(input)
            await authorizeModels(
              ctx,
              request.sessionID,
              projectID,
              "lz-get-model-settings",
              [request.taskID ?? projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            return await readSettings(request.taskID, signal)
          },
          catch: failure,
        }).pipe(Effect.orDie),
      configure: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelConfigureRPCInputSchema.parse(input)
            const resource =
              request.target.scope === "task" ? request.target.taskID : projectDirectory
            await authorizeModels(
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
            const written = ModelMappingWriteOutputSchema.parse(
              withService((service) => service.configure(update)),
            )
            // An agent's route is applied by its transform: run the transforms again so OpenCode
            // starts the next session of that agent on the new model, without a restart.
            if (written.status === "updated" && isAgentSubject(update.persona))
              await Effect.runPromise(ctx.agent.reload(), { signal })
            return written
          },
          catch: failure,
        }).pipe(Effect.orDie),
      priceSources: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelPriceSourceSettingsRPCInputSchema.parse(input)
            await authorizeModels(
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
              access: { openrouter, opencode, "models-dev": "configured" as const },
            })
          },
          catch: failure,
        }).pipe(Effect.orDie),
      configurePriceSources: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelPriceSourceConfigureRPCInputSchema.parse(input)
            await authorizeModels(
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
            await authorizeModels(
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
            await authorizeModels(
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
            await authorizeModels(
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
            await authorizeModels(
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
            await authorizeModels(
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
            await authorizeModels(
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
              // Statuses only: endpoint pricing bodies are returned when the evidence is requested.
              await withEvidenceStoreAsync(async (store) =>
                store.read({}, { endpointPricing: false }),
              ),
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
      overviewAll: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelDecisionOverviewAllRPCInputSchema.parse(input)
            const access = await decisionAccess(request.sessionID, signal)
            const picked = pickUnit(access.units, request.cursor)
            if (!picked) throw new Error("No project is readable in this scope")
            signal.throwIfAborted()
            const target = readerFor(picked.unit)
            const overview = await target.reader.overview(
              {
                schemaVersion: request.schemaVersion,
                scope: { projectDirectory: target.directory },
                filters: request.filters,
              },
              { signal },
            )
            signal.throwIfAborted()
            return ModelDecisionOverviewAllOutputSchema.parse({
              project: picked.unit.project,
              unit: unitToken(picked.unit.directory),
              nextCursor: picked.nextCursor,
              overview,
            })
          },
          catch: failure,
        }).pipe(Effect.orDie),
      rowsAll: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelDecisionRowsAllRPCInputSchema.parse(input)
            const access = await decisionAccess(request.sessionID, signal)
            const unit = access.units.find((item) => unitToken(item.directory) === request.unit)
            if (!unit) throw new Error("Models scope is unavailable")
            signal.throwIfAborted()
            const target = readerFor(unit)
            const rows = await target.reader.rows(
              {
                schemaVersion: request.schemaVersion,
                scope: { projectDirectory: target.directory },
                filters: request.filters,
                snapshotID: request.snapshotID,
                cursor: request.cursor,
                limit: request.limit,
              },
              { signal },
            )
            signal.throwIfAborted()
            return ModelDecisionRowsAllOutputSchema.parse({
              project: unit.project,
              unit: request.unit,
              rows,
            })
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
