import { afterEach, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { enrollProjectionConnection, registerProjectionDrain } from "./hook.ts"
import { projectionStatus } from "./lifecycle.ts"
import { ProjectionOwner, startProjection, type ProjectionSpec } from "./owner.ts"
import { drainQueue, queueRef, queueTableSQL } from "./queue.ts"

/**
 * A toy projection over `toy_source`: `toy_rows` doubles each value. One backfill phase pages by
 * rowid, ten rows a page; a trigger queues inserts and updates; `toy_fail` makes a refresh throw.
 */
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const PAGE = 10
const pagesFrom: number[] = []
let failing = false

function refresh(db: Database, ref: string) {
  if (failing) throw new Error("toy refresh failed")
  const id = Number(ref)
  const row = db.query<{ v: number }, [number]>("SELECT v FROM toy_source WHERE id=?").get(id)
  if (!row) db.query("DELETE FROM toy_rows WHERE id=?").run(id)
  else db.query("INSERT OR REPLACE INTO toy_rows(id,v) VALUES(?,?)").run(id, row.v * 2)
}

const spec = (generation = 1): ProjectionSpec => ({
  name: "toy",
  generation,
  backfill: [
    {
      name: "source",
      page(db, _scope, after) {
        pagesFrom.push(after)
        const ids = db
          .query<{ id: number }, [number, number]>(
            "SELECT id FROM toy_source WHERE id>? ORDER BY id LIMIT ?",
          )
          .all(after, PAGE)
        for (const { id } of ids) refresh(db, String(id))
        return { next: ids.at(-1)?.id ?? after, done: ids.length < PAGE }
      },
    },
  ],
  queue: {
    table: "toy_dirty",
    drain: (db) => drainQueue(db, "toy_dirty", refresh, { budget: 100 }),
  },
})

function database(rows: number) {
  const directory = mkdtempSync(join(tmpdir(), "lazers-projection-"))
  const path = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(path, "/p")
  cleanups.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  repository.atomic((db) => {
    db.exec(`CREATE TABLE toy_source(id INTEGER PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE toy_rows(id INTEGER PRIMARY KEY, v INTEGER NOT NULL);
      ${queueTableSQL("toy_dirty")}`)
    for (let i = 1; i <= rows; i++) db.query("INSERT INTO toy_source(v) VALUES(?)").run(i)
    db.exec(`CREATE TRIGGER toy_q AFTER INSERT ON toy_source BEGIN
      ${queueRef("toy_dirty", "NEW.id")} END;
      CREATE TRIGGER toy_u AFTER UPDATE ON toy_source BEGIN ${queueRef("toy_dirty", "NEW.id")} END;`)
  })
  registerProjectionDrain("toy", "toy_dirty", (db) => void spec().queue!.drain(db))
  repository.read((db) => enrollProjectionConnection(db, "toy"))
  return { path, repository }
}

const slow = {
  startMs: 60_000,
  quiet: { sliceMs: 1, waitMs: 1 },
  busy: { sliceMs: 1, waitMs: 1 },
  retryMs: 60_000,
}
const count = (repository: TaskRepository, table: string) =>
  repository.read(
    (db) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
  )

test("owner: resumes at the stored watermark after a kill; idle when clean holds no timer", async () => {
  const { path, repository } = database(35)
  pagesFrom.length = 0
  const first = new ProjectionOwner(new TaskRepository(path, "/p"), spec(), { pacing: slow })
  first.start()
  expect(first.backfillPage()).toBe(true)
  expect(first.backfillPage()).toBe(true)
  // Killed between pages: the watermark committed with the second page.
  first.close()
  expect(repository.read((db) => projectionStatus(db, "toy"))).toMatchObject({
    state: "backfilling",
    phase: 0,
    after: 20,
    pages: 2,
  })
  const lease = startProjection(path, "/p", spec(), { pacing: slow })
  cleanups.push(() => lease.release())
  await lease.owner.settle()
  expect(pagesFrom).toEqual([0, 10, 20, 30])
  expect(count(repository, "toy_rows")).toBe(35)
  expect(lease.owner.status()).toMatchObject({ state: "ready", pages: 4 })
  expect(lease.owner.idle()).toBe(true)
  // A write after ready reaches the projection through the drain in its own transaction.
  repository.atomic((db) => db.query("UPDATE toy_source SET v=100 WHERE id=1").run())
  expect(repository.read((db) => db.query("SELECT v FROM toy_rows WHERE id=1").get())).toEqual({
    v: 200,
  })
  expect(count(repository, "toy_dirty")).toBe(0)
  // Same database and projection: one shared owner.
  const again = startProjection(path, "/q", spec(), { pacing: slow })
  expect(again.owner).toBe(lease.owner)
  again.release()
})

test("owner: a generation bump returns ready to backfilling and rewrites every row", async () => {
  const { path, repository } = database(12)
  const one = startProjection(path, "/p", spec(1), { pacing: slow })
  await one.owner.settle()
  one.release()
  repository.atomic((db) => db.exec("DELETE FROM toy_rows"))
  pagesFrom.length = 0
  const two = startProjection(path, "/p", spec(2), { pacing: slow })
  cleanups.push(() => two.release())
  expect(two.owner.status()).toMatchObject({ state: "backfilling", generation: 2, after: 0 })
  await two.owner.settle()
  expect(pagesFrom).toEqual([0, 10])
  expect(count(repository, "toy_rows")).toBe(12)
  // An older copy (generation 1) sees a newer stored generation and does not backfill.
  const older = new ProjectionOwner(new TaskRepository(path, "/p"), spec(1), { pacing: slow })
  older.start()
  expect(older.backfillPage()).toBe(false)
  older.close()
  expect(two.owner.status()).toMatchObject({ state: "ready", generation: 2 })
})

test("owner: a throwing refresh leaves its entry with its error; a later drain recovers", async () => {
  const { path, repository } = database(0)
  const lease = startProjection(path, "/p", spec(), { pacing: slow })
  cleanups.push(() => lease.release())
  await lease.owner.settle()
  failing = true
  try {
    // The writer's transaction commits; the entry is parked with its error and a backoff.
    repository.atomic((db) => db.query("INSERT INTO toy_source(v) VALUES(7)").run())
    const parked = repository.read((db) =>
      db
        .query<{ attempts: number; error: string }, []>("SELECT attempts,error FROM toy_dirty")
        .get(),
    )
    expect(parked).toEqual({ attempts: 1, error: "toy refresh failed" })
    expect(count(repository, "toy_source")).toBe(1)
    expect(count(repository, "toy_rows")).toBe(0)
  } finally {
    failing = false
  }
  // A due entry is drained by the owner (here: its backoff is passed by moving next_at).
  repository.atomic((db) => db.exec("UPDATE toy_dirty SET next_at=0"))
  await lease.owner.drain()
  expect(count(repository, "toy_rows")).toBe(1)
  expect(count(repository, "toy_dirty")).toBe(0)
  expect(lease.owner.idle()).toBe(true)
})
