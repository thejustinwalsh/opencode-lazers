import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keyedProposal, validProposal } from "../test/proposal.ts"
import type { RetryProcessOptions } from "../test/retry-process.ts"
import { TaskRepository } from "./storage.ts"
import { submitTask } from "./submission.ts"
import type { TaskSpec } from "./task.ts"
import { fingerprint } from "./identity.ts"
import { openReadOnlyTaskCorrections } from "./tasks/corrections.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-retry-"))
  directories.push(directory)
  const path = join(directory, "tasks.sqlite")
  const provenance = () => ({
    projectID: "p",
    projectDirectory: "/repo",
    workspaceDirectory: "/repo",
    sessionID: "s",
    startingRevision: { kind: "unborn" as const },
  })
  return { path, directory, provenance }
}
function open(path: string, project = "/repo") {
  const repository = new TaskRepository(path, project)
  repositories.push(repository)
  return repository
}
function counts(path: string) {
  const db = new Database(path)
  try {
    return {
      tasks: db.query<{ n: number }, []>("SELECT count(*) AS n FROM tasks").get()!.n,
      keys: db.query<{ n: number }, []>("SELECT count(*) AS n FROM submission_requests").get()!.n,
    }
  } finally {
    db.close()
  }
}
function noProvenance(): never {
  throw new Error("Must not recollect provenance")
}

test("lost receipts and reordered nested objects replay the unchanged original after reopening", () => {
  const { path, provenance } = fixture()
  const repository = open(path)
  submitTask(repository, keyedProposal(), provenance) // Simulate losing the receipt.
  const original = repository.list()[0]!
  repository.close()
  const reopened = open(path)
  const reordered = JSON.parse(
    JSON.stringify(keyedProposal(), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    ),
  )
  expect(submitTask(reopened, reordered, noProvenance)).toEqual({
    status: "submitted",
    taskID: original.id,
    reference: "LZ-1",
    revision: original.revision,
  })
  expect(reopened.get(original.id)).toEqual(original)
  expect(reopened.get("LZ-1")).toEqual(original)
  expect(reopened.referenceFor(original.id)).toBe("LZ-1")
  expect(original.proposal).not.toHaveProperty("idempotencyKey")
  expect(counts(path)).toEqual({ tasks: 1, keys: 1 })
})

test("changed values and array order conflict; distinct exact keys and canonical repositories are independent", () => {
  const { path, provenance } = fixture()
  const repository = open(path)
  const first = submitTask(repository, keyedProposal(), provenance)
  if (first.status !== "submitted") throw new Error("Expected submission")
  const original = repository.get(first.taskID)
  for (const change of [
    { objective: "Different intent" },
    { classification: { taxonomy: "task-kind/v1", primaryKind: "testing" } },
    { writeScope: [...validProposal().writeScope].reverse() },
    { requirements: { ...validProposal().requirements, risk: "high" } },
  ]) {
    expect(submitTask(repository, { ...keyedProposal(), ...change }, noProvenance)).toEqual({
      status: "conflict",
      message: "idempotencyKey already identifies different validated content",
    })
  }
  expect(repository.get(first.taskID)).toEqual(original)
  const shared = open(path)
  expect(submitTask(shared, keyedProposal(), noProvenance)).toEqual(first)
  const keys = ["new", " new", "new ", "NEW", "é", "e\u0301"]
  const ids = new Set([first.taskID])
  for (const key of keys) {
    const result = submitTask(repository, keyedProposal(key), provenance)
    if (result.status !== "submitted") throw new Error("Expected distinct key submission")
    ids.add(result.taskID)
  }
  expect(ids.size).toBe(keys.length + 1)
  const other = open(path, "/other")
  expect(other.get(first.taskID)).toBeUndefined()
  expect(other.list()).toEqual([])
  const separate = submitTask(other, { ...keyedProposal(), objective: "Other repo" }, () => ({
    ...provenance(),
    projectDirectory: "/other",
  }))
  if (separate.status !== "submitted") throw new Error("Expected independent namespace")
  expect(repository.get(separate.taskID)).toBeUndefined()
  expect(other.list().map((task) => task.id)).toEqual([separate.taskID])
})

