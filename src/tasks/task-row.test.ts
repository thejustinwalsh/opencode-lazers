import { expect, test } from "bun:test"
import { taskRowPresentation } from "./row-presentation.ts"
import { childRowOf, listRowOf } from "./task-row.ts"
import { spliceItems } from "./virtual-rows.ts"

const base = {
  objective: "Do the thing",
  reference: "LZ-1",
  status: "queued",
  node_state: "queued",
  plan_state: "running",
  node_reason: null,
  plan_reason: null,
  reason: null,
  dispatch_pause: null,
  dependency_waiting: false,
  dependency_count: 0,
  decision: "eligible",
  decision_reason: null,
  wait_plan_ids: [],
  wait_plans_count: 0,
  blocker_task_ids: [],
  stale: false,
}
const row = (over: Record<string, unknown>) => {
  const merged = { ...base, ...over }
  return listRowOf((column) => merged[column as keyof typeof merged], "t1")
}

test("a held-back row follows the old waiting rule and presents as the old read did", () => {
  expect(row({}).waiting).toBe(false)
  expect(taskRowPresentation(row({})).label).toBe("Queued")
  // A reservation holds it: effective status is blocked, recorded state stays queued.
  const held = row({
    status: "blocked",
    reason: "Waiting for checkout or write scope: LZ-2",
    blocker_task_ids: ["t2"],
  })
  expect(held.status).toBe("queued")
  expect(held.waiting).toBe(true)
  const shown = taskRowPresentation(held)
  expect(shown.label).toBe("Waiting")
  expect(shown.blockers).toEqual([{ kind: "task", id: "t2" }])
  // An unmet dependency waits unless the plan is paused.
  expect(row({ dependency_waiting: true }).waiting).toBe(true)
  expect(
    row({ dependency_waiting: true, dispatch_pause: { reason: "hold", untilPlans: [] } }).waiting,
  ).toBe(false)
  expect(
    taskRowPresentation(row({ dispatch_pause: { reason: "hold", untilPlans: [] } })).label,
  ).toBe("Paused")
  // Finished and cancelled-with-plan rows never wait.
  expect(
    row({ node_state: "accepted", status: "accepted", dependency_waiting: true }).waiting,
  ).toBe(false)
  expect(row({ plan_state: "cancelled", status: "cancelled" }).waiting).toBe(false)
  // Prerequisite plans are blockers of kind plan; a stale row is marked.
  const plans = row({ wait_plan_ids: ["p9"], wait_plans_count: 1 })
  expect(taskRowPresentation(plans).blockers).toEqual([{ kind: "plan", id: "p9" }])
  expect(row({ stale: true }).stale).toBe(true)
})

test("a dependency child renders as its own row, or as the edge records it", () => {
  const edge = {
    child_task_id: "c1",
    child_title: "Child",
    child_reference: "LZ-3",
    child_state: "accepted",
  }
  const bare = childRowOf((column) => (edge as Record<string, unknown>)[column])
  expect(bare).toMatchObject({
    taskID: "c1",
    title: "Child",
    status: "accepted",
    reference: "LZ-3",
    contextOnly: true,
  })
  const own = {
    ...edge,
    c_status: "running",
    c_node_state: "running",
    c_plan_state: "running",
    c_objective: "x",
    c_decision: "not-applicable",
    c_dependency_count: 2,
  }
  const full = childRowOf((column) => (own as Record<string, unknown>)[column])
  expect(full).toMatchObject({
    taskID: "c1",
    status: "running",
    title: "Child",
    dependencyCount: 2,
    contextOnly: true,
  })
})

test("splice lists expanded children under their parent, cuts cycles and adds loaders", () => {
  const a = { ...row({ dependency_count: 1 }), taskID: "a" }
  const b = { ...row({ dependency_count: 1 }), taskID: "b" }
  const back = { ...row({ dependency_count: 1 }), taskID: "a", contextOnly: true }
  const items = spliceItems({
    rows: [{ row: a, priority: 1 }, { row: b }],
    expanded: new Set(["task:a", "task:a>b", "task:a>b>a"]),
    children: (key) => (key === "task:a" ? [b] : key === "task:a>b" ? [back] : undefined),
    loaders: { start: true, end: true },
  })
  expect(
    items.map((item) =>
      item.kind === "task" ? `${item.key}:${item.depth}:${item.expandable}` : item.key,
    ),
  ).toEqual([
    "loader:before",
    "task:a:0:true",
    "task:a>b:1:true",
    "task:a>b>a:2:false",
    "task:b:0:true",
    "loader:more",
  ])
  expect(items[1]).toMatchObject({ priority: 1, setSize: 2, posInSet: 1 })
})
