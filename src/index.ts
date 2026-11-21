import { registerAuditTools } from "./audit/tools.ts"
import { registerBudget } from "./budget/server.ts"
import { registerRetention } from "./retention/rpc.ts"
import { Plugin } from "@opencode/plugin/effect"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { registerArchitect } from "./architect.ts"
import { agentRouteReader } from "./models/agent-route-apply.ts"
import { registerTaskTools, taskSubmitter } from "./tools.ts"
import { startingRevision } from "./submission.ts"
import { PlanTasker } from "./planning/tasking.ts"
import { registerLocalInference } from "./webgpu/server.ts"
import { registerTaskReads } from "./tasks/rpc.ts"
import { registerStreams } from "./streams/rpc.ts"
import { registerPlanningAgents } from "./planning/register.ts"
import {
  createPlanningDecisions,
  createPlanningReviews,
  registerPlanningReviewTicks,
  registerPlanningDecisionHooks,
  registerPlanningRpc,
  sessionMessageText,
} from "./planning/server.ts"
import { startDecision } from "./planning/decision/step.ts"
import {
  PlanDrafts,
  PlanResolver,
  PlanReviewer,
  registerPlanResolveTool,
  registerPlanTaskTool,
  registerPlanReviewTool,
  registerPlanningTools,
} from "./planning/tools.ts"
import { PlanningStore } from "./planning/store.ts"
import { projectKeyOfDirectory, projectSettings } from "./projects/settings.ts"
import { registerRunnerTools, submitPlanReceipt } from "./runner/tools.ts"
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
import { registerProfileTools } from "./projects/profile-tools.ts"
import { ensureArchitectProfileGuidance, ensureSetupPointer } from "./projects/profile-guidance.ts"
import { freezePlanMap } from "./context/repo-map-store.ts"
import { registerTrajectoryTools } from "./trajectory/tools.ts"
import { authorize as authorizeRead, registerObservability } from "./observability/rpc.ts"
import { projectIdsFor } from "./project-key.ts"
import { registerProgress } from "./progress/native.ts"
import { registerRecoveryTools } from "./recovery/tools.ts"
import { registerToolCallWrappers } from "./progress/tool-observation.ts"
import { registerToolResults } from "./tool-results.ts"
import { registerToolSignatures } from "./tool-signature.ts"
import { registerNativeInteraction } from "./verification/opencode/native-interaction-server.ts"
import { registerModelTools } from "./models/tools.ts"
import { createModelsManagedUsagePriceProvider, registerModelsServer } from "./models/server.ts"
import { registerManagedUsageTools } from "./managed-usage/tools.ts"
import { startHeapSampler } from "./diagnostics/heap-sampler.ts"
import {
  section,
  sectionAsync,
  sectionEffect,
  stallProbe,
  timedHooks,
} from "./diagnostics/stall-probe.ts"
import { loadLazersCore } from "./core/load.ts"
import { nativeEventSubscriptions } from "./core/event-hub.ts"
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
      const diagnosticsRoot = dirname(taskDatabasePath(dataDirectory))
      startHeapSampler({
        directory: join(diagnosticsRoot, "diagnostics"),
        context: () => ({
          locations: probe.locations,
          cores: coreSnapshot().length,
          // Per event-type set: live subscriptions and mode, first-seen vs duplicate deliveries,
          // how many distinct locations delivered each retained event, and `singleSourceEvents`
          // (nonzero means a stream is location-scoped and the hub fell back to every copy).
          events: nativeEventSubscriptions(),
        }),
      })
      probe.configure({
        dataDirectory: diagnosticsRoot,
        log: (message, fields) => void Effect.runFork(Effect.logWarning(message, fields)),
        cores: () => coreSnapshot().length,
      })
      const handle = yield* Effect.acquireRelease(
        Effect.promise(() =>
          sectionAsync("core:acquire", () =>
            loadLazersCore(ctx, {
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
      const managedUsagePriceProvider = createModelsManagedUsagePriceProvider(ctx, repository)
      yield* sectionEffect("setup:ManagedUsageTools", () =>
        registerManagedUsageTools({
          ctx,
          store: core.managedUsageStore,
          projectID,
          projectDirectory: repository.projectDirectory,
          priceProvider: managedUsagePriceProvider,
        }),
      )
      const agentRoutes = agentRouteReader(repository)
      yield* sectionEffect("setup:Architect", () => registerArchitect(ctx, agentRoutes))
      yield* sectionEffect("setup:AuditTools", () =>
        registerAuditTools(ctx, repository, (sessionID) =>
          core.runtime.attemptBaseForSession(sessionID),
        ),
      )
      yield* sectionEffect("setup:ProfileTools", () =>
        registerProfileTools(ctx, repository, {
          dataDirectory: dirname(taskDatabasePath(dataDirectory)),
          workspace: {
            create: ({ base, name }) =>
              runtime.host.worktree({
                base,
                directory: join(`${repository.projectDirectory}.worktrees`, name),
              }),
            remove: (directory) => runtime.host.removeWorktree(directory),
          },
        }),
      )
      const planningDecisions = createPlanningDecisions(
        ctx,
        repository,
        core.inferenceBroker,
        projectID,
      )
      const sessionAgents = core.sessionAgents
      yield* timedHooks(ctx.session, "session").hook("prompt", (prompt) =>
        Effect.promise(async () => {
          // Recorded and delivered without ever delaying the prompt; a failure here is invisible.
          void (async () => {
            const id = String(prompt.sessionID)
            let agent = sessionAgents.get(id)
            if (agent === undefined) {
              agent = String(
                (await Effect.runPromise(ctx.session.get({ sessionID: prompt.sessionID }))).agent,
              )
              sessionAgents.set(id, agent)
            }
            startDecision(planningDecisions, {
              sessionID: id,
              messageID: String(prompt.messageID),
              text: prompt.prompt.text,
              agent,
            })
          })().catch(() => undefined)
          await runtime.observeArchitectPrompt(prompt.sessionID, prompt.messageID)
          // The map joins the Architect's cached prefix at its first prompt; orientation must
          // never block the prompt, so a failure leaves the session without it.
          await ensureArchitectMap(ctx.session, repository, prompt.sessionID).catch(() => false)
          await ensureArchitectProfileGuidance(ctx.session, repository, prompt.sessionID).catch(
            () => false,
          )
          await ensureSetupPointer(ctx.session, repository, prompt.sessionID).catch(() => false)
        }),
      )
      yield* sectionEffect("setup:TaskReads", () =>
        registerTaskReads(ctx, core.taskReads, runtime).pipe(Effect.orDie),
      )
      yield* sectionEffect("setup:Streams", () =>
        registerStreams(ctx, {
          databasePath: core.taskReads.repository.path,
          context: {
            projectID,
            projectDirectory: repository.projectDirectory,
            projectIds: projectIdsFor,
            read: (run) => repository.read(run),
            assertRead: async (sessionID) => {
              await authorizeRead(
                ctx,
                { sessionID },
                projectID,
                repository.projectDirectory,
                "read",
              )
            },
          },
        }).pipe(Effect.orDie),
      )
      yield* sectionEffect("setup:Worker", () =>
        registerWorker(ctx, runtime.store, agentRoutes, runtime.delegatedAgentCapacity, () =>
          core.wake(),
        ),
      )
      yield* sectionEffect("setup:PlanningAgents", () => registerPlanningAgents(ctx, agentRoutes))
      yield* registerPlanningDecisionHooks(ctx, planningDecisions)
      yield* registerPlanningRpc(ctx, repository, projectID).pipe(Effect.orDie)
      const planningReviews = createPlanningReviews(
        ctx,
        repository,
        agentRoutes,
        core.host.messages,
      )
      yield* registerPlanningReviewTicks(planningReviews, repository.projectDirectory)
      yield* sectionEffect("setup:PlanningTools", () =>
        Effect.gen(function* () {
          const store = new PlanningStore(repository)
          yield* registerPlanningTools(
            ctx,
            new PlanDrafts(
              repository,
              projectID,
              Date.now,
              (planningID, reason) => void planningReviews.cancelForPlanning(planningID, reason),
            ),
          )
          yield* registerPlanResolveTool(
            ctx,
            new PlanResolver(
              store,
              projectID,
              sessionMessageText((sessionID, messageID) => core.host.message(sessionID, messageID)),
            ),
          )
          yield* registerPlanTaskTool(
            ctx,
            new PlanTasker({
              store,
              projectID,
              submitTask: taskSubmitter(ctx, repository, core.verificationDefaults, () =>
                core.runtime.fallowGate(),
              ),
              submitPlan: (input, sessionID) =>
                submitPlanReceipt(
                  core.runtime,
                  (planID) =>
                    freezePlanMap(
                      repository,
                      planID,
                      ctx.location.directory,
                      repository.projectDirectory,
                    ),
                  input,
                  sessionID,
                ),
              headCommit: async () => {
                const revision = await startingRevision(ctx.location.directory)
                if (revision.kind !== "git")
                  throw new Error("The checkout has no commit; give baseCommit")
                return revision.commit
              },
              cancelReviews: (planningID, reason) =>
                planningReviews.cancelForPlanning(planningID, reason),
              timeoutDefaults: core.verificationDefaults,
            }),
          )
          yield* registerPlanReviewTool(
            ctx,
            new PlanReviewer(
              store,
              planningReviews,
              projectID,
              () => {
                const key = projectKeyOfDirectory(repository, repository.projectDirectory)
                return key ? projectSettings(repository, key).planningAutoDispatch : true
              },
              ctx.location.directory,
            ),
          )
        }),
      )
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
          freezePlanMap(repository, planID, ctx.location.directory, repository.projectDirectory),
        ),
      )
      yield* sectionEffect("setup:Progress", () =>
        registerProgress(
          ctx,
          progress,
          projectID,
          (sessionID, type) => runtime.observeArchitectSourceEvent(sessionID, type),
          () => core.wake(),
          core.host.messages,
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
      yield* sectionEffect("setup:RecoveryTools", () =>
        registerRecoveryTools(ctx, repository, core.host.messages),
      )
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
