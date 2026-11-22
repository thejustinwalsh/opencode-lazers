import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { ARCHITECT_TURN_STALE_MS, reloadSafety } from "./reload-safety.ts"

function database() {
  const db = new Database(":memory:")
  db.run("CREATE TABLE runner_plans(id TEXT, state TEXT, owner TEXT)")
  db.run(
    "CREATE TABLE runner_attempts(id TEXT, plan_id TEXT, state TEXT, session_id TEXT DEFAULT 'ses_worker')",
  )
  db.run("CREATE TABLE runner_effects(id TEXT, kind TEXT, state TEXT)")
  return db
}

function reload(
  db: Database,
  input: { sessions?: string[]; processIDs?: number[] } = {},
  opencode?: Database,
  now = Date.now(),
) {
  return reloadSafety(db, opencode, now, {
    sessions: { kind: "observed", sessionIDs: input.sessions ?? [] },
    verifications: { kind: "observed", processIDs: input.processIDs ?? [] },
  })
}

test("only a positively busy host session counts as a worker; idle attempts are listed as stale", () => {
  const db = database()
  db.run("INSERT INTO runner_plans VALUES('p','running',NULL)")
  db.run("INSERT INTO runner_attempts(id,plan_id,state) VALUES('attempt-stale','p','running')")
  expect(reload(db)).toMatchObject({
    safe: true,
    workers: 0,
    staleAttempts: [{ id: "attempt-stale", sessionID: "ses_worker", state: "running" }],
  })
  const busy = reload(db, { sessions: ["ses_worker"] })
  expect(busy).toMatchObject({ safe: false, workers: 1, staleAttempts: [] })
  expect(busy.line).toBe(
    "1 worker running, 0 verifications running, 0 Architect turns in flight, safe to reload: no",
  )
  db.run("UPDATE runner_attempts SET state='accepted'")
  expect(reload(db).safe).toBe(true)
})

test("a live verification process holds a reload, not an intended row by itself", () => {
  const db = database()
  db.run("INSERT INTO runner_effects VALUES('e','verify:quality','intended')")
  expect(reload(db)).toMatchObject({ safe: true, verifications: 0 })
  const busy = reload(db, { processIDs: [42] })
  expect(busy).toMatchObject({ safe: false, verifications: 1 })
  expect(busy.line).toContain("1 verification running")
  db.run("UPDATE runner_effects SET state='completed'")
  expect(reload(db).safe).toBe(true)
})

test("work of a cancelled plan does not block a reload or appear as stale", () => {
  const db = database()
  db.run("INSERT INTO runner_plans VALUES('p','cancelled',NULL)")
  db.run("INSERT INTO runner_attempts(id,plan_id,state) VALUES('a','p','preparing')")
  expect(reload(db)).toMatchObject({ safe: true, workers: 0, staleAttempts: [] })
})

test("every host-active session blocks reload, including cancelled workers and untracked children", () => {
  const db = database()
  db.run("INSERT INTO runner_plans VALUES('p','cancelled',NULL)")
  db.run(
    "INSERT INTO runner_attempts(id,plan_id,state,session_id) VALUES('cancelled-worker','p','running','ses_cancelled')",
  )
  for (const sessionID of ["ses_cancelled", "ses_native_child", "ses_architect_without_plan"]) {
    const result = reload(db, { sessions: [sessionID] })
    expect(result).toMatchObject({ safe: false, otherHostSessions: 1 })
    expect(result.line).toContain("1 other host session active")
  }
})

test("check kinds and retained/adoption state labels need a live process to hold a reload", () => {
  const db = database()
  db.run("CREATE TABLE runner_retained_verifications(id TEXT, state TEXT)")
  db.run("CREATE TABLE runner_adoption_checks(adoption_id TEXT, state TEXT)")
  for (const kind of ["graph-verify:fallow-audit", "mechanical-fix", "verify:lazers-fallow"]) {
    db.run("DELETE FROM runner_effects")
    db.run("INSERT INTO runner_effects VALUES('e',?, 'intended')", [kind])
    expect(reload(db)).toMatchObject({ safe: true, verifications: 0 })
    expect(reload(db, { processIDs: [17] })).toMatchObject({ safe: false, verifications: 1 })
  }
  db.run("DELETE FROM runner_effects")
  db.run("INSERT INTO runner_effects VALUES('w','worktree','intended')")
  expect(reload(db).safe).toBe(true)
  for (const state of ["pending", "task-checks"]) {
    db.run("DELETE FROM runner_retained_verifications")
    db.run("INSERT INTO runner_retained_verifications VALUES('r',?)", [state])
    expect(reload(db)).toMatchObject({ safe: true, verifications: 0 })
  }
  db.run("UPDATE runner_retained_verifications SET state='completed'")
  expect(reload(db).safe).toBe(true)
  db.run("INSERT INTO runner_adoption_checks VALUES('a','intended')")
  expect(reload(db)).toMatchObject({ safe: true, verifications: 0 })
  expect(reload(db, { processIDs: [19] })).toMatchObject({ safe: false, verifications: 1 })
})

