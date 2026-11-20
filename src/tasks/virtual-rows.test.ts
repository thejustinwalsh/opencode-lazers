import { expect, test } from "bun:test"
import type { ExecutionListRow } from "./task-row.ts"
import {
  LOADER_KEY,
  LOADER_START_KEY,
  anchoredScrollTop,
  estimateItemSize,
  navigationTarget,
  spliceItems,
  taskIndex,
  taskItems,
  viewportAnchor,
} from "./virtual-rows.ts"
import type { VirtualItem } from "./virtual-rows.ts"

/** A graph of task id to the ids it depends on; a row's dependency count is its edge count. */
type Graph = Record<string, string[]>
const rowOf = (taskID: string, graph: Graph): ExecutionListRow => ({
  taskID,
  title: taskID,
  status: "queued",
  reason: null,
  waiting: false,
  holdReason: null,
  ordinal: 0,
  dependencyCount: graph[taskID]?.length ?? 0,
  contextOnly: false,
  prerequisites: [],
  successors: [],
})
function splice(
  listed: string[],
  graph: Graph,
  options: {
    expanded?: string[]
    loaders?: { start?: boolean; end?: boolean }
    priority?: Record<string, number>
  } = {},
) {
  return spliceItems({
    rows: listed.map((taskID) => ({
      row: rowOf(taskID, graph),
      priority: options.priority?.[taskID],
    })),
    expanded: new Set(options.expanded ?? []),
    children: (_key, taskID) => (graph[taskID] ?? []).map((child) => rowOf(child, graph)),
    loaders: options.loaders,
  })
}
const keys = (items: readonly VirtualItem[]) => items.map((item) => item.key)

test("every task is one flat row", () => {
  const items = splice(["t1", "t2", "t3", "u1"], {})
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
  const items = splice(["a", "b"], { b: ["a"] })
  expect(keys(items)).toEqual(["task:a", "task:b"])
  expect(taskItems(items).map((item) => [item.expandable, item.expanded])).toEqual([
    [false, false],
    [true, false],
  ])
})

test("expanding lists the dependency tree as nested rows, duplicated across expanded trees", () => {
  // c depends on b, b depends on a; d also depends on b: b's subtree repeats under d.
  const graph = { b: ["a"], c: ["b"], d: ["b"] }
  const listed = ["a", "b", "c", "d"]
  const items = splice(listed, graph, {
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
  expect(keys(splice(listed, graph, { expanded: ["task:c>b", "task:d", "task:d>b"] }))).toEqual([
    "task:a",
    "task:b",
    "task:c",
    "task:d",
    "task:d>b",
    "task:d>b>a",
  ])
})

test("dependency cycles are listed once and never expand again", () => {
  const graph = { a: ["b"], b: ["a"], s: ["s"] }
  const items = splice(["a", "b", "s"], graph, {
    expanded: ["task:a", "task:a>b", "task:a>b>a", "task:s"],
  })
  expect(keys(items)).toEqual(["task:a", "task:a>b", "task:a>b>a", "task:b", "task:s", "task:s>s"])
  const cyclic = taskItems(items).find((item) => item.key === "task:a>b>a")!
  expect(cyclic).toMatchObject({ expandable: false, expanded: false })
})

test("loader items stand at an end of the window only while rows remain beyond it", () => {
  expect(keys(splice(["t1", "t2"], {}))).toEqual(["task:t1", "task:t2"])
  expect(keys(splice(["t1", "t2"], {}, { loaders: { end: true } }))).toEqual([
    "task:t1",
    "task:t2",
    LOADER_KEY,
  ])
  expect(keys(splice(["t1", "t2"], {}, { loaders: { start: true, end: true } }))).toEqual([
    LOADER_START_KEY,
    "task:t1",
    "task:t2",
    LOADER_KEY,
  ])
})

test("item keys are stable when the window slides", () => {
  const before = keys(splice(["t1", "t2", "t3"], {}, { loaders: { end: true } }))
  const after = keys(splice(["t2", "t3", "t4"], {}, { loaders: { start: true, end: true } }))
  expect(before.filter((key) => !key.startsWith("loader"))).toEqual([
    "task:t1",
    "task:t2",
    "task:t3",
  ])
  expect(after.indexOf("task:t2")).toBe(before.indexOf("task:t1") + 1)
  expect(after.indexOf("task:t3")).toBe(after.indexOf("task:t2") + 1)
})

test("keyboard navigation reads the model in visual order and moves through the dependency tree", () => {
  const graph = { b: ["a"] }
  const items = splice(["a", "b", "c"], graph, { expanded: ["task:b"] })
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
  expect(navigationTarget(splice(["a", "b", "c"], graph), "task:b", "ArrowRight")).toBeUndefined()
  // Unknown keys fall back to the first row.
  expect(go("task:missing", "ArrowDown")).toBe("task:a")
})

test("a task's index prefers its listed row over a repeat inside an expanded tree", () => {
  const items = splice(["x", "a"], { x: ["a"] }, { expanded: ["task:x"] })
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
  const items = splice(["a", "b"], {}, { loaders: { end: true } })
  expect(items.map(estimateItemSize)).toEqual([32, 32, 32])
})

test("priority rides on listed rows only and is omitted for none", () => {
  const items = taskItems(
    splice(["a", "b", "c"], { b: ["a"] }, { expanded: ["task:b"], priority: { a: 3, b: 3 } }),
  )
  expect(items.map((item) => [item.key, item.priority])).toEqual([
    ["task:a", 3],
    ["task:b", 3],
    ["task:b>a", undefined],
    ["task:c", undefined],
  ])
})
