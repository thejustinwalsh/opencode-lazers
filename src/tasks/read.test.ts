import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { TaskReads } from "./read.ts"
import { Schema } from "effect"
import { AssociationTaskReads } from "../observability/task-reads.ts"

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
  let finalTaskID = ""
  for (let i = 0; i < 125; i++) {
    const task = insert(repository, `Task ${i}`, i % 2 ? "session-a" : "session-b")
    if (i === 124) finalTaskID = task.id
  }
  const foreign = insert(otherProject, "Literal λ_% ' OR 1=1 --")
  const reads = new TaskReads(repository)
  expect(reads.query({ search: older.id }).tasks.map((task) => task.taskID)).toEqual([older.id])
  expect(reads.query({ search: "LZ-126" }).tasks[0]).toMatchObject({
    taskID: finalTaskID,
    reference: "LZ-126",
    matches: [{ field: "reference", snippet: "LZ-126" }],
  })
  expect(reads.get({ taskID: "LZ-1" })).toMatchObject({
    status: "found",
    reference: "LZ-1",
    task: { id: older.id },
  })
  expect(new TaskReads(otherProject).get({ taskID: "LZ-1" })).toMatchObject({
    status: "found",
    task: { id: foreign.id },
  })
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

test("retired tasks disappear from open queries but direct detail preserves disposition", () => {
  const { open } = fixture()
  const repository = open()
  const task = insert(repository, "Legacy task replaced by the runner.")
  repository.recordDisposition(
    {
      taskID: task.id,
      requestID: "retire-read-test",
      disposition: "superseded",
      reason: "The integrated runner plan replaces this record.",
      evidence: [{ kind: "artifact", reference: ".agents/docs/spikes/011-runner-execution.md" }],
    },
    { sessionID: "architect", agent: "architect" },
  )
  const reads = new TaskReads(repository)
  expect(reads.query({}).tasks).toEqual([])
  const history = reads.query({ includeRetired: true })
  expect(history.count).toBe(1)
  expect(history.tasks[0]?.disposition?.disposition).toBe("superseded")
  expect(history.tasks[0]?.reason).toContain("integrated runner")
  const detail = reads.get({ taskID: task.id })
  expect(detail).toMatchObject({ status: "found", disposition: { disposition: "superseded" } })
})

test("open tasks exclude cancelled plans while failed work remains actionable and history survives", () => {
  const repository = fixture().open()
  const reads = new TaskReads(repository)
  const tasks = ["cancelled", "running", "failed", "exhausted", "cleanup-blocked"].map((state) => {
    const task = insert(repository, `Failed worker in ${state} plan`)
    const proposal = validProposal()
    const plan = reads.runner.submit(
      {
        requestID: `plan-${state}`,
        objective: task.proposal.objective,
        baseCommit: "a".repeat(40),
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: proposal.verification,
        acceptance: proposal.acceptance,
      },
      "architect",
    )
    // Seed the recorded worker-interruption states, without dispatching a worker.
    repository.atomic((db) => {
      db.query("UPDATE runner_plans SET state=? WHERE id=?").run(state, plan.planID)
      db.query(
        "UPDATE runner_nodes SET state='failed',reason='Worker interrupted' WHERE plan_id=?",
      ).run(plan.planID)
    })
    return task
  })
  for (const reader of [reads, new AssociationTaskReads(repository)])
    for (const sessionID of [undefined, "session-a"]) {
      const open = reader.query({ sessionID })
      expect(open.count).toBe(4)
      expect(new Set(open.tasks.map((task) => task.taskID))).toEqual(
        new Set(tasks.slice(1).map((task) => task.id)),
      )
      const history = reader.query({ sessionID, includeCompleted: true })
      expect(history.count).toBe(5)
      expect(history.tasks.find((task) => task.taskID === tasks[0]!.id)).toMatchObject({
        status: "failed",
        reason: "Worker interrupted",
      })
    }
  expect(reads.get({ taskID: tasks[0]!.id })).toMatchObject({ status: "found" })
})
