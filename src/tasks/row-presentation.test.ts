import { expect, test } from "bun:test"
import type { ExecutionListRow } from "./execution-list.ts"
import { planStateLabel, rowHoldReasons, taskRowPresentation } from "./row-presentation.ts"

const row = (change: Partial<ExecutionListRow> = {}): ExecutionListRow => ({
  taskID: "11111111-1111-4111-8111-111111111111",
  title: "Persist submission identity",
  status: "queued",
  reason: null,
  waiting: false,
  holdReason: null,
  ordinal: 0,
  contextOnly: false,
  prerequisites: [],
  successors: [],
  ...change,
})

const activity = (change: Record<string, unknown> = {}) => ({
  waiting: false,
  holdReason: null,
  pendingInput: false,
  pendingPermissions: 0,
  pendingForms: 0,
  ...change,
})

test("scheduled work stays quiet while running, ready and submitted work is named", () => {
  expect(taskRowPresentation(row())).toEqual({
    tone: "scheduled",
    icon: "status",
    badge: null,
    badgeDetail: null,
  })
  expect(taskRowPresentation(row({ status: "running" }))).toMatchObject({
    tone: "running",
    icon: "status-active",
    badge: "Running",
  })
  expect(taskRowPresentation(row({ status: "verifying" })).badge).toBe("Verifying")
  expect(taskRowPresentation(row({ status: "ready" }))).toMatchObject({
    tone: "ready",
    badge: "Ready",
  })
  expect(taskRowPresentation(row({ status: "submitted" })).badge).toBe("Not started")
})

test("native attention outranks holds and running state", () => {
  const held = row({ status: "running", waiting: true, holdReason: "Reconciliation hold" })
  expect(
    taskRowPresentation(held, activity({ pendingInput: true, pendingPermissions: 1 })),
  ).toEqual({
    tone: "attention",
    icon: "circle-exclamation",
    badge: "Needs input",
    badgeDetail: "Input pending · Approval pending",
  })
  expect(taskRowPresentation(held, activity({ pendingForms: 2 })).badge).toBe("Needs approval")
  // A finished task never asks for attention, whatever a stale observation says.
  expect(
    taskRowPresentation(row({ status: "accepted" }), activity({ pendingInput: true })).tone,
  ).toBe("accepted")
})

test("waiting rows name the pending prerequisite, else the first recorded hold line", () => {
  const dependencies = [
    { taskID: "a", reference: "LZ-8", title: "First", state: "queued", waiting: true },
    { taskID: "b", title: "Second", state: "running", waiting: true },
    { taskID: "c", reference: "LZ-2", title: "Done", state: "accepted", waiting: false },
  ]
  expect(
    taskRowPresentation(row({ waiting: true, dependencyTasks: dependencies }), undefined, (id) =>
      id === "b" ? "LZ-9" : id,
    ),
  ).toEqual({
    tone: "waiting",
    icon: "circle-ban-sign",
    badge: "Waiting on LZ-8 +1",
    badgeDetail: "Waiting on LZ-8 (queued), LZ-9 (running)",
  })

  const holds = taskRowPresentation(
    row({ status: "running", waiting: true, holdReason: "Plan hold" }),
    activity({ waiting: true, holdReason: "Worker hold: review.\nAdditional hold: audit." }),
  )
  expect(holds.badge).toBe("Plan hold")
  expect(holds.badgeDetail).toBe("Plan hold; Worker hold: review.\nAdditional hold: audit.")
  expect(taskRowPresentation(row({ waiting: true })).badge).toBe("Blocked")
  expect(
    rowHoldReasons(
      row({ waiting: true, holdReason: "Same" }),
      activity({ waiting: true, holdReason: "Same" }),
    ),
  ).toEqual(["Same"])
})

test("a dispatch pause applies only to work that has not started", () => {
  const dispatchPause = { reason: "Paused until LZ-4 integrates", untilPlans: [] }
  expect(taskRowPresentation(row({ dispatchPause }))).toEqual({
    tone: "paused",
    icon: "stop",
    badge: "Paused",
    badgeDetail: "Paused until LZ-4 integrates",
  })
  expect(taskRowPresentation(row({ status: "running", dispatchPause })).tone).toBe("running")
})

test("acceptance, integration, failure and cancellation stay distinct", () => {
  expect(taskRowPresentation(row({ status: "accepted" }))).toMatchObject({
    icon: "check",
    badge: "Accepted",
  })
  expect(taskRowPresentation(row({ status: "incorporated" }))).toMatchObject({
    tone: "integrated",
    icon: "circle-check",
    badge: null,
  })
  expect(taskRowPresentation(row({ status: "failed", reason: "Check failed" }))).toMatchObject({
    tone: "failed",
    badge: "Failed",
    badgeDetail: "Check failed",
  })
  expect(taskRowPresentation(row({ status: "exhausted" })).badge).toBe("Exhausted")
  expect(taskRowPresentation(row({ status: "cancelled" }))).toMatchObject({
    tone: "cancelled",
    badge: null,
  })
  // Terminal work is never shown as waiting, even inside a held plan.
  expect(taskRowPresentation(row({ status: "accepted", waiting: true })).tone).toBe("accepted")
})

test("plan headings name integration and cleanup, not ordinary progress", () => {
  expect(planStateLabel("running")).toBeNull()
  expect(planStateLabel("accepted")).toBe("Awaiting integration")
  expect(planStateLabel("cleaning")).toBe("Cleaning up")
  expect(planStateLabel("cleanup-blocked")).toBe("Cleanup blocked")
  expect(planStateLabel("integrated")).toBe("Integrated")
})
