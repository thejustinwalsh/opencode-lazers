import { afterEach, beforeEach, expect, test } from "bun:test"
import { Cause, Effect, Queue, Stream } from "effect"
import {
  joinNativeEvents,
  nativeEventSubscriptions,
  resetNativeEventFallback,
  setNativeEventHubDefaults,
} from "./event-hub.ts"

const GRACE = 60
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

let restore = () => {}
beforeEach(() => {
  resetNativeEventFallback()
  restore = setNativeEventHubDefaults({ graceMs: GRACE, pair: true })
})
afterEach(() => restore())

let sequence = 0
/**
 * `count` fake plugin copies, one per location, each with its own host subscription. A stream
 * is created when the hub subscribes and carries events emitted from then on: a copy that never
 * subscribed hears nothing from the host, as in the real server. `scoped` models a stream that
 * carries only its own location's events; otherwise every live stream carries every event.
 */
function world(count: number, scoped: boolean) {
  const types = [`hub.test.${++sequence}`]
  const key = types[0]!
  const copies = Array.from({ length: count }, (_, index) => {
    const state = {
      directory: `/loc-${index}`,
      subscribes: 0,
      queue: undefined as Queue.Queue<unknown, Cause.Done> | undefined,
    }
    return {
      state,
      ctx: {
        event: {
          subscribe: () => {
            state.subscribes++
            state.queue = Effect.runSync(Queue.unbounded<unknown, Cause.Done>())
            return Stream.fromQueue(state.queue)
          },
        },
      },
    }
  })
  const emit = async (event: { id?: string; type?: string; location: string }) => {
    for (const copy of copies)
      if (copy.state.queue && (!scoped || copy.state.directory === event.location))
        await Effect.runPromise(Queue.offer(copy.state.queue, event))
  }
  const heard = copies.map(() => [] as unknown[])
  const gaps = copies.map(() => 0)
  const leave = copies.map((copy, index) =>
    joinNativeEvents(
      copy.ctx as never,
      types,
      {
        event: (event) => heard[index]!.push(event),
        gap: () => gaps[index]!++,
      },
      copy.state.directory,
    ),
  )
  const stats = () => nativeEventSubscriptions().find((hub) => hub.types === key)!
  const subscribes = () => copies.map((copy) => copy.state.subscribes)
  const leaveAll = () => leave.forEach((fn) => fn())
  return { copies, emit, heard, gaps, leave, stats, subscribes, leaveAll, key }
}

const ids = (events: unknown[]) => events.map((event) => (event as { id: string }).id)

test("pair mode is selected by the setting: every test below this line runs it", () => {
  expect(world(2, false).stats().mode).toBe("two-locations")
})

test("server-wide stream, three copies: two subscriptions, each listener hears each event once", async () => {
  const w = world(3, false)
  await tick()
  // The two subscribed copies are different locations; the third stands by.
  expect(w.subscribes()).toEqual([1, 1, 0])
  expect(w.stats()).toMatchObject({ listeners: 3, subscriptions: 2, mode: "two-locations" })
  await w.emit({ id: "evt_1", location: "/loc-0" })
  await w.emit({ id: "evt_2", location: "/loc-1" })
  await tick()
  for (const heard of w.heard) expect(ids(heard)).toEqual(["evt_1", "evt_2"])
  // Each event arrived twice (one per subscription): once fanned out, once dropped.
  expect(w.stats()).toMatchObject({
    opened: 2,
    firstSeen: 2,
    duplicates: 2,
    singleSourceEvents: 0,
    fallbacks: 0,
  })
  expect(w.stats().deliveredByLocations).toMatchObject({ 2: 2 })
  expect(w.gaps).toEqual([0, 0, 0])
  w.leaveAll()
  expect(nativeEventSubscriptions().find((hub) => hub.types === w.key)).toBeUndefined()
})

test("server-wide stream, ten copies: still two subscriptions, each of ten listeners hears each event once", async () => {
  const w = world(10, false)
  await tick()
  expect(w.subscribes().reduce((sum, count) => sum + count, 0)).toBe(2)
  expect(w.stats()).toMatchObject({ listeners: 10, subscriptions: 2 })
  for (let index = 0; index < 20; index++)
    await w.emit({ id: `evt_${index}`, location: `/loc-${index % 10}` })
  await tick()
  const expected = Array.from({ length: 20 }, (_, index) => `evt_${index}`)
  for (const heard of w.heard) expect(ids(heard)).toEqual(expected)
  // 20 events x 2 subscriptions = 40 host deliveries (it was 200 with a subscription per copy).
  expect(w.stats()).toMatchObject({ firstSeen: 20, duplicates: 20 })
  w.leaveAll()
})

