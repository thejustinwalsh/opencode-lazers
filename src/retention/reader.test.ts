import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { EventEmitter } from "node:events"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Retention } from "./contract.ts"
import { registerRetention } from "./rpc.ts"
import { RetentionReader, type RetentionReaderWorker } from "./reader.ts"
import type { RetentionReadRequest, RetentionReadResult } from "./reader-protocol.ts"
import { RetentionService } from "./service.ts"
import type { WorktreeProbe } from "./worktrees.ts"
import { retentionDatabaseSizes } from "./database-size.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { meterDatabase, meterRepository, type ReadMeter } from "../runner/read-meter.fixture.ts"
import { makeFixture, taskID } from "../../test/trajectory/fixture.ts"

const NOW = Date.UTC(2026, 10, 19)
const DAY = 86_400_000
const fixtures: Array<ReturnType<typeof makeFixture>> = []
const services: RetentionService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const fixture of fixtures.splice(0)) fixture.close()
})

type Handler = (input: never, context: never) => Effect.Effect<unknown>
type Handlers = Record<string, Handler>

function settings(
  fixture: ReturnType<typeof makeFixture>,
  now: () => number = () => NOW,
  tree?: { path: string; probe: WorktreeProbe },
) {
  const host = {
    session: async () => null,
    worktrees: async () => (tree ? [tree.path] : []),
    removeWorktree: async () => {},
  }
  const service = new RetentionService({
    repository: fixture.repository,
    host,
    ...(tree ? { probe: tree.probe } : {}),
    now,
  })
  services.push(service)
  const handlers: Handlers = {}
  const ctx = {
    rpc: {
      register: (definition: { id: string }, registered: object) => {
        expect(definition.id).toBe(Retention.id)
        Object.assign(handlers, registered)
        return Effect.succeed({ events: { emit: () => Effect.void } })
      },
    },
  }
  const ready = Effect.runPromise(Effect.scoped(registerRetention(ctx as never, service)))
  const call = async <T>(name: string, input: unknown): Promise<T> => {
    await ready
    const handler = handlers[name]
    if (!handler) throw new Error(`Missing retention RPC ${name}`)
    return (await Effect.runPromise(handler(input as never, { error: () => ({}) } as never))) as T
  }
  return { service, call }
}

function seedHistory(size: number) {
  const fixture = makeFixture()
  fixtures.push(fixture)
  new ProgressRecorder(fixture.store, "project")
  const tree = `${realpathSync(fixture.directory)}.worktrees/clean`
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(fixture.receipt.planID)
    db.query("UPDATE runner_transitions SET created_at=1 WHERE plan_id=?").run(
      fixture.receipt.planID,
    )
    db.query("UPDATE runner_attempts SET workspace=?,started_at=1 WHERE plan_id=?").run(
      tree,
      fixture.receipt.planID,
    )
    const transition = db.query(
      `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
       VALUES(?,NULL,?,'OUTCOME_HOST_ADMITTED','{}',2)`,
    )
    for (let index = 0; index < size; index++) transition.run(fixture.receipt.planID, index + 100)
  })
  return { fixture, tree }
}

const forbiddenHistorySQL =
  /\b(?:tasks|task_changes|runner_[a-z0-9_]+|recovery_[a-z0-9_]+|planning_[a-z0-9_]+|audit_[a-z0-9_]+|native_tool_calls|transcript_(?:steps|sessions)|model_(?:evidence|endpoint_pricing)_[a-z0-9_]+)\b/i

async function measured<T>(
  fixture: ReturnType<typeof makeFixture>,
  run: () => Promise<T>,
): Promise<{ value: T; rows: number }> {
  const meter = meterRepository(fixture.repository)
  try {
    const value = await run()
    expect(meter.rows).toBeLessThanOrEqual(8)
    expect(meter.statements.some((sql) => forbiddenHistorySQL.test(sql))).toBe(false)
    return { value, rows: meter.rows }
  } finally {
    meter.stop()
  }
}

