import { afterAll, beforeAll, expect, test } from "bun:test"
import { readerPool, type ReaderPool } from "./pool.ts"
import type { Tier } from "./protocol.ts"
import { itemSource, itemsMoreSource } from "./test-source.ts"
import { openHarness, seedItems, testPool, type SeededDatabase } from "./test-harness.ts"

let seeded: SeededDatabase
let pool: ReaderPool

beforeAll(() => {
  seeded = seedItems(10_000)
  pool = testPool(seeded.path)
})
afterAll(async () => {
  await pool.close()
  seeded.close()
})

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)
const totals = async () => {
  const [stats] = await pool.stats()
  return stats!
}

test("open at head returns the first window with exact before and after", async () => {
  const h = openHarness(pool, itemSource, { filter: {}, order: "id", anchor: "head", window: 100 })
  const frame = await h.next()
  expect(frame.ids).toEqual(range(1, 100))
  expect(frame.header.before).toBe(0)
  expect(frame.header.after).toBe(9_900)
  h.stream.close()
})

test("open at tail returns the last window in order", async () => {
  const h = openHarness(pool, itemSource, { filter: {}, order: "id", anchor: "tail", window: 100 })
  const frame = await h.next()
  expect(frame.ids).toEqual(range(9_901, 10_000))
  expect(frame.header.before).toBe(9_900)
  expect(frame.header.after).toBe(0)
  h.stream.close()
})

test("slide(+25) reads 25 rows from the leading edge and keeps the rest", async () => {
  const h = openHarness(pool, itemSource, { filter: {}, order: "id", anchor: "head", window: 100 })
  await h.next()
  const before = await totals()
  const frame = await h.slide(25)
  const after = await totals()
  expect(frame.ids).toEqual(range(26, 125))
  expect(frame.header.before).toBe(25)
  expect(frame.header.after).toBe(9_875)
  expect(after.statements - before.statements).toBe(1)
  expect(after.rowsRead - before.rowsRead).toBe(25)
  const back = await h.slide(-10)
  expect(back.ids).toEqual(range(16, 115))
  expect(back.header.before).toBe(15)
  expect(back.header.after).toBe(9_885)
  h.stream.close()
})

test("a slide larger than the window skips rows and a slide past the end lands on the tail", async () => {
  const h = openHarness(pool, itemSource, { filter: {}, order: "id", anchor: "head", window: 10 })
  await h.next()
  expect((await h.slide(35)).ids).toEqual(range(36, 45))
  const far = await h.slide(1_000_000)
  expect(far.ids).toEqual(range(9_991, 10_000))
  expect(far.header.after).toBe(0)
  expect((await h.slide(-1_000_000)).ids).toEqual(range(1, 10))
  h.stream.close()
})

test("seek(key) centres the window on the key and clamps at both ends", async () => {
  const h = openHarness(pool, itemSource, { filter: {}, order: "id", anchor: "head", window: 100 })
  await h.next()
  const middle = await h.seek({ key: [5_000] })
  expect(middle.ids).toEqual(range(4_950, 5_049))
  expect(middle.header.before).toBe(4_949)
  expect(middle.header.after).toBe(4_951)
  expect((await h.seek({ key: [3] })).ids).toEqual(range(1, 100))
  const end = await h.seek({ key: [9_998] })
  expect(end.ids).toEqual(range(9_901, 10_000))
  expect(end.header.after).toBe(0)
  expect((await h.seek({ key: [123_456_789] })).ids).toEqual(range(1, 100))
  h.stream.close()
})

