import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "./store.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-contact-"))
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, root)
  cleanups.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { repository, store: new RunnerStore(repository), path, root }
}

test("an enabled contact keeps no reason: enabling clears the pause reason", () => {
  const { store } = fixture()
  expect(store.setArchitectContact("paused", "Recovery mode")).toMatchObject({
    state: "paused",
    reason: "Recovery mode",
  })
  // Live 2026-11-19: enabling with a text stored it, so an enabled contact read like a pause.
  expect(
    store.setArchitectContact(
      "enabled",
      "Owner queue prune 2026-11-19: no other work until the owner resumes the queue",
    ),
  ).toMatchObject({ state: "enabled", reason: "" })
})

test("a stored enabled row with a reason is corrected when the store loads", () => {
  const { repository, path, root } = fixture()
  repository.atomic((db) =>
    db
      .query("INSERT INTO runner_architect_contact VALUES(?,?,?,?)")
      .run(root, "enabled", "Owner queue prune 2026-11-19", 1),
  )
  const again = new TaskRepository(path, root)
  cleanups.push(() => again.close())
  expect(new RunnerStore(again).architectContact()).toMatchObject({ state: "enabled", reason: "" })
})
