import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { TaskReads } from "./read.ts"
import { Schema } from "effect"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-reads-"))
  const path = join(directory, "tasks.sqlite")
  const repositories: TaskRepository[] = []
  const open = (project = "/project") => {
    const repository = new TaskRepository(path, project)
    repositories.push(repository)
    return repository
  }
  cleanups.push(() => {
    for (const repository of repositories) repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { open, path }
}
function insert(
  repository: TaskRepository,
  objective = "Implement bounded tasks.",
  sessionID = "session-a",
) {
  const proposal = validProposal()
  proposal.objective = objective
  proposal.writeScope = ["src/tasks/**"]
  proposal.acceptance[0]!.assertion = "Acceptance needle λ_%"
  proposal.context[0]!.reference = "Context needle λ_%"
  return repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-10-31T00:00:00.000Z",
    provenance: {
      projectID: "global",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: "/worktree",
      sessionID,
      startingRevision: { kind: "unborn" },
    },
    proposal,
  })
}

test("older records, literal filters, sessions and keyset snapshots stay bounded and isolated", () => {
  const { open } = fixture()
  const repository = open()
  const otherConnection = open()
  const otherProject = open("/other")
  const older = insert(repository, "Literal λ_% ' OR 1=1 --")
  for (let i = 0; i < 125; i++) insert(repository, `Task ${i}`, i % 2 ? "session-a" : "session-b")
  const foreign = insert(otherProject, "Literal λ_% ' OR 1=1 --")
  const reads = new TaskReads(repository)
  expect(reads.query({ search: older.id }).tasks.map((task) => task.taskID)).toEqual([older.id])
  expect(reads.query({ search: "λ_% ' OR 1=1 --" }).count).toBe(1)
  expect(reads.query({ search: "Acceptance needle λ_%", scopePath: "tasks/**" }).count).toBe(126)
  expect(reads.query({ search: "Context needle λ_%" }).count).toBe(126)
  expect(reads.query({ sessionID: "session-b" }).count).toBe(63)
  expect(reads.get({ taskID: foreign.id })).toEqual({ status: "not_found" })
  expect(reads.get({ taskID: older.id, sessionID: "session-b" })).toEqual({ status: "not_found" })
  expect(reads.get({ taskID: older.id, revision: 2 })).toEqual({
    status: "revision_unavailable",
    revision: 1,
  })
  const page = reads.query({ limit: 17 })
  const ids = page.tasks.map((task) => task.taskID)
  const inserted = insert(otherConnection, "Concurrent insert")
  let cursor = page.nextCursor
  while (cursor) {
    const next = reads.query({ limit: 17, cursor })
    expect(next.snapshot).toBe(page.snapshot)
    expect(next.count).toBe(126)
    ids.push(...next.tasks.map((task) => task.taskID))
    cursor = next.nextCursor
  }
  expect(ids).toHaveLength(126)
  expect(new Set(ids).size).toBe(126)
  expect(ids).not.toContain(inserted.id)
  expect(reads.query({}).count).toBe(127)
  expect(() => reads.query({ cursor: page.nextCursor!, search: "changed" })).toThrow(
    "does not match",
  )
  expect(() => new TaskReads(otherProject).query({ cursor: page.nextCursor! })).toThrow(
    "does not match",
  )
  for (const input of [
    { cursor: "bad" },
    { limit: 101 },
    { search: "a".repeat(201) },
    { worker: "fiction" },
  ])
    expect(() => reads.query(input)).toThrow()
})

test("read observers cannot invalidate a committed receipt and a fresh process preserves the watermark", () => {
  const { open, path } = fixture()
  const repository = open()
  let called = 0
  const unsubscribe = repository.subscribe(() => {
    called++
    throw new Error("notification lost")
  })
  const original = insert(repository)
  expect(called).toBe(1)
  expect(repository.get(original.id)).toEqual(original)
  const version = repository.version()
  const worker = spawnSync(
    process.execPath,
    [
      "-e",
      `
    import { TaskRepository } from ${JSON.stringify(new URL("../storage.ts", import.meta.url).pathname)};
    const repository = new TaskRepository(process.argv[1], "/project");
    const task = JSON.parse(process.argv[2]); task.id = crypto.randomUUID(); repository.insert(task); repository.close();
  `,
      path,
      JSON.stringify(original),
    ],
    { encoding: "utf8" },
  )
  expect(worker.status).toBe(0)
  expect(repository.version()).toBeGreaterThan(version)
  expect(new TaskReads(open()).query({}).count).toBe(2)
  unsubscribe()
  insert(repository)
  expect(called).toBe(1)
  expect(() => repository.insert({})).toThrow()
  expect(called).toBe(1)
})

test("unplanned detail is encodable by the native JSON RPC boundary", () => {
  const { open } = fixture()
  const repository = open()
  const task = insert(repository)
  const detail = new TaskReads(repository).get({ taskID: task.id })
  expect(Schema.is(Schema.Json)(detail)).toBe(true)
  expect(Object.hasOwn(detail, "execution")).toBe(false)
})
