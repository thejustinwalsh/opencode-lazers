import { Effect, Stream } from "effect"

/**
 * One process-wide fan-out of host events. Two modes:
 *
 * - every-copy (the default): every plugin copy holds its own host subscription. Nothing can be
 *   lost to a location-scoped stream, at the price of the host delivering each event once per
 *   copy. In this mode the hub records the evidence that would justify the pair mode, below.
 * - pair (opt in with LAZERS_NATIVE_EVENT_PAIR=1, or `setNativeEventHubDefaults({ pair: true })`):
 *   two live host subscriptions instead of one per copy, with a proven way back to every-copy.
 *
 * Evidence recorded in every-copy mode. For each first-seen event the hub compares the locations
 * that delivered it within the grace period with the locations subscribed for that whole period
 * (every subscription attached for at least the grace period before the event, and no attach,
 * drop, join or leave until the period ended). `fullyDelivered` counts events every subscribed
 * location delivered, `partiallyDelivered` events some did not, and `partialSamples` keeps a
 * byte-budgeted sample (oldest evicted) with type, delivering and subscribed locations. A pair is
 * safe only if `partiallyDelivered` stays 0 over a long session with many copies: an event that
 * reaches only locations outside a pair can never be seen by the pair, so the pair mode cannot
 * detect that loss itself. Both are reported by `nativeEventSubscriptions()`, which the heap
 * sampler records.
 *
 * The pair mode in detail:
 *
 * OpenCode loads one plugin copy per location. The server protocol says the event stream spans
 * "all server locations" and each event carries its own `location`
 * (node_modules/@opencode/protocol/dist/groups/event.js:51, :9, :16), but the plugin runtime
 * that backs `ctx.event.subscribe` is not readable here. Live evidence from one process (10
 * copies, about 300 events per type over 70 minutes): 87% of events arrived from all 10
 * subscribing locations and the rest from 2, none from only 1, none without an id. So the stream
 * is server-wide, and every copy that subscribes makes the host deliver each event once more.
 *
 * - Two subscriptions, from two different locations, are kept while at least two copies are
 *   joined (one when only one is). The other copies are standby members: they hear every event
 *   through the fan-out and subscribe only when promoted.
 * - Why two and not one: if a stream were scoped to its own location, a single subscription would
 *   silently hide every other location's events. With two, a scoped stream shows up as events
 *   seen by only one of the two. Two is the smallest number that can show it.
 * - Events are de-duplicated by their own id (`id: Event.ID`, event.js:7 for native events and
 *   :12 for plugin RPC events; one id names one event across every stream that carries it). The
 *   first delivery of an id fans out to every listener; later deliveries of it are dropped. An
 *   event with no id is never de-duplicated (a key built from type, time and entity could merge
 *   two distinct events), so it is delivered by every subscription that carries it.
 * - Safety check. An event is "single source" when, with both subscriptions attached and both
 *   attached for at least the grace period before the event, only one of the two delivered it
 *   within the grace period after it. One single-source event means a stream is not server-wide.
 *   `singleSourceEvents` counts them, the hub falls back to every copy subscribing, for the rest
 *   of the process (the decision outlives the hub, so a reload of copies does not retry it),
 *   signals a gap to every listener (`failed`, so each resynchronizes) and logs a warning.
 *   What is lost before the fallback: only in a scoped world, events of locations that have no
 *   subscription, from the moment the pair attached until the fallback (at most the grace period
 *   after the first event that only one of the two carried). The gap covers exactly that span.
 *   A scoped world in which neither subscribed location ever emits is not detectable and stays
 *   blind to the other locations; the evidence above says that world is not the one running.
 * - When a subscribed copy leaves, another copy is promoted at once, from a different location
 *   than the remaining subscriber when there is one. The remaining subscription covers the
 *   hand-over, so a server-wide stream loses nothing; a leave is not a gap.
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
  /** A subscription ended or failed, or the hub fell back: events may have been missed. */
  gap?(reason?: "failed" | "ended"): void
}

