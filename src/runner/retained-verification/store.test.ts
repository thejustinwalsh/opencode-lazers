import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { fingerprint } from "../../identity.ts"
import type { RetainedVerification } from "./schema.ts"
import { createRetainedVerification, retainedVerificationsForInspection } from "./store.ts"

const projectDirectory = "/project/selected"
const selectedPlan = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const foreignPlan = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const taskA = "11111111-1111-4111-8111-111111111111"
const taskB = "22222222-2222-4222-8222-222222222222"
const databases: Database[] = []

function fixture(includeRetainedTables = true) {
  const db = new Database(":memory:")
  databases.push(db)
  db.exec(`
    CREATE TABLE runner_plans(id TEXT NOT NULL,project_directory TEXT NOT NULL);
    CREATE TABLE runner_nodes(plan_id TEXT NOT NULL,task_id TEXT NOT NULL,ordinal INTEGER NOT NULL);
  `)
  db.query("INSERT INTO runner_plans(id,project_directory) VALUES(?,?)").run(
    selectedPlan,
    projectDirectory,
  )
  db.query("INSERT INTO runner_plans(id,project_directory) VALUES(?,?)").run(
    foreignPlan,
    projectDirectory,
  )
  db.query("INSERT INTO runner_nodes(plan_id,task_id,ordinal) VALUES(?,?,?)").run(
    selectedPlan,
    taskA,
    0,
  )
  db.query("INSERT INTO runner_nodes(plan_id,task_id,ordinal) VALUES(?,?,?)").run(
    selectedPlan,
    taskB,
    1,
  )
  db.query("INSERT INTO runner_nodes(plan_id,task_id,ordinal) VALUES(?,?,?)").run(
    foreignPlan,
    taskA,
    0,
  )
  if (includeRetainedTables)
    createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 1, "failed"))
  return db
}

