import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js"
import type { Columns, Row } from "../streams/frame.ts"
import { createStream, type GuiStream, type StreamsTransport } from "../streams/gui.ts"
import type { SourceRef } from "../streams/source.ts"
import { liveHistoryRef } from "../streams/sources/live-history-ref.ts"
import { radarRefs, type RadarGroup, type RadarScope } from "../streams/sources/radar-ref.ts"
import { taskPlansRef } from "../streams/sources/tasks-ref.ts"
import { AttemptModel, type AttemptSummary } from "../tasks/attempt-summary.ts"
import { taskMachineDefinition, type TaskMachineDefinition } from "../runner/task-machine-config.ts"
import {
  nodeOf,
  planOf,
  selectedNode,
  selectedPlan,
  transitionOf,
  type ObservationNode,
  type ObservationPlan,
  type RecordedTransition,
} from "./projection.ts"

/**
 * The Radar's stream reads (`src/streams/sources/radar.ts`): each is a window over stored rows,
 * opened while its pane shows and refreshed by the stream when its rows change. No timer, no
 * cache beside the window, no whole read on the main thread.
 *
 * ```
 * worker pane ─ radar.attempt (window 1) ─┐
 *             ─ liveHistory tools (whole) ┼─► WorkerAttempt (stats, lane, concern, takeover)
 *             ─ liveHistory newest (1) ───┘
 * group pane  ─ radar.group (50) + radar.workload (1) ─► GroupRead (tasks, total, indexing)
 * ```
 */
export type RadarStreamSource = {
  transport: StreamsTransport
  projectDirectory: string
  scope: RadarScope
}

const readerOf = (row: unknown) => row as Record<string, unknown>

/**
 * Build `make` under its own owner while `key` names something, and again when the key changes;
 * the previous owner (and every stream it opened) is disposed. Undefined while there is no key.
 */
function keyed<K, T>(
  key: Accessor<K | undefined>,
  same: (a: K, b: K) => boolean,
  make: (key: K) => T,
) {
  const current = createMemo<K | undefined>(key, undefined, {
    equals: (a, b) => (a === undefined || b === undefined ? a === b : same(a, b)),
  })
  const [value, setValue] = createSignal<T | undefined>()
  createEffect(() => {
    const now = current()
    if (now === undefined) return void setValue(undefined)
    const dispose = createRoot((done) => {
      const built = make(now)
      setValue(() => built)
      return done
    })
    // Disposed when the key changes or the owner closes: its streams close with it.
    onCleanup(dispose)
  })
  return value
}

/**
 * Every row of a filter: the window starts at `initial` and doubles while rows remain after it.
 * Nothing is refused (the old summary dropped the lane past 1,000 calls); a short list is one frame.
 */
function wholeStream<F, C extends Columns>(
  transport: StreamsTransport,
  source: SourceRef<F, C>,
  options: () => { filter: F; order: string },
  initial: number,
): GuiStream<C> {
  const [window, setWindow] = createSignal(initial)
  const stream = createStream(transport, source, () => ({ ...options(), window: window() }))
  createEffect(() => {
    if (stream.loaded() && stream.after() !== 0) setWindow((size) => size * 2)
  })
  return stream
}

/** What the worker pane shows of the selected session's attempt; the shape `worker-pane.ts` reads. */
export type WorkerAttempt = {
  id: string
  number: number
  state: string
  startedAt: number
  toolCount: number
  model?: AttemptModel
  summary: AttemptSummary
  task?: { state: string; reason: string | null; planState: string; planReason: string | null }
  concern?: {
    line: string
    action?: "acknowledge" | "steer" | "takeover" | "cancel"
    because?: string
  }
  takeover?: true
}

/** A tool call's display row as the summary reads it: time, status, edited files. */
function summaryOf(
  ticks: readonly Row<typeof liveHistoryRef.columns>[],
  newest: Row<typeof liveHistoryRef.columns> | undefined,
): AttemptSummary {
  const files = new Set<string>()
  const ordered = ticks.map(readerOf).toSorted((a, b) => Number(a.seq) - Number(b.seq))
  for (const row of ordered) {
    const targets = row.file_targets_json as { operation?: string; paths?: unknown } | null
    if (targets?.operation !== "edit" && targets?.operation !== "patch") continue
    if (Array.isArray(targets.paths))
      for (const path of targets.paths) if (typeof path === "string" && path) files.add(path)
  }
  const last = newest ? Number(readerOf(newest).at) : undefined
  return {
    ...(last !== undefined && Number.isFinite(last) ? { lastActivityAt: last } : {}),
    ticks: ordered.map((row) => ({
      at: Number(row.at),
      ...(row.status === "failed" ? { failed: true as const } : {}),
    })),
    ...(files.size ? { files: files.size } : {}),
  }
}

