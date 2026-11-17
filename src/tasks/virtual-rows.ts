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
  /** 0 for list rows, 1 for rows hanging from a fork. */
  depth: number
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
  const pushRows = (rows: readonly ExecutionListRow[], group?: ExecutionPlanGroup) => {
    rows.forEach((row, index) => {
      const expandable = Boolean(group && row.fork)
      const expanded = Boolean(group && row.fork && input.forkExpanded(group, row))
      items.push({
        kind: "task",
        key: taskKey(row.taskID),
        row,
        group,
        depth: 0,
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
    if (planHeaded(group)) {
      const collapsed = input.collapsedPlans.has(group.planID)
      items.push({ kind: "plan", key: planKey(group.planID), group, collapsed })
      if (collapsed) continue
    }
    pushRows(group.rows, group)
  }
  pushRows(input.model.unplanned)
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

/**
 * Task to move to from `taskID` in visual order. Offscreen rows count: this reads the model, not the
 * DOM. Left goes to a branch row's fork root; Right to a fork root's first branch row (a collapsed
 * fork must expand first, which the caller does).
 */
export function navigationTarget(
  items: readonly VirtualItem[],
  taskID: string,
  key: NavigationKey,
): string | undefined {
  const tasks = taskItems(items)
  const index = tasks.findIndex((item) => item.row.taskID === taskID)
  if (index < 0) return tasks[0]?.row.taskID
  switch (key) {
    case "Home":
      return tasks[0]?.row.taskID
    case "End":
      return tasks[tasks.length - 1]?.row.taskID
    case "ArrowUp":
      return tasks[Math.max(0, index - 1)]?.row.taskID
    case "ArrowDown":
      return tasks[Math.min(tasks.length - 1, index + 1)]?.row.taskID
    case "ArrowLeft":
      return tasks[index]?.parentTaskID
    case "ArrowRight": {
      const current = tasks[index]!
      const next = tasks[index + 1]
      return current.expandable && current.expanded && next?.parentTaskID === taskID
        ? next.row.taskID
        : undefined
    }
  }
}

/** Index of the item whose key is `key`, or -1. */
export const itemIndex = (items: readonly VirtualItem[], key: string) =>
  items.findIndex((item) => item.key === key)

/**
 * Scroll anchoring across item-list changes: the first item intersecting the viewport and how far
 * its start sits below the scroll offset. Returns the scroll offset that keeps it put, or
 * undefined when the item is gone or has not moved.
 */
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
