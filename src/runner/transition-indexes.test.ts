import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { asLegacyHistory } from "./identity.fixture.ts"
import { RunnerStore } from "./store.ts"
import {
  TRANSITION_INDEXES,
  ensureTransitionIndexes,
  missingTransitionIndexes,
} from "./transition-indexes.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function database() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-transition-indexes-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), join(directory, "project"))
  repositories.push(repository)
  return repository
}

const missing = (repository: TaskRepository) =>
  repository.read((db) => missingTransitionIndexes(db).map(([name]) => name))

/** A database from before these indexes and before the integer keys (which retire them). */
function dropIndexes(repository: TaskRepository) {
  repository.atomic((db) => {
    // Rows make the table look populated so the off-thread path is exercised.
    db.exec(
      "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES('p','d','o',1,1,'queued','{}')",
    )
    db.exec(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES('p',NULL,1,'E','{}',1)",
    )
  })
  asLegacyHistory(repository)
  repository.atomic((db) => {
    for (const [name] of TRANSITION_INDEXES) db.exec(`DROP INDEX IF EXISTS ${name}`)
  })
}

test("opening a database from before the indexes existed creates all three", async () => {
  const repository = database()
  const first = new RunnerStore(repository)
  await first.transitionIndexes
  // A new database is keyed at install: its readers use the integer indexes instead.
  expect(missing(repository)).toHaveLength(3)
  dropIndexes(repository)
  expect(missing(repository)).toHaveLength(3)

  const reopened = new RunnerStore(repository)
  await reopened.transitionIndexes
  expect(missing(repository)).toEqual([])
})

test("large tables are indexed by a worker without blocking the opener", async () => {
  const repository = database()
  await new RunnerStore(repository).transitionIndexes
  dropIndexes(repository)
  const pending = ensureTransitionIndexes(repository, { inlineRowLimit: 0 })
  // The opener returned without building them inline.
  expect(missing(repository)).toHaveLength(3)
  await pending
  expect(missing(repository)).toEqual([])
})

test("separate module copies share one in-flight build per database", async () => {
  const repository = database()
  await new RunnerStore(repository).transitionIndexes
  dropIndexes(repository)
  // A query string yields a distinct module instance, like a per-location cleared require cache.
  const load = (copy: string): Promise<typeof import("./transition-indexes.ts")> =>
    import(`./transition-indexes.ts?copy=${copy}`)
  const copies = [await load("a"), await load("b")]
  expect(copies[0]!.ensureTransitionIndexes).not.toBe(ensureTransitionIndexes)
  let spawned = 0
  const builds = copies.map((copy) =>
    copy.ensureTransitionIndexes(repository, {
      inlineRowLimit: 0,
      onSpawn: () => spawned++,
    }),
  )
  await Promise.all(builds)
  expect(spawned).toBe(1)
  expect(missing(repository)).toEqual([])
})

test("the worker is spawned only after the requesting transaction has committed", async () => {
  const repository = database()
  await new RunnerStore(repository).transitionIndexes
  dropIndexes(repository)
  const states: boolean[] = []
  let db: import("bun:sqlite").Database | undefined
  const wrapped = {
    path: repository.path,
    read: <T>(run: (database: import("bun:sqlite").Database) => T): T => repository.read(run),
    atomic: <T>(run: (database: import("bun:sqlite").Database) => T): T =>
      repository.atomic((database) => {
        db = database
        return run(database)
      }),
  }
  await ensureTransitionIndexes(wrapped, {
    inlineRowLimit: 0,
    onSpawn: () => states.push(db!.inTransaction),
  })
  expect(states).toEqual([false])
  expect(missing(repository)).toEqual([])
})