test("location-scoped stream, three copies: the single-source event triggers the fallback; nothing after it is lost", async () => {
  const w = world(3, true)
  // The pair must have been attached for the grace period before an event is evidence.
  await tick(GRACE + 40)
  expect(w.stats().subscriptions).toBe(2)
  await w.emit({ id: "evt_a", location: "/loc-0" })
  // Before the fallback an unsubscribed location's event is lost: nothing carries it.
  await w.emit({ id: "evt_c_lost", location: "/loc-2" })
  await tick(GRACE + 80)
  const afterFallback = w.stats()
  expect(afterFallback).toMatchObject({
    singleSourceEvents: 1,
    fallbacks: 1,
    subscriptions: 3,
    mode: "every-copy",
  })
  // The gap told every listener that events may have been missed, so each resynchronizes.
  expect(w.gaps).toEqual([1, 1, 1])
  for (const heard of w.heard) expect(ids(heard)).toEqual(["evt_a"])
  expect(w.subscribes()).toEqual([1, 1, 1])
  // After the fallback every location's events reach every listener.
  await w.emit({ id: "evt_b", location: "/loc-1" })
  await w.emit({ id: "evt_c", location: "/loc-2" })
  await tick()
  for (const heard of w.heard) expect(ids(heard).sort()).toEqual(["evt_a", "evt_b", "evt_c"])
  expect(w.stats().deliveredByLocations).toMatchObject({ 1: 3 })
  w.leaveAll()
})

test("location-scoped stream, ten copies: every copy subscribes after the fallback and all ten hear all ten locations", async () => {
  const w = world(10, true)
  await tick(GRACE + 40)
  await w.emit({ id: "evt_first", location: "/loc-0" })
  await tick(GRACE + 80)
  expect(w.stats()).toMatchObject({ fallbacks: 1, subscriptions: 10, mode: "every-copy" })
  for (let index = 0; index < 10; index++)
    await w.emit({ id: `evt_loc_${index}`, location: `/loc-${index}` })
  await tick()
  const expected = [
    "evt_first",
    ...Array.from({ length: 10 }, (_, index) => `evt_loc_${index}`),
  ].sort()
  for (const heard of w.heard) expect(ids(heard).sort()).toEqual(expected)
  w.leaveAll()
})

test("the fallback is permanent for the process: a hub rebuilt after every copy left starts with every copy subscribing", async () => {
  const w = world(3, true)
  await tick(GRACE + 40)
  await w.emit({ id: "evt_a", location: "/loc-0" })
  await tick(GRACE + 80)
  expect(w.stats().fallbacks).toBe(1)
  w.leaveAll()
  expect(nativeEventSubscriptions().find((hub) => hub.types === w.key)).toBeUndefined()
  // Same type set, new copies.
  const queues: Queue.Queue<unknown, Cause.Done>[] = []
  const leaves = [0, 1, 2].map((index) =>
    joinNativeEvents(
      {
        event: {
          subscribe: () => {
            const queue = Effect.runSync(Queue.unbounded<unknown, Cause.Done>())
            queues.push(queue)
            return Stream.fromQueue(queue)
          },
        },
      } as never,
      [w.key],
      { event: () => {} },
      `/again-${index}`,
    ),
  )
  await tick()
  expect(queues.length).toBe(3)
  leaves.forEach((leave) => leave())
})

test("a stream that lags within the grace period is not evidence of scoping", async () => {
  const w = world(3, false)
  await tick(GRACE + 40)
  // Deliver to the first stream, then to the second inside the grace period.
  await Effect.runPromise(
    Queue.offer(w.copies[0]!.state.queue!, { id: "evt_slow", location: "/loc-0" }),
  )
  await tick(GRACE / 4)
  await Effect.runPromise(
    Queue.offer(w.copies[1]!.state.queue!, { id: "evt_slow", location: "/loc-0" }),
  )
  await tick(GRACE + 80)
  expect(w.stats()).toMatchObject({ singleSourceEvents: 0, fallbacks: 0, subscriptions: 2 })
  for (const heard of w.heard) expect(ids(heard)).toEqual(["evt_slow"])
  w.leaveAll()
})

