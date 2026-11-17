import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { keyedProposal, validProposal } from "../test/proposal.ts"
import { TaskRepository, taskDatabasePath } from "./storage.ts"
import { startingRevision, submitTask } from "./submission.ts"
import { RunnerStore } from "./runner/store.ts"
import { ensureRetainedVerificationTables } from "./runner/retained-verification/store.ts"
import { openReadOnlyTaskCorrections } from "./tasks/corrections.ts"

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
  expect(result.reference).toBe("LZ-1")
  repository.close()
  const reopened = open(path)
  const task = reopened.get(result.taskID)!
  expect(task.id).toBe(result.taskID)
  expect(task.provenance).toEqual(provenance())
  expect(task.proposal).toEqual(validProposal())
  expect(task.status).toBe("submitted")
  expect(reopened.referenceFor(result.taskID)).toBe("LZ-1")
  expect(reopened.get("LZ-1")).toEqual(task)
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
  expect(sameProject.get(result.reference)?.id).toBe(result.taskID)
  expect(otherProject.get(result.taskID)).toBeUndefined()
  expect(otherProject.list()).toEqual([])
  expect(otherProject.get(result.reference)).toBeUndefined()
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

test("S2-4 module installation upgrades atomically, skips current generations and refuses future ones", () => {
  const repository = open(join(directory(), "modules.sqlite"))
  let installs = 0
  const install = () =>
    repository.installSchema("example", 1, ["example_rows"], (db) => {
      installs++
      db.exec("CREATE TABLE example_rows(value TEXT); INSERT INTO example_rows VALUES('retained')")
    })
  install()
  install()
  expect(installs).toBe(1)
  expect(() =>
    repository.installSchema("example", 2, ["example_rows", "failed_upgrade"], (db) => {
      db.exec("CREATE TABLE failed_upgrade(value TEXT)")
      throw new Error("Interrupted upgrade")
    }),
  ).toThrow("Interrupted upgrade")
  expect(
    repository.read((db) =>
      db.query("SELECT name FROM sqlite_master WHERE name='failed_upgrade'").get(),
    ),
  ).toBeNull()
  expect(
    repository.read((db) =>
      db.query("SELECT generation FROM schema_modules WHERE module='example'").get(),
    ),
  ).toEqual({ generation: 1 })
  repository.installSchema("example", 2, ["example_rows"], () => {})
  expect(() => install()).toThrow("Unsupported LAZERS schema module example generation 2")
  expect(repository.read((db) => db.query("SELECT * FROM example_rows").all())).toEqual([
    { value: "retained" },
  ])
})

