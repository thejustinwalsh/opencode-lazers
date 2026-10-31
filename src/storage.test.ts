import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { keyedProposal, validProposal } from "../test/proposal.ts"
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
  const result = submitTask(repository, keyedProposal(), provenance)
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
  const result = submitTask(repository, { ...keyedProposal(), verification: [] }, () => {
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
  const result = submitTask(repository, keyedProposal(), provenance)
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
  db.exec(
    "CREATE TABLE future_metadata(marker TEXT); INSERT INTO future_metadata VALUES ('preserve')",
  )
  db.close()
  expect(() => new TaskRepository(path, "/repo")).toThrow("version 99")
  const check = new Database(path)
  expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: 99 })
  expect(check.query("SELECT * FROM future_metadata").all()).toEqual([{ marker: "preserve" }])
  expect(check.query("SELECT name FROM sqlite_master WHERE name='tasks'").all()).toEqual([])
  check.close()
})

test("SQLite itself enforces key uniqueness and task association referential integrity", () => {
  const path = join(directory(), "tasks.sqlite")
  const repository = open(path)
  const result = submitTask(repository, keyedProposal(), provenance)
  if (result.status !== "submitted") throw new Error("Expected submission")
  repository.atomic((db) => {
    expect(() =>
      db
        .query("INSERT INTO submission_requests VALUES(?,?,?,?)")
        .run("/repo", "test-submission", "any", result.taskID),
    ).toThrow("UNIQUE")
    expect(() =>
      db
        .query("INSERT INTO submission_requests VALUES(?,?,?,?)")
        .run("/repo", "dangling-key", "any", crypto.randomUUID()),
    ).toThrow("FOREIGN KEY")
    expect(() => db.query("DELETE FROM tasks WHERE id=?").run(result.taskID)).toThrow("FOREIGN KEY")
    expect(db.query("SELECT count(*) AS n FROM submission_requests").get()).toEqual({ n: 1 })
  })
  expect(repository.list()).toHaveLength(1)
})

test("task dispositions are project-local, durable, idempotent, and hide retired records by default", () => {
  const path = join(directory(), "tasks.sqlite")
  const repository = open(path)
  const other = open(path, "/other")
  const first = submitTask(repository, keyedProposal(), provenance)
  if (first.status !== "submitted") throw new Error("Expected submission")
  const second = submitTask(
    repository,
    { ...keyedProposal(), idempotencyKey: "second" },
    provenance,
  )
  if (second.status !== "submitted") throw new Error("Expected submission")
  const input = {
    taskID: first.taskID,
    requestID: "legacy-cleanup-1",
    disposition: "superseded" as const,
    reason: "Replaced by the integrated runner plan.",
    evidence: [
      { kind: "artifact" as const, reference: ".agents/docs/spikes/011-runner-execution.md" },
    ],
    relatedTaskIDs: [second.taskID],
  }
  const recorded = repository.recordDisposition(input, {
    sessionID: "architect",
    agent: "architect",
  })
  expect(recorded.status).toBe("recorded")
  expect(repository.list()).toHaveLength(1)
  expect(repository.list(20, true)).toHaveLength(2)
  expect(repository.taskDisposition(first.taskID)?.disposition).toBe("superseded")
  expect(repository.taskDispositionHistory(first.taskID)).toHaveLength(1)
  expect(
    repository.recordDisposition(input, { sessionID: "other", agent: "architect" }).status,
  ).toBe("replayed")
  expect(
    repository.recordDisposition(
      { ...input, reason: "Changed reason" },
      { sessionID: "architect", agent: "architect" },
    ),
  ).toEqual({
    status: "conflict",
    taskID: first.taskID,
    message: "requestID already identifies different disposition content",
  })
  expect(() =>
    other.recordDisposition(input, { sessionID: "architect", agent: "architect" }),
  ).toThrow("not found in this project")
  repository.close()
  const reopened = open(path)
  expect(reopened.taskDisposition(first.taskID)?.reason).toContain("integrated runner")
  expect(reopened.list()).toHaveLength(1)
})

test("a disposition cannot hide active execution or claim failed work was fulfilled", () => {
  const path = join(directory(), "tasks.sqlite")
  const repository = open(path)
  const submitted = submitTask(repository, keyedProposal(), provenance)
  if (submitted.status !== "submitted") throw new Error("Expected submission")
  repository.atomic((db) => {
    db.exec(`
      CREATE TABLE runner_plans (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, owner TEXT NOT NULL,
        revision INTEGER NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
        body TEXT NOT NULL, model TEXT, reason TEXT, artifact TEXT
      );
      CREATE TABLE runner_nodes (
        plan_id TEXT NOT NULL, task_id TEXT NOT NULL, spec_revision INTEGER NOT NULL,
        ordinal INTEGER NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
        reason TEXT, artifact TEXT, snapshot TEXT NOT NULL, machine_version TEXT NOT NULL
      );
    `)
    db.query("INSERT INTO runner_plans VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      "plan",
      "/repo",
      "architect",
      1,
      1,
      "running",
      "{}",
      null,
      null,
      null,
    )
    db.query("INSERT INTO runner_nodes VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      "plan",
      submitted.taskID,
      1,
      0,
      "running",
      1,
      null,
      null,
      "{}",
      "v1",
    )
  })
  expect(() =>
    repository.recordDisposition(
      {
        taskID: submitted.taskID,
        requestID: "active",
        disposition: "rejected",
        reason: "Should not be accepted while running.",
        evidence: [{ kind: "human", reference: "review" }],
      },
      { sessionID: "architect", agent: "architect" },
    ),
  ).toThrow("active execution")
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
