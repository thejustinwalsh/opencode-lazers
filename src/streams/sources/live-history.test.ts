import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  corpus,
  seedDisplayCorpus,
  storedDisplayItem,
  type StoredDisplay,
} from "../../progress/display.fixture.ts"
import { firstAttemptID, makeFixture } from "../../../test/trajectory/fixture.ts"
import { meterRepository } from "../../runner/read-meter.fixture.ts"
import { openStream } from "../client.ts"
import { readerPool, type ReaderPool } from "../pool.ts"
import { liveHistorySource } from "./live-history.ts"
import { liveHistoryColumns, liveHistoryItem, type LiveHistoryFilter } from "./live-history-ref.ts"
import { readFrame } from "../frame.ts"
import { base64ToBytes } from "../gui.ts"
import { createStreamsService } from "../rpc.ts"
import { refreshProgressDisplay } from "../../progress/display-store.ts"

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
    scope: { kind: "project", sessionID: "ses-owner" },
    projectIDs: ["project"],
  }
  pool = readerPool(fixture.store.repository.path, { workers: 1 })
})
afterAll(async () => {
  await pool.close()
  fixture.close()
})

/** The stored display rows, newest first, as history items: the table read directly. */
function expectedItems() {
  return fixture.store
    .read((db) =>
      db
        .query<StoredDisplay, [string]>(
          "SELECT * FROM runner_progress_display WHERE attempt_id=? AND session_id='ses-failed' AND project_id='project' ORDER BY seq DESC",
        )
        .all(firstAttemptID),
    )
    .map(storedDisplayItem)
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

test("walking the stream by slides gives the stored display rows, newest first, field for field", async () => {
  const expected = expectedItems()
  expect(expected.length).toBeGreaterThanOrEqual(corpus.length)
  for (const window of [1, 4, 9, 100]) {
    const { seen } = await walk(filter, window)
    expect(seen).toEqual(expected)
  }
})

test("a tools-only list before a time is the calls older than it", async () => {
  const calls = expectedItems().filter((item) => item.tool !== null)
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
  expect(stream.after).toBe(expectedItems().length - 10)
  await stream.seek("tail")
  expect(stream.after).toBe(0)
  expect(stream.before).toBe(expectedItems().length - 10)
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

test("opening through the service keeps what the replaced read checked: aliases, directory and session scope", async () => {
  // The same project under a second OpenCode project id, and a row of an unrelated project.
  fixture.store.atomic((db) => {
    for (const [index, projectID] of ["alias-b", "stranger"].entries()) {
      const plan = db
        .query<{ plan_id: string; task_id: string }, [string]>(
          "SELECT plan_id,task_id FROM runner_attempts WHERE id=?",
        )
        .get(firstAttemptID)!
      const result = db
        .query(
          `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,
            at,recorded_at,source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
           VALUES(?,?,?,?,?,?,?,?,?,'[]','tool','[]',?,?,?,?)`,
        )
        .run(
          fixture.store.repository.projectDirectory,
          projectID,
          plan.plan_id,
          plan.task_id,
          firstAttemptID,
          "ses-failed",
          9_000 + index,
          9_000 + index,
          "runtime",
          `call-${projectID}`,
          `msg-${projectID}`,
          `dedupe-${projectID}`,
          JSON.stringify({ tool: "read", status: "succeeded" }),
        )
      refreshProgressDisplay(db, Number(result.lastInsertRowid))
    }
  })
  const asked: string[] = []
  const service = createStreamsService({
    pool,
    changed: () => {},
    context: {
      projectID: "project",
      projectDirectory: fixture.store.repository.projectDirectory,
      projectIds: (id) => (id === "project" ? ["project", "alias-b"] : [id]),
      assertRead: async (sessionID) => {
        asked.push(sessionID)
        if (sessionID === "ses-denied") throw new Error("Not permitted")
      },
    },
  })
  const calls = async (
    input: Partial<LiveHistoryFilter> & { scope?: LiveHistoryFilter["scope"] },
  ) => {
    const frame = await service.open({
      stream: crypto.randomUUID(),
      source: "observability.liveHistory",
      filter: {
        projectDirectory: "/elsewhere",
        attemptID: firstAttemptID,
        sessionID: "ses-failed",
        scope: { kind: "project", sessionID: "ses-owner" },
        projectIDs: ["stranger"],
        ...input,
      },
      order: "recent",
      window: 200,
    })
    const bytes = base64ToBytes(frame.data)
    const read = readFrame(bytes.buffer, bytes.byteOffset, liveHistoryColumns)
    return Array.from({ length: read.header.count }, (_, i) => read.row(i).call_id)
  }
  const ids = await calls({})
  // The alias's row is the project's; the stranger's is not; the caller's directory and ids were replaced.
  expect(ids).toContain("call-alias-b")
  expect(ids).not.toContain("call-stranger")
  expect(ids.length).toBe(expectedItems().length + 1)
  await expect(calls({ scope: { kind: "session", sessionID: "ses-other" } })).rejects.toThrow(
    "unavailable in this project scope",
  )
  expect((await calls({ scope: { kind: "session", sessionID: "ses-failed" } })).length).toBe(
    ids.length,
  )
  await expect(calls({ scope: { kind: "project", sessionID: "ses-denied" } })).rejects.toThrow(
    "Not permitted",
  )
  expect(asked).toEqual(["ses-owner", "ses-failed", "ses-denied"])
  service.dispose()
})