test("invalid keys/proposals and provenance failures never reserve a key", () => {
  const { path, provenance } = fixture()
  const repository = open(path)
  for (const idempotencyKey of [undefined, "", " \n", "a".repeat(201), 1]) {
    const result = submitTask(repository, { ...validProposal(), idempotencyKey }, noProvenance)
    expect(result.status).toBe("invalid")
    if (result.status === "invalid") expect(result.errors[0]?.path).toBe("idempotencyKey")
  }
  const invalid = submitTask(repository, { ...keyedProposal(), verification: [] }, noProvenance)
  expect(invalid.status).toBe("invalid")
  if (invalid.status === "invalid")
    expect(invalid.errors[0]?.path).toBe("acceptance.0.evidence.0.verificationID")
  expect(counts(path)).toEqual({ tasks: 0, keys: 0 })
  expect(() => submitTask(repository, keyedProposal(), noProvenance)).toThrow("provenance")
  expect(counts(path)).toEqual({ tasks: 0, keys: 0 })
  expect(submitTask(repository, keyedProposal(), provenance).status).toBe("submitted")
})

test("fresh requests require an explicit kind while exact unclassified historical replay stays unchanged", () => {
  const { path, provenance } = fixture()
  const repository = open(path)
  const { classification: _classification, idempotencyKey, ...legacyProposal } = keyedProposal()
  const legacySubmission = { ...legacyProposal, idempotencyKey }
  const freshMissing = submitTask(repository, legacySubmission, noProvenance)
  expect(freshMissing).toEqual({
    status: "invalid",
    errors: [
      {
        path: "classification",
        message: "Choose one explicit task-kind/v1 primaryKind for a new task",
      },
    ],
  })
  expect(counts(path)).toEqual({ tasks: 0, keys: 0 })

  const task: TaskSpec = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-03T00:00:00.000Z",
    provenance: provenance(),
    proposal: legacyProposal,
  }
  repository.insert(task)
  repository.atomic((db) => {
    db.query(
      "INSERT INTO submission_requests(project_directory,request_id,fingerprint,task_id) VALUES (?,?,?,?)",
    ).run("/repo", idempotencyKey, fingerprint(legacyProposal), task.id)
  })
  expect(
    repository.recordTaskClassification(
      {
        taskID: task.id,
        requestID: "annotate-before-legacy-replay",
        expectedRevision: 0,
        classification: { taxonomy: "task-kind/v1", primaryKind: "maintenance" },
        reason: "Reviewed historical task classification.",
      },
      { sessionID: "architect", agent: "architect" },
    ).status,
  ).toBe("recorded")

  expect(submitTask(repository, legacySubmission, noProvenance)).toEqual({
    status: "submitted",
    taskID: task.id,
    reference: repository.referenceFor(task.id)!,
    revision: task.revision,
  })
  expect(
    submitTask(
      repository,
      {
        ...legacySubmission,
        classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
      },
      noProvenance,
    ),
  ).toEqual({
    status: "conflict",
    message: "idempotencyKey already identifies different validated content",
  })
  expect(repository.get(task.id)).toEqual(task)
  expect(counts(path)).toEqual({ tasks: 1, keys: 1 })
})

test("a failed association write rolls back task, key and change stream; retry succeeds", () => {
  const { path, provenance } = fixture()
  const repository = open(path)
  let notifications = 0
  repository.subscribe(() => {
    notifications++
  })
  const db = new Database(path)
  try {
    db.exec(`CREATE TRIGGER fail_association BEFORE INSERT ON submission_requests BEGIN
      SELECT RAISE(ABORT, 'injected association failure'); END;`)
    expect(() => submitTask(repository, keyedProposal(), provenance)).toThrow(
      "injected association failure",
    )
    expect(counts(path)).toEqual({ tasks: 0, keys: 0 })
    expect(repository.version()).toBe(0)
    expect(notifications).toBe(0)
    db.exec("DROP TRIGGER fail_association")
    let observed: ReturnType<typeof counts> | undefined
    repository.subscribe(() => {
      observed = counts(path)
      throw new Error("Read observer cannot discard a committed receipt")
    })
    expect(submitTask(repository, keyedProposal(), provenance).status).toBe("submitted")
    expect(observed!).toEqual({ tasks: 1, keys: 1 })
    expect(notifications).toBe(1)
    expect(counts(path)).toEqual({ tasks: 1, keys: 1 })
    expect(submitTask(repository, keyedProposal(), noProvenance).status).toBe("submitted")
    expect(notifications).toBe(1)
  } finally {
    db.close()
  }
})