/** The stored concern (`task_schedule.concern`): its line. The rule's advice is not stored there. */
function concernOf(value: unknown): WorkerAttempt["concern"] {
  const concern = value as { line?: unknown } | null
  return typeof concern?.line === "string" && concern.line ? { line: concern.line } : undefined
}

function workerAttemptOf(
  row: Row<typeof radarRefs.attempt.columns>,
  summary: AttemptSummary,
): WorkerAttempt {
  const value = readerOf(row)
  const model = AttemptModel.safeParse(value.model)
  const concern = concernOf(value.concern)
  return {
    id: String(value.id),
    number: Number(value.number),
    state: String(value.state),
    startedAt: Number(value.started_at),
    toolCount: Number(value.tool_count),
    ...(model.success ? { model: model.data } : {}),
    summary,
    ...(value.node_state
      ? {
          task: {
            state: String(value.node_state),
            reason: (value.node_reason as string | null) ?? null,
            planState: String(value.plan_state),
            planReason: (value.plan_reason as string | null) ?? null,
          },
        }
      : {}),
    ...(concern ? { concern } : {}),
    ...(value.takeover ? { takeover: true as const } : {}),
  }
}

/** Calls read per frame for the lane before it grows; one attempt's calls usually fit. */
const LANE_INITIAL_CALLS = 256

/**
 * The selected worker's attempt: `radar.attempt` for its row, its tool calls for the lane and its
 * newest progress row for the last activity. `undefined` while loading, `null` without an attempt.
 */
export function createWorkerAttempt(
  source: Accessor<RadarStreamSource | undefined>,
  target: Accessor<{ sessionID: string; attemptID: string } | undefined>,
): Accessor<{ sessionID: string; attempt: WorkerAttempt | null } | undefined> {
  const opened = keyed(
    () => {
      const from = source()
      const to = target()
      return from && to ? { from, to } : undefined
    },
    (a, b) =>
      a.from === b.from && a.to.sessionID === b.to.sessionID && a.to.attemptID === b.to.attemptID,
    ({ from, to }) => {
      const base = { projectDirectory: from.projectDirectory, scope: from.scope }
      const attempt = createStream(from.transport, radarRefs.attempt, () => ({
        filter: { ...base, sessionID: to.sessionID },
        order: "recent",
        window: 1,
      }))
      const history = { ...base, attemptID: to.attemptID, sessionID: to.sessionID }
      const ticks = wholeStream(
        from.transport,
        liveHistoryRef,
        () => ({ filter: { ...history, toolsOnly: true }, order: "recent" }),
        LANE_INITIAL_CALLS,
      )
      const newest = createStream(from.transport, liveHistoryRef, () => ({
        filter: history,
        order: "recent",
        window: 1,
      }))
      return createMemo(() => {
        if (!attempt.loaded() || !ticks.loaded() || !newest.loaded()) return undefined
        const [row] = attempt.items()
        return {
          sessionID: to.sessionID,
          attempt: row ? workerAttemptOf(row, summaryOf(ticks.items(), newest.items()[0])) : null,
        }
      })
    },
  )
  return () => opened()?.()
}

/** Rows the group pane lists (the old head of 25) plus as many again of slop for scrolling. */
const GROUP_VIEW_ROWS = 25
const GROUP_WINDOW = GROUP_VIEW_ROWS * 2

export type GroupRead =
  | { indexing: true }
  | {
      indexing: false
      total: number
      tasks: { taskID: string; reference: string | null; title: string }[]
    }

const totalOf = (row: Record<string, unknown>, group: RadarGroup) =>
  Number(group === "needs-you" ? row.needs_you : group === "failed" ? row.failed : row.queued)

/**
 * The tasks behind one Map group, newest first, and the group's total from the workload row. A
 * project whose list is not indexed yet reads `indexing`, never an empty group or a zero.
 */
