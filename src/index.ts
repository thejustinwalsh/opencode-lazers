import { registerAuditTools } from "./audit/tools.ts"
import { registerBudget } from "./budget/server.ts"
import { registerRetention } from "./retention/rpc.ts"
import { Plugin } from "@opencode/plugin/effect"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { registerArchitect } from "./architect.ts"
import { agentRouteReader } from "./models/agent-route-apply.ts"
import { registerTaskTools } from "./tools.ts"
import { registerLocalInference } from "./webgpu/server.ts"
import { registerTaskReads } from "./tasks/rpc.ts"
import { registerPlanningAgents } from "./planning/register.ts"
import { registerRunnerTools } from "./runner/tools.ts"
import {
  architectContextStubsMode,
  registerArchitectContextStubs,
  registerWorker,
} from "./runner/roles.ts"
import { architectCacheWindowMs } from "./runner/architect-routing.ts"
import { registerArchitectContact } from "./runner/architect-contact-rpc.ts"
import type { ProjectIndex } from "./context/index.ts"
import { registerContextTools } from "./context/tools.ts"
import { ensureArchitectMap } from "./context/architect-map.ts"
import { freezePlanMap } from "./context/repo-map-store.ts"
import { registerTrajectoryTools } from "./trajectory/tools.ts"
import { registerObservability } from "./observability/rpc.ts"
import { registerProgress } from "./progress/native.ts"
import { registerRecoveryTools } from "./recovery/tools.ts"
import { registerToolCallWrappers } from "./progress/tool-observation.ts"
import { registerToolResults } from "./tool-results.ts"
import { registerToolSignatures } from "./tool-signature.ts"
import { registerNativeInteraction } from "./verification/opencode/native-interaction-server.ts"
import { registerModelTools } from "./models/tools.ts"
import { registerModelsServer } from "./models/server.ts"
import { section, sectionEffect, stallProbe, timedHooks } from "./diagnostics/stall-probe.ts"
import { acquireLazersCore } from "./core/core.ts"
import { coreSnapshot, loadedProjectDirectories } from "./core/registry.ts"
import { registerProjects } from "./projects/rpc.ts"
import { taskDatabasePath } from "./storage.ts"

/**
 * Per-location adapter. OpenCode boots this once per location, so it only registers
 * this location's tools, RPCs and hooks and forwards to the per-process core (one
 * repository, runtime, recorder, index set and scheduler participant per project).
 */
