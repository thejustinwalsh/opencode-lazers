import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository, acquireSharedConnection } from "../storage.ts"
import { TaskSpecSchema } from "../task.ts"
import type { TaskClassification } from "../task-classification.ts"
import { openReadOnlyTaskClassifications } from "./classification.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-classification-"))
  const path = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(path, "/project")
  cleanups.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, path, repository }
}

function addLegacyTask(repository: TaskRepository) {
  const { classification: _classification, ...proposal } = validProposal()
  return repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-03T00:00:00.000Z",
    provenance: {
      projectID: "project",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: "/worktree",
      sessionID: "submitter",
      startingRevision: { kind: "unborn" },
    },
    proposal,
  })
}

const kind = (primaryKind: TaskClassification["primaryKind"]): TaskClassification => ({
  taxonomy: "task-kind/v1" as const,
  primaryKind,
})

test("legacy annotation, embedded baseline and corrections have independent contiguous revisions", () => {
  const { repository } = fixture()
  const legacy = addLegacyTask(repository)
  const bodyBefore = repository.atomic(
    (db) =>
      db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(legacy.id)!
        .body,
  )
  const unclassified = repository.taskClassification(legacy.id)!
  expect(unclassified).toEqual({
    current: {
      revision: 0,
      classification: null,
      provenance: { kind: "legacy" },
    },
    history: [
      {
        revision: 0,
        classification: null,
        provenance: { kind: "legacy" },
      },
    ],
  })

  const firstInput = {
    taskID: legacy.id,
    requestID: "legacy-kind-1",
    expectedRevision: 0,
    classification: kind("bug-repair"),
    reason: "The acceptance boundary corrects an existing defect.",
  }
  const first = repository.recordTaskClassification(firstInput, {
    sessionID: "trusted-architect-session",
    agent: "architect",
  })
  expect(first.status).toBe("recorded")
  if (first.status !== "recorded") throw new Error("Expected first annotation")
  expect(first.annotation).toMatchObject({
    taskID: legacy.id,
    requestID: firstInput.requestID,
    revision: 1,
    classification: kind("bug-repair"),
    sessionID: "trusted-architect-session",
    agent: "architect",
  })

  const correction = repository.recordTaskClassification(
    {
      ...firstInput,
      requestID: "legacy-kind-correction",
      expectedRevision: 1,
      classification: kind("testing"),
      reason: "The tests are the primary deliverable after review.",
    },
    { sessionID: "correcting-session", agent: "architect" },
  )
  expect(correction.status).toBe("recorded")
  if (correction.status !== "recorded") throw new Error("Expected correction")
  expect(correction.annotation.revision).toBe(2)
  const snapshot = repository.taskClassification(legacy.id)!
  expect(snapshot.current).toEqual(snapshot.history.at(-1)!)
  expect(snapshot.current).toMatchObject({ revision: 2, classification: kind("testing") })
  expect(snapshot.history.map((item) => item.revision)).toEqual([0, 1, 2])
  expect(snapshot.history[1]).toMatchObject({
    revision: first.annotation.revision,
    classification: first.annotation.classification,
    provenance: {
      kind: "annotation",
      requestID: first.annotation.requestID,
      sessionID: first.annotation.sessionID,
      agent: first.annotation.agent,
      reason: first.annotation.reason,
      createdAt: first.annotation.createdAt,
    },
  })
  expect(
    repository.atomic(
      (db) =>
        db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(legacy.id)!
          .body,
    ),
  ).toBe(bodyBefore)

  const embeddedTask = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-03T00:00:00.000Z",
    provenance: {
      projectID: "project",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: "/worktree",
      sessionID: "author-session",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  })
  const embedded = repository.taskClassification(embeddedTask.id)!
  expect(embedded.current).toMatchObject({
    revision: 1,
    classification: validProposal().classification,
    provenance: { kind: "embedded", sessionID: "author-session" },
  })
  const updated = repository.recordTaskClassification(
    {
      taskID: embeddedTask.id,
      requestID: "embedded-correction",
      expectedRevision: 1,
      classification: kind("refactoring"),
      reason: "The objective is behavior-preserving restructuring.",
    },
    { sessionID: "architect", agent: "architect" },
  )
  expect(updated.status).toBe("recorded")
  expect(
    repository.taskClassification(embeddedTask.id)?.history.map((item) => item.revision),
  ).toEqual([1, 2])
})

test("read-only classification reads tolerate a missing annotation table without migration or file creation", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-readonly-classification-"))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "legacy.sqlite")
  const { classification: _classification, ...proposal } = validProposal()
  const task = TaskSpecSchema.parse({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-03T00:00:00.000Z",
    provenance: {
      projectID: "project",
      projectDirectory: "/legacy-project",
      workspaceDirectory: "/legacy-project",
      sessionID: "legacy-session",
      startingRevision: { kind: "unborn" },
    },
    proposal,
  })
  const legacy = new Database(path)
  legacy.exec(
    "CREATE TABLE tasks(id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL); PRAGMA user_version=5",
  )
  legacy
    .query("INSERT INTO tasks VALUES(?,?,?,?)")
    .run(task.id, "/legacy-project", task.createdAt, JSON.stringify(task))
  const schemaBefore = legacy
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
  legacy.close()

  const reader = openReadOnlyTaskClassifications(
    acquireSharedConnection(path, "readonly"),
    "/legacy-project",
  )
  try {
    expect(reader.read(task.id)?.classification).toEqual({
      current: { revision: 0, classification: null, provenance: { kind: "legacy" } },
      history: [{ revision: 0, classification: null, provenance: { kind: "legacy" } }],
    })
  } finally {
    reader.close()
  }
  const check = new Database(path, { readonly: true, strict: true })
  try {
    expect(
      check
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all(),
    ).toEqual(schemaBefore)
    expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: 5 })
  } finally {
    check.close()
  }
  const missingPath = join(directory, "missing.sqlite")
  expect(() =>
    openReadOnlyTaskClassifications(
      acquireSharedConnection(missingPath, "readonly"),
      "/legacy-project",
    ),
  ).toThrow()
  expect(existsSync(missingPath)).toBe(false)
})
