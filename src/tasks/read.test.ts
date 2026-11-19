import { RecoveryDetector } from "../recovery/detector.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { TaskReads } from "./read.ts"
import { Schema } from "effect"
import { AssociationTaskReads } from "../observability/task-reads.ts"
import { recordTaskAdvice } from "./advice.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-reads-"))
  const path = join(directory, "tasks.sqlite")
  const repositories: TaskRepository[] = []
  const open = (project = "/project") => {
    const repository = new TaskRepository(path, project)
    repositories.push(repository)
    return repository
  }
  cleanups.push(() => {
    for (const repository of repositories) repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { open, path }
}
function insert(
  repository: TaskRepository,
  objective = "Implement bounded tasks.",
  sessionID = "session-a",
) {
  const proposal = validProposal()
  proposal.objective = objective
  proposal.writeScope = ["src/tasks/**"]
  proposal.acceptance[0]!.assertion = "Acceptance needle λ_%"
  proposal.context[0]!.reference = "Context needle λ_%"
  return repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-10-31T00:00:00.000Z",
    provenance: {
      projectID: "global",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: "/worktree",
      sessionID,
      startingRevision: { kind: "unborn" },
    },
    proposal,
  })
}

test("older records, literal filters, sessions and keyset snapshots stay bounded and isolated", () => {
  const { open } = fixture()
  const repository = open()
  const otherConnection = open()
  const otherProject = open("/other")
  const older = insert(repository, "Literal λ_% ' OR 1=1 --")
  let finalTaskID = ""
  for (let i = 0; i < 125; i++) {
    const task = insert(repository, `Task ${i}`, i % 2 ? "session-a" : "session-b")
    if (i === 124) finalTaskID = task.id
  }
  const foreign = insert(otherProject, "Literal λ_% ' OR 1=1 --")
  const reads = new TaskReads(repository)
  expect(reads.query({ search: older.id }).tasks.map((task) => task.taskID)).toEqual([older.id])
  expect(reads.query({ search: "LZ-126" }).tasks[0]).toMatchObject({
    taskID: finalTaskID,
    reference: "LZ-126",
    matches: [{ field: "reference", snippet: "LZ-126" }],
  })
  expect(reads.get({ taskID: "LZ-1" })).toMatchObject({
    status: "found",
    reference: "LZ-1",
    task: { id: older.id },
  })
  expect(new TaskReads(otherProject).get({ taskID: "LZ-1" })).toMatchObject({
    status: "found",
    task: { id: foreign.id },
  })
  expect(reads.query({ search: "λ_% ' OR 1=1 --" }).count).toBe(1)
  expect(reads.query({ search: "Acceptance needle λ_%", scopePath: "tasks/**" }).count).toBe(126)
  expect(reads.query({ search: "Context needle λ_%" }).count).toBe(126)
  expect(reads.query({ sessionID: "session-b" }).count).toBe(63)
  expect(reads.get({ taskID: foreign.id })).toEqual({ status: "not_found" })
  expect(reads.get({ taskID: older.id, sessionID: "session-b" })).toEqual({ status: "not_found" })
  expect(reads.get({ taskID: older.id, revision: 2 })).toEqual({
    status: "revision_unavailable",
    revision: 1,
  })
  const page = reads.query({ limit: 17 })
  const ids = page.tasks.map((task) => task.taskID)
  const inserted = insert(otherConnection, "Concurrent insert")
  let cursor = page.nextCursor
  while (cursor) {
    const next = reads.query({ limit: 17, cursor })
    expect(next.snapshot).toBe(page.snapshot)
    expect(next.count).toBe(126)
    ids.push(...next.tasks.map((task) => task.taskID))
    cursor = next.nextCursor
  }
  expect(ids).toHaveLength(126)
  expect(new Set(ids).size).toBe(126)
  expect(ids).not.toContain(inserted.id)
  expect(reads.query({}).count).toBe(127)
  expect(() => reads.query({ cursor: page.nextCursor!, search: "changed" })).toThrow(
    "does not match",
  )
  expect(() => new TaskReads(otherProject).query({ cursor: page.nextCursor! })).toThrow(
    "does not match",
  )
  for (const input of [
    { cursor: "bad" },
    { limit: 101 },
    { search: "a".repeat(201) },
    { worker: "fiction" },
  ])
    expect(() => reads.query(input)).toThrow()
})

