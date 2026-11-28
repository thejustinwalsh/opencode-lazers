import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanup, drive, fixture, runPlan, useRuntimeFixtureCleanup } from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

function consume(f: ReturnType<typeof fixture>, sessionID = "owner") {
  const owner = f.sessions.get(sessionID)!
  for (const entry of f.inbox.get(sessionID) ?? [])
    owner.messages.push({
      id: entry.id,
      type: "synthetic",
      text: "Runtime review",
      metadata: entry.metadata,
    })
  f.inbox.set(sessionID, [])
  owner.busy = false
}

test("a delivered combined-check failure wakes Architect again until the setup is repaired", async () => {
  let now = Date.now()
  const setup = mkdtempSync(join(tmpdir(), "lazers-follow-through-"))
  cleanup.push(() => rmSync(setup, { recursive: true, force: true }))
  const ready = join(setup, "ready")
  const f = fixture({
    shared: true,
    commit: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
    combinedCheckCommand: `test -f '${ready}'`,
  })
  const reviews = () => f.notifications.filter((n) => n.text.includes('"status":"queue-review"'))
  await runPlan(f)
  await drive(f.runtime, 14)
  expect(f.store.plan(f.receipt.planID)?.reason).toBe("Combined artifact verification failed")
  expect(f.store.nodes(f.receipt.planID).every((n) => n.state === "accepted")).toBe(true)
  const attempts = f.store.attempts(f.receipt.planID).map((a) => a.id)
  consume(f)
  const before = reviews().length
  now += 5 * 60_000
  await f.runtime.tick()
  expect(reviews()).toHaveLength(before + 1)
  expect(reviews().at(-1)).toMatchObject({ sessionID: "owner", resume: true })
  expect(reviews().at(-1)?.text).toContain(f.receipt.planID)
  expect(reviews().at(-1)?.text).toContain('"state":"blocked"')
  await f.runtime.tick()
  expect(reviews()).toHaveLength(before + 1)
  consume(f)
  now += 5 * 60_000
  f.sessions.get("owner")!.pendingForms = 1
  await f.runtime.tick()
  expect(reviews()).toHaveLength(before + 1)
  f.sessions.get("owner")!.pendingForms = 0
  writeFileSync(ready, "built")
  await f.runtime.command(
    {
      requestID: "repair-combined-setup",
      planID: f.receipt.planID,
      action: "resume",
      reason: "Required build input now exists",
    },
    "owner",
  )
  await drive(f.runtime, 12)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID).map((a) => a.id)).toEqual(attempts)
})

test("an idle Architect reviews accepted work while an unrelated worker remains busy", async () => {
  let now = Date.now()
  const f = fixture({
    delayed: true,
    independent: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  await f.runtime.tick()
  const worker = f.store.attempts(f.receipt.planID)[0]!
  expect(f.sessions.get(worker.session_id)?.busy).toBe(true)
  const task = f.createTask("b", "b.txt")
  const plan = f.store.submit(f.inputFor([task], { requestID: "accepted-review" }), "owner")
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_plans SET state='accepted',artifact=? WHERE id=?")
      .run(worker.base_commit, plan.planID),
  )
  await f.runtime.tick()
  consume(f)
  const before = f.notifications.filter((n) => n.text.includes('"status":"queue-review"')).length
  now += 5 * 60_000
  await f.runtime.tick()
  const reviews = f.notifications.filter((n) => n.text.includes('"status":"queue-review"'))
  expect(reviews).toHaveLength(before + 1)
  expect(reviews.at(-1)?.text).toContain(plan.planID)
  expect(f.sessions.get(worker.session_id)?.busy).toBe(true)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})