const processScript = new URL("../test/retry-process.ts", import.meta.url).pathname
function child(options: RetryProcessOptions, ready?: () => void) {
  return Bun.spawn([process.execPath, processScript, JSON.stringify(options)], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
    ...(ready
      ? {
          ipc: (message: unknown) => {
            if (message === "ready") ready()
          },
        }
      : {}),
  })
}
async function output(process: ReturnType<typeof child>) {
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  expect(exit, stderr).toBe(0)
  return stdout
}

test("fresh native-tool processes recover a lost receipt across session/worktree/HEAD changes", async () => {
  const { path, directory } = fixture()
  const project = join(directory, "project")
  expect(spawnSync("git", ["init", "--initial-branch=main", project]).status).toBe(0)
  const options = { path, project, workspace: project, session: "original", input: keyedProposal() }
  expect(await output(child({ ...options, discard: true }))).toBe("")
  const repository = open(path, project)
  const original = repository.list()[0]!
  repository.close()
  const retry = JSON.parse(
    await output(
      child({
        ...options,
        workspace: join(directory, "no-git-access"),
        session: "new-session",
        inspect: true,
      }),
    ),
  )
  expect(retry.receipt).toMatchObject({
    status: "submitted",
    taskID: original.id,
    reference: repository.referenceFor(original.id),
    revision: 1,
    title: validProposal().objective,
    goal: validProposal().objective,
    state: "submitted",
  })
  expect(retry.get.task).toEqual(original)
  expect(retry.list.tasks.map((task: { taskID: string }) => task.taskID)).toEqual([original.id])
  expect(open(path, project).get(original.id)).toEqual(original)
  expect(counts(path)).toEqual({ tasks: 1, keys: 1 })
}, 30_000)

async function race(options: RetryProcessOptions[], path: string, expectedCount = 1) {
  const children: ReturnType<typeof child>[] = []
  const ready = options.map(
    (option) =>
      new Promise<void>((resolve, reject) => {
        let reached = false
        const contender = child({ ...option, gate: true }, () => {
          reached = true
          resolve()
        })
        children.push(contender)
        void contender.exited.then(async () => {
          if (reached) return
          const error = await new Response(contender.stderr).text()
          reject(new Error(`Contender exited before release: ${error}`))
        })
      }),
  )
  try {
    await Promise.all(ready)
    for (const contender of children) contender.send("go")
    const results = await Promise.all(
      children.map(async (contender) => JSON.parse(await output(contender))),
    )
    expect(counts(path)).toEqual({ tasks: expectedCount, keys: expectedCount })
    return results
  } finally {
    for (const contender of children) contender.kill()
    await Promise.all(children.map((contender) => contender.exited))
  }
}

async function contend(options: RetryProcessOptions[]) {
  const children: ReturnType<typeof child>[] = []
  const ready = options.map(
    (option) =>
      new Promise<void>((resolve, reject) => {
        let reached = false
        const contender = child({ ...option, gate: true }, () => {
          reached = true
          resolve()
        })
        children.push(contender)
        void contender.exited.then(async () => {
          if (reached) return
          const error = await new Response(contender.stderr).text()
          reject(new Error(`Contender exited before release: ${error}`))
        })
      }),
  )
  try {
    await Promise.all(ready)
    for (const contender of children) contender.send("go")
    return await Promise.all(children.map(async (contender) => JSON.parse(await output(contender))))
  } finally {
    for (const contender of children) contender.kill()
    await Promise.all(children.map((contender) => contender.exited))
  }
}

test("independent native-tool connections racing the same content commit one task and association", async () => {
  const { path, directory } = fixture()
  expect(spawnSync("git", ["init", "--initial-branch=main", directory]).status).toBe(0)
  const options = {
    path,
    project: directory,
    workspace: directory,
    session: "race",
    input: keyedProposal(),
  }
  const results = await race([options, { ...options, session: "other" }], path)
  expect(results[0].status).toBe("submitted")
  expect(results[1]).toEqual(results[0])
}, 30_000)

