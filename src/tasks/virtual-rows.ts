import type { ExecutionList, ExecutionListRow, ExecutionPlanGroup } from "./execution-list.ts"
import { PLAN_HEADING_HEIGHT, TASK_ROW_HEIGHT } from "./panel-layout.ts"

export const LOADER_HEIGHT = 32
const NOTE_HEIGHT = 28
const PLAN_MARGIN = 8
const PLAN_REASON_HEIGHT = 20

/**
 * The Tasks list as one flat, ordered sequence. Plan headings, task rows, "not in this page" notes
 * and the page loader are siblings; nesting survives only as `depth` and branch position data, so
 * a virtualizer can mount any window of it. Pure: no Solid or DOM imports.
 */

/** A titled plan gets a heading when it groups several tasks or carries scheduler facts. */
export function planHeaded(group: ExecutionPlanGroup) {
  return (
    group.hasRecordedTitle &&
    (group.totalCount > 1 || Boolean(group.priority) || (group.afterPlans ?? []).length > 0)
  )
}

export type VirtualPlanItem = {
  kind: "plan"
  key: string
  group: ExecutionPlanGroup
  collapsed: boolean
  /** A heading is a top-level tree item: aria-level 1, positioned among top-level siblings. */
  setSize: number
  posInSet: number
}

export type VirtualBranchPosition = {
  branchID: string
  /** First/last task row of its branch: the branch rail starts and ends here. */
  first: boolean
  last: boolean
}

export type VirtualTaskItem = {
  kind: "task"
  key: string
  row: ExecutionListRow
  group?: ExecutionPlanGroup
  /** 0 for list rows, 1 for rows hanging from a fork. Visual indent only. */
  depth: number
  /** aria-level: one deeper under a plan heading, one more under a fork root. */
  level: number
  /** Position among tree siblings (aria-setsize / aria-posinset). */
  setSize: number
  posInSet: number
  /** The fork root a branch row hangs from. */
  parentTaskID?: string
  expandable: boolean
  expanded: boolean
  branch?: VirtualBranchPosition
}

export type VirtualNoteItem = {
  kind: "note"
  key: string
  branchID: string
  hiddenCount: number
  depth: number
}

export type VirtualLoaderItem = { kind: "loader"; key: string }

export type VirtualItem = VirtualPlanItem | VirtualTaskItem | VirtualNoteItem | VirtualLoaderItem

export const LOADER_KEY = "loader:more"
export const planKey = (planID: string) => `plan:${planID}`
export const taskKey = (taskID: string) => `task:${taskID}`
export const noteKey = (branchID: string) => `note:${branchID}`

export function flattenExecutionList(input: {
  model: ExecutionList
  collapsedPlans: ReadonlySet<string>
  forkExpanded: (group: ExecutionPlanGroup, row: ExecutionListRow) => boolean
  /** Append a loader row while another page exists. */
  hasMore?: boolean
}): VirtualItem[] {
  const items: VirtualItem[] = []
  const pushRows = (
    rows: readonly ExecutionListRow[],
    group?: ExecutionPlanGroup,
    headed = false,
  ) => {
    const level = headed ? 2 : 1
    rows.forEach((row, index) => {
      const expandable = Boolean(group && row.fork)
      const expanded = Boolean(group && row.fork && input.forkExpanded(group, row))
      items.push({
        kind: "task",
        key: taskKey(row.taskID),
        row,
        group,
        depth: 0,
        level,
        setSize: rows.length,
        posInSet: index + 1,
        expandable,
        expanded,
      })
      if (!expanded || !row.fork) return
      const children = row.fork.branches.reduce((sum, branch) => sum + branch.rows.length, 0)
      let position = 0
      for (const branch of row.fork.branches) {
        branch.rows.forEach((child, childIndex) => {
          items.push({
            kind: "task",
            key: taskKey(child.taskID),
            row: child,
            group,
            depth: 1,
            level: level + 1,
            setSize: children,
            posInSet: ++position,
            parentTaskID: row.taskID,
            expandable: false,
            expanded: false,
            branch: {
              branchID: branch.id,
              first: childIndex === 0,
              last: childIndex === branch.rows.length - 1 && branch.hiddenCount === 0,
            },
          })
        })
        if (branch.hiddenCount > 0)
          items.push({
            kind: "note",
            key: noteKey(branch.id),
            branchID: branch.id,
            hiddenCount: branch.hiddenCount,
            depth: 1,
          })
      }
    })
  }
  for (const group of input.model.plans) {
    const headed = planHeaded(group)
    if (headed) {
      const collapsed = input.collapsedPlans.has(group.planID)
      items.push({
        kind: "plan",
        key: planKey(group.planID),
        group,
        collapsed,
        setSize: 0,
        posInSet: 0,
      })
      if (collapsed) continue
    }
    pushRows(group.rows, group, headed)
  }
  pushRows(input.model.unplanned)
  // Headings and the rows of plain plans and unplanned tasks are one top-level sibling set.
  const topLevel = items.filter(
    (item): item is VirtualPlanItem | VirtualTaskItem =>
      item.kind === "plan" || (item.kind === "task" && item.level === 1),
  )
  topLevel.forEach((item, index) => {
    item.setSize = topLevel.length
    item.posInSet = index + 1
  })
  if (input.hasMore) items.push({ kind: "loader", key: LOADER_KEY })
  return items
}

