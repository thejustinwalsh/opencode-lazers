import { expect, test } from "bun:test"
import type { ExecutionList, ExecutionListRow, ExecutionPlanGroup } from "./execution-list.ts"
import {
  anchoredScrollTop,
  estimateItemSize,
  viewportAnchor,
  flattenExecutionList,
  navigationTarget,
  planHeaded,
  planOfTask,
  taskIndex,
  taskItems,
} from "./virtual-rows.ts"
import type { VirtualItem } from "./virtual-rows.ts"

const row = (taskID: string, fork?: ExecutionListRow["fork"]): ExecutionListRow => ({
  taskID,
  title: taskID,
  status: "queued",
  reason: null,
  waiting: false,
  holdReason: null,
  ordinal: 0,
  contextOnly: false,
  prerequisites: [],
  successors: [],
  ...(fork ? { fork } : {}),
})
const group = (
  planID: string,
  rows: ExecutionListRow[],
  extra: Partial<ExecutionPlanGroup> = {},
): ExecutionPlanGroup => ({
  planID,
  planVersion: 1,
  title: planID,
  hasRecordedTitle: true,
  nonterminalCount: rows.length,
  totalCount: rows.length,
  rows,
  ...extra,
})
const fork = (rootID: string, branches: Array<{ id: string; ids: string[]; hidden?: number }>) => ({
  id: `${rootID}:fork`,
  joinID: "join",
  branches: branches.map((branch) => ({
    id: branch.id,
    taskIDs: branch.ids,
    rows: branch.ids.map((id) => row(id)),
    hiddenCount: branch.hidden ?? 0,
  })),
})
const model = (plans: ExecutionPlanGroup[], unplanned: ExecutionListRow[] = []): ExecutionList => ({
  plans,
  unplanned,
  topologyAvailable: true,
})

const forked = () =>
  group("plan-a", [
    row(
      "root",
      fork("root", [
        { id: "a1", ids: ["a1", "a2"], hidden: 2 },
        { id: "b1", ids: ["b1"] },
      ]),
    ),
    row("join"),
  ])
const flatten = (
  list: ExecutionList,
  options: { collapsed?: string[]; expanded?: string[]; hasMore?: boolean } = {},
) =>
  flattenExecutionList({
    model: list,
    collapsedPlans: new Set(options.collapsed ?? []),
    forkExpanded: (_group, parent) => (options.expanded ?? []).includes(parent.taskID),
    hasMore: options.hasMore,
  })
const keys = (items: readonly VirtualItem[]) => items.map((item) => item.key)

test("a headed plan flattens to heading then rows; plain plans and unplanned rows have no heading", () => {
  const items = flatten(
    model(
      [
        group("headed", [row("t1"), row("t2")]),
        group("single", [row("s1")], { totalCount: 1 }),
        group("untitled", [row("u1"), row("u2")], { hasRecordedTitle: false }),
      ],
      [row("loose")],
    ),
  )
  expect(keys(items)).toEqual([
    "plan:headed",
    "task:t1",
    "task:t2",
    "task:s1",
    "task:u1",
    "task:u2",
    "task:loose",
  ])
  expect(planHeaded(group("single", [row("s1")], { totalCount: 1 }))).toBe(false)
  // Scheduler facts earn a heading even for one task.
  expect(planHeaded(group("gated", [row("g")], { totalCount: 1, priority: 2 }))).toBe(true)
  expect(planHeaded(group("after", [row("g")], { totalCount: 1, afterPlans: ["x"] }))).toBe(true)
})

test("a collapsed plan keeps its heading and omits every row, fork branches included", () => {
  const list = model([forked(), group("plan-b", [row("b-task"), row("c-task")])])
  const items = flatten(list, { collapsed: ["plan-a"], expanded: ["root"] })
  expect(keys(items)).toEqual(["plan:plan-a", "plan:plan-b", "task:b-task", "task:c-task"])
  expect(items[0]).toMatchObject({ kind: "plan", collapsed: true })
  expect(items[1]).toMatchObject({ kind: "plan", collapsed: false })
  // Collapse is ignored where there is no heading to expand it again.
  const plain = model([group("plain", [row("only")], { totalCount: 1 })])
  expect(keys(flatten(plain, { collapsed: ["plain"] }))).toEqual(["task:only"])
})

