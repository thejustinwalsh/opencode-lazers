import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  on,
  onCleanup,
  runWithOwner,
  type Accessor,
} from "solid-js"
import type { Columns } from "../streams/frame.ts"
import { createStream, type GuiStream, type StreamsTransport } from "../streams/gui.ts"
import type { SourceRef } from "../streams/source.ts"
import {
  taskBlockersRef,
  taskBucketCountsRef,
  taskDependenciesRef,
  taskIndexRef,
  taskPlansRef,
  taskScheduleRef,
  taskSessionBucketCountsRef,
  taskWaitsRef,
  type TaskScope,
  type TaskStateFilter,
} from "../streams/sources/tasks-ref.ts"
import { bucketsFor } from "./schedule/key.ts"
import { BUCKETS } from "./schedule/buckets.ts"
import { childRowOf, listRowOf, priorityOfRow, type ExecutionListRow } from "./task-row.ts"
import { spliceItems, type VirtualItem } from "./virtual-rows.ts"

/**
 * What the Tasks list reads: stream windows over the stored projection, no cursors and no cache
 * beside the windows. The list is one `tasks.schedule` window (rows that fit plus slop each side,
 * moved by `slide`); every expanded row owns a `tasks.dependencies` stream that lives while it is
 * expanded; the chips read `tasks.bucketCounts` (or the session counts); one `tasks.index` row says
 * whether the project is indexed yet. Rows are keyed by task id, so a row that changes updates in
 * place.
 *
 * ```
 *   before (not held)   │ slop │ rows that fit │ slop │   after (not held)
 *   "more" → start loader                                "more" → end loader
 * ```
 */

/** Rows held on each side of the rows that fit. */
const SLOP_ROWS = 25
/** Rows the window holds for a view that fits `fit` rows. */
const windowFor = (fit: number) => Math.max(1, fit) + 2 * SLOP_ROWS

const readerOf = (row: unknown) => (column: string) => (row as Record<string, unknown>)[column]
const unfinished = (stream: GuiStream<never>) => stream.after() !== 0

/**
 * A stream that reads every row of its filter: it starts at `initial` rows and doubles while rows
 * remain after the window. Nothing is refused; a short list is read in one frame.
 */
function wholeStream<F, C extends Columns>(
  transport: StreamsTransport,
  source: SourceRef<F, C>,
  options: () => { filter: F; order: string },
  initial: () => number,
): GuiStream<C> {
  const [window, setWindow] = createSignal(Math.max(1, initial()))
  const stream = createStream(transport, source, () => ({ ...options(), window: window() }))
  createEffect(() => {
    if (stream.loaded() && unfinished(stream as never)) setWindow((current) => current * 2)
  })
  return stream
}

export type TaskListInput = {
  transport: StreamsTransport
  /** Fixed for the list's life: a new project or scope is a new list. */
  project: string
  scope: TaskScope
  search: Accessor<string>
  state: Accessor<TaskStateFilter>
  /** Rows that fit in view; the window follows it and never shrinks. */
  fit: Accessor<number>
  expanded: Accessor<ReadonlySet<string>>
  /** The task the list opens around, when it is still in the filter; otherwise it opens at the head. */
  startAt?: string
}

