import { expect, test } from "bun:test"
import {
  assessStruggling,
  canStruggle,
  recommendStruggling,
  STRUGGLING_THRESHOLDS,
  type StrugglingFacts,
  type StrugglingReason,
} from "./struggling.ts"

const calm: StrugglingFacts = {
  attempts: 1,
  verifyRounds: 1,
  repairsAndResumes: 0,
  interruptions: 0,
  reopenedAfterAccept: 0,
  repeatedHold: null,
  attemptMs: 30 * 60_000,
  tokens: 11_000_000,
  toolCalls: 117,
  costUSD: null,
}

test("a median task is not struggling", () => {
  expect(assessStruggling(calm)).toEqual({ struggling: false, reasons: [], line: "" })
})

test("each measure trips alone at its threshold and not below it", () => {
  const t = STRUGGLING_THRESHOLDS
  const cases: Array<[Partial<StrugglingFacts>, StrugglingReason]> = [
    [{ verifyRounds: t.verifyRounds }, "verify-rounds"],
    [{ repairsAndResumes: t.repairsAndResumes }, "repairs-and-resumes"],
    [{ attemptMs: t.attemptMs }, "attempt-time"],
    [{ tokens: t.tokens }, "tokens"],
    [{ interruptions: t.interruptions }, "interruptions"],
    [{ reopenedAfterAccept: t.reopenedAfterAccept }, "reopened-after-accept"],
    [{ repeatedHold: { family: "check-failed", count: t.sameHoldFamily } }, "repeated-hold"],
  ]
  for (const [change, reason] of cases)
    expect(assessStruggling({ ...calm, ...change }).reasons).toEqual([reason])
  expect(assessStruggling({ ...calm, verifyRounds: t.verifyRounds - 1 }).struggling).toBe(false)
  expect(assessStruggling({ ...calm, tokens: t.tokens - 1 }).struggling).toBe(false)
})

test("the line names every tripped measure in one sentence", () => {
  const facts = { ...calm, verifyRounds: 3, attemptMs: (4 * 60 + 10) * 60_000, tokens: 92_000_000 }
  expect(assessStruggling(facts).line).toBe("3 verification rounds, 4h 10m in attempts, 92M tokens")
})

test("terminal states cannot struggle", () => {
  for (const state of ["accepted", "cancelled", "failed"]) expect(canStruggle(state)).toBe(false)
  for (const state of ["running", "blocked", "ready", "verifying"])
    expect(canStruggle(state)).toBe(true)
})

test("the Architect is asked a decision that fits the facts", () => {
  const scope = { ...calm, repeatedHold: { family: "scope-violation", count: 3 } }
  expect(recommendStruggling(assessStruggling(scope), scope).action).toBe("re-scope")
  const reloads = { ...calm, interruptions: 2 }
  expect(recommendStruggling(assessStruggling(reloads), reloads).action).toBe("continue")
  const grind = { ...calm, verifyRounds: 3, tokens: 90_000_000, attemptMs: 4 * 3_600_000 }
  expect(recommendStruggling(assessStruggling(grind), grind).action).toBe("split")
})

test("facts are read from the journal and attempts, summed across attempts", async () => {
  const { Database } = await import("bun:sqlite")
  const { readStrugglingFacts } = await import("./struggling.ts")
  const db = new Database(":memory:")
  db.run(
    "CREATE TABLE runner_transitions(id INTEGER PRIMARY KEY, plan_id TEXT, task_id TEXT, event TEXT, payload TEXT, created_at INTEGER)",
  )
  db.run(
    "CREATE TABLE runner_attempts(id TEXT, plan_id TEXT, task_id TEXT, state TEXT, started_at INTEGER, token_count INTEGER, tool_count INTEGER, cost REAL)",
  )
  const add = (event: string, payload: object, at: number) =>
    db.run(
      "INSERT INTO runner_transitions(plan_id,task_id,event,payload,created_at) VALUES('p','t',?,?,?)",
      [event, JSON.stringify(payload), at],
    )
  const hour = 3_600_000
  add("VERIFY", {}, 1)
  add("VERIFY", {}, 2)
  add("REPAIR", {}, 3)
  add("RETAINED_REPAIR", { from: "accepted" }, 4)
  add("WORKER_STARTED", { attemptID: "a1" }, 0)
  add("WORKER_STOPPED", { attemptID: "a1", outcome: "interrupted" }, hour)
  add("ATTEMPT_RESUMED", { attemptID: "a2" }, 2 * hour)
  for (let i = 0; i < 3; i++) add("BLOCKED", { reason: "Out-of-scope changes: src/x.ts" }, 5 + i)
  db.run("INSERT INTO runner_attempts VALUES('a1','p','t','failed',0,1000,10,NULL)")
  db.run(
    "INSERT INTO runner_attempts VALUES('a2','p','t','running',2*3600000,2000,5,0.5)".replace(
      "2*3600000",
      String(2 * hour),
    ),
  )
  const facts = readStrugglingFacts(db, "p", "t", 5 * hour)
  expect(facts).toMatchObject({
    attempts: 2,
    verifyRounds: 2,
    repairsAndResumes: 2,
    interruptions: 1,
    reopenedAfterAccept: 1,
    attemptMs: hour + 3 * hour,
    tokens: 3000,
    toolCalls: 15,
    costUSD: 0.5,
  })
  expect(facts.repeatedHold?.count).toBe(3)
})
