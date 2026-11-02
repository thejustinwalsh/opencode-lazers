import { expect, test } from "bun:test"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { readSourceStamp } from "./changes.ts"
import { ensureObservationRevision } from "./source-revision.ts"

test("observation invalidation is transactional, project scoped, and ignores unchanged writes", () => {
  const fixture = makeFixture()
  const stamp = () =>
    readSourceStamp(fixture.repository.path, fixture.directory, new Uint8Array(32))
      .sourceFingerprint
  try {
    const initial = stamp()
    fixture.store.atomic((db) => db.exec("UPDATE runner_plans SET state=state"))
    expect(stamp()).toBe(initial)
    expect(() =>
      fixture.store.atomic((db) => {
        db.query("UPDATE runner_plans SET reason='rolled back' WHERE id=?").run(
          fixture.receipt.planID,
        )
        throw new Error("rollback")
      }),
    ).toThrow("rollback")
    expect(stamp()).toBe(initial)
    fixture.store.atomic((db) =>
      db
        .query("INSERT INTO task_changes(project_directory,kind) VALUES(?,?)")
        .run("/unrelated", "mutation"),
    )
    expect(stamp()).toBe(initial)
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_plans SET reason='changed' WHERE id=?").run(fixture.receipt.planID),
    )
    const updated = stamp()
    expect(updated).not.toBe(initial)
    fixture.store.atomic((db) => {
      db.query(
        "INSERT INTO runner_continuations(plan_id,session_id,directory,generation) VALUES(?,?,?,1)",
      ).run(fixture.receipt.planID, "ses-continuation", fixture.directory)
    })
    const inserted = stamp()
    expect(inserted).not.toBe(updated)
    fixture.store.atomic((db) =>
      db.query("DELETE FROM runner_continuations WHERE plan_id=?").run(fixture.receipt.planID),
    )
    expect(stamp()).not.toBe(inserted)
    const deleted = stamp()
    fixture.store.atomic(ensureObservationRevision)
    expect(stamp()).toBe(deleted)
  } finally {
    fixture.close()
  }
})