/** Call inside the owner that should close the streams. */
export function createTaskList(input: TaskListInput) {
  const filterBase = { project: input.project, scope: input.scope }
  // Memoized so a write that leaves them unchanged (the stored view saves the selection) does not
  // reopen the stream.
  const search = createMemo(input.search)
  const state = createMemo(input.state)
  const windowSize = createMemo<number>((previous) =>
    Math.max(previous ?? 0, windowFor(input.fit())),
  )
  // A new window size reopens the stream; it reopens around the first row so the view holds still.
  // Another filter reopens at the head.
  let firstKey: [string] | undefined
  let shape = ""
  const schedule = createStream(input.transport, taskScheduleRef, () => {
    const filter = {
      ...filterBase,
      state: state(),
      ...(search() ? { search: search() } : {}),
    }
    const now = JSON.stringify(filter)
    const keep =
      now === shape ? firstKey : shape === "" && input.startAt ? [input.startAt] : undefined
    const around = now !== shape
    shape = now
    return {
      filter,
      order: "schedule",
      window: windowSize(),
      ...(keep
        ? { anchor: { key: [...keep], place: around ? ("center" as const) : ("start" as const) } }
        : {}),
    }
  })
  createEffect(() => {
    const [first] = schedule.items()
    firstKey = first ? [String(first.task_id)] : undefined
  })
  const rows = createMemo(() =>
    schedule.items().map((raw) => {
      const read = readerOf(raw)
      return {
        row: listRowOf(read, String(read("task_id"))),
        priority: priorityOfRow(raw as never),
      }
    }),
  )

  // One dependency stream per expanded row, opened and closed as rows expand and collapse.
  const owner = getOwner()
  const open = new Map<string, { stream: GuiStream<never>; dispose: () => void }>()
  const [version, bump] = createSignal(0)
  const taskOfKey = (key: string) =>
    key
      .split(">")
      .at(-1)!
      .replace(/^task:/, "")
  const listed = createMemo(() => new Set(rows().map(({ row }) => `task:${row.taskID}`)))
  createEffect(() => {
    // An expanded row leaves with its listed ancestor; its stream closes then.
    const wanted = [...input.expanded()].filter((key) => listed().has(key.split(">")[0]!))
    const wantedSet = new Set(wanted)
    for (const [key, entry] of open)
      if (!wantedSet.has(key)) {
        entry.dispose()
        open.delete(key)
      }
    for (const key of wanted) {
      if (open.has(key)) continue
      const count =
        rows().find(({ row }) => `task:${row.taskID}` === key)?.row.dependencyCount ?? undefined
      runWithOwner(owner, () =>
        createRoot((dispose) => {
          const stream = wholeStream(
            input.transport,
            taskDependenciesRef,
            () => ({
              filter: { scope: input.scope, parent: taskOfKey(key) },
              order: "ord",
            }),
            () => count ?? 8,
          ) as unknown as GuiStream<never>
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
    return entry?.stream.items().map((raw) => childRowOf(readerOf(raw)))
  }

  const items = createMemo<VirtualItem[]>(() =>
    spliceItems({
      rows: rows(),
      expanded: input.expanded(),
      children: (key) => children(key),
      loaders: { start: schedule.before() !== 0, end: schedule.after() !== 0 },
    }),
  )

  const counts = createStream(
    input.transport,
    input.scope.kind === "session" ? taskSessionBucketCountsRef : taskBucketCountsRef,
    () => ({ filter: { ...filterBase }, order: "bucket", window: BUCKETS.length }),
  )
  /** Tasks per chip from the stored counters; undefined while a search narrows the list. */
  const chipCount = (chip: TaskStateFilter): number | undefined => {
    if (search() || !counts.loaded()) return undefined
    const byBucket = new Map(
      counts.items().map((raw) => [String(readerOf(raw)("bucket")), Number(readerOf(raw)("n"))]),
    )
    const buckets = bucketsFor(chip) ?? BUCKETS
    return buckets.reduce((sum, bucket) => sum + (byBucket.get(bucket) ?? 0), 0)
  }

  const index = createStream(input.transport, taskIndexRef, () => ({
    filter: { project: input.project, scope: input.scope },
    order: "project",
    window: 1,
  }))
  /** False until the project is indexed; undefined before the first answer. */
  const indexed = createMemo(() => {
    if (!index.loaded()) return undefined
    const [first] = index.items()
    // No state row: the project's indexing has not started.
    return first ? Boolean(readerOf(first)("ready")) : false
  })

  // One move at a time, each answered by a frame.
  let moving = false
  let last = 0
  createEffect(() => {
    schedule.items()
    moving = false
  })
  createEffect(() => {
    if (schedule.error()) moving = false
  })
  const slide = (delta: number) => {
    if (moving || delta === 0) return
    moving = true
    last = delta
    schedule.slide(delta)
  }

  return {
    items,
    rows,
    chipCount,
    indexed,
    schedule,
    /** Every frame of the list has arrived at least once. */
    loaded: () => schedule.loaded(),
    error: () => schedule.error() ?? counts.error() ?? index.error(),
    /** Rows each side of the window hold. */
    before: () => schedule.before(),
    after: () => schedule.after(),
    /** Move the window by items, as the view scrolls near an edge. */
    slide,
    /** Ask for the move that failed again. */
    retry: () => slide(last),
    /**
     * Bring the window around a task. Only a task the list's filter selects has a place in it:
     * another chip's task, or any task while a search narrows the list, stays where it is.
     */
    reveal: (taskID: string, bucket: string) => {
      if (rows().some(({ row }) => row.taskID === taskID)) return
      if (search()) return
      const buckets = bucketsFor(state())
      if (buckets && !(buckets as readonly string[]).includes(bucket)) return
      schedule.seek({ key: [taskID], place: "center" })
    },
  }
}
export type TaskList = ReturnType<typeof createTaskList>

export type SelectedFactsInput = {
  transport: StreamsTransport
  project: string
  scope: TaskScope
  taskID: Accessor<string | undefined>
}

/** One related task: its id, and the reference and title the relation carries. */
type RelatedTask = { taskID: string; reference?: string; title?: string }

type Facts = {
  row: Accessor<(ExecutionListRow & { bucket: string }) | undefined>
  plan: Accessor<
    | {
        id: string
        title: string
        priority: number
        state: string
        reason: string | null
        afterPlans: string[]
        afterPlansCount: number
      }
    | undefined
  >
  afterPlans: Accessor<Array<{ planID: string; title: string }>>
  blockers: Accessor<RelatedTask[]>
  waits: Accessor<Array<{ planID: string; title: string | null; reason: string | null }>>
  prerequisites: Accessor<RelatedTask[]>
  successors: Accessor<RelatedTask[]>
}

/**
 * What the inspector shows of the selected task beyond its detail: its own schedule row (not
 * limited to the list's window), its plan, the plans that plan runs after, the tasks and plans it
 * waits behind, and the tasks it runs after and the tasks that run after it. Each is a stream
 * opened while the task is selected and closed when the selection moves.
 */
export function createSelectedFacts(input: SelectedFactsInput) {
  const owner = getOwner()
  const selected = createMemo(input.taskID)
  const [facts, setFacts] = createSignal<Facts>()
  let release: (() => void) | undefined
  createEffect(
    on(selected, (taskID) => {
      release?.()
      release = undefined
      setFacts(undefined)
      if (!taskID) return
      runWithOwner(owner, () =>
        createRoot((dispose) => {
          release = dispose
          const base = { scope: input.scope }
          const schedule = createStream(input.transport, taskScheduleRef, () => ({
            filter: { project: input.project, ...base, taskID, includeRetired: true },
            order: "schedule",
            window: 1,
          }))
          const row = createMemo(() => {
            const [raw] = schedule.items()
            if (!raw) return undefined
            const read = readerOf(raw)
            const concern = read("concern") as ExecutionListRow["concern"] | null
            const totals = read("concern_totals")
            const listed = listRowOf(read, taskID)
            return {
              ...listed,
              ...(concern && totals ? { concern: { ...concern, totals } as never } : {}),
              bucket: String(read("bucket")),
            }
          })
          const planID = createMemo(() => {
            const [raw] = schedule.items()
            const value = raw ? readerOf(raw)("plan_id") : undefined
            return typeof value === "string" ? value : undefined
          })
          const planStream = createStream(input.transport, taskPlansRef, () => ({
            filter: { project: input.project, ...base, planID: planID() ?? "" },
            order: "schedule",
            window: 1,
          }))
          const plan = createMemo(() => {
            const [raw] = planStream.items()
            if (!raw || !planID()) return undefined
            const read = readerOf(raw)
            const after = read("after_plans")
            return {
              id: String(read("plan_id")),
              title: String(read("title") ?? ""),
              priority: Number(read("priority") ?? 0),
              state: String(read("state") ?? ""),
              reason: (read("reason") as string | null) ?? null,
              afterPlans: Array.isArray(after) ? (after as string[]) : [],
              afterPlansCount: Number(read("after_plans_count") ?? 0),
            }
          })
          const afterStream = wholeStream(
            input.transport,
            taskPlansRef,
            () => ({
              filter: {
                project: input.project,
                ...base,
                planIDs: plan()?.afterPlans.length ? plan()!.afterPlans : [""],
              },
              order: "schedule",
            }),
            () => 8,
          )
          const afterPlans = createMemo(() => {
            const byID = new Map(
              afterStream.items().map((raw) => {
                const read = readerOf(raw)
                return [String(read("plan_id")), String(read("title") ?? "")] as const
              }),
            )
            return (plan()?.afterPlans ?? []).map((planID) => ({
              planID,
              title: byID.get(planID) ?? "",
            }))
          })
          const blockerStream = wholeStream(
            input.transport,
            taskBlockersRef,
            () => ({ filter: { ...base, task: taskID }, order: "blocker" }),
            () => 8,
          )
          const waitStream = wholeStream(
            input.transport,
            taskWaitsRef,
            () => ({ filter: { ...base, task: taskID }, order: "ord" }),
            () => 8,
          )
          const prerequisiteStream = wholeStream(
            input.transport,
            taskDependenciesRef,
            () => ({ filter: { ...base, parent: taskID }, order: "ord" }),
            () => 8,
          )
          const successorStream = wholeStream(
            input.transport,
            taskDependenciesRef,
            () => ({ filter: { ...base, task: taskID }, order: "ord" }),
            () => 8,
          )
          setFacts({
            row,
            plan,
            afterPlans,
            blockers: createMemo(() =>
              blockerStream.items().map((raw) => {
                const read = readerOf(raw)
                return {
                  taskID: String(read("blocker_task_id")),
                  ...(read("reference") ? { reference: String(read("reference")) } : {}),
                  ...(read("title") ? { title: String(read("title")) } : {}),
                }
              }),
            ),
            waits: createMemo(() =>
              waitStream.items().map((raw) => {
                const read = readerOf(raw)
                return {
                  planID: String(read("plan_id")),
                  title: (read("title") as string | null) ?? null,
                  reason: (read("reason") as string | null) ?? null,
                }
              }),
            ),
            prerequisites: createMemo(() =>
              prerequisiteStream.items().map((raw) => {
                const read = readerOf(raw)
                return {
                  taskID: String(read("child_task_id")),
                  ...(read("child_reference")
                    ? { reference: String(read("child_reference")) }
                    : {}),
                  ...(read("child_title") ? { title: String(read("child_title")) } : {}),
                }
              }),
            ),
            successors: createMemo(() =>
              successorStream.items().map((raw) => {
                const read = readerOf(raw)
                return {
                  taskID: String(read("parent_task_id")),
                  ...(read("parent_reference")
                    ? { reference: String(read("parent_reference")) }
                    : {}),
                  ...(read("parent_title") ? { title: String(read("parent_title")) } : {}),
                }
              }),
            ),
          })
        }),
      )
    }),
  )
  onCleanup(() => {
    release?.()
    release = undefined
  })
  const read = <T>(pick: (facts: Facts) => Accessor<T>, fallback: T): T => {
    const current = facts()
    return current ? pick(current)() : fallback
  }
  return {
    row: () => read((f) => f.row, undefined),
    plan: () => read((f) => f.plan, undefined),
    afterPlans: () => read((f) => f.afterPlans, []),
    blockers: () => read((f) => f.blockers, []),
    waits: () => read((f) => f.waits, []),
    prerequisites: () => read((f) => f.prerequisites, []),
    successors: () => read((f) => f.successors, []),
  }
}
