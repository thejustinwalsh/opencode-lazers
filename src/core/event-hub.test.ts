import { expect, test } from "bun:test"
import { Cause, Effect, Queue, Stream } from "effect"
import { joinNativeEvents, nativeEventSubscriptions } from "./event-hub.ts"

const TYPES = ["session.idle", "session.status"]
const KEY = [...TYPES].sort().join("|")
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Three fake plugin copies, one per location. `scoped` models a stream that carries only its own
 * location's events; otherwise every copy's stream carries every event, as the server protocol
 * describes. Each copy subscribes for itself.
 */
function world(scoped: boolean) {
  const copies = ["/a", "/b", "/c"].map((directory) => {
    const queue = Effect.runSync(Queue.unbounded<unknown, Cause.Done>())
    const state = { subscribes: 0 }
    return {
      directory,
      queue,
      state,
      ctx: {
        event: {
          subscribe: () => {
            state.subscribes++
            return Stream.fromQueue(queue)
          },
        },
      },
    }
  })
  const emit = async (event: { id?: string; location: string }) => {
    for (const copy of copies)
      if (!scoped || copy.directory === event.location)
        await Effect.runPromise(Queue.offer(copy.queue, event))
  }
  const heard = copies.map(() => [] as unknown[])
  const gaps = copies.map(() => 0)
  const leave = copies.map((copy, index) =>
    joinNativeEvents(
      copy.ctx as never,
      TYPES,
      {
        event: (event) => heard[index]!.push(event),
        gap: () => gaps[index]!++,
      },
      copy.directory,
    ),
  )
  return { copies, emit, heard, gaps, leave }
}

const ids = (events: unknown[]) => events.map((event) => (event as { id: string }).id)

test("server-wide streams: every copy subscribes, each listener hears each event exactly once", async () => {
  const w = world(false)
  await tick()
  expect(w.copies.map((copy) => copy.state.subscribes)).toEqual([1, 1, 1])
  await w.emit({ id: "evt_1", location: "/a" })
  await w.emit({ id: "evt_2", location: "/b" })
  await tick()
  expect(w.heard.map(ids)).toEqual([
    ["evt_1", "evt_2"],
    ["evt_1", "evt_2"],
    ["evt_1", "evt_2"],
  ])
  const stats = nativeEventSubscriptions().find((hub) => hub.types === KEY)!
  // Each event was first seen once and delivered twice more as a duplicate, by all 3 locations.
  expect(stats).toMatchObject({ listeners: 3, opened: 3, firstSeen: 2, duplicates: 4 })
  expect(stats.deliveredByLocations).toMatchObject({ 3: 2 })
  w.leave.forEach((leave) => leave())
  expect(nativeEventSubscriptions().find((hub) => hub.types === KEY)).toBeUndefined()
})

test("location-scoped streams: every listener still hears every location's events, none lost", async () => {
  const w = world(true)
  await tick()
  await w.emit({ id: "evt_a", location: "/a" })
  await w.emit({ id: "evt_b", location: "/b" })
  await w.emit({ id: "evt_c", location: "/c" })
  await tick()
  for (const events of w.heard) expect(ids(events).sort()).toEqual(["evt_a", "evt_b", "evt_c"])
  const stats = nativeEventSubscriptions().find((hub) => hub.types === KEY)!
  // Each event arrived from one location only: the live evidence that streams are scoped.
  expect(stats).toMatchObject({ firstSeen: 3, duplicates: 0 })
  expect(stats.deliveredByLocations).toMatchObject({ 1: 3 })
  w.leave.forEach((leave) => leave())
})

test("a copy leaving does not drop events the others still deliver", async () => {
  for (const scoped of [false, true]) {
    const w = world(scoped)
    await tick()
    w.leave[0]!()
    await w.emit({ id: "evt_after_a", location: "/b" })
    await w.emit({ id: "evt_after_c", location: "/c" })
    await tick()
    expect(ids(w.heard[1]!).sort()).toEqual(["evt_after_a", "evt_after_c"])
    expect(ids(w.heard[2]!).sort()).toEqual(["evt_after_a", "evt_after_c"])
    // The leaver hears nothing more, and a leave is not a gap for the rest.
    expect(w.heard[0]!.length).toBe(0)
    expect(w.gaps).toEqual([0, 0, 0])
    w.leave[1]!()
    w.leave[2]!()
  }
})

test("a copy whose stream ends signals a gap, and an event without an id is never merged", async () => {
  const w = world(false)
  await tick()
  await Effect.runPromise(Queue.end(w.copies[0]!.queue))
  await tick()
  expect(w.gaps.every((count) => count >= 1)).toBe(true)
  // No id: the two streams that still carry it each deliver it; nothing is dropped as a duplicate.
  await w.emit({ location: "/b" })
  await tick()
  expect(w.heard[1]!.length).toBe(2)
  expect(nativeEventSubscriptions().find((hub) => hub.types === KEY)!.unidentified).toBe(2)
  w.leave.forEach((leave) => leave())
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
