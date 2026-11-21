import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { gitAsync } from "./artifacts.ts"
import { AdoptionPreparation } from "./adoption-preparation.ts"
import { meterReads } from "./read-meter.fixture.ts"
import { RETAINED_REPAIR_EVENTS, RetainedRepairRecords } from "./retained-repair-records.ts"
import { RetentionService } from "../retention/service.ts"
import { forgetKeysReady, planIs } from "./identity-read.ts"
import { asLegacyHistory } from "./identity.fixture.ts"
import { RunnerStore } from "./store.ts"

/**
 * Retained repair read every transition of a plan, and the adoption baseline read every
 * integration event of the project, to find a handful. Each now reads the events it uses.
 */

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const show = (name: string, before: unknown, after: unknown) => {
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[transition-reads] ${name} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    )
}

function seeded() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-transition-reads-")))
  const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  cleanups.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  repository.atomic((db) => {
    for (const id of ["plan-a", "plan-b"])
      db.query("INSERT INTO runner_plans VALUES(?,?,'owner',1,1,'running',?,NULL,NULL,NULL)").run(
        id,
        root,
        JSON.stringify({ priority: 1 }),
      )
  })
  const record = (plan: string, task: string | null, event: string, payload: unknown) =>
    repository.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,?,?,1)",
        )
        .run(plan, task, event, JSON.stringify(payload)),
    )
  return { root, repository, store, record }
}

test("retained repair reads its six events of one task, across pages, as the full history had", () => {
  const f = seeded()
  // Noise: progress-like events of every task, far more than one page.
  for (let index = 0; index < 1_400; index++)
    f.record("plan-a", index % 3 === 0 ? "task-1" : "task-2", "NODE_UPDATED", {
      index,
      pad: "x".repeat(200),
    })
  for (let index = 0; index < 600; index++)
    f.record("plan-a", "task-1", "ATTEMPT_RESUMED", { index })
  f.record("plan-a", "task-1", "RETAINED_REPAIR_REQUESTED", { operationID: "op" })
  f.record("plan-a", "task-2", "ATTEMPT_RESUMED", { index: "other task" })
  f.record("plan-a", null, "BLOCKED", { reason: "hold" })
  f.record("plan-a", null, "CANCEL_REQUESTED", {})
  f.record("plan-a", "task-1", "CANCEL", { from: "running", to: "cancelled", reason: null })
  f.record("plan-b", "task-1", "ATTEMPT_RESUMED", { index: "other plan" })

  const history = (planID: string, taskID: string) =>
    RetainedRepairRecords.prototype.transitionHistory.call({ store: f.store }, planID, taskID)

  // Before: every transition of the plan, filtered in JavaScript.
  const old = meterReads(f.store)
  const everything = f.store.read((db) =>
    db
      .query<{ id: number; task_id: string | null; event: string; payload: string }, [string]>(
        "SELECT id,task_id,event,payload FROM runner_transitions WHERE plan_id=? ORDER BY id",
      )
      .all("plan-a"),
  )
  old.stop()
  const expected = everything.filter(
    (row) =>
      (row.task_id === "task-1" || row.task_id === null) &&
      (RETAINED_REPAIR_EVENTS as readonly string[]).includes(row.event),
  )

  const meter = meterReads(f.store)
  const got = history("plan-a", "task-1")
  meter.stop()
  expect(got).toEqual(expected)
  expect(got).toHaveLength(600 + 1 + 1 + 1 + 1)
  expect(got.map((row) => row.id)).toEqual(got.map((row) => row.id).toSorted((a, b) => a - b))
  expect(history("plan-a", "task-2").map((row) => row.event)).toEqual([
    "ATTEMPT_RESUMED",
    "BLOCKED",
    "CANCEL_REQUESTED",
  ])
  show("retained repair history", old.of(/runner_transitions/), meter.of(/runner_transitions/))
  expect(meter.of(/runner_transitions/).bytes).toBeLessThan(old.of(/runner_transitions/).bytes / 2)
})

