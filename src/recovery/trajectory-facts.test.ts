import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import {
  canStruggle,
  durationLabel,
  readTrajectoryFacts,
  readTrajectoryTail,
  tokenLabel,
} from "./trajectory-facts.ts"

test("terminal states cannot struggle; the labels read plainly", () => {
  for (const state of ["accepted", "cancelled", "failed"]) expect(canStruggle(state)).toBe(false)
  for (const state of ["running", "blocked", "ready", "verifying"])
    expect(canStruggle(state)).toBe(true)
  expect(durationLabel(4 * 3_600_000 + 10 * 60_000)).toBe("4h 10m")
  expect(tokenLabel(92_000_000)).toBe("92M")
})

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

test("facts are read from the journal and attempts, summed across attempts", () => {
  const db = journal()
  const add = (event: string, payload: object, at: number) =>
    db.run(
      "INSERT INTO runner_transitions(plan_id,task_id,event,payload,created_at) VALUES('p','t',?,?,?)",
      [event, JSON.stringify(payload), at],
    )
  const hour = 3_600_000
  add("VERIFY", {}, 1)
  add("VERIFY", {}, 2)
  add("REPAIR", { from: "verifying", to: "ready" }, 3)
  add("RETAINED_REPAIR", { from: "accepted" }, 4)
  add("WORKER_STARTED", { attemptID: "a1" }, 0)
  add("WORKER_STOPPED", { attemptID: "a1", outcome: "interrupted" }, hour)
  add("ATTEMPT_RESUMED", { attemptID: "a2" }, 2 * hour)
  for (let i = 0; i < 3; i++) add("BLOCKED", { reason: "Out-of-scope changes: src/x.ts" }, 5 + i)
  db.run("INSERT INTO runner_attempts VALUES('a1','p','t','failed',0,1000,10,NULL)")
  db.run("INSERT INTO runner_attempts VALUES('a2','p','t','running',?,2000,5,0.5)", [2 * hour])
  const facts = readTrajectoryFacts(db, "p", "t", 5 * hour)
  expect(facts).toMatchObject({
    attempts: 2,
    verifyRounds: 2,
    verifyFailures: 1,
    repairsAndResumes: 2,
    interruptions: 1,
    reopenedAfterAccept: 1,
    attemptMs: hour + 3 * hour,
    tokens: 3000,
    toolCalls: 15,
    costUSD: 0.5,
  })
  expect(facts.repeatedHold?.count).toBe(3)
  // Replayed as of an earlier moment, later records and attempts do not exist yet.
  const early = readTrajectoryFacts(db, "p", "t", 2, { replay: true })
  expect(early).toMatchObject({ verifyRounds: 2, repairsAndResumes: 0, attempts: 1 })
})

test("the tail counts failures, calls since the last file change and tokens since then", () => {
  const db = journal()
  let seq = 0
  const row = (kind: string, payload: object, at: number, call = kind === "tool") =>
    db.run(
      "INSERT INTO runner_progress(seq,project_directory,attempt_id,at,kind,call_id,payload) VALUES(?,?,?,?,?,?,?)",
      [++seq, "/repo", "a1", at, kind, call ? `c${seq}` : null, JSON.stringify(payload)],
    )
  const step = (tokens: number, at: number) =>
    row("step", { usage: { input: tokens / 2, cacheRead: tokens / 2 } }, at)
  row("tool", { tool: "read", status: "succeeded" }, 1)
  step(1000, 1)
  // An old-format patch carries its files in the result text, a new one in fileTargets.
  row(
    "tool",
    { tool: "patch", status: "succeeded", content: "Success.\nM src/a.ts\nA docs/x.md" },
    2,
  )
  step(2000, 2)
  row(
    "tool",
    {
      tool: "patch",
      status: "succeeded",
      fileTargets: { operation: "patch", paths: ["src/b.ts"] },
    },
    3,
  )
  step(4000, 3)
  row("tool", { tool: "patch", status: "failed" }, 4)
  row("tool", { tool: "read", status: "failed" }, 5)
  row("tool", { tool: "shell", status: "failed" }, 6)
  step(8000, 6)
  const tail = readTrajectoryTail(db, "/repo", "a1", ["src/**"])
  expect(tail).toMatchObject({
    trailingToolFailures: 3,
    callsWithoutFileChange: 3,
    tokensWithoutFileChange: 12_000,
    outOfScope: ["docs/x.md"],
  })
  expect(tail.throughSequence).toBe(seq)
  // As of the second call: one patch landed, nothing failed, the scope was already broken.
  expect(readTrajectoryTail(db, "/repo", "a1", ["src/**"], 3)).toMatchObject({
    trailingToolFailures: 0,
    callsWithoutFileChange: 0,
    outOfScope: ["docs/x.md"],
  })
})
