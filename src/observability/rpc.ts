import { timedRpc } from "../diagnostics/stall-probe.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { privacyStats, safeError } from "../trajectory/privacy.ts"
import { progressReconstructionDiagnostics } from "../progress/reconstruction.ts"
import { sharedScheduler } from "../runner/scheduler-coordinator.ts"
import { Observability } from "./contract.ts"
import { allProjectsAccess, callerSession } from "../projects/read-access.ts"
import { loadedProjectDirectories } from "../core/registry.ts"
import type { ObservationReads } from "./read.ts"

type ObservationContext = Pick<Plugin.Context, "rpc" | "permission" | "session">

function schedulerTotals(agent: string) {
  return agent === "architect"
    ? {
        status: "available" as const,
        scope: "process" as const,
        audience: "architect-only" as const,
        source: "sharedScheduler.snapshot" as const,
        ...sharedScheduler.snapshot(),
      }
    : { status: "unavailable" as const, reason: "architect-only" as const }
}

export async function authorize(
  ctx: ObservationContext,
  scope: { sessionID: string },
  projectID: string,
  projectDirectory: string,
  action: "read" | "lz-inspect-trajectory",
) {
  const session = await callerSession(ctx, scope.sessionID, projectID)
  if (!session) throw new Error("Observation scope is unavailable")
  await Effect.runPromise(
    ctx.permission.assert({
      sessionID: Session.ID.make(session.id),
      agent: Agent.ID.make(session.agent),
      action,
      resources: action === "read" ? [projectDirectory] : ["*"],
    }),
  )
  return session.agent
}

export function registerObservability(
  ctx: ObservationContext,
  reads: ObservationReads,
  projectID: string,
  options: {
    /** Project roots with a live location in this server; decides `loaded` on all-projects rows. */
    loaded?: () => Iterable<string>
  } = {},
) {
  const loaded = options.loaded ?? loadedProjectDirectories
  /**
   * The checkouts an all-projects read covers. A read over this RPC is the owner looking at their
   * own machine's projects, so no permission is asserted here (nothing can prompt); the session
   * check only guards against a malformed call. Agent tools never reach these reads.
   */
  const accessFor = (scope: { sessionID: string }) =>
    allProjectsAccess(ctx, {
      sessionID: scope.sessionID,
      projectID,
      repository: reads.store.repository,
      loaded,
      unavailable: "Observation scope is unavailable",
    })
  return Effect.gen(function* () {
    yield* timedRpc(ctx.rpc).register(Observability, {
      progressDiagnostics: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (input.scope.kind === "all") {
              const access = await accessFor(input.scope)
              const agent = (await callerSession(ctx, input.scope.sessionID, projectID))!.agent
              signal.throwIfAborted()
              return reads
                .allPage(
                  { scope: input.scope, ...(input.cursor ? { cursor: input.cursor } : {}) },
                  access,
                  (unit) => ({
                    ...progressReconstructionDiagnostics(
                      reads.store.repository.path,
                      unit.reads.store.repository.projectDirectory,
                      unit.reads.projectIdentity,
                    ),
                    scope: { kind: "project" as const },
                    processSchedulerTotals: schedulerTotals(agent),
                  }),
                )
                .then((page) => ({ ...page, scope: { kind: "all" as const } }))
            }
            const agent = await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "read",
            )
            signal.throwIfAborted()
            const reconstruction = progressReconstructionDiagnostics(
              reads.store.repository.path,
              reads.store.repository.projectDirectory,
              projectID,
            )
            const processSchedulerTotals = schedulerTotals(agent)
            return {
              ...reconstruction,
              scope: { kind: "project" as const },
              processSchedulerTotals,
            }
          },
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.orDie),
    })
  })
}
