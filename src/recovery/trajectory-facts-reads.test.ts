import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { meterDatabase } from "../runner/read-meter.fixture.ts"
import { readTrajectoryFacts, readTrajectoryTail } from "./trajectory-facts.ts"
import { legacyTrajectoryFacts, legacyTrajectoryTail } from "./trajectory-facts-legacy.fixture.ts"

function journal() {
  const db = new Database(":memory:")
  db.run(
    "CREATE TABLE runner_transitions(id INTEGER PRIMARY KEY, plan_id TEXT, task_id TEXT, event TEXT, payload TEXT, created_at INTEGER)",
  )
  db.run(
    "CREATE TABLE runner_attempts(id TEXT, plan_id TEXT, task_id TEXT, state TEXT, started_at INTEGER, token_count INTEGER, tool_count INTEGER, cost REAL)",
  )
  db.run(
    `CREATE TABLE runner_progress(seq INTEGER PRIMARY KEY, project_directory TEXT, attempt_id TEXT, at INTEGER,
       kind TEXT, call_id TEXT, payload TEXT)`,
  )
  return db
}

const REASONS = [
  "Out-of-scope changes: src/x.ts",
  "Out-of-scope changes: src/y.ts",
  "Verification failed: bun test",
  "Something nobody classified",
]
const FILLER = "x".repeat(300)

/** One task with a long history: 3 attempts, 3 worker intervals, hundreds of counted events. */
function seed(db: Database) {
  const add = (event: string, payload: object, at: number) =>
    db.run(
      "INSERT INTO runner_transitions(plan_id,task_id,event,payload,created_at) VALUES('p','t',?,?,?)",
      [event, JSON.stringify({ ...payload, note: FILLER }), at],
    )
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = attempt * 1_000_000
    add("WORKER_STARTED", { attemptID: `a${attempt}` }, base)
    for (let round = 0; round < 40; round++) {
      add("VERIFY", {}, base + 10 + round)
      add("REPAIR", { from: round % 3 === 0 ? "verifying" : "running" }, base + 11 + round)
      add("RETAINED_REPAIR", { from: round % 5 === 0 ? "accepted" : "ready" }, base + 12 + round)
      add("RESUME", {}, base + 13 + round)
      add("BLOCKED", { reason: REASONS[(round + attempt) % REASONS.length] }, base + 14 + round)
    }
    add("WORKER_STOPPED", { outcome: attempt === 1 ? "interrupted" : "done" }, base + 500_000)
  }
  add("WORKER_STARTED", { attemptID: "a3" }, 3_100_000)
  db.run("INSERT INTO runner_attempts VALUES('a0','p','t','failed',0,1000,10,0.25)")
  db.run("INSERT INTO runner_attempts VALUES('a1','p','t','failed',1000000,2000,20,NULL)")
  db.run("INSERT INTO runner_attempts VALUES('a2','p','t','done',2000000,NULL,30,0.5)")
  db.run("INSERT INTO runner_attempts VALUES('a3','p','t','running',3100000,4000,40,0.125)")
  db.run("INSERT INTO runner_attempts VALUES('other','p','other-task','running',0,9,9,9)")

  let seq = 0
  const row = (kind: string, payload: object, at: number, call = kind === "tool") =>
    db.run(
      "INSERT INTO runner_progress(seq,project_directory,attempt_id,at,kind,call_id,payload) VALUES(?,?,?,?,?,?,?)",
      [++seq, "/repo", "a3", at, kind, call ? `c${seq}` : null, JSON.stringify(payload)],
    )
  for (let index = 0; index < 400; index++) {
    row("step", { usage: { input: 10, output: 5, cacheRead: 100 } }, 3_100_000 + index)
    // The same few files edited again and again, some edits failed or never ran.
    const status = ["succeeded", "failed", undefined, "not-executed"][index % 4]
    row(
      "tool",
      {
        tool: index % 2 ? "edit" : "write",
        ...(status ? { status } : {}),
        content: FILLER,
        fileTargets: { operation: "edit", paths: [`src/file-${index % 5}.ts`] },
      },
      3_100_000 + index,
    )
    row("tool", { tool: "read", status: "succeeded", content: FILLER }, 3_100_000 + index)
  }
  // An old-format patch lists its files in the result text.
  row(
    "tool",
    { tool: "patch", status: "succeeded", content: "Success.\nM src/old.ts\nA docs/new.md" },
    3_200_000,
  )
  row("tool", { tool: "patch", status: "failed", content: "A docs/never.md" }, 3_200_001)
}

