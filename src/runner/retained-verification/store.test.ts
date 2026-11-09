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
  for (let generation = 2; generation <= 101; generation++) add(foreignPlan, taskA, generation)

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
  expect(initial.history.concurrentChanges).toBe("runner-database-writes-invalidate-cursor")
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
  ).toThrow("changed since this page")
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

test("cursor read fences reject intervening database writes without modifying state", () => {
  const db = fixture()
  createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 2, "failed"))
  createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 3, "failed"))
  const first = retainedVerificationsForInspection(db, projectDirectory, selectedPlan, [taskA], 1)
  const before = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!
    .changes
  db.query(
    `UPDATE runner_retained_verifications SET state='held'
     WHERE project_directory=? AND plan_id=? AND task_id=? AND generation=1`,
  ).run(projectDirectory, selectedPlan, taskA)
  expect(() =>
    retainedVerificationsForInspection(
      db,
      projectDirectory,
      selectedPlan,
      [taskA],
      1,
      first.history.nextCursor!,
    ),
  ).toThrow("changed since this page")
  const after = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!
    .changes
  expect(after).toBe(before + 1)
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
