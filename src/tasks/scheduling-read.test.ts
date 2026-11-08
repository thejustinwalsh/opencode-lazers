import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "../runner/artifacts.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskSchedulingRead } from "./scheduling-read.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-scheduling-read-"))
  git(directory, ["init", "--initial-branch=main"])
  git(directory, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "base",
  ])
  const repository = new TaskRepository(join(directory, "state.sqlite"), directory)
  const store = new RunnerStore(repository)
  const baseCommit = git(directory, ["rev-parse", "HEAD"])
  const create = (
    name: string,
    priority: number,
    dependency = false,
    afterPlans: string[] = [],
  ) => {
    const task = repository.insert({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      revision: 1,
      status: "submitted",
      createdAt: new Date().toISOString(),
      provenance: {
        projectID: "project",
        projectDirectory: directory,
        workspaceDirectory: directory,
        sessionID: "owner",
        startingRevision: { kind: "git", commit: baseCommit },
      },
      proposal: { ...validProposal(), objective: name, writeScope: [`${name}.ts`] },
    })
    const plan = store.submit(
      {
        requestID: `request-${name}`,
        title: `Plan ${name}`,
        objective: `Implement ${name}`,
        priority,
        ...(afterPlans.length ? { afterPlans } : {}),
        baseCommit,
        workspaceMode: "isolated",
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: [],
        acceptance: [
          { id: "done", assertion: "Done", evidence: [{ kind: "human", decision: "review" }] },
        ],
      },
      "owner",
    )
    repository.atomic((db) => {
      db.query("UPDATE runner_plans SET state='running' WHERE id=?").run(plan.planID)
      repository.changed()
    })
    if (dependency)
      repository.atomic((db) => {
        db.query("UPDATE runner_nodes SET state='accepted' WHERE plan_id=? AND task_id=?").run(
          plan.planID,
          task.id,
        )
        repository.changed()
      })
    return { task, plan }
  }
  cleanup.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, repository, store, create }
}

test("scheduling pages pin one bounded ordered snapshot while a new write remains visible on refresh", async () => {
  const f = fixture()
  const firstPlan = f.create("first", 7)
  const secondPlan = f.create("second", 7)
  const thirdPlan = f.create("third", 1)
  let now = 0
  const read = new TaskSchedulingRead(f.store, () => now)
  const scope = { kind: "project" as const, sessionID: "owner" }
  const first = await read.read({ scope, limit: 1 })
  expect(first.observedAt).toBe(0)
  expect(first.plans.map((plan) => plan.planID)).toEqual([firstPlan.plan.planID])
  expect(first.next).toMatchObject({ status: "known", candidate: { taskID: firstPlan.task.id } })
  const version = first.repositoryVersion
  const pinnedCursor = first.nextCursor!

  const newer = f.create("newer", 100)
  now = 1
  const second = await read.read({ scope, cursor: pinnedCursor, limit: 1 })
  expect(second.snapshotID).toBe(first.snapshotID)
  expect(second.observedAt).toBe(first.observedAt)
  expect(second.repositoryVersion).toBe(version)
  expect(second.plans.map((plan) => plan.planID)).toEqual([secondPlan.plan.planID])
  expect(second.next).toEqual(first.next)

  const refreshed = await read.read({ scope, limit: 1 })
  expect(refreshed.snapshotID).not.toBe(first.snapshotID)
  expect(refreshed.repositoryVersion).toBeGreaterThan(version)
  expect(refreshed.next).toMatchObject({ status: "known", candidate: { taskID: newer.task.id } })
  expect(thirdPlan.plan.planID).not.toBe(first.plans[0]!.planID)
})

