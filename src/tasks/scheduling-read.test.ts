import { priorityFromHigherFirst } from "../../test/legacy-priority.ts"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "../runner/artifacts.ts"
import { RunnerStore } from "../runner/store.ts"
import { SchedulingOutput } from "./scheduling-contract.ts"
import { TaskSchedulingRead } from "./scheduling-read.ts"
import { DelegatedAgentCapacity } from "../runner/delegated-agent-capacity.ts"
import { setProjectSetting } from "../projects/settings.ts"
import { inspectPlan } from "../runner/inspection.ts"
import { TaskReads } from "./read.ts"

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
    sessionID = "owner",
    writeScope = [`${name}.ts`],
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
        sessionID,
        startingRevision: { kind: "git", commit: baseCommit },
      },
      proposal: { ...validProposal(), objective: name, writeScope },
    })
    const plan = store.submit(
      {
        requestID: `request-${name}`,
        title: `Plan ${name}`,
        objective: `Implement ${name}`,
        priority: priorityFromHigherFirst(priority),
        ...(afterPlans.length ? { afterPlans } : {}),
        baseCommit,
        workspaceMode: "isolated",
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: [],
        acceptance: [{ id: "done", assertion: "Done", evidence: [] }],
      },
      sessionID,
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

test("Session visibility preserves the project-wide winner and exposes it only when associated", async () => {
  const f = fixture()
  const local = f.create("session-a-winner", 20, false, [], "session-a")
  const unrelated = f.create("session-b-lower", 10, false, [], "session-b")
  const read = new TaskSchedulingRead(f.store, () => 11)
  const session = await read.read({
    scope: { kind: "session", sessionID: "session-a" },
    limit: 10,
  })
  expect(session.plans.map((plan) => plan.planID)).toEqual([local.plan.planID])
  expect(session.selectedTaskIDs).toEqual([local.task.id])
  expect(session.next).toMatchObject({ status: "known", candidate: { taskID: local.task.id } })
  expect(session.coverage).toMatchObject({
    planCount: 1,
    coveredPlanCount: 1,
    nodeCount: 1,
    coveredNodeCount: 1,
  })

  const project = await read.read({
    scope: { kind: "project", sessionID: "session-a" },
    limit: 10,
  })
  expect(project.plans.map((plan) => plan.planID)).toEqual([
    local.plan.planID,
    unrelated.plan.planID,
  ])
  expect(project.next).toMatchObject({ status: "known", candidate: { taskID: local.task.id } })
})

test("delegated-agent overflow is visible as a truthful Tasks and inspection wait", async () => {
  const f = fixture()
  const active = f.create("active-agent", 1)
  const waiting = f.create("waiting-agent", 0)
  const capacity = new DelegatedAgentCapacity(f.repository, "github.com/example/scheduling")
  setProjectSetting(f.repository, await capacity.key(), "limit", 1)
  const requestID = await capacity.ensureRunnerQueued({
    planID: active.plan.planID,
    taskID: active.task.id,
    attemptNumber: 1,
  })
  const attemptID = crypto.randomUUID()
  f.repository.atomic((db) => {
    expect(capacity.admitRunnerInTransaction(db, requestID, attemptID)).toBe(true)
    db.query("UPDATE runner_nodes SET state='running' WHERE plan_id=? AND task_id=?").run(
      active.plan.planID,
      active.task.id,
    )
    db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
       VALUES(?,?,?,1,?,?,?,?,?,'running',?)`,
    ).run(
      attemptID,
      active.plan.planID,
      active.task.id,
      "active-worker",
      "active-message",
      join(f.directory, ".worktree-active-agent"),
      git(f.directory, ["rev-parse", "HEAD"]),
      "{}",
      Date.now(),
    )
  })
  const waitingRequest = await capacity.ensureRunnerQueued({
    planID: waiting.plan.planID,
    taskID: waiting.task.id,
    attemptNumber: 1,
  })
  const page = await new TaskSchedulingRead(f.store, Date.now, {}, undefined, capacity).read({
    scope: { kind: "project", sessionID: "owner" },
    limit: 10,
  })

  expect(page).toMatchObject({
    next: { status: "waiting" },
    delegatedAgents: { limit: 1, active: 1, queued: 1 },
  })
  expect(page.plans.find((plan) => plan.planID === waiting.plan.planID)?.nodes[0]).toMatchObject({
    taskID: waiting.task.id,
    decision: "waiting",
    reason: "Waiting for delegated-agent capacity (1 of 1 slots in use).",
  })
  expect(waitingRequest).toBeTruthy()
  const capacityDetail = await capacity.inspectionSnapshot()
  const inspection = inspectPlan(
    f.store,
    { planID: waiting.plan.planID, full: false },
    capacityDetail,
  )
  expect(inspection).toMatchObject({
    nodes: [
      {
        taskID: waiting.task.id,
        reason: "Waiting for delegated-agent capacity (1 of 1 slots in use).",
      },
    ],
    plan: {
      schedule: {
        delegatedAgentCapacity: { limit: 1, active: 1, queued: 1 },
      },
    },
  })
})

test("Session associations include same-project afterPlans prerequisites but not unrelated plans", async () => {
  const f = fixture()
  const prerequisite = f.create("session-b-linked-prerequisite", 0, false, [], "session-b")
  const local = f.create("session-a-plan", 20, false, [prerequisite.plan.planID], "session-a")
  const unrelated = f.create("session-b-unrelated", -10, false, [], "session-b")
  const read = new TaskSchedulingRead(f.store, () => 13)
  const result = await read.read({
    scope: { kind: "session", sessionID: "session-a" },
    limit: 10,
  })
  expect(result.plans.map((plan) => plan.planID)).toEqual([
    local.plan.planID,
    prerequisite.plan.planID,
  ])
  expect(result.plans[0]?.afterPlans).toEqual([prerequisite.plan.planID])
  expect(result.plans[0]?.nodes[0]).toMatchObject({
    waitingOn: [],
    waitingOnPlans: [prerequisite.plan.planID],
  })
  expect(result.plans.map((plan) => plan.planID)).not.toContain(unrelated.plan.planID)
  expect(result.next).toMatchObject({
    status: "known",
    candidate: { taskID: prerequisite.task.id, planID: prerequisite.plan.planID },
  })
  expect(result.coverage).toMatchObject({
    planCount: 2,
    coveredPlanCount: 2,
    nodeCount: 2,
    coveredNodeCount: 2,
  })
})

test("task, scheduling, and inspection reads expose bounded project-scoped plan prerequisite facts", async () => {
  const f = fixture()
  const prerequisite = f.create("source-prerequisite", 1)
  const dependent = f.create("dependent-plan", 2, false, [prerequisite.plan.planID])
  const tasks = new TaskReads(f.repository)

  const task = tasks.get({ taskID: dependent.task.id })
  expect(task).toMatchObject({
    status: "found",
    execution: {
      waitingOnPlans: [
        {
          planID: prerequisite.plan.planID,
          title: "Plan source-prerequisite",
          state: "running",
          version: 1,
        },
      ],
      waitingOnPlansCount: 1,
      waitingOnPlansComplete: true,
    },
  })
  if (task.status !== "found") throw new Error("Expected task detail")
  const execution = task.execution
  if (!execution) throw new Error("Expected task execution")
  expect(execution.reason).toContain("Waiting for prerequisite integration")
  expect(execution.reason).toContain(prerequisite.plan.planID)

  const inspection = inspectPlan(f.store, {
    planID: dependent.plan.planID,
    full: false,
  })
  expect(inspection).toMatchObject({
    waitingOnPlans: [
      {
        planID: prerequisite.plan.planID,
        title: "Plan source-prerequisite",
        state: "running",
        version: 1,
      },
    ],
    waitingOnPlansCount: 1,
    waitingOnPlansComplete: true,
  })
  expect(inspectPlan(f.store, { planID: dependent.plan.planID, full: true })).toMatchObject({
    waitingOnPlans: [
      {
        planID: prerequisite.plan.planID,
        title: "Plan source-prerequisite",
        state: "running",
        version: 1,
      },
    ],
    waitingOnPlansCount: 1,
    waitingOnPlansComplete: true,
  })

  const schedule = await new TaskSchedulingRead(f.store, () => 13).read({
    scope: { kind: "project", sessionID: "owner" },
    limit: 10,
  })
  expect(
    schedule.plans.find((plan) => plan.planID === dependent.plan.planID)?.nodes[0],
  ).toMatchObject({
    decision: "waiting",
    reason: "Waiting for accepted prerequisite plans to be integrated.",
    waitingOnPlans: [prerequisite.plan.planID],
  })

  f.repository.atomic((db) => {
    db.query(
      "UPDATE runner_plans SET state='cancelled',reason='cancelled by owner' WHERE id=?",
    ).run(prerequisite.plan.planID)
    f.repository.changed()
  })
  const cancelled = tasks.get({ taskID: dependent.task.id })
  if (cancelled.status !== "found") throw new Error("Expected task detail")
  const cancelledExecution = cancelled.execution
  if (!cancelledExecution) throw new Error("Expected task execution")
  expect(cancelledExecution.reason).toContain("cancelled")
  expect(cancelledExecution.reason).toContain("never restarted automatically")
  expect(cancelledExecution.waitingOnPlans?.[0]).toMatchObject({
    planID: prerequisite.plan.planID,
    state: "cancelled",
    reason: "cancelled by owner",
  })
  const cancelledSchedule = await new TaskSchedulingRead(f.store, () => 14).read({
    scope: { kind: "project", sessionID: "owner" },
    limit: 10,
  })
  const cancelledScheduleNode = cancelledSchedule.plans.find(
    (plan) => plan.planID === dependent.plan.planID,
  )?.nodes[0]
  expect(cancelledScheduleNode?.reason).toContain("never restarted automatically")
  expect(cancelledScheduleNode?.waitingOnPlans).toEqual([prerequisite.plan.planID])
})

test("unknown plan prerequisite facts are explicitly incomplete in Tasks and inspection", () => {
  const f = fixture()
  const dependent = f.create("unknown-prerequisite", 1)
  f.repository.atomic((db) => {
    db.query(
      "UPDATE runner_plans SET body=json_set(body,'$.afterPlans','not-an-array') WHERE id=?",
    ).run(dependent.plan.planID)
    f.repository.changed()
  })

  const task = new TaskReads(f.repository).get({ taskID: dependent.task.id })
  if (task.status !== "found") throw new Error("Expected task detail")
  expect(task.execution).toMatchObject({
    waitingOnPlans: [],
    waitingOnPlansCount: 0,
    waitingOnPlansComplete: false,
    reason: "Prerequisite plan facts are incomplete; dependent work remains queued.",
  })
  expect(inspectPlan(f.store, { planID: dependent.plan.planID, full: false })).toMatchObject({
    waitingOnPlans: [],
    waitingOnPlansCount: 0,
    waitingOnPlansComplete: false,
  })
})

test.each([100, 101])(
  "complete reservation facts with %i blockers remain schema-safe and render bounded blocker links",
  async (reservationCount) => {
    const f = fixture()
    const target = f.create("reservation-target", 1_000, false, [], "session-a", ["shared.ts"])
    const blockers = Array.from({ length: reservationCount }, (_, index) =>
      f.create(`reservation-${index}`, 100, false, [], "session-b", ["shared.ts"]),
    )
    const globalNext = f.create("global-next", -1, false, [], "session-b", ["other.ts"])
    const baseCommit = git(f.directory, ["rev-parse", "HEAD"])

    f.repository.atomic((db) => {
      const setRunning = db.query(
        "UPDATE runner_nodes SET state='running' WHERE plan_id=? AND task_id=?",
      )
      const insertAttempt = db.query(
        `INSERT INTO runner_attempts
          (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
         VALUES(?,?,?,?,?,?,?,?,?,'running',?)`,
      )
      for (const [index, blocker] of blockers.entries()) {
        setRunning.run(blocker.plan.planID, blocker.task.id)
        insertAttempt.run(
          crypto.randomUUID(),
          blocker.plan.planID,
          blocker.task.id,
          1,
          `worker-${index}`,
          `message-${index}`,
          join(f.directory, `.worktree-${index}`),
          baseCommit,
          JSON.stringify({ workspaceMode: "isolated" }),
          index,
        )
      }
      f.repository.changed()
    })

    // The project's limit (Projects settings) is below the synthetic active reservations.
    const capacity = new DelegatedAgentCapacity(f.repository)
    setProjectSetting(f.repository, await capacity.key(), "limit", 3)
    const read = new TaskSchedulingRead(f.store, () => 90)
    const scope = { kind: "project" as const, sessionID: "session-a" }
    const firstPage = SchedulingOutput.parse(await read.read({ scope, limit: 100 }))
    const targetNode = firstPage.plans[0]?.nodes.find((node) => node.taskID === target.task.id)
    expect(targetNode).toMatchObject({
      decision: "waiting",
      reason: "A conflicting write scope is reserved.",
      reservationTaskCount: reservationCount,
      reservationTaskIDsComplete: reservationCount <= 100,
      reservationTaskIDsScopeLimited: false,
    })
    expect(targetNode?.reservationTaskIDs).toHaveLength(Math.min(reservationCount, 100))
    expect(firstPage.coverage).toMatchObject({
      status: "complete",
      activeReservationCount: reservationCount,
      reservationsComplete: true,
    })
    expect(firstPage.selectionComplete).toBe(true)
    expect(firstPage.next).toMatchObject({
      status: "waiting",
      reason: "Waiting for delegated-agent capacity; all configured slots are in use.",
    })
    // With spare capacity, the unrelated candidate remains the global next task.
    setProjectSetting(f.repository, await capacity.key(), "limit", reservationCount + 1)
    expect((await read.read({ scope, limit: 100 })).next).toMatchObject({
      status: "known",
      candidate: { taskID: globalNext.task.id },
    })

    const session = SchedulingOutput.parse(
      await read.read({ scope: { kind: "session", sessionID: "session-a" }, limit: 100 }),
    )
    const sessionTarget = session.plans[0]?.nodes.find((node) => node.taskID === target.task.id)
    expect(session.plans.map((plan) => plan.planID)).toEqual([target.plan.planID])
    expect(sessionTarget).toMatchObject({
      decision: "waiting",
      reservationTaskCount: 0,
      reservationTaskIDs: [],
      reservationTaskIDsComplete: true,
      reservationTaskIDsScopeLimited: true,
    })
    expect(session.coverage.reservationsComplete).toBe(true)
    expect(session.next.status).toBe("unknown")
    expect(session.next).not.toMatchObject({ candidate: { taskID: globalNext.task.id } })
  },
)

test("partial reservation capture keeps known blockers waiting and unknown candidates ineligible", async () => {
  const f = fixture()
  const knownBlocked = f.create("known-blocked", 1_000, false, [], "session-a", ["known.ts"])
  const unknownCandidate = f.create("unknown-candidate", 900, false, [], "session-a", [
    "omitted.ts",
  ])
  const captured = f.create("captured-reservation", 10, false, [], "session-b", ["known.ts"])
  const omitted = f.create("omitted-reservation", 0, false, [], "session-b", ["omitted.ts"])
  const baseCommit = git(f.directory, ["rev-parse", "HEAD"])
  f.repository.atomic((db) => {
    const setRunning = db.query(
      "UPDATE runner_nodes SET state='running' WHERE plan_id=? AND task_id=?",
    )
    const insertAttempt = db.query(
      `INSERT INTO runner_attempts
        (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
       VALUES(?,?,?,?,?,?,?,?,?,'running',?)`,
    )
    for (const [index, reservation] of [captured, omitted].entries()) {
      setRunning.run(reservation.plan.planID, reservation.task.id)
      insertAttempt.run(
        crypto.randomUUID(),
        reservation.plan.planID,
        reservation.task.id,
        1,
        `partial-worker-${index}`,
        `partial-message-${index}`,
        join(f.directory, `.partial-worktree-${index}`),
        baseCommit,
        JSON.stringify({ workspaceMode: "isolated" }),
        index,
      )
    }
    f.repository.changed()
  })

  const read = new TaskSchedulingRead(f.store, () => 91, { maxReservations: 1 })
  const page = SchedulingOutput.parse(
    await read.read({ scope: { kind: "project", sessionID: "session-a" }, limit: 100 }),
  )
  const nodes = new Map(page.plans.flatMap((plan) => plan.nodes.map((node) => [node.taskID, node])))
  expect(page.coverage).toMatchObject({
    status: "partial",
    activeReservationCount: 2,
    reservationsComplete: false,
  })
  expect(nodes.get(knownBlocked.task.id)).toMatchObject({
    decision: "waiting",
    reservationTaskIDs: [captured.task.id],
    reservationTaskCount: 1,
    reservationTaskIDsComplete: false,
    reservationTaskIDsScopeLimited: false,
  })
  expect(nodes.get(unknownCandidate.task.id)).toMatchObject({
    decision: "unknown",
    reason: "Active reservation coverage is incomplete; task eligibility cannot be established.",
    reservationTaskIDs: [],
    reservationTaskCount: 0,
    reservationTaskIDsComplete: false,
    reservationTaskIDsScopeLimited: false,
  })
  expect(page.selectedTaskIDs).toEqual([])
  expect(page.selectionComplete).toBe(false)
  expect(page.next.status).toBe("unknown")
  expect(page.next).not.toEqual({ status: "none" })
  expect(omitted.task.id).not.toBe(captured.task.id)
})

test("an outside-Session global winner never promotes a lower local task and pages stay scoped", async () => {
  const f = fixture()
  const unrelated = f.create("outside-session-winner", 50, false, [], "session-b")
  const firstLocal = f.create("session-a-first", 10, false, [], "session-a")
  const secondLocal = f.create("session-a-second", 1, false, [], "session-a")
  const read = new TaskSchedulingRead(f.store, () => 12)
  const scope = { kind: "session" as const, sessionID: "session-a" }
  const first = await read.read({ scope, limit: 1 })
  expect(first.plans.map((plan) => plan.planID)).toEqual([firstLocal.plan.planID])
  expect(first.plans[0]?.planOrder).toBe(1)
  expect(first.selectedTaskIDs).toEqual([firstLocal.task.id, secondLocal.task.id])
  expect(first.next).toMatchObject({ status: "unknown" })
  expect(first.next).not.toMatchObject({ candidate: { taskID: firstLocal.task.id } })
  expect(first.plans.map((plan) => plan.planID)).not.toContain(unrelated.plan.planID)
  expect(first.coverage).toMatchObject({
    planCount: 2,
    coveredPlanCount: 2,
    nodeCount: 2,
    coveredNodeCount: 2,
  })

  const second = await read.read({ scope, cursor: first.nextCursor!, limit: 1 })
  expect(second.snapshotID).toBe(first.snapshotID)
  expect(second.plans.map((plan) => plan.planID)).toEqual([secondLocal.plan.planID])
  expect(second.next).toEqual(first.next)
  expect(second.coverage).toEqual(first.coverage)
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

test("scheduling facts include live reservations outside the display plan limit", () => {
  const f = fixture()
  f.create("visible", 1000)
  const blocker = f.create("blocker", 0)
  const baseCommit = git(f.directory, ["rev-parse", "HEAD"])
  f.repository.atomic((db) => {
    db.query(
      `WITH RECURSIVE filler(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM filler WHERE n<999)
       INSERT INTO runner_plans (id,project_directory,owner,revision,version,state,body)
       SELECT 'filler-'||n,?,'owner',1,1,'cancelled','{"priority":1}' FROM filler`,
    ).run(f.directory)
    db.query(
      `INSERT INTO runner_attempts
        (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
       VALUES('blocker-attempt',?,?,1,'worker','message',?,?,'{}','running',0)`,
    ).run(blocker.plan.planID, blocker.task.id, join(f.directory, ".worktree"), baseCommit)
  })
  const facts = f.store.schedulingFacts({ maxPlans: 1 })
  expect(facts.plans).toHaveLength(1)
  expect(facts.totalReservationCount).toBe(1)
  expect(facts.reservationsComplete).toBe(true)
  expect(facts.reservations.map((attempt) => attempt.task_id)).toEqual([blocker.task.id])
})

test("an explicit dispatch pause removes a ready plan from Next until it is unpaused", async () => {
  const f = fixture()
  const first = f.create("paused", 9)
  const second = f.create("next", 1)
  const read = new TaskSchedulingRead(f.store, () => 92)
  const scope = { kind: "project" as const, sessionID: "owner" }

  f.store.setDispatchPause(first.plan.planID, { reason: "Waiting to dispatch", untilPlans: [] }, {})
  const paused = await read.read({ scope, limit: 100 })
  expect(paused.plans[0]?.nodes[0]).toMatchObject({
    decision: "waiting",
    reason: "Waiting to dispatch",
    waitingOn: [],
  })
  expect(paused.next).toMatchObject({ status: "known", candidate: { taskID: second.task.id } })

  f.store.setDispatchPause(first.plan.planID, null, {})
  const resumed = await read.read({ scope, limit: 100 })
  expect(resumed.next).toMatchObject({ status: "known", candidate: { taskID: first.task.id } })
})

test("a conditional pause keeps dispatch waiting until the prerequisite source integrates", async () => {
  const f = fixture()
  const parent = f.create("pause-prerequisite", 1)
  const child = f.create("conditionally-paused", 9)
  const read = new TaskSchedulingRead(f.store, () => 93)
  const scope = { kind: "project" as const, sessionID: "owner" }
  f.store.setDispatchPause(
    child.plan.planID,
    { reason: "Waiting for prerequisite source", untilPlans: [parent.plan.planID] },
    {},
  )
  const paused = await read.read({ scope, limit: 100 })
  expect(paused.plans[0]?.nodes[0]).toMatchObject({
    decision: "waiting",
    waitingOnPlans: [parent.plan.planID],
  })
  expect(paused.next).toMatchObject({ status: "known", candidate: { taskID: parent.task.id } })

  const artifact = git(f.directory, ["rev-parse", "HEAD"])
  f.repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='cleaning',artifact=? WHERE id=?").run(
      artifact,
      parent.plan.planID,
    )
    f.store.record(parent.plan.planID, null, "PLAN_ACCEPTED", { artifact })
    f.store.record(parent.plan.planID, null, "INTEGRATION_RECORDED", {
      artifact,
      head: artifact,
      branch: "main",
      reason: "reviewed",
    })
  })
  const ready = await read.read({ scope, limit: 100 })
  expect(ready.next).toMatchObject({ status: "known", candidate: { taskID: child.task.id } })
})

test("more than 100 waiting plan references remain bounded, counted, and navigable", async () => {
  const f = fixture()
  const prerequisites = Array.from(
    { length: 101 },
    (_, index) => f.create(`many-prerequisite-${index}`, -1).plan.planID,
  )
  const dependent = f.create("many-prerequisite-dependent", 100, false, prerequisites)
  const page = SchedulingOutput.parse(
    await new TaskSchedulingRead(f.store, () => 95).read({
      scope: { kind: "project", sessionID: "owner" },
      limit: 100,
    }),
  )
  const node = page.plans[0]?.nodes.find((candidate) => candidate.taskID === dependent.task.id)
  expect(node).toMatchObject({
    decision: "waiting",
    waitingOnPlans: prerequisites.slice(0, 100),
    waitingOnPlansCount: 101,
    waitingOnPlansComplete: false,
  })
})

test("an unknown resume condition leaves Next unknown", async () => {
  const f = fixture()
  const paused = f.create("pause-proof-missing", 9)
  f.create("lower-priority", 1)
  f.store.setDispatchPause(
    paused.plan.planID,
    { reason: "Waiting for prerequisite source", untilPlans: [crypto.randomUUID()] },
    {},
  )

  const read = new TaskSchedulingRead(f.store, () => 94)
  const page = await read.read({ scope: { kind: "project", sessionID: "owner" }, limit: 100 })
  expect(page.plans[0]?.decision).toBe("unknown")
  expect(page.next.status).toBe("unknown")
})
