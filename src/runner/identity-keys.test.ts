import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { ATTEMPT_KEYS, PLAN_KEYS, attemptKey, planKey } from "./identity-keys.ts"
import { RunnerStore } from "./store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function open() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-identity-keys-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), join(directory, "project"))
  repositories.push(repository)
  new RunnerStore(repository)
  return repository
}

test("a key is stable and created once per id", () => {
  const repository = open()
  repository.atomic((db) => {
    const first = planKey(db, "plan-a")
    expect(planKey(db, "plan-a")).toBe(first)
    expect(planKey(db, "plan-b")).not.toBe(first)
    const attempt = attemptKey(db, "attempt-a")
    expect(attemptKey(db, "attempt-a")).toBe(attempt)
    expect(db.query(`SELECT count(*) AS n FROM ${PLAN_KEYS}`).get()).toEqual({ n: 2 })
    expect(db.query(`SELECT count(*) AS n FROM ${ATTEMPT_KEYS}`).get()).toEqual({ n: 1 })
  })
})

test("a plan is keyed when its row is first inserted by any writer", () => {
  const repository = open()
  repository.atomic((db) => {
    db.exec(
      "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES('p1','d','o',1,1,'queued','{}')",
    )
    expect(db.query(`SELECT plan_id FROM ${PLAN_KEYS}`).all()).toEqual([{ plan_id: "p1" }])
    expect(planKey(db, "p1")).toBe(1)
  })
})

test("installing over existing plans keys them without touching their rows", () => {
  const repository = open()
  repository.atomic((db) => {
    db.exec(
      "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES('old','d','o',1,1,'queued','{}')",
    )
    db.exec(`DELETE FROM ${PLAN_KEYS}; DELETE FROM schema_modules WHERE module='runner'`)
  })
  new RunnerStore(repository)
  expect(repository.read((db) => db.query(`SELECT plan_id FROM ${PLAN_KEYS}`).all())).toEqual([
    { plan_id: "old" },
  ])
})