const meter = (db: Database, run: (db: Database) => unknown) => {
  const metered = meterDatabase(db)
  const value = run(metered.db)
  return { value, rows: metered.meter.rows, bytes: metered.meter.bytes }
}

test("facts equal the previous reader at every moment, live and replayed, and read far less", () => {
  const db = journal()
  seed(db)
  const moments = [0, 1, 700_000, 1_500_000, 2_600_000, 3_100_500, 4_000_000]
  for (const now of moments) {
    for (const replay of [false, true]) {
      const options = { replay, projectDirectory: "/repo" }
      expect(readTrajectoryFacts(db, "p", "t", now, options)).toEqual(
        legacyTrajectoryFacts(db, "p", "t", now, options),
      )
    }
  }
  expect(readTrajectoryFacts(db, "p", "none", 5)).toEqual(legacyTrajectoryFacts(db, "p", "none", 5))

  const now = 4_000_000
  const before = meter(db, (d) => legacyTrajectoryFacts(d, "p", "t", now))
  const after = meter(db, (d) => readTrajectoryFacts(d, "p", "t", now))
  const beforeReplay = meter(db, (d) =>
    legacyTrajectoryFacts(d, "p", "t", now, { replay: true, projectDirectory: "/repo" }),
  )
  const afterReplay = meter(db, (d) =>
    readTrajectoryFacts(d, "p", "t", now, { replay: true, projectDirectory: "/repo" }),
  )
  console.log("readTrajectoryFacts read-meter (607 transitions, 4 attempts, 1,200 progress rows)", {
    live: {
      before: { rows: before.rows, bytes: before.bytes },
      after: { rows: after.rows, bytes: after.bytes },
    },
    replay: {
      before: { rows: beforeReplay.rows, bytes: beforeReplay.bytes },
      after: { rows: afterReplay.rows, bytes: afterReplay.bytes },
    },
  })
  expect(after.rows).toBeLessThan(before.rows / 3)
  expect(after.bytes).toBeLessThan(before.bytes / 10)
  expect(afterReplay.rows).toBeLessThan(beforeReplay.rows / 3)
})

test("the tail equals the previous reader at every sequence and reads only distinct edit targets", () => {
  const db = journal()
  seed(db)
  const last = db.query<{ seq: number }, []>("SELECT max(seq) AS seq FROM runner_progress").get()!
  for (const through of [1, 2, 3, 4, 5, 50, 601, 1_000, last.seq - 2, last.seq]) {
    for (const scope of [["src/**"], ["src/file-1.ts"], [] as string[]]) {
      expect(readTrajectoryTail(db, "/repo", "a3", scope, through)).toEqual(
        legacyTrajectoryTail(db, "/repo", "a3", scope, through),
      )
    }
  }
  expect(readTrajectoryTail(db, "/repo", "a3", ["src/**"])).toEqual(
    legacyTrajectoryTail(db, "/repo", "a3", ["src/**"]),
  )
  const before = meter(db, (d) => legacyTrajectoryTail(d, "/repo", "a3", ["src/**"]))
  const after = meter(db, (d) => readTrajectoryTail(d, "/repo", "a3", ["src/**"]))
  console.log("readTrajectoryTail read-meter (1,200 progress rows, 400 edit rows)", {
    before: { rows: before.rows, bytes: before.bytes },
    after: { rows: after.rows, bytes: after.bytes },
  })
  expect(after.rows).toBeLessThan(before.rows)
  expect(after.bytes).toBeLessThan(before.bytes / 5)
})
