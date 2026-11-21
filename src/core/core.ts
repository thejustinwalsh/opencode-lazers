import { acquireScheduleOwner } from "../tasks/schedule/owner.ts"
import { taskEventsProjection } from "../events/task-events-refresh.ts"
import { startProjection } from "../projections/owner.ts"
import { nativeCallDisplayProjection } from "../progress/native-call-display.ts"
import { ensureModelCandidatesSchema } from "../models/candidate-store.ts"
import { mirrorSchedulerStatus } from "../runner/scheduler-status.ts"
import { startHostSessionFold } from "../host-sessions/fold.ts"
import { startTaskEffortFold } from "../trajectory/effort-store.ts"
import { startTranscriptMetaFold } from "../transcript-meta/fold.ts"
import { workerTaskEffort } from "../trajectory/effort-worker-client.ts"
import { bindHostRuntime } from "../streams/host-source.ts"
import type { TrajectoryHostRuntime } from "../streams/sources/trajectory-host.ts"
import { nativeHostSessionSource } from "../host-sessions/native.ts"
import {
  ensureProjectOverviewSchema,
  projectOverviewProjection,
  projectsDefaultsOf,
  setProjectOverviewDefaults,
} from "../projects/overview-store.ts"
import { acquirePresence } from "../projects/presence.ts"
import { realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { Effect } from "effect"
import { parseFallowThreads } from "../audit/fallow-threads.ts"
import { setFallowThreads } from "../audit/wasm-analyzer.ts"
import { section, sectionAsync } from "../diagnostics/stall-probe.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { UsageCache } from "../budget/server.ts"
import { ProjectIndex } from "../context/index.ts"
import { nativeContextPermission } from "../context/tools.ts"
import {
  configuredAccess,
  createModelsTaskValuationProvider,
  createPriceSourceSettingsStore,
} from "../models/server.ts"
import { AssociationTaskReads } from "../observability/task-reads.ts"
import { nativeRadarSessionHost } from "../observability/native.ts"
import { historyCacheBytes } from "../trajectory/history.ts"
import { trajectoryCachePair } from "../trajectory/cache-pair.ts"
import { ObservationReads } from "../observability/read.ts"
import { projectKeyFor, registerProject } from "../project-key.ts"
import { globalSettings, spendCeilingFor } from "../projects/settings.ts"
import { startProgressDisplayBackfill } from "../progress/display-backfill.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { nativeHost } from "../runner/native.ts"
import { TaskRuntime } from "../runner/runtime.ts"
import {
  PROJECT_RECONCILIATION_INTERVAL_MS,
  schedulerProjectKey,
  sharedScheduler,
} from "../runner/scheduler-coordinator.ts"
import { RunnerStore } from "../runner/store.ts"
import { RetentionService } from "../retention/service.ts"
import { verificationTimeoutDefaults } from "../runner/verification-timeout.ts"
import { TaskRepository, taskDatabasePath } from "../storage.ts"
import { ManagedUsageStore } from "../managed-usage/store.ts"
import { nativeTrajectoryHost } from "../trajectory/native.ts"
import { ownsRecordedWorkspace } from "../runner/workspace-location.ts"
import { InferenceBroker } from "../webgpu/broker.ts"
import type { CapabilityHub } from "./capabilities.ts"
import { moduleGeneration } from "./generation.ts"
import { LruMap, SESSION_MEMO_ENTRIES } from "./process-shared.ts"
import { acquireCore } from "./registry.ts"
import type { CoreHandle } from "./registry.ts"

/** Construction counters, process-wide. Tests compare adapters against core constructions. */
const countersKey = Symbol.for("lazers.core.counters.v1")
const counterHost = globalThis as typeof globalThis & {
  [countersKey]?: Record<string, number>
}
export const coreConstructions: Record<string, number> = (counterHost[countersKey] ??= {})
const built = (name: string) => {
  coreConstructions[name] = (coreConstructions[name] ?? 0) + 1
}

export type LazersCore = {
  readonly repository: TaskRepository
  readonly runnerStore: RunnerStore
  readonly progress: ProgressRecorder
  readonly runtime: TaskRuntime
  readonly host: ReturnType<typeof nativeHost>
  readonly reads: ObservationReads
  readonly taskReads: AssociationTaskReads
  readonly trajectoryHost: ReturnType<typeof nativeTrajectoryHost>
  readonly taskValuationProvider: ReturnType<typeof createModelsTaskValuationProvider>
  readonly managedUsageStore: ManagedUsageStore
  readonly usageCache: UsageCache
  readonly retention: RetentionService
  readonly inferenceBroker: InferenceBroker
  readonly verificationDefaults: ReturnType<typeof verificationTimeoutDefaults>
  /** Scheduler tick wake-up for this project (exactly one participant). */
  wake(): void
  /** Workspace index for one checkout; built lazily and shared by every location using it. */
  indexFor(directory: string): ProjectIndex
  /** The agent of each prompted session: one memo per project, shared by every plugin copy. */
  readonly sessionAgents: LruMap<string, string>
}

export type LazersCoreInfo = {
  dataDirectory?: string
  projectID: string
  projectDirectory: string
  directory: string
  options: Plugin.Context["options"]
  /** Loaded-code stamp; defaults to this module graph's generation. Tests inject one. */
  generation?: string
}

function canonical(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Code generation + database realpath + canonical project root + OpenCode project id. */
export function coreKey(
  info: Pick<LazersCoreInfo, "dataDirectory" | "projectID" | "projectDirectory" | "generation">,
) {
  return JSON.stringify([
    "core",
    info.generation ?? moduleGeneration(),
    canonical(taskDatabasePath(info.dataDirectory)),
    canonical(info.projectDirectory),
    info.projectID,
  ])
}

export type LazersCoreHandle = CoreHandle<LazersCore, Plugin.Context>

export function acquireLazersCore(ctx: Plugin.Context, info: LazersCoreInfo): LazersCoreHandle {
  return acquireCore<LazersCore, Plugin.Context>({
    key: coreKey(info),
    projectDirectory: info.projectDirectory,
    directory: info.directory,
    ctx,
    create: (hub) => section("core:create", () => createLazersCore(hub, info)),
  })
}

export function createLazersCore(hub: CapabilityHub<Plugin.Context>, info: LazersCoreInfo) {
  const host = hub.context
  const projectID = info.projectID
  const dataDirectory = info.dataDirectory
  const verificationDefaults = verificationTimeoutDefaults({
    inactivityTimeoutMs: info.options.verificationInactivityTimeoutMs,
    hardTimeoutMs: info.options.verificationHardTimeoutMs,
  })
  const repository = new TaskRepository(taskDatabasePath(dataDirectory), info.projectDirectory)
  const delegatedAgentProjectKey = projectKeyFor(info.projectDirectory).then(
    (identity) => identity.key,
  )
  built("repository")
  const indexes = new Map<string, ProjectIndex>()
  const indexFor = (directory: string) => {
    const root = canonical(directory)
    let index = indexes.get(root)
    if (!index) {
      const created = section(
        "ProjectIndex:construct",
        () =>
          new ProjectIndex(
            directory,
            join(dirname(repository.path), "context"),
            repository,
            nativeContextPermission(host),
          ),
      )
      index = created
      built("projectIndex")
      indexes.set(root, index)
    }
    return index
  }
  try {
    // The canonical project index fails setup early; worktree indexes are built lazily.
    indexFor(info.projectDirectory)
  } catch (error) {
    repository.close()
    throw error
  }
  const runnerStore = new RunnerStore(repository)
  built("runnerStore")
  // Backfills the Tasks projection of this project, then drains what stale copies queued and
  // retries parked refreshes; idle it holds a table subscription and no timer.
  // One owner per database per process serves every project core that loads it.
  const scheduleLease = acquireScheduleOwner(repository.path, info.projectDirectory)
  // Backfills `task_events` (database-wide, paced like the display backfill) and drains what other
  // connections queued; idle it holds a table subscription and no timer.
  const taskEventsLease = startProjection(
    repository.path,
    info.projectDirectory,
    taskEventsProjection,
    {
      onError: (error) =>
        void Effect.runPromise(
          Effect.logWarning("LAZERS task events projection failed", { error: String(error) }),
        ),
    },
  )
  // Display rows for tool calls recorded before their table; triggers keep new ones current.
  const nativeCallLease = startProjection(
    repository.path,
    info.projectDirectory,
    nativeCallDisplayProjection,
    {
      onError: (error) =>
        void Effect.runPromise(
          Effect.logWarning("LAZERS native call display backfill failed", {
            error: String(error),
          }),
        ),
    },
  )
  // The comparison candidates' tables and triggers; the Models server's decision worker builds them.
  ensureModelCandidatesSchema(repository)
  // The Projects section's rows: kept by triggers in each writer's transaction; this start
  // resolves settings with this service's plugin-option defaults and marks the project loaded.
  ensureProjectOverviewSchema(repository)
  const overviewLease = startProjection(
    repository.path,
    info.projectDirectory,
    projectOverviewProjection,
    {
      onError: (error) =>
        void Effect.runPromise(
          Effect.logWarning("LAZERS project overview failed", { error: String(error) }),
        ),
    },
  )
  setProjectOverviewDefaults(repository, projectsDefaultsOf(info.options))
  const presence = acquirePresence(repository, info.projectDirectory)
  const managedUsageStore = new ManagedUsageStore(repository)
  // Non-blocking: aliases hydrate synchronously, git resolution runs in the background.
  void sectionAsync("registerProject", () =>
    registerProject(repository, {
      directory: info.projectDirectory,
      opencodeProjectID: projectID,
    }),
  ).catch((error) =>
    Effect.runPromise(
      Effect.logWarning("LAZERS project key registration failed", { error: String(error) }),
    ),
  )
  const progress = new ProgressRecorder(runnerStore, projectID)
  built("progress")
  const nativeRunnerHost = nativeHost(host, repository)
  let scheduler: ReturnType<typeof sharedScheduler.register> | undefined
  setFallowThreads(parseFallowThreads(info.options.fallowThreads))
  const runtime: TaskRuntime = new TaskRuntime(runnerStore, nativeRunnerHost, projectID, progress, {
    delegatedAgentProjectKey,
    architectCacheWindowMs: info.options.architectCacheWindowMs as number | undefined,
    architectReuseMaxContextTokens: info.options.architectReuseMaxContextTokens as
      number | undefined,
    fallowReview: info.options.fallowReview === "off" ? "off" : "on",
    // Read per evaluation: a value set in Settings wins over the plugin option.
    workerSpendCeilingTokens: () =>
      spendCeilingFor(
        repository,
        repository.projectDirectory,
        info.options.workerSpendCeilingTokens,
      ),
    // Deprecated alias of architectCacheWindowMs.
    architectIdleWindowMs: info.options.architectIdleWindowMs as number | undefined,
    verificationTimeoutDefaults: verificationDefaults,
    architectPromptHook: true,
    requestTick: () => (scheduler ? scheduler.runNow() : runtime.tick()),
    wakeScheduler: (delayMs) => scheduler?.request(delayMs),
  })
  built("runtime")
  // Lazy, offline-safe backfill of stable change identity; never blocks startup.
  void runtime.stampIdentity(true)
  const trajectoryHost = nativeTrajectoryHost(
    host,
    projectID,
    (directory) => ownsRecordedWorkspace(directory, repository.projectDirectory),
    nativeRunnerHost.messages,
  )
  const radarSessionHost = nativeRadarSessionHost(host)
  // Live session facts for the Radar and task activity: a fold of host reads, hinted by native
  // events and resynced by cursor on every subscription attach; idle it holds no timer.
  const hostSessions = startHostSessionFold(
    repository.path,
    info.projectDirectory,
    projectID,
    nativeHostSessionSource(host, nativeRunnerHost),
    {
      events: host,
      location: info.directory,
      onError: (error) =>
        void Effect.runPromise(
          Effect.logWarning("LAZERS host session fold failed", { error: String(error) }),
        ),
    },
  )
  // Worker transcripts' metadata (routes, times, counts; never text), folded by host cursor.
  const transcriptMeta = startTranscriptMetaFold(
    repository.path,
    info.projectDirectory,
    nativeRunnerHost.messages,
    {
      events: host,
      location: info.directory,
      onError: (error) =>
        void Effect.runPromise(
          Effect.logWarning("LAZERS transcript metadata fold failed", { error: String(error) }),
        ),
    },
  )
  const taskValuationProvider = createModelsTaskValuationProvider(host, repository)
  // Each task's effort and market valuation, recomputed off the main thread (the effort worker)
  // when its facts or the prices change; only the price-source settings are read here.
  const priceSourceSettings = createPriceSourceSettingsStore(host, repository.projectDirectory)
  const effortCompute = workerTaskEffort({
    path: repository.path,
    projectDirectory: info.projectDirectory,
    projectID,
    readPriceInputs: async (signal) => {
      const [policy, openrouter] = await Promise.all([
        priceSourceSettings.read(signal),
        configuredAccess(host, "openrouter", signal),
      ])
      return { policy, openrouter }
    },
  })
  const taskEffort = startTaskEffortFold(
    repository.path,
    info.projectDirectory,
    effortCompute.compute,
    {
      onError: (error) =>
        void Effect.runPromise(
          Effect.logWarning("LAZERS task effort fold failed", { error: String(error) }),
        ),
    },
  )
  // The host access the Trajectory host sources (`trajectory.transcript`, `trajectory.effort`) read.
  const unbindHostRuntime = bindHostRuntime(repository.projectDirectory, {
    messages: nativeRunnerHost.messages,
    events: host,
    databasePath: repository.path,
    read: (run) => repository.read(run),
    effortDetail: effortCompute.detail,
    touchEffort: (taskID) => taskEffort.fold.touch(taskID),
  } satisfies TrajectoryHostRuntime)
  // Sized once at load; a value set in Settings wins over the plugin option on the next load.
  const historyBytes = historyCacheBytes(
    globalSettings(repository, {
      ...(typeof info.options.historyCacheMB === "number"
        ? { historyCacheMB: info.options.historyCacheMB }
        : {}),
    }).historyCacheMB,
  )
  const observationSecret = crypto.getRandomValues(new Uint8Array(32))
  const reads = new ObservationReads(
    runnerStore,
    trajectoryHost,
    projectID,
    observationSecret,
    radarSessionHost,
    taskValuationProvider,
    undefined,
    // One cache pair under one budget, owned by this per-project core.
    trajectoryCachePair(observationSecret, historyBytes),
  )
  built("observationReads")
  const taskReads = new AssociationTaskReads(repository)
  const usageCache = new UsageCache()
  const inferenceBroker = new InferenceBroker()

  const retention = new RetentionService({ repository, host: nativeRunnerHost })
  built("retention")
  // Display rows for progress older than their table: small transactions, longer at a quiet point.
  const displayBackfill = startProgressDisplayBackfill(repository, {
    onError: (error) =>
      void Effect.runPromise(
        Effect.logWarning("LAZERS progress display backfill failed", { error: String(error) }),
      ),
  })
  scheduler = sharedScheduler.register(
    schedulerProjectKey(repository.path, repository.projectDirectory, projectID),
    {
      intervalMs: PROJECT_RECONCILIATION_INTERVAL_MS,
      run: async () => {
        await runtime.tick()
        // At a quiet point only; one bounded slice, never awaited by the tick.
        void retention
          .autoTick()
          .catch((error) =>
            Effect.runPromise(
              Effect.logWarning("LAZERS automatic retention failed", { error: String(error) }),
            ),
          )
      },
      onError: (error) =>
        Effect.runPromise(
          Effect.logError("LAZERS scheduler reconciliation failed", { error: String(error) }),
        ),
    },
  )
  built("schedulerParticipant")
  // The Radar reads the scheduler's status for this project from its row.
  const schedulerStatus = mirrorSchedulerStatus(
    sharedScheduler,
    schedulerProjectKey(repository.path, repository.projectDirectory, projectID),
    repository,
    {
      onError: (error) =>
        void Effect.runPromise(
          Effect.logWarning("LAZERS scheduler status write failed", { error: String(error) }),
        ),
    },
  )
  // Joining a live group must not wait an interval: the next drain turn picks up handoff work.
  scheduler.request()
  const registration = scheduler

  const core: LazersCore = {
    repository,
    runnerStore,
    progress,
    runtime,
    host: nativeRunnerHost,
    reads,
    taskReads,
    trajectoryHost,
    taskValuationProvider,
    managedUsageStore,
    usageCache,
    retention,
    inferenceBroker,
    verificationDefaults,
    wake: () => scheduler?.request(),
    indexFor,
    sessionAgents: new LruMap<string, string>(SESSION_MEMO_ENTRIES),
  }
  const disposeCore = async () => {
    scheduler = undefined
    unbindHostRuntime()
    displayBackfill.stop()
    taskEventsLease.release()
    nativeCallLease.release()
    hostSessions.release()
    transcriptMeta.release()
    taskEffort.release()
    effortCompute.release()
    overviewLease.release()
    presence.release()
    scheduleLease.release()
    await registration.dispose()
    await schedulerStatus.stop()
    await runtime.stop()
    // Hand the lease to a successor core immediately instead of letting the TTL lapse.
    try {
      runnerStore.releaseLease(runtime.owner)
    } catch {
      // The lease expires on its own TTL if the store is unavailable.
    }
    for (const index of indexes.values()) index.close()
    indexes.clear()
    inferenceBroker.close()
    repository.close()
  }
  return { core, dispose: () => sectionAsync("core:dispose", disposeCore) }
}
