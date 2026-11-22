import { setFallowConfig } from "./config.ts"
import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "../runner/store.ts"
import { getTaskDetail } from "../tasks/stream-query.ts"
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
const many = (count: number) => ({
  summary: { total_issues: count },
  unused_exports: Array.from({ length: count }, (_, index) => ({
    path: `src/f${index}.ts`,
    line: index + 1,
    export_name: `e${index}`,
  })),
})

test("finish, detail, decide and export read findings from an index and never reparse every section", async () => {
  const f = fixture()
  const start = f.history.start({ requestID: "indexed", workspace: f.workspace }, f.actor)
  const runID = start.run.runID
  f.history.section(runID, "deadCode", many(30))
  f.history.section(runID, "health", { summary: {}, complexity: [{ path: "src/x.ts", line: 2 }] })

  const parses: string[] = []
  const parse = JSON.parse
  JSON.parse = ((text: string, ...rest: []) => {
    parses.push(text.slice(0, 40))
    return parse(text, ...rest)
  }) as typeof JSON.parse
  try {
    const finished = f.history.finish(runID)
    expect(finished.state).toBe("completed")
    // finish parses the run payload only: no section report.
    expect(parses.filter((text) => text.includes("unused_exports"))).toEqual([])

    parses.length = 0
    const page = f.history.detail(runID, { analysis: "deadCode", limit: 5, offset: 10 })
    expect(page.totalFindings).toBe(30)
    expect(page.findings.map((x) => x.path)).toEqual(
      [10, 11, 12, 13, 14].map((index) => `src/f${index}.ts`),
    )
    expect(page.nextOffset).toBe(15)
    // Five findings were parsed, not 31 findings in two whole reports.
    expect(parses.filter((text) => text.startsWith('{"path"'))).toHaveLength(5)
    expect(parses.some((text) => text.includes("unused_exports"))).toBe(false)

    parses.length = 0
    f.history.decide(
      {
        requestID: "d1",
        runID,
        findingID: page.findings[0]!.findingID,
        disposition: "fixed",
        note: "Removed the export; behavior tests passed",
      },
      f.actor,
    )
    expect(parses.some((text) => text.includes("unused_exports"))).toBe(false)
  } finally {
    JSON.parse = parse
  }
  expect(f.history.detail(runID, { path: "f2.ts" }).totalFindings).toBe(1)
  expect(() =>
    f.history.decide(
      {
        requestID: "d2",
        runID,
        findingID: `${runID}/deadCode/unused_exports/999`,
        disposition: "fixed",
        note: "Removed the export; behavior tests passed",
      },
      f.actor,
    ),
  ).toThrow("Finding not found")

  const path = await f.history.export(runID)
  const expected = JSON.stringify(
    {
      ...f.history.summary(f.history.get(runID)),
      schemaVersion: 2,
      reports: Object.fromEntries(f.history.sections(runID).map((s) => [s.analysis, s.report])),
    },
    null,
    2,
  )
  expect(readFileSync(path, "utf8")).toBe(`${expected}\n`)
})