test("a subscribed copy leaving promotes another at once and loses no event (three and ten copies)", async () => {
  for (const count of [3, 10]) {
    const w = world(count, false)
    await tick()
    expect(w.subscribes().slice(0, 2)).toEqual([1, 1])
    w.leave[0]!()
    // Promotion is part of the leave: the freed subscription is taken in the same call.
    expect(w.stats()).toMatchObject({ subscriptions: 2, promotions: 1 })
    await w.emit({ id: "evt_during", location: "/loc-1" })
    await tick()
    expect(w.subscribes()[2]).toBe(1)
    await w.emit({ id: "evt_after", location: "/loc-1" })
    await tick()
    for (const [index, heard] of w.heard.entries()) {
      if (index === 0) expect(heard.length).toBe(0)
      else expect(ids(heard)).toEqual(["evt_during", "evt_after"])
    }
    // A leave is not a gap, and the surviving subscription covered the hand-over.
    expect(w.gaps).toEqual(Array(count).fill(0))
    // The other subscribed copy leaves too: a second promotion, still nothing lost.
    w.leave[1]!()
    await w.emit({ id: "evt_last", location: "/loc-2" })
    await tick()
    // Three copies: one is left, which takes the only subscription. Ten: the pair is full again.
    expect(w.stats()).toMatchObject({
      subscriptions: Math.min(2, count - 2),
      promotions: count > 3 ? 2 : 1,
    })
    for (const heard of w.heard.slice(2))
      expect(ids(heard)).toEqual(["evt_during", "evt_after", "evt_last"])
    w.leaveAll()
  }
})

test("a standby copy leaving changes nothing; one remaining copy holds the only subscription", async () => {
  const w = world(3, false)
  await tick()
  w.leave[2]!()
  expect(w.stats()).toMatchObject({ subscriptions: 2, promotions: 0 })
  w.leave[0]!()
  await tick()
  expect(w.stats()).toMatchObject({ subscriptions: 1, listeners: 1 })
  await w.emit({ id: "evt_solo", location: "/loc-1" })
  await tick()
  expect(ids(w.heard[1]!)).toEqual(["evt_solo"])
  w.leaveAll()
})

test("a subscribed copy whose stream ends signals a gap, and an event without an id is never merged", async () => {
  const w = world(3, false)
  await tick()
  await Effect.runPromise(Queue.end(w.copies[0]!.state.queue!))
  await tick()
  expect(w.gaps.every((count) => count >= 1)).toBe(true)
  // No id: the one stream still carrying it delivers it; nothing is dropped as a duplicate.
  await w.emit({ location: "/loc-1" })
  await tick()
  expect(w.heard[1]!.length).toBe(1)
  expect(w.stats().unidentified).toBe(1)
  w.leaveAll()
})

test("the recent-id set is bounded by its byte budget and evicts oldest first", async () => {
  const heard: unknown[] = []
  const queue = Effect.runSync(Queue.unbounded<unknown>())
  const leave = joinNativeEvents(
    { event: { subscribe: () => Stream.fromQueue(queue) } } as never,
    ["budget.test"],
    { event: (event) => heard.push(event) },
    "/solo",
    { maxBytes: 418 * 3 },
  )
  await tick()
  for (let index = 0; index < 10; index++)
    await Effect.runPromise(Queue.offer(queue, { id: `evt_${index}`, location: "/solo" }))
  await tick()
  expect(heard.length).toBe(10)
  const stats = nativeEventSubscriptions().find((hub) => hub.types === "budget.test")!
  expect(stats.retainedIDs).toBeLessThanOrEqual(3)
  expect(stats.retainedBytes).toBeLessThanOrEqual(418 * 3)
  // An evicted id that comes back is processed again, never refused.
  await Effect.runPromise(Queue.offer(queue, { id: "evt_0", location: "/solo" }))
  await tick()
  expect(heard.length).toBe(11)
  leave()
})

