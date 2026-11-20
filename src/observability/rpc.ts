import { joinNativeEvents } from "../core/event-hub.ts"
import { section, timedRpc } from "../diagnostics/stall-probe.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { privacyStats, safeError } from "../trajectory/privacy.ts"
import { TrajectoryHistoryUnavailableError } from "../trajectory/history.ts"
import { progressReconstructionDiagnostics } from "../progress/reconstruction.ts"
import { sharedScheduler } from "../runner/scheduler-coordinator.ts"
import { Observability, type ObservationChange } from "./contract.ts"
import { allProjectsAccess, callerSession } from "../projects/read-access.ts"
import { loadedProjectDirectories } from "../core/registry.ts"
import type { ObservationReads } from "./read.ts"
import { ObservationReadChangedError } from "./read.ts"
import { ObservationChangeTracker } from "./changes.ts"
import { databaseChanges } from "../database-events.ts"
import { LiveHistoryUnavailableError } from "./live-store.ts"

type ObservationContext = Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">

const NATIVE_EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.agent.selected",
  "session.model.selected",
  "session.moved",
  "session.archived",
  "session.unarchived",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.usage.updated",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.ended",
  "session.synthetic",
  "session.tool.called",
  "session.tool.input.started",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.retry.scheduled",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.idle",
  "session.status",
] as const

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

