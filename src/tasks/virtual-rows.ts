import type { ExecutionListRow } from "./task-row.ts"
import { TASK_ROW_HEIGHT } from "./panel-layout.ts"

export const LOADER_HEIGHT = 32

/**
 * The Tasks list as one flat, priority-ordered sequence of task rows. A task with dependencies is
 * an accordion: expanding it lists its dependency tree beneath it as nested rows. Nesting survives
 * only as `depth` and `parentKey`, so a virtualizer can mount any window of it. Pure: no Solid or
 * DOM imports.
 */

export type VirtualTaskItem = {
  kind: "task"
  /** `task:<id>` for a listed row; a dependency row appends `>` and its id to its parent's key. */
  key: string
  row: ExecutionListRow
  /** 0 for listed rows, one more per dependency level. Visual indent only. */
  depth: number
  /** aria-level: depth + 1. */
  level: number
  /** Position among tree siblings (aria-setsize / aria-posinset). */
  setSize: number
  posInSet: number
  parentKey?: string
  /** Scheduler priority of the row's plan (1 is top); listed rows only, absent for none. */
  priority?: number
  /** The row has dependencies to list. */
  expandable: boolean
  expanded: boolean
}

export type VirtualLoaderItem = { kind: "loader"; key: string }

export type VirtualItem = VirtualTaskItem | VirtualLoaderItem

export const LOADER_KEY = "loader:more"
export const taskKey = (taskID: string) => `task:${taskID}`

export const taskItems = (items: readonly VirtualItem[]) =>
  items.filter((item): item is VirtualTaskItem => item.kind === "task")

/**
 * Index in the flat list of a task row, or -1 when it is not part of the visible sequence. The
 * listed row wins over a repeat of the same task inside an expanded dependency tree.
 */
export function taskIndex(items: readonly VirtualItem[], taskID: string) {
  const listed = items.findIndex((item) => item.key === taskKey(taskID))
  return listed >= 0
    ? listed
    : items.findIndex((item) => item.kind === "task" && item.row.taskID === taskID)
}

export type NavigationKey = "ArrowUp" | "ArrowDown" | "Home" | "End" | "ArrowLeft" | "ArrowRight"

/**
 * Task item to move to from the item keyed `key` in visual order. Offscreen rows count: this reads
 * the model, not the DOM. Left goes to the parent a dependency row hangs from; Right to an expanded
 * row's first dependency (a collapsed row must expand first, which the caller does).
 */
export function navigationTarget(
  items: readonly VirtualItem[],
  key: string,
  direction: NavigationKey,
): VirtualTaskItem | undefined {
  const tree = taskItems(items)
  const index = tree.findIndex((item) => item.key === key)
  if (index < 0) return tree[0]
  const current = tree[index]!
  switch (direction) {
    case "Home":
      return tree[0]
    case "End":
      return tree[tree.length - 1]
    case "ArrowUp":
      return tree[Math.max(0, index - 1)]
    case "ArrowDown":
      return tree[Math.min(tree.length - 1, index + 1)]
    case "ArrowLeft":
      return current.parentKey ? tree.find((item) => item.key === current.parentKey) : undefined
    case "ArrowRight": {
      const next = tree[index + 1]
      return current.expandable && current.expanded && next?.parentKey === current.key
        ? next
        : undefined
    }
  }
}

/** Index of the item whose key is `key`, or -1. */
export const itemIndex = (items: readonly VirtualItem[], key: string) =>
  items.findIndex((item) => item.key === key)

/**
 * Scroll anchoring across item-list changes: the first item intersecting the viewport and how far
 * its start (from the tree's top) sits below the scroll offset, or undefined when nothing in the
 * tree should hold still. `anchoredScrollTop` returns the scroll offset that keeps it put, or
 * undefined when the item is gone or has not moved.
 */
export function viewportAnchor(
  scrollTop: number,
  treeOffset: number,
  first: { key: string | number | bigint; start: number } | undefined,
): { key: string; offset: number } | undefined {
  // At the list top, or with the notes above the tree still at the viewport top, the person reads
  // content a reorder of tree rows does not move: hold the scroll offset, follow no row.
  if (!first || scrollTop <= 0 || scrollTop < treeOffset) return undefined
  return { key: String(first.key), offset: first.start - treeOffset - scrollTop }
}

export function anchoredScrollTop(
  anchor: { key: string; offset: number } | undefined,
  start: (key: string) => number | undefined,
  scrollTop: number,
): number | undefined {
  if (!anchor) return undefined
  const next = start(anchor.key)
  if (next === undefined) return undefined
  const target = next - anchor.offset
  return Math.abs(target - scrollTop) < 0.5 ? undefined : target
}

/** First-guess height before the virtualizer measures the mounted element. */
export function estimateItemSize(item: VirtualItem) {
  return item.kind === "task" ? TASK_ROW_HEIGHT : LOADER_HEIGHT
}

/**
 * The Tasks list as one flat sequence, from stream windows: the listed rows of the
 * `tasks.schedule` window, and for every expanded row the children its own `tasks.dependencies`
 * stream holds (`children`, by the parent's item key). A row is expandable when it stores
 * dependencies; a cycle is cut on the ancestor path, which is view state.
 */
export function spliceItems(input: {
  rows: readonly { row: ExecutionListRow; priority?: number }[]
  expanded: ReadonlySet<string>
  children(parentKey: string, parentTaskID: string): readonly ExecutionListRow[] | undefined
  /** Another window exists before (`start`) or after (`end`) the rows. */
  loaders?: { start?: boolean; end?: boolean }
}): VirtualItem[] {
  const items: VirtualItem[] = []
  if (input.loaders?.start) items.push({ kind: "loader", key: LOADER_START_KEY })
  const push = (
    row: ExecutionListRow,
    key: string,
    depth: number,
    setSize: number,
    posInSet: number,
    ancestors: ReadonlySet<string>,
    priority?: number,
    parentKey?: string,
  ) => {
    const expandable = (row.dependencyCount ?? 0) > 0 && !ancestors.has(row.taskID)
    const expanded = expandable && input.expanded.has(key)
    items.push({
      kind: "task",
      key,
      row,
      depth,
      level: depth + 1,
      setSize,
      posInSet,
      ...(parentKey ? { parentKey } : {}),
      ...(priority ? { priority } : {}),
      expandable,
      expanded,
    })
    if (!expanded) return
    const next = new Set([...ancestors, row.taskID])
    const kids = input.children(key, row.taskID) ?? []
    kids.forEach((child, index) =>
      push(
        child,
        `${key}>${child.taskID}`,
        depth + 1,
        kids.length,
        index + 1,
        next,
        undefined,
        key,
      ),
    )
  }
  input.rows.forEach(({ row, priority }, index) =>
    push(row, taskKey(row.taskID), 0, input.rows.length, index + 1, new Set(), priority),
  )
  if (input.loaders?.end) items.push({ kind: "loader", key: LOADER_KEY })
  return items
}
export const LOADER_START_KEY = "loader:before"
