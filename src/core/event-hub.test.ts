import { expect, test } from "bun:test"
import { Effect, Queue, Stream } from "effect"
import { joinNativeEvents, nativeEventSubscriptions } from "./event-hub.ts"

const TYPES = ["session.idle", "session.status"]

/** A fake plugin copy: its own `ctx.event`, counting subscriptions and feeding one queue. */
function copy() {
  const queue = Effect.runSync(Queue.unbounded<unknown>())
  const state = { subscribes: 0 }
  return {
    state,
    emit: (event: unknown) => Effect.runPromise(Queue.offer(queue, event)),
    ctx: {
      event: {
        subscribe: () => {
          state.subscribes++
          return Stream.fromQueue(queue)
        },
      },
    },
  }
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

test("three plugin copies of one project share one host subscription and each hears every event once", async () => {
  const copies = [copy(), copy(), copy()]
  const heard = copies.map(() => [] as unknown[])
  const gaps = copies.map(() => 0)
  const leave = copies.map((c, index) =>
    joinNativeEvents(c.ctx as never, TYPES, {
      event: (event) => heard[index]!.push(event),
      gap: () => gaps[index]!++,
    }),
  )
  await tick()
  // Only the first copy's context subscribed.
  expect(copies.map((c) => c.state.subscribes)).toEqual([1, 0, 0])
  expect(nativeEventSubscriptions()).toEqual([
    { types: [...TYPES].sort().join("|"), listeners: 3, opened: 1 },
  ])
  await copies[0]!.emit({ type: "session.idle", id: 1 })
  await tick()
  expect(heard.map((events) => events.length)).toEqual([1, 1, 1])

  // The leader leaves: exactly one other copy takes the subscription over, and all are told.
  leave[0]!()
  await tick()
  expect(copies.map((c) => c.state.subscribes)).toEqual([1, 1, 0])
  expect(gaps[1]).toBe(1)
  await copies[1]!.emit({ type: "session.idle", id: 2 })
  await tick()
  expect(heard[1]!.length).toBe(2)
  expect(heard[2]!.length).toBe(2)
  expect(heard[0]!.length).toBe(1)

  leave[1]!()
  leave[2]!()
  expect(nativeEventSubscriptions()).toEqual([])
})