test("S2-4 startup inventory reports three drift classes without mutating tables", () => {
  const repository = open(join(directory(), "inventory.sqlite"))
  repository.atomic((db) => {
    db.exec("CREATE TABLE legacy_orphan(value TEXT); INSERT INTO legacy_orphan VALUES('keep')")
    db.query("INSERT INTO schema_modules VALUES('runner',99,'[]',1)").run()
  })
  const drift = repository.schemaDrift()
  expect(drift.undeclaredTables).toContain("legacy_orphan")
  expect(drift.missingTables).toContain("runner_plans")
  expect(drift.generationDrift).toContainEqual({ module: "runner", installed: 99, declared: 5 })
  expect(repository.read((db) => db.query("SELECT * FROM legacy_orphan").all())).toEqual([
    { value: "keep" },
  ])
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

test("classification annotations use exact CAS replay and preserve every immutable or execution record", () => {
  const path = join(directory(), "tasks.sqlite")
  const repository = open(path)
  const submitted = submitTask(repository, keyedProposal(), provenance)
  if (submitted.status !== "submitted") throw new Error("Expected submitted task")
  const task = repository.get(submitted.taskID)!
  const runner = new RunnerStore(repository)
  const plan = runner.submit(
    {
      requestID: "classification-preserve-execution",
      objective: task.proposal.objective,
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: task.id, revision: task.revision }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
    },
    "architect",
  )
  repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='accepted' WHERE id=?").run(plan.planID)
    db.query("UPDATE runner_nodes SET state='accepted' WHERE plan_id=?").run(plan.planID)
  })
  const disposition = repository.recordDisposition(
    {
      taskID: task.id,
      requestID: "classification-preserve-disposition",
      disposition: "fulfilled",
      reason: "The accepted implementation was reviewed.",
      evidence: [{ kind: "verification", reference: "bun test" }],
    },
    { sessionID: "architect", agent: "architect" },
  )
  expect(disposition.status).toBe("recorded")
  const immutableBefore = repository.atomic((db) => ({
    body: db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(task.id)!
      .body,
    fingerprint: db
      .query<{ fingerprint: string }, [string, string]>(
        "SELECT fingerprint FROM submission_requests WHERE project_directory=? AND request_id=?",
      )
      .get("/repo", "test-submission")!.fingerprint,
  }))
  const before = {
    ...immutableBefore,
    execution: runner.execution(task.id),
    disposition: repository.taskDisposition(task.id),
  }
  let notifications = 0
  const unsubscribe = repository.subscribe(() => notifications++)
  const request = {
    taskID: task.id,
    requestID: "classification-correction-1",
    expectedRevision: 1,
    classification: { taxonomy: "task-kind/v1", primaryKind: "refactoring" },
    reason: "Review confirms behavior-preserving restructuring is the deliverable.",
  }
  const first = repository.recordTaskClassification(request, {
    sessionID: "trusted-session",
    agent: "architect",
  })
  expect(first.status).toBe("recorded")
  if (first.status !== "recorded") throw new Error("Expected recorded classification")
  expect(first.annotation).toMatchObject({
    revision: 2,
    sessionID: "trusted-session",
    agent: "architect",
  })
  expect(notifications).toBe(1)
  const version = repository.version()
  expect(
    repository.recordTaskClassification(request, { sessionID: "other", agent: "architect" }),
  ).toMatchObject({
    status: "replayed",
    annotation: first.annotation,
  })
  expect(notifications).toBe(1)
  expect(repository.version()).toBe(version)
  expect(
    repository.recordTaskClassification(
      { ...request, reason: "Different request content." },
      { sessionID: "trusted-session", agent: "architect" },
    ),
  ).toMatchObject({
    status: "conflict",
    message: "requestID already identifies different classification content",
  })
  expect(
    repository.recordTaskClassification(
      {
        ...request,
        requestID: "stale-classification",
        classification: { taxonomy: "task-kind/v1", primaryKind: "maintenance" },
      },
      { sessionID: "trusted-session", agent: "architect" },
    ),
  ).toMatchObject({ status: "conflict", expectedRevision: 1, currentRevision: 2 })
  expect(notifications).toBe(1)
  expect(repository.version()).toBe(version)

  const immutableAfter = repository.atomic((db) => ({
    body: db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(task.id)!
      .body,
    fingerprint: db
      .query<{ fingerprint: string }, [string, string]>(
        "SELECT fingerprint FROM submission_requests WHERE project_directory=? AND request_id=?",
      )
      .get("/repo", "test-submission")!.fingerprint,
  }))
  const after = {
    ...immutableAfter,
    execution: runner.execution(task.id),
    disposition: repository.taskDisposition(task.id),
  }
  expect(after).toEqual(before)
  expect(repository.get(task.id)).toEqual(task)
  expect(repository.taskClassification(task.id)?.current).toMatchObject({
    revision: 2,
    classification: request.classification,
  })
  unsubscribe()

  expect(() =>
    repository.atomic((db) =>
      db
        .query("UPDATE task_classifications SET reason='mutated' WHERE request_id=?")
        .run(request.requestID),
    ),
  ).toThrow("append-only")
  expect(() =>
    repository.atomic((db) =>
      db.query("DELETE FROM task_classifications WHERE request_id=?").run(request.requestID),
    ),
  ).toThrow("append-only")
})

