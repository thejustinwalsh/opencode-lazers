import { expect, test } from "bun:test"
import type { ExecutionList, ExecutionListRow, ExecutionPlanGroup } from "./execution-list.ts"
import {
  anchoredScrollTop,
  estimateItemSize,
  flattenExecutionList,
  navigationTarget,
  taskIndex,
  taskItems,
  viewportAnchor,
} from "./virtual-rows.ts"
import type { VirtualItem } from "./virtual-rows.ts"

const row = (taskID: string, prerequisites: string[] = []): ExecutionListRow => ({
  taskID,
  title: taskID,
  status: "queued",
  reason: null,
  waiting: false,
  holdReason: null,
  ordinal: 0,
  contextOnly: false,
  prerequisites,
  successors: [],
})
const group = (planID: string, rows: ExecutionListRow[]): ExecutionPlanGroup => ({
  planID,
  planVersion: 1,
  title: planID,
  hasRecordedTitle: true,
  nonterminalCount: rows.length,
  totalCount: rows.length,
  rows,
})
const model = (
  plans: ExecutionPlanGroup[],
  unplanned: ExecutionListRow[] = [],
  related: ExecutionListRow[] = [],
): ExecutionList => ({ plans, unplanned, related, topologyAvailable: true })
const flatten = (list: ExecutionList, options: { expanded?: string[]; hasMore?: boolean } = {}) =>
  flattenExecutionList({
    model: list,
    expanded: new Set(options.expanded ?? []),
    hasMore: options.hasMore,
  })
const keys = (items: readonly VirtualItem[]) => items.map((item) => item.key)

test("every task is one flat row: no plan headings, plans and unplanned tasks interleave in model order", () => {
  const list = model([group("p", [row("t1"), row("t2")]), group("q", [row("t3")])], [row("u1")])
  const items = flatten(list)
  expect(keys(items)).toEqual(["task:t1", "task:t2", "task:t3", "task:u1"])
  expect(taskItems(items).map((item) => [item.level, item.setSize, item.posInSet])).toEqual([
    [1, 4, 1],
    [1, 4, 2],
    [1, 4, 3],
    [1, 4, 4],
  ])
  expect(taskItems(items).some((item) => item.expandable)).toBe(false)
})

test("a task with dependencies is a collapsed accordion by default", () => {
  const list = model([group("p", [row("a"), row("b", ["a"])])])
  const items = flatten(list)
  expect(keys(items)).toEqual(["task:a", "task:b"])
  expect(taskItems(items).map((item) => [item.expandable, item.expanded])).toEqual([
    [false, false],
    [true, false],
  ])
})

test("expanding lists the dependency tree as nested rows, duplicated across expanded trees", () => {
  // c depends on b, b depends on a; d also depends on b: b's subtree repeats under d.
  const list = model([group("p", [row("a"), row("b", ["a"]), row("c", ["b"]), row("d", ["b"])])])
  const items = flatten(list, {
    expanded: ["task:c", "task:c>b", "task:d", "task:d>b"],
  })
  expect(keys(items)).toEqual([
    "task:a",
    "task:b",
    "task:c",
    "task:c>b",
    "task:c>b>a",
    "task:d",
    "task:d>b",
    "task:d>b>a",
  ])
  const nested = taskItems(items).filter((item) => item.key === "task:c>b>a")[0]!
  expect(nested).toMatchObject({ depth: 2, level: 3, parentKey: "task:c>b", setSize: 1 })
  // Collapsing a parent hides its whole subtree but keeps sibling expansion.
  expect(keys(flatten(list, { expanded: ["task:c>b", "task:d", "task:d>b"] }))).toEqual([
    "task:a",
    "task:b",
    "task:c",
    "task:d",
    "task:d>b",
    "task:d>b>a",
  ])
})

test("dependency cycles are listed once and never expand again", () => {
  const list = model([group("p", [row("a", ["b"]), row("b", ["a"]), row("s", ["s"])])])
  const items = flatten(list, { expanded: ["task:a", "task:a>b", "task:a>b>a", "task:s"] })
  expect(keys(items)).toEqual(["task:a", "task:a>b", "task:a>b>a", "task:b", "task:s", "task:s>s"])
  const cyclic = taskItems(items).find((item) => item.key === "task:a>b>a")!
  expect(cyclic).toMatchObject({ expandable: false, expanded: false })
})

test("dependencies outside the list resolve from related rows, else from the reference alone", () => {
  const external = {
    ...row("far"),
    contextOnly: true,
    title: "Far away",
    prerequisites: ["deeper"],
  }
  const list = model([group("p", [row("a", ["far", "ghost"])])], [], [external])
  const items = flatten(list, { expanded: ["task:a", "task:a>far"] })
  expect(keys(items)).toEqual(["task:a", "task:a>far", "task:a>far>deeper", "task:a>ghost"])
  const ghost = taskItems(items).find((item) => item.key === "task:a>ghost")!
  expect(ghost.row).toMatchObject({ contextOnly: true, title: "Task ghost" })
  expect(ghost.expandable).toBe(false)
})

test("a loader item trails the list only while another page exists", () => {
  const list = model([group("p", [row("t1"), row("t2")])])
  expect(keys(flatten(list))).toEqual(["task:t1", "task:t2"])
  expect(keys(flatten(list, { hasMore: true }))).toEqual(["task:t1", "task:t2", "loader:more"])
})

