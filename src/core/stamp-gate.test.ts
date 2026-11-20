import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { observationRevisionStamp, StampGate } from "./stamp-gate.ts"

test("a read runs once per stamp and concurrent callers share it", async () => {
  const gate = new StampGate<{ n: number }>({ maxBytes: 10_000 })
  let runs = 0
  const read = async () => ({ n: ++runs })
  const [a, b] = await Promise.all([gate.run("k", 1, read), gate.run("k", 1, read)])
  expect(a).toBe(b)
  expect((await gate.run("k", 1, read)).n).toBe(1)
  expect(runs).toBe(1)
  expect((await gate.run("k", 2, read)).n).toBe(2)
  expect(gate.counts).toEqual({ ran: 2, hit: 1 })
})

test("failures are not cached", async () => {
  const gate = new StampGate<number>({ maxBytes: 100 })
  await expect(
    gate.run("k", 1, () => {
      throw new Error("boom")
    }),
  ).rejects.toThrow("boom")
  expect(await gate.run("k", 1, () => 7)).toBe(7)
})

test("the byte budget evicts least recently used and keeps oversized results out", async () => {
  const gate = new StampGate<string>({ maxBytes: 30 })
  await gate.run("a", 1, () => "x".repeat(10)) // 12 bytes as JSON
  await gate.run("b", 1, () => "y".repeat(10))
  await gate.run("a", 1, () => "unused") // refresh a
  await gate.run("c", 1, () => "z".repeat(10)) // evicts b
  let reran = false
  await gate.run("b", 1, () => ((reran = true), "y".repeat(10)))
  expect(reran).toBe(true)
  expect(await gate.run("big", 1, () => "q".repeat(100))).toHaveLength(100)
  expect(gate.size).toBeLessThanOrEqual(30)
})

test("the observation revision stamp gates a database read", async () => {
  const db = new Database(":memory:")
  db.exec(
    "CREATE TABLE observation_revisions(project_directory TEXT PRIMARY KEY, revision INTEGER)",
  )
  db.run("INSERT INTO observation_revisions VALUES ('/p', 1)")
  const gate = new StampGate<number>({ maxBytes: 100 })
  let reads = 0
  const read = () => (reads++, 42)
  for (let i = 0; i < 5; i++) await gate.run("q", observationRevisionStamp(db, "/p"), read)
  expect(reads).toBe(1)
  db.run("UPDATE observation_revisions SET revision=2")
  await gate.run("q", observationRevisionStamp(db, "/p"), read)
  expect(reads).toBe(2)
  expect(observationRevisionStamp(new Database(":memory:"), "/p")).toBe(0)
})