test("correction audit persists with CAS replay and leaves physical accepted history untouched", () => {
  const path = join(directory(), "tasks.sqlite")
  const repository = open(path)
  const originalSubmission = submitTask(
    repository,
    keyedProposal("correction-original"),
    provenance,
  )
  const correctionSubmission = submitTask(repository, keyedProposal("correction-task"), provenance)
  const unfinishedSubmission = submitTask(
    repository,
    keyedProposal("unfinished-correction"),
    provenance,
  )
  const evolutionSubmission = submitTask(
    repository,
    keyedProposal("separate-evolution"),
    provenance,
  )
  if (
    originalSubmission.status !== "submitted" ||
    correctionSubmission.status !== "submitted" ||
    unfinishedSubmission.status !== "submitted" ||
    evolutionSubmission.status !== "submitted"
  )
    throw new Error("Expected submitted tasks")

  const original = repository.get(originalSubmission.taskID)!
  const correction = repository.get(correctionSubmission.taskID)!
  const unfinished = repository.get(unfinishedSubmission.taskID)!
  const evolution = repository.get(evolutionSubmission.taskID)!
  const runner = new RunnerStore(repository)
  const acceptedPlan = runner.submit(
    {
      requestID: "accepted-correction-fixture",
      objective: "Preserve both accepted physical task records.",
      baseCommit: "a".repeat(40),
      nodes: [
        { taskID: original.id, revision: 1 },
        { taskID: correction.id, revision: 1 },
      ],
      dependencies: [],
      integrationOrder: [original.id, correction.id],
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
    },
    "architect",
  )
  for (const [task, suffix] of [
    [original, "original"],
    [correction, "correction"],
  ] as const) {
    runner.move(acceptedPlan.planID, task.id, "READY")
    runner.move(acceptedPlan.planID, task.id, "DISPATCH")
    runner.move(acceptedPlan.planID, task.id, "VERIFY")
    runner.move(acceptedPlan.planID, task.id, "ACCEPT")
    runner.record(acceptedPlan.planID, task.id, "ARTIFACT_ACCEPTED", {
      artifact: `${suffix}-artifact`,
    })
  }
  repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='accepted', artifact='accepted-plan' WHERE id=?").run(
      acceptedPlan.planID,
    )
    const setArtifact = db.query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?")
    setArtifact.run("original-artifact", acceptedPlan.planID, original.id)
    setArtifact.run("correction-artifact", acceptedPlan.planID, correction.id)
    const attempt = db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,
        started_at,token_count,tool_count,retry_count,cost)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (const [task, tokens, suffix] of [
      [original, 100, "original"],
      [correction, 50, "correction"],
    ] as const) {
      attempt.run(
        crypto.randomUUID(),
        acceptedPlan.planID,
        task.id,
        1,
        `worker-${suffix}`,
        `message-${suffix}`,
        "/repo/worktree",
        "a".repeat(40),
        `${suffix}-artifact`,
        "{}",
        "accepted",
        Date.now(),
        tokens,
        7,
        0,
        null,
      )
    }
  })
  runner.submit(
    {
      requestID: "generic-supplement-fixture",
      objective: "Continue an adjacent area without correcting its original goal.",
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: evolution.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [evolution.id],
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
      dispositions: [
        {
          taskID: evolution.id,
          otherTaskID: original.id,
          relation: "supplements",
          rationale: "Related additional work is not a same-original-goal correction.",
        },
      ],
    },
    "architect",
  )

  const physicalState = () =>
    repository.atomic((db) => ({
      tasks: db
        .query<{ id: string; body: string }, []>("SELECT id, body FROM tasks ORDER BY id")
        .all(),
      submissions: db
        .query<{ request_id: string; fingerprint: string; task_id: string }, [string]>(
          "SELECT request_id, fingerprint, task_id FROM submission_requests WHERE project_directory=? ORDER BY request_id",
        )
        .all("/repo"),
      plans: db
        .query<{ id: string; state: string; artifact: string | null }, [string]>(
          "SELECT id, state, artifact FROM runner_plans WHERE project_directory=? ORDER BY id",
        )
        .all("/repo"),
      nodes: db
        .query<
          { plan_id: string; task_id: string; state: string; artifact: string | null },
          [string]
        >(
          "SELECT plan_id, task_id, state, artifact FROM runner_nodes WHERE plan_id IN (SELECT id FROM runner_plans WHERE project_directory=?) ORDER BY plan_id, task_id",
        )
        .all("/repo"),
      attempts: db
        .query<
          {
            task_id: string
            state: string
            artifact: string | null
            token_count: number | null
            tool_count: number
          },
          [string]
        >(
          `SELECT task_id, state, artifact, token_count, tool_count FROM runner_attempts
           WHERE task_id IN (SELECT task_id FROM runner_nodes WHERE plan_id IN
             (SELECT id FROM runner_plans WHERE project_directory=?)) ORDER BY task_id`,
        )
        .all("/repo"),
      transitions: db
        .query<{ task_id: string | null; event: string; payload: string }, [string]>(
          "SELECT task_id, event, payload FROM runner_transitions WHERE plan_id IN (SELECT id FROM runner_plans WHERE project_directory=?) ORDER BY id",
        )
        .all("/repo"),
    }))

  const before = physicalState()
  const input = {
    taskID: correction.id,
    originalTaskID: original.id,
    requestID: "same-original-goal-correction",
    expectedRevision: 0,
    reason: "This accepted change completes the original acceptance boundary.",
  }
  const first = repository.recordTaskCorrection(input, {
    sessionID: "correction-review-session",
    agent: "architect",
  })
  expect(first.status).toBe("recorded")
  if (first.status !== "recorded") throw new Error("Expected recorded correction")
  expect(first.correction).toMatchObject({
    taskID: correction.id,
    originalTaskID: original.id,
    revision: 1,
    sessionID: "correction-review-session",
    agent: "architect",
    requestID: input.requestID,
    reason: input.reason,
  })
  const version = repository.version()
  expect(
    repository.recordTaskCorrection(input, { sessionID: "replay-session", agent: "architect" }),
  ).toEqual({ status: "replayed", correction: first.correction })
  expect(repository.version()).toBe(version)
  expect(
    repository.recordTaskCorrection(
      { ...input, reason: "Changed payload." },
      { sessionID: "correction-review-session", agent: "architect" },
    ),
  ).toMatchObject({ status: "conflict" })
  expect(
    repository.recordTaskCorrection(
      { ...input, requestID: "stale-correction", expectedRevision: 0 },
      { sessionID: "correction-review-session", agent: "architect" },
    ),
  ).toMatchObject({
    status: "conflict",
    expectedRevision: 0,
    currentRevision: 1,
  })
  expect(repository.version()).toBe(version)

  repository.recordTaskCorrection(
    {
      taskID: unfinished.id,
      originalTaskID: correction.id,
      requestID: "unfinished-correction-branch",
      expectedRevision: 0,
      reason: "This submitted branch continues the same reviewed goal.",
    },
    { sessionID: "correction-review-session", agent: "architect" },
  )
  expect(physicalState()).toEqual(before)
  expect(repository.get(original.id)).toEqual(original)
  expect(repository.get(correction.id)).toEqual(correction)

  const reader = openReadOnlyTaskCorrections(path, "/repo")
  try {
    const membership = reader.inspect(correction.id)
    expect(membership).toMatchObject({
      status: "found",
      task: { taskID: correction.id, rootTaskID: original.id },
      members: [original.id, correction.id, unfinished.id]
        .sort()
        .map((taskID) => ({ taskID, rootTaskID: original.id })),
    })
    expect(reader.inspect(evolution.id)).toMatchObject({
      status: "found",
      task: { taskID: evolution.id, rootTaskID: evolution.id, relation: "unreviewed" },
      members: [{ taskID: evolution.id }],
    })
  } finally {
    reader.close()
  }
  expect(
    repository.atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string, string]>(
            "SELECT count(*) AS count FROM runner_relations WHERE project_directory=? AND task_id=? AND other_task_id=? AND relation='supplements'",
          )
          .get("/repo", evolution.id, original.id)!.count,
    ),
  ).toBe(1)
  expect(
    Object.fromEntries(before.attempts.map((attempt) => [attempt.task_id, attempt])),
  ).toMatchObject({
    [original.id]: {
      state: "accepted",
      artifact: "original-artifact",
      token_count: 100,
    },
    [correction.id]: {
      state: "accepted",
      artifact: "correction-artifact",
      token_count: 50,
    },
  })
  expect(
    before.transitions.filter((event) => event.event === "ACCEPT").map((event) => event.task_id),
  ).toEqual([original.id, correction.id])
  expect(repository.get(unfinished.id)?.status).toBe("submitted")

  const retracted = repository.recordTaskCorrection(
    {
      taskID: correction.id,
      originalTaskID: null,
      requestID: "same-original-goal-retracted",
      expectedRevision: 1,
      reason: "A later review separates this branch from the original task.",
    },
    { sessionID: "correction-re-review", agent: "architect" },
  )
  expect(retracted).toMatchObject({ status: "recorded", correction: { revision: 2 } })
  expect(physicalState()).toEqual(before)
  const afterRetraction = openReadOnlyTaskCorrections(path, "/repo")
  try {
    expect(afterRetraction.inspect(correction.id)).toMatchObject({
      task: {
        rootTaskID: correction.id,
        relation: "independent",
        revision: 2,
        history: [
          { originalTaskID: original.id, revision: 1 },
          { originalTaskID: null, revision: 2 },
        ],
      },
      members: [correction.id, unfinished.id]
        .sort()
        .map((taskID) => ({ taskID, rootTaskID: correction.id })),
    })
    expect(afterRetraction.inspect(original.id)).toMatchObject({
      task: { rootTaskID: original.id },
      members: [{ taskID: original.id }],
    })
  } finally {
    afterRetraction.close()
  }
})