test("windows follow SQL OFFSET truth for every order, with ties and nulls, across random slides", async () => {
  const query = (order: string, group: string | undefined) => {
    const where = group ? "WHERE grp = ?" : ""
    const sql: Record<string, string> = {
      id: "id ASC",
      newest: "id DESC",
      rank: "rank DESC, id ASC",
      bucket: "bucket ASC, id DESC",
    }
    return (offset: number, limit: number) =>
      seeded.db
        .query<{ id: number }, (string | number)[]>(
          `SELECT id FROM items ${where} ORDER BY ${sql[order]} LIMIT ? OFFSET ?`,
        )
        .all(...(group ? [group] : []), limit, offset)
        .map((r) => r.id)
  }
  let seed = 12_345
  const random = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
  for (const order of ["id", "newest", "rank", "bucket"]) {
    for (const group of [undefined, "g1"]) {
      const truth = query(order, group)
      const total = group ? 3_334 : 10_000
      const h = openHarness(pool, itemSource, {
        filter: group ? { group } : {},
        order,
        anchor: "head",
        window: 40,
      })
      let frame = await h.next()
      let offset = 0
      expect(frame.ids).toEqual(truth(0, 40))
      for (let step = 0; step < 25; step++) {
        const delta = random(120) - 50
        const target = Math.max(0, Math.min(total - 40, offset + delta))
        frame = await h.slide(delta)
        offset = target
        expect(frame.ids).toEqual(truth(offset, 40))
        expect(frame.header.before).toBe(offset)
        expect(frame.header.after).toBe(total - offset - 40)
      }
      h.stream.close()
    }
  }
}, 120_000)

test("a detail open (window 1) carries the detail columns", async () => {
  const h = openHarness(pool, itemSource, {
    filter: {},
    order: "id",
    anchor: { key: [77] },
    window: 1,
  })
  const frame = await h.next()
  expect(frame.ids).toEqual([77])
  expect(frame.header.before).toBe(76)
  expect(frame.header.after).toBe(9_923)
  const { readFrame } = await import("./frame.ts")
  const { streamColumns } = await import("./source.ts")
  const columns = streamColumns(itemSource as never, 1)
  const row = readFrame(frame.bytes.buffer, 0, columns).row(0) as Record<string, unknown>
  expect(row.body).toContain("body of 77")
  expect(row.meta).toEqual({ n: 77 })
  expect(Object.keys(streamColumns(itemSource as never, 2))).not.toContain("body")
  h.stream.close()
})

test("a source that counts as `more` reports 0 or more", async () => {
  const h = openHarness(pool, itemsMoreSource, {
    filter: {},
    order: "id",
    anchor: "head",
    window: 100,
  })
  const first = await h.next()
  expect(first.header.before).toBe(0)
  expect(first.header.after).toBe("more")
  const slid = await h.slide(25)
  expect(slid.header.before).toBe("more")
  expect(slid.header.after).toBe("more")
  const end = await h.seek("tail")
  expect(end.header.after).toBe(0)
  expect(end.header.before).toBe("more")
  h.stream.close()
})

test("all three tiers produce byte-identical frames", async () => {
  const tiers: Tier[] = ["shared", "transfer", "copy"]
  const harnesses = tiers.map((tier) =>
    openHarness(pool, itemSource, {
      filter: { group: "g2" },
      order: "rank",
      anchor: "head",
      window: 60,
      tier,
    }),
  )
  const steps: (() => Promise<unknown>)[][] = [
    harnesses.map((h) => () => h.next()),
    harnesses.map((h) => () => h.slide(25)),
    harnesses.map((h) => () => h.slide(-7)),
    harnesses.map((h) => () => h.seek({ key: [2_000] })),
    harnesses.map((h) => () => h.seek("tail")),
  ]
  for (const step of steps) {
    await Promise.all(step.map((run) => run()))
    const [shared, transfer, copy] = harnesses.map((h) => h.frames[h.frames.length - 1]!)
    expect(shared!.bytes.byteLength).toBeGreaterThan(0)
    expect(Buffer.from(transfer!.bytes).equals(Buffer.from(shared!.bytes))).toBe(true)
    expect(Buffer.from(copy!.bytes).equals(Buffer.from(shared!.bytes))).toBe(true)
  }
  for (const h of harnesses) h.stream.close()
})

test("a returned transfer buffer is reused: three buffers serve 100 slides", async () => {
  const before = await totals()
  const h = openHarness(pool, itemSource, {
    filter: {},
    order: "id",
    anchor: "head",
    window: 100,
    tier: "transfer",
  })
  await h.next()
  for (let i = 0; i < 100; i++) await h.slide(5)
  const after = await totals()
  expect(after.buffersAllocated - before.buffersAllocated).toBeLessThanOrEqual(3)
  h.stream.close()
})

