import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { registerArchitect } from "./architect.ts"
import { TaskRepository, taskDatabasePath } from "./storage.ts"
import { registerTaskTools } from "./tools.ts"
import { registerLocalInference } from "./webgpu/server.ts"
import { registerTaskReads } from "./tasks/rpc.ts"
import { RunnerStore } from "./runner/store.ts"
import { TaskRuntime, architectIdleWindowMs } from "./runner/runtime.ts"
import { schedulerProjectKey, sharedScheduler } from "./runner/scheduler-coordinator.ts"
import { nativeHost } from "./runner/native.ts"
import { registerRunnerTools } from "./runner/tools.ts"
import { registerWorker } from "./runner/roles.ts"
import { beginSourceGuard } from "./runner/source-quarantine.ts"
import { registerSourceFence } from "./runner/source-fence-rpc.ts"
import { ProjectIndex } from "./context/index.ts"
import type { ContextHost } from "./context/index.ts"
import { nativeContextPermission, registerContextTools } from "./context/tools.ts"
import { nativeTrajectoryHost } from "./trajectory/native.ts"
import { registerTrajectoryTools } from "./trajectory/tools.ts"
import { AssociationTaskReads } from "./observability/task-reads.ts"
import { ObservationReads } from "./observability/read.ts"
import { registerObservability } from "./observability/rpc.ts"
import { nativeRadarSessionHost } from "./observability/native.ts"
import { ProgressRecorder } from "./progress/recorder.ts"
import { registerProgress } from "./progress/native.ts"
import { registerNativeInteraction } from "./verification/opencode/native-interaction-server.ts"
import { Session } from "@opencode/schema/session"
import { join, dirname } from "node:path"
import { registerModelTools } from "./models/tools.ts"
import { registerModelsServer } from "./models/server.ts"

export default Plugin.define({
  id: "lazers",
  effect: (ctx) =>
    Effect.gen(function* () {
      const sourceGuard = yield* Effect.acquireRelease(
        Effect.sync(() =>
          beginSourceGuard({
            directory: ctx.location.directory,
            projectDirectory: ctx.location.project.canonical,
          }),
        ),
        (guard) => Effect.sync(() => guard.dispose()),
      )
      const dataDirectory = ctx.options.dataDirectory
      if (dataDirectory !== undefined && typeof dataDirectory !== "string") {
        return yield* Effect.die(new Error("LAZERS dataDirectory must be an absolute path string"))
      }
      const repository = yield* Effect.acquireRelease(
        Effect.sync(
          () => new TaskRepository(taskDatabasePath(dataDirectory), ctx.location.project.canonical),
        ),
        (repository) => Effect.sync(() => repository.close()),
      )
      const projectIndex = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const contextHost: ContextHost = {
            projectID: ctx.location.project.id,
            session: async (id) => {
              try {
                const session = await Effect.runPromise(
                  ctx.session.get({ sessionID: Session.ID.make(id) }),
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
          return new ProjectIndex(
            ctx.location.directory,
            join(dirname(repository.path), "context"),
            repository,
            nativeContextPermission(ctx),
            contextHost,
          )
        }),
        (index) => Effect.sync(() => index.close()),
      )
      yield* registerContextTools(ctx, projectIndex)
      yield* registerNativeInteraction(ctx).pipe(Effect.orDie)
      yield* registerTaskTools(ctx, repository)
      yield* registerModelTools(ctx, repository)
      yield* registerModelsServer(ctx, repository).pipe(Effect.orDie)
      yield* registerArchitect(ctx)
      const runnerStore = new RunnerStore(repository)
      const progress = new ProgressRecorder(runnerStore, ctx.location.project.id)
      const host = nativeHost(ctx, repository)
      let scheduler: ReturnType<typeof sharedScheduler.register> | undefined
      const runtime = new TaskRuntime(runnerStore, host, ctx.location.project.id, progress, {
        architectIdleWindowMs: architectIdleWindowMs(ctx.options.architectIdleWindowMs),
        architectPromptHook: true,
        requestTick: () => (scheduler ? scheduler.runNow() : runtime.tick()),
      })
      yield* ctx.session.hook("prompt", (prompt) =>
        Effect.promise(() => runtime.observeArchitectPrompt(prompt.sessionID, prompt.messageID)),
      )
      yield* registerTaskReads(ctx, new AssociationTaskReads(repository), runtime).pipe(
        Effect.orDie,
      )
      yield* registerWorker(ctx, runtime.store, sourceGuard)
      yield* registerSourceFence(ctx, runtime.store, sourceGuard).pipe(Effect.orDie)
      yield* registerRunnerTools(ctx, runtime)
      yield* registerProgress(
        ctx,
        progress,
        ctx.location.project.id,
        host.retainedInputID,
        host.readSessionLog,
      )
      const trajectoryHost = nativeTrajectoryHost(ctx, ctx.location.project.id)
      const radarSessionHost = nativeRadarSessionHost(ctx)
      yield* registerTrajectoryTools(ctx, runtime.store, trajectoryHost, ctx.location.project.id)
      const observationSecret = crypto.getRandomValues(new Uint8Array(32))
      yield* registerObservability(
        ctx,
        new ObservationReads(
          runtime.store,
          trajectoryHost,
          ctx.location.project.id,
          observationSecret,
          radarSessionHost,
        ),
        ctx.location.project.id,
      ).pipe(Effect.orDie)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          scheduler = sharedScheduler.register(
            schedulerProjectKey(
              repository.path,
              repository.projectDirectory,
              ctx.location.project.id,
            ),
            {
              intervalMs: 2000,
              run: () => runtime.tick(),
              onError: (error) =>
                Effect.runPromise(
                  Effect.logError("LAZERS scheduler reconciliation failed", {
                    error: String(error),
                  }),
                ),
            },
          )
          const registration = scheduler
          return async () => {
            await registration.dispose()
            await runtime.stop()
          }
        }),
        (stop) => Effect.promise(stop),
      )
      yield* registerLocalInference(ctx).pipe(Effect.orDie)
      yield* ctx.storage.set("loaded", true)
      yield* Effect.logInfo("LAZERS loaded", { host: ctx.app.version, database: repository.path })
    }),
})