test("correction endpoints reject self, missing, and foreign tasks; request replay is nonduplicating", () => {
  const path = join(directory(), "tasks.sqlite")
  const repository = open(path)
  const foreignRepository = open(path, "/foreign")
  const originalSubmission = submitTask(
    repository,
    keyedProposal("correction-validation-root"),
    provenance,
  )
  const correctionSubmission = submitTask(
    repository,
    keyedProposal("correction-validation-child"),
    provenance,
  )
  const foreignTask = submitTask(
    foreignRepository,
    keyedProposal("foreign-correction-task"),
    () => ({
      ...provenance(),
      projectDirectory: "/foreign",
    }),
  )
  if (
    originalSubmission.status !== "submitted" ||
    correctionSubmission.status !== "submitted" ||
    foreignTask.status !== "submitted"
  )
    throw new Error("Expected submitted tasks")
  const correction = (taskID: string, originalTaskID: string | null, requestID: string) => ({
    taskID,
    originalTaskID,
    requestID,
    expectedRevision: 0,
    reason: "Explicit relation validation fixture.",
  })
  const actor = { sessionID: "architect", agent: "architect" }
  const initialVersion = repository.version()
  for (const [taskID, originalTaskID] of [
    [correctionSubmission.taskID, correctionSubmission.taskID],
    [crypto.randomUUID(), originalSubmission.taskID],
    [correctionSubmission.taskID, crypto.randomUUID()],
    [correctionSubmission.taskID, foreignTask.taskID],
    [foreignTask.taskID, originalSubmission.taskID],
  ] as const) {
    expect(() =>
      repository.recordTaskCorrection(
        correction(taskID, originalTaskID, `invalid-${taskID}-${String(originalTaskID)}`),
        actor,
      ),
    ).toThrow()
  }
  expect(repository.version()).toBe(initialVersion)
  expect(
    repository.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM task_corrections WHERE project_directory=?",
          )
          .get("/repo")!.count,
    ),
  ).toBe(0)

  const input = correction(correctionSubmission.taskID, originalSubmission.taskID, "one-link")
  let notifications = 0
  const unsubscribe = repository.subscribe(() => notifications++)
  const injectedFailure = new Database(path)
  try {
    injectedFailure.exec(`CREATE TRIGGER fail_correction_change
      BEFORE INSERT ON task_changes WHEN NEW.kind='mutation'
      BEGIN SELECT RAISE(ABORT, 'injected correction change failure'); END;`)
    expect(() => repository.recordTaskCorrection(input, actor)).toThrow(
      "injected correction change failure",
    )
    expect(repository.version()).toBe(initialVersion)
    expect(notifications).toBe(0)
    expect(
      repository.atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT count(*) AS count FROM task_corrections WHERE project_directory=?",
            )
            .get("/repo")!.count,
      ),
    ).toBe(0)
    injectedFailure.exec("DROP TRIGGER fail_correction_change")
  } finally {
    injectedFailure.close()
  }
  const first = repository.recordTaskCorrection(input, actor)
  expect(first.status).toBe("recorded")
  if (first.status !== "recorded") throw new Error("Expected correction receipt")
  expect(notifications).toBe(1)
  expect(
    repository.recordTaskCorrection(input, { sessionID: "new-session", agent: "architect" }),
  ).toEqual({
    status: "replayed",
    correction: first.correction,
  })
  expect(
    repository.recordTaskCorrection({ ...input, reason: "Changed payload." }, actor),
  ).toMatchObject({ status: "conflict" })
  expect(
    repository.recordTaskCorrection(
      { ...input, requestID: "stale-link", expectedRevision: 0 },
      actor,
    ),
  ).toMatchObject({ status: "conflict", expectedRevision: 0, currentRevision: 1 })
  expect(
    repository.atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string]>(
            "SELECT count(*) AS count FROM task_corrections WHERE project_directory=? AND task_id=?",
          )
          .get("/repo", correctionSubmission.taskID)!.count,
    ),
  ).toBe(1)
  expect(notifications).toBe(1)
  unsubscribe()
  expect(() =>
    repository.atomic((db) =>
      db
        .query("UPDATE task_corrections SET reason='mutated' WHERE request_id=?")
        .run(input.requestID),
    ),
  ).toThrow("append-only")
  expect(() =>
    repository.atomic((db) =>
      db.query("DELETE FROM task_corrections WHERE request_id=?").run(input.requestID),
    ),
  ).toThrow("append-only")
  const reader = openReadOnlyTaskCorrections(path, "/repo")
  try {
    expect(reader.inspect(correctionSubmission.taskID)).toMatchObject({
      status: "found",
      task: { memberTaskIDs: [originalSubmission.taskID, correctionSubmission.taskID].sort() },
    })
  } finally {
    reader.close()
  }
})

