import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { ObservationReads } from "./read.ts"
import { ObservationChangeTracker } from "./changes.ts"

function sqlDuring(action: () => void) {
  const queries = spyOn(Database.prototype, "query")
  try {
    action()
    return queries.mock.calls.map(([query]) => String(query))
  } finally {
    queries.mockRestore()
  }
}
