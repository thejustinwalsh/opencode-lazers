import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { registerArchitect } from "./architect.ts"
import { TaskRepository, taskDatabasePath } from "./storage.ts"
import { registerTaskTools } from "./tools.ts"
import { registerLocalInference } from "./webgpu/server.ts"
import { TaskReads } from "./tasks/read.ts"
import { registerTaskReads } from "./tasks/rpc.ts"
import { RunnerStore } from "./runner/store.ts"
import { TaskRuntime } from "./runner/runtime.ts"
import { nativeHost } from "./runner/native.ts"
import { registerRunnerTools } from "./runner/tools.ts"
import { registerWorker } from "./runner/roles.ts"
import { ProjectIndex } from "./context/index.ts"
import { registerContextTools } from "./context/tools.ts"
import { nativeTrajectoryHost } from "./trajectory/native.ts"
import { registerTrajectoryTools } from "./trajectory/tools.ts"
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
        Effect.sync(
          () =>
            new ProjectIndex(
              ctx.location.directory,
              join(dirname(repository.path), "context"),
              repository,
              async (path, principal) => {
                try {
                  await Effect.runPromise(
                    ctx.permission.assert({
                      sessionID: Session.ID.make(principal.sessionID),
                      agent: Agent.ID.make(principal.agent),
                      action: "read",
                      resources: [join(ctx.location.directory, path)],
                    }),
                  )
                  return true
                } catch {
                  return false
                }
              },
            ),
        ),
        (index) => Effect.sync(() => index.close()),
      )
      yield* registerContextTools(ctx, projectIndex)
      yield* registerTaskTools(ctx, repository)
      yield* registerTaskReads(ctx, new TaskReads(repository)).pipe(Effect.orDie)
      yield* registerArchitect(ctx)
      const runtime = new TaskRuntime(
        new RunnerStore(repository),
        nativeHost(ctx, repository),
        ctx.location.project.id,
      )
      yield* registerWorker(ctx, runtime.store)
      yield* registerRunnerTools(ctx, runtime)
      yield* registerTrajectoryTools(
        ctx,
        runtime.store,
        nativeTrajectoryHost(ctx, ctx.location.project.id),
        ctx.location.project.id,
      )
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
          return () => {
            clearInterval(timer)
            runtime.stop()
          }
        }),
        (stop) => Effect.sync(stop),
      )
      yield* registerLocalInference(ctx).pipe(Effect.orDie)
      yield* ctx.storage.set("loaded", true)
      yield* Effect.logInfo("LAZERS loaded", { host: ctx.app.version, database: repository.path })
    }),
})