test("repository pages filter execution state before counting while legacy history includes all states", () => {
  const repository = open(join(directory(), "tasks.sqlite"))
  const completed = submitTask(repository, keyedProposal(), provenance)
  const running = submitTask(
    repository,
    { ...keyedProposal(), idempotencyKey: "running-storage-filter" },
    provenance,
  )
  if (completed.status !== "submitted" || running.status !== "submitted")
    throw new Error("Expected submitted tasks")
  const runner = new RunnerStore(repository)
  const plan = runner.submit(
    {
      requestID: "completed-storage-filter",
      objective: "Completed repository filter fixture",
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: completed.taskID, revision: 1 }],
      dependencies: [],
      integrationOrder: [completed.taskID],
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
    },
    "session",
  )
  const secondPlan = runner.submit(
    {
      requestID: "running-storage-filter",
      objective: "Running repository filter fixture",
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: running.taskID, revision: 1 }],
      dependencies: [],
      integrationOrder: [running.taskID],
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
    },
    "session",
  )
  repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='accepted' WHERE id=?").run(plan.planID)
    db.query("UPDATE runner_nodes SET state='accepted' WHERE plan_id=?").run(plan.planID)
    db.query("UPDATE runner_plans SET state='running' WHERE id=?").run(secondPlan.planID)
    db.query("UPDATE runner_nodes SET state='running' WHERE plan_id=?").run(secondPlan.planID)
  })

  const completedPage = repository.readPage({ search: "", limit: 10, state: "completed" })
  expect(completedPage.count).toBe(1)
  expect(completedPage.rows.map(({ task }) => task.id)).toEqual([completed.taskID])
  const openPage = repository.readPage({ search: "", limit: 10, state: "open" })
  expect(openPage.count).toBe(1)
  expect(openPage.rows.map(({ task }) => task.id)).toEqual([running.taskID])
  expect(repository.readPage({ search: "", limit: 10, includeCompleted: true }).count).toBe(2)
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

