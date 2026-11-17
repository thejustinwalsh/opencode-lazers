import { expect, test } from "bun:test"
import type { ExecutionListRow } from "./execution-list.ts"
import {
  isRingGlyph,
  planStateLabel,
  rowBlockers,
  rowHoldReasons,
  taskRowPresentation,
  taskRowBlocker,
  taskStateTooltip,
} from "./row-presentation.ts"

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

const quiet = { blockers: [], blockerTotal: 0 }

test("scheduled work stays quiet while running, ready and submitted work is named", () => {
  expect(taskRowPresentation(row())).toEqual({
    tone: "scheduled",
    icon: "ring",
    label: "Queued",
    detail: null,
    ...quiet,
  })
  expect(taskRowPresentation(row({ status: "running" }))).toMatchObject({
    tone: "running",
    icon: "ring-progress",
    label: "Running",
  })
  expect(taskRowPresentation(row({ status: "verifying" })).label).toBe("Verifying")
  expect(taskRowPresentation(row({ status: "ready" }))).toMatchObject({
    tone: "ready",
    label: "Ready",
  })
  expect(taskRowPresentation(row({ status: "submitted" })).label).toBe("Proposed")
})

test("native attention outranks holds and running state", () => {
  const held = row({ status: "running", waiting: true, holdReason: "Reconciliation hold" })
  expect(
    taskRowPresentation(held, activity({ pendingInput: true, pendingPermissions: 1 })),
  ).toEqual({
    tone: "attention",
    icon: "circle-exclamation",
    label: "Input",
    detail: "Input pending · Approval pending",
    ...quiet,
  })
  expect(taskRowPresentation(held, activity({ pendingForms: 2 })).label).toBe("Approval")
  // A finished task never asks for attention, whatever a stale observation says.
  expect(
    taskRowPresentation(row({ status: "accepted" }), activity({ pendingInput: true })).tone,
  ).toBe("accepted")
})

test("waiting rows keep a short state; reasons move to the detail, blockers stay typed", () => {
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
    icon: "ring-clock",
    label: "Waiting",
    detail: "Waiting on LZ-8 (queued), LZ-9 (running)",
    blockers: [
      { kind: "task", id: "a" },
      { kind: "task", id: "b" },
    ],
    blockerTotal: 2,
  })

  // A long machine reason never becomes the label; it is the detail behind it.
  const machineReason =
    "Waiting for prerequisite source integration in the selected source revision before dispatch."
  const holds = taskRowPresentation(
    row({ status: "running", waiting: true, holdReason: "Plan hold" }),
    activity({ waiting: true, holdReason: machineReason }),
  )
  expect(holds.label).toBe("Waiting")
  expect(holds.detail).toBe(`Plan hold; ${machineReason}`)
  expect(taskRowPresentation(row({ status: "blocked", reason: machineReason }))).toMatchObject({
    label: "Blocked",
    detail: machineReason,
  })
  expect(
    rowHoldReasons(
      row({ waiting: true, holdReason: "Same" }),
      activity({ waiting: true, holdReason: "Same" }),
    ),
  ).toEqual(["Same"])
})

test("scheduling waits link prerequisites, plans and every reservation holder", () => {
  const scheduled = row({
    scheduling: {
      decision: "waiting",
      reason: "Waiting for prerequisite source integration.",
      waitingOn: ["a"],
      waitingOnPlans: ["plan-1"],
      reservationTaskIDs: ["r1", "a", "r2"],
      reservationTaskCount: 5,
      reservationTaskIDsComplete: false,
    },
  })
  const presentation = taskRowPresentation(scheduled)
  expect(presentation).toMatchObject({
    tone: "waiting",
    label: "Waiting",
    detail: "Waiting for prerequisite source integration.",
  })
  expect(presentation.blockers).toEqual([
    { kind: "task", id: "a" },
    { kind: "task", id: "r1" },
    { kind: "task", id: "r2" },
    { kind: "plan", id: "plan-1" },
  ])
  // Five reservation holders are known but three enumerated: two more count without a link.
  expect(presentation.blockerTotal).toBe(6)
  expect(rowBlockers(row()).blockerTotal).toBe(0)
})

test("a dispatch pause applies only to work that has not started and outranks waiting", () => {
  const dispatchPause = { reason: "Paused until LZ-4 integrates", untilPlans: [] }
  expect(taskRowPresentation(row({ dispatchPause }))).toEqual({
    tone: "paused",
    icon: "ring-pause",
    label: "Paused",
    detail: "Paused until LZ-4 integrates",
    ...quiet,
  })
  expect(
    taskRowPresentation(
      row({
        dispatchPause,
        scheduling: { decision: "waiting", reason: "x", waitingOn: ["a"], reservationTaskIDs: [] },
      }),
    ),
  ).toMatchObject({ label: "Paused", blockers: [{ kind: "task", id: "a" }] })
  expect(taskRowPresentation(row({ status: "running", dispatchPause })).tone).toBe("running")
})