test("collapsed forks omit branch rows and notes; expanded forks add them with depth and rail data", () => {
  const list = model([forked()])
  expect(keys(flatten(list))).toEqual(["plan:plan-a", "task:root", "task:join"])
  const items = flatten(list, { expanded: ["root"] })
  expect(keys(items)).toEqual([
    "plan:plan-a",
    "task:root",
    "task:a1",
    "task:a2",
    "note:a1",
    "task:b1",
    "task:join",
  ])
  const tasks = Object.fromEntries(taskItems(items).map((item) => [item.row.taskID, item]))
  expect(tasks.root).toMatchObject({ depth: 0, level: 2, expandable: true, expanded: true })
  expect(tasks.join).toMatchObject({
    depth: 0,
    level: 2,
    expandable: false,
    setSize: 2,
    posInSet: 2,
  })
  // Branch rows are the fork root's children: one sibling set spanning both branches.
  expect(tasks.a1).toMatchObject({
    depth: 1,
    level: 3,
    setSize: 3,
    posInSet: 1,
    parentTaskID: "root",
  })
  expect(tasks.a2).toMatchObject({ depth: 1, setSize: 3, posInSet: 2, parentTaskID: "root" })
  expect(tasks.b1).toMatchObject({ depth: 1, setSize: 3, posInSet: 3, parentTaskID: "root" })
  expect(tasks.a1!.branch).toEqual({ branchID: "a1", first: true, last: false })
  // The rail continues through the hidden-count note, which closes branch a.
  expect(tasks.a2!.branch).toEqual({ branchID: "a1", first: false, last: false })
  expect(tasks.b1!.branch).toEqual({ branchID: "b1", first: true, last: true })
  expect(items.find((item) => item.kind === "note")).toMatchObject({
    hiddenCount: 2,
    depth: 1,
    branchID: "a1",
  })
})

test("tree levels: headings and unheaded rows are one top-level set; a heading's rows sit below it", () => {
  const items = flatten(
    model(
      [
        group("headed", [row("t1"), row("t2")]),
        group("single", [row("s1")], { totalCount: 1 }),
        group("other", [row("o1"), row("o2")]),
      ],
      [row("loose")],
    ),
    { collapsed: ["other"] },
  )
  const levels = items.map((item) =>
    item.kind === "plan"
      ? [item.key, 1, item.posInSet, item.setSize]
      : item.kind === "task"
        ? [item.key, item.level, item.posInSet, item.setSize]
        : [item.key],
  )
  expect(levels).toEqual([
    ["plan:headed", 1, 1, 4],
    ["task:t1", 2, 1, 2],
    ["task:t2", 2, 2, 2],
    ["task:s1", 1, 2, 4],
    ["plan:other", 1, 3, 4],
    ["task:loose", 1, 4, 4],
  ])
})

test("a loader item trails the list only while another page exists", () => {
  const list = model([group("p", [row("t1"), row("t2")])])
  expect(keys(flatten(list))).toEqual(["plan:p", "task:t1", "task:t2"])
  expect(keys(flatten(list, { hasMore: true }))).toEqual([
    "plan:p",
    "task:t1",
    "task:t2",
    "loader:more",
  ])
})

test("item keys are stable when later pages append rows", () => {
  const page1 = model([group("p", [row("t1"), row("t2")])], [row("u1")])
  const page2 = model([group("p", [row("t1"), row("t2"), row("t3")])], [row("u1"), row("u2")])
  const before = keys(flatten(page1, { hasMore: true }))
  const after = keys(flatten(page2))
  expect(before.filter((key) => key !== "loader:more")).toEqual(
    after.filter((key) => key !== "task:t3" && key !== "task:u2"),
  )
  // Existing rows keep their index; only the tail grows.
  expect(after.indexOf("task:t1")).toBe(before.indexOf("task:t1"))
  expect(after.indexOf("task:u1")).toBe(before.indexOf("task:u1") + 1)
})

