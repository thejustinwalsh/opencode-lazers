import { registerAuditTools } from "./audit/tools.ts"
import { registerBudget } from "./budget/server.ts"
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { registerArchitect } from "./architect.ts"
import { registerTaskTools } from "./tools.ts"
import { registerLocalInference } from "./webgpu/server.ts"
import { registerTaskReads } from "./tasks/rpc.ts"
import { registerRunnerTools } from "./runner/tools.ts"
import { registerWorker } from "./runner/roles.ts"
import { beginSourceGuard } from "./runner/source-quarantine.ts"
import { registerSourceFence } from "./runner/source-fence-rpc.ts"
import type { ProjectIndex } from "./context/index.ts"
import { registerContextTools } from "./context/tools.ts"
import { registerTrajectoryTools } from "./trajectory/tools.ts"
import { registerObservability } from "./observability/rpc.ts"
import { registerProgress } from "./progress/native.ts"
import { registerRecoveryTools } from "./recovery/tools.ts"
import { registerToolCallWrappers } from "./progress/tool-observation.ts"
import { registerNativeInteraction } from "./verification/opencode/native-interaction-server.ts"
import { registerModelTools } from "./models/tools.ts"
import { registerModelsServer } from "./models/server.ts"
import { acquireLazersCore } from "./core/core.ts"

/**
 * Per-location adapter. OpenCode boots this once per location, so it only registers
 * this location's tools, RPCs and hooks and forwards to the per-process core (one
 * repository, runtime, recorder, index set and scheduler participant per project).
 */
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
      const handle = yield* Effect.acquireRelease(
        Effect.sync(() =>
          acquireLazersCore(ctx, {
            ...(dataDirectory !== undefined ? { dataDirectory } : {}),
            projectID: ctx.location.project.id,
            projectDirectory: ctx.location.project.canonical,
            directory: ctx.location.directory,
            options: ctx.options,
          }),
        ),
        (acquired) => Effect.promise(() => acquired.release()),
      )
      const core = handle.core
      const { repository, runtime, progress } = core
      const projectID = ctx.location.project.id
      yield* registerBudget(ctx, fetch, core.usageCache).pipe(Effect.orDie)
      // The checkout index is built on first use and shared by locations on one directory.
      const projectIndex = new Proxy({} as ProjectIndex, {
        get: (_, property) => {
          const index = core.indexFor(ctx.location.directory)
          const value = Reflect.get(index, property)
          return typeof value === "function" ? value.bind(index) : value
        },
      })
      yield* registerContextTools(ctx, projectIndex)
      yield* registerNativeInteraction(ctx).pipe(Effect.orDie)
      yield* registerTaskTools(ctx, repository, projectIndex, core.verificationDefaults)
      yield* registerModelTools(ctx, repository)
      yield* registerModelsServer(ctx, repository).pipe(Effect.orDie)
      yield* registerArchitect(ctx)
      yield* registerAuditTools(ctx, repository)
      yield* ctx.session.hook("prompt", (prompt) =>
        Effect.promise(() => runtime.observeArchitectPrompt(prompt.sessionID, prompt.messageID)),
      )
      yield* registerTaskReads(ctx, core.taskReads, runtime).pipe(Effect.orDie)
      yield* registerWorker(ctx, runtime.store, sourceGuard)
      yield* registerSourceFence(ctx, runtime.store, sourceGuard).pipe(Effect.orDie)
      yield* registerRunnerTools(ctx, runtime)
      yield* registerProgress(
        ctx,
        progress,
        projectID,
        core.host.retainedInputID,
        core.host.readSessionLog,
        (sessionID) => runtime.observeArchitectSourceEvent(sessionID),
        () => core.wake(),
      )
      yield* registerTrajectoryTools(
        ctx,
        runtime.store,
        core.trajectoryHost,
        projectID,
        core.taskValuationProvider,
      )
      yield* registerObservability(ctx, core.reads, projectID).pipe(Effect.orDie)
      yield* registerLocalInference(ctx, undefined, core.inferenceBroker).pipe(Effect.orDie)
      yield* registerRecoveryTools(ctx, repository)
      yield* registerToolCallWrappers(ctx, progress, projectID)
      yield* ctx.storage.set("loaded", true)
      yield* Effect.logInfo("LAZERS loaded", {
        host: ctx.app.version,
        database: repository.path,
        schema: repository.schemaDrift(),
      })
    }),
})
