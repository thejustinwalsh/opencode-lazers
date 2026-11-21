import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { AuditHistory } from "../audit/history.ts"
import { rawReportPath, writeRawReport } from "../audit/audit-raw.ts"
import { makeFixture, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { previewRetention, retireSlice, type SliceResult } from "./retention.ts"

const NOW = Date.UTC(2026, 10, 19)
const fixtures: Array<ReturnType<typeof makeFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

function setup() {
  const fixture = makeFixture()
  fixtures.push(fixture)
  new AuditHistory(fixture.repository)
  const data = dirname(fixture.repository.path)
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(fixture.receipt.planID)
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
    ).run(fixture.receipt.planID, null, 20, "PLAN_ACCEPTED", "{}", 1700)
  })
  const run = (id: string, state: string, owner: { task?: string; attempt?: string }) => {
    fixture.store.atomic((db) => {
      db.query("INSERT INTO audit_runs VALUES(?,?,?,?,?,?,?,?)").run(
        id,
        fixture.directory,
        owner.task ?? null,
        owner.attempt ?? null,
        "ses",
        `req-${id}`,
        1000,
        JSON.stringify({ runID: id, state }),
      )
      for (const analysis of ["deadCode", "health"]) {
        db.query(
          "INSERT INTO audit_sections(run_id,analysis,payload,summary,captured_at,finding_count,raw_file) VALUES(?,?,?,?,?,?,1)",
        ).run(id, analysis, "", "{}", 1000, 1)
        db.query(
          "INSERT INTO audit_findings(run_id,analysis,ordinal,finding_id,section_at,category,path,line,details) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(id, analysis, 0, `${id}-${analysis}`, 1000, "c", "src/a.ts", 1, "{}")
        writeRawReport(rawReportPath(data, id, analysis), JSON.stringify({ pad: "x".repeat(2000) }))
      }
      db.query(
        "INSERT INTO audit_decisions(project_directory,run_id,finding_id,session_id,request_id,payload,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(fixture.directory, id, `${id}-health`, "ses", `d-${id}`, "{}", 1000)
    })
    writeFileSync(join(data, "audits", `${id}.json`), "{}")
  }
  return { fixture, data, run }
}

async function purge(fixture: ReturnType<typeof makeFixture>, data: string) {
  const removed: SliceResult["removed"] = {}
  for (let guard = 0; guard < 50; guard++) {
    const slice = await retireSlice(
      (run) => fixture.store.atomic(run),
      (run) => fixture.repository.read(run),
      { now: NOW, days: 30, budgetMs: 10_000, batch: 3, dataDirectory: data },
    )
    for (const [id, total] of Object.entries(slice.removed)) {
      const entry = (removed[id] ??= { rows: 0, bytes: 0 })
      entry.rows += total.rows
      entry.bytes += total.bytes
    }
    if (slice.done) return removed
  }
  throw new Error("purge did not finish")
}

const rows = (fixture: ReturnType<typeof makeFixture>, table: string) =>
  fixture.repository.read(
    (db) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
  )

test("a purge removes a retired plan's audit runs with their files; other runs and files stay", async () => {
  const { fixture, data, run } = setup()
  run("gone-task", "completed", { task: taskID })
  run("gone-attempt", "partial", { attempt: firstAttemptID })
  run("other", "completed", { task: "unrelated-task" })
  run("collecting", "collecting", { task: taskID })
  // A folder whose run row is gone (a removal that failed after its commit) is swept too.
  mkdirSync(join(data, "audits", "orphan"), { recursive: true })
  writeFileSync(join(data, "audits", "orphan", "x.json.gz"), "z".repeat(500))

  const preview = await fixture.repository.read((db) =>
    previewRetention(db, { now: NOW, days: 30, dataDirectory: data }),
  )
  const kind = preview.kinds.find((entry) => entry.id === "audit-runs")!
  const fileBytes = 4 * rawFileSize(data, "gone-task") + 500
  expect(kind.bytes).toBeGreaterThanOrEqual(fileBytes)
  // Four sections' files, their findings, two runs, two decisions, plus the orphan folder.
  expect(kind.rows).toBe(2 + 4 + 4 + 2 + 1)

  const removed = await purge(fixture, data)
  expect(removed["audit-runs"]!.rows).toBe(kind.rows)
  expect(removed["audit-runs"]!.bytes).toBeGreaterThanOrEqual(fileBytes)
  expect(rows(fixture, "audit_runs")).toBe(2)
  expect(rows(fixture, "audit_sections")).toBe(4)
  expect(rows(fixture, "audit_findings")).toBe(4)
  expect(rows(fixture, "audit_decisions")).toBe(2)
  for (const id of ["gone-task", "gone-attempt", "orphan"]) {
    expect(existsSync(join(data, "audits", id))).toBe(false)
    expect(existsSync(join(data, "audits", `${id}.json`))).toBe(false)
  }
  // A file whose section row exists is never deleted.
  for (const id of ["other", "collecting"]) {
    for (const analysis of ["deadCode", "health"])
      expect(existsSync(rawReportPath(data, id, analysis))).toBe(true)
    expect(existsSync(join(data, "audits", `${id}.json`))).toBe(true)
  }
  // A repeat finds nothing.
  expect((await purge(fixture, data))["audit-runs"]).toBeUndefined()
})

function rawFileSize(data: string, id: string) {
  return Bun.file(rawReportPath(data, id, "deadCode")).size
}

const DAY = 86_400_000

/** Dates the plan's last activity (its newest transition and attempt) at `at`. */
function dateActivity(fixture: ReturnType<typeof makeFixture>, at: number) {
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_transitions SET created_at=? WHERE plan_id=?").run(
      at,
      fixture.receipt.planID,
    )
    db.query("UPDATE runner_attempts SET started_at=? WHERE plan_id=?").run(
      at,
      fixture.receipt.planID,
    )
  })
}