test("open takeovers hold a reload and a missing takeover table does not", () => {
  const db = database()
  expect(reload(db).safe).toBe(true)
  db.run("CREATE TABLE runner_takeovers(id TEXT, state TEXT)")
  db.run("INSERT INTO runner_takeovers VALUES('t','done')")
  expect(reload(db).safe).toBe(true)
  for (const state of ["notifying", "awaiting-handoff", "stopping"]) {
    db.run("UPDATE runner_takeovers SET state=?", [state])
    const result = reload(db)
    expect(result).toMatchObject({ safe: false, takeovers: 1 })
    expect(result.line).toContain("1 takeover handoff open, safe to reload: no")
  }
})

test("an Architect with an unfinished assistant turn holds a reload until it finishes or goes stale", () => {
  const db = database()
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
  expect(reload(db, {}, opencode, now).safe).toBe(true)
  message(2, now - 1_000, false)
  const live = reload(db, {}, opencode, now)
  expect(live).toMatchObject({ safe: false, architectTurns: 1 })
  expect(live.line).toBe(
    "0 workers running, 0 verifications running, 1 Architect turn in flight, safe to reload: no",
  )
  // A turn that stopped updating long ago is a dead turn, not a live one.
  expect(reload(db, {}, opencode, now + ARCHITECT_TURN_STALE_MS + 1).safe).toBe(true)
  // Host activity also protects a currently busy Architect session.
  expect(reload(db, { sessions: ["arch"] }, opencode, now)).toMatchObject({
    safe: false,
    architectTurns: 1,
  })
  message(3, now, true)
  expect(reload(db, {}, opencode, now).safe).toBe(true)
  db.run("UPDATE runner_plans SET state='cancelled'")
  message(4, now, false)
  expect(reload(db, {}, opencode, now).safe).toBe(true)
})

test("a task an Architect took over is named as such, never as a running worker", () => {
  const db = database()
  db.run("INSERT INTO runner_plans VALUES('p','running',NULL)")
  db.run(
    "INSERT INTO runner_attempts(id,plan_id,state,session_id) VALUES('t','p','verifying','lazers-takeover:x')",
  )
  const result = reload(db)
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
  const result = reload(db)
  expect(result).toMatchObject({ safe: true, verifications: 0, uncertainSteps: 2 })
  expect(result.uncertainLine).toBe("2 uncertain steps on a blocked plan")
  expect(result.line).toContain("0 verifications running")
  db.run("DELETE FROM runner_effects WHERE id='h'")
  expect(reload(db).uncertainLine).toBe("1 uncertain step on a blocked plan")
  db.run("UPDATE runner_effects SET state='failed'")
  expect(reload(db).uncertainLine).toBeUndefined()
})

test("unavailable live observations never prove a safe reload or mark attempts stale", () => {
  const db = database()
  db.run("INSERT INTO runner_plans VALUES('p','running',NULL)")
  db.run("INSERT INTO runner_attempts(id,plan_id,state) VALUES('a','p','running')")
  const result = reloadSafety(db)
  expect(result).toMatchObject({
    safe: false,
    workers: 0,
    verifications: 0,
    staleAttempts: [],
    observationErrors: [
      "live activity observation unavailable: host session activity was not observed",
      "live activity observation unavailable: verification process activity was not observed",
    ],
  })
  expect(result.line).toContain("safe to reload: no")
})

test("an Architect owner without a readable OpenCode message database is not assumed idle", () => {
  const db = database()
  db.run("INSERT INTO runner_plans VALUES('p','blocked','arch')")
  const result = reload(db)
  expect(result.safe).toBe(false)
  expect(result.observationErrors).toContain("OpenCode message database was not available")
  expect(result.line).toContain("safe to reload: no")
})
