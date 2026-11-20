import { afterAll, beforeAll, expect, test } from "bun:test"
import { Effect, Scope } from "effect"
import { readFrame } from "./frame.ts"
import { base64ToBytes } from "./gui.ts"
import { createStreamsService, registerStreams, UnknownStreamError } from "./rpc.ts"
import { Streams } from "./contract.ts"
import { itemColumns } from "./test-source.ts"
import { seedItems, testPool, type SeededDatabase } from "./test-harness.ts"
import type { ReaderPool } from "./pool.ts"

let seeded: SeededDatabase
let pool: ReaderPool
beforeAll(() => {
  seeded = seedItems(400)
  pool = testPool(seeded.path)
})
afterAll(async () => {
  await pool.close()
  seeded.close()
})

const decode = (frame: { data: string }) => {
  const bytes = base64ToBytes(frame.data)
  const read = readFrame(bytes.buffer, bytes.byteOffset, itemColumns)
  return {
    header: read.header,
    ids: Array.from({ length: read.header.count }, (_, i) => read.row(i).id as number),
  }
}
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)
const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await condition()) return
    await Bun.sleep(10)
  }
  throw new Error("condition not reached")
}
const open = { source: "test.items", filter: {}, order: "id", window: 50 }

test("a handler round trip against a seeded database: open, slide, seek, read, close", async () => {
  const events: [string, number][] = []
  const service = createStreamsService({ pool, changed: (s, n) => events.push([s, n]) })
  const first = await service.open({ stream: "a", ...open })
  expect(decode(first).ids).toEqual(range(1, 50))
  expect(decode(first).header.after).toBe(350)
  const slid = await service.slide({ stream: "a", delta: 25 })
  expect(decode(slid).ids).toEqual(range(26, 75))
  expect(slid.seq).toBeGreaterThan(first.seq)
  expect(decode(await service.seek({ stream: "a", anchor: { key: [300] } })).ids).toContain(300)
  expect(decode(service.read({ stream: "a" })).ids).toContain(300)
  expect(service.touch({ stream: "a" })).toEqual({ alive: true })
  expect(service.close({ stream: "a" })).toEqual({ closed: true })
  expect(service.close({ stream: "a" })).toEqual({ closed: false })
  expect(service.touch({ stream: "a" })).toEqual({ alive: false })
  expect(() => service.read({ stream: "a" })).toThrow(UnknownStreamError)
  // Every frame above came back in a response, so none was pushed.
  expect(events).toEqual([])
})

test("a frame no response carried is announced by a changed event, and read returns it", async () => {
  const live = seedItems(50)
  const livePool = testPool(live.path)
  const events: [string, number][] = []
  const service = createStreamsService({ pool: livePool, changed: (s, n) => events.push([s, n]) })
  try {
    const first = await service.open({ stream: "n", ...open, order: "newest", window: 10 })
    expect(decode(first).ids[0]).toBe(50)
    live.db.query("INSERT INTO items VALUES(900,'g0',1,1,'t','{}',0,'b')").run()
    livePool.revision(1)
    await until(() => events.length > 0)
    expect(events).toEqual([["n", first.seq + 1]])
    expect(decode(service.read({ stream: "n" })).ids[0]).toBe(900)
  } finally {
    service.dispose()
    await livePool.close()
    live.close()
  }
})

test("a dropped window is closed when its lease lapses and its reader stream is freed", async () => {
  const service = createStreamsService({ pool, changed: () => {}, leaseMs: 60 })
  const baseline = (await pool.stats())[0]!.streams
  await service.open({ stream: "lost", ...open })
  expect((await pool.stats())[0]!.streams).toBe(baseline + 1)
  await until(async () => service.size === 0)
  await until(async () => (await pool.stats())[0]!.streams === baseline)
  await expect(service.slide({ stream: "lost", delta: 1 })).rejects.toThrow(UnknownStreamError)
  // A window that keeps touching keeps its stream.
  await service.open({ stream: "kept", ...open })
  for (let i = 0; i < 6; i++) {
    await Bun.sleep(25)
    service.touch({ stream: "kept" })
  }
  expect(service.size).toBe(1)
  service.dispose()
  expect(service.size).toBe(0)
})

test("an unknown source or order fails the open and leaves nothing behind", async () => {
  const service = createStreamsService({ pool, changed: () => {} })
  await expect(service.open({ stream: "x", ...open, source: "nope" })).rejects.toThrow(
    /Unknown source/,
  )
  await expect(service.open({ stream: "y", ...open, order: "nope" })).rejects.toThrow(/no order/)
  expect(service.size).toBe(0)
})

test("registration wires the handlers, pushes events, and releases the pool with its scope", async () => {
  const handlers: Record<string, (input: never, context: never) => Effect.Effect<unknown>> = {}
  const emitted: unknown[] = []
  const ctx = {
    rpc: {
      register: (definition: { id: string }, given: typeof handlers) => {
        expect(definition.id).toBe(Streams.id)
        Object.assign(handlers, given)
        return Effect.succeed({
          events: {
            emit: (name: string, data: unknown) =>
              Effect.sync(() => void emitted.push([name, data])),
          },
        })
      },
    },
  }
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(
    registerStreams(ctx as never, { databasePath: seeded.path, pool }).pipe(Scope.provide(scope)),
  )
  const call = (name: string, input: unknown) =>
    Effect.runPromise(
      handlers[name]!(input as never, { error: (type: string) => ({ type }) } as never),
    )
  const opened = (await call("open", { stream: "r", ...open })) as { data: string }
  expect(decode(opened).ids).toEqual(range(1, 50))
  await expect(call("slide", { stream: "ghost", delta: 1 })).rejects.toMatchObject({
    type: "unknown_stream",
  })
  expect(await call("close", { stream: "r" })).toEqual({ closed: true })
  await Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined } as never))
})

test("a source that authorizes an open can refuse it or narrow its filter, on the main thread", async () => {
  const asked: string[] = []
  const context = {
    projectID: "p",
    projectDirectory: "/p",
    projectIds: (id: string) => [id],
    assertRead: async (sessionID: string) => {
      asked.push(sessionID)
      if (sessionID === "denied") throw new Error("Not permitted")
    },
  }
  const service = createStreamsService({ pool, changed: () => {}, context })
  const guarded = { ...open, source: "test.items.guarded" }
  // Narrowed: the caller asked for group g2 and g1 is what it gets.
  const narrowed = await service.open({ stream: "n", ...guarded, filter: { group: "g2" } })
  expect(decode(narrowed).ids.every((id) => id % 3 === 1)).toBe(true)
  // The caller's own claim never decides: the permission check saw it first.
  await expect(
    service.open({ stream: "d", ...guarded, filter: { group: "denied" } }),
  ).rejects.toThrow("Not permitted")
  await expect(service.open({ stream: "r", ...guarded, filter: { group: "g0" } })).rejects.toThrow(
    "not readable",
  )
  expect(service.size).toBe(1)
  expect(asked).toEqual(["g2", "denied", "g0"])
  // A service with no context refuses a source that needs one; a source without a hook is unaffected.
  const bare = createStreamsService({ pool, changed: () => {} })
  await expect(bare.open({ stream: "b", ...guarded, filter: {} })).rejects.toThrow(
    "cannot authorize",
  )
  expect(decode(await bare.open({ stream: "c", ...open })).ids).toEqual(range(1, 50))
  service.dispose()
  bare.dispose()
})