async function authorize(
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
    const tracker = new ObservationChangeTracker(reads.store.repository, reads.secret, projectID)
    const rpc = yield* timedRpc(ctx.rpc).register(Observability, {
      snapshot: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (input.scope.kind === "all")
              return reads.snapshotAll(
                { scope: input.scope, ...(input.cursor ? { cursor: input.cursor } : {}) },
                tracker,
                await accessFor(input.scope),
                signal,
              )
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "read",
            )
            return reads.snapshot(input.scope, tracker, signal)
          },
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.orDie),
      topology: (input) =>
        Effect.tryPromise({
          try: async () => {
            if (input.scope.kind === "all")
              return reads.topologyAll(
                { scope: input.scope, ...(input.cursor ? { cursor: input.cursor } : {}) },
                tracker,
                await accessFor(input.scope),
              )
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "read",
            )
            return reads.topology(input.scope, tracker)
          },
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.orDie),
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
                  tracker,
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
      radar: (input, context) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (input.scope.kind === "all") {
              const access = await accessFor(input.scope)
              const scope = input.scope
              for (let attempt = 1; ; attempt++) {
                signal.throwIfAborted()
                try {
                  return await reads.radarAll(
                    {
                      scope,
                      includeUnmanagedSessions: input.includeUnmanagedSessions,
                      ...(input.cursor ? { cursor: input.cursor } : {}),
                    },
                    tracker,
                    signal,
                    access,
                  )
                } catch (error) {
                  if (!(error instanceof ObservationReadChangedError) || attempt === 3) throw error
                }
              }
            }
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "read",
            )
            for (let attempt = 1; ; attempt++) {
              signal.throwIfAborted()
              try {
                return await reads.radar(input, tracker, signal)
              } catch (error) {
                if (!(error instanceof ObservationReadChangedError) || attempt === 3) throw error
              }
            }
          },
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            error instanceof ObservationReadChangedError
              ? Effect.fail(
                  context.error("observation_changed", error.message, {
                    source: error.source,
                    recovery: "retry",
                  }),
                )
              : Effect.die(new Error(safeError(error, privacyStats()))),
          ),
        ),
      liveRadar: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (input.scope.kind === "all")
              return reads.liveRadarAll(
                {
                  scope: input.scope,
                  includeUnmanagedSessions: input.includeUnmanagedSessions,
                  ...(input.cursor ? { cursor: input.cursor } : {}),
                },
                tracker,
                signal,
                await accessFor(input.scope),
              )
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "read",
            )
            return reads.liveRadar(input, tracker, signal, tracker.streamEpoch)
          },
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.orDie),
      liveGroup: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (input.scope.kind === "all")
              return reads.liveGroupAll(
                {
                  scope: input.scope,
                  group: input.group,
                  ...(input.cursor ? { cursor: input.cursor } : {}),
                },
                tracker,
                signal,
                await accessFor(input.scope),
              )
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "read",
            )
            return reads.liveGroup(input, signal)
          },
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.orDie),
      liveAttempt: (input, context) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (input.scope.kind === "all")
              return reads.liveAttemptAll(input, tracker, signal, await accessFor(input.scope))
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "read",
            )
            return reads.liveAttempt(input, signal)
          },
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            error instanceof LiveHistoryUnavailableError
              ? Effect.fail(
                  context.error("live_history_unavailable", error.message, {
                    reason: error.reason,
                    recovery: "restart",
                  }),
                )
              : Effect.die(new Error(safeError(error, privacyStats()))),
          ),
        ),
      trajectory: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (input.scope.kind === "all") {
              return reads.trajectoryAll(input, tracker, signal, await accessFor(input.scope))
            }
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "lz-inspect-trajectory",
            )
            signal.throwIfAborted()
            return reads.trajectory(input, tracker, signal)
          },
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.orDie),
      trajectoryHistory: (input, context) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (input.scope.kind === "all") {
              return reads.trajectoryHistoryAll(
                input,
                tracker,
                signal,
                await accessFor(input.scope),
              )
            }
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "lz-inspect-trajectory",
            )
            signal.throwIfAborted()
            return reads.trajectoryHistory(input, tracker, signal)
          },
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            error instanceof TrajectoryHistoryUnavailableError
              ? Effect.fail(
                  context.error("trajectory_history_unavailable", error.message, {
                    reason: error.reason,
                    recovery: "recapture",
                  }),
                )
              : Effect.die(new Error(safeError(error, privacyStats()))),
          ),
        ),
      trajectoryStatus: (input) =>
        Effect.tryPromise({
          try: async () => {
            if (input.scope.kind === "all") {
              return reads.trajectoryStatusAll(input, tracker, await accessFor(input.scope))
            }
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "lz-inspect-trajectory",
            )
            return reads.trajectoryStatus(input, tracker)
          },
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.orDie),
    })

    let disposed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let retryChange: ObservationChange | undefined
    const publish = (change: ObservationChange) => {
      if (disposed) return
      void Effect.runPromise(rpc.events.emit("changed", change)).then(
        () => {
          if (retryChange && retryChange.sequence <= change.sequence) {
            retryChange = undefined
            if (retry) clearTimeout(retry)
            retry = undefined
          }
        },
        () => {
          if (disposed) return
          if (!retryChange || retryChange.sequence < change.sequence) retryChange = change
          if (retry) return
          retry = setTimeout(() => {
            retry = undefined
            const latest = retryChange
            retryChange = undefined
            if (latest) publish({ ...latest, cause: "gap", resnapshotRequired: true })
          }, 1_000)
          retry.unref()
        },
      )
    }
    tracker.initialize(publish)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        disposed = true
        if (retry) clearTimeout(retry)
        tracker.close()
      }),
    )

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        let closed = false
        const refresh = () => {
          if (closed) return
          // Every runner/progress write bumps the revision; coalesce into one trailing read.
          tracker.scheduleRefresh()
        }
        const unsubscribe = databaseChanges.subscribe(reads.store.repository.path, refresh, () =>
          tracker.streamGap(),
        )
        return () => {
          closed = true
          unsubscribe()
        }
      }),
      (close) => Effect.sync(close),
    )

    // The host stream is server-wide: one subscription per process feeds every copy's tracker.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        joinNativeEvents(
          ctx,
          NATIVE_EVENT_TYPES,
          {
            attached: () => tracker.streamAttached(),
            event: (event) =>
              section(`event:${(event as { type?: string }).type}`, () => tracker.native(event)),
            gap: () => tracker.streamGap(),
          },
          (ctx as { location?: { directory?: string } }).location?.directory,
        ),
      ),
      (leave) => Effect.sync(leave),
    )
  })
}
