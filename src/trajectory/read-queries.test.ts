import { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { inspectTrajectory } from "./read.ts"
import { InspectTrajectoryInput } from "./schema.ts"
import { makeFixture, cursorSecret, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"

const parse = (input: unknown) => InspectTrajectoryInput.parse(input)

async function queriesFor(input: Record<string, unknown>, extraPlans: number) {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) => {
      const source = db
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM runner_plans WHERE project_directory=?",
        )
        .get(fixture.directory)!
      const insert = db.query(
        "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES(?,?,?,1,1,'accepted',?)",
      )
      for (let i = 0; i < extraPlans; i++)
        insert.run(crypto.randomUUID(), fixture.directory, "ses-other", String(source.body))
    })
    const spy = spyOn(Database.prototype, "query")
    try {
      await inspectTrajectory(fixture.store, fixture.host, "project", parse(input), cursorSecret)
      return spy.mock.calls.map(([sql]) => String(sql))
    } finally {
      spy.mockRestore()
    }
  } finally {
    fixture.close()
  }
}

test("snapshot reads do not grow with the number of unrelated project plans", async () => {
  const few = await queriesFor({ taskID }, 1)
  const many = await queriesFor({ taskID }, 40)
  expect(many.length).toBe(few.length)
  expect(
    many.some((sql) => /SELECT \* FROM runner_nodes WHERE plan_id=\? ORDER BY ordinal/.test(sql)),
  ).toBe(false)
})

test("resolving a task by attempt is one lookup, not a scan of every plan's attempts", async () => {
  const few = await queriesFor({ attemptID: firstAttemptID }, 1)
  const many = await queriesFor({ attemptID: firstAttemptID }, 40)
  expect(many.length).toBe(few.length)
  expect(
    many.filter((sql) => /SELECT \* FROM runner_attempts WHERE plan_id=\? ORDER BY/.test(sql)),
  ).toEqual([])
})
