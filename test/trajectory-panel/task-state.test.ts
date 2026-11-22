import { expect, test } from "bun:test"
import { currentTaskState } from "../../src/trajectory-panel/projection.ts"
import { taskStatePresentation } from "../../src/trajectory-panel/state-presentation.ts"
import { choiceFromRow, integratedRow } from "../../src/trajectory-panel/rows.ts"
import { reportTaskView } from "../../src/trajectory-panel/attempt-state.ts"
import { assignedTaskView } from "../../src/radar/worker-hold.ts"
import { listRowOf } from "../../src/tasks/task-row.ts"
import { taskRowPresentation } from "../../src/tasks/row-presentation.ts"

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

test("an accepted task on an integrated plan is Integrated in Trajectory and Radar, as in Tasks", () => {
  // The stored schedule row of LZ-216: node accepted, plan integrated.
  const row = { task_id: "t", node_state: "accepted", plan_state: "integrated" }
  expect(integratedRow(row)).toBe(true)
  expect(choiceFromRow(row)).toMatchObject({ status: "accepted", integrated: true })
  expect(taskStatePresentation("accepted", true).label).toBe("Integrated")
  const report = {
    task: { id: "t", status: "submitted", recordedState: "accepted", integrated: true },
    plans: [{ id: "p", state: "integrated", checks: [] }],
    attempts: [],
  }
  expect(reportTaskView(report as never).label).toBe("Integrated")
  const tasks = listRowOf((column) => (row as Record<string, unknown>)[column] ?? null, "t")
  expect(taskRowPresentation(tasks).label).toBe("Integrated")
  expect(
    assignedTaskView(
      { assignment: { taskID: "t" } },
      { state: "accepted", reason: null, planState: "integrated", planReason: null },
    )?.label,
  ).toBe("Integrated")
  // Accepted on a plan not integrated yet stays Accepted.
  expect(integratedRow({ ...row, plan_state: "running" })).toBe(false)
  expect(taskStatePresentation("accepted").label).toBe("Accepted")
})
