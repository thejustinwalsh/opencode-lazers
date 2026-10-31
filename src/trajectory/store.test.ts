import { expect, test } from "bun:test"
import { openReadOnlyTrajectoryStore } from "./store.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"

test("trajectory store opens the project database read-only and rejects SQL mutations", () => {
  const fixture = makeFixture()
  const reader = openReadOnlyTrajectoryStore(
    fixture.repository.path,
    fixture.repository.projectDirectory,
  )
  try {
    const before = fixture.repository.atomic((db) => ({
      tasks: db.query<{ count: number }, []>("SELECT count(*) AS count FROM tasks").get()!.count,
      attempts: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_attempts")
        .get()!.count,
    }))
    expect(() => reader.store.atomic((db) => db.exec("DELETE FROM runner_attempts"))).toThrow()
    expect(() =>
      reader.store.atomic((db) => db.exec("CREATE TABLE forbidden_write(id INTEGER)")),
    ).toThrow()
    expect(reader.store.repository.get(fixture.task.id)).toEqual(fixture.task)

    const after = fixture.repository.atomic((db) => ({
      tasks: db.query<{ count: number }, []>("SELECT count(*) AS count FROM tasks").get()!.count,
      attempts: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_attempts")
        .get()!.count,
    }))
    expect(after).toEqual(before)
  } finally {
    reader.close()
    fixture.close()
  }
})
