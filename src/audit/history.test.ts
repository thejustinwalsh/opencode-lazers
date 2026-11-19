import { setFallowConfig } from "./config.ts"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskReads } from "../tasks/read.ts"
import { taskInstructions } from "../tasks/instructions.ts"
import { AuditHistory } from "./history.ts"
import { importAudit, fallowReport } from "./report.ts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lz-audit-history-")))
  const workspace = join(root, "checkout")
  mkdirSync(workspace)
  const path = join(root, "data", "tasks.sqlite")
  const connections: TaskRepository[] = []
  const open = (project = workspace) => {
    const r = new TaskRepository(path, project)
    connections.push(r)
    return r
  }
  cleanups.push(() => {
    for (const r of connections) r.close()
    rmSync(root, { recursive: true, force: true })
  })
  const repository = open(),
    runner = new RunnerStore(repository),
    proposal = validProposal()
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory: workspace,
      workspaceDirectory: workspace,
      sessionID: "architect",
      startingRevision: { kind: "unborn" },
    },
    proposal,
  })
  const plan = runner.submit(
    {
      requestID: "plan",
      objective: "Simplify the system",
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: task.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    "architect",
  )
  const attemptID = crypto.randomUUID(),
    sessionID = "auditor-worker"
  repository.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
    VALUES(?,?,?,?,?,?,?,?,?,'running',?)`,
      )
      .run(
        attemptID,
        plan.planID,
        task.id,
        1,
        sessionID,
        "input",
        workspace,
        "a".repeat(40),
        JSON.stringify({ agent: "auditor" }),
        Date.now(),
      ),
  )
  const history = new AuditHistory(repository),
    actor = { sessionID, agent: "auditor" }
  return {
    root,
    workspace,
    path,
    repository,
    history,
    actor,
    attemptID,
    task,
    planID: plan.planID,
    open,
  }
}
const report = {
  schema_version: 1,
  summary: { total_issues: 2 },
  unused_exports: [
    { path: "src/a.ts", line: 10, col: 1, export_name: "unused" },
    { path: "src/b.ts", line: 20, col: 2, export_name: "alsoUnused" },
  ],
}

test("audit history, pairing and finding decisions survive checkout/export deletion and database reopen", async () => {
  const f = fixture()
  const start = f.history.start({ requestID: "before", workspace: f.workspace }, f.actor)
  expect(start.run).toMatchObject({
    taskID: f.task.id,
    planID: f.planID,
    attemptID: f.attemptID,
    sessionID: f.actor.sessionID,
    phase: "baseline",
  })
  f.history.section(start.run.runID, "deadCode", report)
  f.history.finish(start.run.runID)
  const finding = f.history.detail(start.run.runID, { limit: 1 }).findings[0]!
  const after = f.history.start({ requestID: "after", workspace: f.workspace }, f.actor)
  expect(after.run.baselineRunID).toBe(start.run.runID)
  expect(after.run.phase).toBe("follow-up")
  f.history.section(after.run.runID, "deadCode", {
    summary: { total_issues: 0 },
    unused_exports: [],
  })
  f.history.finish(after.run.runID)
  f.history.decide(
    {
      requestID: "defer",
      runID: start.run.runID,
      findingID: finding.findingID,
      disposition: "deferred",
      note: "Inspect the dynamic entry point first",
    },
    f.actor,
  )
  f.history.decide(
    {
      requestID: "fixed",
      runID: start.run.runID,
      findingID: finding.findingID,
      disposition: "fixed",
      note: "Removed unused export; related behavior tests passed",
      followupRunID: after.run.runID,
    },
    { sessionID: "architect", agent: "architect" },
  )
  const task = new TaskReads(f.repository).get({ taskID: f.task.id })
  expect(task).toMatchObject({ auditHistory: { runCount: 2, latestRunID: after.run.runID } })
  expect(taskInstructions(task)).toContain("lz-query-audits")
  expect(new RunnerStore(f.repository).attempts(f.planID)[0]!.state).toBe("running")
  const exported = await f.history.export(start.run.runID)
  f.repository.close()
  rmSync(f.workspace, { recursive: true })
  rmSync(exported)
  const reopened = new AuditHistory(f.open())
  const detail = reopened.detail(start.run.runID, { path: "src/a.ts" })
  expect(detail.findings[0]!.findingID).toBe(finding.findingID)
  expect(detail.findings[0]!.decisions.map((d) => d.disposition)).toEqual(["deferred", "fixed"])
  expect(detail.findings[0]!.decisions.every((d) => Number.isInteger(d.createdAt))).toBe(true)
  expect(reopened.list({ taskID: "LZ-1" }).runs).toHaveLength(2)
  expect(reopened.list({ attemptID: f.attemptID }).runs).toHaveLength(2)
  expect(reopened.list({ planID: f.planID, limit: 1 }).nextOffset).toBe(1)
  await reopened.export(start.run.runID)
  expect(JSON.parse(readFileSync(exported, "utf8")).reports.deadCode).toEqual(report)
})

test("partial results are durable before finish and a replay does not rescan or duplicate history", () => {
  const f = fixture(),
    input = { requestID: "interrupted", workspace: f.workspace }
  const start = f.history.start(input, f.actor)
  f.history.section(start.run.runID, "deadCode", report)
  f.repository.close()
  const history = new AuditHistory(f.open())
  expect(history.get(start.run.runID)).toMatchObject({ state: "collecting", finishedAt: null })
  expect(history.detail(start.run.runID).totalFindings).toBe(2)
  expect(
    history.start({ workspace: f.workspace, requestID: "interrupted" }, f.actor),
  ).toMatchObject({ created: false, run: { runID: start.run.runID } })
  expect(history.list().runs).toHaveLength(1)
  expect(() => history.start({ ...input, phase: "follow-up" }, f.actor)).toThrow(
    "different audit request",
  )
  history.finish(start.run.runID, "Host interrupted")
  expect(history.get(start.run.runID).state).toBe("interrupted")
  expect(() => history.section(start.run.runID, "health", {})).toThrow("finished")
})

test("project scope and runtime assignment prevent false audit associations", () => {
  const f = fixture(),
    start = f.history.start({ requestID: "scan", workspace: f.workspace }, f.actor)
  const foreign = new AuditHistory(f.open("/other-project"))
  expect(foreign.list().runs).toEqual([])
  expect(() => foreign.get(start.run.runID)).toThrow("not found in this project")
  expect(() =>
    foreign.start(
      { requestID: "foreign", workspace: f.workspace, baselineRunID: start.run.runID },
      { sessionID: "owner", agent: "architect" },
    ),
  ).toThrow("not found in this project")
  expect(() =>
    f.history.start(
      { requestID: "wrong-task", workspace: f.workspace, taskID: crypto.randomUUID() },
      f.actor,
    ),
  ).toThrow("does not match")
  expect(() =>
    f.history.start({ requestID: "wrong-workspace", workspace: f.root }, f.actor),
  ).toThrow("workspace differs")
})

test("finding decisions retain prior assessments and replay only the same request", () => {
  const f = fixture(),
    start = f.history.start({ requestID: "scan", workspace: f.workspace }, f.actor)
  f.history.section(start.run.runID, "deadCode", report)
  f.history.finish(start.run.runID)
  const finding = f.history.detail(start.run.runID).findings[0]!
  const input = {
    requestID: "decision",
    runID: start.run.runID,
    findingID: finding.findingID,
    disposition: "retained" as const,
    note: "Public plugin API",
  }
  expect(f.history.decide(input, f.actor)).toEqual(f.history.decide(input, f.actor))
  expect(() => f.history.decide({ ...input, note: "Other decision" }, f.actor)).toThrow(
    "different finding decision",
  )
  expect(f.history.detail(start.run.runID).findings[0]!.decisions).toHaveLength(1)
  expect(() =>
    f.history.decide({ ...input, requestID: "wrong", findingID: "missing" }, f.actor),
  ).toThrow("Finding not found")
  expect(f.history.detail(start.run.runID, { path: "src/b.ts", limit: 1 }).findings[0]!.path).toBe(
    "src/b.ts",
  )
})

test("legacy report import preserves original provenance, errors, findings and task attachment", async () => {
  const f = fixture(),
    path = join(f.workspace, "legacy.json")
  const legacy = {
    schemaVersion: 1,
    workspace: "/old/worker",
    startedAt: 100,
    finishedAt: 200,
    reports: { deadCode: report, health: { error: "Original scan error" } },
  }
  writeFileSync(path, JSON.stringify(legacy))
  const input = { requestID: "import", workspace: f.workspace, path }
  const saved = await importAudit(f.history, input, f.actor)
  expect(saved).toMatchObject({
    taskID: f.task.id,
    attemptID: f.attemptID,
    state: "partial",
    source: "legacy-file",
    phase: "inspection",
    importedMetadata: { workspace: "/old/worker", startedAt: 100 },
  })
  expect(f.history.detail(saved.runID).totalFindings).toBe(2)
  expect((await importAudit(f.history, input, f.actor)).runID).toBe(saved.runID)
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(legacy)
})

test("a cancelled real scan leaves a retrievable interrupted run without task failure", async () => {
  const f = fixture(),
    controller = new AbortController()
  controller.abort(new Error("Cancelled scan"))
  setFallowConfig(f.repository, {}, f.actor, "fixture")
  await expect(
    fallowReport(
      f.history,
      { requestID: "cancel", workspace: f.workspace },
      f.actor,
      controller.signal,
    ),
  ).rejects.toThrow("Cancelled scan")
  const saved = f.history.list().runs[0]!
  expect(saved).toMatchObject({ state: "interrupted", taskID: f.task.id, attemptID: f.attemptID })
  expect(new RunnerStore(f.repository).attempts(f.planID)[0]!.state).toBe("running")
})
