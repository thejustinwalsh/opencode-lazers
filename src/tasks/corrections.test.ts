import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import { openReadOnlyTaskCorrections, readTaskCorrections } from "./corrections.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-corrections-read-"))
  const path = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(path, "/project")
  cleanups.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const addTask = (projectDirectory = "/project") => {
    const scoped =
      projectDirectory === repository.projectDirectory
        ? repository
        : new TaskRepository(path, projectDirectory)
    try {
      return scoped.insert({
        schemaVersion: 1,
        id: crypto.randomUUID(),
        revision: 1,
        status: "submitted",
        createdAt: "2026-11-04T00:00:00.000Z",
        provenance: {
          projectID: "project",
          projectDirectory,
          workspaceDirectory: projectDirectory,
          sessionID: "submitter",
          startingRevision: { kind: "unborn" },
        },
        proposal: validProposal(),
      })
    } finally {
      if (scoped !== repository) scoped.close()
    }
  }
  return { directory, path, repository, addTask }
}

function link(
  repository: TaskRepository,
  taskID: string,
  originalTaskID: string | null,
  requestID: string,
  expectedRevision: number,
) {
  return repository.recordTaskCorrection(
    {
      taskID,
      originalTaskID,
      requestID,
      expectedRevision,
      reason: `Reviewed ${requestID}.`,
    },
    { sessionID: "architect-session", agent: "architect" },
  )
}

test("effective roots follow explicit chains and branches across reassignment and retraction", () => {
  const { repository } = fixture()
  const rootA = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-04T00:00:00.000Z",
    provenance: {
      projectID: "project",
      projectDirectory: "/project",
      workspaceDirectory: "/project",
      sessionID: "submitter",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  })
  const rootB = repository.insert({
    ...rootA,
    id: crypto.randomUUID(),
    createdAt: "2026-11-04T00:00:01.000Z",
  })
  const correction = repository.insert({
    ...rootA,
    id: crypto.randomUUID(),
    createdAt: "2026-11-04T00:00:02.000Z",
  })
  const branch = repository.insert({
    ...rootA,
    id: crypto.randomUUID(),
    createdAt: "2026-11-04T00:00:03.000Z",
  })
  const leaf = repository.insert({
    ...rootA,
    id: crypto.randomUUID(),
    createdAt: "2026-11-04T00:00:04.000Z",
  })
  link(repository, correction.id, rootA.id, "read-link-a", 0)
  link(repository, branch.id, correction.id, "read-link-b", 0)
  link(repository, leaf.id, branch.id, "read-link-c", 0)

  const reader = openReadOnlyTaskCorrections(repository.path, "/project")
  try {
    const before = reader.read()
    expect(before.identity).toMatchObject({ storage: "available", revision: 3 })
    expect(before.tasks.find((task) => task.taskID === leaf.id)).toMatchObject({
      rootTaskID: rootA.id,
      memberTaskIDs: [rootA.id, correction.id, branch.id, leaf.id].sort(),
      relation: "linked",
      originalTaskID: branch.id,
      revision: 1,
    })
    link(repository, correction.id, rootB.id, "read-reassign", 1)
    const reassigned = reader.read()
    expect(reassigned.tasks.find((task) => task.taskID === leaf.id)?.rootTaskID).toBe(rootB.id)
    expect(reassigned.tasks.find((task) => task.taskID === correction.id)?.history).toHaveLength(2)
    expect(before.tasks.find((task) => task.taskID === leaf.id)?.rootTaskID).toBe(rootA.id)

    link(repository, correction.id, null, "read-retract", 2)
    const retracted = reader.read()
    expect(retracted.tasks.find((task) => task.taskID === correction.id)).toMatchObject({
      rootTaskID: correction.id,
      relation: "independent",
      originalTaskID: null,
      revision: 3,
      history: [
        { originalTaskID: rootA.id, revision: 1 },
        { originalTaskID: rootB.id, revision: 2 },
        { originalTaskID: null, revision: 3 },
      ],
    })
    expect(retracted.tasks.find((task) => task.taskID === leaf.id)?.rootTaskID).toBe(correction.id)
    expect(retracted.tasks.find((task) => task.taskID === rootA.id)?.memberTaskIDs).toEqual([
      rootA.id,
    ])
  } finally {
    reader.close()
  }
})

