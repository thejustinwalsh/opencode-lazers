import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { privacyStats, safeError } from "../trajectory/privacy.ts"
import { TrajectoryHistoryUnavailableError } from "../trajectory/history.ts"
import { Observability } from "./contract.ts"
import type { ObservationReads } from "./read.ts"
import { ObservationChangeTracker } from "./changes.ts"

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

const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "SessionNotFoundError"

async function authorize(
  ctx: ObservationContext,
  scope: { sessionID: string },
  projectID: string,
  projectDirectory: string,
  action: "read" | "lz-inspect-trajectory",
) {
  const session = await Effect.runPromise(
    ctx.session
      .get({ sessionID: Session.ID.make(scope.sessionID) })
      .pipe(
        Effect.catch((error) => (isNotFound(error) ? Effect.succeed(null) : Effect.fail(error))),
      ),
  )
  if (
    !session ||
    session.id !== scope.sessionID ||
    session.projectID !== projectID ||
    session.time.archived !== undefined ||
    !session.agent
  )
    throw new Error("Observation scope is unavailable")
  await Effect.runPromise(
    ctx.permission.assert({
      sessionID: Session.ID.make(session.id),
      agent: Agent.ID.make(session.agent),
      action,
      resources: action === "read" ? [projectDirectory] : ["*"],
    }),
  )
}

export function registerObservability(
  ctx: ObservationContext,
  reads: ObservationReads,
  projectID: string,
) {
  return Effect.gen(function* () {
    const tracker = new ObservationChangeTracker(reads.store.repository, reads.secret, projectID)
    const rpc = yield* ctx.rpc.register(Observability, {
      snapshot: (input) =>
        Effect.tryPromise({
          try: async () => {
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "read",
            )
            return reads.snapshot(input.scope, tracker)
          },
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.orDie),
      radar: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "read",
            )
            return reads.radar(input, tracker, signal)
          },
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.orDie),
      trajectory: (input) =>
        Effect.tryPromise({
          try: async () => {
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "lz-inspect-trajectory",
            )
            return reads.trajectory(input, tracker)
          },
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.orDie),
      trajectoryHistory: (input, context) =>
        Effect.tryPromise({
          try: async () => {
            await authorize(
              ctx,
              input.scope,
              projectID,
              reads.store.repository.projectDirectory,
              "lz-inspect-trajectory",
            )
            return reads.trajectoryHistory(input, tracker)
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

    tracker.initialize((change) => {
      void Effect.runPromise(rpc.events.emit("changed", change)).catch(() => {})
    })

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        let closed = false
        const poll = () => {
          if (closed) return
          try {
            tracker.refreshSource()
          } catch {
            tracker.streamGap()
          }
        }
        const unsubscribe = reads.store.repository.subscribe(poll)
        const timer = setInterval(poll, 1_000)
        return () => {
          closed = true
          clearInterval(timer)
          unsubscribe()
        }
      }),
      (close) => Effect.sync(close),
    )

    const listen = Effect.forever(
      Stream.runForEach(ctx.event.subscribe({ types: NATIVE_EVENT_TYPES }), (event) =>
        Effect.sync(() => tracker.native(event)),
      ).pipe(
        Effect.match({
          onFailure: () => {
            tracker.streamGap()
          },
          onSuccess: () => {
            tracker.streamGap()
          },
        }),
        Effect.andThen(Effect.sleep(1_000)),
      ),
    )
    yield* Effect.forkScoped(listen)
  })
}