export default Plugin.define({
  id: "lazers",
  effect: (ctx) =>
    Effect.gen(function* () {
      const dataDirectory = ctx.options.dataDirectory
      if (dataDirectory !== undefined && typeof dataDirectory !== "string") {
        return yield* Effect.die(new Error("LAZERS dataDirectory must be an absolute path string"))
      }
      const probe = stallProbe()
      probe.locations++
      probe.configure({
        dataDirectory: dirname(taskDatabasePath(dataDirectory)),
        log: (message, fields) => void Effect.runFork(Effect.logWarning(message, fields)),
        cores: () => coreSnapshot().length,
      })
      const handle = yield* Effect.acquireRelease(
        Effect.sync(() =>
          section("core:acquire", () =>
            acquireLazersCore(ctx, {
              ...(dataDirectory !== undefined ? { dataDirectory } : {}),
              projectID: ctx.location.project.id,
              projectDirectory: ctx.location.project.canonical,
              directory: ctx.location.directory,
              options: ctx.options,
            }),
          ),
        ),
        (acquired) => Effect.promise(() => acquired.release()),
      )
      const core = handle.core
      const { repository, runtime, progress } = core
      const projectID = ctx.location.project.id
      yield* sectionEffect("setup:Retention", () =>
        registerRetention(ctx, core.retention).pipe(Effect.orDie),
      )
      yield* sectionEffect("setup:Budget", () =>
        registerBudget(ctx, fetch, core.usageCache).pipe(Effect.orDie),
      )
      // The checkout index is built on first use and shared by locations on one directory.
      const projectIndex = new Proxy({} as ProjectIndex, {
        get: (_, property) => {
          const index = core.indexFor(ctx.location.directory)
          const value = Reflect.get(index, property)
          return typeof value === "function" ? value.bind(index) : value
        },
      })
      yield* sectionEffect("setup:ContextTools", () => registerContextTools(ctx, projectIndex))
      yield* sectionEffect("setup:NativeInteraction", () =>
        registerNativeInteraction(ctx).pipe(Effect.orDie),
      )
      yield* sectionEffect("setup:TaskTools", () =>
        registerTaskTools(ctx, repository, projectIndex, core.verificationDefaults, () =>
          core.runtime.fallowGate(),
        ),
      )
      yield* sectionEffect("setup:ModelTools", () => registerModelTools(ctx, repository))
      yield* sectionEffect("setup:ModelsServer", () =>
        registerModelsServer(ctx, repository, undefined, undefined, { prewarmDecision: true }).pipe(
          Effect.orDie,
        ),
      )
      const agentRoutes = agentRouteReader(repository)
      yield* sectionEffect("setup:Architect", () => registerArchitect(ctx, agentRoutes))
      yield* sectionEffect("setup:AuditTools", () =>
        registerAuditTools(ctx, repository, (sessionID) =>
          core.runtime.attemptBaseForSession(sessionID),
        ),
      )
      yield* timedHooks(ctx.session, "session").hook("prompt", (prompt) =>
        Effect.promise(async () => {
          await runtime.observeArchitectPrompt(prompt.sessionID, prompt.messageID)
          // The map joins the Architect's cached prefix at its first prompt; orientation must
          // never block the prompt, so a failure leaves the session without it.
          await ensureArchitectMap(ctx.session, repository, prompt.sessionID).catch(() => false)
        }),
      )
      yield* sectionEffect("setup:TaskReads", () =>
        registerTaskReads(ctx, core.taskReads, runtime).pipe(Effect.orDie),
      )
      yield* sectionEffect("setup:Worker", () =>
        registerWorker(ctx, runtime.store, agentRoutes, runtime.delegatedAgentCapacity, () =>
          core.wake(),
        ),
      )
      yield* sectionEffect("setup:PlanningAgents", () => registerPlanningAgents(ctx, agentRoutes))
      const stubsMode = architectContextStubsMode(ctx.options.architectContextStubs)
      if (stubsMode !== "off")
        yield* sectionEffect("setup:ContextStubs", () =>
          registerArchitectContextStubs(ctx, {
            mode: stubsMode,
            cacheWindowMs: architectCacheWindowMs(
              ctx.options.architectCacheWindowMs ?? ctx.options.architectIdleWindowMs,
            ),
          }),
        )
      yield* sectionEffect("setup:ArchitectContact", () =>
        registerArchitectContact(ctx, runtime.store, () => core.wake()).pipe(Effect.orDie),
      )
      yield* sectionEffect("setup:Projects", () =>
        registerProjects(ctx, repository, {
          projectID: ctx.location.project.id,
          sessionOf: async (id) => {
            const session = await runtime.host.session(id, { messages: false })
            return session && session.projectID === ctx.location.project.id
              ? {
                  id: session.id,
                  archived: session.archived,
                  ...(session.agent ? { agent: session.agent } : {}),
                  ...(session.pendingForms !== undefined
                    ? { pendingForms: session.pendingForms }
                    : {}),
                }
              : null
          },
          loaded: loadedProjectDirectories,
          wake: () => core.wake(),
          dataDirectory: dirname(taskDatabasePath(dataDirectory)),
          proofWorkspace: {
            create: ({ base, name }) =>
              runtime.host.worktree({
                base,
                directory: join(`${repository.projectDirectory}.worktrees`, name),
              }),
            remove: (directory) => runtime.host.removeWorktree(directory),
          },
          defaults: {
            global:
              typeof ctx.options.historyCacheMB === "number"
                ? { historyCacheMB: ctx.options.historyCacheMB }
                : {},
            project:
              typeof ctx.options.workerSpendCeilingTokens === "number" &&
              ctx.options.workerSpendCeilingTokens > 0
                ? { spendCeilingTokens: ctx.options.workerSpendCeilingTokens }
                : {},
          },
        }).pipe(Effect.orDie),
      )
      yield* sectionEffect("setup:RunnerTools", () =>
        registerRunnerTools(ctx, runtime, (planID) =>
          freezePlanMap(repository, planID, ctx.location.directory),
        ),
      )
      yield* sectionEffect("setup:Progress", () =>
        registerProgress(
          ctx,
          progress,
          projectID,
          (sessionID) => runtime.observeArchitectSourceEvent(sessionID),
          () => core.wake(),
        ),
      )
      yield* sectionEffect("setup:TrajectoryTools", () =>
        registerTrajectoryTools(
          ctx,
          runtime.store,
          core.trajectoryHost,
          projectID,
          core.taskValuationProvider,
        ),
      )
      yield* sectionEffect("setup:Observability", () =>
        registerObservability(ctx, core.reads, projectID).pipe(Effect.orDie),
      )
      yield* sectionEffect("setup:LocalInference", () =>
        registerLocalInference(ctx, undefined, core.inferenceBroker).pipe(Effect.orDie),
      )
      yield* sectionEffect("setup:RecoveryTools", () => registerRecoveryTools(ctx, repository))
      yield* sectionEffect("setup:ToolSignatures", () => registerToolSignatures(ctx))
      yield* sectionEffect("setup:ToolResults", () => registerToolResults(ctx, projectID))
      yield* sectionEffect("setup:ToolCallWrappers", () =>
        registerToolCallWrappers(ctx, progress, projectID),
      )
      yield* ctx.storage.set("loaded", true)
      yield* Effect.logInfo("LAZERS loaded", {
        host: ctx.app.version,
        database: repository.path,
        schema: repository.schemaDrift(),
      })
    }),
})
