import { expect, test } from "bun:test"
import { makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import { getTaskDetail } from "../tasks/stream-query.ts"

test("associated task reads resolve references for session gets", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.updatePlanOwner(fixture.receipt.planID, "ses-owner", "ses-reviewer")
    for (const sessionID of ["ses-owner", "ses-reviewer", "ses-failed", "ses-accepted"]) {
      expect(
        await getTaskDetail(fixture.repository, { taskID: "LZ-1", session: sessionID }),
      ).toMatchObject({
        status: "found",
        reference: "LZ-1",
        task: { id: taskID },
      })
    }
    expect(
      await getTaskDetail(fixture.repository, { taskID: "LZ-1", session: "ses-unrelated" }),
    ).toEqual({
      status: "not_found",
    })
  } finally {
    fixture.close()
  }
})
