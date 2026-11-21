import { afterEach, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { AuditHistory } from "../audit/history.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import { RetentionService } from "./service.ts"
import { AUDIT_RECEIPTS_KEPT } from "./retention.ts"
import type { WorktreeProbe } from "./worktrees.ts"

const fixtures: Array<ReturnType<typeof makeFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

function setup() {
  const fixture = makeFixture()
  fixtures.push(fixture)
  new ProgressRecorder(fixture.store, "project")
  const root = `${realpathSync(fixture.directory)}.worktrees`
  const paths = {
    clean: `${root}/clean`,
    dirty: `${root}/dirty`,
    unmerged: `${root}/unmerged`,
    unlisted: `${root}/unlisted`,
    outside: "/somewhere/else/tree",
  }
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(fixture.receipt.planID)
    const [first, second] = fixture.attempts
    db.query("UPDATE runner_attempts SET workspace=? WHERE id=?").run(paths.clean, first!.id)
    db.query("UPDATE runner_attempts SET workspace=? WHERE id=?").run(paths.dirty, second!.id)
    let number = 10
    for (const workspace of [paths.unmerged, paths.unlisted, paths.outside])
      db.query(
        "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at) VALUES(?,?,?,?,?,?,?,'b','{}','failed',5)",
      ).run(
        `att-${number}`,
        fixture.receipt.planID,
        taskID,
        number,
        `s${number}`,
        `m${number++}`,
        workspace,
      )
  })
  const removed: string[] = []
  const gone = new Set<string>()
  const sessions = new Map<string, Record<string, unknown>>()
  const refusals = new Set<string>()
  const host = {
    session: async (id: string) => (sessions.get(id) as never) ?? null,
    worktrees: async () => [paths.clean, paths.dirty, paths.unmerged, paths.outside],
    removeWorktree: async (directory: string) => {
      if (refusals.has(directory)) throw new Error("native refused removal")
      removed.push(directory)
      gone.add(directory)
    },
  }
  const probe: WorktreeProbe = {
    exists: (path) => !gone.has(path),
    size: async () => 1024,
    status: async (path) => (path === paths.dirty ? " M src/a.ts\n" : ""),
    contained: async (_project, path) =>
      path === paths.unmerged
        ? { contained: false, reason: "HEAD is not an ancestor" }
        : { contained: true, reason: "" },
  }
  let now = Date.UTC(2026, 10, 19)
  const service = new RetentionService({
    repository: fixture.repository,
    host,
    probe,
    now: () => now,
  })
  return {
    fixture,
    service,
    removed,
    paths,
    sessions,
    refusals,
    probe,
    advance: (ms: number) => (now += ms),
  }
}

test("the preview lists worktrees: clean and merged ones are removable, the rest are listed with why", async () => {
  const { service, paths, removed } = setup()
  const preview = await service.preview({ days: 30 })
  const byPath = Object.fromEntries(preview.worktrees.map((finding) => [finding.path, finding]))
  expect(byPath[paths.clean]).toMatchObject({ action: "remove" })
  expect(byPath[paths.dirty]).toMatchObject({ action: "keep", reason: "uncommitted changes" })
  expect(byPath[paths.unmerged]?.reason).toContain("unmerged commits")
  expect(byPath[paths.unlisted]?.reason).toContain("OpenCode cannot remove")
  expect(byPath[paths.outside]?.reason).toContain("outside the LAZERS worktree folders")
  expect(preview.worktreeBytes).toBe(1024)
  expect(removed).toEqual([])
})

test("a purge removes only the clean merged worktree, through the native API, and records the run", async () => {
  const { service, removed, paths, fixture } = setup()
  const preview = await service.preview({ days: 30 })
  let slice = await service.retire({ days: 30, asOf: preview.asOf })
  while (!slice.done)
    slice = await service.retire({ days: 30, asOf: preview.asOf, runID: slice.runID })
  expect(removed).toEqual([paths.clean])
  expect(slice.worktrees.map((tree) => tree.path)).toEqual([paths.clean])
  const status = await service.status()
  expect(status.lastRun).toMatchObject({ id: slice.runID, done: true, trigger: "manual", days: 30 })
  expect(status.lastRun?.worktrees).toEqual([{ path: paths.clean, bytes: 1024 }])
  expect(
    Object.values(status.lastRun?.removed ?? {}).reduce((sum, kind) => sum + kind.rows, 0),
  ).toBeGreaterThanOrEqual(0)
  expect(status.presets.map((preset) => preset.days)).toEqual([7, 14, 30, 60, 90])
  expect(status.fileBytes).toBeGreaterThan(0)
  // Repeating finds nothing more to remove.
  const again = await service.retire({ days: 30 })
  expect(again.done).toBe(true)
  expect(again.worktrees).toEqual([])
  expect(removed).toEqual([paths.clean])
  expect(fixture.repository.get(taskID)).toBeDefined()
})