class FakeReaderWorker extends EventEmitter implements RetentionReaderWorker {
  readonly requests: RetentionReadRequest[] = []
  terminated = false
  private readonly waiters: Array<(request: RetentionReadRequest) => void> = []

  constructor(private readonly acknowledgeClose = true) {
    super()
  }

  postMessage(message: unknown) {
    const request = message as RetentionReadRequest
    this.requests.push(request)
    for (const resolve of this.waiters.splice(0)) resolve(request)
    if (request.type === "close" && this.acknowledgeClose)
      this.emit("message", { type: "closed" } satisfies RetentionReadResult)
  }

  unref() {
    return this
  }

  terminate() {
    this.terminated = true
    return Promise.resolve(0)
  }

  nextRequest() {
    const request = this.requests[0]
    return request
      ? Promise.resolve(request)
      : new Promise<RetentionReadRequest>((resolve) => this.waiters.push(resolve))
  }
}

test("Settings status and preview read bounded main-thread rows for cold, warm, small and large histories", async () => {
  const mainRows: number[] = []
  const previews: number[] = []
  for (const historySize of [25, 25_000]) {
    const { fixture, tree } = seedHistory(historySize)
    const probe: WorktreeProbe = {
      exists: () => true,
      size: async () => 1024,
      status: async () => "",
      contained: async () => ({ contained: true, reason: "" }),
    }
    const { call } = settings(fixture, () => NOW, { path: tree, probe })
    const cold = await measured(fixture, () =>
      call<Awaited<ReturnType<RetentionService["status"]>>>("status", {}),
    )
    mainRows.push(cold.rows)
    expect(cold.value.presets.map((preset) => preset.days)).toEqual([7, 14, 30, 60, 90])

    const preview = await measured(fixture, () =>
      call<Awaited<ReturnType<RetentionService["preview"]>>>("preview", { days: 30 }),
    )
    mainRows.push(preview.rows)
    previews.push(preview.value.rows)
    expect(preview.value.protected.find((item) => item.noun === "tasks")?.count).toBeGreaterThan(0)
    expect(preview.value.protected.find((item) => item.noun === "attempts")?.count).toBe(
      fixture.attempts.length,
    )
    expect(preview.value.worktrees).toMatchObject([{ path: tree, action: "remove", bytes: 1024 }])
    expect(preview.value.worktreeBytes).toBe(1024)

    const warm = await measured(fixture, () =>
      call<Awaited<ReturnType<RetentionService["status"]>>>("status", {}),
    )
    mainRows.push(warm.rows)
    expect(warm.value.presets).toEqual(cold.value.presets)
  }
  expect(Math.max(...mainRows)).toBeLessThanOrEqual(8)
  expect(previews[1]).toBeGreaterThan(previews[0]!)
})

test("the fresh file-size connection reads PRAGMA metadata only", () => {
  const { fixture } = seedHistory(25)
  let meter: ReadMeter | undefined
  const sizes = retentionDatabaseSizes(fixture.repository.path, (path, options) => {
    const measured = meterDatabase(new Database(path, options))
    meter = measured.meter
    return measured.db
  })
  expect(sizes.fileBytes).toBeGreaterThan(0)
  expect(meter?.rows).toBe(4)
  expect(meter?.statements).toEqual([
    "PRAGMA auto_vacuum",
    "PRAGMA page_size",
    "PRAGMA page_count",
    "PRAGMA freelist_count",
  ])
  expect(meter?.statements.some((sql) => forbiddenHistorySQL.test(sql))).toBe(false)
  meter?.stop()
})

