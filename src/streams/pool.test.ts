import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { readerPool } from "./pool.ts"
import { itemSource } from "./test-source.ts"
import { openHarness, seedItems, testPool } from "./test-harness.ts"

test("streams are assigned to workers round-robin and close() leaves none behind", async () => {
  const seeded = seedItems(50)
  const pool = testPool(seeded.path, 2)
  try {
    const a = openHarness(pool, itemSource, { filter: {}, order: "id", anchor: "head", window: 5 })
    const b = openHarness(pool, itemSource, { filter: {}, order: "id", anchor: "tail", window: 5 })
    const c = openHarness(pool, itemSource, { filter: {}, order: "id", anchor: "head", window: 5 })
    await Promise.all([a.next(), b.next(), c.next()])
    const stats = await pool.stats()
    expect(stats.map((s) => s.streams).sort()).toEqual([1, 2])
    c.stream.close()
    c.stream.close()
    const after = await pool.stats()
    expect(after.reduce((sum, s) => sum + s.streams, 0)).toBe(2)
  } finally {
    await pool.close()
    seeded.close()
  }
  expect(() => pool.attach({} as never, () => {})).toThrow(/closed/)
  // A closed pool is forgotten: the next request builds a new one.
  const again = seedItems(5)
  try {
    const fresh = readerPool(seeded.path)
    expect(fresh).not.toBe(pool)
    await fresh.close()
  } finally {
    again.close()
  }
})

test("a worker that cannot start fails its streams instead of looping forever", async () => {
  const seeded = seedItems(5)
  const directory = mkdtempSync(join(tmpdir(), "lz-bad-worker-"))
  const script = join(directory, "bad-worker.js")
  writeFileSync(script, "throw new Error('cannot start')\n")
  const pool = readerPool(join(directory, "other.sqlite"), {
    workers: 1,
    workerURL: pathToFileURL(script),
  })
  try {
    const failures: string[] = []
    pool.attach(
      { source: itemSource.name, filter: {}, order: "id", anchor: "head", window: 5, tier: "copy" },
      (message) => {
        if (message.type === "failed") failures.push(message.message)
      },
    )
    const deadline = Date.now() + 15_000
    while (failures.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50))
    expect(failures[0]).toMatch(/keeps failing/)
  } finally {
    await pool.close()
    seeded.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

test("a buffer from a dead worker is dropped, not handed to its replacement", async () => {
  const seeded = seedItems(50)
  const pool = testPool(seeded.path)
  try {
    const frames: ArrayBuffer[] = []
    const stream = pool.attach(
      {
        source: itemSource.name,
        filter: {},
        order: "id",
        anchor: "head",
        window: 5,
        tier: "transfer",
      },
      (message) => {
        if (message.type === "frame" && message.buffer) frames.push(message.buffer)
      },
    )
    while (frames.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    await pool.terminateWorkerOf(stream.id)
    await new Promise((resolve) => setTimeout(resolve, 300))
    stream.release(frames[0]!)
    const [stats] = await pool.stats()
    expect(stats!.buffersPooled).toBe(0)
    stream.close()
  } finally {
    await pool.close()
    seeded.close()
  }
})