test("a reattach asks the host for a fresh stream and the gap names its cause", async () => {
  const queue = Effect.runSync(Queue.unbounded<unknown>())
  let subscribes = 0
  const gaps: (string | undefined)[] = []
  const leave = joinNativeEvents(
    {
      event: {
        subscribe: () => {
          subscribes++
          return Stream.fromQueue(queue).pipe(
            Stream.mapEffect((event) =>
              event === "boom" ? Effect.fail(new Error("lost")) : Effect.succeed(event),
            ),
          )
        },
      },
    } as never,
    ["reattach.test"],
    { event: () => {}, gap: (reason) => gaps.push(reason) },
    "/solo",
  )
  await tick()
  expect(subscribes).toBe(1)
  await Effect.runPromise(Queue.offer(queue, "boom"))
  await tick(1_300)
  expect(gaps).toEqual(["failed"])
  expect(subscribes).toBe(2)
  leave()
})

/** The default: no pair setting, so every copy subscribes. */
function defaultWorld(count: number, scoped: boolean) {
  restore()
  restore = setNativeEventHubDefaults({ graceMs: GRACE })
  return world(count, scoped)
}

test("every-copy is the default: every copy subscribes and each listener hears each event once", async () => {
  for (const count of [3, 10]) {
    const w = defaultWorld(count, false)
    await tick(GRACE + 40)
    expect(w.subscribes()).toEqual(Array(count).fill(1))
    expect(w.stats()).toMatchObject({ mode: "every-copy", subscriptions: count })
    for (let index = 0; index < 5; index++)
      await w.emit({ id: `evt_${index}`, type: "session.idle", location: `/loc-${index}` })
    await tick(GRACE + 80)
    const expected = Array.from({ length: 5 }, (_, index) => `evt_${index}`)
    for (const heard of w.heard) expect(ids(heard)).toEqual(expected)
    // Every subscribed location delivered every event: the evidence a pair would be safe.
    expect(w.stats()).toMatchObject({
      fullyDelivered: 5,
      partiallyDelivered: 0,
      singleSourceEvents: 0,
      fallbacks: 0,
    })
    expect(w.stats().partialSamples).toEqual([])
    w.leaveAll()
  }
})

test("every-copy default loses nothing on a location-scoped stream, and counts and samples the partial deliveries", async () => {
  const w = defaultWorld(3, true)
  await tick(GRACE + 40)
  await w.emit({ id: "evt_a", type: "session.idle", location: "/loc-0" })
  await w.emit({ id: "evt_b", type: "session.status", location: "/loc-1" })
  await w.emit({ id: "evt_c", type: "session.idle", location: "/loc-2" })
  await tick(GRACE + 80)
  for (const heard of w.heard) expect(ids(heard).sort()).toEqual(["evt_a", "evt_b", "evt_c"])
  const stats = w.stats()
  expect(stats).toMatchObject({ fullyDelivered: 0, partiallyDelivered: 3, fallbacks: 0 })
  expect(stats.partialSamples).toHaveLength(3)
  expect(stats.partialSamples[0]).toEqual({
    id: "evt_a",
    type: "session.idle",
    delivered: ["/loc-0"],
    subscribed: ["/loc-0", "/loc-1", "/loc-2"],
  })
  expect(stats.partialSampleBytes).toBeGreaterThan(0)
  w.leaveAll()
})

test("an event inside a membership change is not evidence; the sample is byte-budgeted", async () => {
  const w = defaultWorld(3, true)
  await tick(GRACE + 40)
  await w.emit({ id: "evt_x", type: "t", location: "/loc-0" })
  // A copy leaves during the grace period: the subscribed set was not stable, so no verdict.
  w.leave[2]!()
  await tick(GRACE + 80)
  expect(w.stats()).toMatchObject({ fullyDelivered: 0, partiallyDelivered: 0 })
  w.leaveAll()

  const big = defaultWorld(3, true)
  await tick(GRACE + 40)
  for (let index = 0; index < 1_500; index++)
    await big.emit({ id: `evt_${index}`, type: "x".repeat(100), location: "/loc-0" })
  await tick(GRACE + 200)
  const stats = big.stats()
  expect(stats.partiallyDelivered).toBe(1_500)
  expect(stats.partialSampleBytes).toBeLessThanOrEqual(64 * 1024)
  expect(stats.partialSamples.length).toBeLessThan(1_500)
  // Oldest evicted: the newest sample is the last event.
  expect(stats.partialSamples.at(-1)!.id).toBe("evt_1499")
  big.leaveAll()
})
