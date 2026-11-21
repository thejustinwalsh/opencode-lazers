import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import { acquireLazersCore } from "./core.ts"
import { loadLazersCore, prepareDatabase } from "./load.ts"
import type { LazersCoreHandle, LazersCoreInfo } from "./core.ts"
import { coreSnapshot } from "./registry.ts"
import { taskDatabasePath } from "../storage.ts"

const roots: string[] = []
const handles: LazersCoreHandle[] = []
const locks: Database[] = []

afterEach(async () => {
  for (const lock of locks.splice(0)) {
    try {
      lock.exec("ROLLBACK")
    } catch {
      // Already rolled back.
    }
    lock.close()
  }
  for (const handle of handles.splice(0)) await handle.release()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

function root() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "lazers-load-busy-")))
  roots.push(path)
  return path
}

function location(data: string, project: string, name: string) {
  const directory = join(project, name)
  mkdirSync(directory, { recursive: true })
  const info: LazersCoreInfo = {
    dataDirectory: data,
    projectID: "project-busy",
    projectDirectory: project,
    directory,
    options: {},
  }
  const ctx = {
    tag: directory,
    app: { version: "test" },
    location: { directory, project: { id: "project-busy", canonical: project } },
    options: {},
  } as unknown as Plugin.Context
  return { ctx, info }
}

/** Another connection holding the write lock, as a worker's index build or a second process does. */
function holdWriteLock(path: string) {
  const lock = new Database(path, { create: true, strict: true })
  locks.push(lock)
  lock.exec("PRAGMA journal_mode = WAL")
  lock.exec("BEGIN IMMEDIATE")
  return lock
}

test("a current database loads without a write, so a long lock holder never fails the load", async () => {
  const data = root()
  const project = root()
  const first = location(data, project, "a")
  handles.push(acquireLazersCore(first.ctx, first.info))
  holdWriteLock(taskDatabasePath(data))
  const second = location(data, project, "b")
  // Same process: a second location of a live core only registers.
  handles.push(acquireLazersCore(second.ctx, second.info))
  // A reload builds a new core on the shared connection while the lock is held.
  const reload = location(data, project, "c")
  const generation = "reloaded"
  const handle = acquireLazersCore(reload.ctx, { ...reload.info, generation })
  handles.push(handle)
  expect(handle.core).not.toBe(handles[0]!.core)
})

test("a fresh database installs after a lock held longer than the sync wait is released", async () => {
  const data = root()
  const project = root()
  const lock = holdWriteLock(taskDatabasePath(data))
  const { ctx, info } = location(data, project, "a")
  // Today's synchronous path dies on the 250 ms wait.
  expect(() => acquireLazersCore(ctx, info)).toThrow(/database is locked/)
  const started = performance.now()
  const loading = loadLazersCore(ctx, info)
  await Bun.sleep(1_200)
  lock.exec("ROLLBACK")
  const handle = await loading
  handles.push(handle)
  expect(performance.now() - started).toBeGreaterThan(1_100)
  expect(
    handle.core.repository.read((db) => db.query("SELECT count(*) AS n FROM tasks").get()),
  ).toEqual({
    n: 0,
  })
})

test("a lock that outlasts the wait fails loudly with the cause and the next attempt loads", async () => {
  const data = root()
  const project = root()
  const lock = holdWriteLock(taskDatabasePath(data))
  const { ctx, info } = location(data, project, "a")
  const failure = await loadLazersCore(ctx, info, { deadlineMs: 600 }).then(
    () => undefined,
    (error: Error) => error,
  )
  expect(failure?.name).toBe("StorageBusyError")
  expect(String((failure as Error & { cause?: unknown }).cause)).toContain("database is locked")
  expect(coreSnapshot()).toEqual([])
  lock.exec("ROLLBACK")
  const handle = await loadLazersCore(ctx, info)
  handles.push(handle)
  expect(coreSnapshot().length).toBe(1)
})

test("once prepared, constructing a core takes no write lock on a fresh database", async () => {
  const data = root()
  const project = root()
  const { ctx, info } = location(data, project, "a")
  const prepared = await prepareDatabase(info)
  try {
    holdWriteLock(taskDatabasePath(data))
    handles.push(acquireLazersCore(ctx, info))
  } finally {
    prepared.close()
  }
})