test("reviewed fulfillment accepts quiet unstarted plans without rewriting executor state", () => {
  const path = join(directory(), "tasks.sqlite")
  let repository = open(path)
  let runner = new RunnerStore(repository)
  const createPlan = (key: string) => {
    const submitted = submitTask(repository, keyedProposal(key), provenance)
    if (submitted.status !== "submitted") throw new Error("Expected submitted task")
    const task = repository.get(submitted.taskID)!
    const plan = runner.submit(
      {
        requestID: `plan-${key}`,
        objective: task.proposal.objective,
        baseCommit: "a".repeat(40),
        nodes: [{ taskID: task.id, revision: task.revision }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: task.proposal.verification,
        acceptance: task.proposal.acceptance,
      },
      "architect",
    )
    return { task, plan }
  }
  const inputFor = (taskID: string, requestID: string) => ({
    taskID,
    requestID,
    disposition: "fulfilled" as const,
    reason: "Reviewed external completion evidence.",
    evidence: [{ kind: "artifact" as const, reference: "reviews/external-completion.patch" }],
    relatedTaskIDs: [],
  })

  const cancelled = createPlan("cancelled-external")
  runner.move(cancelled.plan.planID, cancelled.task.id, "CANCEL")
  repository.atomic((db) =>
    db.query("UPDATE runner_plans SET state='cancelled' WHERE id=?").run(cancelled.plan.planID),
  )
  const cancelledInput = inputFor(cancelled.task.id, "cancelled-external-review")
  const recorded = repository.recordDisposition(cancelledInput, {
    sessionID: "architect-session",
    agent: "architect",
  })
  expect(recorded).toMatchObject({
    status: "recorded",
    disposition: {
      disposition: "fulfilled",
      evidence: cancelledInput.evidence,
      sessionID: "architect-session",
      agent: "architect",
    },
  })
  expect(runner.nodes(cancelled.plan.planID)[0]?.state).toBe("cancelled")
  expect(runner.execution(cancelled.task.id)?.state).toBe("cancelled")
  expect(runner.attempts(cancelled.plan.planID)).toEqual([])

  const draft = createPlan("quiet-draft-external")
  const draftInput = inputFor(draft.task.id, "quiet-draft-external-review")
  expect(
    repository.recordDisposition(draftInput, { sessionID: "architect-session", agent: "architect" })
      .status,
  ).toBe("recorded")
  expect(runner.plan(draft.plan.planID)?.state).toBe("draft")
  expect(runner.nodes(draft.plan.planID)[0]?.state).toBe("queued")
  expect(runner.attempts(draft.plan.planID)).toEqual([])

  const running = createPlan("running-queued-external")
  repository.atomic((db) =>
    db.query("UPDATE runner_plans SET state='running' WHERE id=?").run(running.plan.planID),
  )
  expect(() =>
    repository.recordDisposition(inputFor(running.task.id, "running-queued-external-review"), {
      sessionID: "architect-session",
      agent: "architect",
    }),
  ).toThrow("active execution")
  expect(repository.taskDisposition(running.task.id)).toBeUndefined()

  repository.close()
  repository = open(path)
  runner = new RunnerStore(repository)
  expect(
    repository.recordDisposition(cancelledInput, { sessionID: "reopened", agent: "architect" }),
  ).toMatchObject({ status: "replayed", disposition: { evidence: cancelledInput.evidence } })
  expect(
    repository.recordDisposition(
      { ...cancelledInput, reason: "Changed reviewed outcome." },
      { sessionID: "architect-session", agent: "architect" },
    ),
  ).toMatchObject({ status: "conflict" })
  expect(repository.taskDispositionHistory(cancelled.task.id)).toHaveLength(1)
  expect(runner.nodes(cancelled.plan.planID)[0]?.state).toBe("cancelled")
  expect(runner.attempts(cancelled.plan.planID)).toEqual([])
})

test("reviewed fulfillment refuses all historical attempt rows, including terminal and unknown states", () => {
  const path = join(directory(), "tasks.sqlite")
  const repository = open(path)
  const runner = new RunnerStore(repository)
  const submitted = submitTask(repository, keyedProposal(), provenance)
  if (submitted.status !== "submitted") throw new Error("Expected submitted task")
  const task = repository.get(submitted.taskID)!
  const plan = runner.submit(
    {
      requestID: "history-review-plan",
      objective: task.proposal.objective,
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: task.id, revision: task.revision }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
    },
    "architect",
  )
  runner.move(plan.planID, task.id, "CANCEL")
  repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='cancelled' WHERE id=?").run(plan.planID)
    const insert = db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (const [index, state] of ["failed", "cancelled", "unknown"].entries())
      insert.run(
        `historical-${index}`,
        plan.planID,
        task.id,
        index + 1,
        `ses_historical_${index}`,
        `msg_historical_${index}`,
        "/repo",
        "a".repeat(40),
        "{}",
        state,
        index,
      )
  })

  expect(() =>
    repository.recordDisposition(
      {
        taskID: task.id,
        requestID: "historical-attempt-external-review",
        disposition: "fulfilled",
        reason: "Review does not erase the attempt history.",
        evidence: [{ kind: "human", reference: "reviewed externally" }],
      },
      { sessionID: "architect-session", agent: "architect" },
    ),
  ).toThrow("Fulfilled disposition requires accepted execution or reviewed evidence")
  expect(repository.taskDisposition(task.id)).toBeUndefined()
  expect(runner.attempts(plan.planID).map((attempt) => attempt.state)).toEqual([
    "failed",
    "cancelled",
    "unknown",
  ])
  expect(runner.nodes(plan.planID)[0]?.state).toBe("cancelled")
})