test("by default only superseded rows are purged, at a quiet point and then after the interval", async () => {
  const { service, fixture, advance } = setup()
  fixture.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(fixture.attempts[0]!.id),
  )
  await service.autoTick()
  expect((await service.status()).lastRun).toBeNull()

  fixture.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(fixture.attempts[0]!.id),
  )
  // Bulky audit receipts beyond the newest few: dead once newer audits exist.
  const audit = (n: number) => JSON.stringify({ status: "audited", pad: "x".repeat(70_000), n })
  fixture.store.atomic((db) => {
    for (let n = 0; n < 8; n++)
      db.query("INSERT INTO runner_commands VALUES(?,?,?,?)").run(
        fixture.directory,
        `audit-${n}`,
        `f${n}`,
        audit(n),
      )
  })
  const planDetail = () =>
    fixture.store.atomic(
      (db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_progress").get()!.n,
    )
  const detailBefore = planDetail()
  await service.autoTick()
  const first = (await service.status()).lastRun
  expect(first).toMatchObject({ trigger: "auto", days: 0, done: true })
  expect(first?.removed["audit-receipts"]?.rows).toBe(8 - AUDIT_RECEIPTS_KEPT)
  expect(first?.removed["audit-receipts"]?.bytes).toBeGreaterThan(70_000)
  expect(first?.worktrees).toEqual([])
  // Nothing that depends on an age is touched without the owner's choice.
  expect(planDetail()).toBe(detailBefore)
  await service.autoTick()
  expect((await service.status()).lastRun?.id).toBe(first!.id)
  advance(7 * 3_600_000)
  await service.autoTick()
  const second = (await service.status()).lastRun
  expect(second?.id).toBeGreaterThan(first!.id)
  expect(second?.removed).toEqual({})

  service.setAuto(30)
  expect(service.settings()).toEqual({ autoDays: 30 })
  advance(7 * 3_600_000)
  await service.autoTick()
  expect((await service.status()).lastRun).toMatchObject({ trigger: "auto", days: 30, done: true })
  service.setAuto(null)
  expect(service.settings()).toEqual({ autoDays: null })
})

test("81b1d6ba-2: a worker still running a shell in the worktree keeps it", async () => {
  const { service, removed, paths, sessions, fixture } = setup()
  sessions.set(fixture.attempts[0]!.session_id, { id: "x", runningShells: 1, busy: false })
  const slice = await service.retire({ days: 30 })
  expect(removed).toEqual([])
  expect(slice.skipped.map((entry) => entry.path)).toEqual([paths.clean])
  expect(slice.skipped[0]!.reason).toContain("shell")
})

test("81b1d6ba-2: a plan retried while the worktree is being inspected keeps it", async () => {
  const { service, removed, probe, fixture } = setup()
  const contained = probe.contained
  probe.contained = async (...args) => {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_plans SET state='running' WHERE id=?").run(fixture.receipt.planID),
    )
    return contained(...args)
  }
  await service.retire({ days: 30 })
  expect(removed).toEqual([])
})

test("81b1d6ba-3: a refused removal is reported with its reason and recorded on the run", async () => {
  const { service, removed, paths, refusals } = setup()
  refusals.add(paths.clean)
  const slice = await service.retire({ days: 30 })
  expect(removed).toEqual([])
  expect(slice.skipped).toEqual([
    { path: paths.clean, reason: expect.stringContaining("native refused") },
  ])
  expect((await service.status()).lastRun?.skipped).toEqual(slice.skipped)
})

test("the automatic pass removes audit runs of plans older than the configured age, and none without one", async () => {
  const { service, fixture, advance } = setup()
  new AuditHistory(fixture.repository)
  fixture.store.atomic((db) =>
    db
      .query("INSERT INTO audit_runs VALUES(?,?,?,?,?,?,?,?)")
      .run(
        "r1",
        fixture.directory,
        taskID,
        null,
        "ses",
        "req-r1",
        1000,
        JSON.stringify({ runID: "r1", state: "completed" }),
      ),
  )
  const count = () =>
    fixture.repository.read(
      (db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_runs").get()!.n,
    )
  await service.autoTick()
  expect(count()).toBe(1)
  service.setAuto(30)
  advance(7 * 3_600_000)
  await service.autoTick()
  expect(count()).toBe(0)
})