const slice = (
  fixture: ReturnType<typeof makeFixture>,
  data: string,
  days: number,
  ageDependent?: boolean,
) =>
  retireSlice(
    (work) => fixture.store.atomic(work),
    (work) => fixture.repository.read(work),
    { now: NOW, days, budgetMs: 10_000, batch: 3, dataDirectory: data, ageDependent },
  )

test("with no age configured (the superseded-only pass) audit runs of finished plans are kept", async () => {
  const { fixture, data, run } = setup()
  run("kept-task", "completed", { task: taskID })
  const before = rows(fixture, "audit_runs")
  // That pass runs with days 0 and ageDependent false: at days 0 every finished plan counts as
  // retired, so without the guard it would remove every audit run.
  const result = await slice(fixture, data, 0, false)
  expect(result.removed["audit-runs"]).toBeUndefined()
  expect(rows(fixture, "audit_runs")).toBe(before)
  expect(before).toBeGreaterThan(0)
  expect(existsSync(rawReportPath(data, "kept-task", "health"))).toBe(true)
})

test("the configured finished-plan age governs audit runs: a plan younger than it keeps them", async () => {
  const { fixture, data, run } = setup()
  run("young", "completed", { task: taskID })
  dateActivity(fixture, NOW - 29 * DAY)
  const result = await slice(fixture, data, 30)
  expect(result.removed["audit-runs"]).toBeUndefined()
  expect(rows(fixture, "audit_runs")).toBe(1)
  expect(rows(fixture, "audit_sections")).toBe(2)
  expect(existsSync(rawReportPath(data, "young", "health"))).toBe(true)
  expect(existsSync(join(data, "audits", "young.json"))).toBe(true)
})

test("the configured finished-plan age governs audit runs: a plan older than it loses them, rows and files", async () => {
  const { fixture, data, run } = setup()
  run("old", "completed", { task: taskID })
  dateActivity(fixture, NOW - 31 * DAY)
  const result = await slice(fixture, data, 30)
  expect(result.removed["audit-runs"]!.rows).toBeGreaterThan(0)
  expect(result.removed["audit-runs"]!.bytes).toBeGreaterThan(0)
  expect(rows(fixture, "audit_runs")).toBe(0)
  expect(rows(fixture, "audit_sections")).toBe(0)
  expect(existsSync(join(data, "audits", "old"))).toBe(false)
  expect(existsSync(join(data, "audits", "old.json"))).toBe(false)
})