test("a pinned read-only SQLite snapshot hides concurrent correction writes until the next read", () => {
  const { repository } = fixture()
  const original = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-04T00:00:00.000Z",
    provenance: {
      projectID: "project",
      projectDirectory: "/project",
      workspaceDirectory: "/project",
      sessionID: "submitter",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  })
  const correction = repository.insert({
    ...original,
    id: crypto.randomUUID(),
    createdAt: "2026-11-04T00:00:01.000Z",
  })
  const readonly = new Database(repository.path, { readonly: true, strict: true })
  try {
    const pinned = readonly
      .transaction(() => {
        const before = readTaskCorrections(readonly, "/project")
        link(repository, correction.id, original.id, "pinned-relation", 0)
        const stillPinned = readTaskCorrections(readonly, "/project")
        return { before, stillPinned }
      })
      .deferred()
    expect(pinned.before.identity.revision).toBe(0)
    expect(pinned.stillPinned.identity.revision).toBe(0)
    expect(pinned.stillPinned.identity.taskRevision).toBe(pinned.before.identity.taskRevision)
    expect(pinned.stillPinned.tasks.find((task) => task.taskID === correction.id)).toMatchObject({
      rootTaskID: correction.id,
      relation: "unreviewed",
    })
    const next = readTaskCorrections(readonly, "/project")
    expect(next.identity.revision).toBeGreaterThan(pinned.before.identity.revision!)
    expect(next.tasks.find((task) => task.taskID === correction.id)).toMatchObject({
      rootTaskID: original.id,
      relation: "linked",
    })
    const laterTask = repository.insert({
      ...original,
      id: crypto.randomUUID(),
      createdAt: "2026-11-04T00:00:02.000Z",
    })
    const afterTaskInsert = readTaskCorrections(readonly, "/project")
    expect(afterTaskInsert.identity.revision).toBe(next.identity.revision)
    expect(afterTaskInsert.identity.taskRevision).toBeGreaterThan(next.identity.taskRevision!)
    expect(afterTaskInsert.tasks.find((task) => task.taskID === laterTask.id)).toMatchObject({
      rootTaskID: laterTask.id,
      relation: "unreviewed",
    })
  } finally {
    readonly.close()
  }
})

