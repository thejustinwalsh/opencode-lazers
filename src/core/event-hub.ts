import { Effect, Stream } from "effect"

/**
 * One process-wide fan-out of host events, correct whether or not a plugin copy's stream is
 * server-wide.
 *
 * OpenCode loads one plugin copy per location. The server protocol says the event stream spans
 * "all server locations" and each event carries its own `location`
 * (node_modules/@opencode/protocol/dist/groups/event.js:51, :9, :16), but the plugin runtime
 * that backs `ctx.event.subscribe` is not readable here, so the hub does not rely on it:
 *
 * - Every copy keeps its own subscription. A subscription is cheap; processing each event once
 *   per copy is the cost.
 * - Events are de-duplicated by their own id (`id: Event.ID`, event.js:7 for native events and
 *   :12 for plugin RPC events; one id names one event across every stream that carries it). The
 *   first delivery of an id fans out to every listener; later deliveries of it are dropped. If
 *   the streams are server-wide, each event is processed once instead of once per copy; if each
 *   stream is scoped to its own location, every event is still delivered once to every listener,
 *   so no listener goes blind to another location's events.
 * - An event with no id is never de-duplicated (a key built from type, time and entity could
 *   merge two distinct events), so it is delivered by every stream that carries it.
 *
 * The registry lives on globalThis because every plugin copy loads its own module instance.
 */
type EventStreamContext = {
  event: { subscribe(input: { types: readonly never[] }): Stream.Stream<unknown, unknown> }
}

export type NativeEventListener = {
  /** A subscription attached (also called again after every reattach). */
  attached?(): void
  event(event: unknown): void
  /** A subscription ended or failed: events of its location may have been missed. */
  gap?(reason?: "failed" | "ended"): void
}

type Member = {
  id: symbol
  /** The subscribing location, for the delivery diagnostics; the member's own id when unknown. */
  location: string
  ctx: EventStreamContext
  listener: NativeEventListener
  fiber?: { interruptUnsafe(): void }
}

type Seen = { locations: Set<string>; bytes: number }

/**
 * Recent event ids, for de-duplication across copies. A delivery skew between copies is the
 * time between the same event arriving on two streams: in one process that is the time one
 * copy's event loop takes to reach the next, seconds at worst (a copy that falls further behind
 * has its stream failed by the host as a slow consumer, "volatile by contract", event.js:51).
 * At a sustained 100 events per second, 60 s of ids is 6,000 entries.
 *
 * Measurement (`bun:jsc` heapStats after `Bun.gc(true)`, 200,000 entries of a 30-character id
 * with one location name): 418 bytes per entry for the Map slot, id, entry object and Set. Each
 * further location name adds one Set slot, taken as 64 bytes (an estimate, not measured). So
 * 4 MiB holds about 10,000 ids, 100 s at 100 events per second. Oldest ids are evicted; an insert
 * is never refused. An evicted id that arrives late is processed again, never lost.
 */
export const EVENT_ID_BUDGET_BYTES = 4 * 1024 * 1024
const ENTRY_BASE_BYTES = 418
const ENTRY_LOCATION_BYTES = 64

type Hub = {
  members: Map<symbol, Member>
  seen: Map<string, Seen>
  seenBytes: number
  maxBytes: number
  counts: {
    /** Subscriptions opened (attach events), across all copies. */
    opened: number
    /** First deliveries of an event id (fanned out). */
    firstSeen: number
    /** Later deliveries of an id already seen (dropped). */
    duplicates: number
    /** Deliveries of events that carry no id (never de-duplicated). */
    unidentified: number
    /** Among retained ids: how many distinct locations delivered it, by that number. */
    deliveredByLocations: Record<number, number>
  }
}

const hubsKey = Symbol.for("lazers.native-event-hubs.v2")
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

const eventID = (event: unknown) => {
  const id =
    typeof event === "object" && event !== null ? (event as { id?: unknown }).id : undefined
  return typeof id === "string" && id.length > 0 ? id : undefined
}

