import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { validProposal } from "../test/proposal.ts"
import { TaskRepository, taskDatabasePath } from "./storage.ts"
import { startingRevision, submitTask } from "./submission.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), "lazers-tasks-"))
  directories.push(path)
  return path
}
function open(path: string, project = "/repo") {
  const repository = new TaskRepository(path, project)
  repositories.push(repository)
  return repository
}
function provenance() {
  return {
    projectID: "project",
    projectDirectory: "/repo",
    workspaceDirectory: "/repo/worktree",
    sessionID: "session",
    startingRevision: { kind: "unborn" as const },
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

test("a validated submission survives closing and reopening SQLite with runtime provenance", () => {
  const path = join(directory(), "nested", "tasks.sqlite")
  const repository = new TaskRepository(path, "/repo")
  const result = submitTask(repository, validProposal(), provenance)
  expect(result.status).toBe("submitted")
  if (result.status !== "submitted") throw new Error("Submission failed")
  repository.close()
  const reopened = open(path)
  const task = reopened.get(result.taskID)!
  expect(task.id).toBe(result.taskID)
  expect(task.provenance).toEqual(provenance())
  expect(task.proposal).toEqual(validProposal())
  expect(task.status).toBe("submitted")
  expect(reopened.list()).toHaveLength(1)
  expect(() => reopened.insert(task)).toThrow()
  expect(reopened.list()).toHaveLength(1)
})

test("invalid submissions return field guidance, save nothing, and do not collect provenance", () => {
  const repository = open(join(directory(), "tasks.sqlite"))
  const result = submitTask(repository, { ...validProposal(), verification: [] }, () => {
    throw new Error("Invalid input must be rejected before provenance")
  })
  expect(result.status).toBe("invalid")
  if (result.status !== "invalid") throw new Error("Expected rejection")
  expect(result.errors[0]?.path).toBe("acceptance.0.evidence.0.verificationID")
  expect(repository.list()).toEqual([])
  expect(() => repository.insert({ status: "submitted" })).toThrow()
  expect(repository.list()).toEqual([])
})

test("worktrees sharing canonical project identity see tasks; other projects cannot retrieve them", () => {
  const path = join(directory(), "tasks.sqlite")
  const repository = open(path)
  const result = submitTask(repository, validProposal(), provenance)
  if (result.status !== "submitted") throw new Error("Submission failed")
  const sameProject = open(path)
  const otherProject = open(path, "/other")
  expect(sameProject.get(result.taskID)?.provenance.workspaceDirectory).toBe("/repo/worktree")
  expect(otherProject.get(result.taskID)).toBeUndefined()
  expect(otherProject.list()).toEqual([])
  expect(() => otherProject.insert(repository.get(result.taskID))).toThrow("provenance")
})

test("a newer database version fails without resetting migration metadata", () => {
  const path = join(directory(), "tasks.sqlite")
  const db = new Database(path)
  db.exec("PRAGMA user_version = 99")
  db.close()
  expect(() => new TaskRepository(path, "/repo")).toThrow("version 99")
  const check = new Database(path)
  expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: 99 })
  check.close()
})

test("storage path honors an explicit directory and rejects a relative override", () => {
  expect(taskDatabasePath("/tmp/lazers")).toBe("/tmp/lazers/tasks.sqlite")
  expect(() => taskDatabasePath("relative")).toThrow("absolute")
})

test("Git provenance distinguishes unborn HEAD, committed HEAD, and an inaccessible repository", () => {
  const path = directory()
  expect(() => startingRevision(path)).toThrow("starting revision")
  expect(spawnSync("git", ["init", "--initial-branch=main", path]).status).toBe(0)
  expect(startingRevision(path)).toEqual({ kind: "unborn" })
  expect(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=LAZERS test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: path },
    ).status,
  ).toBe(0)
  expect(startingRevision(path).kind).toBe("git")
})