test("acceptance, integration, failure and cancellation stay distinct", () => {
  expect(taskRowPresentation(row({ status: "accepted" }))).toMatchObject({
    tone: "accepted",
    icon: "circle-check",
    label: "Accepted",
  })
  expect(taskRowPresentation(row({ status: "incorporated" }))).toMatchObject({
    tone: "integrated",
    icon: "circle-check",
    label: "Integrated",
  })
  expect(taskRowPresentation(row({ status: "failed", reason: "Check failed" }))).toMatchObject({
    tone: "failed",
    label: "Failed",
    detail: "Check failed",
  })
  expect(taskRowPresentation(row({ status: "exhausted" })).label).toBe("Exhausted")
  expect(taskRowPresentation(row({ status: "cancelled" }))).toMatchObject({
    tone: "cancelled",
    label: "Cancelled",
  })
  // Terminal work is never shown as waiting or blocked, even inside a held plan.
  expect(
    taskRowPresentation(
      row({
        status: "accepted",
        waiting: true,
        scheduling: { decision: "waiting", reason: null, waitingOn: ["a"], reservationTaskIDs: [] },
      }),
    ),
  ).toMatchObject({ tone: "accepted", blockers: [] })
})

test("every row state is one short word, the state icon's accessible name", () => {
  const rows = [
    row(),
    ...[
      "submitted",
      "ready",
      "running",
      "verifying",
      "blocked",
      "accepted",
      "incorporated",
      "failed",
      "exhausted",
      "cancelled",
      "mystery-state",
    ].map((status) => row({ status: status as ExecutionListRow["status"] })),
    row({ waiting: true, holdReason: "A long recorded hold reason that stays out of the row" }),
    row({ dispatchPause: { reason: "Paused until LZ-4 integrates", untilPlans: [] } }),
  ]
  const presentations = [
    ...rows.map((value) => taskRowPresentation(value)),
    taskRowPresentation(row({ status: "running" }), activity({ pendingInput: true })),
    taskRowPresentation(row({ status: "running" }), activity({ pendingPermissions: 1 })),
  ]
  for (const presentation of presentations) {
    expect(presentation.label).toMatch(/^[A-Z][a-z]{1,9}$/u)
    expect(presentation).not.toHaveProperty("badge")
  }
  expect(taskRowPresentation(row({ status: "mystery-state" as never })).label).toBe("Mystery")
})

test("a row links its first blocker unless native attention outranks the wait", () => {
  const scheduling = {
    decision: "waiting" as const,
    reason: "Waiting for prerequisite source integration.",
    waitingOn: ["a"],
    reservationTaskIDs: [],
  }
  const waiting = taskRowPresentation(row({ scheduling }))
  // The scheduler's recorded decision still sets the tone; the icon names it, the reason follows.
  expect(waiting).toMatchObject({ tone: "waiting", label: "Waiting" })
  expect(taskRowBlocker(waiting)).toEqual({ kind: "task", id: "a" })
  expect(taskStateTooltip(waiting)).toBe("Waiting · Waiting for prerequisite source integration.")
  const asking = taskRowPresentation(row({ scheduling }), activity({ pendingInput: true }))
  expect(asking.blockers).toHaveLength(1)
  expect(taskRowBlocker(asking)).toBeUndefined()
  expect(taskRowBlocker(taskRowPresentation(row({ status: "running" })))).toBeUndefined()
  expect(taskStateTooltip(taskRowPresentation(row()))).toBe("Queued")
})

test("plan headings name integration and cleanup, not ordinary progress", () => {
  expect(planStateLabel("running")).toBeNull()
  expect(planStateLabel(undefined)).toBeNull()
  expect(planStateLabel("accepted")).toBe("Awaiting integration")
  expect(planStateLabel("cleaning")).toBe("Cleaning up")
  expect(planStateLabel("cleanup-blocked")).toBe("Cleanup blocked")
  expect(planStateLabel("integrated")).toBe("Integrated")
})

test("every state glyph is a circled mark: host circle icons or Tasks rings, never panel glyphs", () => {
  const glyph = (change: Partial<ExecutionListRow>) => taskRowPresentation(row(change)).icon
  expect(glyph({ status: "queued" })).toBe("ring")
  expect(glyph({ status: "ready" })).toBe("ring-dot")
  expect(glyph({ status: "running" })).toBe("ring-progress")
  expect(glyph({ status: "verifying" })).toBe("ring-progress")
  expect(glyph({ status: "submitted" })).toBe("ring-dashed")
  expect(glyph({ status: "cancelled" })).toBe("ring-minus")
  expect(glyph({ dispatchPause: { reason: "Held", untilPlans: [] } })).toBe("ring-pause")
  expect(glyph({ status: "incorporated" })).toBe("circle-check")
  expect(glyph({ status: "failed" })).toBe("circle-x")
  expect(glyph({ waiting: true })).toBe("ring-clock")
  expect(glyph({ status: "blocked" })).toBe("circle-ban-sign")
  const statuses = ["queued", "ready", "running", "submitted", "accepted", "failed", "x-unknown"]
  for (const status of statuses) {
    const icon = glyph({ status: status as ExecutionListRow["status"] })
    expect(isRingGlyph(icon) || icon.startsWith("circle-")).toBe(true)
  }
  expect(isRingGlyph("circle-check")).toBe(false)
  expect(isRingGlyph("ring-dot")).toBe(true)
})