test("read observers cannot invalidate a committed receipt and a fresh process preserves the watermark", () => {
  const { open, path } = fixture()
  const repository = open()
  let called = 0
  const unsubscribe = repository.subscribe(() => {
    called++
    throw new Error("notification lost")
  })
  const original = insert(repository)
  expect(called).toBe(1)
  expect(repository.get(original.id)).toEqual(original)
  const version = repository.version()
  const worker = spawnSync(
    process.execPath,
    [
      "-e",
      `
    import { TaskRepository } from ${JSON.stringify(new URL("../storage.ts", import.meta.url).pathname)};
    const repository = new TaskRepository(process.argv[1], "/project");
    const task = JSON.parse(process.argv[2]); task.id = crypto.randomUUID(); repository.insert(task); repository.close();
  `,
      path,
      JSON.stringify(original),
    ],
    { encoding: "utf8" },
  )
  expect(worker.status).toBe(0)
  expect(repository.version()).toBeGreaterThan(version)
  expect(new TaskReads(open()).query({}).count).toBe(2)
  unsubscribe()
  insert(repository)
  expect(called).toBe(1)
  expect(() => repository.insert({})).toThrow()
  expect(called).toBe(1)
})

test("unplanned detail is encodable by the native JSON RPC boundary", () => {
  const { open } = fixture()
  const repository = open()
  const task = insert(repository)
  const detail = new TaskReads(repository).get({ taskID: task.id })
  expect(Schema.is(Schema.Json)(detail)).toBe(true)
  expect(Object.hasOwn(detail, "execution")).toBe(false)
  expect(detail).toHaveProperty("advice", null)
})

