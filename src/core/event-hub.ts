import { Effect, Stream } from "effect"

/**
 * One host event subscription per process and event-type set, fanned out to every listener.
 *
 * OpenCode loads one plugin copy per location, and each copy's `ctx.event.subscribe` is the
 * same server-wide stream: the protocol describes it as events "across all server locations"
 * (node_modules/@opencode/protocol/dist/groups/event.js:51), each event carrying its own
 * `location` (event.js:9, :16). A copy that subscribes for itself therefore receives and
 * processes every event again, once per copy. The hub subscribes once through the copy that
 * joined first, and promotes another copy's context when that one leaves.
 *
 * The registry lives on globalThis because every plugin copy loads its own module instance.
 */
type EventStreamContext = {
  event: { subscribe(input: { types: readonly never[] }): Stream.Stream<unknown, unknown> }
}

export type NativeEventListener = {
  /** The stream is attached (also called again after every reattach). */
  attached?(): void
  event(event: unknown): void
  /** The stream ended, failed or changed hands: events may have been missed. */
  gap?(): void
}

type Member = { id: symbol; ctx: EventStreamContext; listener: NativeEventListener }
type Hub = {
  members: Map<symbol, Member>
  leader?: symbol
  fiber?: { interruptUnsafe(): void }
  /** Streams opened so far; for tests and diagnostics. */
  subscriptions: number
}

const hubsKey = Symbol.for("lazers.native-event-hubs.v1")
const host = globalThis as typeof globalThis & { [hubsKey]?: Map<string, Hub> }
const hubs = () => (host[hubsKey] ??= new Map<string, Hub>())

const each = (hub: Hub, call: (listener: NativeEventListener) => void) => {
  for (const member of [...hub.members.values()]) {
    try {
      call(member.listener)
    } catch {
      // One listener's failure never stops the others or the stream.
    }
  }
}

function lead(hub: Hub, member: Member, types: readonly string[]) {
  hub.fiber?.interruptUnsafe()
  hub.leader = member.id
  const loop = Effect.forever(
    Effect.sync(() => {
      hub.subscriptions++
      each(hub, (listener) => listener.attached?.())
    }).pipe(
      Effect.andThen(
        Stream.runForEach(member.ctx.event.subscribe({ types: types as never[] }), (event) =>
          Effect.sync(() => each(hub, (listener) => listener.event(event))),
        ),
      ),
      Effect.match({
        onFailure: () => each(hub, (listener) => listener.gap?.()),
        onSuccess: () => each(hub, (listener) => listener.gap?.()),
      }),
      Effect.andThen(Effect.sleep(1_000)),
    ),
  )
  hub.fiber = Effect.runFork(Effect.sleep(0).pipe(Effect.andThen(loop)))
}

/** Joins the process-wide subscription for `types`; the returned function leaves it. */
export function joinNativeEvents(
  ctx: EventStreamContext,
  types: readonly string[],
  listener: NativeEventListener,
): () => void {
  const key = [...types].sort().join("|")
  const all = hubs()
  let hub = all.get(key)
  if (!hub) {
    hub = { members: new Map(), subscriptions: 0 }
    all.set(key, hub)
  }
  const joined = hub
  const member: Member = { id: Symbol("native-event-listener"), ctx, listener }
  joined.members.set(member.id, member)
  if (joined.leader === undefined) lead(joined, member, types)
  let left = false
  return () => {
    if (left) return
    left = true
    joined.members.delete(member.id)
    if (joined.leader === member.id) {
      joined.fiber?.interruptUnsafe()
      joined.fiber = undefined
      joined.leader = undefined
      const next = joined.members.values().next().value
      if (next) {
        each(joined, (other) => other.gap?.())
        lead(joined, next, types)
      }
    }
    if (joined.members.size === 0 && all.get(key) === joined) all.delete(key)
  }
}

/** Open subscriptions per event-type set, for tests and diagnostics. */
export function nativeEventSubscriptions() {
  return [...hubs().entries()].map(([key, hub]) => ({
    types: key,
    listeners: hub.members.size,
    opened: hub.subscriptions,
  }))
}