type Member = {
  id: symbol
  /** The subscribing location, for the delivery diagnostics; the member's own id when unknown. */
  location: string
  ctx: EventStreamContext
  listener: NativeEventListener
  fiber?: { interruptUnsafe(): void }
  /** When this member's live subscription attached; unset while it has none. */
  attachedAt?: number
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

/**
 * How long both subscriptions must have been attached before an event counts as evidence, and how
 * long the other subscription has to deliver it. It must exceed the worst delivery skew between
 * two streams of one process, which the id budget above puts at seconds (one copy's event loop
 * reaching the next, bounded by the host failing a slow consumer). 10 s is that bound with margin:
 * a false alarm costs only a return to one subscription per copy (today's behavior), while a long
 * period lengthens the span in which a scoped world would go unnoticed, so it is not longer.
 */
export const SINGLE_SOURCE_GRACE_MS = 10_000

/** Hub options applied to hubs created after this call; tests shorten the grace period. */
let defaults: { maxBytes?: number; graceMs?: number; pair?: boolean } = {}
export function setNativeEventHubDefaults(options: {
  maxBytes?: number
  graceMs?: number
  pair?: boolean
}) {
  const previous = defaults
  defaults = options
  return () => {
    defaults = previous
  }
}

/** Forget that these type sets fell back (tests only: the decision is permanent in a process). */
export function resetNativeEventFallback() {
  fellBack().clear()
}

/** Live subscriptions kept while at least two copies are joined. */
const SUBSCRIPTIONS = 2

/**
 * Partially delivered events kept as evidence: 64 KiB, about 300 samples at the roughly 200 bytes
 * of a type plus two location lists of ten copies. An estimate, not measured on live data; oldest
 * samples are evicted, the counter keeps the total.
 */
export const PARTIAL_SAMPLE_BUDGET_BYTES = 64 * 1024

export type PartialSample = {
  id: string
  type: string | undefined
  delivered: string[]
  subscribed: string[]
}

/** `subscribed` is set only for evidence in every-copy mode; the pair rule needs no snapshot. */
type Pending = {
  id: string
  at: number
  epoch: number
  type?: string
  subscribed?: string[]
}

type Hub = {
  key: string
  types: readonly string[]
  members: Map<symbol, Member>
  /** Members with a live subscription (at most SUBSCRIPTIONS until the fallback). */
  subscribed: Set<symbol>
  /** Fallen back: every member subscribes. Permanent for the process. */
  all: boolean
  /** Moves whenever a subscription attaches, drops, joins or leaves. */
  epoch: number
  /** Events first seen while the pair was eligible, awaiting the end of their grace period. */
  pending: Pending[]
  pendingHead: number
  timer?: ReturnType<typeof setTimeout>
  graceMs: number
  now: () => number
  seen: Map<string, Seen>
  seenBytes: number
  maxBytes: number
  partialSamples: PartialSample[]
  partialBytes: number
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
    /** Events only one of the two subscriptions delivered, both attached; evidence of scoping. */
    singleSourceEvents: number
    /** Times the hub fell back to every copy subscribing (0 or 1 per process and type set). */
    fallbacks: number
    /** Standby copies promoted to a subscription after a subscribed copy left. */
    promotions: number
    /** Every-copy evidence: events every subscribed location delivered within the grace period. */
    fullyDelivered: number
    /** Every-copy evidence: events some subscribed location did not deliver. Pair needs 0. */
    partiallyDelivered: number
  }
}

const hubsKey = Symbol.for("lazers.native-event-hubs.v3")
const fallbackKey = Symbol.for("lazers.native-event-fallback.v1")
const host = globalThis as typeof globalThis & {
  [hubsKey]?: Map<string, Hub>
  [fallbackKey]?: Set<string>
}
const hubs = () => (host[hubsKey] ??= new Map<string, Hub>())
/** Type sets that fell back; outlives the hub so the decision holds for the whole process. */
const fellBack = () => (host[fallbackKey] ??= new Set<string>())

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

/** Both subscriptions attached, from different locations, each for at least the grace period. */
function pairEligible(hub: Hub) {
  if (hub.all || hub.subscribed.size !== SUBSCRIPTIONS) return false
  const pair = [...hub.subscribed].map((id) => hub.members.get(id)!)
  if (pair.some((member) => member.attachedAt === undefined)) return false
  if (new Set(pair.map((member) => member.location)).size !== SUBSCRIPTIONS) return false
  const now = hub.now()
  return pair.every((member) => now - member.attachedAt! >= hub.graceMs)
}

/**
 * Every-copy evidence: at least two subscriptions, all attached for the grace period. Returns the
 * subscribed locations, or undefined when the event cannot count.
 */