test("task advice is explicit without legacy attachments and shared by planned and unplanned reads", () => {
  const repository = fixture().open()
  const unplannedTask = insert(repository, "Unplanned task advice fixture")
  const reads = new TaskReads(repository)
  expect(reads.get({ taskID: unplannedTask.id })).toMatchObject({
    status: "found",
    advice: null,
  })
  // S2-4: schema is startup-owned; reading an unadvised task creates no receipts.
  expect(
    repository.read((db) => db.query("SELECT count(*) AS count FROM task_advice").get()),
  ).toEqual({ count: 0 })

  const adviceInput = (taskID: string, requestID: string) => ({
    taskID,
    specRevision: 1,
    requestID,
    expectedRevision: 0,
    findings: ["Use the current shared task read boundary."],
    implementationAdvice: ["Keep attachments separate from approved task bytes."],
    references: [],
  })
  const unplannedAdvice = recordTaskAdvice(
    repository,
    adviceInput(unplannedTask.id, "read-unplanned-advice"),
    { sessionID: "architect-session", agent: "architect" },
  )
  expect(unplannedAdvice.status).toBe("recorded")
  expect(reads.get({ taskID: unplannedTask.id })).toMatchObject({
    status: "found",
    advice: {
      current: {
        revision: 1,
        projectDirectory: "/project",
        taskID: unplannedTask.id,
        specRevision: 1,
        provenance: { sessionID: "architect-session", agent: "architect" },
      },
      history: [{ revision: 1 }],
    },
  })

  const plannedTask = insert(repository, "Planned task advice fixture")
  recordTaskAdvice(repository, adviceInput(plannedTask.id, "read-planned-advice"), {
    sessionID: "architect-session",
    agent: "architect",
  })
  const proposal = validProposal()
  reads.runner.submit(
    {
      requestID: "planned-advice-fixture",
      objective: plannedTask.proposal.objective,
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: plannedTask.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [plannedTask.id],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    "owner-session",
  )
  expect(reads.get({ taskID: plannedTask.id })).toMatchObject({
    status: "found",
    execution: { taskID: plannedTask.id },
    architectSessionID: "owner-session",
    advice: { current: { revision: 1, taskID: plannedTask.id } },
  })
})

test("get, query, history and exact classification revisions agree and mutations stale cursors", () => {
  const { open } = fixture()
  const repository = open()
  const task = insert(repository, "Classification revision fixture")
  insert(repository, "Second classification fixture")
  const reads = new TaskReads(repository)
  const firstPage = reads.query({ limit: 1 })
  expect(firstPage.nextCursor).toBeTruthy()
  expect(firstPage.tasks[0]?.classification).toMatchObject({
    revision: 1,
    classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
    provenance: { kind: "embedded", sessionID: "session-a" },
  })

  let committedView: unknown
  const unsubscribe = repository.subscribe(() => {
    committedView = repository.taskClassification(task.id)?.current
  })
  const correction = repository.recordTaskClassification(
    {
      taskID: task.id,
      requestID: "read-classification-correction",
      expectedRevision: 1,
      classification: { taxonomy: "task-kind/v1", primaryKind: "documentation" },
      reason: "The primary acceptance outcome is documentation.",
    },
    { sessionID: "architect-session", agent: "architect" },
  )
  expect(correction.status).toBe("recorded")
  expect(committedView).toMatchObject({
    revision: 2,
    classification: correction.status === "recorded" ? correction.annotation.classification : null,
  })
  expect(() => reads.query({ limit: 1, cursor: firstPage.nextCursor! })).toThrow("changed")

  const detail = reads.get({ taskID: task.id, classificationRevision: 1 })
  expect(detail).toMatchObject({
    status: "found",
    task: { id: task.id, revision: 1 },
    classification: {
      revision: 2,
      classification: { taxonomy: "task-kind/v1", primaryKind: "documentation" },
    },
    classificationHistory: [
      {
        revision: 1,
        classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
      },
      { revision: 2, classification: { taxonomy: "task-kind/v1", primaryKind: "documentation" } },
    ],
    classificationAtRevision: {
      revision: 1,
      classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
    },
  })
  expect(reads.get({ taskID: task.id, classificationRevision: 2 })).toMatchObject({
    status: "found",
    classificationAtRevision: detail.status === "found" ? detail.classification : null,
  })
  expect(reads.get({ taskID: task.id, classificationRevision: 99 })).toMatchObject({
    status: "found",
    classificationAtRevision: null,
  })
  unsubscribe()
})

test("retired tasks disappear from open queries but direct detail preserves disposition", () => {
  const { open } = fixture()
  const repository = open()
  const task = insert(repository, "Legacy task replaced by the runner.")
  repository.recordDisposition(
    {
      taskID: task.id,
      requestID: "retire-read-test",
      disposition: "superseded",
      reason: "The integrated runner plan replaces this record.",
      evidence: [{ kind: "artifact", reference: ".agents/docs/spikes/011-runner-execution.md" }],
    },
    { sessionID: "architect", agent: "architect" },
  )
  const reads = new TaskReads(repository)
  expect(reads.query({}).tasks).toEqual([])
  const history = reads.query({ includeRetired: true })
  expect(history.count).toBe(1)
  expect(history.tasks[0]?.disposition?.disposition).toBe("superseded")
  expect(history.tasks[0]?.reason).toContain("integrated runner")
  const detail = reads.get({ taskID: task.id })
  expect(detail).toMatchObject({ status: "found", disposition: { disposition: "superseded" } })
})

test("open, failed and cancelled filters separate effective plan and node states", () => {
  const repository = fixture().open()
  const reads = new TaskReads(repository)
  const tasks = ["cancelled", "running", "failed", "exhausted", "cleanup-blocked"].map((state) => {
    const task = insert(repository, `Failed worker in ${state} plan`)
    const proposal = validProposal()
    const plan = reads.runner.submit(
      {
        requestID: `plan-${state}`,
        objective: task.proposal.objective,
        baseCommit: "a".repeat(40),
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: proposal.verification,
        acceptance: proposal.acceptance,
      },
      "architect",
    )
    // Seed the recorded worker-interruption states, without dispatching a worker.
    repository.atomic((db) => {
      db.query("UPDATE runner_plans SET state=? WHERE id=?").run(state, plan.planID)
      db.query(
        "UPDATE runner_nodes SET state='failed',reason='Worker interrupted' WHERE plan_id=?",
      ).run(plan.planID)
    })
    return task
  })
  for (const reader of [reads, new AssociationTaskReads(repository)])
    for (const sessionID of [undefined, "session-a"]) {
      const open = reader.query({ sessionID, state: "open" })
      expect(open.count).toBe(0)
      const legacyDefault = reader.query({ sessionID, limit: 10 })
      const legacyFalse = reader.query({ sessionID, includeCompleted: false, limit: 10 })
      const legacyTaskIDs = new Set(tasks.slice(1).map((task) => task.id))
      expect(legacyDefault.count).toBe(4)
      expect(legacyFalse.count).toBe(4)
      expect(new Set(legacyDefault.tasks.map((task) => task.taskID))).toEqual(legacyTaskIDs)
      expect(new Set(legacyFalse.tasks.map((task) => task.taskID))).toEqual(legacyTaskIDs)
      const failed = reader.query({ sessionID, state: "failed" })
      expect(failed.count).toBe(4)
      expect(new Set(failed.tasks.map((task) => task.taskID))).toEqual(
        new Set(tasks.slice(1).map((task) => task.id)),
      )
      expect(reader.query({ sessionID, state: "cancelled" }).tasks).toMatchObject([
        { taskID: tasks[0]!.id, status: "cancelled", reason: "Worker interrupted" },
      ])
      const history = reader.query({ sessionID, includeCompleted: true })
      expect(history.count).toBe(5)
      expect(history.tasks.find((task) => task.taskID === tasks[0]!.id)).toMatchObject({
        status: "cancelled",
        reason: "Worker interrupted",
      })
    }
  expect(reads.get({ taskID: tasks[0]!.id })).toMatchObject({ status: "found" })
})

test("queued, running and blocked filters use recorded node and plan states across pages", () => {
  const repository = fixture().open()
  const reads = new TaskReads(repository)
  const cases = [
    // S8: a blocked plan is not an executing or dispatchable task.
    { name: "queued normally", node: "queued", plan: "running", state: "queued" },
    { name: "running normally", node: "running", plan: "running", state: "running" },
    { name: "queued under hold", node: "queued", plan: "blocked", state: "queued" },
    { name: "running under hold", node: "running", plan: "blocked", state: "running" },
    { name: "node blocked", node: "blocked", plan: "running", state: "blocked" },
    { name: "accepted under hold", node: "accepted", plan: "blocked", state: "completed" },
    { name: "incorporated under hold", node: "incorporated", plan: "blocked", state: "completed" },
  ] as const
  const ids = new Map<string, string>()
  for (const item of cases) {
    const task = insert(repository, `Filter ${item.name}`)
    const proposal = validProposal()
    const plan = reads.runner.submit(
      {
        requestID: `filter-${item.name.replaceAll(" ", "-")}`,
        objective: task.proposal.objective,
        baseCommit: "a".repeat(40),
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: proposal.verification,
        acceptance: proposal.acceptance,
      },
      "architect",
    )
    repository.atomic((db) => {
      db.query("UPDATE runner_plans SET state=?,reason='reconciliation hold' WHERE id=?").run(
        item.plan,
        plan.planID,
      )
      db.query("UPDATE runner_nodes SET state=?,reason='node hold' WHERE plan_id=?").run(
        item.node,
        plan.planID,
      )
    })
    ids.set(item.name, task.id)
  }

  const expected = {
    queued: [ids.get("queued normally")!],
    running: [ids.get("running normally")!],
    blocked: [
      ids.get("queued under hold")!,
      ids.get("running under hold")!,
      ids.get("node blocked")!,
    ],
    completed: [ids.get("accepted under hold")!, ids.get("incorporated under hold")!],
  }
  for (const reader of [reads, new AssociationTaskReads(repository)]) {
    for (const [state, taskIDs] of Object.entries(expected)) {
      const first = reader.query({ state: state as "queued", sessionID: "session-a", limit: 1 })
      expect(first.count).toBe(taskIDs.length)
      const received = [...first.tasks.map((task) => task.taskID)]
      let cursor = first.nextCursor
      while (cursor) {
        const next = reader.query({
          state: state as "queued",
          sessionID: "session-a",
          limit: 1,
          cursor,
        })
        expect(next.snapshot).toBe(first.snapshot)
        expect(next.count).toBe(taskIDs.length)
        received.push(...next.tasks.map((task) => task.taskID))
        cursor = next.nextCursor
      }
      expect(new Set(received)).toEqual(new Set(taskIDs))
    }
    expect(reader.query({ state: "blocked", sessionID: "session-a", limit: 1 }).tasks.length).toBe(
      1,
    )
    expect(reader.query({ state: "running", sessionID: "session-a" }).tasks[0]).toMatchObject({
      taskID: ids.get("running normally"),
      status: "running",
      recordedState: "running",
    })
    expect(
      new Set(
        reader
          .query({ state: "completed", sessionID: "session-a" })
          .tasks.map((task) => task.status),
      ),
    ).toEqual(new Set(["accepted", "incorporated"]))
  }
})

test("current activity candidates are limited to requested, authorized latest attempt rows", () => {
  const repository = fixture().open()
  const reads = new TaskReads(repository)
  const task = insert(repository, "Held current worker")
  const foreign = insert(repository, "Foreign session task", "session-b")
  const proposal = validProposal()
  const plan = reads.runner.submit(
    {
      requestID: "current-activity-plan",
      objective: task.proposal.objective,
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: task.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    "architect",
  )
  repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='blocked',reason='reconcile' WHERE id=?").run(
      plan.planID,
    )
    db.query("UPDATE runner_nodes SET state='running',reason=NULL WHERE plan_id=?").run(plan.planID)
    const addAttempt = (id: string, number: number, sessionID: string) =>
      db
        .query(
          `INSERT INTO runner_attempts
          (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          plan.planID,
          task.id,
          number,
          sessionID,
          `message-${number}`,
          "/worktree",
          "a".repeat(40),
          null,
          "{}",
          "accepted",
          number,
        )
    addAttempt(crypto.randomUUID(), 1, "stale-worker")
    addAttempt(crypto.randomUUID(), 2, "latest-worker")
  })

  expect(reads.currentActivityTargets([task.id], "session-a")[0]).toMatchObject({
    authorized: true,
    attempt: { sessionID: "latest-worker", workspace: "/worktree", state: "accepted" },
    recordedState: "running",
    waiting: true,
    holdReason: "reconcile",
  })
  expect(reads.currentActivityTargets([foreign.id], "session-a")[0]).toMatchObject({
    authorized: false,
    attempt: null,
    recordedState: null,
  })
  expect(reads.currentActivityTargets([foreign.id])[0]).toMatchObject({
    authorized: true,
    attempt: null,
  })
  expect(() =>
    reads.currentActivityTargets(Array.from({ length: 41 }, () => crypto.randomUUID())),
  ).toThrow("invalid")
})

test("the task read carries the model and a compact summary for the latest attempt only", () => {
  const repository = fixture().open()
  const reads = new TaskReads(repository)
  const task = insert(repository, "Summarised attempts")
  const proposal = validProposal()
  const plan = reads.runner.submit(
    {
      requestID: "attempt-summary-plan",
      objective: task.proposal.objective,
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: task.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    "architect",
  )
  const attempts = [crypto.randomUUID(), crypto.randomUUID()]
  repository.atomic((db) => {
    attempts.forEach((id, index) =>
      db
        .query(
          `INSERT INTO runner_attempts
          (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,tool_count)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          plan.planID,
          task.id,
          index + 1,
          `worker-${index}`,
          `message-${index}`,
          "/worktree",
          "a".repeat(40),
          null,
          index === 1
            ? JSON.stringify({ model: { providerID: "openai", id: "gpt-6-luna", variant: "max" } })
            : "{}",
          index === 1 ? "running" : "failed",
          1_000 * (index + 1),
          index === 1 ? 2 : 1,
        ),
    )
    const progress = (attempt: string, at: number, status: string, files: string[]) =>
      db
        .query(
          `INSERT INTO runner_progress
           (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,sources_json,kind,event_ids_json,call_id,dedupe_key,payload)
           VALUES(?,?,?,?,?,?,?,'native','[]','tool','[]',?,?,?)`,
        )
        .run(
          repository.projectDirectory,
          "global",
          plan.planID,
          task.id,
          attempt,
          "worker",
          at,
          `call-${at}`,
          `dedupe-${at}`,
          JSON.stringify({ status, fileTargets: { operation: "edit", paths: files } }),
        )
    progress(attempts[0]!, 1_500, "succeeded", ["old.ts"])
    progress(attempts[1]!, 2_100, "succeeded", ["a.ts"])
    progress(attempts[1]!, 2_400, "failed", ["b.ts"])
  })
  const found = reads.get({ taskID: task.id })
  if (found.status !== "found") throw new Error("task not found")
  const [first, latest] = found.attempts!
  expect(first!.summary).toBeUndefined()
  expect(first!.model).toBeUndefined()
  expect(latest).toMatchObject({
    toolCount: 2,
    model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
    summary: {
      lastActivityAt: 2_400,
      ticks: [{ at: 2_100 }, { at: 2_400, failed: true }],
      files: 2,
    },
  })
})