test("preview refreshes for asOf, writes and retirement instead of caching an old estimate", async () => {
  const { fixture } = seedHistory(0)
  let now = NOW
  const { call } = settings(fixture, () => now)
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_transitions SET created_at=? WHERE plan_id=?").run(
      NOW - 30.25 * DAY,
      fixture.receipt.planID,
    )
    db.query("UPDATE runner_attempts SET started_at=1 WHERE plan_id=?").run(fixture.receipt.planID)
  })

  const pinned = await call<Awaited<ReturnType<RetentionService["preview"]>>>("preview", {
    days: 30,
    asOf: NOW - 12 * 60 * 60_000,
  })
  expect(pinned.asOf).toBe(NOW - 12 * 60 * 60_000)
  expect(pinned.plans.retired).toBe(0)

  now = NOW - 12 * 60 * 60_000
  const earlier = await call<Awaited<ReturnType<RetentionService["preview"]>>>("preview", {
    days: 30,
  })
  expect(earlier.plans.retired).toBe(0)

  now = NOW
  const current = await call<Awaited<ReturnType<RetentionService["preview"]>>>("preview", {
    days: 30,
  })
  expect(current.plans.retired).toBe(1)
  const progressBefore = current.kinds.find((kind) => kind.id === "progress")!.rows
  fixture.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,
          at,source,sources_json,kind,event_ids_json,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        fixture.directory,
        "project",
        fixture.receipt.planID,
        taskID,
        fixture.attempts[0]!.id,
        "ses-retention-refresh",
        2,
        "test",
        "[]",
        "tool",
        "[]",
        "retention-refresh",
        "{}",
      ),
  )
  const updated = await call<Awaited<ReturnType<RetentionService["preview"]>>>("preview", {
    days: 30,
  })
  expect(updated.kinds.find((kind) => kind.id === "progress")!.rows).toBe(progressBefore + 1)

  const slice = await call<Awaited<ReturnType<RetentionService["retire"]>>>("retire", {
    days: 30,
    asOf: updated.asOf,
    confirmed: true,
  })
  expect(slice.done).toBe(true)
  const status = await call<Awaited<ReturnType<RetentionService["status"]>>>("status", {})
  expect(status.presets.find((preset) => preset.days === 30)?.rows).toBe(0)
})

test("a reader query failure is surfaced rather than returned as an exact zero", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-retention-reader-"))
  try {
    const path = join(directory, "empty.sqlite")
    const db = new Database(path)
    db.close()
    const reader = new RetentionReader(path)
    await expect(reader.status({ now: NOW, dataDirectory: directory })).rejects.toThrow(
      /runner_plans/,
    )
    await reader.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a dead reader generation cannot reject a replacement worker's result", async () => {
  const first = new FakeReaderWorker()
  const second = new FakeReaderWorker()
  let creations = 0
  let resolveSecondStarted!: () => void
  const secondStarted = new Promise<void>((resolve) => {
    resolveSecondStarted = resolve
  })
  const reader = new RetentionReader("unused", new URL("file:///retention-reader-test.js"), () => {
    creations += 1
    if (creations === 2) resolveSecondStarted()
    return creations === 1 ? first : second
  })
  const input = { now: NOW, dataDirectory: "." }
  const failed = reader.status(input)
  const retry = reader.status(input)
  await first.nextRequest()
  const failure = new Error("reader worker crashed")
  first.emit("error", failure)
  await secondStarted
  first.emit("exit", 1)

  const request = await second.nextRequest()
  if (request.type === "close") throw new Error("expected a status request")
  const value = { presets: [], superseded: { rows: 0, bytes: 0 } }
  second.emit("message", { type: "result", id: request.id, value } satisfies RetentionReadResult)

  await expect(failed).rejects.toBe(failure)
  await expect(retry).resolves.toEqual(value)
  await reader.close()
  expect(second.terminated).toBe(true)
})

test("closing terminates a reader worker that does not acknowledge shutdown", async () => {
  const worker = new FakeReaderWorker(false)
  const reader = new RetentionReader(
    "unused",
    new URL("file:///retention-reader-test.js"),
    () => worker,
  )
  const read = reader.status({ now: NOW, dataDirectory: "." })
  const outcome = read.then(
    () => undefined,
    (error: unknown) => error,
  )
  await worker.nextRequest()
  await reader.close()
  const error = await outcome
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe("Retention reader closed")
  expect(worker.terminated).toBe(true)
})