test("item keys are stable when later pages append rows", () => {
  const page1 = model([group("p", [row("t1"), row("t2")])], [row("u1")])
  const page2 = model([group("p", [row("t1"), row("t2"), row("t3")])], [row("u1"), row("u2")])
  const before = keys(flatten(page1, { hasMore: true }))
  const after = keys(flatten(page2))
  expect(before.filter((key) => key !== "loader:more")).toEqual(
    after.filter((key) => key !== "task:t3" && key !== "task:u2"),
  )
  expect(after.indexOf("task:t1")).toBe(before.indexOf("task:t1"))
  expect(after.indexOf("task:u1")).toBe(before.indexOf("task:u1") + 1)
})

test("keyboard navigation reads the model in visual order and moves through the dependency tree", () => {
  const list = model([group("p", [row("a"), row("b", ["a"]), row("c")])])
  const items = flatten(list, { expanded: ["task:b"] })
  expect(keys(items)).toEqual(["task:a", "task:b", "task:b>a", "task:c"])
  const go = (key: string, direction: Parameters<typeof navigationTarget>[2]) =>
    navigationTarget(items, key, direction)?.key
  expect(go("task:a", "ArrowDown")).toBe("task:b")
  expect(go("task:b", "ArrowDown")).toBe("task:b>a")
  expect(go("task:b>a", "ArrowDown")).toBe("task:c")
  expect(go("task:c", "ArrowDown")).toBe("task:c")
  expect(go("task:a", "ArrowUp")).toBe("task:a")
  expect(go("task:c", "Home")).toBe("task:a")
  expect(go("task:a", "End")).toBe("task:c")
  // Right enters an expanded row's first dependency; Left returns to its parent.
  expect(go("task:b", "ArrowRight")).toBe("task:b>a")
  expect(go("task:b>a", "ArrowLeft")).toBe("task:b")
  expect(go("task:a", "ArrowRight")).toBeUndefined()
  expect(go("task:a", "ArrowLeft")).toBeUndefined()
  // A collapsed accordion has nothing to enter: the caller expands it first.
  expect(navigationTarget(flatten(list), "task:b", "ArrowRight")).toBeUndefined()
  // Unknown keys fall back to the first row.
  expect(go("task:missing", "ArrowDown")).toBe("task:a")
})

test("a task's index prefers its listed row over a repeat inside an expanded tree", () => {
  const list = model([group("p", [row("x", ["a"]), row("a")])])
  const items = flatten(list, { expanded: ["task:x"] })
  expect(keys(items)).toEqual(["task:x", "task:x>a", "task:a"])
  expect(taskIndex(items, "a")).toBe(2)
  expect(taskIndex(items, "x")).toBe(0)
  expect(taskIndex(items, "missing")).toBe(-1)
})

test("scroll anchoring restores a moved first-visible item and ignores stable or removed ones", () => {
  const anchor = { key: "task:t5", offset: 12 }
  const starts = new Map([["task:t5", 200]])
  const at = (key: string) => starts.get(key)
  expect(anchoredScrollTop({ key: "task:t5", offset: 12 }, at, 138)).toBe(188)
  expect(anchoredScrollTop(anchor, at, 188)).toBeUndefined()
  expect(anchoredScrollTop({ key: "task:gone", offset: 0 }, at, 50)).toBeUndefined()
  expect(anchoredScrollTop(undefined, at, 50)).toBeUndefined()
})

test("no anchor while the list top or the notes above the tree are at the viewport top", () => {
  const first = { key: "task:t1", start: 80 }
  expect(viewportAnchor(0, 80, first)).toBeUndefined()
  expect(viewportAnchor(40, 80, first)).toBeUndefined()
  expect(viewportAnchor(0, 0, { key: "task:t1", start: 0 })).toBeUndefined()
  expect(viewportAnchor(100, 80, { key: "task:t2", start: 112 })).toEqual({
    key: "task:t2",
    offset: -68,
  })
  expect(viewportAnchor(100, 80, undefined)).toBeUndefined()
})

test("size estimates follow the compact row height", () => {
  const items = flatten(model([group("r", [row("a"), row("b")])]), { hasMore: true })
  expect(items.map(estimateItemSize)).toEqual([32, 32, 32])
})

test("top-level rows follow the read's order, not the plan grouping; unlisted rows come last", () => {
  const list = model(
    [{ ...group("p1", [row("a"), row("b")]), priority: 1 }, group("p2", [row("c")])],
    [row("u")],
  )
  const items = flattenExecutionList({
    model: list,
    expanded: new Set(),
    order: ["c", "u", "b"],
  })
  expect(taskItems(items).map((item) => item.row.taskID)).toEqual(["c", "u", "b", "a"])
  // Without an order the model order stands.
  expect(taskItems(flatten(list)).map((item) => item.row.taskID)).toEqual(["a", "b", "c", "u"])
})

test("priority rides on listed rows only and is omitted for none", () => {
  const list = model([
    { ...group("p", [row("a"), row("b", ["a"])]), priority: 3 },
    { ...group("q", [row("c")]), priority: 0 },
  ])
  const items = taskItems(flatten(list, { expanded: ["task:b"] }))
  expect(items.map((item) => [item.key, item.priority])).toEqual([
    ["task:a", 3],
    ["task:b", 3],
    ["task:b>a", undefined],
    ["task:c", undefined],
  ])
})