test("independent native-tool connections racing changed content produce one winner and one conflict", async () => {
  const { path, directory } = fixture()
  expect(spawnSync("git", ["init", "--initial-branch=main", directory]).status).toBe(0)
  const options = {
    path,
    project: directory,
    workspace: directory,
    session: "race",
    input: keyedProposal(),
  }
  const results = await race(
    [
      options,
      {
        ...options,
        input: { ...keyedProposal(), objective: "Competing intent" },
      },
    ],
    path,
  )
  expect(results.map((result) => result.status).sort()).toEqual(["conflict", "submitted"])
  const winner = results.findIndex((result) => result.status === "submitted")
  const task = open(path, directory).list()[0]!
  expect(task.id).toBe(results[winner].taskID)
  expect(task.proposal.objective).toBe(
    winner === 0 ? validProposal().objective : "Competing intent",
  )
  expect(
    submitTask(open(path, directory), { ...keyedProposal(), ...task.proposal }, noProvenance),
  ).toMatchObject({
    status: "submitted",
    taskID: results[winner].taskID,
    reference: results[winner].reference,
    revision: 1,
  })
}, 30_000)

test("concurrent distinct submissions allocate unique project-local references", async () => {
  const { path, directory } = fixture()
  expect(spawnSync("git", ["init", "--initial-branch=main", directory]).status).toBe(0)
  const base = { path, project: directory, workspace: directory, session: "race" }
  const results = await race(
    [
      { ...base, input: keyedProposal("reference-a") },
      { ...base, input: keyedProposal("reference-b"), session: "other" },
    ],
    path,
    2,
  )
  expect(results.map((result) => result.status)).toEqual(["submitted", "submitted"])
  expect(new Set(results.map((result) => result.reference))).toEqual(new Set(["LZ-1", "LZ-2"]))
  const reopened = open(path, directory)
  expect(reopened.list()).toHaveLength(2)
  expect(new Set(reopened.list().map((task) => reopened.referenceFor(task.id)))).toEqual(
    new Set(["LZ-1", "LZ-2"]),
  )
}, 30_000)

test("concurrent stale classification corrections serialize to one commit and one conflict", async () => {
  const { path, provenance } = fixture()
  const repository = open(path)
  const { classification: _classification, ...legacyProposal } = validProposal()
  const task: TaskSpec = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-03T00:00:00.000Z",
    provenance: provenance(),
    proposal: legacyProposal,
  }
  repository.insert(task)
  const base = {
    path,
    project: "/repo",
    workspace: "/repo",
    action: "classify" as const,
  }
  const results = await contend([
    {
      ...base,
      session: "correction-a",
      input: {
        taskID: task.id,
        requestID: "concurrent-classification-a",
        expectedRevision: 0,
        classification: { taxonomy: "task-kind/v1", primaryKind: "bug-repair" },
        reason: "Existing defect is the primary outcome.",
      },
    },
    {
      ...base,
      session: "correction-b",
      input: {
        taskID: task.id,
        requestID: "concurrent-classification-b",
        expectedRevision: 0,
        classification: { taxonomy: "task-kind/v1", primaryKind: "testing" },
        reason: "Tests are the primary outcome.",
      },
    },
  ])
  expect(results.map((result) => result.status).sort()).toEqual(["conflict", "recorded"])
  expect(results.find((result) => result.status === "conflict")).toMatchObject({
    expectedRevision: 0,
    currentRevision: 1,
  })
  expect(repository.taskClassification(task.id)?.history.map((item) => item.revision)).toEqual([
    0, 1,
  ])
  expect(
    repository.atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string]>(
            "SELECT count(*) AS count FROM task_classifications WHERE project_directory=? AND task_id=?",
          )
          .get("/repo", task.id)!.count,
    ),
  ).toBe(1)
}, 30_000)

