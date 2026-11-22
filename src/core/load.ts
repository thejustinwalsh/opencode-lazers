import { dirname, join } from "node:path"
import { RepositorySnapshotStore } from "../context/repository-snapshots.ts"
import { ManagedUsageStore } from "../managed-usage/store.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { RetentionService } from "../retention/service.ts"
import { TaskRuntime } from "../runner/runtime.ts"
import type { RunnerHost } from "../runner/host.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository, taskDatabasePath, waitForWriteLock } from "../storage.ts"
import { acquireLazersCore } from "./core.ts"
import type { LazersCoreHandle, LazersCoreInfo } from "./core.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { taskEventsProjection } from "../events/task-events-refresh.ts"
import { nativeCallDisplayProjection } from "../progress/native-call-display.ts"
import { ensureModelCandidatesSchema } from "../models/candidate-store.ts"
import { ensureModelAssignmentViewSchema } from "../models/assignment-view.ts"
import {
  ensureProjectOverviewSchema,
  projectOverviewProjection,
  projectsDefaultsOf,
  setProjectOverviewDefaults,
} from "../projects/overview-store.ts"
import { acquirePresence } from "../projects/presence.ts"
import { ensureProjectionStateSchema, openProjectionState } from "../projections/lifecycle.ts"
import type { ProjectionSpec } from "../projections/owner.ts"
import { hostSessionSeedProjection } from "../host-sessions/state.ts"
import { transcriptMetaSeedProjection } from "../transcript-meta/schema.ts"
import { ensureTaskEffortSchema, taskEffortSeedProjection } from "../trajectory/effort-store.ts"

/** The database-wide projections the core starts; their state rows are opened here, under the wait. */
const LOAD_PROJECTIONS: readonly ProjectionSpec[] = [
  taskEventsProjection,
  nativeCallDisplayProjection,
  projectOverviewProjection,
]
/** The per-project seeds of the folds the core starts (host sessions, transcripts, effort). */
const LOAD_PROJECT_SEEDS: readonly ProjectionSpec[] = [
  hostSessionSeedProjection,
  transcriptMetaSeedProjection,
  taskEffortSeedProjection,
]

/**
 * Take the schema installs and upgrades that core construction would run, waiting for the write
 * lock. Another copy's index worker or another process can hold it for a second or more; the
 * synchronous construction only waits 250 ms per statement and a failure there would leave the
 * location without its RPCs. A failed attempt closes its own handle and leaves nothing behind.
 * The returned handle keeps the connection (and its install keys) alive: the caller closes it
 * once the core holds its own, so construction runs no write on a current database.
 */
export function prepareDatabase(
  info: Pick<LazersCoreInfo, "dataDirectory" | "projectDirectory" | "projectID" | "options">,
  options: { deadlineMs?: number } = {},
) {
  const path = taskDatabasePath(info.dataDirectory)
  return waitForWriteLock(() => {
    const repository = new TaskRepository(path, info.projectDirectory)
    try {
      const store = new RunnerStore(repository)
      const progress = new ProgressRecorder(store, info.projectID)
      // The runtime's constructor installs the schemas of the stores it owns; it needs no host to do so.
      const host = {} as RunnerHost
      void new TaskRuntime(store, host, info.projectID, progress)
      void new RetentionService({ repository, host })
      new ManagedUsageStore(repository)
      new HandoffStore(repository)
      new RepositorySnapshotStore(join(dirname(path), "context", "repositories"), repository)
      // The panel stores the core installs and the projections it starts.
      ensureModelCandidatesSchema(repository)
      ensureModelAssignmentViewSchema(repository)
      ensureProjectOverviewSchema(repository)
      // Host session state, transcript metadata and task effort, with their triggers.
      ensureTaskEffortSchema(repository)
      ensureProjectionStateSchema(repository)
      repository.atomic((db) => {
        for (const spec of LOAD_PROJECTIONS) openProjectionState(db, spec.name, spec.generation)
        for (const spec of LOAD_PROJECT_SEEDS)
          openProjectionState(db, spec.name, spec.generation, info.projectDirectory)
      })
      // Process-wide records the core would write: this service's settings defaults and the
      // project's presence. The core's own acquire then only counts a held presence.
      setProjectOverviewDefaults(repository, projectsDefaultsOf(info.options))
      const presence = acquirePresence(repository, info.projectDirectory)
      return {
        repository,
        close() {
          presence.release()
          repository.close()
        },
      }
    } catch (error) {
      repository.close()
      throw error
    }
  }, options)
}

/** `acquireLazersCore` after the database is prepared; a failure here registers nothing. */
export async function loadLazersCore(
  ctx: Plugin.Context,
  info: LazersCoreInfo,
  options: { deadlineMs?: number } = {},
): Promise<LazersCoreHandle> {
  const prepared = await prepareDatabase(info, options)
  try {
    return acquireLazersCore(ctx, info)
  } finally {
    prepared.close()
  }
}