test("source plan provenance survives storage and task reads without inventing it for standalone tasks", () => {
  const { open } = fixture()
  const repository = open()
  const standalone = insert(repository)
  const sourcePlan = { path: "design/roadmap.md", section: "Phase 2", line: 12 }
  const planned = repository.insert({
    ...standalone,
    id: crypto.randomUUID(),
    proposal: { ...standalone.proposal, sourcePlan },
  })
  const reads = new TaskReads(repository)
  expect(reads.query({}).tasks.find((task) => task.taskID === planned.id)?.sourcePlan).toEqual(
    sourcePlan,
  )
  const detail = reads.get({ taskID: planned.id })
  expect(detail.status === "found" && detail.task.proposal.sourcePlan).toEqual(sourcePlan)
  expect(
    new AssociationTaskReads(repository)
      .query({ sessionID: "session-a" })
      .tasks.find((task) => task.taskID === planned.id)?.sourcePlan,
  ).toEqual(sourcePlan)
  expect(
    reads.query({}).tasks.find((task) => task.taskID === standalone.id)?.sourcePlan,
  ).toBeUndefined()
})

test("paused dispatch is durable, filterable and distinct from active worker lifecycle", () => {
  const fixtureState = fixture()
  const repository = fixtureState.open()
  const active = insert(repository, "Already running")
  const waiting = insert(repository, "Wait for dispatch")
  const reads = new TaskReads(repository)
  const proposal = validProposal()
  const plan = reads.runner.submit(
    {
      requestID: "pause-reads",
      objective: "Pause dispatch only",
      baseCommit: "a".repeat(40),
      nodes: [active, waiting].map((task) => ({ taskID: task.id, revision: 1 })),
      dependencies: [],
      integrationOrder: [active.id, waiting.id],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    "session-a",
  )
  repository.atomic((db) =>
    db.query("UPDATE runner_plans SET state='running' WHERE id=?").run(plan.planID),
  )
  reads.runner.move(plan.planID, active.id, "READY")
  reads.runner.move(plan.planID, active.id, "DISPATCH")
  reads.runner.setDispatchPause(
    plan.planID,
    { reason: "Coordinate next wave", untilPlans: [] },
    { caller: "session-a" },
  )
  expect(reads.query({ state: "paused" }).tasks.map((task) => task.taskID)).toEqual([waiting.id])
  expect(reads.query({ state: "queued" }).count).toBe(0)
  expect(reads.query({ state: "running" }).tasks.map((task) => task.taskID)).toEqual([active.id])
  expect(reads.query({ state: "paused" }).tasks[0]).toMatchObject({
    recordedState: "queued",
    dispatchPause: { reason: "Coordinate next wave", untilPlans: [] },
    dispatchPausePlanID: plan.planID,
  })
  const reopened = new TaskReads(fixtureState.open())
  expect(reopened.runner.dispatchPause(plan.planID)).toEqual({
    reason: "Coordinate next wave",
    untilPlans: [],
  })
  reads.runner.setDispatchPause(plan.planID, null, { caller: "session-a" })
  expect(reopened.query({ state: "paused" }).count).toBe(0)
  expect(reopened.query({ state: "queued" }).tasks.map((task) => task.taskID)).toEqual([waiting.id])
})

test("a running task that trips a detector rule shows its open concern with totals across attempts", () => {
  const repository = fixture().open()
  const reads = new TaskReads(repository)
  const calm = insert(repository, "Calm task")
  const grind = insert(repository, "Grinding task")
  const proposal = validProposal()
  const plan = reads.runner.submit(
    {
      requestID: "concern-plan",
      objective: grind.proposal.objective,
      baseCommit: "a".repeat(40),
      nodes: [
        { taskID: calm.id, revision: 1 },
        { taskID: grind.id, revision: 1 },
      ],
      dependencies: [],
      integrationOrder: [calm.id, grind.id],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    "architect",
  )
  repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='running',reason=NULL WHERE id=?").run(plan.planID)
    db.query("UPDATE runner_nodes SET state='running',reason=NULL WHERE plan_id=?").run(plan.planID)
    const addAttempt = (taskID: string, number: number, tokens: number, state: string) =>
      db
        .query(
          `INSERT INTO runner_attempts
          (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count,tool_count)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          crypto.randomUUID(),
          plan.planID,
          taskID,
          number,
          `session-${taskID}-${number}`,
          `message-${taskID}-${number}`,
          "/worktree",
          "a".repeat(40),
          null,
          "{}",
          state,
          Date.now() - 60_000,
          tokens,
          100,
        )
    addAttempt(calm.id, 1, 1_000_000, "running")
    addAttempt(grind.id, 1, 40_000_000, "failed")
    addAttempt(grind.id, 2, 50_000_000, "running")
    for (let round = 0; round < 3; round++)
      db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,'VERIFY','{}',?)",
      ).run(plan.planID, grind.id, round + 1)
  })

  // Nothing is shown until the detector records a concern.
  expect(reads.query({ state: "all" }).tasks.some((task) => task.concern)).toBe(false)
  new RecoveryDetector({
    store: reads.runner,
    handoff: new HandoffStore(repository),
    now: Date.now,
  }).evaluate("owner", reads.runner.claim("owner", Date.now())!)
  const tasks = reads.query({ state: "all" }).tasks
  expect(tasks.find((task) => task.taskID === calm.id)?.concern).toBeUndefined()
  const found = tasks.find((task) => task.taskID === grind.id)?.concern
  expect(found?.reasons.toSorted()).toEqual(["token-spend-high", "verify-rounds-repeated"])
  expect(found?.line).toContain("3 verification rounds")
  expect(found?.totals).toMatchObject({ attempts: 2, verifyRounds: 3, toolCalls: 200 })
})
