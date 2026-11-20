import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { openStream, type StreamPool } from "./client.ts"
import { defineSource } from "./source.ts"
import type { PoolStream, ReaderPool } from "./pool.ts"
import { SHARED_CONTROL_BYTES } from "./protocol.ts"
import { itemSource } from "./test-source.ts"
import { seedItems, testPool, type SeededDatabase } from "./test-harness.ts"

let seeded: SeededDatabase
let pool: ReaderPool
beforeAll(() => {
  seeded = seedItems(1_000)
  pool = testPool(seeded.path)
})
afterAll(async () => {
  await pool.close()
  seeded.close()
})

const ids = (stream: { items: readonly { id?: unknown }[] }) => stream.items.map((r) => r.id)
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)
const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return
    await Bun.sleep(10)
  }
  throw new Error("condition not reached")
}
const owner = () => {
  const runs: (() => void)[] = []
  return {
    onDispose: (run: () => void) => void runs.push(run),
    dispose: () => runs.forEach((r) => r()),
  }
}

for (const transport of ["shared", "transfer", "copy"] as const) {
  test(`${transport}: a stream opens, reads lazily, slides, seeks and closes`, async () => {
    const stream = openStream(pool, itemSource, {
      filter: {},
      order: "id",
      window: 50,
      transport,
    })
    await stream.ready()
    expect(ids(stream)).toEqual(range(1, 50))
    expect(stream.before).toBe(0)
    expect(stream.after).toBe(950)
    expect(stream.items[3]!.title).toBe("item 4 é")
    await stream.slide(25)
    expect(ids(stream)).toEqual(range(26, 75))
    expect(stream.before).toBe(25)
    await stream.seek({ key: [500] })
    expect(ids(stream)[25]).toBe(500)
    await stream.seek("tail")
    expect(ids(stream)).toEqual(range(951, 1_000))
    stream.close()
    stream.close()
    await expect(stream.slide(1)).rejects.toThrow(/closed/)
  })
}

test("slide issues exactly one message to the reader and `change` fires per frame", async () => {
  let posts = 0
  const counting: StreamPool = {
    attach(request, listener) {
      const inner: PoolStream = pool.attach(request, listener)
      return { ...inner, post: (command) => (posts++, inner.post(command)) }
    },
  }
  const stream = openStream(counting, itemSource, { filter: {}, order: "id", window: 50 })
  await stream.ready()
  let changes = 0
  stream.on("change", () => changes++)
  await stream.slide(10)
  expect(posts).toBe(1)
  expect(changes).toBeGreaterThanOrEqual(1)
  stream.close()
})

test("an unknown order fails ready()", async () => {
  const stream = openStream(pool, itemSource, { filter: {}, order: "nope", window: 5 })
  await expect(stream.ready()).rejects.toThrow(/no order/)
  stream.close()
})

test("anchored at head, an insert plus a revision produces change with the new row first", async () => {
  const live = seedItems(100)
  const livePool = testPool(live.path)
  try {
    const stream = openStream(livePool, itemSource, { filter: {}, order: "newest", window: 20 })
    await stream.ready()
    expect(stream.items[0]!.id).toBe(100)
    const changed = new Promise<void>((resolve) => stream.on("change", resolve))
    live.db.query("INSERT INTO items VALUES(500,'g0',5,1,'new','{}',0,'b')").run()
    livePool.revision(7)
    await changed
    expect(stream.items[0]!.id).toBe(500)
    expect(stream.revision).toBe(7)
    expect(stream.after).toBe(81)
    stream.close()
  } finally {
    await livePool.close()
    live.close()
  }
})

test("Review Focus 2: a 5 MiB row in a window of 1 arrives through regrow", async () => {
  const big = seedItems(3)
  const bigPool = testPool(big.path)
  try {
    const stream = openStream(bigPool, itemSource, {
      filter: {},
      order: "id",
      window: 1,
      transport: "shared",
    })
    await stream.ready()
    const text = "é".repeat(2.5 * 1024 * 1024)
    big.db.query("UPDATE items SET title = ? WHERE id = 1").run(text)
    const grown = new Promise<void>((resolve) => stream.on("change", resolve))
    bigPool.revision(1)
    await grown
    expect((stream.items[0]!.title as string).length).toBe(text.length)
    expect(stream.items[0]!.title === text).toBe(true)
    stream.close()
  } finally {
    await bigPool.close()
    big.close()
  }
})

test("Review Focus 4: a disposed owner closes the stream, returns its buffer, and close is idempotent", async () => {
  const scope = owner()
  const [before] = await pool.stats()
  const stream = openStream(
    pool,
    itemSource,
    { filter: {}, order: "id", window: 50, transport: "transfer" },
    scope,
  )
  await stream.ready()
  await stream.slide(5)
  const pooledBefore = (await pool.stats())[0]!.buffersPooled
  scope.dispose()
  stream.close()
  scope.dispose()
  await until(async () => (await pool.stats())[0]!.buffersPooled > pooledBefore)
  const [after] = await pool.stats()
  expect(after!.streams).toBe(before!.streams)
  await expect(stream.seek("head")).rejects.toThrow(/closed/)
})

test("Review Focus 1: while the reader flips 10,000 times every read is one complete window", async () => {
  const flipSource = defineSource({
    name: "test.flip",
    table: "t",
    key: ["n"],
    orders: { n: [{ column: "n", direction: "asc" }] },
    filter: () => ({ where: "", params: [] }),
    columns: { n: "int", t: "text" },
    count: "exact",
  })
  const rows = 40
  const frameBytes = 64 * 1024
  const shared = new SharedArrayBuffer(SHARED_CONTROL_BYTES + 2 * frameBytes)
  new Int32Array(shared, 0, 4)[3] = frameBytes
  let flipper: Worker | undefined
  const fake: StreamPool = {
    attach(_request, listener) {
      queueMicrotask(() => listener({ type: "opened", stream: 1, shared }))
      return { id: 1, post: () => 0, release: () => {}, close: () => {} }
    },
  }
  const stream = openStream(fake, flipSource, { filter: {}, order: "n", window: rows })
  let reads = 0
  let torn = 0
  let last = 0
  stream.on("change", () => {
    reads++
    const n = stream.items[0]!.n as number
    const text = `x${n}`.repeat(20)
    if (stream.items.length !== rows) torn++
    for (const row of stream.items) if (row.n !== n || row.t !== text) torn++
    last = n
  })
  const done = new Promise<void>((resolve, reject) => {
    flipper = new Worker(join(import.meta.dir, "test-flipper.ts"), {
      workerData: { buffer: shared, flips: 10_000, rows },
    })
    flipper.once("message", () => resolve())
    flipper.once("error", reject)
  })
  await done
  await until(() => last === 10_000)
  expect(torn).toBe(0)
  expect(reads).toBeGreaterThan(1)
  expect(stream.revision).toBe(10_000)
  stream.close()
  await flipper!.terminate()
}, 60_000)