test("legacy missing correction tables are unreviewed, distinct from explicit independence, and read-only", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-corrections-legacy-"))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "legacy.sqlite")
  const taskID = crypto.randomUUID()
  const task = {
    schemaVersion: 1,
    id: taskID,
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-04T00:00:00.000Z",
    provenance: {
      projectID: "project",
      projectDirectory: "/legacy",
      workspaceDirectory: "/legacy",
      sessionID: "old-session",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  }
  const legacy = new Database(path)
  legacy.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY, project_directory TEXT NOT NULL,
    created_at TEXT NOT NULL, body TEXT NOT NULL); PRAGMA user_version=6;`)
  legacy
    .query("INSERT INTO tasks VALUES(?,?,?,?)")
    .run(taskID, "/legacy", task.createdAt, JSON.stringify(task))
  const tables = legacy
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
  legacy.close()

  const reader = openReadOnlyTaskCorrections(path, "/legacy")
  try {
    expect(reader.inspect(taskID)).toMatchObject({
      status: "found",
      identity: { storage: "missing-table", revision: null },
      task: {
        rootTaskID: taskID,
        relation: "unreviewed",
        revision: 0,
        history: [],
      },
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
    ).toEqual(tables)
    expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: 6 })
  } finally {
    check.close()
  }
  const missingPath = join(directory, "missing.sqlite")
  expect(() => openReadOnlyTaskCorrections(missingPath, "/legacy")).toThrow()
  expect(existsSync(missingPath)).toBe(false)
})

test("an explicit independence review has durable history distinct from unreviewed membership", () => {
  const { repository, addTask } = fixture()
  const task = addTask()
  const before = openReadOnlyTaskCorrections(repository.path, "/project")
  try {
    expect(before.inspect(task.id)).toMatchObject({
      identity: { storage: "available", revision: 0 },
      task: { relation: "unreviewed", rootTaskID: task.id, history: [] },
    })
  } finally {
    before.close()
  }
  repository.recordTaskCorrection(
    {
      taskID: task.id,
      originalTaskID: null,
      requestID: "review-independent-task",
      expectedRevision: 0,
      reason: "Reviewed as an independent evolution, not a correction.",
    },
    { sessionID: "independence-review", agent: "architect" },
  )
  const after = openReadOnlyTaskCorrections(repository.path, "/project")
  try {
    expect(after.inspect(task.id)).toMatchObject({
      identity: { storage: "available", revision: 1 },
      task: {
        relation: "independent",
        rootTaskID: task.id,
        revision: 1,
        history: [
          {
            requestID: "review-independent-task",
            sessionID: "independence-review",
            agent: "architect",
            reason: "Reviewed as an independent evolution, not a correction.",
          },
        ],
      },
    })
  } finally {
    after.close()
  }
})

test("correction reads isolate project scope and do not infer generic supplementary relations", () => {
  const { repository, path, addTask } = fixture()
  const localRoot = addTask()
  const localChild = addTask()
  const evolution = addTask()
  const foreignRoot = addTask("/other-project")
  const foreignChild = addTask("/other-project")
  repository.recordTaskCorrection(
    {
      taskID: localChild.id,
      originalTaskID: localRoot.id,
      requestID: "local-only-link",
      expectedRevision: 0,
      reason: "The acceptance goal is the same.",
    },
    { sessionID: "architect", agent: "architect" },
  )
  new RunnerStore(repository).submit(
    {
      requestID: "generic-supplement-not-correction",
      objective: "Independently extend an earlier model surface.",
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: evolution.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [evolution.id],
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
      dispositions: [
        {
          taskID: evolution.id,
          otherTaskID: localRoot.id,
          relation: "supplements",
          rationale: "This is related additional work, not a correction of the original goal.",
        },
      ],
    },
    "architect",
  )
  const foreignRepository = new TaskRepository(path, "/other-project")
  try {
    foreignRepository.recordTaskCorrection(
      {
        taskID: foreignChild.id,
        originalTaskID: foreignRoot.id,
        requestID: "foreign-project-correction",
        expectedRevision: 0,
        reason: "This project-local relation must not leak.",
      },
      { sessionID: "foreign-architect", agent: "architect" },
    )
    const read = openReadOnlyTaskCorrections(path, "/project")
    try {
      const snapshot = read.read()
      expect(snapshot.identity.revision).toBe(1)
      expect(snapshot.tasks.map((task) => task.taskID)).toEqual(
        [localRoot.id, localChild.id, evolution.id].sort(),
      )
      expect(snapshot.tasks.find((task) => task.taskID === localChild.id)?.rootTaskID).toBe(
        localRoot.id,
      )
      expect(
        snapshot.tasks.some((task) => [foreignRoot.id, foreignChild.id].includes(task.taskID)),
      ).toBe(false)
      expect(snapshot.tasks.find((task) => task.taskID === evolution.id)).toMatchObject({
        rootTaskID: evolution.id,
        relation: "unreviewed",
        memberTaskIDs: [evolution.id],
      })
    } finally {
      read.close()
    }
  } finally {
    foreignRepository.close()
  }
})