test("incorporated fulfillment remains compatible with existing executor history", () => {
  const path = join(directory(), "tasks.sqlite")
  const repository = open(path)
  const runner = new RunnerStore(repository)
  const submitted = submitTask(repository, keyedProposal(), provenance)
  if (submitted.status !== "submitted") throw new Error("Expected submitted task")
  const task = repository.get(submitted.taskID)!
  const plan = runner.submit(
    {
      requestID: "incorporated-fulfillment-plan",
      objective: task.proposal.objective,
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: task.id, revision: task.revision }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
    },
    "architect",
  )
  repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='incorporated' WHERE id=?").run(plan.planID)
    db.query("UPDATE runner_nodes SET state='incorporated' WHERE plan_id=?").run(plan.planID)
    db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
       VALUES(?,?,?,?,?,?,?,?,?,'unknown',?)`,
    ).run(
      "incorporated-historical-attempt",
      plan.planID,
      task.id,
      1,
      "ses_incorporated_history",
      "msg_incorporated_history",
      "/repo",
      "a".repeat(40),
      "{}",
      1,
    )
  })

  expect(
    repository.recordDisposition(
      {
        taskID: task.id,
        requestID: "incorporated-fulfillment-review",
        disposition: "fulfilled",
        reason: "The incorporated execution remains a valid fulfillment basis.",
        evidence: [{ kind: "verification", reference: "bun test" }],
      },
      { sessionID: "architect-session", agent: "architect" },
    ),
  ).toMatchObject({ status: "recorded", disposition: { disposition: "fulfilled" } })
  expect(runner.nodes(plan.planID)[0]?.state).toBe("incorporated")
  expect(runner.attempts(plan.planID).map((attempt) => attempt.state)).toEqual(["unknown"])
})

test("preparing, running, verifying, and approval-held execution cannot be externally fulfilled", () => {
  const path = join(directory(), "tasks.sqlite")
  const repository = open(path)
  const runner = new RunnerStore(repository)
  const createCancelledPlan = (key: string) => {
    const submitted = submitTask(repository, keyedProposal(key), provenance)
    if (submitted.status !== "submitted") throw new Error("Expected submitted task")
    const task = repository.get(submitted.taskID)!
    const plan = runner.submit(
      {
        requestID: `active-${key}-plan`,
        objective: task.proposal.objective,
        baseCommit: "a".repeat(40),
        nodes: [{ taskID: task.id, revision: task.revision }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: task.proposal.verification,
        acceptance: task.proposal.acceptance,
      },
      "architect",
    )
    runner.move(plan.planID, task.id, "CANCEL")
    repository.atomic((db) =>
      db.query("UPDATE runner_plans SET state='cancelled' WHERE id=?").run(plan.planID),
    )
    return { task, plan }
  }

  const active = createCancelledPlan("active-attempts")
  repository.atomic((db) => {
    const insert = db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (const [index, state] of ["preparing", "running", "verifying"].entries())
      insert.run(
        `active-attempt-${index}`,
        active.plan.planID,
        active.task.id,
        index + 1,
        `ses_active_${index}`,
        `msg_active_${index}`,
        "/repo",
        "a".repeat(40),
        "{}",
        state,
        index,
      )
  })
  expect(() =>
    repository.recordDisposition(
      {
        taskID: active.task.id,
        requestID: "active-attempts-review",
        disposition: "fulfilled",
        reason: "An active reservation is not external completion.",
        evidence: [{ kind: "human", reference: "review" }],
      },
      { sessionID: "architect-session", agent: "architect" },
    ),
  ).toThrow("active execution")
  expect(repository.taskDisposition(active.task.id)).toBeUndefined()

  const held = createCancelledPlan("approval-held")
  repository.atomic((db) => {
    ensureRetainedVerificationTables(db)
    db.query("INSERT INTO runner_retained_verifications VALUES(?,?,?,?,?,?,?)").run(
      crypto.randomUUID(),
      "/repo",
      held.plan.planID,
      held.task.id,
      1,
      "waiting-human",
      "{}",
    )
  })
  expect(() =>
    repository.recordDisposition(
      {
        taskID: held.task.id,
        requestID: "approval-held-review",
        disposition: "fulfilled",
        reason: "Retained verification is awaiting its required approval.",
        evidence: [{ kind: "human", reference: "review" }],
      },
      { sessionID: "architect-session", agent: "architect" },
    ),
  ).toThrow("active execution")
  expect(repository.taskDisposition(held.task.id)).toBeUndefined()
  expect(runner.attempts(held.plan.planID)).toEqual([])
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
