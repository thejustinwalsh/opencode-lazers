import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunnerStore } from "../../runner/store.ts"
import { TaskRepository } from "../../storage.ts"
import { scheduleReady } from "./stored.ts"
import { insertTask } from "./fixture.ts"
import { acquireScheduleOwner } from "./owner.ts"
import { ensureTaskScheduleSchema } from "./schema.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

test("one owner per database indexes every project in it, loaded or not, and stops with its last release", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-owner-"))
  const path = join(directory, "tasks.sqlite")
  const loaded = new TaskRepository(path, "/loaded")
  const unloaded = new TaskRepository(path, "/unloaded")
  cleanups.push(() => {
    loaded.close()
    unloaded.close()
    rmSync(directory, { recursive: true, force: true })
  })
  ensureTaskScheduleSchema(loaded)
  new RunnerStore(loaded)
  insertTask(loaded, "a")
  insertTask(unloaded, "b")
  // Only the loaded project's core is constructed; a second core of the same database shares it.
  const first = acquireScheduleOwner(path, "/loaded")
  const second = acquireScheduleOwner(path, "/other")
  expect(second.owner).toBe(first.owner)
  await first.owner.settle()
  for (const repository of [loaded, unloaded])
    expect(repository.read((db) => scheduleReady(db, repository.projectDirectory))).toBe(true)
  // A project that appears later is indexed too.
  const later = new TaskRepository(path, "/later")
  cleanups.push(() => later.close())
  insertTask(later, "c")
  // The owner hears of the new task through the table-change subscription.
  for (let waited = 0; waited < 50 && !later.read((db) => scheduleReady(db, "/later")); waited++)
    await Bun.sleep(20)
  expect(later.read((db) => scheduleReady(db, "/later"))).toBe(true)
  first.release()
  const third = acquireScheduleOwner(path, "/loaded")
  expect(third.owner).toBe(first.owner)
  second.release()
  third.release()
  // Every lease is released: the next acquire builds a fresh owner.
  const fresh = acquireScheduleOwner(path, "/loaded")
  expect(fresh.owner).not.toBe(first.owner)
  fresh.release()
})