test("independent processes replay durable project-local correction receipts without rewriting provenance", async () => {
  const { path, provenance } = fixture()
  const repository = open(path)
  const root = submitTask(repository, keyedProposal("process-correction-root"), provenance)
  const correction = submitTask(repository, keyedProposal("process-correction-child"), provenance)
  if (root.status !== "submitted" || correction.status !== "submitted")
    throw new Error("Expected submitted correction tasks")
  const other = open(path, "/other")
  const otherRoot = submitTask(other, keyedProposal("other-correction-root"), () => ({
    ...provenance(),
    projectDirectory: "/other",
  }))
  const otherCorrection = submitTask(other, keyedProposal("other-correction-child"), () => ({
    ...provenance(),
    projectDirectory: "/other",
  }))
  if (otherRoot.status !== "submitted" || otherCorrection.status !== "submitted")
    throw new Error("Expected other-project tasks")

  const input = {
    taskID: correction.taskID,
    originalTaskID: root.taskID,
    requestID: "process-correction-request",
    expectedRevision: 0,
    reason: "The second accepted record corrects the original goal.",
  }
  const options = {
    path,
    project: "/repo",
    workspace: "/repo",
    session: "correction-session-original",
    action: "correct" as const,
    input,
  }
  repository.close()
  const first = JSON.parse(await output(child(options)))
  expect(first).toMatchObject({ status: "recorded", correction: { revision: 1 } })
  const replay = JSON.parse(
    await output(child({ ...options, session: "correction-session-replay" })),
  )
  expect(replay).toEqual({ status: "replayed", correction: first.correction })
  expect(first.correction).toMatchObject({
    sessionID: "correction-session-original",
    agent: "architect",
    requestID: input.requestID,
    reason: input.reason,
    taskID: correction.taskID,
    originalTaskID: root.taskID,
  })
  expect(
    JSON.parse(
      await output(
        child({
          ...options,
          session: "correction-session-changed",
          input: { ...input, reason: "Changed payload." },
        }),
      ),
    ),
  ).toMatchObject({ status: "conflict" })
  expect(
    JSON.parse(
      await output(
        child({
          ...options,
          session: "correction-session-stale",
          input: { ...input, requestID: "process-stale-correction" },
        }),
      ),
    ),
  ).toMatchObject({ status: "conflict", expectedRevision: 0, currentRevision: 1 })

  const independentProjectInput = {
    ...input,
    taskID: otherCorrection.taskID,
    originalTaskID: otherRoot.taskID,
  }
  expect(
    JSON.parse(
      await output(
        child({
          ...options,
          project: "/other",
          workspace: "/other",
          session: "other-project-session",
          input: independentProjectInput,
        }),
      ),
    ),
  ).toMatchObject({
    status: "recorded",
    correction: {
      taskID: otherCorrection.taskID,
      originalTaskID: otherRoot.taskID,
      revision: 1,
    },
  })

  const reopened = open(path)
  const reader = openReadOnlyTaskCorrections(path, "/repo")
  try {
    expect(reader.inspect(correction.taskID)).toMatchObject({
      status: "found",
      task: { rootTaskID: root.taskID },
      members: [root.taskID, correction.taskID]
        .sort()
        .map((taskID) => ({ taskID, rootTaskID: root.taskID })),
    })
    expect(reopened.get(root.taskID)?.provenance.sessionID).toBe("s")
    expect(reopened.get(correction.taskID)?.provenance.sessionID).toBe("s")
    expect(
      reopened.atomic(
        (db) =>
          db
            .query<{ count: number }, [string, string]>(
              "SELECT count(*) AS count FROM task_corrections WHERE project_directory=? AND task_id=?",
            )
            .get("/repo", correction.taskID)!.count,
      ),
    ).toBe(1)
  } finally {
    reader.close()
  }
}, 30_000)

