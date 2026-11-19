import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
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

function dropIndexes(repository: TaskRepository) {
  repository.atomic((db) => {
    for (const [name] of TRANSITION_INDEXES) db.exec(`DROP INDEX IF EXISTS ${name}`)
    // Rows make the table look populated so the off-thread path is exercised.
    db.exec(
      "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES('p','d','o',1,1,'queued','{}')",
    )
    db.exec(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES('p',NULL,1,'E','{}',1)",
    )
  })
}

test("opening a database from before the indexes existed creates all three", async () => {
  const repository = database()
  const first = new RunnerStore(repository)
  await first.transitionIndexes
  expect(missing(repository)).toEqual([])
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
  const pending = repository.atomic((db) =>
    ensureTransitionIndexes(db, repository.path, { inlineRowLimit: 0 }),
  )
  // The opener returned without building them inline.
  expect(missing(repository)).toHaveLength(3)
  await pending
  expect(missing(repository)).toEqual([])
})