function evidenceLocations(hub: Hub): string[] | undefined {
  if (!hub.all || hub.subscribed.size < SUBSCRIPTIONS) return undefined
  const members = [...hub.subscribed].map((id) => hub.members.get(id)!)
  const now = hub.now()
  if (members.some((m) => m.attachedAt === undefined || now - m.attachedAt < hub.graceMs))
    return undefined
  return [...new Set(members.map((m) => m.location))].toSorted()
}

function recordPartial(hub: Hub, sample: PartialSample) {
  const bytes = JSON.stringify(sample).length
  hub.partialSamples.push(sample)
  hub.partialBytes += bytes
  while (hub.partialBytes > PARTIAL_SAMPLE_BUDGET_BYTES && hub.partialSamples.length > 1) {
    hub.partialBytes -= JSON.stringify(hub.partialSamples.shift()).length
  }
}

function schedule(hub: Hub, ms: number) {
  if (hub.timer !== undefined) return
  hub.timer = setTimeout(() => sweep(hub), Math.max(1, ms))
  ;(hub.timer as { unref?: () => void }).unref?.()
}

/** Judge every pending event whose grace period has ended. */
function sweep(hub: Hub) {
  hub.timer = undefined
  const now = hub.now()
  while (hub.pendingHead < hub.pending.length) {
    const pending = hub.pending[hub.pendingHead]!
    if (pending.at + hub.graceMs > now) {
      schedule(hub, pending.at + hub.graceMs - now)
      break
    }
    hub.pendingHead++
    // The subscriptions changed since this event arrived: it proves nothing about any stream.
    if (pending.epoch !== hub.epoch) continue
    const known = hub.seen.get(pending.id)
    if (!known) continue
    if (pending.subscribed) {
      const delivered = pending.subscribed.filter((location) => known.locations.has(location))
      if (delivered.length === pending.subscribed.length) hub.counts.fullyDelivered++
      else {
        hub.counts.partiallyDelivered++
        recordPartial(hub, {
          id: pending.id,
          type: pending.type,
          delivered,
          subscribed: pending.subscribed,
        })
      }
      continue
    }
    if (hub.all || known.locations.size >= SUBSCRIPTIONS) continue
    hub.counts.singleSourceEvents++
    fallBack(hub)
    return
  }
  if (hub.pendingHead > 0 && hub.pendingHead === hub.pending.length) {
    hub.pending = []
    hub.pendingHead = 0
  }
}

function fallBack(hub: Hub) {
  if (hub.all) return
  hub.all = true
  hub.counts.fallbacks++
  fellBack().add(hub.key)
  hub.pending = []
  hub.pendingHead = 0
  if (hub.timer !== undefined) clearTimeout(hub.timer)
  hub.timer = undefined
  void Effect.runFork(
    Effect.logWarning(
      "LAZERS host event stream is scoped to a location: every plugin copy now subscribes",
      { types: hub.key, singleSourceEvents: hub.counts.singleSourceEvents },
    ),
  )
  // Events of locations without a subscription may have been missed until now.
  each(hub, (listener) => listener.gap?.("failed"))
  for (const member of hub.members.values())
    if (!hub.subscribed.has(member.id)) subscribe(hub, member)
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
  const subscribed = evidenceLocations(hub)
  if (subscribed || pairEligible(hub)) {
    const type = (event as { type?: unknown }).type
    hub.pending.push({
      id,
      at: hub.now(),
      epoch: hub.epoch,
      ...(subscribed ? { subscribed, type: typeof type === "string" ? type : undefined } : {}),
    })
    schedule(hub, hub.graceMs)
  }
  each(hub, (listener) => listener.event(event))
}

function run(hub: Hub, member: Member) {
  const loop = Effect.forever(
    Effect.sync(() => {
      hub.counts.opened++
      member.attachedAt = hub.now()
      hub.epoch++
      each(hub, (listener) => listener.attached?.())
    }).pipe(
      Effect.andThen(
        // Suspended so every reattach asks the host for a fresh stream instead of rerunning the
        // first stream value.
        Effect.suspend(() =>
          Stream.runForEach(member.ctx.event.subscribe({ types: hub.types as never[] }), (event) =>
            Effect.sync(() => deliver(hub, member, event)),
          ),
        ),
      ),
      Effect.match({
        // This copy's stream is gone: whatever only it carried is missed.
        onFailure: () => {
          member.attachedAt = undefined
          hub.epoch++
          each(hub, (listener) => listener.gap?.("failed"))
        },
        onSuccess: () => {
          member.attachedAt = undefined
          hub.epoch++
          each(hub, (listener) => listener.gap?.("ended"))
        },
      }),
      Effect.andThen(Effect.sleep(1_000)),
    ),
  )
  member.fiber = Effect.runFork(Effect.sleep(0).pipe(Effect.andThen(loop)))
}