test("independent processes serialize opposing links and atomically prevent a cross-task cycle", async () => {
  const { path, provenance } = fixture()
  const repository = open(path)
  const firstTask = submitTask(repository, keyedProposal("opposing-link-a"), provenance)
  const secondTask = submitTask(repository, keyedProposal("opposing-link-b"), provenance)
  if (firstTask.status !== "submitted" || secondTask.status !== "submitted")
    throw new Error("Expected submitted cycle endpoints")
  const base = {
    path,
    project: "/repo",
    workspace: "/repo",
    action: "correct" as const,
  }
  const results = await contend([
    {
      ...base,
      session: "opposing-session-a",
      input: {
        taskID: firstTask.taskID,
        originalTaskID: secondTask.taskID,
        requestID: "opposing-link-a",
        expectedRevision: 0,
        reason: "A corrects B.",
      },
    },
    {
      ...base,
      session: "opposing-session-b",
      input: {
        taskID: secondTask.taskID,
        originalTaskID: firstTask.taskID,
        requestID: "opposing-link-b",
        expectedRevision: 0,
        reason: "B corrects A.",
      },
    },
  ])
  expect(results.map((result) => result.status).sort()).toEqual(["error", "recorded"])
  expect(results.find((result) => result.status === "error")?.message).toContain("cycle")
  const reader = openReadOnlyTaskCorrections(path, "/repo")
  try {
    const snapshot = reader.read()
    const first = snapshot.tasks.find((task) => task.taskID === firstTask.taskID)!
    const second = snapshot.tasks.find((task) => task.taskID === secondTask.taskID)!
    expect(first.rootTaskID).toBe(second.rootTaskID)
    expect(first.memberTaskIDs).toEqual([firstTask.taskID, secondTask.taskID].sort())
    expect(new Set(first.memberTaskIDs).size).toBe(2)
    expect(
      repository.atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT count(*) AS count FROM task_corrections WHERE project_directory=?",
            )
            .get("/repo")!.count,
      ),
    ).toBe(1)
  } finally {
    reader.close()
  }
}, 30_000)

test("genuine v1 data migrates transactionally and mappings survive repeated reopening", () => {
  const { path, provenance } = fixture()
  const task: TaskSpec = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-01-01T00:00:00.000Z",
    provenance: provenance(),
    proposal: (({ classification: _classification, ...legacy }) => legacy)(validProposal()),
  }
  const body = JSON.stringify(task, null, 2)
  const legacy = new Database(path)
  legacy.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY, project_directory TEXT NOT NULL,
    created_at TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX tasks_project_created ON tasks(project_directory, created_at);
    PRAGMA user_version=1;`)
  legacy.query("INSERT INTO tasks VALUES(?,?,?,?)").run(task.id, "/repo", task.createdAt, body)
  legacy.close()
  let receipt: ReturnType<typeof submitTask> | undefined
  for (let index = 0; index < 3; index++) {
    const repository = open(path)
    expect(repository.get(task.id)).toEqual(task)
    expect(repository.list().find((stored) => stored.id === task.id)).toEqual(task)
    const result = submitTask(repository, keyedProposal(), index === 0 ? provenance : noProvenance)
    if (index === 0) receipt = result
    expect(result).toEqual(receipt!)
    repository.close()
    const db = new Database(path)
    try {
      expect(db.query("SELECT body FROM tasks WHERE id=?").get(task.id)).toEqual({ body })
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 8 })
    } finally {
      db.close()
    }
    expect(repository.referenceFor(task.id)).toBe("LZ-1")
    expect(result).toMatchObject({ status: "submitted", reference: "LZ-2" })
    expect(counts(path)).toEqual({ tasks: 2, keys: 1 })
  }
})

test("migration failure preserves v1 metadata/body and can be retried without partial DDL", () => {
  const { path } = fixture()
  const legacy = new Database(path)
  legacy.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY, project_directory TEXT NOT NULL,
    created_at TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE submission_requests(block_migration TEXT);
    PRAGMA user_version=1;`)
  try {
    expect(() => new TaskRepository(path, "/repo")).toThrow("already exists")
    expect(legacy.query("PRAGMA user_version").get()).toEqual({ user_version: 1 })
    expect(
      legacy
        .query<{ name: string }, []>("PRAGMA table_info(tasks)")
        .all()
        .map((row) => row.name),
    ).toEqual(["id", "project_directory", "created_at", "body"])
    expect(legacy.query("SELECT name FROM sqlite_master WHERE name='task_changes'").all()).toEqual(
      [],
    )
    legacy.exec("DROP TABLE submission_requests")
    expect(open(path).list()).toEqual([])
  } finally {
    legacy.close()
  }
})
