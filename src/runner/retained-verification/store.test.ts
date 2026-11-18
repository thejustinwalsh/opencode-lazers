import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
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
  sequence: number,
  state: RetainedVerification["state"],
  overrides: Partial<RetainedVerification> = {},
): RetainedVerification {
  const now = 1_700_000_000_000 + sequence
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    projectID: "project",
    projectDirectory,
    planID,
    planRevision: 1,
    owner: "architect",
    taskID,
    taskRevision: 1,
    attemptID: crypto.randomUUID(),
    originalSessionID: "ses_private",
    originalMessageID: "msg_private",
    originalWorkspace: "/private/original-workspace",
    artifact: "a".repeat(40),
    taskWorkspace: null,
    taskWorkspaceState: null,
    environmentIdentity: JSON.stringify({ PATH: "/private/environment" }),
    reason: "PRIVATE_REASON",
    state,
    failureReason: null,
    cleanupState: "complete",
    createdAt: now,
    updatedAt: now + 100,
    ...overrides,
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

test("inspection reports the latest call per selected task and no history", () => {
  const db = fixture()
  const add = (
    planID: string,
    taskID: string,
    sequence: number,
    state: RetainedVerification["state"],
  ) => createRetainedVerification(db, projectDirectory, operation(planID, taskID, sequence, state))
  add(selectedPlan, taskA, 2, "failed")
  const latestA = add(selectedPlan, taskA, 3, "accepted")
  const latestB = add(selectedPlan, taskB, 2, "failed")
  add(foreignPlan, taskA, 1, "failed")

  const inspection = retainedVerificationsForInspection(db, projectDirectory, selectedPlan)
  expect(inspection).toMatchObject({ status: "available", planID: selectedPlan })
  expect(Object.keys(inspection).sort()).toEqual(
    ["availability", "latest", "planID", "status", "taskIDs"].sort(),
  )
  expect(
    inspection.latest.map((record) => [record.taskID, record.operationID, record.state]),
  ).toEqual([
    [taskA, latestA.id, "accepted"],
    [taskB, latestB.id, "failed"],
  ])
  const text = JSON.stringify(inspection)
  for (const retired of ["generation", "planVersion", "inputFingerprint", "combinedArtifact"])
    expect(text).not.toContain(retired)
  expect(text).not.toContain("PRIVATE_REASON")
  expect(text).not.toContain(foreignPlan)
  expect(
    retainedVerificationsForInspection(db, projectDirectory, selectedPlan, [taskB]).latest,
  ).toHaveLength(1)
  expect(() =>
    retainedVerificationsForInspection(db, projectDirectory, selectedPlan, [crypto.randomUUID()]),
  ).toThrow("must belong to this plan")
})

test("a task can be verified again after a failure and only one call runs at a time", () => {
  const db = fixture(false)
  createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 1, "failed"))
  const running = createRetainedVerification(
    db,
    projectDirectory,
    operation(selectedPlan, taskA, 2, "pending"),
  )
  expect(() =>
    createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 3, "pending")),
  ).toThrow("conflicting retained verification operation is active")
  db.query("UPDATE runner_retained_verifications SET state='failed' WHERE id=?").run(running.id)
  expect(() =>
    createRetainedVerification(db, projectDirectory, operation(selectedPlan, taskA, 3, "pending")),
  ).not.toThrow()
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(runner_retained_verifications)")
    .all()
    .map((column) => column.name)
  expect(columns).not.toContain("generation")
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
  const result = retainedVerificationsForInspection(db, projectDirectory, selectedPlan)
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
      task_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL
    );
  `)
  const saved = operation(selectedPlan, taskA, 1, "accepted", { cleanupState: "failed" })
  db.query(
    `INSERT INTO runner_retained_verifications(
      id,project_directory,plan_id,task_id,state,payload
    ) VALUES(?,?,?,?,?,?)`,
  ).run(saved.id, projectDirectory, selectedPlan, taskA, saved.state, JSON.stringify(saved))
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
  const result = retainedVerificationsForInspection(db, projectDirectory, selectedPlan, [taskA])
  expect(result).toMatchObject({
    status: "partial",
    availability: { operations: true, checks: false, resources: false },
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
