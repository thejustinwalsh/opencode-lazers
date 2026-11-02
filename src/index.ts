import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { registerArchitect } from "./architect.ts"
import { TaskRepository, taskDatabasePath } from "./storage.ts"
import { registerTaskTools } from "./tools.ts"
import { registerLocalInference } from "./webgpu/server.ts"
import { registerTaskReads } from "./tasks/rpc.ts"
import { RunnerStore } from "./runner/store.ts"
import { TaskRuntime } from "./runner/runtime.ts"
import { nativeHost } from "./runner/native.ts"
import { registerRunnerTools } from "./runner/tools.ts"
import { registerWorker } from "./runner/roles.ts"
import { ProjectIndex } from "./context/index.ts"
import type { ContextHost } from "./context/index.ts"
import { registerContextTools } from "./context/tools.ts"
import { nativeTrajectoryHost } from "./trajectory/native.ts"
import { registerTrajectoryTools } from "./trajectory/tools.ts"
import { AssociationTaskReads } from "./observability/task-reads.ts"
import { ObservationReads } from "./observability/read.ts"
import { registerObservability } from "./observability/rpc.ts"
import { ProgressRecorder } from "./progress/recorder.ts"
import { registerProgress } from "./progress/native.ts"
import { registerNativeInteraction } from "./verification/opencode/native-interaction-server.ts"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { join, dirname } from "node:path"

export default Plugin.define({
  id: "lazers",
  effect: (ctx) =>
    Effect.gen(function* () {
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
            async (path, principal, workspace) => {
              try {
                await Effect.runPromise(
                  ctx.permission.assert({
                    sessionID: Session.ID.make(principal.sessionID),
                    agent: Agent.ID.make(principal.agent),
                    action: "read",
                    resources: [join(workspace, path)],
                  }),
                )
                return true
              } catch {
                return false
              }
            },
            contextHost,
          )
        }),
        (index) => Effect.sync(() => index.close()),
      )
      yield* registerContextTools(ctx, projectIndex)
      yield* registerNativeInteraction(ctx).pipe(Effect.orDie)
      yield* registerTaskTools(ctx, repository)
      yield* registerArchitect(ctx)
      const runnerStore = new RunnerStore(repository)
      const progress = new ProgressRecorder(runnerStore, ctx.location.project.id)
      const runtime = new TaskRuntime(
        runnerStore,
        nativeHost(ctx, repository),
        ctx.location.project.id,
        progress,
      )
      yield* registerTaskReads(ctx, new AssociationTaskReads(repository), runtime).pipe(
        Effect.orDie,
      )
      yield* registerWorker(ctx, runtime.store)
      yield* registerRunnerTools(ctx, runtime)
      yield* registerProgress(ctx, progress, ctx.location.project.id)
      const trajectoryHost = nativeTrajectoryHost(ctx, ctx.location.project.id)
      yield* registerTrajectoryTools(ctx, runtime.store, trajectoryHost, ctx.location.project.id)
      const observationSecret = crypto.getRandomValues(new Uint8Array(32))
      yield* registerObservability(
        ctx,
        new ObservationReads(
          runtime.store,
          trajectoryHost,
          ctx.location.project.id,
          observationSecret,
        ),
        ctx.location.project.id,
      ).pipe(Effect.orDie)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const tick = () => {
            void runtime.tick().catch((error) =>
              Effect.runPromise(
                Effect.logError("LAZERS scheduler reconciliation failed", {
                  error: String(error),
                }),
              ),
            )
          }
          const timer = setInterval(tick, 2000)
          tick()
          return async () => {
            clearInterval(timer)
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