test("keyboard navigation reads the model in visual order through headings and rows", () => {
  const items = flatten(model([forked(), group("plan-b", [row("x"), row("y")])]), {
    expanded: ["root"],
    hasMore: true,
  })
  const go = (key: string, direction: Parameters<typeof navigationTarget>[2]) =>
    navigationTarget(items, key, direction)?.key
  expect(go("task:root", "Home")).toBe("plan:plan-a")
  expect(go("task:root", "End")).toBe("task:y")
  expect(go("task:root", "ArrowDown")).toBe("task:a1")
  // Down from the last row of plan-a reaches plan-b's heading, then its first row.
  expect(go("task:join", "ArrowDown")).toBe("plan:plan-b")
  expect(go("plan:plan-b", "ArrowDown")).toBe("task:x")
  expect(go("task:x", "ArrowUp")).toBe("plan:plan-b")
  expect(go("task:y", "ArrowDown")).toBe("task:y")
  expect(go("task:root", "ArrowUp")).toBe("plan:plan-a")
  expect(go("plan:plan-a", "ArrowUp")).toBe("plan:plan-a")
  expect(go("task:root", "ArrowRight")).toBe("task:a1")
  expect(go("task:a2", "ArrowLeft")).toBe("task:root")
  // Left from a plan's row is its heading; Right from an expanded heading is its first row.
  expect(go("task:join", "ArrowLeft")).toBe("plan:plan-a")
  expect(go("plan:plan-b", "ArrowRight")).toBe("task:x")
  expect(go("plan:plan-b", "ArrowLeft")).toBeUndefined()
  expect(go("task:join", "ArrowRight")).toBeUndefined()
  // An item outside the sequence enters it at the first item.
  expect(go("task:gone", "ArrowDown")).toBe("plan:plan-a")
  const collapsed = flatten(model([forked(), group("plan-b", [row("x"), row("y")])]), {
    collapsed: ["plan-b"],
  })
  expect(navigationTarget(collapsed, "task:root", "ArrowRight")).toBeUndefined()
  expect(navigationTarget(collapsed, "plan:plan-b", "ArrowRight")).toBeUndefined()
  // Rows without a heading have no parent to go back to.
  const plain = flatten(model([], [row("loose")]))
  expect(navigationTarget(plain, "task:loose", "ArrowLeft")).toBeUndefined()
})

test("reveal targets: a task in a collapsed fork or plan gets an index once revealed", () => {
  const list = model([forked(), group("plan-b", [row("x"), row("y")])])
  // Hidden until revealed.
  const hidden = flatten(list, { collapsed: ["plan-a"] })
  expect(taskIndex(hidden, "a2")).toBe(-1)
  expect(planOfTask(list, "a2")).toBe("plan-a")
  expect(planOfTask(list, "join")).toBe("plan-a")
  expect(planOfTask(list, "y")).toBe("plan-b")
  expect(planOfTask(list, "nowhere")).toBeUndefined()
  // Un-collapse the plan only: the fork is still collapsed.
  const planOpen = flatten(list)
  expect(taskIndex(planOpen, "a2")).toBe(-1)
  expect(taskIndex(planOpen, "root")).toBe(1)
  // Expand the fork too: the flat index addresses the row among all items, headings included.
  const revealed = flatten(list, { expanded: ["root"] })
  expect(taskIndex(revealed, "a2")).toBe(3)
  expect(revealed[taskIndex(revealed, "a2")]!.key).toBe("task:a2")
  expect(taskIndex(revealed, "y")).toBe(revealed.length - 1)
})

test("scroll anchoring restores a moved first-visible item and ignores stable or removed ones", () => {
  const anchor = { key: "task:t5", offset: 12 }
  const starts = new Map([["task:t5", 200]])
  const at = (key: string) => starts.get(key)
  // A row inserted above moved the anchor from 150 to 200: scrollTop follows.
  expect(anchoredScrollTop({ key: "task:t5", offset: 12 }, at, 138)).toBe(188)
  // Unmoved: no write.
  expect(anchoredScrollTop(anchor, at, 188)).toBeUndefined()
  // Removed or never captured: no write.
  expect(anchoredScrollTop({ key: "task:gone", offset: 0 }, at, 50)).toBeUndefined()
  expect(anchoredScrollTop(undefined, at, 50)).toBeUndefined()
})

test("no anchor while the list top or the head above the tree is at the viewport top", () => {
  // The virtualizer reports the first tree row for any offset above the tree.
  const first = { key: "task:t1", start: 80 }
  expect(viewportAnchor(0, 80, first)).toBeUndefined()
  expect(viewportAnchor(40, 80, first)).toBeUndefined()
  expect(viewportAnchor(0, 0, { key: "task:t1", start: 0 })).toBeUndefined()
  // Inside the tree the first visible row anchors, measured from the tree's top.
  expect(viewportAnchor(100, 80, { key: "task:t2", start: 112 })).toEqual({
    key: "task:t2",
    offset: -68,
  })
  expect(viewportAnchor(100, 80, undefined)).toBeUndefined()
})

test("size estimates follow the compact row height and carry plan margins and reason lines", () => {
  const [plain, reasoned, tasks] = [
    group("p", [row("a")]),
    group("q", [row("a")], { schedulingReason: "Waiting" }),
    flatten(model([group("r", [row("a"), row("b")])]), { hasMore: true }),
  ]
  const heading = { kind: "plan", collapsed: false, setSize: 1, posInSet: 1 } as const
  expect(estimateItemSize({ ...heading, key: "p", group: plain! })).toBe(36)
  expect(estimateItemSize({ ...heading, key: "q", group: reasoned! })).toBe(56)
  expect((tasks as VirtualItem[]).map(estimateItemSize)).toEqual([36, 32, 32, 32])
})