function subscribe(hub: Hub, member: Member) {
  hub.subscribed.add(member.id)
  hub.epoch++
  run(hub, member)
}

/** Whether a copy that just joined, or is next in line, should hold a subscription. */
function wantsSubscription(hub: Hub, member: Member) {
  if (hub.all) return true
  if (hub.subscribed.size >= SUBSCRIPTIONS) return false
  if (hub.subscribed.size === 0) return true
  // The second subscription comes from a different location, or the pair proves nothing.
  return ![...hub.subscribed].some((id) => hub.members.get(id)!.location === member.location)
}

/** Fill the subscriptions a leave freed, at once; a standby copy's stream starts in this call. */
function promote(hub: Hub) {
  for (const member of hub.members.values()) {
    if (hub.subscribed.has(member.id) || !wantsSubscription(hub, member)) continue
    hub.counts.promotions++
    subscribe(hub, member)
  }
}

/**
 * Joins the process-wide fan-out for `types`; the returned function leaves it. The copy hears
 * every event whether or not it holds one of the live subscriptions. `location` names the
 * subscribing location for the delivery diagnostics and for choosing two different ones.
 * `options` apply to the first copy that creates the hub for these types.
 */
export function joinNativeEvents(
  ctx: EventStreamContext,
  types: readonly string[],
  listener: NativeEventListener,
  location?: string,
  options: { maxBytes?: number; graceMs?: number; now?: () => number; pair?: boolean } = {},
): () => void {
  const key = [...types].sort().join("|")
  const all = hubs()
  let hub = all.get(key)
  if (!hub) {
    hub = {
      key,
      types,
      members: new Map(),
      subscribed: new Set(),
      all:
        !(options.pair ?? defaults.pair ?? process.env.LAZERS_NATIVE_EVENT_PAIR === "1") ||
        fellBack().has(key),
      epoch: 0,
      pending: [],
      pendingHead: 0,
      graceMs: options.graceMs ?? defaults.graceMs ?? SINGLE_SOURCE_GRACE_MS,
      now: options.now ?? Date.now,
      seen: new Map(),
      seenBytes: 0,
      partialSamples: [],
      partialBytes: 0,
      maxBytes: options.maxBytes ?? defaults.maxBytes ?? EVENT_ID_BUDGET_BYTES,
      counts: {
        opened: 0,
        firstSeen: 0,
        duplicates: 0,
        unidentified: 0,
        deliveredByLocations: {},
        singleSourceEvents: 0,
        fallbacks: 0,
        promotions: 0,
        fullyDelivered: 0,
        partiallyDelivered: 0,
      },
    }
    all.set(key, hub)
  }
  const joined = hub
  const id = Symbol("native-event-listener")
  // A copy that cannot name its location is its own location: never grouped with another copy
  // (a random name, because every copy's module instance has its own counters).
  const member: Member = {
    id,
    location: location ?? `unnamed-${crypto.randomUUID()}`,
    ctx,
    listener,
  }
  joined.members.set(id, member)
  if (wantsSubscription(joined, member)) subscribe(joined, member)
  let left = false
  return () => {
    if (left) return
    left = true
    member.fiber?.interruptUnsafe()
    joined.members.delete(id)
    if (joined.subscribed.delete(id)) {
      joined.epoch++
      promote(joined)
    }
    if (joined.members.size === 0) {
      if (joined.timer !== undefined) clearTimeout(joined.timer)
      joined.timer = undefined
      if (all.get(key) === joined) all.delete(key)
    }
  }
}

/** Per event-type set: listeners, subscriptions and delivery counters, for diagnostics and tests. */
export function nativeEventSubscriptions() {
  return [...hubs().entries()].map(([key, hub]) => ({
    types: key,
    listeners: hub.members.size,
    subscriptions: hub.subscribed.size,
    mode: hub.all ? ("every-copy" as const) : ("two-locations" as const),
    ...hub.counts,
    deliveredByLocations: { ...hub.counts.deliveredByLocations },
    partialSamples: hub.partialSamples.map((sample) => ({ ...sample })),
    partialSampleBytes: hub.partialBytes,
    retainedIDs: hub.seen.size,
    retainedBytes: hub.seenBytes,
  }))
}
