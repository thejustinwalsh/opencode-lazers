import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  type Accessor,
} from "solid-js"
import { createStream, type GuiStream, type StreamsTransport } from "../streams/gui.ts"
import {
  taskBucketCountsRef,
  taskDependenciesRef,
  taskIndexRef,
  taskScheduleRef,
  taskSessionBucketCountsRef,
  type TaskScope,
  type TaskStateFilter,
} from "../streams/sources/tasks-ref.ts"
import { childRowOf, listRowOf, priorityOfRow, type ExecutionListRow } from "./task-row.ts"
import { spliceItems, type VirtualItem } from "./virtual-rows.ts"

/**
 * What the Tasks list reads: stream windows over the stored projection, no cursors and no cache
 * beside the windows. The list is one `tasks.schedule` window (rows that fit plus slop, moved by
 * `slide`); every expanded row owns a `tasks.dependencies` stream that lives while it is expanded;
 * the chips read `tasks.bucketCounts` (or the session counts); one `tasks.index` row says whether
 * the project is indexed yet. Rows are keyed by task id, so a row that changes updates in place.
 */
export type TaskListInput = {
  transport: StreamsTransport
  project: Accessor<string>
  scope: Accessor<TaskScope>
  search: Accessor<string>
  state: Accessor<TaskStateFilter>
  /** Rows the window holds: what fits in view plus slop on each side. */
  window: Accessor<number>
  expanded: Accessor<ReadonlySet<string>>
}

const readerOf = (row: unknown) => (column: string) => (row as Record<string, unknown>)[column]

/** Call inside the owner that should close the streams. */
export function createTaskList(input: TaskListInput) {
  const filterBase = () => ({ project: input.project(), scope: input.scope() })
  const schedule = createStream(input.transport, taskScheduleRef, () => ({
    filter: {
      ...filterBase(),
      state: input.state(),
      ...(input.search() ? { search: input.search() } : {}),
    },
    order: "schedule",
    window: input.window(),
  }))
  const rows = createMemo(() =>
    schedule.items().map((raw) => {
      const read = readerOf(raw)
      const taskID = String(read("task_id"))
      return { row: listRowOf(read, taskID), priority: priorityOfRow(raw as never) }
    }),
  )

  // One dependency stream per expanded row, opened and closed as rows expand and collapse.
  const owner = getOwner()
  const open = new Map<string, { stream: GuiStream<never>; dispose: () => void }>()
  const [version, bump] = createSignal(0)
  const taskOfKey = createMemo(() => {
    const byKey = new Map<string, string>()
    const walk = (key: string, taskID: string) => byKey.set(key, taskID)
    for (const { row } of rows()) walk(`task:${row.taskID}`, row.taskID)
    return byKey
  })
  createEffect(() => {
    const expanded = input.expanded()
    version()
    // The task an expanded key stands for: a listed row's own, or the last key segment of a child.
    const wanted = new Map<string, string>()
    for (const key of expanded) {
      const taskID =
        taskOfKey().get(key) ??
        key
          .split(">")
          .at(-1)!
          .replace(/^task:/, "")
      if (taskID) wanted.set(key, taskID)
    }
    for (const [key, entry] of open)
      if (!wanted.has(key)) {
        entry.dispose()
        open.delete(key)
      }
    for (const [key, taskID] of wanted) {
      if (open.has(key)) continue
      runWithOwner(owner, () =>
        createRoot((dispose) => {
          const stream = createStream(input.transport, taskDependenciesRef, () => ({
            filter: { scope: input.scope(), parent: taskID },
            order: "ord",
            // A dependency list is read whole: it is small, and every child shows.
            window: 100,
          })) as unknown as GuiStream<never>
          open.set(key, { stream, dispose })
        }),
      )
    }
    bump((n) => n + 1)
  })
  onCleanup(() => {
    for (const entry of open.values()) entry.dispose()
    open.clear()
  })
  const children = (key: string): ExecutionListRow[] | undefined => {
    version()
    const entry = open.get(key)
    if (!entry) return undefined
    return entry.stream.items().map((raw) => childRowOf(readerOf(raw)))
  }

  const items = createMemo<VirtualItem[]>(() =>
    spliceItems({
      rows: rows(),
      expanded: input.expanded(),
      children: (key) => children(key),
      loaders: {
        start: schedule.before() !== 0 && schedule.before() === "more",
        end: schedule.after() === "more",
      },
    }),
  )

  const counts = createStream(
    input.transport,
    input.scope().kind === "session" ? taskSessionBucketCountsRef : taskBucketCountsRef,
    () => ({ filter: { ...filterBase() }, order: "bucket", window: 32 }),
  )
  /** Tasks per chip; undefined while a search narrows the list (no badge is better than a wrong one). */
  const bucketCounts = createMemo(() => {
    if (input.search()) return undefined
    const byBucket: Record<string, number> = {}
    for (const raw of counts.items())
      byBucket[String(readerOf(raw)("bucket"))] = Number(readerOf(raw)("n"))
    return byBucket
  })

  const index = createStream(input.transport, taskIndexRef, () => ({
    filter: filterBase(),
    order: "project",
    window: 1,
  }))
  /** False while the project is being indexed; undefined before the first answer. */
  const indexed = createMemo(() => {
    const [first] = index.items()
    return first ? Boolean(readerOf(first)("ready")) : undefined
  })

  return {
    items,
    rows,
    counts: bucketCounts,
    indexed,
    schedule,
    error: () => schedule.error() ?? counts.error() ?? index.error(),
    /** Move the window by items, as the view scrolls near an edge. */
    slide: (delta: number) => schedule.slide(delta),
  }
}
export type TaskList = ReturnType<typeof createTaskList>
