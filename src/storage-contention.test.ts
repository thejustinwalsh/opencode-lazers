import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SQLITE_BUSY_TIMEOUT_MS,
  StorageBusyError,
  TaskRepository,
  acquireSharedConnection,
  sharedConnectionCount,
} from "./storage.ts"
import { ModelEvidenceStore } from "./models/source-store.ts"

const directories: string[] = []
const locks: Database[] = []
const repos: TaskRepository[] = []

afterEach(() => {
  for (const lock of locks.splice(0)) {
    try {
      lock.exec("ROLLBACK")
    } catch {}
    lock.close()
  }
  for (const repository of repos.splice(0)) repository.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lazers-contention-"))
  directories.push(dir)
  const path = join(dir, "tasks.db")
  const repository = new TaskRepository(path, "/repo")
  repos.push(repository)
  repository.atomic((db) => db.exec("CREATE TABLE IF NOT EXISTS probe (n INTEGER)"))
  /** A second connection holding the write lock, as another plugin instance or CLI would. */
  const lock = new Database(path, { strict: true })
  locks.push(lock)
  lock.exec("BEGIN IMMEDIATE")
  return { repository, lock }
}

test("read() completes without waiting while another connection holds the write lock", () => {
  const { repository } = fixture()
  const started = performance.now()
  const count = repository.read((db) => db.query("SELECT count(*) AS c FROM probe").get())
  expect(count).toEqual({ c: 0 })
  expect(performance.now() - started).toBeLessThan(40)
})

test("sync atomic() fails fast instead of sleeping for seconds", () => {
  const { repository } = fixture()
  const started = performance.now()
  expect(() => repository.atomic((db) => db.exec("INSERT INTO probe VALUES (1)"))).toThrow()
  // Bound by "well under a second", not exact SQLite timing, so a loaded machine can't flake it.
  expect(performance.now() - started).toBeLessThan(SQLITE_BUSY_TIMEOUT_MS * 3)
})

test("atomicAsync() yields to the event loop while retrying and succeeds after release", async () => {
  const { repository, lock } = fixture()
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  setTimeout(() => lock.exec("COMMIT"), 200)
  try {
    await repository.atomicAsync((db) => db.exec("INSERT INTO probe VALUES (1)"))
  } finally {
    clearInterval(timer)
  }
  expect(ticks).toBeGreaterThan(5)
  expect(repository.read((db) => db.query("SELECT count(*) AS c FROM probe").get())).toEqual({
    c: 1,
  })
})

test("atomicAsync() surfaces StorageBusyError after its deadline", async () => {
  const { repository } = fixture()
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  try {
    await expect(
      repository.atomicAsync((db) => db.exec("INSERT INTO probe VALUES (1)"), { deadlineMs: 150 }),
    ).rejects.toBeInstanceOf(StorageBusyError)
  } finally {
    clearInterval(timer)
  }
  expect(ticks).toBeGreaterThan(3)
})

test("instances on one path share a single connection; the last release closes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "lazers-shared-"))
  directories.push(dir)
  const path = join(dir, "tasks.db")
  const before = sharedConnectionCount()
  const first = new TaskRepository(path, "/repo")
  const second = new TaskRepository(path, "/other")
  expect(sharedConnectionCount()).toBe(before + 1)
  expect(first.read((db) => db)).toBe(second.read((db) => db))
  const models = new ModelEvidenceStore(path, "/repo")
  expect(sharedConnectionCount()).toBe(before + 1)
  first.close()
  first.close()
  models.close()
  expect(second.read((db) => db.query("SELECT 1 AS one").get())).toEqual({ one: 1 })
  second.close()
  expect(sharedConnectionCount()).toBe(before)
  // A later instance opens a fresh connection and still sees the data.
  const again = new TaskRepository(path, "/repo")
  repos.push(again)
  expect(sharedConnectionCount()).toBe(before + 1)
})

test("readonly connections are shared per path, separate from the writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "lazers-shared-ro-"))
  directories.push(dir)
  const path = join(dir, "tasks.db")
  const repository = new TaskRepository(path, "/repo")
  repos.push(repository)
  const a = acquireSharedConnection(path, "readonly")
  const b = acquireSharedConnection(path, "readonly")
  expect(a.db).toBe(b.db)
  expect(a.db).not.toBe(repository.read((db) => db))
  a.release()
  expect(b.db.query("SELECT 1 AS one").get()).toEqual({ one: 1 })
  b.release()
  expect(() => b.db.query("SELECT 1").get()).toThrow()
})

test("a replaced database file is not served from a stale connection", () => {
  const dir = mkdtempSync(join(tmpdir(), "lazers-shared-stale-"))
  directories.push(dir)
  const path = join(dir, "tasks.db")
  const stale = new TaskRepository(path, "/repo")
  repos.push(stale)
  rmSync(path)
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
  const fresh = new TaskRepository(path, "/repo")
  repos.push(fresh)
  expect(fresh.read((db) => db)).not.toBe(stale.read((db) => db))
})

test("many interleaved in-process writers never see SQLITE_BUSY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lazers-shared-writers-"))
  directories.push(dir)
  const path = join(dir, "tasks.db")
  const instances = Array.from({ length: 44 }, () => new TaskRepository(path, "/repo"))
  repos.push(...instances)
  instances[0]!.atomic((db) =>
    db.exec("CREATE TABLE IF NOT EXISTS w (instance INTEGER, n INTEGER)"),
  )
  await Promise.all(
    instances.map(async (repository, instance) => {
      for (let n = 0; n < 25; n++) {
        repository.atomic((db) => db.query("INSERT INTO w VALUES (?, ?)").run(instance, n))
        if (n % 5 === 0) await Bun.sleep(0)
        await repository.atomicAsync((db) =>
          db.query("INSERT INTO w VALUES (?, ?)").run(instance, 1000 + n),
        )
      }
    }),
  )
  expect(instances[0]!.read((db) => db.query("SELECT count(*) AS c FROM w").get())).toEqual({
    c: 44 * 50,
  })
})
