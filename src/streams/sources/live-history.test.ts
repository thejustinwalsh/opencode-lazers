import { afterAll, beforeAll, expect, test } from "bun:test"
import { corpus, seedDisplayCorpus } from "../../progress/display.fixture.ts"
import { operationalReads } from "../../../test/radar/operational.ts"
import { firstAttemptID, makeFixture } from "../../../test/trajectory/fixture.ts"
import type { LiveHistoryResponse } from "../../observability/contract.ts"
import { meterRepository } from "../../runner/read-meter.fixture.ts"
import { openStream } from "../client.ts"
import { readerPool, type ReaderPool } from "../pool.ts"
import { liveHistorySource } from "./live-history.ts"
import { liveHistoryItem, type LiveHistoryFilter } from "./live-history-ref.ts"

let fixture: ReturnType<typeof makeFixture>
let pool: ReaderPool
let filter: LiveHistoryFilter

beforeAll(() => {
  fixture = makeFixture()
  seedDisplayCorpus(fixture)
  filter = {
    projectDirectory: fixture.store.repository.projectDirectory,
    attemptID: firstAttemptID,
    sessionID: "ses-failed",
  }
  pool = readerPool(fixture.store.repository.path, { workers: 1 })
})
afterAll(async () => {
  await pool.close()
  fixture.close()
})

function oldRead() {
  const reads = operationalReads(fixture)
  const items: LiveHistoryResponse["items"] = []
  let cursor: string | undefined
  do {
    const page = reads.liveHistory(
      {
        scope: { kind: "project", sessionID: "ses-owner" },
        sessionID: "ses-failed",
        limit: 25,
        ...(cursor ? { cursor } : {}),
      },
      new AbortController().signal,
    )
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items.toSorted((left, right) => right.sequence - left.sequence)
}

async function walk(options: LiveHistoryFilter, window: number) {
  const stream = openStream(pool, liveHistorySource, {
    filter: options,
    order: "recent",
    window,
    transport: "copy",
  })
  await stream.ready()
  const seen = stream.items.map((row) => liveHistoryItem(row))
  while (stream.after !== 0) {
    await stream.slide(window)
    const next = stream.items.map((row) => liveHistoryItem(row))
    const last = seen.at(-1)!.sequence
    seen.push(...next.filter((item) => item.sequence < last))
  }
  const counts = { before: stream.before, after: stream.after }
  stream.close()
  return { seen, counts }
}

test("walking the stream by slides gives the history read's items, in its order, field for field", async () => {
  const expected = oldRead()
  expect(expected.length).toBeGreaterThanOrEqual(corpus.length)
  for (const window of [1, 4, 9, 100]) {
    const { seen } = await walk(filter, window)
    expect(seen).toEqual(expected)
  }
})

test("a tools-only list before a time is the history read's calls older than it", async () => {
  const calls = oldRead().filter((item) => item.tool !== null)
  const expected = calls.filter((item) => item.at < 1_100)
  expect(expected.length).toBeGreaterThan(1)
  expect(expected.length).toBeLessThan(calls.length)
  const { seen } = await walk({ ...filter, toolsOnly: true, beforeAt: 1_100 }, 5)
  expect(seen).toEqual(expected)
})

test("another attempt, session or project reads nothing", async () => {
  expect((await walk({ ...filter, attemptID: crypto.randomUUID() }, 5)).seen).toEqual([])
  expect((await walk({ ...filter, sessionID: "ses-other" }, 5)).seen).toEqual([])
  expect((await walk({ ...filter, projectDirectory: "/elsewhere" }, 5)).seen).toEqual([])
})

test("counts are exact, so a list can size its scroll", async () => {
  const stream = openStream(pool, liveHistorySource, {
    filter,
    order: "recent",
    window: 10,
    transport: "copy",
  })
  await stream.ready()
  expect(stream.before).toBe(0)
  expect(stream.after).toBe(oldRead().length - 10)
  await stream.seek("tail")
  expect(stream.after).toBe(0)
  expect(stream.before).toBe(oldRead().length - 10)
  stream.close()
})

test("opening, sliding and seeking run no statement on the main repository", async () => {
  const meter = meterRepository(fixture.store.repository)
  try {
    const stream = openStream(pool, liveHistorySource, {
      filter,
      order: "recent",
      window: 10,
      transport: "copy",
    })
    await stream.ready()
    await stream.slide(10)
    await stream.seek("tail")
    expect(stream.items.length).toBeGreaterThan(0)
    stream.close()
  } finally {
    meter.stop()
  }
  expect(meter.statements).toEqual([])
  const old = meterRepository(fixture.store.repository)
  fixture.store.read((db) => db.query("SELECT 1 FROM runner_progress LIMIT 1").get())
  old.stop()
  expect(old.statements.length).toBeGreaterThan(0)
})

test("the reads are range seeks on the attempt's index, never a scan of the table", () => {
  const plans = fixture.store.read((db) => {
    const where =
      "project_directory=? AND attempt_id=? AND session_id=? AND tool IS NOT NULL AND at<?"
    const args = [filter.projectDirectory, filter.attemptID, filter.sessionID, 5_000]
    const rows = db
      .query<{ detail: string }, (string | number)[]>(
        `EXPLAIN QUERY PLAN SELECT * FROM runner_progress_display WHERE ${where} ORDER BY seq DESC LIMIT 10`,
      )
      .all(...args)
    const count = db
      .query<{ detail: string }, (string | number)[]>(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM runner_progress_display WHERE ${where} AND seq<?`,
      )
      .all(...args, 100)
    return [...rows, ...count].map((row) => row.detail)
  })
  for (const detail of plans) {
    expect(detail).toContain("runner_progress_display_attempt")
    expect(detail).not.toMatch(/^SCAN/)
    expect(detail).not.toContain("TEMP B-TREE")
  }
})