test("a shared frame that outgrows its buffer is regrown, never refused", async () => {
  const big = seedItems(5)
  const bigPool = testPool(big.path)
  try {
    const h = openHarness(bigPool, itemSource, {
      filter: {},
      order: "id",
      anchor: "head",
      window: 1,
      tier: "shared",
    })
    const first = await h.next()
    expect(first.ids).toEqual([1])
    big.db.query("UPDATE items SET title = ? WHERE id = 1").run("é".repeat(3 * 1024 * 1024))
    bigPool.revision(1)
    const grown = await h.next()
    expect(h.messages.some((m) => m.type === "regrow")).toBe(true)
    expect(grown.bytes.byteLength).toBeGreaterThan(6 * 1024 * 1024)
    h.stream.close()
  } finally {
    await bigPool.close()
    big.close()
  }
})

test("a worker that dies mid-stream is replaced and the stream resumes at its anchor", async () => {
  const h = openHarness(pool, itemSource, { filter: {}, order: "id", anchor: "head", window: 50 })
  await h.next()
  const slid = await h.slide(25)
  expect(slid.ids).toEqual(range(26, 75))
  const sequenceBefore = slid.message.sequence
  await pool.terminateWorkerOf(h.stream.id)
  const resumed = await h.next()
  expect(resumed.ids).toEqual(range(26, 75))
  expect(resumed.message.sequence).toBeGreaterThan(sequenceBefore)
  // The dead worker never answered this slide; it is replayed on the new worker.
  await pool.terminateWorkerOf(h.stream.id)
  h.stream.post({ type: "slide", delta: 10 })
  const deadline = Date.now() + 10_000
  while (h.frames[h.frames.length - 1]!.ids[0] !== 36 && Date.now() < deadline) await h.next()
  expect(h.frames[h.frames.length - 1]!.ids).toEqual(range(36, 85))
  const [stats] = await pool.stats()
  expect(stats!.streams).toBeGreaterThanOrEqual(1)
  h.stream.close()
})

test("a revision refreshes streams whose rows changed and leaves the others alone", async () => {
  const live = seedItems(300)
  const livePool = testPool(live.path)
  try {
    const head = openHarness(livePool, itemSource, {
      filter: {},
      order: "newest",
      anchor: "head",
      window: 20,
    })
    const middle = openHarness(livePool, itemSource, {
      filter: {},
      order: "id",
      anchor: { key: [150] },
      window: 20,
    })
    const other = openHarness(livePool, itemSource, {
      filter: { group: "g1" },
      order: "id",
      anchor: "head",
      window: 20,
    })
    await head.next()
    await middle.next()
    await other.next()
    livePool.revision(1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect([head.frames.length, middle.frames.length, other.frames.length]).toEqual([1, 1, 1])
    live.db.query("INSERT INTO items VALUES(1000,'g0',5,1,'new','{}',0,'b')").run()
    const wait = head.next()
    livePool.revision(2)
    const changed = await wait
    expect(changed.ids[0]).toBe(1_000)
    expect(changed.header.revision).toBe(2)
    expect(changed.header.after).toBe(300 + 1 - 20)
    await new Promise((resolve) => setTimeout(resolve, 200))
    // The window in the middle holds the same rows; only its `after` count moved.
    expect(other.frames.length).toBe(1)
    expect(middle.frames.length).toBe(2)
    expect(middle.frames[1]!.ids).toEqual(middle.frames[0]!.ids)
    expect(middle.frames[1]!.header.after).toBe(Number(middle.frames[0]!.header.after) + 1)
    head.stream.close()
    other.stream.close()
    middle.stream.close()
  } finally {
    await livePool.close()
    live.close()
  }
})

test("an unknown source or order fails the stream without killing the worker", async () => {
  const h = openHarness(pool, itemSource, { filter: {}, order: "nope", anchor: "head", window: 5 })
  await expect(h.next()).rejects.toThrow(/no order/)
  const ok = openHarness(pool, itemSource, { filter: {}, order: "id", anchor: "head", window: 5 })
  expect((await ok.next()).ids).toEqual(range(1, 5))
  ok.stream.close()
})

test("one pool per database per process", () => {
  expect(readerPool(seeded.path)).toBe(pool)
})