test("the adoption baseline is the newest qualifying integration, found without reading the project's events", async () => {
  const f = seeded()
  const git = (...args: string[]) => gitAsync(f.root, args)
  await git("init", "--initial-branch=main")
  const commits: string[] = []
  for (let index = 0; index < 6; index++) {
    writeFileSync(join(f.root, "file.txt"), `${index}\n`)
    await git("add", "file.txt")
    await git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-m",
      `c${index}`,
    )
    commits.push(await git("rev-parse", "HEAD"))
  }
  const [c0, c1, c2, c3, c4, c5] = commits as [string, string, string, string, string, string]
  const bogus = "f".repeat(40)
  // Heads 1, 2 and 4 were integrated to main; 3 is recorded for another branch; 1,500 other events.
  f.record("plan-a", "task-1", "TASK_INTEGRATION_RECORDED", {
    branch: "main",
    artifact: c1,
    head: c1,
  })
  f.record("plan-a", null, "INTEGRATION_RECORDED", { branch: "main", artifact: c2, head: c2 })
  f.record("plan-b", null, "INTEGRATION_RECORDED", { branch: "other", artifact: c3, head: c3 })
  f.record("plan-b", null, "INTEGRATION_RECORDED", { branch: "main", artifact: c4, head: c4 })
  // Not on the candidate's line, malformed, or the candidate itself: all skipped.
  f.record("plan-b", null, "INTEGRATION_RECORDED", { branch: "main", artifact: bogus, head: bogus })
  f.record("plan-b", null, "INTEGRATION_RECORDED", { branch: "main", artifact: "nope", head: 4 })
  f.record("plan-b", null, "INTEGRATION_RECORDED", { branch: "main", artifact: c5, head: c5 })
  for (let index = 0; index < 1_500; index++)
    f.record("plan-b", "task-9", "INTEGRATION_RECORDED", {
      branch: "side",
      artifact: c1,
      head: c1,
      index,
    })

  const baseline = (candidate: string) =>
    AdoptionPreparation.prototype.reviewedAdoptionBaseline.call(
      { store: f.store, directory: f.root },
      "main",
      c0,
      candidate,
    )

  // The old algorithm, spelled out: every event of the project, the head nearest the candidate.
  const rows = f.store.read((db) =>
    db
      .query<{ event: string; payload: string }, [string]>(
        `SELECT t.event,t.payload FROM runner_transitions t JOIN runner_plans p ON p.id=t.plan_id
         WHERE p.project_directory=? AND t.event IN ('INTEGRATION_RECORDED','TASK_INTEGRATION_RECORDED')
         ORDER BY t.id`,
      )
      .all(f.root),
  )
  const oldBaseline = async (candidate: string) => {
    const line = (await git("rev-list", "--first-parent", candidate)).split(/\s+/).filter(Boolean)
    const index = new Map(line.map((commit, position) => [commit, position]))
    let result = c0
    let nearest = Number.POSITIVE_INFINITY
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as {
        artifact?: unknown
        branch?: unknown
        head?: unknown
      }
      if (
        payload.branch !== "main" ||
        typeof payload.artifact !== "string" ||
        typeof payload.head !== "string" ||
        !/^[a-f0-9]{40}$/.test(payload.artifact) ||
        !/^[a-f0-9]{40}$/.test(payload.head) ||
        payload.head === candidate
      )
        continue
      const position = index.get(payload.head)
      if (position === undefined || position >= nearest) continue
      try {
        await git("merge-base", "--is-ancestor", c0, payload.head)
        await git("merge-base", "--is-ancestor", payload.artifact, payload.head)
      } catch {
        continue
      }
      result = payload.head
      nearest = position
    }
    return result
  }

  for (const candidate of [c5, c3, c2, c1])
    expect(await baseline(candidate)).toBe(await oldBaseline(candidate))
  expect(await baseline(c5)).toBe(c4)
  expect(await baseline(c1)).toBe(c0)

  const meter = meterReads(f.store)
  await baseline(c5)
  meter.stop()
  const old = meterReads(f.store)
  f.store.read((db) =>
    db
      .query(
        `SELECT t.event,t.payload FROM runner_transitions t JOIN runner_plans p ON p.id=t.plan_id
         WHERE p.project_directory=? AND t.event IN ('INTEGRATION_RECORDED','TASK_INTEGRATION_RECORDED')
         ORDER BY t.id`,
      )
      .all(f.root),
  )
  old.stop()
  show("adoption baseline", old.of(/runner_transitions/), meter.of(/runner_transitions/))
  expect(meter.of(/runner_transitions/).rows).toBeLessThanOrEqual(5)
  expect(old.of(/runner_transitions/).rows).toBeGreaterThan(1_500)
})

test("retained repair reads the same history on text keys and on integer keys, planned on an integer index", async () => {
  const f = seeded()
  for (let index = 0; index < 700; index++)
    f.record(
      "plan-a",
      index % 2 ? "task-1" : null,
      index % 5 ? "NODE_UPDATED" : "ATTEMPT_RESUMED",
      {
        index,
      },
    )
  f.record("plan-b", "task-1", "ATTEMPT_RESUMED", { other: true })
  // Rows written before the integer keys existed: readers start on the text predicate.
  asLegacyHistory(f.repository)
  f.repository.read((db) => expect(planIs(db, "runner_transitions")).toBe("plan_id=?"))
  const history = (planID: string) =>
    RetainedRepairRecords.prototype.transitionHistory.call({ store: f.store }, planID, "task-1")
  const before = [history("plan-a"), history("plan-b")]
  expect(before[0]!.length).toBeGreaterThan(100)
  await new RetentionService({ repository: f.repository, host: {} as never }).backfillKeys(30_000)
  forgetKeysReady(f.repository.read((db) => db))
  expect([history("plan-a"), history("plan-b")]).toEqual(before)
  f.repository.read((db) => {
    const plan = db
      .query<{ detail: string }, string[]>(
        `EXPLAIN QUERY PLAN SELECT id,task_id,event,payload FROM runner_transitions
          WHERE ${planIs(db, "runner_transitions")} AND (task_id=? OR task_id IS NULL) AND event IN (?) AND id>? ORDER BY id LIMIT 500`,
      )
      .all("x", "y", "z", "0")
      .map((row) => row.detail)
      .join(" | ")
    if (process.env.EXPLAIN_VERBOSE) console.log("retained repair =>", plan)
    expect(plan).toContain("plan_n")
    expect(plan).not.toMatch(/SCAN runner_transitions(?! USING)/)
  })
})
