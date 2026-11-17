import { realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { UsageCache } from "../budget/server.ts"
import { ProjectIndex } from "../context/index.ts"
import type { ContextHost } from "../context/index.ts"
import { nativeContextPermission } from "../context/tools.ts"
import { createModelsTaskValuationProvider } from "../models/server.ts"
import { AssociationTaskReads } from "../observability/task-reads.ts"
import { nativeRadarSessionHost } from "../observability/native.ts"
import { ObservationReads } from "../observability/read.ts"
import { registerProject } from "../project-key.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { nativeHost } from "../runner/native.ts"
import { TaskRuntime, architectIdleWindowMs } from "../runner/runtime.ts"
import {
  PROJECT_RECONCILIATION_INTERVAL_MS,
  schedulerProjectKey,
  sharedScheduler,
} from "../runner/scheduler-coordinator.ts"
import { RunnerStore } from "../runner/store.ts"
import { verificationTimeoutDefaults } from "../runner/verification-timeout.ts"
import { TaskRepository, taskDatabasePath } from "../storage.ts"
import { nativeTrajectoryHost } from "../trajectory/native.ts"
import { InferenceBroker } from "../webgpu/broker.ts"
import type { CapabilityHub } from "./capabilities.ts"
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
  readonly usageCache: UsageCache
  readonly inferenceBroker: InferenceBroker
  readonly verificationDefaults: ReturnType<typeof verificationTimeoutDefaults>
  /** Scheduler tick wake-up for this project (exactly one participant). */
  wake(): void
  /** Workspace index for one checkout; built lazily and shared by every location using it. */
  indexFor(directory: string): ProjectIndex
}

export type LazersCoreInfo = {
  dataDirectory?: string
  projectID: string
  projectDirectory: string
  directory: string
  options: Plugin.Context["options"]
}

function canonical(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Database realpath + canonical project root + OpenCode project id. */
export function coreKey(
  info: Pick<LazersCoreInfo, "dataDirectory" | "projectID" | "projectDirectory">,
) {
  return JSON.stringify([
    "core",
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
    create: (hub) => createLazersCore(hub, info),
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
  built("repository")
  const runnerStore = new RunnerStore(repository)
  built("runnerStore")
  // Non-blocking: aliases hydrate synchronously, git resolution runs in the background.
  void registerProject(repository, {
    directory: info.projectDirectory,
    opencodeProjectID: projectID,
  }).catch((error) =>
    Effect.runPromise(
      Effect.logWarning("LAZERS project key registration failed", { error: String(error) }),
    ),
  )
  const progress = new ProgressRecorder(runnerStore, projectID)
  built("progress")
  const nativeRunnerHost = nativeHost(host, repository)
  let scheduler: ReturnType<typeof sharedScheduler.register> | undefined
  const runtime: TaskRuntime = new TaskRuntime(runnerStore, nativeRunnerHost, projectID, progress, {
    architectIdleWindowMs: architectIdleWindowMs(info.options.architectIdleWindowMs),
    verificationTimeoutDefaults: verificationDefaults,
    architectPromptHook: true,
    requestTick: () => (scheduler ? scheduler.runNow() : runtime.tick()),
    wakeScheduler: () => scheduler?.request(),
  })
  built("runtime")
  // Lazy, offline-safe backfill of stable change identity; never blocks startup.
  void runtime.stampIdentity(true)
  const trajectoryHost = nativeTrajectoryHost(
    host,
    projectID,
    nativeRunnerHost.ownsCurrentWorkspace,
  )
  const radarSessionHost = nativeRadarSessionHost(host)
  const taskValuationProvider = createModelsTaskValuationProvider(host, repository)
  const reads = new ObservationReads(
    runnerStore,
    trajectoryHost,
    projectID,
    crypto.getRandomValues(new Uint8Array(32)),
    radarSessionHost,
    taskValuationProvider,
  )
  built("observationReads")
  const taskReads = new AssociationTaskReads(repository)
  const usageCache = new UsageCache()
  const inferenceBroker = new InferenceBroker()

  const indexes = new Map<string, ProjectIndex>()
  const contextHost: ContextHost = {
    projectID,
    session: async (id) => {
      try {
        const session = await Effect.runPromise(
          host.session.get({ sessionID: Session.ID.make(id) }),
        )
        return {
          id: session.id,
          ...(session.parentID ? { parentID: session.parentID } : {}),
          projectID: session.projectID,
          directory: session.location.directory,
          agent: session.agent,
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "SessionNotFoundError"
        )
          return null
        throw error
      }
    },
  }
  const indexFor = (directory: string) => {
    const root = canonical(directory)
    let index = indexes.get(root)
    if (!index) {
      index = new ProjectIndex(
        directory,
        join(dirname(repository.path), "context"),
        repository,
        nativeContextPermission(host),
        contextHost,
      )
      built("projectIndex")
      indexes.set(root, index)
    }
    return index
  }

  scheduler = sharedScheduler.register(
    schedulerProjectKey(repository.path, repository.projectDirectory, projectID),
    {
      intervalMs: PROJECT_RECONCILIATION_INTERVAL_MS,
      run: () => runtime.tick(),
      onError: (error) =>
        Effect.runPromise(
          Effect.logError("LAZERS scheduler reconciliation failed", { error: String(error) }),
        ),
    },
  )
  built("schedulerParticipant")
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
    usageCache,
    inferenceBroker,
    verificationDefaults,
    wake: () => scheduler?.request(),
    indexFor,
  }
  return {
    core,
    dispose: async () => {
      scheduler = undefined
      await registration.dispose()
      await runtime.stop()
      for (const index of indexes.values()) index.close()
      indexes.clear()
      inferenceBroker.close()
      repository.close()
    },
  }
}
