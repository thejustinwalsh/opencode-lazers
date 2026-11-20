import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { ARCHITECT_TURN_STALE_MS, reloadSafety } from "./reload-safety.ts"

function database() {
  const db = new Database(":memory:")
  db.run("CREATE TABLE runner_plans(id TEXT, state TEXT)")
  db.run(
    "CREATE TABLE runner_attempts(id TEXT, plan_id TEXT, state TEXT, session_id TEXT DEFAULT 'ses_worker')",
  )
  db.run("CREATE TABLE runner_effects(id TEXT, kind TEXT, state TEXT)")
  return db
}

test("a reload is unsafe while a worker or a verification is running", () => {
  const db = database()
  expect(reloadSafety(db).line).toBe(
    "0 workers running, 0 verifications running, 0 Architect turns in flight, safe to reload: yes",
  )
  db.run("INSERT INTO runner_plans VALUES('p','running')")
  db.run("INSERT INTO runner_attempts(id,plan_id,state) VALUES('a','p','running')")
  db.run("INSERT INTO runner_attempts(id,plan_id,state) VALUES('b','p','accepted')")
  expect(reloadSafety(db)).toMatchObject({ safe: false, workers: 1 })
  db.run("UPDATE runner_attempts SET state='accepted'")
  db.run("INSERT INTO runner_effects VALUES('e','verify:quality','intended')")
  expect(reloadSafety(db)).toMatchObject({ safe: false, workers: 0, verifications: 1 })
  db.run("UPDATE runner_effects SET state='completed'")
  expect(reloadSafety(db).safe).toBe(true)
})

test("work of a cancelled plan does not block a reload", () => {
  const db = database()
  db.run("INSERT INTO runner_plans VALUES('p','cancelled')")
  db.run("INSERT INTO runner_attempts(id,plan_id,state) VALUES('a','p','preparing')")
  expect(reloadSafety(db).safe).toBe(true)
})

test("running check kinds, retained operations and adoption checks hold a reload", () => {
  const db = database()
  db.run("CREATE TABLE runner_retained_verifications(id TEXT, state TEXT)")
  db.run("CREATE TABLE runner_adoption_checks(adoption_id TEXT, state TEXT)")
  for (const kind of ["graph-verify:fallow-audit", "mechanical-fix", "verify:lazers-fallow"]) {
    db.run("DELETE FROM runner_effects")
    db.run("INSERT INTO runner_effects VALUES('e',?, 'intended')", [kind])
    expect(reloadSafety(db)).toMatchObject({ safe: false, verifications: 1 })
  }
  db.run("DELETE FROM runner_effects")
  db.run("INSERT INTO runner_effects VALUES('w','worktree','intended')")
  expect(reloadSafety(db).safe).toBe(true)
  for (const state of ["pending", "task-checks"]) {
    db.run("DELETE FROM runner_retained_verifications")
    db.run("INSERT INTO runner_retained_verifications VALUES('r',?)", [state])
    expect(reloadSafety(db)).toMatchObject({ safe: false, verifications: 1 })
  }
  db.run("UPDATE runner_retained_verifications SET state='completed'")
  expect(reloadSafety(db).safe).toBe(true)
  db.run("INSERT INTO runner_adoption_checks VALUES('a','intended')")
  expect(reloadSafety(db)).toMatchObject({ safe: false, verifications: 1 })
})

test("open takeovers hold a reload and a missing takeover table does not", () => {
  const db = database()
  expect(reloadSafety(db).safe).toBe(true)
  db.run("CREATE TABLE runner_takeovers(id TEXT, state TEXT)")
  db.run("INSERT INTO runner_takeovers VALUES('t','done')")
  expect(reloadSafety(db).safe).toBe(true)
  for (const state of ["notifying", "awaiting-handoff", "stopping"]) {
    db.run("UPDATE runner_takeovers SET state=?", [state])
    const result = reloadSafety(db)
    expect(result).toMatchObject({ safe: false, takeovers: 1 })
    expect(result.line).toContain("1 takeover handoff open, safe to reload: no")
  }
})

test("an Architect with an unfinished assistant turn holds a reload until it finishes or goes stale", () => {
  const db = database()
  db.run("ALTER TABLE runner_plans ADD COLUMN owner TEXT")
  db.run("INSERT INTO runner_plans VALUES('p','blocked','arch')")
  const opencode = new Database(":memory:")
  opencode.run(
    "CREATE TABLE session_message(id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)",
  )
  const now = 10_000_000
  const message = (seq: number, updated: number, completed: boolean) =>
    opencode.run("INSERT INTO session_message VALUES(?,?,?,?,?,?)", [
      `m${seq}`,
      "arch",
      "assistant",
      seq,
      updated,
      JSON.stringify({ time: completed ? { created: 1, completed: 2 } : { created: 1 } }),
    ])
  message(1, now - 1_000, true)
  expect(reloadSafety(db, opencode, now).safe).toBe(true)
  message(2, now - 1_000, false)
  const live = reloadSafety(db, opencode, now)
  expect(live).toMatchObject({ safe: false, architectTurns: 1 })
  expect(live.line).toBe(
    "0 workers running, 0 verifications running, 1 Architect turn in flight, safe to reload: no",
  )
  // A turn that stopped updating long ago is a dead turn, not a live one.
  expect(reloadSafety(db, opencode, now + ARCHITECT_TURN_STALE_MS + 1).safe).toBe(true)
  // The next message completing it releases the hold; a non-Architect session never counts.
  message(3, now, true)
  expect(reloadSafety(db, opencode, now).safe).toBe(true)
  db.run("UPDATE runner_plans SET state='cancelled'")
  message(4, now, false)
  expect(reloadSafety(db, opencode, now).safe).toBe(true)
})

test("a task an Architect took over is named as such, never as a running worker", () => {
  const db = database()
  db.run("INSERT INTO runner_plans VALUES('p','running')")
  db.run(
    "INSERT INTO runner_attempts(id,plan_id,state,session_id) VALUES('t','p','verifying','lazers-takeover:x')",
  )
  const result = reloadSafety(db)
  expect(result).toMatchObject({ workers: 0, architectTakeovers: 1, safe: true })
  expect(result.line).toBe(
    "0 workers running, 0 verifications running, 0 Architect turns in flight, 1 task taken over by an Architect, safe to reload: yes",
  )
})

test("an uncertain or held check step is reported apart and does not hold a reload", () => {
  const db = database()
  db.run("CREATE TABLE runner_adoption_checks(adoption_id TEXT, state TEXT)")
  db.run("INSERT INTO runner_effects VALUES('e','graph-verify:all','uncertain')")
  db.run("INSERT INTO runner_effects VALUES('h','verify:quality','held')")
  const result = reloadSafety(db)
  expect(result).toMatchObject({ safe: true, verifications: 0, uncertainSteps: 2 })
  expect(result.uncertainLine).toBe("2 uncertain steps on a blocked plan")
  expect(result.line).toContain("0 verifications running")
  db.run("DELETE FROM runner_effects WHERE id='h'")
  expect(reloadSafety(db).uncertainLine).toBe("1 uncertain step on a blocked plan")
  db.run("UPDATE runner_effects SET state='failed'")
  expect(reloadSafety(db).uncertainLine).toBeUndefined()
})
