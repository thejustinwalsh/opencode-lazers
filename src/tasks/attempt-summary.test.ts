import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { SUMMARY_TICKS, attemptModel, readAttemptSummary } from "./attempt-summary.ts"

function fixture() {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE runner_progress (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, project_directory TEXT NOT NULL, attempt_id TEXT NOT NULL,
      at INTEGER NOT NULL, kind TEXT NOT NULL, call_id TEXT, payload TEXT NOT NULL
    );
    CREATE INDEX runner_progress_attempt_seq ON runner_progress(project_directory,attempt_id,seq);
  `)
  const add = (
    attempt: string,
    at: number,
    kind: string,
    payload: unknown = {},
    callID: string | null = null,
  ) =>
    db
      .query(
        "INSERT INTO runner_progress(project_directory,attempt_id,at,kind,call_id,payload) VALUES('/p',?,?,?,?,?)",
      )
      .run(attempt, at, kind, callID, JSON.stringify(payload))
  return { db, add }
}

test("the summary carries tick times, failures, edited files and the last activity", () => {
  const { db, add } = fixture()
  add(
    "a",
    100,
    "tool",
    { status: "succeeded", fileTargets: { operation: "read", paths: ["x.ts"] } },
    "c1",
  )
  add(
    "a",
    200,
    "tool",
    { status: "succeeded", fileTargets: { operation: "edit", paths: ["a.ts"] } },
    "c2",
  )
  add(
    "a",
    300,
    "tool",
    { status: "failed", fileTargets: { operation: "patch", paths: ["a.ts", "b.ts"] } },
    "c3",
  )
  add("a", 400, "step", {})
  add("a", 250, "tool", { status: "succeeded" }, null)
  add("other", 999, "tool", { status: "failed" }, "z")
  expect(readAttemptSummary(db, "/p", "a")).toEqual({
    lastActivityAt: 250,
    ticks: [{ at: 100 }, { at: 200 }, { at: 300, failed: true }],
    files: 2,
  })
  expect(readAttemptSummary(db, "/other-project", "a")).toEqual({ ticks: [] })
})

test("an attempt too long to draw keeps its last activity and loses ticks and files", () => {
  const { db, add } = fixture()
  db.transaction(() => {
    for (let index = 0; index <= SUMMARY_TICKS; index++)
      add(
        "long",
        index,
        "tool",
        { status: "succeeded", fileTargets: { operation: "edit", paths: [`f${index}`] } },
        `c${index}`,
      )
  })()
  expect(readAttemptSummary(db, "/p", "long")).toEqual({ lastActivityAt: SUMMARY_TICKS, ticks: [] })
})

test("the read is one newest-row lookup and one bounded range on the attempt index", () => {
  const { db } = fixture()
  const plan = (sql: string) =>
    db
      .query(`EXPLAIN QUERY PLAN ${sql}`)
      .all("/p", "a", 1)
      .map((row) => (row as { detail: string }).detail)
      .join(" | ")
  expect(
    plan(
      "SELECT at FROM runner_progress WHERE project_directory=? AND attempt_id=? ORDER BY seq DESC LIMIT ?",
    ),
  ).toContain("runner_progress_attempt_seq")
  expect(
    plan(
      "SELECT at FROM runner_progress WHERE project_directory=? AND attempt_id=? AND kind='tool' AND call_id IS NOT NULL ORDER BY seq LIMIT ?",
    ),
  ).toContain("runner_progress_attempt_seq")
})

test("the model comes from the recorded policy and is omitted when absent or unreadable", () => {
  expect(
    attemptModel(
      JSON.stringify({
        agent: "x",
        model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
      }),
    ),
  ).toEqual({ providerID: "openai", id: "gpt-6-luna", variant: "max" })
  expect(attemptModel("{}")).toBeUndefined()
  expect(attemptModel("not json")).toBeUndefined()
})
