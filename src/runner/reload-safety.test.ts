import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { reloadSafety } from "./reload-safety.ts"

function database() {
  const db = new Database(":memory:")
  db.run("CREATE TABLE runner_plans(id TEXT, state TEXT)")
  db.run("CREATE TABLE runner_attempts(id TEXT, plan_id TEXT, state TEXT)")
  db.run("CREATE TABLE runner_effects(id TEXT, kind TEXT, state TEXT)")
  return db
}

test("a reload is unsafe while a worker or a verification is running", () => {
  const db = database()
  expect(reloadSafety(db).line).toBe(
    "0 workers running, 0 verifications running, safe to reload: yes",
  )
  db.run("INSERT INTO runner_plans VALUES('p','running')")
  db.run("INSERT INTO runner_attempts VALUES('a','p','running')")
  db.run("INSERT INTO runner_attempts VALUES('b','p','accepted')")
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
  db.run("INSERT INTO runner_attempts VALUES('a','p','preparing')")
  expect(reloadSafety(db).safe).toBe(true)
})
