import { routedModels } from "./catalog-inputs.ts"
import { registerDecisionViewOpener } from "./decision-view-registry.ts"
import { DecisionViewRequestSchema } from "./decision-view-build.ts"
import { timedRpc } from "../diagnostics/stall-probe.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Integration } from "@opencode/schema/integration"
import { Session } from "@opencode/schema/session"
import { ArchivedSessionError } from "../session-archived.ts"
import { Effect } from "effect"
import { TaskRepository } from "../storage.ts"
import {
  ModelConfigureRPCInputSchema,
  ModelPriceSourceConfigureRPCInputSchema,
  ModelPriceSourceSettingsRPCInputSchema,
  ModelMappingWriteOutputSchema,
  ModelSourceRefreshRPCInputSchema,
  ModelSettingsOutputSchema,
  Models,
} from "./contract.ts"
import { ModelEvidenceOutputSchema } from "./source-schema.ts"
import { readAgentRoutes, readHostAgentFacts } from "./agent-routes.ts"
import { writeHostAgentFacts } from "./assignment-view.ts"
import { LAZERS_AGENTS, isAgentSubject } from "./agent-ids.ts"
import { ModelEvidenceRefresher, createRefreshGate } from "./source-refresh.ts"

/** A background refresh gives up after this long. */
const BACKGROUND_REFRESH_TIMEOUT_MS = 120_000
/**
 * How often the background check runs. It fetches only what `dueSources` says is due, so most
 * checks read two small status rows and fetch nothing; a quarter of the hourly price rule keeps
 * prices at most 75 minutes old.
 */
export const REFRESH_CHECK_MS = 15 * 60_000

/**
 * One timer per database and project in this process, however many locations register; it runs
 * the newest live registration's check, so a reloaded location's closure is never called.
 */
const refreshTimersKey = Symbol.for("lazers.models.refreshTimers.v1")
type RefreshTimer = { ticks: (() => void)[]; timer: ReturnType<typeof setInterval> }
const refreshTimers = () =>
  ((globalThis as Record<symbol, unknown>)[refreshTimersKey] ??= new Map()) as Map<
    string,
    RefreshTimer
  >
function claimRefreshTimer(path: string, projectDirectory: string, tick: () => void, ms: number) {
  const key = `${path}\u0000${projectDirectory}`
  let entry = refreshTimers().get(key)
  if (!entry) {
    const created: RefreshTimer = {
      ticks: [],
      timer: setInterval(() => created.ticks.at(-1)?.(), ms),
    }
    created.timer.unref?.()
    refreshTimers().set(key, created)
    // The first check runs soon after start, not a whole interval later.
    setTimeout(() => created.ticks.at(-1)?.(), Math.min(ms, 30_000)).unref?.()
    entry = created
  }
  entry.ticks.push(tick)
  const held = entry
  return () => {
    const at = held.ticks.indexOf(tick)
    if (at < 0) return
    held.ticks.splice(at, 1)
    if (held.ticks.length) return
    clearInterval(held.timer)
    if (refreshTimers().get(key) === held) refreshTimers().delete(key)
  }
}
import type { ModelEvidenceFetcher } from "./source-refresh.ts"
import { createTaskValuationReader, currentPriceIndexFreshness } from "./task-valuation.ts"
import type { TaskValuationIndexReader, TaskValuationProvider } from "./task-valuation.ts"
import { acquireDecisionWorker } from "./decision-worker-registry.ts"
import { nativeCatalogAccess, priceIndexFromSources } from "./price-state.ts"
import type { PriceInputs } from "./price-state.ts"
import {
  MODELS_DECISION_CONTRACT_VERSION,
  ModelDecisionReadInputSchema,
} from "./decision-contract.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"
import { ModelSettingsService } from "./service.ts"
import {
  ModelPriceSourceSettingsSchema,
  ModelPriceSourceSettingsStore,
  ModelPriceSourceWriteOutputSchema,
} from "./price-source-settings.ts"
import { startModelPriceSourcePolicyProjection } from "./price-source-projection.ts"
import { createManagedUsagePriceProvider } from "./managed-usage-valuation.ts"
import type { ManagedUsageIndexReader } from "./managed-usage-valuation.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"

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

/**
 * The Models actions that only read. An archived session of this project reads as a live one
 * (`src/session-archived.ts`); writes (`lz-configure-models`) and a forced refresh from an
 * archived session are refused with the plain reason.
 */
const READ_ACTIONS: ReadonlySet<string> = new Set([
  "lz-read-model-decision",
  "lz-read-model-comparison",
  "lz-get-model-settings",
])

/**
 * The caller's session: it exists, belongs to this project and has an agent. A change from an
 * archived session is refused with the plain reason (`ArchivedSessionError`).
 */
async function eligibleSession(
  ctx: ModelsContext,
  sessionID: string,
  projectID: string,
  signal: AbortSignal,
  reading: boolean,
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
    !session.agent
  )
    throw new Error("Models scope is unavailable")
  if (!reading && session.time.archived !== undefined) throw new ArchivedSessionError()
  return { session, agent: session.agent }
}