export function createGroupRead(
  source: Accessor<RadarStreamSource | undefined>,
  group: Accessor<RadarGroup | undefined>,
): Accessor<{ group: RadarGroup; read: GroupRead } | undefined> {
  const opened = keyed(
    () => {
      const from = source()
      const name = group()
      return from && name ? { from, name } : undefined
    },
    (a, b) => a.from === b.from && a.name === b.name,
    ({ from, name }) => {
      const base = { projectDirectory: from.projectDirectory, scope: from.scope }
      const tasks = createStream(from.transport, radarRefs.group, () => ({
        filter: { ...base, group: name },
        order: "recent",
        window: GROUP_WINDOW,
      }))
      const workload = createStream(from.transport, radarRefs.workload, () => ({
        filter: base,
        order: "key",
        window: 1,
      }))
      return createMemo(() => {
        if (!tasks.loaded() || !workload.loaded()) return undefined
        const row = workload.items()[0]
        if (!row || !readerOf(row).ready) return { group: name, read: { indexing: true as const } }
        return {
          group: name,
          read: {
            indexing: false as const,
            total: totalOf(readerOf(row), name),
            tasks: tasks.items().map((task) => {
              const value = readerOf(task)
              return {
                taskID: String(value.task_id),
                reference: (value.reference as string | null) ?? null,
                title: String(value.title),
              }
            }),
          },
        }
      })
    },
  )
  return () => opened()?.()
}

/**
 * Plans the lifecycle picker lists, read whole (the picker names every plan of the scope; 221 live).
 * The first frame holds this many; the window doubles while more remain.
 */
const PLANS_INITIAL = 64
/** A plan's nodes, read whole: plans hold a few nodes (251 nodes over 221 plans live). */
const NODES_INITIAL = 16
/** A node's recorded edges, read whole: at most one row per machine edge (about 40). */
const EDGES_INITIAL = 64

export type Lifecycle = {
  machine: TaskMachineDefinition
  loaded: Accessor<boolean>
  error: Accessor<Error | undefined>
  plans: Accessor<ObservationPlan[]>
  plan: Accessor<ObservationPlan | undefined>
  nodes: Accessor<ObservationNode[]>
  node: Accessor<ObservationNode | undefined>
  transitions: Accessor<RecordedTransition[]>
  /** The selected transition with its reason, read as a one-row detail window. */
  chosen: Accessor<RecordedTransition | undefined>
}

/**
 * The lifecycle view: the scope's plans (`tasks.plans`), the selected plan's nodes (`radar.nodes`)
 * and the selected node's recorded edges (`radar.planEvents`), each a stream that updates when
 * its rows change. Replaces the whole-project snapshot and the freshness read that gated it.
 */
export function createLifecycle(
  source: RadarStreamSource,
  selection: Accessor<{ planID: string | null; taskID: string | null; transition: number | null }>,
): Lifecycle {
  const machine = taskMachineDefinition()
  const base = { projectDirectory: source.projectDirectory, scope: source.scope }
  const taskScope = {
    kind: source.scope.kind === "session" ? ("session" as const) : ("project" as const),
    sessionID: source.scope.sessionID,
  }
  const planRows = wholeStream(
    source.transport,
    taskPlansRef,
    () => ({ filter: { project: source.projectDirectory, scope: taskScope }, order: "schedule" }),
    PLANS_INITIAL,
  )
  const plans = createMemo(() => planRows.items().map(planOf))
  const plan = createMemo(() => selectedPlan(plans(), selection().planID))
  const nodeRows = wholeStream(
    source.transport,
    radarRefs.nodes,
    () => ({ filter: { ...base, planID: plan()?.id ?? "" }, order: "plan" }),
    NODES_INITIAL,
  )
  const nodes = createMemo(() => nodeRows.items().map((row) => nodeOf(row, machine)))
  const node = createMemo(() => selectedNode(nodes(), selection().taskID))
  const edgeRows = wholeStream(
    source.transport,
    radarRefs.planEvents,
    () => ({
      filter: { ...base, planID: plan()?.id ?? "", taskID: node()?.taskID ?? "" },
      order: "id",
    }),
    EDGES_INITIAL,
  )
  const transitions = createMemo(() => edgeRows.items().map(transitionOf))
  const chosenRow = keyed(
    () => selection().transition ?? undefined,
    (a, b) => a === b,
    (id) =>
      createStream(source.transport, radarRefs.planEvents, () => ({
        filter: { ...base, planID: plan()?.id ?? "", taskID: node()?.taskID ?? "" },
        order: "id",
        window: 1,
        anchor: { key: [id] },
      })),
  )
  const chosen = createMemo(() => {
    const id = selection().transition
    if (id === null) return undefined
    const row = chosenRow()?.items()[0]
    const listed = transitions().find((item) => item.sequence === id)
    if (row && Number((row as unknown as Record<string, unknown>).id) === id)
      return transitionOf(row)
    return listed
  })
  return {
    machine,
    loaded: () => planRows.loaded() && (!plan() || (nodeRows.loaded() && edgeRows.loaded())),
    error: () => planRows.error() ?? nodeRows.error() ?? edgeRows.error(),
    plans,
    plan,
    nodes,
    node,
    transitions,
    chosen,
  }
}