function deliver(hub: Hub, member: Member, event: unknown) {
  const id = eventID(event)
  if (id === undefined) {
    hub.counts.unidentified++
    each(hub, (listener) => listener.event(event))
    return
  }
  const known = hub.seen.get(id)
  if (known) {
    hub.counts.duplicates++
    if (!known.locations.has(member.location)) {
      const before = known.locations.size
      known.locations.add(member.location)
      known.bytes += ENTRY_LOCATION_BYTES
      hub.seenBytes += ENTRY_LOCATION_BYTES
      const histogram = hub.counts.deliveredByLocations
      histogram[before] = (histogram[before] ?? 1) - 1
      histogram[before + 1] = (histogram[before + 1] ?? 0) + 1
    }
    return
  }
  hub.counts.firstSeen++
  const bytes = ENTRY_BASE_BYTES
  hub.seen.set(id, { locations: new Set([member.location]), bytes })
  hub.seenBytes += bytes
  hub.counts.deliveredByLocations[1] = (hub.counts.deliveredByLocations[1] ?? 0) + 1
  while (hub.seenBytes > hub.maxBytes && hub.seen.size > 1) {
    const oldest = hub.seen.entries().next().value as [string, Seen]
    hub.seen.delete(oldest[0])
    hub.seenBytes -= oldest[1].bytes
    const k = oldest[1].locations.size
    hub.counts.deliveredByLocations[k] = (hub.counts.deliveredByLocations[k] ?? 1) - 1
  }
  each(hub, (listener) => listener.event(event))
}

function run(hub: Hub, member: Member, types: readonly string[]) {
  const loop = Effect.forever(
    Effect.sync(() => {
      hub.counts.opened++
      each(hub, (listener) => listener.attached?.())
    }).pipe(
      Effect.andThen(
        // Suspended so every reattach asks the host for a fresh stream instead of rerunning the
        // first stream value.
        Effect.suspend(() =>
          Stream.runForEach(member.ctx.event.subscribe({ types: types as never[] }), (event) =>
            Effect.sync(() => deliver(hub, member, event)),
          ),
        ),
      ),
      Effect.match({
        // This copy's stream is gone: whatever only it carried is missed.
        onFailure: () => each(hub, (listener) => listener.gap?.("failed")),
        onSuccess: () => each(hub, (listener) => listener.gap?.("ended")),
      }),
      Effect.andThen(Effect.sleep(1_000)),
    ),
  )
  member.fiber = Effect.runFork(Effect.sleep(0).pipe(Effect.andThen(loop)))
}

/**
 * Joins the process-wide fan-out for `types` with this copy's own subscription; the returned
 * function leaves it. `location` names the subscribing location for the delivery diagnostics.
 */
export function joinNativeEvents(
  ctx: EventStreamContext,
  types: readonly string[],
  listener: NativeEventListener,
  location?: string,
  options: { maxBytes?: number } = {},
): () => void {
  const key = [...types].sort().join("|")
  const all = hubs()
  let hub = all.get(key)
  if (!hub) {
    hub = {
      members: new Map(),
      seen: new Map(),
      seenBytes: 0,
      maxBytes: options.maxBytes ?? EVENT_ID_BUDGET_BYTES,
      counts: { opened: 0, firstSeen: 0, duplicates: 0, unidentified: 0, deliveredByLocations: {} },
    }
    all.set(key, hub)
  }
  const joined = hub
  const id = Symbol("native-event-listener")
  const member: Member = { id, location: location ?? id.toString(), ctx, listener }
  joined.members.set(id, member)
  run(joined, member, types)
  let left = false
  return () => {
    if (left) return
    left = true
    member.fiber?.interruptUnsafe()
    joined.members.delete(id)
    if (joined.members.size === 0 && all.get(key) === joined) all.delete(key)
  }
}

/** Per event-type set: listeners, subscriptions and delivery counters, for diagnostics and tests. */
export function nativeEventSubscriptions() {
  return [...hubs().entries()].map(([key, hub]) => ({
    types: key,
    listeners: hub.members.size,
    ...hub.counts,
    deliveredByLocations: { ...hub.counts.deliveredByLocations },
    retainedIDs: hub.seen.size,
    retainedBytes: hub.seenBytes,
  }))
}
