import { afterAll, beforeAll, expect, test } from "bun:test"
import { databaseChanges, DatabaseChangeHub } from "../database-events.ts"
import { openStream } from "./client.ts"
import { acquireReaderPool, readerPoolSnapshot, type ReaderPool } from "./pool.ts"
import { connectRevisions } from "./revisions.ts"
import { itemSource } from "./test-source.ts"
import { seedItems, testSourceModule, type SeededDatabase } from "./test-harness.ts"

const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return
    await Bun.sleep(10)
  }
  throw new Error("condition not reached")
}

test("100 writes in one turn send one revision naming the tables written", async () => {
  const seeded = seedItems(10)
  const hub = new DatabaseChangeHub()
  hub.track(seeded.db, seeded.path)
  const sent: { revision: number; tables?: readonly string[] }[] = []
  const stop = connectRevisions(
    { revision: (revision, tables) => void sent.push({ revision, ...(tables ? { tables } : {}) }) },
    seeded.path,
    hub,
  )
  try {
    for (let i = 0; i < 100; i++)
      seeded.db.query("INSERT INTO items VALUES(?,'g0',1,1,'t','{}',0,'b')").run(1_000 + i)
    await until(() => sent.length > 0)
    await Bun.sleep(30)
    expect(sent).toEqual([{ revision: 1, tables: ["items"] }])
  } finally {
    stop()
    seeded.close()
  }
})

test("a hub without the table feed falls back to a revision that names no tables", async () => {
  const seeded = seedItems(3)
  const sent: unknown[] = []
  let notify = () => {}
  const stop = connectRevisions(
    { revision: (revision, tables) => void sent.push([revision, tables]) },
    seeded.path,
    {
      subscribe(_path: string, changed: () => void) {
        notify = changed
        return () => {}
      },
    } as never,
  )
  notify()
  expect(sent).toEqual([[1, undefined]])
  stop()
  seeded.close()
})

let seeded: SeededDatabase
let pool: ReaderPool
let release: () => void
beforeAll(() => {
  seeded = seedItems(300)
  seeded.db.run("CREATE TABLE other(v INTEGER)")
  // The writer connection is the tracked one, as the plugin's shared connection is.
  databaseChanges.track(seeded.db, seeded.path)
  const lease = acquireReaderPool(seeded.path, { workers: 1, sourceModules: [testSourceModule] })
  pool = lease.pool
  release = lease.release
})
afterAll(() => {
  release()
  seeded.close()
})

test("Review Focus 3: an update and a delete inside the window change it in place, no jump", async () => {
  const stream = openStream(pool, itemSource, {
    filter: {},
    order: "id",
    window: 20,
    anchor: { key: [150] },
  })
  await stream.ready()
  const ids = () => stream.items.map((r) => r.id)
  expect(ids()[0]).toBe(140)
  expect(stream.before).toBe(139)
  expect(stream.after).toBe(141)
  const next = (run: () => void) => {
    const changed = new Promise<void>((resolve) => {
      const off = stream.on("change", () => (off(), resolve()))
    })
    run()
    return changed
  }
  await next(() => seeded.db.query("UPDATE items SET title = 'edited' WHERE id = 145").run())
  expect(ids()).toEqual(Array.from({ length: 20 }, (_, i) => 140 + i))
  expect(stream.items[5]!.title).toBe("edited")
  expect(stream.after).toBe(141)
  await next(() => seeded.db.query("DELETE FROM items WHERE id = 146").run())
  expect(ids()[0]).toBe(140)
  expect(ids()).not.toContain(146)
  expect(ids().length).toBe(20)
  expect(stream.before).toBe(139)
  expect(stream.after).toBe(140)
  // The first row of the window itself goes away: the window starts at its successor.
  await next(() => seeded.db.query("DELETE FROM items WHERE id = 140").run())
  expect(ids()[0]).toBe(141)
  expect(stream.before).toBe(139)
  stream.close()
})

test("a write to an unrelated table sends a revision but produces no frame and no query", async () => {
  const stream = openStream(pool, itemSource, { filter: {}, order: "id", window: 20 })
  await stream.ready()
  let changes = 0
  stream.on("change", () => changes++)
  const before = (await pool.stats())[0]!
  seeded.db.query("INSERT INTO other VALUES(1)").run()
  await Bun.sleep(150)
  const after = (await pool.stats())[0]!
  expect(changes).toBe(0)
  expect(after.statements).toBe(before.statements)
  stream.close()
})

test("the pool is held by its leases and the last release closes it", async () => {
  const own = seedItems(5)
  const options = { workers: 1, sourceModules: [testSourceModule] }
  try {
    const a = acquireReaderPool(own.path, options)
    const b = acquireReaderPool(own.path, options)
    expect(a.pool).toBe(b.pool)
    expect(readerPoolSnapshot().find((entry) => entry.key.includes(own.path))?.refs).toBe(2)
    a.release()
    a.release()
    expect(readerPoolSnapshot().find((entry) => entry.key.includes(own.path))?.refs).toBe(1)
    const stream = openStream(b.pool, itemSource, { filter: {}, order: "id", window: 3 })
    await stream.ready()
    stream.close()
    b.release()
    expect(readerPoolSnapshot().some((entry) => entry.key.includes(own.path))).toBe(false)
    expect(() => b.pool.attach({} as never, () => {})).toThrow(/closed/)
  } finally {
    own.close()
  }
})
