import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keyedProposal, validProposal } from "../../test/proposal.ts"
import { nativeTools } from "../../test/retry-process.ts"
import { TaskRepository } from "../storage.ts"
import { submitTask } from "../submission.ts"
import { recordTaskAdvice } from "./advice.ts"
import { guardedWrite } from "./observed-revisions.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-observed-"))
  const path = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(path, "/repo")
  cleanups.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  // A legacy task has no classification records, so every session starts at revision 0.
  const { classification: _classification, ...legacyProposal } = validProposal()
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-03T00:00:00.000Z",
    provenance: {
      projectID: "p",
      projectDirectory: "/repo",
      workspaceDirectory: "/repo",
      sessionID: "s",
      startingRevision: { kind: "unborn" as const },
    },
    proposal: legacyProposal,
  })
  return { repository, taskID: task.id }
}

const classify = (taskID: string, requestID: string, primaryKind = "testing") => ({
  taskID,
  requestID,
  classification: { taxonomy: "task-kind/v1", primaryKind },
  reason: "Observed-revision probe.",
})

test("classification: a first write needs no read; a read lets the same session write again", async () => {
  const { repository, taskID } = fixture()
  const a = await nativeTools(repository, { session: "a" })
  expect((await a.call("lz-classify-task", classify(taskID, "c1"))).status).toBe("recorded")
  // The receipt is the session's observation of its own write.
  expect((await a.call("lz-classify-task", classify(taskID, "c2", "bug-repair"))).status).toBe(
    "recorded",
  )
})

test("classification: a write after another session's write conflicts until the session re-inspects", async () => {
  const { repository, taskID } = fixture()
  const a = await nativeTools(repository, { session: "a" })
  const b = await nativeTools(repository, { session: "b" })
  expect((await a.call("lz-classify-task", classify(taskID, "a1"))).status).toBe("recorded")
  const stale = await b.call("lz-classify-task", classify(taskID, "b1", "bug-repair"))
  expect(stale).toMatchObject({ status: "conflict", expectedRevision: 0, currentRevision: 1 })
  expect(stale.message).toContain("lz-get-task")
  expect(stale.message).toContain("new requestID")
  expect(repository.taskClassification(taskID)!.history.map((item) => item.revision)).toEqual([
    0, 1,
  ])
  // Re-inspect, then the same session succeeds.
  expect((await b.call("lz-get-task", { taskID, format: "structured" })).status).toBe("found")
  expect((await b.call("lz-classify-task", classify(taskID, "b2", "bug-repair"))).status).toBe(
    "recorded",
  )
  // The earlier writer is now stale in turn.
  expect(await a.call("lz-classify-task", classify(taskID, "a2", "refactoring"))).toMatchObject({
    status: "conflict",
    expectedRevision: 1,
    currentRevision: 2,
  })
})

test("classification: reading before the other session writes still goes stale", async () => {
  const { repository, taskID } = fixture()
  const a = await nativeTools(repository, { session: "a" })
  const b = await nativeTools(repository, { session: "b" })
  await b.call("lz-get-task", { taskID, format: "structured" })
  await a.call("lz-classify-task", classify(taskID, "a1"))
  expect(await b.call("lz-classify-task", classify(taskID, "b1", "bug-repair"))).toMatchObject({
    status: "conflict",
    expectedRevision: 0,
    currentRevision: 1,
  })
})

test("a same-requestID replay still replays from a session with no observation", async () => {
  const { repository, taskID } = fixture()
  const a = await nativeTools(repository, { session: "a" })
  const b = await nativeTools(repository, { session: "b" })
  const first = await a.call("lz-classify-task", classify(taskID, "same"))
  await a.call("lz-classify-task", classify(taskID, "later", "bug-repair"))
  expect(await b.call("lz-classify-task", classify(taskID, "same"))).toEqual({
    status: "replayed",
    annotation: first.annotation,
  })
})

test("correction: stale session conflicts; lz-inspect-task-corrections refreshes it", async () => {
  const { repository, taskID } = fixture()
  const other = submitTask(repository, keyedProposal("observed-original"), () => ({
    projectID: "p",
    projectDirectory: "/repo",
    workspaceDirectory: "/repo",
    sessionID: "s",
    startingRevision: { kind: "unborn" as const },
  }))
  if (other.status !== "submitted") throw new Error("Expected submitted task")
  const a = await nativeTools(repository, { session: "a" })
  const b = await nativeTools(repository, { session: "b" })
  const link = (requestID: string, originalTaskID: string | null) => ({
    taskID,
    originalTaskID,
    requestID,
    reason: "Observed-revision probe.",
  })
  expect((await a.call("lz-correct-task", link("k1", other.taskID))).status).toBe("recorded")
  const stale = await b.call("lz-correct-task", link("k2", null))
  expect(stale).toMatchObject({ status: "conflict", expectedRevision: 0, currentRevision: 1 })
  expect(stale.message).toContain("lz-inspect-task-corrections")
  await b.call("lz-inspect-task-corrections", { taskID })
  expect((await b.call("lz-correct-task", link("k2", null))).status).toBe("recorded")
})

test("advice: read-then-write succeeds, another session's write makes the next one conflict", () => {
  const { repository, taskID } = fixture()
  const advice = (requestID: string, sessionID: string) => (expectedRevision: number) =>
    recordTaskAdvice(
      repository,
      {
        taskID,
        requestID,
        expectedRevision,
        findings: ["f"],
        implementationAdvice: ["i"],
        references: [],
      },
      { sessionID, agent: "architect" },
    )
  const scope = (sessionID: string) => ({
    sessionID,
    taskID,
    kind: "advice" as const,
    recordKey: "advice",
  })
  expect(guardedWrite(repository, scope("a"), advice("adv-1", "a")).status).toBe("recorded")
  expect(guardedWrite(repository, scope("b"), advice("adv-2", "b"))).toMatchObject({
    status: "conflict",
    expectedRevision: 0,
    currentRevision: 1,
  })
  expect(guardedWrite(repository, scope("a"), advice("adv-3", "a")).status).toBe("recorded")
})

test("a session that submitted a classified task may correct it without a separate read", async () => {
  const { repository } = fixture()
  const a = await nativeTools(repository, { session: "submitter", workspace: process.cwd() })
  const b = await nativeTools(repository, { session: "other" })
  const submitted = await a.call("lz-submit-task", keyedProposal("observed-submit"))
  expect(submitted.status).toBe("submitted")
  const current = repository.taskClassification(submitted.taskID)!.current.revision
  expect(
    (await a.call("lz-classify-task", classify(submitted.taskID, "own", "bug-repair"))).status,
  ).toBe("recorded")
  const blind = await b.call("lz-classify-task", classify(submitted.taskID, "blind"))
  expect(blind).toMatchObject({ status: "conflict", expectedRevision: 0 })
  expect(blind.currentRevision).toBeGreaterThanOrEqual(current)
})