export async function authorizeModels(
  ctx: ModelsContext,
  sessionID: string,
  projectID: string,
  action: string,
  resources: string[],
  signal: AbortSignal,
  options: { reading?: boolean } = {},
) {
  const reading = options.reading ?? READ_ACTIONS.has(action)
  const readEligibleSession = () => eligibleSession(ctx, sessionID, projectID, signal, reading)

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

export async function configuredAccess(
  ctx: ModelsContext,
  source: ModelPriceSource,
  signal: AbortSignal,
) {
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

export function createPriceSourceSettingsStore(ctx: ModelsContext, projectDirectory: string) {
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

/**
 * Read-only Models-owned task valuation provider using the same configured cached price path.
 *
 * Test oracle: the service values task effort with `storedPriceProvider` (`trajectory/
 * effort-compute.ts`), which mirrors this off the main thread; the cost-basis contract test
 * (`server.test.ts`) reads this one. Nothing in the service calls it.
 */
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
  options: {
    prewarmDecision?: boolean
    /** Check the price sources' staleness rule on a timer (the service; tests pass a period). */
    backgroundRefreshMs?: number
  } = {},
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
  /**
   * Fetch the sources past their staleness rule (`dueSources`: prices hourly, model info weekly,
   * a failed source again after 5 minutes), once at a time. Unforced, it starts the fetch and
   * returns; forced (the header button), it waits for it. A failed fetch records its error code
   * on the source's refresh row, which the panel shows.
   */
  const refreshDue = async (force: boolean) => {
    if (force) await refreshGate.wait()
    if (refreshGate.busy) return
    const plan = await withEvidenceStoreAsync(async (store) =>
      new ModelEvidenceRefresher(ctx, store, fetcher).due(force),
    )
    if (plan.size === 0) return
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

  /**
   * What the host resolves for each agent, stored for the assignments stream. One read at a time;
   * a request during a read runs once more after it, so the last open sees the last state.
   */
  let hostRead: Promise<void> | undefined
  let hostAgain = false
  const refreshHostAgents = (): Promise<void> => {
    if (hostRead) {
      hostAgain = true
      return hostRead
    }
    hostRead = (async () => {
      try {
        do {
          hostAgain = false
          const facts = await readHostAgentFacts(ctx)
          withService((service) => writeHostAgentFacts(service.repository, facts))
        } while (hostAgain)
      } catch {
        // The next open reads again; the stored rows stay as they were.
      } finally {
        hostRead = undefined
      }
    })()
    return hostRead
  }

  return Effect.gen(function* () {
    const pricePolicyProjection = startModelPriceSourcePolicyProjection({
      repository,
      projectDirectory,
      read: () => priceSourceSettings.read(),
      refreshMs: options.backgroundRefreshMs ?? REFRESH_CHECK_MS,
      onError: (error) =>
        void Effect.runPromise(
          Effect.logWarning("LAZERS model price-source policy projection failed", {
            error: String(error),
          }),
        ),
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => pricePolicyProjection.stop()))
    // One decision worker per database per process, shared by every location's registration.
    const lease = acquireDecisionWorker({ path, readPriceInputs })
    yield* Effect.addFinalizer(() => Effect.sync(() => lease.release()))
    // The comparison candidates (schema installed by the project core): built in the decision
    // worker, written here a page at a time.
    lease.ensureCandidates(projectDirectory)
    // Stored decision views: the routes the panel counts as routed come from this location's
    // settings read, and a Models stream opens a view through the registered opener.
    lease.provideRouted(projectDirectory, async (taskID, signal) =>
      routedModels(await readSettings(taskID ?? undefined, signal ?? new AbortController().signal)),
    )
    const releaseOpener = registerDecisionViewOpener(projectDirectory, {
      open: (request) => lease.openView(projectDirectory, DecisionViewRequestSchema.parse(request)),
      release: (viewID) => lease.releaseView(viewID),
      refreshHostAgents: () => void refreshHostAgents(),
    })
    yield* Effect.addFinalizer(() => Effect.sync(releaseOpener))
    const decisionReader = lease.reader(projectDirectory)
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
    // Prices stay current with no panel open: one location per project and process checks the
    // staleness rule on a timer (2026-11-22 live: nothing refreshed from Nov 19 until a panel
    // was opened on a live session).
    if (options.backgroundRefreshMs !== undefined) {
      const releaseRefreshTimer = claimRefreshTimer(
        path,
        projectDirectory,
        () => void refreshDue(false).catch(() => undefined),
        options.backgroundRefreshMs,
      )
      yield* Effect.addFinalizer(() => Effect.sync(releaseRefreshTimer))
    }
    yield* timedRpc(ctx.rpc).register(Models, {
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
            if (written.status === "updated" && isAgentSubject(update.persona)) {
              await Effect.runPromise(ctx.agent.reload(), { signal })
              await refreshHostAgents()
            }
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
              // The native snapshot's stamp decides access; its records are never read here.
              const sources = store.readComparisonSources(undefined, {
                stampOnly: true,
                sources: ["native-catalog"],
              })
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
            await pricePolicyProjection.refresh()
            return ModelPriceSourceWriteOutputSchema.parse(result)
          },
          catch: failure,
        }).pipe(Effect.orDie),
      refreshSources: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelSourceRefreshRPCInputSchema.parse(input)
            // The stored snapshots are served at once. Only sources past their TTL are fetched,
            // in the background and once at a time; a forced refresh (the header button) waits.
            // The panel's open (not forced) reads, so an archived session may send it.
            const force = request.force === true
            await authorizeModels(
              ctx,
              request.sessionID,
              projectID,
              "lz-refresh-model-evidence",
              [projectDirectory],
              signal,
              { reading: !force },
            )
            signal.throwIfAborted()
            await refreshDue(force)
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
  })
}