test("unknown higher-priority coverage is not reported as no candidate", async () => {
  const f = fixture()
  const held = f.create("held", 10, true)
  const lower = f.create("lower", 1)
  f.repository.atomic((db) => {
    db.query("UPDATE runner_nodes SET state='accepted' WHERE plan_id=? AND task_id=?").run(
      held.plan.planID,
      held.task.id,
    )
    f.repository.changed()
  })
  const bounded = new TaskSchedulingRead(f.store, () => 20, { maxPlans: 1 })
  const result = await bounded.read({
    scope: { kind: "project", sessionID: "owner" },
    limit: 10,
  })
  expect(result.coverage.status).toBe("partial")
  expect(result.plans.map((plan) => plan.planID)).toEqual([held.plan.planID])
  expect(result.next.status).toBe("unknown")
  expect(result.next).not.toEqual({ status: "none" })
  expect(lower.task.id).not.toBe(held.task.id)
})

test("a normal write during snapshot capture is isolated from the captured facts and seen on refresh", async () => {
  const f = fixture()
  f.create("before-capture", 1)
  const writer = new TaskRepository(f.repository.path, f.directory)
  const before = f.repository.version()
  let inserted = false
  const read = new TaskSchedulingRead(f.store, () => {
    if (!inserted) {
      inserted = true
      writer.insert({
        schemaVersion: 1,
        id: crypto.randomUUID(),
        revision: 1,
        status: "submitted",
        createdAt: new Date().toISOString(),
        provenance: {
          projectID: "project",
          projectDirectory: f.directory,
          workspaceDirectory: f.directory,
          sessionID: "owner",
          startingRevision: { kind: "unborn" },
        },
        proposal: { ...validProposal(), objective: "Written during snapshot capture" },
      })
    }
    return 45
  })
  try {
    const scope = { kind: "project" as const, sessionID: "owner" }
    const captured = await read.read({ scope, limit: 10 })
    expect(inserted).toBe(true)
    expect(captured.repositoryVersion).toBe(before)
    expect(captured.plans).toHaveLength(1)
    const refreshed = await read.read({ scope, limit: 10 })
    expect(refreshed.snapshotID).not.toBe(captured.snapshotID)
    expect(refreshed.repositoryVersion).toBeGreaterThan(before)
  } finally {
    writer.close()
  }
})

test("stale and cross-scope cursors are rejected without replacing their pinned snapshot", async () => {
  const f = fixture()
  f.create("one", 1)
  f.create("two", 0)
  let now = 100
  const read = new TaskSchedulingRead(f.store, () => now)
  const scope = { kind: "project" as const, sessionID: "owner" }
  const first = await read.read({ scope, limit: 1 })
  await expect(
    read.read({
      scope: { kind: "session", sessionID: "owner" },
      cursor: first.nextCursor!,
      limit: 1,
    }),
  ).rejects.toThrow("another scope")
  now += 120_001
  await expect(read.read({ scope, cursor: first.nextCursor!, limit: 1 })).rejects.toThrow("stale")
})

