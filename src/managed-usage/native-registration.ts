import { Effect, Stream } from "effect"
import type {
  ManagedUsageCapture,
  ManagedUsageNativeContext,
  ManagedUsageObserverLease,
} from "./native.ts"
import { managedUsageLocation } from "./native-location.ts"

const MANAGED_USAGE_EVENT_TYPES = [
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
] as const

export function registerManagedUsageNative(
  ctx: ManagedUsageNativeContext,
  capture: ManagedUsageCapture,
  projectID: string,
) {
  return Effect.gen(function* () {
    const nativeLocation = managedUsageLocation(ctx.location)
    if (!nativeLocation)
      return yield* Effect.die(new Error("Managed usage native location is unavailable"))
    let activeLease: ManagedUsageObserverLease | undefined
    let stopping: Promise<void> | undefined
    const stop = (
      lease: ManagedUsageObserverLease,
      reason: "stream-failed" | "stream-ended" | "listener-stopped",
    ): Promise<void> => {
      if (activeLease?.id === lease.id) activeLease = undefined
      const current = capture.stopObserver(lease.id, reason).finally(() => {
        if (stopping === current) stopping = undefined
      })
      stopping = current
      return current
    }
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (activeLease) await stop(activeLease, "listener-stopped")
        else await stopping
      }),
    )

    const listen = Effect.forever(
      Effect.suspend(() => {
        const lease = capture.startObserver(crypto.randomUUID(), nativeLocation)
        activeLease = lease
        return Stream.runForEach(
          ctx.event.subscribe({ types: MANAGED_USAGE_EVENT_TYPES }),
          (event) => Effect.sync(() => capture.observeForObserver(lease, event, ctx, projectID)),
        ).pipe(
          Effect.matchEffect({
            onFailure: () => Effect.promise(() => stop(lease, "stream-failed")),
            onSuccess: () => Effect.promise(() => stop(lease, "stream-ended")),
          }),
          Effect.andThen(Effect.sleep(1_000)),
        )
      }),
    )
    yield* Effect.forkScoped(listen)
  })
}