export const taskItems = (items: readonly VirtualItem[]) =>
  items.filter((item): item is VirtualTaskItem => item.kind === "task")

/** Index in the flat list of a task row, or -1 when it is not part of the visible sequence. */
export function taskIndex(items: readonly VirtualItem[], taskID: string) {
  return items.findIndex((item) => item.kind === "task" && item.row.taskID === taskID)
}

/** The plan whose rows, fork branches included, list this task. */
export function planOfTask(model: ExecutionList, taskID: string) {
  const holds = (row: ExecutionListRow): boolean =>
    row.taskID === taskID ||
    Boolean(
      row.fork?.branches.some((branch) => branch.rows.some((child) => child.taskID === taskID)),
    )
  return model.plans.find((group) => group.rows.some(holds))?.planID
}

export type NavigationKey = "ArrowUp" | "ArrowDown" | "Home" | "End" | "ArrowLeft" | "ArrowRight"

/** Tree items in visual order: plan headings and task rows (notes and the loader are not items). */
export type TreeItem = VirtualPlanItem | VirtualTaskItem
export const treeItems = (items: readonly VirtualItem[]) =>
  items.filter((item): item is TreeItem => item.kind === "plan" || item.kind === "task")

/**
 * Tree item to move to from the item keyed `key` in visual order. Offscreen rows count: this reads
 * the model, not the DOM. Left goes to a branch row's fork root or a plan row's heading; Right to an
 * expanded fork root's first branch row or an expanded heading's first row (collapsed ones must
 * expand first, which the caller does).
 */
export function navigationTarget(
  items: readonly VirtualItem[],
  key: string,
  direction: NavigationKey,
): TreeItem | undefined {
  const tree = treeItems(items)
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
    case "ArrowLeft": {
      if (current.kind === "plan") return undefined
      const parent = current.parentTaskID
        ? taskKey(current.parentTaskID)
        : current.level > 1 && current.group
          ? planKey(current.group.planID)
          : undefined
      return parent ? tree.find((item) => item.key === parent) : undefined
    }
    case "ArrowRight": {
      const next = tree[index + 1]
      if (current.kind === "plan")
        return !current.collapsed && next?.kind === "task" && next.group === current.group
          ? next
          : undefined
      return current.expandable &&
        current.expanded &&
        next?.kind === "task" &&
        next.parentTaskID === current.row.taskID
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
  // At the list top, or with the head (Now/Attention/Next) still at the viewport top, the person
  // reads content a reorder of tree rows does not move: hold the scroll offset, follow no row.
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

/**
 * First-guess height before the virtualizer measures the mounted element: compact rows match
 * `.lazers-tasks-row`, headings carry their margin and optional reason line.
 */
export function estimateItemSize(item: VirtualItem) {
  switch (item.kind) {
    case "task":
      return TASK_ROW_HEIGHT
    case "plan":
      return (
        PLAN_HEADING_HEIGHT +
        PLAN_MARGIN +
        (item.group.schedulingReason || (item.group.afterPlans ?? []).length
          ? PLAN_REASON_HEIGHT
          : 0)
      )
    case "note":
      return NOTE_HEIGHT
    case "loader":
      return LOADER_HEIGHT
  }
}
