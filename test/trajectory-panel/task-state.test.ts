import { expect, test } from "bun:test"
import { currentTaskState } from "../../src/trajectory-panel/projection.ts"
import { taskStatePresentation } from "../../src/trajectory-panel/state-presentation.ts"

test("the head shows the node's current recorded state, not the proposal's own status", () => {
  const report = { task: { status: "submitted", recordedState: "accepted" } }
  // The proposal-level status stays where it was submitted; the node was accepted.
  expect(currentTaskState(report as never)).toBe("accepted")
  const state = taskStatePresentation(currentTaskState(report as never))
  expect([state.label, state.tone, state.glyph]).toEqual(["Accepted", "accepted", "ring-check"])
  // What the old head showed.
  expect(taskStatePresentation(report.task.status).label).toBe("Proposed")
  // A row without the node's state: the proposal status is all there is.
  expect(currentTaskState({ task: { status: "submitted" } } as never)).toBe("submitted")
})
