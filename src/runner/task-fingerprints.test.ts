import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { fingerprint } from "../identity.ts"
import { TaskRepository } from "../storage.ts"
import { meterDatabase, meterRepository } from "./read-meter.fixture.ts"
import { RunnerStore } from "./store.ts"

/**
 * `exactContentConflicts` and `audit` parsed and fingerprinted every task body of the project on
 * each call. The fingerprint is now a column written with the task, and the scope the audit and
 * `effectiveScope` need is read as two JSON fields.
 */

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const show = (name: string, before: unknown, after: unknown) => {
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[task-fingerprints] ${name} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    )
}

const TASKS = 1_500

function seeded() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-task-fingerprints-")))
  const path = join(root, "data", "tasks.sqlite")
  const repository = new TaskRepository(path, root)
  const store = new RunnerStore(repository)
  cleanups.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const ids: string[] = []
  for (let index = 0; index < TASKS; index++) {
    // Every 50th task repeats the proposal of the one before it: a duplicate pair.
    const proposal = validProposal()
    const number = index % 50 === 1 ? index - 1 : index
    proposal.objective = `Task number ${number}. ${"pad ".repeat(200)}`
    proposal.writeScope = [`area${number % 500}/**`]
    const task = repository.insert({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      revision: 1,
      status: "submitted",
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      provenance: {
        projectID: "project",
        projectDirectory: root,
        workspaceDirectory: root,
        sessionID: "architect",
        startingRevision: { kind: "git", commit: "a".repeat(40) },
      },
      proposal,
    })
    ids.push(task.id)
  }
  return { root, path, repository, store, ids }
}

test("a stored fingerprint equals the fingerprint of the validated proposal", () => {
  const f = seeded()
  const stored = f.repository.read((db) =>
    db
      .query<{ id: string; content_fingerprint: string | null }, []>(
        "SELECT id,content_fingerprint FROM tasks",
      )
      .all(),
  )
  expect(stored).toHaveLength(TASKS)
  for (const row of stored)
    expect(row.content_fingerprint).toBe(fingerprint(f.repository.get(row.id)!.proposal))
  // Duplicate pairs share a fingerprint, distinct tasks do not.
  expect(new Set(stored.map((row) => row.content_fingerprint)).size).toBe(TASKS - TASKS / 50)
})

test("exactContentConflicts reads the fingerprint index and matches the full scan", () => {
  const f = seeded()
  // Retire one half of a duplicate pair and relate another.
  const disposed = f.ids[51]!
  f.repository.recordDisposition(
    {
      taskID: disposed,
      requestID: "retire-1",
      disposition: "superseded",
      reason: "Replaced by the integrated runner plan.",
      evidence: [{ kind: "artifact", reference: "docs/a.md" }],
      relatedTaskIDs: [f.ids[0]!],
    },
    { sessionID: "architect", agent: "architect" },
  )
  const related = [f.ids[101]!, f.ids[100]!] as [string, string]
  f.store.atomic((db) =>
    db
      .query("INSERT INTO runner_relations VALUES(?,?,?,?,?,?,?)")
      .run(f.root, related[0], related[1], "distinct", "reason", "owner", 1),
  )
  const selected = [0, 1, 50, 51, 100, 101, 150, 151, 200, 7, 1_499].map((index) => f.ids[index]!)

  // The old algorithm: every live task, parsed and fingerprinted, grouped in JavaScript.
  const before = meterDatabase(f.repository.read((db) => db) as unknown as Database)
  const live = before.db
    .query<{ id: string; body: string }, [string]>(
      `SELECT id,body FROM tasks WHERE project_directory=?
       AND NOT EXISTS (SELECT 1 FROM task_dispositions d
         WHERE d.project_directory=tasks.project_directory AND d.task_id=tasks.id) ORDER BY rowid`,
    )
    .all(f.root)
    .map(({ id, body }) => ({ id, content: fingerprint(JSON.parse(body).proposal) }))
  const relations = new Set(
    [
      [related[0], related[1]],
      [related[1], related[0]],
    ].map((pair) => JSON.stringify(pair)),
  )
  const chosen = new Set(selected)
  const byContent = new Map<string, number[]>()
  live.forEach((task, i) =>
    byContent.set(task.content, [...(byContent.get(task.content) ?? []), i]),
  )
  const expected: string[][] = []
  live.forEach((a, i) => {
    if (!chosen.has(a.id)) return
    for (const j of byContent.get(a.content)!) {
      const b = live[j]!
      if (i === j || (j < i && chosen.has(b.id)) || relations.has(JSON.stringify([a.id, b.id])))
        continue
      expected.push(i < j ? [a.id, b.id] : [b.id, a.id])
    }
  })
  // (0,1) and (150,151) and (200,201); 51 is retired and 100/101 are related.
  expect(expected).toHaveLength(3)

  const meter = meterRepository(f.repository)
  const got = f.store.exactContentConflicts(selected)
  meter.stop()
  expect(got.findings.map((finding) => finding.taskIDs)).toEqual(expected)
  expect(f.store.exactContentConflicts([]).findings).toEqual([])
  show(
    "exactContentConflicts",
    { rows: before.meter.rows, bytes: before.meter.bytes },
    {
      rows: meter.of(/FROM tasks/).rows,
      bytes: meter.of(/FROM tasks/).bytes,
    },
  )
  expect(meter.of(/FROM tasks/).rows).toBeLessThan(80)
  expect(meter.of(/FROM tasks/).bytes).toBeLessThan(before.meter.bytes / 50)
})

