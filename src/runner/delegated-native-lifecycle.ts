import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect, Predicate, Stream } from "effect"
import type { DelegatedAgentCapacity, NativeExecution } from "./delegated-agent-capacity.ts"

const eventTypes = [
  "session.created",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const

/**
 * Observe an admission, not just a child ID: an old wait must never release a
 * later execution in that child. All observers belong to the plugin's scope.
 */
export function nativeChildLifecycle(
  ctx: Plugin.Context,
  capacity: DelegatedAgentCapacity,
  wakeScheduler?: () => void,
) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope
    const watched = new Set<string>()
    let disposed = false
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        disposed = true
      }),
    )
    const release = (execution: NativeExecution) =>
      Effect.promise(async () => {
        if (!disposed && (await capacity.releaseNativeRequest(execution.id, execution.key)))
          wakeScheduler?.()
      })
    const monitor = (execution: NativeExecution) =>
      Effect.gen(function* () {
        for (;;) {
          const observed = yield* ctx.session
            .get({ sessionID: Session.ID.make(execution.sessionID) })
            .pipe(
              Effect.map((session) => ({ found: true as const, session })),
              Effect.catch((error) =>
                Predicate.isObject(error) && error._tag === "SessionNotFoundError"
                  ? Effect.succeed({ found: false as const })
                  : Effect.fail(error),
              ),
            )
          if (!observed.found) {
            yield* release(execution)
            return
          }
          const busy = observed.session.time.busy
          const idle = observed.session.time.idle
          // A child is created idle before its first prompt. No wait or idle
          // snapshot proves completion until this admission actually executed.
          if (
            busy &&
            (DateTime.toEpochMillis(busy) >= execution.createdAt ||
              (idle && DateTime.toEpochMillis(idle) < DateTime.toEpochMillis(busy)))
          ) {
            yield* ctx.session
              .wait({ sessionID: Session.ID.make(execution.sessionID) })
              .pipe(
                Effect.catch((error) =>
                  Predicate.isObject(error) && error._tag === "SessionNotFoundError"
                    ? Effect.void
                    : Effect.fail(error),
                ),
              )
            yield* release(execution)
            return
          }
          yield* Effect.sleep(150)
        }
      }).pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(Effect.sync(() => watched.delete(execution.key))),
      )
    const watch = (sessionID: string) =>
      Effect.gen(function* () {
        const execution = yield* Effect.promise(() => capacity.nativeExecution(sessionID))
        if (!execution || disposed || watched.has(execution.key)) return
        watched.add(execution.key)
        yield* Effect.forkIn(monitor(execution), scope)
      })
    const observe = (event: unknown) =>
      Effect.gen(function* () {
        const payload = Predicate.isObject(event) ? event : undefined
        const data = payload && Predicate.isObject(payload.data) ? payload.data : undefined
        if (!data || typeof data.sessionID !== "string") return
        if (
          payload?.type === "session.created" &&
          typeof data.parentID === "string" &&
          typeof data.agent === "string" &&
          typeof data.title === "string"
        )
          yield* Effect.promise(() =>
            capacity.bindNativeChildFromCreatedSession({
              sessionID: data.sessionID as string,
              parentSessionID: data.parentID as string,
              agent: data.agent as string,
              description: data.title as string,
            }),
          )
        // Events wake a fresh observation; they do not release whatever
        // generation happens to be current when a delayed event arrives.
        yield* watch(data.sessionID)
      })
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.suspend(() =>
          Stream.runForEach(ctx.event.subscribe({ types: eventTypes }), observe).pipe(
            Effect.catch(() => Effect.void),
            Effect.andThen(Effect.sleep(1_000)),
          ),
        ),
      ),
    )
    for (const execution of yield* Effect.promise(() => capacity.admittedNativeExecutions()))
      yield* watch(execution.sessionID)
    return { watch }
  })
}