test("repeated first pages reuse semantic projections and ancestry proofs across progress-only churn", async () => {
  const f = fixture()
  const parent = f.create("integrated-parent", 0)
  const child = f.create("after-parent", 10, false, [parent.plan.planID])
  const artifact = git(f.directory, ["rev-parse", "HEAD"])
  f.repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='cleaning',artifact=? WHERE id=?").run(
      artifact,
      parent.plan.planID,
    )
    db.query("UPDATE runner_nodes SET state='accepted',artifact=? WHERE plan_id=?").run(
      artifact,
      parent.plan.planID,
    )
    db.query(
      `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
       VALUES(?,NULL,3,'PLAN_ACCEPTED',?,1),(?,NULL,3,'INTEGRATION_RECORDED',?,2)`,
    ).run(
      parent.plan.planID,
      JSON.stringify({ artifact }),
      parent.plan.planID,
      JSON.stringify({ artifact, head: artifact, branch: "main", reason: "reviewed" }),
    )
    f.repository.changed()
  })
  const read = new TaskSchedulingRead(f.store, () => 50)
  const scope = { kind: "project" as const, sessionID: "owner" }
  const first = await read.read({ scope, limit: 100 })
  expect(first.next).toMatchObject({ status: "known", candidate: { taskID: child.task.id } })
  const afterFirst = read.workCounts
  expect(afterFirst.proofEvaluations).toBe(1)

  const beforeProgress = f.repository.version()
  f.repository.atomic((db) => {
    db.query(
      `INSERT INTO runner_progress
       (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
        source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES(?, 'project', ?, ?, 'attempt-progress', 'ses-worker', 1, 1,
        'worker', '[]', 'progress', '[]', NULL, NULL, 'progress-only', '{}')`,
    ).run(f.directory, child.plan.planID, child.task.id)
  })
  const second = await read.read({ scope, limit: 100 })
  expect(second.snapshotID).not.toBe(first.snapshotID)
  expect(second.observedAt).toBe(50)
  expect(f.repository.version()).toBe(beforeProgress)
  expect(second.next).toEqual(first.next)
  expect(read.workCounts.factCaptures).toBe(2)
  expect(read.workCounts.projectionBuilds).toBe(1)
  expect(read.workCounts.projectionCacheHits).toBe(1)
  expect(read.workCounts.proofEvaluations).toBe(afterFirst.proofEvaluations)
  expect(read.workCounts.proofCacheHits).toBe(afterFirst.proofCacheHits)
  expect(read.workCounts.gitCommands - afterFirst.gitCommands).toBe(2)
})

test("scheduling and Git source changes invalidate cached proof bases", async () => {
  const f = fixture()
  const parent = f.create("integrated-parent", 0)
  const child = f.create("after-parent", 10, false, [parent.plan.planID])
  const artifact = git(f.directory, ["rev-parse", "HEAD"])
  f.repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='cleaning',artifact=? WHERE id=?").run(
      artifact,
      parent.plan.planID,
    )
    db.query("UPDATE runner_nodes SET state='accepted',artifact=? WHERE plan_id=?").run(
      artifact,
      parent.plan.planID,
    )
    f.repository.changed()
  })
  const read = new TaskSchedulingRead(f.store, () => 60)
  const scope = { kind: "project" as const, sessionID: "owner" }
  const waiting = await read.read({ scope, limit: 100 })
  expect(waiting.next).toMatchObject({ status: "none" })

  f.repository.atomic((db) => {
    db.query(
      `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
       VALUES(?,NULL,3,'PLAN_ACCEPTED',?,1),(?,NULL,3,'INTEGRATION_RECORDED',?,2)`,
    ).run(
      parent.plan.planID,
      JSON.stringify({ artifact }),
      parent.plan.planID,
      JSON.stringify({ artifact, head: artifact, branch: "main", reason: "reviewed" }),
    )
    f.repository.changed()
  })
  const integrated = await read.read({ scope, limit: 100 })
  expect(integrated.next).toMatchObject({ status: "known", candidate: { taskID: child.task.id } })
  expect(read.workCounts.proofEvaluations).toBe(2)

  git(f.directory, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "new integrated baseline",
  ])
  const advanced = await read.read({ scope, limit: 100 })
  expect(advanced.next).toMatchObject({ status: "known", candidate: { taskID: child.task.id } })
  expect(read.workCounts.proofEvaluations).toBe(3)
  expect(read.workCounts.projectionBuilds).toBe(3)
})

