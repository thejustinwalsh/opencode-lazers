import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "../runner/store.ts"
import { refreshProgressDisplay } from "../progress/display-store.ts"
import { getTaskDetail } from "./stream-query.ts"
import { Schema } from "effect"
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

test("read observers cannot invalidate a committed receipt and a fresh process preserves the watermark", async () => {
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
  expect(open().list(100)).toHaveLength(2)
  unsubscribe()
  insert(repository)
  expect(called).toBe(1)
  expect(() => repository.insert({})).toThrow()
  expect(called).toBe(1)
})

test("unplanned detail is encodable by the native JSON RPC boundary", async () => {
  const { open } = fixture()
  const repository = open()
  const task = insert(repository)
  const detail = await getTaskDetail(repository, { taskID: task.id })
  expect(Schema.is(Schema.Json)(detail)).toBe(true)
  expect(Object.hasOwn(detail, "execution")).toBe(false)
  expect(detail).toHaveProperty("advice", null)
})

test("task advice is explicit without legacy attachments and shared by planned and unplanned reads", async () => {
  const repository = fixture().open()
  const unplannedTask = insert(repository, "Unplanned task advice fixture")
  const reads = {
    runner: new RunnerStore(repository),
    get: (query: Parameters<typeof getTaskDetail>[1]) => getTaskDetail(repository, query),
  }
  expect(await reads.get({ taskID: unplannedTask.id })).toMatchObject({
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
  expect(await reads.get({ taskID: unplannedTask.id })).toMatchObject({
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
  expect(await reads.get({ taskID: plannedTask.id })).toMatchObject({
    status: "found",
    execution: { taskID: plannedTask.id },
    architectSessionID: "owner-session",
    advice: { current: { revision: 1, taskID: plannedTask.id } },
  })
})

test("get, history and exact classification revisions agree", async () => {
  const { open } = fixture()
  const repository = open()
  const task = insert(repository, "Classification revision fixture")
  insert(repository, "Second classification fixture")
  const reads = {
    runner: new RunnerStore(repository),
    get: (query: Parameters<typeof getTaskDetail>[1]) => getTaskDetail(repository, query),
  }

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

  const detail = await reads.get({ taskID: task.id, classificationRevision: 1 })
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
  expect(await reads.get({ taskID: task.id, classificationRevision: 2 })).toMatchObject({
    status: "found",
    classificationAtRevision: detail.status === "found" ? detail.classification : null,
  })
  expect(await reads.get({ taskID: task.id, classificationRevision: 99 })).toMatchObject({
    status: "found",
    classificationAtRevision: null,
  })
  unsubscribe()
})

test("direct detail preserves the disposition of a retired task", async () => {
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
  const reads = {
    runner: new RunnerStore(repository),
    get: (query: Parameters<typeof getTaskDetail>[1]) => getTaskDetail(repository, query),
  }
  const detail = await reads.get({ taskID: task.id })
  expect(detail).toMatchObject({ status: "found", disposition: { disposition: "superseded" } })
})

test("the task read carries the model and a compact summary for the latest attempt only", async () => {
  const repository = fixture().open()
  const reads = {
    runner: new RunnerStore(repository),
    get: (query: Parameters<typeof getTaskDetail>[1]) => getTaskDetail(repository, query),
  }
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
  const attempts: string[] = [crypto.randomUUID(), crypto.randomUUID()]
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
          // Progress rows carry their attempt's session (80,287 of 80,287 live rows).
          `worker-${attempts.indexOf(attempt)}`,
          at,
          `call-${at}`,
          `dedupe-${at}`,
          JSON.stringify({ status, fileTargets: { operation: "edit", paths: files } }),
        )
    progress(attempts[0]!, 1_500, "succeeded", ["old.ts"])
    progress(attempts[1]!, 2_100, "succeeded", ["a.ts"])
    progress(attempts[1]!, 2_400, "failed", ["b.ts"])
    // The display rows the recorder writes beside each progress row.
    for (const { seq } of db.query<{ seq: number }, []>("SELECT seq FROM runner_progress").all())
      refreshProgressDisplay(db, seq)
  })
  const found = await reads.get({ taskID: task.id })
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

test("source plan provenance survives storage and task reads without inventing it for standalone tasks", async () => {
  const { open } = fixture()
  const repository = open()
  const standalone = insert(repository)
  const sourcePlan = { path: "design/roadmap.md", section: "Phase 2", line: 12 }
  const planned = repository.insert({
    ...standalone,
    id: crypto.randomUUID(),
    proposal: { ...standalone.proposal, sourcePlan },
  })
  const reads = {
    runner: new RunnerStore(repository),
    get: (query: Parameters<typeof getTaskDetail>[1]) => getTaskDetail(repository, query),
  }
  const detail = await reads.get({ taskID: planned.id })
  expect(detail.status === "found" && detail.task.proposal.sourcePlan).toEqual(sourcePlan)
  const plain = await reads.get({ taskID: standalone.id })
  expect(plain.status === "found" && plain.task.proposal.sourcePlan).toBeUndefined()
})
