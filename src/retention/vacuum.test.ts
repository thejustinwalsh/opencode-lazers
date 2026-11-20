import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { RetentionService } from "./service.ts"
import {
  CompactionRefused,
  INCREMENTAL_VACUUM_PAGES,
  compactOnce,
  incrementalVacuum,
  spaceState,
} from "./vacuum.ts"

const directories: string[] = []
const fixtures: Array<ReturnType<typeof makeFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function database(rows = 3000) {
  const dir = mkdtempSync(join(tmpdir(), "lazers-vacuum-"))
  directories.push(dir)
  const path = join(dir, "t.sqlite")
  const db = new Database(path)
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
  db.transaction(() => {
    const insert = db.query("INSERT INTO t(body) VALUES(?)")
    for (let i = 0; i < rows; i++) insert.run(`${i}:`.repeat(600))
  })()
  return { db, path }
}

const fileBytes = (path: string) => statSync(path).size

test("a database that was never compacted is left alone by the incremental step", () => {
  const { db, path } = database()
  db.exec("DELETE FROM t WHERE id % 4 <> 0")
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  const before = { state: spaceState(db), size: fileBytes(path) }
  expect(before.state.autoVacuum).toBe("none")
  expect(before.state.freelistPages).toBeGreaterThan(0)
  expect(incrementalVacuum(db)).toBe(0)
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  expect(spaceState(db).freelistPages).toBe(before.state.freelistPages)
  expect(fileBytes(path)).toBe(before.size)
  db.close()
})

test("the one-time compaction keeps every row, switches the mode and returns the free pages", () => {
  const { db, path } = database()
  db.exec("DELETE FROM t WHERE id % 4 <> 0")
  const expected = db.query("SELECT id,body FROM t ORDER BY id").all()
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  const before = fileBytes(path)
  db.close()
  const result = compactOnce(path)
  expect(result.autoVacuum).toBe("incremental")
  expect(result.afterBytes).toBeLessThan(before / 2)
  const check = new Database(path)
  expect(check.query("SELECT id,body FROM t ORDER BY id").all()).toEqual(expected)
  expect(spaceState(check).freelistPages).toBe(0)
  check.close()
})

test("the compaction refuses when the disk cannot hold its temporary copies", () => {
  const { db, path } = database(200)
  db.close()
  expect(() => compactOnce(path, { freeDiskBytes: 1024 })).toThrow(CompactionRefused)
  const check = new Database(path)
  expect(spaceState(check).autoVacuum).toBe("none")
  check.close()
})

test("incremental steps are bounded and shrink the file after later deletes", () => {
  const { db, path } = database(8000)
  db.close()
  compactOnce(path)
  const live = new Database(path)
  live.exec("PRAGMA journal_mode=WAL")
  live.exec("DELETE FROM t WHERE id % 4 <> 0")
  const free = spaceState(live).freelistPages
  expect(free).toBeGreaterThan(INCREMENTAL_VACUUM_PAGES)
  const step = incrementalVacuum(live)
  const after = spaceState(live)
  // One step releases at most its page budget, and the rest stays for the next step.
  expect(step).toBe(INCREMENTAL_VACUUM_PAGES * after.pageSize)
  expect(after.freelistPages).toBe(free - INCREMENTAL_VACUUM_PAGES)
  while (incrementalVacuum(live) > 0);
  live.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  expect(spaceState(live).freelistPages).toBe(0)
  expect(live.query("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 2000 })
  live.close()
})

test("the retention service reports the mode and reclaims space once the database is incremental", async () => {
  const fixture = makeFixture()
  fixtures.push(fixture)
  const service = new RetentionService({
    repository: fixture.repository,
    host: { session: async () => null, worktrees: async () => [], removeWorktree: async () => {} },
    now: () => Date.UTC(2026, 10, 19),
  })
  const bulk = () =>
    fixture.store.atomic((db) => {
      db.exec("CREATE TABLE IF NOT EXISTS scratch_bulk (body TEXT)")
      const insert = db.query("INSERT INTO scratch_bulk VALUES(?)")
      for (let i = 0; i < 2000; i++) insert.run("x".repeat(2000))
      db.exec("DROP TABLE scratch_bulk")
    })
  bulk()
  const before = await service.status()
  expect(before.autoVacuum).toBe("none")
  expect(before.freeBytes).toBeGreaterThan(0)
  expect(before.compactionDiskBytes).toBeGreaterThan(0)
  expect((await service.retire({ days: 30 })).reclaimedBytes).toBe(0)

  compactOnce(fixture.repository.path)
  expect((await service.status()).autoVacuum).toBe("incremental")
  bulk()
  const filled = await service.status()
  expect(filled.freeBytes).toBeGreaterThan(0)
  const slice = await service.retire({ days: 30 })
  expect(slice.reclaimedBytes).toBeGreaterThan(0)
  expect(slice.freeBytes).toBeLessThan(filled.freeBytes)
})