function operation(
  planID: string,
  taskID: string,
  generation: number,
  state: RetainedVerification["state"],
  overrides: Partial<RetainedVerification> = {},
): RetainedVerification {
  const now = 1_700_000_000_000 + generation
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    generation,
    projectID: "project",
    projectDirectory,
    planID,
    planRevision: 1,
    planVersion: 1,
    owner: "architect",
    ownerEpoch: 0,
    taskID,
    taskRevision: 1,
    attemptID: crypto.randomUUID(),
    originalSessionID: "ses_private",
    originalMessageID: "msg_private",
    originalWorkspace: "/private/original-workspace",
    artifact: "a".repeat(40),
    combinedArtifact: null,
    combinedInputFingerprint: null,
    taskWorkspace: null,
    taskWorkspaceState: null,
    combinedWorkspace: null,
    combinedWorkspaceState: null,
    inputFingerprint: fingerprint({ planID, taskID, generation }),
    environmentIdentity: JSON.stringify({ PATH: "/private/environment" }),
    reason: "PRIVATE_REASON",
    state,
    holdReason: null,
    cleanupState: "complete",
    createdAt: now,
    updatedAt: now + 100,
    ...overrides,
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

test("inspection pages only selected plan generations with stable generation and task scopes", () => {
  const db = fixture()
  const add = (planID: string, taskID: string, generation: number) =>
    createRetainedVerification(
      db,
      projectDirectory,
      operation(planID, taskID, generation, "failed"),
    )
  add(selectedPlan, taskA, 2)
  add(selectedPlan, taskA, 3)
  add(selectedPlan, taskB, 1)
  add(selectedPlan, taskB, 2)
  add(foreignPlan, taskA, 1)
  const foreignInsert = db.query(
    `INSERT INTO runner_retained_verifications
     (id,project_directory,plan_id,task_id,generation,state,payload) VALUES(?,?,?,?,?,?,?)`,
  )
  for (let generation = 2; generation <= 2501; generation++) {
    const foreign = operation(foreignPlan, taskA, generation, "failed")
    foreignInsert.run(
      foreign.id,
      projectDirectory,
      foreignPlan,
      taskA,
      generation,
      foreign.state,
      JSON.stringify(foreign),
    )
  }

  const initial = retainedVerificationsForInspection(
    db,
    projectDirectory,
    selectedPlan,
    undefined,
    1,
  )
  expect(initial.latest.map((record) => [record.taskID, record.generation])).toEqual([
    [taskA, 3],
    [taskB, 2],
  ])
  expect(initial.history.records).toHaveLength(1)
  expect(initial.history.records[0]).toMatchObject({ taskID: taskA, generation: 2 })
  expect(initial.history.nextCursor).toBeString()
  expect(initial.history.concurrentChanges).toBe(
    "selected-retained-history-changes-invalidate-cursor",
  )
  expect(JSON.stringify(initial)).not.toContain("PRIVATE_REASON")
  expect(JSON.stringify(initial)).not.toContain(foreignPlan)

  expect(() =>
    retainedVerificationsForInspection(
      db,
      projectDirectory,
      foreignPlan,
      undefined,
      1,
      initial.history.nextCursor!,
    ),
  ).toThrow("does not match this plan")
  expect(() =>
    retainedVerificationsForInspection(
      db,
      projectDirectory,
      selectedPlan,
      [taskB],
      1,
      initial.history.nextCursor!,
    ),
  ).toThrow("task selection")
  db.query("INSERT INTO runner_plans(id,project_directory) VALUES(?,?)").run(
    selectedPlan,
    "/other-project",
  )
  expect(() =>
    retainedVerificationsForInspection(
      db,
      "/other-project",
      selectedPlan,
      undefined,
      1,
      initial.history.nextCursor!,
    ),
  ).toThrow("project and task selection")
  expect(() =>
    retainedVerificationsForInspection(
      db,
      projectDirectory,
      selectedPlan,
      undefined,
      1,
      `${initial.history.nextCursor!.slice(0, -1)}${initial.history.nextCursor!.endsWith("A") ? "B" : "A"}`,
    ),
  ).toThrow("Invalid retained-verification cursor")

  const pageTwo = retainedVerificationsForInspection(
    db,
    projectDirectory,
    selectedPlan,
    undefined,
    1,
    initial.history.nextCursor!,
  )
  expect(pageTwo.latest.map((record) => record.generation)).toEqual([3, 2])
  expect(pageTwo.history.records[0]).toMatchObject({ taskID: taskA, generation: 1 })
  expect(pageTwo.history.nextCursor).toBeString()

  add(selectedPlan, taskA, 4)
  expect(() =>
    retainedVerificationsForInspection(
      db,
      projectDirectory,
      selectedPlan,
      undefined,
      1,
      pageTwo.history.nextCursor!,
    ),
  ).toThrow("Selected retained-verification history changed since this capture")
})

test("inspection limits operation reads and returns no more than the requested older page", () => {
  const db = fixture()
  for (let generation = 2; generation <= 40; generation++)
    createRetainedVerification(
      db,
      projectDirectory,
      operation(selectedPlan, taskA, generation, "failed"),
    )
  const page = retainedVerificationsForInspection(db, projectDirectory, selectedPlan, [taskA], 3)
  expect(page.latest).toHaveLength(1)
  expect(page.latest[0]?.generation).toBe(40)
  expect(page.history.records.map((record) => record.generation)).toEqual([39, 38, 37])
  expect(page.history.returned).toBe(3)
  expect(page.history.hasMore).toBe(true)
})

test("duplicate-heavy human evidence lookup keeps only distinct required assertions", () => {
  const db = fixture(false)
  const waiting = operation(selectedPlan, taskA, 1, "waiting-human")
  createRetainedVerification(db, projectDirectory, waiting)

  const insertEvidence = db.query(
    `INSERT INTO runner_retained_verification_evidence(
      id,operation_id,generation,phase,task_id,assertion_id,artifact,body,created_at
    ) VALUES(?,?,?,'task',?,'approval',?,?,?)`,
  )
  for (let index = 0; index < 5_000; index++)
    insertEvidence.run(
      crypto.randomUUID(),
      waiting.id,
      waiting.generation,
      taskA,
      waiting.artifact,
      `duplicate evidence ${index}`,
      index,
    )
  expect(
    db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM runner_retained_verification_evidence WHERE operation_id=?",
      )
      .get(waiting.id)?.count,
  ).toBe(5_000)

  const requirements = new Map([
    [
      taskA,
      {
        planRevision: 1,
        planVersion: 1,
        taskRevision: 1,
        taskAssertionIDs: ["approval", "follow-up"],
        combinedAssertionIDs: [],
      },
    ],
  ])
  const result = retainedVerificationsForInspection(
    db,
    projectDirectory,
    selectedPlan,
    [taskA],
    10,
    undefined,
    requirements,
  )

  expect(result.latest[0]?.humanEvidence).toEqual({
    status: "known",
    phase: "task",
    missingAssertionIDs: ["follow-up"],
  })
})