test("audit compares stored fingerprints and the scope fields, with the findings the full parse gave", () => {
  const f = seeded()
  const findings = f.store.audit().findings
  const codes = new Map<string, number>()
  for (const finding of findings) codes.set(finding.code, (codes.get(finding.code) ?? 0) + 1)
  // 30 exact duplicate pairs; no task has an execution plan; same-area tasks overlap in scope.
  expect(codes.get("exact-content")).toBe(TASKS / 50)
  expect(codes.get("unplanned")).toBe(TASKS)
  expect(codes.get("scope-overlap")).toBeGreaterThan(0)

  // Every finding agrees with a task parsed in full.
  for (const finding of findings.filter((item) => item.code === "exact-content")) {
    const [a, b] = finding.taskIDs.map((id) => fingerprint(f.repository.get(id)!.proposal))
    expect(a).toBe(b)
  }
  for (const finding of findings.filter((item) => item.code === "scope-overlap")) {
    const [a, b] = finding.taskIDs.map((id) => f.repository.get(id)!.proposal.writeScope[0]!)
    expect(a).toBe(b)
  }

  // Before: every task body, read and parsed one at a time.
  const old = meterDatabase(f.repository.read((db) => db) as unknown as Database)
  for (const id of f.ids)
    old.db.query("SELECT body FROM tasks WHERE project_directory=? AND id=?").get(f.root, id)
  const meter = meterRepository(f.repository)
  f.store.audit()
  meter.stop()
  const tasks = meter.of(/FROM tasks/)
  show("audit task reads", { rows: old.meter.rows, bytes: old.meter.bytes }, tasks)
  expect(tasks.bytes).toBeLessThan(old.meter.bytes / 5)
})

test("effectiveScope reads the scope fields of the task, not its plan body", () => {
  const f = seeded()
  const id = f.ids[5]!
  const task = f.repository.get(id)!
  const meter = meterRepository(f.repository)
  const scope = f.store.effectiveScope(id)
  meter.stop()
  expect(scope.edit).toEqual(task.proposal.writeScope)
  expect(scope.create).toEqual(task.proposal.createScope ?? [])
  expect(scope.protected).toEqual(task.proposal.protectedScope ?? [])
  expect(f.store.effectiveScope(id, task)).toEqual(scope)
  expect(f.store.effectiveReservationScope(id)).toContain(task.proposal.writeScope[0]!)
  expect(meter.of(/runner_plans/).bytes).toBe(0)
  expect(meter.bytes).toBeLessThan(600)
  expect(() => f.store.effectiveScope("no-such-task")).toThrow("Task not found")
})

test("a database from before the column gains it and fills it in pages when opened", () => {
  const f = seeded()
  f.repository.close()
  const raw = new Database(f.path)
  raw.exec(`
    DROP INDEX tasks_project_fingerprint;
    ALTER TABLE tasks DROP COLUMN content_fingerprint;
    PRAGMA user_version=9;
    UPDATE schema_modules SET generation=9 WHERE module='tasks';
  `)
  raw.close()

  const reopened = new TaskRepository(f.path, f.root)
  cleanups.push(() => reopened.close())
  const rows = reopened.read((db) =>
    db
      .query<{ id: string; content_fingerprint: string | null }, []>(
        "SELECT id,content_fingerprint FROM tasks",
      )
      .all(),
  )
  expect(rows).toHaveLength(TASKS)
  expect(rows.every((row) => row.content_fingerprint !== null)).toBe(true)
  expect(reopened.read((db) => db.query("PRAGMA user_version").get())).toEqual({ user_version: 10 })
  // A second pass has nothing to do.
  expect(reopened.backfillContentFingerprints()).toBe(0)
})