test("a deferred Git proof yields to unrelated writes and discards its raced branch basis", async () => {
  const f = fixture()
  const parent = f.create("integrated-parent", 0)
  const child = f.create("after-parent", 10, false, [parent.plan.planID])
  const artifact = git(f.directory, ["rev-parse", "HEAD"])
  f.repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='cleaning',artifact=? WHERE id=?").run(
      artifact,
      parent.plan.planID,
    )
    db.query("UPDATE runner_nodes SET state='accepted',artifact=? WHERE plan_id=?").run(
      artifact,
      parent.plan.planID,
    )
    db.query(
      `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
       VALUES(?,NULL,3,'PLAN_ACCEPTED',?,1),(?,NULL,3,'INTEGRATION_RECORDED',?,2)`,
    ).run(
      parent.plan.planID,
      JSON.stringify({ artifact }),
      parent.plan.planID,
      JSON.stringify({ artifact, head: artifact, branch: "main", reason: "reviewed" }),
    )
    f.repository.changed()
  })

  let beginProof!: () => void
  let releaseProof!: () => void
  const proofStarted = new Promise<void>((resolve) => {
    beginProof = resolve
  })
  const proofGate = new Promise<void>((resolve) => {
    releaseProof = resolve
  })
  let deferred = false
  const runGit = async (directory: string, args: string[]) => {
    if (!deferred && args[0] === "merge-base") {
      deferred = true
      beginProof()
      await proofGate
    }
    return git(directory, args)
  }
  const read = new TaskSchedulingRead(f.store, () => 70, {}, runGit)
  const pendingRead = read.read({
    scope: { kind: "project", sessionID: "owner" },
    limit: 100,
  })
  await proofStarted

  const unrelatedWrite = f.create("unrelated-during-proof", -1)
  expect(unrelatedWrite.plan.planID).toBeDefined()
  git(f.directory, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "branch moved during read proof",
  ])
  releaseProof()

  const result = await pendingRead
  expect(result.next).toMatchObject({ status: "known", candidate: { taskID: child.task.id } })
  expect(read.workCounts.projectionBuilds).toBe(2)
  expect(read.workCounts.proofEvaluations).toBe(2)
  const refreshed = await read.read({
    scope: { kind: "project", sessionID: "owner" },
    limit: 100,
  })
  expect(refreshed.plans.map((plan) => plan.planID)).toContain(unrelatedWrite.plan.planID)
})

test("a transient proof I/O error returns unknown and a healthy first-page refresh recovers", async () => {
  const f = fixture()
  const parent = f.create("integrated-parent", 0)
  const child = f.create("after-parent", 10, false, [parent.plan.planID])
  const artifact = git(f.directory, ["rev-parse", "HEAD"])
  f.repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='cleaning',artifact=? WHERE id=?").run(
      artifact,
      parent.plan.planID,
    )
    db.query("UPDATE runner_nodes SET state='accepted',artifact=? WHERE plan_id=?").run(
      artifact,
      parent.plan.planID,
    )
    db.query(
      `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
       VALUES(?,NULL,3,'PLAN_ACCEPTED',?,1),(?,NULL,3,'INTEGRATION_RECORDED',?,2)`,
    ).run(
      parent.plan.planID,
      JSON.stringify({ artifact }),
      parent.plan.planID,
      JSON.stringify({ artifact, head: artifact, branch: "main", reason: "reviewed" }),
    )
    f.repository.changed()
  })

  let failOnce = true
  const runGit = async (directory: string, args: string[]) => {
    if (failOnce && args[0] === "merge-base") {
      failOnce = false
      throw new Error("temporary Git I/O failure")
    }
    return git(directory, args)
  }
  const read = new TaskSchedulingRead(f.store, () => 80, {}, runGit)
  const scope = { kind: "project" as const, sessionID: "owner" }
  const unavailable = await read.read({ scope, limit: 100 })
  expect(unavailable.next.status).toBe("unknown")
  expect(unavailable.next).not.toEqual({ status: "none" })
  expect(read.workCounts.projectionBuilds).toBe(1)

  const recovered = await read.read({ scope, limit: 100 })
  expect(recovered.next).toMatchObject({ status: "known", candidate: { taskID: child.task.id } })
  expect(recovered.snapshotID).not.toBe(unavailable.snapshotID)
  expect(read.workCounts.projectionBuilds).toBe(2)
  expect(read.workCounts.proofEvaluations).toBe(2)
})
