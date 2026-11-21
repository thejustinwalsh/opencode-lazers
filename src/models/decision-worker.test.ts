import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { ModelDecisionReadInputSchema } from "./decision-contract.ts"
import type { ModelDecisionReader } from "./decision-contract.ts"
import { createModelDecisionReader } from "./decision-read.ts"
import { readDecisionPriceState, readPriceIdentity } from "./price-state.ts"
import type { PriceInputs } from "./price-state.ts"
import { createThreadedDecisionReader } from "./decision-worker-client.ts"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import {
  defaultModelPriceSourcePolicy,
  ModelPriceSourceSettingsSchema,
} from "./price-source-settings.ts"
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const SESSION = /ses-[a-z-]+/g
const CLONED_TABLES = [
  "tasks",
  "task_references",
  "runner_plans",
  "runner_plan_revisions",
  "runner_nodes",
  "runner_attempts",
  "runner_progress",
  "runner_transitions",
] as const

/** Multiply the fixture ledger by remapping every id so clones are distinct tasks. */
function inflateLedger(path: string, copies: number) {
  const db = new Database(path, { strict: true })
  try {
    const rows = new Map<string, Record<string, unknown>[]>()
    const columns = new Map<string, string[]>()
    for (const table of CLONED_TABLES) {
      rows.set(table, db.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all())
      columns.set(
        table,
        db
          .query<{ name: string; pk: number; type: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .filter((column) => !(column.pk === 1 && column.type.toUpperCase() === "INTEGER"))
          .map((column) => column.name),
      )
    }
    // Truncating a random UUID collides when two ids differ only in the replaced
    // suffix; memoize a fresh UUID per (copy, id) so references stay consistent.
    const remapped = new Map<string, string>()
    const freshID = (id: string, copy: number) => {
      const key = `${copy}:${id}`
      let next = remapped.get(key)
      if (next === undefined) {
        next = crypto.randomUUID()
        remapped.set(key, next)
      }
      return next
    }
    const remap = (value: string, copy: number) =>
      value.replace(UUID, (id) => freshID(id, copy)).replace(SESSION, (id) => `${id}-c${copy}`)
    const baseSequence = (
      db.query("SELECT MAX(sequence) AS m FROM task_references").get() as { m: number }
    ).m
    db.exec("BEGIN")
    for (let copy = 1; copy <= copies; copy++) {
      for (const table of CLONED_TABLES) {
        const names = columns.get(table)!
        const insert = db.query(
          `INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
        )
        for (const row of rows.get(table)!) {
          insert.run(
            ...names.map((name) => {
              const value = row[name]
              if (name === "sequence") return (value as number) + baseSequence * copy
              if (name === "reference") return `${value}-c${copy}`
              return typeof value === "string" ? remap(value, copy) : (value as never)
            }),
          )
        }
      }
    }
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

function settings() {
  return ModelPriceSourceSettingsSchema.parse({
    policy: defaultModelPriceSourcePolicy(),
    access: { openrouter: "configured", opencode: "not-configured" },
  })
}

const priceInputs = (): PriceInputs => ({
  policy: defaultModelPriceSourcePolicy(),
  openrouter: "configured",
})
const readPriceInputs = async () => priceInputs()

/** The in-process equivalent of what the worker does: read price state from the same database. */
const priceReadersFor = (path: string, projectDirectory: string) => ({
  readPriceState: async (routes: Parameters<typeof readDecisionPriceState>[0]["routes"]) =>
    readDecisionPriceState({ path, projectDirectory, inputs: priceInputs(), routes }),
  readPriceIdentity: async () =>
    readPriceIdentity({ path, projectDirectory, inputs: priceInputs() }),
})

function inputFor(projectDirectory: string) {
  return ModelDecisionReadInputSchema.parse({
    schemaVersion: 2,
    scope: { projectDirectory },
    filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  })
}

/** Snapshot ids and production time are per-read random values; everything else must match. */
function normalize(value: unknown, snapshotIDs: readonly string[]) {
  let text = JSON.stringify(value)
  for (const id of snapshotIDs) text = text.split(id).join("<snapshot>")
  return JSON.parse(
    text
      .replace(/"producedAt":"[^"]*"/g, '"producedAt":""')
      .replace(/"nextCursor":"[^"]*"/g, '"nextCursor":"<cursor>"'),
  ) as unknown
}

async function everything(reader: ModelDecisionReader, projectDirectory: string) {
  const input = inputFor(projectDirectory)
  const overview = await reader.overview(input)
  const snapshotID = overview.context.snapshotID
  const rows = await reader.rows({ ...input, snapshotID, limit: 50 })
  return normalize({ overview, rows }, [snapshotID])
}

test("worker reader returns the same decision data as the synchronous reader", async () => {
  const fixture = makeLedgerFixture()
  inflateLedger(fixture.path, 3)
  const sync = createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger: () => openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory),
    ...priceReadersFor(fixture.path, fixture.projectDirectory),
  })
  const threaded = createThreadedDecisionReader({
    path: fixture.path,
    projectDirectory: fixture.projectDirectory,
    readPriceInputs,
  })
  try {
    const expected = await everything(sync, fixture.projectDirectory)
    const actual = await everything(threaded, fixture.projectDirectory)
    expect(actual).toEqual(expected)
    expect(
      (expected as { overview: { context: { classification: { totalTaskCount: number } } } })
        .overview.context.classification.totalTaskCount,
    ).toBeGreaterThan(6)
    const again = await threaded.overview(inputFor(fixture.projectDirectory))
    const cached = await threaded.overview(inputFor(fixture.projectDirectory))
    expect(cached.context.snapshotID).toBe(again.context.snapshotID)
  } finally {
    sync.close()
    threaded.close()
    fixture.close()
  }
})

test("large-ledger overview keeps the main event loop ticking", async () => {
  const fixture = makeLedgerFixture()
  inflateLedger(fixture.path, 400)
  const threaded = createThreadedDecisionReader({
    path: fixture.path,
    projectDirectory: fixture.projectDirectory,
    readPriceInputs,
  })
  const input = inputFor(fixture.projectDirectory)
  let last = performance.now()
  let maxGap = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
  }, 5)
  try {
    const started = performance.now()
    last = started
    const overview = await threaded.overview(input)
    const elapsed = performance.now() - started
    expect(overview.context.classification.totalTaskCount).toBeGreaterThan(2000)
    await threaded.rows({ ...input, snapshotID: overview.context.snapshotID, limit: 50 })
    console.log(`threaded overview ${elapsed.toFixed(0)}ms, max loop gap ${maxGap.toFixed(1)}ms`)
    expect(maxGap).toBeLessThan(100)
    const cachedStarted = performance.now()
    await threaded.overview(input)
    expect(performance.now() - cachedStarted).toBeLessThan(elapsed)

    const sync = createModelDecisionReader({
      projectDirectory: fixture.projectDirectory,
      openLedger: () => openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory),
      ...priceReadersFor(fixture.path, fixture.projectDirectory),
    })
    last = performance.now()
    maxGap = 0
    await sync.overview(input)
    await new Promise((resolve) => setTimeout(resolve, 20))
    console.log(`synchronous overview blocked the loop for ${maxGap.toFixed(1)}ms`)
    sync.close()
  } finally {
    clearInterval(timer)
    threaded.close()
    fixture.close()
  }
}, 120_000)

test("aborting a worker read rejects promptly and leaves the reader usable", async () => {
  const fixture = makeLedgerFixture()
  const threaded = createThreadedDecisionReader({
    path: fixture.path,
    projectDirectory: fixture.projectDirectory,
    readPriceInputs,
  })
  try {
    const controller = new AbortController()
    const pending = threaded.overview(inputFor(fixture.projectDirectory), {
      signal: controller.signal,
    })
    controller.abort(new Error("stop"))
    await expect(pending).rejects.toThrow("stop")
    const overview = await threaded.overview(inputFor(fixture.projectDirectory))
    expect(overview.context.snapshotID).toBeTruthy()
  } finally {
    threaded.close()
    fixture.close()
  }
})

function bumpRevision(path: string) {
  const db = new Database(path, { strict: true })
  try {
    db.exec("UPDATE observation_revisions SET revision=revision+1")
  } finally {
    db.close()
  }
}

test("a recently read snapshot is rebuilt in the background when the revision moves", async () => {
  const fixture = makeLedgerFixture()
  let priceReads = 0
  const threaded = createThreadedDecisionReader({
    path: fixture.path,
    projectDirectory: fixture.projectDirectory,
    warmIntervalMs: 50,
    readPriceInputs: async () => {
      priceReads++
      return priceInputs()
    },
  })
  try {
    const input = inputFor(fixture.projectDirectory)
    const first = await threaded.overview(input)

    // Nothing changed: the keep-warm loop must not rebuild or even read prices.
    const quiet = priceReads
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(priceReads).toBe(quiet)

    bumpRevision(fixture.path)
    const before = priceReads
    // No read is made: the rebuild is the worker's own.
    const deadline = Date.now() + 10_000
    while (priceReads === before && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    expect(priceReads).toBeGreaterThan(before)

    // The person's read now finds the rebuilt snapshot: one price read to validate it, no rebuild.
    const settled = priceReads
    const next = await threaded.overview(input)
    expect(next.context.snapshotID).not.toBe(first.context.snapshotID)
    expect(priceReads).toBe(settled + 1)
  } finally {
    threaded.close()
    fixture.close()
  }
}, 30_000)

test("the reader warms only when the revision moved past the cached snapshot", async () => {
  const fixture = makeLedgerFixture()
  let priceReads = 0
  const reader = createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger: () => openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory),
    readPriceState: (routes, signal) => {
      priceReads++
      return priceReadersFor(fixture.path, fixture.projectDirectory).readPriceState(routes)
    },
  })
  try {
    const input = inputFor(fixture.projectDirectory)
    expect(await reader.warm(input)).toBe("refreshed")
    const built = priceReads
    expect(await reader.warm(input)).toBe("current")
    expect(priceReads).toBe(built)
    bumpRevision(fixture.path)
    expect(await reader.warm(input)).toBe("refreshed")
  } finally {
    reader.close()
    fixture.close()
  }
})
