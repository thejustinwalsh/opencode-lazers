import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageBusyError, TaskRepository } from "./storage.ts"

const directories: string[] = []
const locks: Database[] = []

afterEach(() => {
  for (const lock of locks.splice(0)) {
    try {
      lock.exec("ROLLBACK")
    } catch {}
    lock.close()
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lazers-contention-"))
  directories.push(dir)
  const path = join(dir, "tasks.db")
  const repository = new TaskRepository(path, "/repo")
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
  expect(performance.now() - started).toBeLessThan(500)
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