test("a run stored before the findings index existed is indexed on first read", () => {
  const f = fixture()
  const start = f.history.start({ requestID: "legacy", workspace: f.workspace }, f.actor)
  f.history.section(start.run.runID, "deadCode", many(4))
  f.repository.atomic((db) => db.query("DELETE FROM audit_findings").run())
  expect(f.history.detail(start.run.runID).totalFindings).toBe(4)
  expect(
    f.repository.atomic(
      (db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_findings").get()!.n,
    ),
  ).toBe(4)
})

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
  const task = await getTaskDetail(f.repository, { taskID: f.task.id })
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

/** Everything a reader of a run can see, in one value: summaries, pages, reports and the export. */
async function readers(history: AuditHistory, runID: string, withList = true) {
  const exported = readFileSync(await history.export(runID), "utf8")
  return {
    // `list` also moves a page of old sections, so a test of the unmoved state leaves it out.
    list: withList ? history.list({ limit: 10 }) : null,
    summary: history.summary(history.get(runID)),
    pages: [
      history.detail(runID),
      history.detail(runID, { analysis: "deadCode", limit: 7, offset: 5 }),
      history.detail(runID, { path: "src/f3.ts" }),
      history.detail(runID, { limit: 1 }),
    ],
    sections: history.sections(runID),
    exported,
  }
}

const sectionRows = (f: ReturnType<typeof fixture>) =>
  f.repository.atomic((db) =>
    db
      .query<{ run_id: string; analysis: string; payload: string; raw_file: number }, []>(
        "SELECT run_id,analysis,payload,raw_file FROM audit_sections ORDER BY rowid",
      )
      .all(),
  )

test("sections stored before report files read the same, move in pages, and free their blobs", async () => {
  const f = fixture()
  const start = f.history.start({ requestID: "legacy-blob", workspace: f.workspace }, f.actor)
  const runID = start.run.runID
  const reports = {
    deadCode: many(40),
    health: { summary: { score: 90 }, findings: [{ path: "src/x.ts", line: 2, name: "x" }] },
    duplication: { stats: { clone_groups: 0 }, clone_groups: [] },
  }
  for (const [name, value] of Object.entries(reports)) f.history.section(runID, name, value)
  f.history.finish(runID)
  const current = await readers(f.history, runID)
  expect(sectionRows(f).every((row) => row.raw_file === 1 && row.payload === "")).toBe(true)

  // Rewind the database to generation 1: reports in the blob, no file, no `raw_file` column.
  const blobs = f.history.sections(runID).map((s) => [s.analysis, JSON.stringify(s.report)])
  f.repository.atomic((db) => {
    for (const [analysis, json] of blobs)
      db.query("UPDATE audit_sections SET payload=? WHERE run_id=? AND analysis=?").run(
        json!,
        runID,
        analysis!,
      )
    db.exec("ALTER TABLE audit_sections DROP COLUMN raw_file")
    db.exec("UPDATE schema_modules SET generation=1 WHERE module='audit'")
  })
  rmSync(join(f.root, "data", "audits", runID), { recursive: true, force: true })
  const payloadBytes = f.repository.atomic(
    (db) =>
      db.query<{ n: number }, []>("SELECT SUM(LENGTH(payload)) AS n FROM audit_sections").get()!.n,
  )

  // A reload reopens the database: the upgrade adds the column and moves no data.
  f.repository.close()
  const reopened = new AuditHistory(f.open())
  expect(sectionRows(f).every((row) => row.raw_file === 0 && row.payload !== "")).toBe(true)
  const unlisted = { ...current, list: null }
  expect(await readers(reopened, runID, false)).toEqual(unlisted)

  // Pages: two sections, then the last one; nothing is moved twice.
  expect(reopened.compact(2)).toMatchObject({ moved: 2, remaining: 1 })
  expect(await readers(reopened, runID, false)).toEqual(unlisted)
  expect(reopened.compact(2)).toMatchObject({ moved: 1, remaining: 0 })
  expect(reopened.compact(2)).toMatchObject({ moved: 0, remaining: 0 })
  expect(sectionRows(f).every((row) => row.raw_file === 1 && row.payload === "")).toBe(true)
  expect(await readers(reopened, runID)).toEqual(current)

  // Bytes: the blobs are gone from the database; the files hold the same reports compressed.
  const fileBytes = sectionRows(f)
    .map(
      (row) => statSync(join(f.root, "data", "audits", row.run_id, `${row.analysis}.json.gz`)).size,
    )
    .reduce((a, b) => a + b, 0)
  expect(fileBytes).toBeLessThan(payloadBytes / 3)
  console.info(`audit sections: ${payloadBytes} blob bytes -> ${fileBytes} file bytes`)
})

test("a missing report file fails the report readers and leaves findings readable", async () => {
  const f = fixture()
  const runID = f.history.start({ requestID: "missing-file", workspace: f.workspace }, f.actor).run
    .runID
  f.history.section(runID, "deadCode", many(3))
  f.history.finish(runID)
  rmSync(join(f.root, "data", "audits", runID), { recursive: true })
  expect(f.history.detail(runID).totalFindings).toBe(3)
  expect(() => f.history.sections(runID)).toThrow("is missing")
  await expect(f.history.export(runID)).rejects.toThrow("is missing")
})

test("list reads the sections of every run in one query", () => {
  const f = fixture()
  for (const name of ["a", "b", "c"]) {
    const run = f.history.start({ requestID: name, workspace: f.workspace }, f.actor).run
    f.history.section(run.runID, "deadCode", many(1))
    f.history.finish(run.runID)
  }
  const sql: string[] = []
  const original = Database.prototype.query
  Database.prototype.query = function (this: Database, text: string) {
    sql.push(text)
    return original.call(this, text)
  } as typeof original
  try {
    const runs = f.history.list().runs
    expect(runs.map((run) => run.analyses.length)).toEqual([1, 1, 1])
  } finally {
    Database.prototype.query = original
  }
  expect(sql.filter((text) => /FROM audit_sections\s+WHERE run_id/.test(text))).toHaveLength(1)
})

test("a finished run is exported once; a missing or older file is written again; no read returns whole reports", async () => {
  const f = fixture()
  const run = f.history.start({ requestID: "export-once", workspace: f.workspace }, f.actor).run
  f.history.section(run.runID, "deadCode", many(3))
  // A run still collecting is exported as far as it has got, every time.
  const early = await f.history.exportOnce(run.runID)
  expect(JSON.parse(readFileSync(early, "utf8")).state).toBe("collecting")
  f.history.finish(run.runID)
  // The partial file is older than the end of the run, so the finished run replaces it.
  await Bun.sleep(5)
  expect(JSON.parse(readFileSync(await f.history.exportOnce(run.runID), "utf8")).state).toBe(
    "completed",
  )
  const written = statSync(early).mtimeMs
  await Bun.sleep(20)
  expect(await f.history.exportOnce(run.runID)).toBe(early)
  expect(statSync(early).mtimeMs).toBe(written)
  rmSync(early)
  await f.history.exportOnce(run.runID)
  expect(statSync(early).mtimeMs).toBeGreaterThan(written)
  expect(f.history.detail(run.runID)).not.toHaveProperty("reports")
})