test("selected history cursors ignore unrelated telemetry and other plan/task writes", () => {
  const db = fixture()
  createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 2, "failed"))
  createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 3, "failed"))
  createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskB, 1, "failed"))
  createRetainedVerification(db, projectDirectory, operation(foreignPlan, taskA, 1, "failed"))
  const otherProject = operation(selectedPlan, taskA, 1, "failed", {
    projectDirectory: "/other-project",
  })
  db.query(
    `INSERT INTO runner_retained_verifications
     (id,project_directory,plan_id,task_id,generation,state,payload) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    otherProject.id,
    otherProject.projectDirectory,
    otherProject.planID,
    otherProject.taskID,
    otherProject.generation,
    otherProject.state,
    JSON.stringify(otherProject),
  )
  const first = retainedVerificationsForInspection(db, projectDirectory, selectedPlan, [taskA], 1)
  db.exec(`
    CREATE TABLE runner_progress(seq INTEGER PRIMARY KEY,project_directory TEXT,payload TEXT);
    CREATE TABLE runner_leases(project_directory TEXT PRIMARY KEY,owner TEXT,fence INTEGER,expires_at INTEGER);
  `)
  db.query("INSERT INTO runner_progress(project_directory,payload) VALUES(?,?)").run(
    projectDirectory,
    "unrelated callback/progress observation",
  )
  db.query("INSERT INTO runner_leases VALUES(?,?,?,?)").run(
    projectDirectory,
    "unrelated-scheduler",
    1,
    Date.now() + 30_000,
  )
  db.query("UPDATE runner_retained_verifications SET state='held' WHERE plan_id=?").run(foreignPlan)
  db.query("UPDATE runner_retained_verifications SET state='held' WHERE task_id=?").run(taskB)
  db.query("UPDATE runner_plans SET project_directory=? WHERE id=?").run(
    "/other-project",
    foreignPlan,
  )

  const next = retainedVerificationsForInspection(
    db,
    projectDirectory,
    selectedPlan,
    [taskA],
    1,
    first.history.nextCursor!,
  )
  expect(next.history.records).toMatchObject([{ taskID: taskA, generation: 1 }])
  expect(next.history.nextCursor).toBeNull()
})

test("selected operation, generation, check, resource, and evidence changes invalidate cursors", () => {
  for (const change of ["operation", "generation", "check", "resource", "evidence"] as const) {
    const db = fixture()
    createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 2, "failed"))
    createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 3, "failed"))
    const operationID = db
      .query<{ id: string }, [string, string, string, number]>(
        `SELECT id FROM runner_retained_verifications
         WHERE project_directory=? AND plan_id=? AND task_id=? AND generation=?`,
      )
      .get(projectDirectory, selectedPlan, taskA, 1)!.id
    if (change === "check")
      db.query(
        `INSERT INTO runner_retained_verification_checks(
          operation_id,phase,check_id,check_json,workspace,artifact,input_fingerprint,
          environment_identity,receipt_path,state,receipt,context_path,cleanup_state,created_at
        ) VALUES(?,'task','tests','{}','/private/workspace','artifact','fingerprint',
          '{}','/private/receipt','completed','{}','/private/context','complete',1)`,
      ).run(operationID)
    if (change === "resource")
      db.query(
        `INSERT INTO runner_retained_verification_resources(
          project_directory,operation_id,generation,phase,check_id,resource_name,canonical_path,
          device,inode,state,created_at,updated_at
        ) VALUES(?,?,1,'task','tests','private-resource','/private/path',1,2,'uncertain',1,2)`,
      ).run(projectDirectory, operationID)
    const first = retainedVerificationsForInspection(db, projectDirectory, selectedPlan, [taskA], 1)
    if (change === "operation")
      db.query("UPDATE runner_retained_verifications SET state='held' WHERE id=?").run(operationID)
    if (change === "generation")
      createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 4, "failed"))
    if (change === "check")
      db.query(
        "UPDATE runner_retained_verification_checks SET cleanup_state='failed' WHERE operation_id=?",
      ).run(operationID)
    if (change === "resource")
      db.query(
        "UPDATE runner_retained_verification_resources SET state='removed',updated_at=3 WHERE operation_id=?",
      ).run(operationID)
    if (change === "evidence")
      db.query(
        `INSERT INTO runner_retained_verification_evidence(
          id,operation_id,generation,phase,task_id,assertion_id,artifact,body,created_at
        ) VALUES(?,?,1,'task',?,'approval','artifact','private body',3)`,
      ).run(crypto.randomUUID(), operationID, taskA)

    expect(() =>
      retainedVerificationsForInspection(
        db,
        projectDirectory,
        selectedPlan,
        [taskA],
        1,
        first.history.nextCursor!,
      ),
    ).toThrow("Selected retained-verification history changed since this capture")
    db.close()
    databases.splice(databases.indexOf(db), 1)
  }
})

test("cursor capture detects evidence generation rebinding", () => {
  const db = fixture()
  createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 2, "failed"))
  const waiting = operation(selectedPlan, taskA, 3, "waiting-human")
  createRetainedVerification(db, projectDirectory, waiting)
  db.query(
    `INSERT INTO runner_retained_verification_evidence(
      id,operation_id,generation,phase,task_id,assertion_id,artifact,body,created_at
    ) VALUES(?,?,3,'task',?,'approval',?,'private approval evidence',3)`,
  ).run(crypto.randomUUID(), waiting.id, taskA, waiting.artifact)
  const requirements = new Map([
    [
      taskA,
      {
        planRevision: 1,
        planVersion: 1,
        taskRevision: 1,
        taskAssertionIDs: ["approval"],
        combinedAssertionIDs: [],
      },
    ],
  ])
  const first = retainedVerificationsForInspection(
    db,
    projectDirectory,
    selectedPlan,
    [taskA],
    1,
    undefined,
    requirements,
  )
  expect(first.latest[0]?.humanEvidence).toEqual({
    status: "known",
    phase: "task",
    missingAssertionIDs: [],
  })
  expect(first.history.nextCursor).toBeString()

  db.query(
    "UPDATE runner_retained_verification_evidence SET generation=99 WHERE operation_id=?",
  ).run(waiting.id)
  expect(() =>
    retainedVerificationsForInspection(
      db,
      projectDirectory,
      selectedPlan,
      [taskA],
      1,
      first.history.nextCursor!,
      requirements,
    ),
  ).toThrow("Selected retained-verification history changed since this capture")
})

test("cursor capture detects evidence rebinding to an older operation", () => {
  const db = fixture()
  createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 2, "failed"))
  const waiting = operation(selectedPlan, taskA, 3, "waiting-human")
  createRetainedVerification(db, projectDirectory, waiting)
  const olderOperationID = db
    .query<{ id: string }, [string, string, string, number]>(
      `SELECT id FROM runner_retained_verifications
       WHERE project_directory=? AND plan_id=? AND task_id=? AND generation=?`,
    )
    .get(projectDirectory, selectedPlan, taskA, 1)!.id
  db.query(
    `INSERT INTO runner_retained_verification_evidence(
      id,operation_id,generation,phase,task_id,assertion_id,artifact,body,created_at
    ) VALUES(?,?,3,'task',?,'approval',?,'private approval evidence',3)`,
  ).run(crypto.randomUUID(), waiting.id, taskA, waiting.artifact)
  const requirements = new Map([
    [
      taskA,
      {
        planRevision: 1,
        planVersion: 1,
        taskRevision: 1,
        taskAssertionIDs: ["approval"],
        combinedAssertionIDs: [],
      },
    ],
  ])
  const first = retainedVerificationsForInspection(
    db,
    projectDirectory,
    selectedPlan,
    [taskA],
    1,
    undefined,
    requirements,
  )
  expect(first.latest[0]?.humanEvidence).toEqual({
    status: "known",
    phase: "task",
    missingAssertionIDs: [],
  })
  expect(first.history.nextCursor).toBeString()

  db.query(
    "UPDATE runner_retained_verification_evidence SET operation_id=? WHERE operation_id=?",
  ).run(olderOperationID, waiting.id)
  const fresh = retainedVerificationsForInspection(
    db,
    projectDirectory,
    selectedPlan,
    [taskA],
    1,
    undefined,
    requirements,
  )
  expect(fresh.latest[0]?.humanEvidence).toEqual({
    status: "known",
    phase: "task",
    missingAssertionIDs: ["approval"],
  })
  expect(() =>
    retainedVerificationsForInspection(
      db,
      projectDirectory,
      selectedPlan,
      [taskA],
      1,
      first.history.nextCursor!,
      requirements,
    ),
  ).toThrow("Selected retained-verification history changed since this capture")
})

test("cursor capture rejects oversized corrupt operation state without exposing it", () => {
  const db = fixture()
  createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 2, "failed"))
  createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 3, "failed"))
  const oversizedState = "corrupt-state-".repeat(150_000)
  db.query(
    `UPDATE runner_retained_verifications SET state=?
     WHERE project_directory=? AND plan_id=? AND task_id=? AND generation=1`,
  ).run(oversizedState, projectDirectory, selectedPlan, taskA)

  expect(() =>
    retainedVerificationsForInspection(db, projectDirectory, selectedPlan, [taskA], 1),
  ).toThrow("oversized operation state and cannot be captured safely")
})

test("absent optional retained tables stay absent and inspection does not write", () => {
  const db = fixture(false)
  const tableNames = () =>
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_retained_verification_%' ORDER BY name",
      )
      .all()
  const beforeTables = tableNames()
  const beforeChanges = db
    .query<{ changes: number }, []>("SELECT total_changes() AS changes")
    .get()!.changes
  const result = retainedVerificationsForInspection(
    db,
    projectDirectory,
    selectedPlan,
    undefined,
    10,
  )
  expect(result).toMatchObject({ status: "unavailable", availability: { operations: false } })
  expect(tableNames()).toEqual(beforeTables)
  expect(
    db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes,
  ).toBe(beforeChanges)
})

test("missing retained child tables report partial facts without adding schema", () => {
  const db = fixture(false)
  db.exec(`
    CREATE TABLE runner_retained_verifications (
      id TEXT PRIMARY KEY,project_directory TEXT NOT NULL,plan_id TEXT NOT NULL,
      task_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL
    );
  `)
  const saved = operation(selectedPlan, taskA, 1, "accepted", { cleanupState: "failed" })
  db.query(
    `INSERT INTO runner_retained_verifications(
      id,project_directory,plan_id,task_id,generation,state,payload
    ) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    saved.id,
    projectDirectory,
    selectedPlan,
    taskA,
    saved.generation,
    saved.state,
    JSON.stringify(saved),
  )
  const tableNames = () =>
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_retained_verification_%' ORDER BY name",
      )
      .all()
  const beforeTables = tableNames()
  const beforeChanges = db
    .query<{ changes: number }, []>("SELECT total_changes() AS changes")
    .get()!.changes
  const result = retainedVerificationsForInspection(db, projectDirectory, selectedPlan, [taskA], 10)
  expect(result).toMatchObject({
    status: "partial",
    availability: { operations: true, checks: false, resources: false, humanEvidence: false },
    latest: [
      {
        state: "accepted",
        checksAvailable: false,
        cleanup: { state: "failed", resourcesAvailable: false },
      },
    ],
  })
  expect(tableNames()).toEqual(beforeTables)
  expect(
    db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes,
  ).toBe(beforeChanges)
})
