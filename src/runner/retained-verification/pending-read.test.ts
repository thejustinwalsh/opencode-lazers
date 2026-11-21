import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../../storage.ts"
import type { RetainedVerification } from "./schema.ts"
import {
  createRetainedVerification,
  retainedVerification,
  saveRetainedVerification,
  terminalPendingRetainedVerifications,
} from "./store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function operation(n: number, over: Partial<RetainedVerification>): RetainedVerification {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    projectID: "project",
    projectDirectory: "/project",
    planID: crypto.randomUUID(),
    planRevision: 1,
    owner: "owner",
    taskID: crypto.randomUUID(),
    taskRevision: 1,
    attemptID: crypto.randomUUID(),
    originalSessionID: "worker",
    originalMessageID: "message",
    originalWorkspace: "/project",
    artifact: "a".repeat(40),
    taskWorkspace: null,
    taskWorkspaceState: null,
    environmentIdentity: "{}",
    reason: "fixture",
    state: "accepted",
    failureReason: null,
    cleanupState: "complete",
    createdAt: n,
    updatedAt: n,
    ...over,
  } as RetainedVerification
}

test("the tick reads terminal operations with cleanup pending, not the project's history", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-retained-pending-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  repositories.push(repository)
  const pending = operation(0, { state: "failed", cleanupState: "failed" })
  repository.atomic((db) => {
    for (let n = 1; n <= 200; n++) createRetainedVerification(db, "/project", operation(n, {}))
    createRetainedVerification(db, "/project", pending)
  })
  const read = () => repository.read((db) => terminalPendingRetainedVerifications(db, "/project"))
  expect(read().map((entry) => entry.id)).toEqual([pending.id])
  // Cleanup completing takes the operation out of the read; a changed fact would put it back.
  repository.atomic((db) =>
    saveRetainedVerification(db, {
      ...retainedVerification(db, pending.id)!,
      cleanupState: "complete",
    }),
  )
  expect(read()).toEqual([])
  const plan = repository.read((db) =>
    db
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT payload FROM runner_retained_verifications WHERE project_directory='/project' AND state IN ('accepted','failed','cancelled') AND cleanup_pending=1",
      )
      .all()
      .map((row) => row.detail)
      .join(" "),
  )
  expect(plan).toContain("runner_retained_verifications_cleanup")
}, 120_000)

test("rows written before the cleanup_pending column existed are classified when it is added", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-retained-legacy-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  repositories.push(repository)
  const done = operation(1, {})
  const stuck = operation(2, { state: "failed", cleanupState: "failed" })
  const owned = operation(3, { taskWorkspace: "/w", taskWorkspaceState: "owned" })
  repository.atomic((db) => {
    db.exec(
      "CREATE TABLE runner_retained_verifications (id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, plan_id TEXT NOT NULL, task_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL)",
    )
    const insert = db.query(
      "INSERT INTO runner_retained_verifications VALUES(?,'/project',?,?,?,?)",
    )
    for (const entry of [done, stuck, owned])
      insert.run(entry.id, entry.planID, entry.taskID, entry.state, JSON.stringify(entry))
  })
  const ids = repository
    .read((db) => terminalPendingRetainedVerifications(db, "/project"))
    .map((entry) => entry.id)
    .sort()
  expect(ids).toEqual([stuck.id, owned.id].sort())
}, 120_000)
