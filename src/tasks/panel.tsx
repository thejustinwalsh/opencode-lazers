import {
  Command,
  LinkHandler,
  MenuItem,
  Panel,
  Store,
  Style,
  bindPlugin,
  createLatest,
  createKeyed,
  usePanel,
} from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import { Schema } from "effect"
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  untrack,
} from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { TaskProposal } from "../task.ts"
import { Tasks } from "./contract.ts"
import { TasksScheduling } from "./scheduling-contract.ts"
import type { SchedulingScope } from "./scheduling-contract.ts"
import { Observability } from "../observability/contract.ts"
import {
  TaskPanelState,
  inspectedCache,
  projectCache,
  remember,
  taskViewCache,
} from "./panel-state.ts"
import { taskChanges } from "./events.ts"
import type { PanelData } from "./panel-state.ts"
import { DetailsPane } from "../details-pane.tsx"
import { sizeFromLegacySplit, storedState } from "../details-pane.ts"
import { createPanelStatus, PanelSkeleton, PanelStatus } from "../panel-status.tsx"
import { taskTitle, taskHeading, taskReasonView, sourcePlanLine } from "./presentation.ts"
import { createTaskLinkHandler, taskMarkdownLink } from "./links.ts"
import { StartFeedback, ScrollRestoration, canStart, workerActivityLabel } from "./panel-view.ts"
import {
  attentionLabel,
  distinctReasons,
  isRingGlyph,
  rowHoldReasons,
  taskRowPresentation,
  planStateLabel,
  taskRowBlocker,
  elapsedLabel,
  runningStart,
  taskSequencing,
  taskStateTooltip,
} from "./row-presentation.ts"
import { buildExecutionList } from "./execution-list.ts"
import type { ExecutionListRow } from "./execution-list.ts"
import type { TaskBlocker, TaskGlyph, TaskRowPresentation } from "./row-presentation.ts"
import { TaskRing } from "./state-glyph.tsx"
import {
  anchoredScrollTop,
  viewportAnchor,
  estimateItemSize,
  flattenExecutionList,
  itemIndex,
  listedRows,
  navigationTarget,
  taskIndex,
  taskItems,
} from "./virtual-rows.ts"
import type { NavigationKey, VirtualItem, VirtualTaskItem } from "./virtual-rows.ts"
import type { TaskTrajectoryTarget } from "../trajectory-panel/panel-state.ts"
import { preferredTaskStateFilter } from "./state-filter.ts"
import { Keyed } from "./keyed.ts"
import css from "./panel.css?inline"

const View = Schema.Struct({
  scope: Schema.Literals(["session", "project"]),
  selectedID: Schema.NullOr(Schema.String),
  search: Schema.String,
  /** Retired list/inspector split; read once to size the details pane. */
  split: Schema.optionalKey(Schema.Number),
  splitAdjusted: Schema.optionalKey(Schema.Boolean),
  /** Details pane: closed by default; size is the body's fraction of the panel. */
  open: Schema.optionalKey(Schema.Boolean),
  size: Schema.optionalKey(Schema.Number),
  listScroll: Schema.Number,
  detailScroll: Schema.Number,
  state: Schema.optionalKey(
    Schema.Literals([
      "open",
      "queued",
      "running",
      "blocked",
      "paused",
      "completed",
      "accepted",
      "integrated",
      "failed",
      "cancelled",
      "all",
    ]),
  ),
  history: Schema.optionalKey(Schema.Boolean),
  revealTaskID: Schema.optionalKey(Schema.String),
})
/** State menu order: live work, then finished work, then everything. */
const STATE_MENU = [
  ["open", "queued", "running", "blocked", "paused"],
  ["accepted", "integrated", "failed", "cancelled"],
  ["all"],
] as const
const initial: typeof View.Type = {
  scope: "session",
  selectedID: null,
  search: "",
  listScroll: 0,
  detailScroll: 0,
  history: false,
  revealTaskID: "",
}
export const taskStores = {
  taskView: Store.session(Schema.Struct({ projects: Schema.Record(Schema.String, View) }), {
    projects: {},
  }),
}
type TaskContext = SetupContext<{ stores: typeof taskStores }>
export type TaskTrajectoryRequest = Omit<TaskTrajectoryTarget, "requestID">
export type TaskTrajectoryOpener = (
  session: PanelProps["session"],
  target: TaskTrajectoryRequest,
) => void
export type TaskRadarRequest = {
  taskID: string
  projectDirectory: string
  /** Exact worker association, when the runtime recorded one. */
  workerSessionID?: string
}
export type TaskRadarOpener = (session: PanelProps["session"], target: TaskRadarRequest) => void

export function verificationTimingSummary(check: TaskProposal["verification"][number]): string {
  const timing = (value: number | undefined) =>
    value === undefined ? "project default (not resolved here)" : `${value / 1000}s (authored)`
  const parts = [
    `Inactivity allowance: ${timing(check.inactivityTimeoutMs)}`,
    `Hard backstop: ${timing(check.hardTimeoutMs)}`,
  ]
  if (check.timeoutMs !== undefined)
    parts.push(`Legacy timeout (historical): ${check.timeoutMs / 1000}s (not used for execution)`)
  return parts.join(" · ")
}

/** Reservation holders listed before the rest move behind a disclosure; all stay linked. */
const RESERVATION_PREVIEW = 8

/** Done when previews this many criteria; explicit expansion shows every one. */
const CRITERIA_PREVIEW = 3

/** The goal repeats only when it says more than the derived title. */
function objectiveExtendsTitle(objective: string) {
  return taskTitle(objective) !== objective.trim().replace(/\s+/g, " ")
}

/** Rows rendered beyond the viewport on each side. */
const VIRTUAL_OVERSCAN = 8
/**
 * Request the next page once the viewport's overscanned window is this close to the end of the
 * list. Measured from the viewport, never from rows pinned to stay mounted for focus.
 */
const LOAD_MORE_WITHIN = 10
/** Bounded wait for a scrolled-to row to mount before giving up on focusing it. */
const FOCUS_ATTEMPTS = 10

const terminalLifecycleStates = new Set([
  "accepted",
  "incorporated",
  "failed",
  "exhausted",
  "cancelled",
])

type VirtualRow = { key: string; index: number; offset: number; item: VirtualItem }

/** Absolutely positioned slot for one virtual item; the virtualizer measures it once mounted. */
function VirtualItemView(props: {
  virtual: Accessor<VirtualRow>
  measure: (element: HTMLDivElement | null) => void
  render: (item: Accessor<VirtualItem>) => JSX.Element
}) {
  let element: HTMLDivElement | undefined
  onMount(() => props.measure(element!))
  onCleanup(() => queueMicrotask(() => props.measure(null)))
  return (
    <div
      class="lazers-tasks-virtual-item"
      role="none"
      ref={(value) => {
        element = value
      }}
      data-index={props.virtual().index}
      data-kind={props.virtual().item.kind}
      style={{ transform: `translateY(${props.virtual().offset}px)` }}
    >
      {untrack(() => props.render(() => props.virtual().item))}
    </div>
  )
}

/** The lookup key for a session's canonical project. */
function scopeKey(source: { server: string; session: string; directory: string }) {
  return `${source.server}\0${source.session}\0${source.directory}`
}

function TaskPanel(
  props: PanelProps & {
    ctx: TaskContext
    openTrajectory: TaskTrajectoryOpener
    openRadar: TaskRadarOpener
  },
) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
  const [data, setData] = createSignal<PanelData>({
    key: "",
    moreError: "",
    tasks: [],
    currentActivity: {},
    activityError: "",
    schedulingError: "",
    linkedDetails: {},
    loading: true,
    stale: false,
    error: "",
  })
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [showAllCriteria, setShowAllCriteria] = createSignal(false)
  const listID = createUniqueId()
  const [startFeedback, setStartFeedback] = createSignal({ taskID: "", error: "" })
  const [copyStatus, setCopyStatus] = createSignal("")
  const [revealedTaskIDs, setRevealedTaskIDs] = createSignal<Set<string>>(new Set())
  /** Item keys of expanded dependency accordions; per view, never persisted. Default collapsed. */
  const [expandedKeys, setExpandedKeys] = createSignal<ReadonlySet<string>>(new Set())
  /** Where the tree starts inside the scrolling list, below the notes. */
  const [treeOffset, setTreeOffset] = createSignal(0)
  /** The tree item holding focus while focus is inside the tree; it stays mounted. */
  const [focusedTreeKey, setFocusedTreeKey] = createSignal<string>()
  const feedback = new StartFeedback(setStartFeedback)
  const listRestore = new ScrollRestoration()
  const detailRestore = new ScrollRestoration()
  let root: HTMLDivElement | undefined
  let list: HTMLDivElement | undefined
  let tree: HTMLDivElement | undefined
  /** The details body while the pane is open; scroll restoration waits for it. */
  const [detail, setDetail] = createSignal<HTMLDivElement>()
  /**
   * What the project lookup depends on. The host replaces session objects (its location) on any
   * session update; with the same client, session, server and directory this keeps its identity,
   * so the lookup does not run again and the view does not blank and reconnect mid-session.
   */
  const scopeSource = createMemo(
    () => {
      if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
      return {
        client: props.session.server.client,
        session: props.session.id,
        server: props.session.server.id,
        directory: props.session.directory,
      }
    },
    undefined,
    {
      equals: (left, right) =>
        left === right ||
        (left !== undefined &&
          right !== undefined &&
          left.client === right.client &&
          left.session === right.session &&
          left.server === right.server &&
          left.directory === right.directory),
    },
  )
  const scope = createLatest(scopeSource, async (source, signal) => {
    const location = await source.client.location.get(
      { location: { directory: source.directory } },
      { signal },
    )
    remember(projectCache, scopeKey(source), location.project.canonical)
    return { ...source, project: location.project.canonical }
  })
  const current = () => {
    if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
    const value = scope.latest
    // A re-mounted panel knows this project already: the lookup refreshes in the background.
    const source = scopeSource()
    const cached = source ? projectCache.get(scopeKey(source)) : undefined
    if (source && cached && !(value && !scope.loading && value.session === source.session))
      return { ...source, project: cached }
    return value &&
      value.session === props.session.id &&
      value.server === props.session.server.id &&
      value.directory === props.session.directory &&
      !scope.loading
      ? value
      : undefined
  }
  const prefs = () => {
    const value = current()
    return value
      ? (ctx.stores.taskView(props.session).value?.projects[value.project] ?? initial)
      : initial
  }
  const stateFilter = () => preferredTaskStateFilter(prefs().state, prefs().history)
  const save = (change: Partial<typeof initial>) => {
    const value = current()
    if (!value) return
    const store = ctx.stores.taskView(props.session)
    store.update((draft) => {
      draft.projects[value.project] = { ...(draft.projects[value.project] ?? initial), ...change }
    })
  }
  const state = new TaskPanelState(
    setData,
    (selectedID) =>
      save({
        selectedID,
        detailScroll: selectedID === prefs().selectedID ? prefs().detailScroll : 0,
      }),
    taskViewCache,
  )
  onCleanup(() => {
    state.close()
    feedback.reset("")
    listRestore.restore("", false, undefined, 0)
    detailRestore.restore("", false, undefined, 0)
  })
  createKeyed(
    () => {
      const value = current()
      if (!value || !frame.visible() || !ctx.stores.taskView(props.session).ready()) {
        return undefined
      }
      const key = JSON.stringify([
        value.server,
        value.project,
        value.session,
        prefs().scope,
        prefs().search,
        stateFilter(),
      ])
      return { value, key }
    },
    ({ value, key }) => {
      const view = prefs()
      const sessionID = view.scope === "session" ? value.session : undefined
      const rpc = () => props.session.server.client.rpc(Tasks)
      state.connect(
        key,
        value.project,
        {
          query: (input, signal) =>
            rpc().query(input, { location: { directory: value.directory }, signal }),
          get: (taskID, signal) =>
            rpc().get(
              { taskID, ...(sessionID ? { sessionID } : {}) },
              { location: { directory: value.directory }, signal },
            ),
          topology: (signal) =>
            value.client.rpc(Observability).topology(
              {
                scope:
                  view.scope === "session"
                    ? { kind: "session", sessionID: value.session }
                    : { kind: "project", sessionID: value.session },
              },
              { location: { directory: value.directory }, signal },
            ),
          scheduling: (input, signal) =>
            value.client
              .rpc(TasksScheduling)
              .read(input, { location: { directory: value.directory }, signal }),
          currentActivity: (taskIDs, signal) =>
            rpc().currentActivity(
              { sessionID: value.session, scope: view.scope, taskIDs },
              { location: { directory: value.directory }, signal },
            ),
          start: (input, signal) =>
            rpc().start(input, { location: { directory: value.directory }, signal }),
          changes: (signal) => taskChanges(value.client.event, value.project, signal),
          online: () => props.session.server.connected,
        },
        {
          search: view.search,
          sort: "schedule",
          state: stateFilter(),
          sessionID,
          limit: 30,
        },
        view.selectedID ?? undefined,
        {
          kind: view.scope,
          sessionID: value.session,
        } satisfies SchedulingScope,
      )
      onCleanup(() => state.close())
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )
  const expectedKey = () => {
    const value = current()
    const view = prefs()
    return value
      ? JSON.stringify([
          value.server,
          value.project,
          value.session,
          view.scope,
          view.search,
          preferredTaskStateFilter(view.state, view.history),
        ])
      : ""
  }
  // Disclosure starts over only for another view (scope, filter, search, session, project). A
  // transient gap with no view (a reconnect) keeps it for its return.
  let revealIdentity = ""
  createEffect(() => {
    const key = expectedKey()
    if (!key || key === revealIdentity) return
    revealIdentity = key
    setRevealedTaskIDs(new Set<string>())
    setExpandedKeys(new Set<string>())
  })
  const visible = () => (data().key === expectedKey() ? data() : undefined)
  const selectionKey = () => JSON.stringify([expectedKey(), visible()?.selectedID])
  /**
   * What the inspector reads. A filter, scope or reconnect replaces the list data with an empty
   * load; the inspector keeps the last data that held a task's detail until another arrives. It
   * is dropped only for another server, project or session.
   */
  const identity = () => {
    const value = current()
    return value ? JSON.stringify([value.server, value.project, value.session]) : ""
  }
  const [lastInspected, setLastInspected] = createSignal<{ identity: string; data: PanelData }>()
  createEffect(() => {
    const value = visible()
    // Only a finished read holds every input the inspector derives its state from.
    if (value?.detail && !value.loading) {
      setLastInspected({ identity: identity(), data: value })
      remember(inspectedCache, identity(), { identity: identity(), data: value })
    }
  })
  // One clock for every elapsed cell, once a minute; only those cells read it.
  const [minute, setMinute] = createSignal(Date.now())
  const minuteTimer = setInterval(() => setMinute(Date.now()), 60_000)
  onCleanup(() => clearInterval(minuteTimer))
  const status = createPanelStatus(() => {
    const value = visible()
    const error = scope.error ? String(scope.error) : (value?.error ?? "")
    return {
      subject: "tasks",
      hasContent: Boolean(value?.page),
      loading: !scope.error && (!value || value.loading),
      disconnected: Boolean(value?.stale) || !props.session.server.connected,
      ...(error ? { error } : {}),
      ...(value?.asOf ? { asOf: value.asOf } : {}),
    }
  })
  const inspected = (): PanelData | undefined => {
    const value = visible()
    // While a reload is in flight the detail can arrive before the topology, scheduling and
    // activity it is presented with; a partial set would show the recorded lifecycle instead of
    // the real status. Hold the last complete set instead.
    if (value?.detail && !value.loading) return value
    const kept = lastInspected() ?? inspectedCache.get(identity())
    if (kept && kept.identity === identity()) return kept.data
    // First load: nothing complete to hold yet, so present no task rather than a partial one.
    if (!value?.detail) return value
    const { detail: _partial, ...withoutDetail } = value
    return withoutDetail
  }
  const executionList = createMemo(() =>
    buildExecutionList({
      topology: inspected()?.topology,
      tasks: inspected()?.tasks ?? [],
      scheduling: inspected()?.scheduling,
      search: prefs().search,
      revealTaskIDs: revealedTaskIDs(),
    }),
  )
  const schedulingPlans = () => inspected()?.scheduling?.plans ?? []
  const schedulingNode = (taskID: string) =>
    schedulingPlans()
      .flatMap((plan) => plan.nodes)
      .find((node) => node.taskID === taskID)
  const schedulingPlan = (planID: string | undefined) =>
    planID ? schedulingPlans().find((plan) => plan.planID === planID) : undefined
  const openPrerequisitePlan = (planID: string) => {
    const firstTask = schedulingPlan(planID)?.nodes.toSorted((a, b) => a.ordinal - b.ordinal)[0]
    if (firstTask) selectTask(firstTask.taskID)
  }
  const revealTask = (taskID: string) => {
    setRevealedTaskIDs((current) => new Set([...current, taskID]))
    queueMicrotask(() => scrollToTask(taskID))
  }
  const selectTask = (taskID: string) => {
    revealTask(taskID)
    void state.select(taskID)
  }
  const setExpanded = (key: string, expanded: boolean) =>
    setExpandedKeys((current) => {
      const next = new Set(current)
      if (expanded) next.add(key)
      else next.delete(key)
      return next
    })
  let handledReveal = ""
  createEffect(() => {
    const taskID = prefs().revealTaskID ?? ""
    const value = visible()
    if (!taskID) {
      handledReveal = ""
      return
    }
    if (!value || value.loading || handledReveal === taskID) return
    handledReveal = taskID
    save({ revealTaskID: "" })
    if (value.selectedID === taskID) {
      revealTask(taskID)
      focusTaskRow(taskID)
    } else selectTask(taskID)
  })
  createEffect(() => {
    const value = visible()
    const view = prefs()
    listRestore.restore(expectedKey(), Boolean(value && !value.loading), list, view.listScroll)
    detailRestore.restore(
      selectionKey(),
      value?.detail?.status === "found" &&
        value.detail.task.id === value.selectedID &&
        Boolean(detail()),
      detail(),
      view.detailScroll,
    )
  })
  createEffect(() => feedback.reset(selectionKey()))
  createEffect(() => {
    const value = current()
    if (!value || !frame.visible() || !ctx.stores.taskView(props.session).ready()) return
    const selectedID = prefs().selectedID ?? undefined
    if (data().key !== expectedKey() || data().selectedID === selectedID || !selectedID) return
    void state.select(selectedID)
  })
  createEffect(() => {
    selectionKey()
    setCopyStatus("")
  })
  const selectedTask = () => {
    const result = inspected()?.detail
    return result?.status === "found" ? result.task : undefined
  }
  const selectedExecution = () => {
    const detail = inspected()?.detail
    return detail?.status === "found" ? detail.execution : undefined
  }
  const selectedDetail = () => {
    const result = inspected()?.detail
    return result?.status === "found" ? result : undefined
  }
  const selectedActivity = () => {
    const taskID = inspected()?.selectedID
    return taskID ? inspected()?.currentActivity[taskID] : undefined
  }
  const selectedRecordedState = () => {
    const taskID = inspected()?.selectedID
    const execution = selectedExecution()
    const node = inspected()
      ?.topology?.plans.find((plan) => plan.id === execution?.planID)
      ?.nodes.find((item) => item.taskID === taskID)
    return (
      selectedDetail()?.recordedState ?? node?.state ?? execution?.state ?? selectedTask()?.status
    )
  }
  const selectedIsWaiting = () => {
    const recordedState = selectedRecordedState()
    if (recordedState && terminalLifecycleStates.has(recordedState)) return false
    const taskID = inspected()?.selectedID
    const execution = selectedExecution()
    const plan = inspected()?.topology?.plans.find((item) => item.id === execution?.planID)
    const node = plan?.nodes.find((item) => item.taskID === taskID)
    const terminal = ["accepted", "incorporated", "failed", "exhausted", "cancelled"].includes(
      node?.state ?? "",
    )
    const topologyWaiting = Boolean(
      node &&
      plan?.state !== "cancelled" &&
      (node.state === "blocked" || (plan?.state === "blocked" && !terminal)),
    )
    return Boolean(
      selectedActivity()?.waiting ||
      topologyWaiting ||
      execution?.state === "blocked" ||
      (taskID ? schedulingNode(taskID)?.decision === "waiting" : false),
    )
  }
  const selectedHoldReasons = () => {
    const activity = selectedActivity()
    const taskID = inspected()?.selectedID
    const execution = selectedExecution()
    const plan = inspected()?.topology?.plans.find((item) => item.id === execution?.planID)
    const node = plan?.nodes.find((item) => item.taskID === taskID)
    return selectedIsWaiting()
      ? distinctReasons([
          activity?.waiting ? activity.holdReason : null,
          node?.reason,
          plan?.reason,
          execution?.reason,
          taskID && schedulingNode(taskID)?.decision === "waiting"
            ? schedulingNode(taskID)?.reason
            : null,
          schedulingPlan(execution?.planID)?.reason,
        ])
      : []
  }
  const selectedInspectorStatus = () =>
    selectedIsWaiting()
      ? "Waiting"
      : selectedExecution()?.dispatchPause
        ? "Paused"
        : (selectedRecordedState() ?? "")
  const selectedRelations = () => {
    const taskID = inspected()?.selectedID
    const plan = schedulingPlan(selectedExecution()?.planID)
    const waitSet = new Set([
      ...(selectedExecution()?.waitingOn ?? []),
      ...(taskID ? (schedulingNode(taskID)?.waitingOn ?? []) : []),
    ])
    const waitingOn = [...waitSet]
    const waitingSet = new Set(waitingOn)
    const prerequisites = new Set<string>()
    const successors = new Set<string>()
    for (const plan of inspected()?.topology?.plans ?? [])
      for (const edge of plan.dependencies) {
        if (edge.successor === taskID && !waitingSet.has(edge.prerequisite))
          prerequisites.add(edge.prerequisite)
        if (edge.prerequisite === taskID) successors.add(edge.successor)
      }
    return {
      prerequisites: [...prerequisites],
      waitingOn,
      waitingOnPlans: taskID ? (schedulingNode(taskID)?.waitingOnPlans ?? []) : [],
      successors: [...successors],
      planPrerequisites: plan?.afterPlans ?? [],
      planPrerequisitesCount: plan?.afterPlansCount ?? plan?.afterPlans.length ?? 0,
      planPrerequisitesComplete: plan?.afterPlansComplete ?? true,
    }
  }
  const relationLabel = (taskID: string) =>
    inspected()?.tasks.find((task) => task.taskID === taskID)?.reference ??
    inspected()?.linkedDetails[taskID]?.reference ??
    taskID.slice(0, 8)
  const renderRelation = (taskID: string) => {
    const reference = createMemo(() => relationLabel(taskID))
    return (
      <Show
        when={reference().startsWith("LZ-") && selectedTask()}
        fallback={
          <button
            type="button"
            class="lazers-tasks-dependency-ref"
            aria-label={`Open related task ${reference()}`}
            onClick={() => selectTask(taskID)}
          >
            {reference()}
          </button>
        }
      >
        <Ui.Markdown text={taskMarkdownLink(reference(), selectedTask()!.provenance.projectID)} />
      </Show>
    )
  }
  const renderPlanRelation = (planID: string) => {
    const plan = schedulingPlan(planID)
    const title = plan?.title ?? `Plan ${planID.slice(0, 8)}`
    return (
      <button
        type="button"
        class="lazers-tasks-dependency-ref"
        aria-label={`Open prerequisite ${title}`}
        title={planID}
        onClick={() => openPrerequisitePlan(planID)}
      >
        {title}
      </button>
    )
  }
  createEffect(() => {
    const value = visible()
    if (!value?.selectedID || value.detail?.status !== "found") return
    const relationIDs = new Set([
      ...selectedRelations().waitingOn,
      ...selectedRelations().prerequisites,
      ...selectedRelations().successors,
    ])
    for (const taskID of relationIDs) {
      const hasReference = Boolean(
        value.tasks.find((task) => task.taskID === taskID)?.reference ??
        value.linkedDetails[taskID]?.reference,
      )
      if (!hasReference) void state.resolveLinked(taskID)
    }
  })
  /** Every row the model knows, listed or reachable only as a dependency. */
  const rowValues = createMemo(() => {
    const model = executionList()
    return [...listedRows(model), ...model.related]
  })
  /** The whole list as one flat sequence; only a window of it is ever mounted. */
  const hasMore = () => Boolean(visible()?.page?.nextCursor)
  const items = createMemo(() =>
    flattenExecutionList({
      model: executionList(),
      expanded: expandedKeys(),
      hasMore: hasMore(),
      order: (inspected()?.tasks ?? []).map((task) => task.taskID),
    }),
  )
  const itemByKey = createMemo(() => new Map(items().map((item) => [item.key, item])))
  /**
   * The tree's one tab stop: the selected row, else the first row. It is always a listed item, and
   * the range extractor keeps it mounted.
   */
  const treeTabStop = createMemo(() => {
    const current = items()
    const selectedID = visible()?.selectedID
    if (selectedID && taskIndex(current, selectedID) >= 0)
      return current[taskIndex(current, selectedID)]!.key
    return taskItems(current)[0]?.key
  })
  /** Last item index inside the viewport (no overscan, no pins); -1 before layout. */
  const [viewportEnd, setViewportEnd] = createSignal(-1)
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return items().length
    },
    getScrollElement: () => list ?? null,
    get estimateSize() {
      const current = items()
      return (index: number) => (current[index] ? estimateItemSize(current[index]!) : 0)
    },
    // A new closure per item list: keys may change without the count changing.
    get getItemKey() {
      const current = items()
      return (index: number) => current[index]?.key ?? index
    },
    get scrollMargin() {
      return treeOffset()
    },
    onChange: (instance) => setViewportEnd(instance.range?.endIndex ?? -1),
    overscan: VIRTUAL_OVERSCAN,
    // The tab stop and the focused item stay mounted: Tab can always enter the tree, and scrolling
    // never drops focus. Pins only add to the mounted set; paging reads the viewport range.
    get rangeExtractor() {
      const current = items()
      const pinned = [treeTabStop(), focusedTreeKey()]
        .map((key) => (key ? itemIndex(current, key) : -1))
        .filter((index) => index >= 0)
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indexes = defaultRangeExtractor(range)
        const extra = pinned.filter((index) => !indexes.includes(index))
        return extra.length
          ? [...indexes, ...new Set(extra)].toSorted((left, right) => left - right)
          : indexes
      }
    },
  })
  const virtualRows = createMemo(() => {
    const byKey = itemByKey()
    const margin = treeOffset()
    return virtualizer.getVirtualItems().flatMap((virtual) => {
      const item = byKey.get(String(virtual.key))
      return item
        ? [{ key: item.key, index: virtual.index, offset: virtual.start - margin, item }]
        : []
    })
  })
  const rowTabIndex = (key: string) => (key === treeTabStop() ? 0 : -1)
  const openSourcePlan = async (source: NonNullable<ExecutionListRow["sourcePlan"]>) => {
    try {
      const files = props.screen.file
      await files.sync(source.path)
      const content = files.get(source.path)?.content
      const line = sourcePlanLine(source, content?.type === "text" ? content.content : "")
      if (line) files.selection.set(source.path, { start: line, end: line })
      ctx.layout.open(`file:${source.path}`, props.session)
    } catch {
      setCopyStatus("Could not open plan.")
    }
  }
  const renderGlyph = (glyph: TaskGlyph) =>
    isRingGlyph(glyph) ? <TaskRing glyph={glyph} /> : <Ui.Icon name={glyph} size="small" />
  /** A known task's row state; tasks outside the model stay neutral. */
  const listedPresentation = (taskID: string): TaskRowPresentation | undefined => {
    const listed = rowValues().find((row) => row.taskID === taskID)
    return listed
      ? taskRowPresentation(listed, visible()?.currentActivity[taskID], relationLabel)
      : undefined
  }
  const renderTaskRow = (item: Accessor<VirtualTaskItem>): JSX.Element => {
    const taskRow = () => item().row
    const expandable = () => item().expandable
    const expanded = () => item().expanded
    const toggle = () => setExpanded(item().key, !expanded())
    const currentActivity = () => visible()?.currentActivity[taskRow().taskID]
    const presentation = createMemo(() =>
      taskRowPresentation(taskRow(), currentActivity(), relationLabel),
    )
    const waiting = () =>
      taskRow().waiting ||
      currentActivity()?.waiting === true ||
      taskRow().scheduling?.decision === "waiting"
    const showWorker = () =>
      Boolean(currentActivity()?.attemptID || currentActivity()?.workerSessionID)
    const pendingDependencies = () =>
      (taskRow().dependencyTasks ?? []).filter((dependency) => dependency.waiting)
    const accessibleDescription = () => {
      const activity = currentActivity()
      const reasons = rowHoldReasons(taskRow(), activity)
      return [
        ...(taskRow().reference ? [taskRow().reference] : []),
        ...(item().priority ? [`priority ${item().priority}`] : []),
        taskTitle(taskRow().title),
        `recorded lifecycle ${taskRow().status}`,
        ...(showWorker()
          ? [
              ...(activity?.foreground && activity.foreground !== "unknown"
                ? [`observed foreground activity ${activity.foreground}`]
                : []),
              ...(activity?.workerSessionID
                ? [`latest worker session ${activity.workerSessionID}`]
                : []),
              ...(activity?.unknownReason
                ? [`activity observation ${activity.unknownReason}`]
                : []),
              ...(activity?.outcome ? [`worker outcome ${activity.outcome}`] : []),
            ]
          : []),
        ...(waiting() ? [`waiting${reasons.length ? `: ${reasons.join("; ")}` : ""}`] : []),
        ...(waiting() && pendingDependencies().length
          ? [
              `waiting on ${pendingDependencies()
                .map(
                  (dependency) =>
                    `${dependency.reference ?? relationLabel(dependency.taskID)} (${dependency.state})`,
                )
                .join(", ")}`,
            ]
          : []),
        ...(presentation().tone === "paused" ? [`paused: ${presentation().detail}`] : []),
        ...(attentionLabel(activity) ? [attentionLabel(activity)] : []),
        ...(taskRow().contextOnly ? ["context"] : []),
      ].join(", ")
    }
    return (
      <div
        class="lazers-tasks-entry"
        role="treeitem"
        data-task-id={taskRow().taskID}
        data-item-key={item().key}
        data-context-only={taskRow().contextOnly}
        data-depth={item().depth}
        style={{ "--task-depth": item().depth }}
        aria-level={item().level}
        aria-setsize={item().setSize}
        aria-posinset={item().posInSet}
        aria-selected={taskRow().taskID === visible()?.selectedID}
        aria-expanded={expandable() ? expanded() : undefined}
        aria-label={accessibleDescription()}
        tabIndex={rowTabIndex(item().key)}
        onKeyDown={(event) => rowKey(event, item(), toggle)}
        onClick={(event) => {
          event.stopPropagation()
          selectTask(taskRow().taskID)
        }}
      >
        <div class="lazers-tasks-row" data-tone={presentation().tone}>
          <Show
            when={expandable()}
            fallback={<span class="lazers-tasks-disclosure-spacer" aria-hidden="true" />}
          >
            {/* The tree's arrow keys already expand and collapse; this is the pointer target. */}
            <button
              type="button"
              class="lazers-tasks-disclosure"
              tabIndex={-1}
              aria-expanded={expanded()}
              aria-label={`${expanded() ? "Collapse" : "Expand"} ${taskRow().reference ?? taskTitle(taskRow().title)}`}
              title={expanded() ? "Collapse dependencies" : "Expand dependencies"}
              onClick={(event) => {
                event.stopPropagation()
                toggle()
              }}
            >
              <Ui.Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
            </button>
          </Show>
          <Show when={taskRow().reference}>
            {(reference) => (
              <span
                class="lazers-tasks-row-reference"
                style={{ "font-family": ctx.appearance.font("mono") }}
              >
                {reference()}
              </span>
            )}
          </Show>
          {/* The whole first sentence: the row truncates to its own width, not to a fixed length. */}
          <span class="lazers-tasks-row-title">{taskHeading(taskRow().title)}</span>
          <span class="lazers-tasks-row-signals">
            <Show when={taskRowBlocker(presentation())}>
              {(blocker) => renderBlockerLink(blocker(), presentation().blockerTotal)}
            </Show>
            <Show when={runningStart(taskRow())}>
              {(start) => (
                <span
                  class="lazers-tasks-row-elapsed"
                  style={{ "font-family": ctx.appearance.font("mono") }}
                >
                  {elapsedLabel(start(), minute())}
                </span>
              )}
            </Show>
            <Ui.Tooltip value={taskStateTooltip(presentation())}>
              <span
                class="lazers-tasks-state"
                data-state={taskRow().status}
                data-waiting={waiting()}
                data-tone={presentation().tone}
                role="img"
                aria-label={presentation().label}
              >
                {renderGlyph(presentation().icon)}
              </span>
            </Ui.Tooltip>
          </span>
        </div>
      </div>
    )
  }
  /**
   * The row's one linked blocker: a themed link icon to the first typed task or plan it waits
   * behind, named with the count in its label and tooltip. Pointer convenience only (not a tab
   * stop, so the tree keeps one roving stop); the inspector lists every reference by keyboard.
   */
  const renderBlockerLink = (blocker: TaskBlocker, total: number) => {
    const name = () =>
      blocker.kind === "plan"
        ? (schedulingPlan(blocker.id)?.title ?? `Plan ${blocker.id.slice(0, 8)}`)
        : relationLabel(blocker.id)
    const more = () => (total > 1 ? ` and ${total - 1} more` : "")
    // The link takes the blocker's own state color, so a failed or running prerequisite reads at once.
    const state = () => (blocker.kind === "task" ? listedPresentation(blocker.id) : undefined)
    const stateSuffix = () => (state() ? ` · ${state()!.label}` : "")
    return (
      <Ui.Tooltip value={`Waiting on ${name()}${stateSuffix()}${more()}`}>
        <button
          type="button"
          class="lazers-tasks-row-blocker"
          data-blocker-kind={blocker.kind}
          tabIndex={-1}
          aria-label={`Open blocker ${name()}${state() ? `, ${state()!.label.toLowerCase()}` : ""}${more()}`}
          onClick={(event) => {
            event.stopPropagation()
            if (blocker.kind === "plan") openPrerequisitePlan(blocker.id)
            else selectTask(blocker.id)
          }}
        >
          <Ui.Icon name="link" size="small" />
        </button>
      </Ui.Tooltip>
    )
  }
  const copyTaskLink = async () => {
    const task = selectedTask()
    const detail = selectedDetail()
    if (!task || !detail) return
    try {
      await ctx.system.copy(taskMarkdownLink(detail.reference, task.provenance.projectID))
      setCopyStatus("Task link copied.")
    } catch {
      setCopyStatus("Could not copy task link.")
    }
  }
  const openSelectedTrajectory = () => {
    const task = selectedTask()
    const reference = selectedDetail()?.reference
    const value = current()
    if (!task || !reference || !value) return
    props.openTrajectory(props.session, {
      taskID: task.id,
      reference,
      projectID: task.provenance.projectID,
      projectDirectory: value.project,
    })
  }
  const selectedRow = () => {
    const selectedID = inspected()?.selectedID
    return selectedID ? rowValues().find((row) => row.taskID === selectedID) : undefined
  }
  const selectedPresentation = () => {
    const row = selectedRow()
    const activity = selectedActivity()
    if (row) return taskRowPresentation(row, activity, relationLabel)
    return taskRowPresentation(
      {
        taskID: inspected()?.selectedID ?? "",
        title: "",
        status: selectedRecordedState() ?? "submitted",
        reason: selectedExecution()?.reason ?? null,
        waiting: selectedIsWaiting(),
        holdReason: null,
        ordinal: 0,
        ...(selectedExecution()?.dispatchPause
          ? { dispatchPause: selectedExecution()!.dispatchPause }
          : {}),
        contextOnly: false,
        prerequisites: [],
        successors: [],
      },
      activity,
      relationLabel,
    )
  }
  /** The selected task's scheduling facts, with coverage text composed by the list model. */
  const selectedScheduling = () => {
    const row = selectedRow()
    if (row?.scheduling) return row.scheduling
    const node = schedulingNode(inspected()?.selectedID ?? "")
    return node
      ? {
          decision: node.decision,
          reason: node.reason,
          waitingOn: node.waitingOn,
          reservationTaskIDs: node.reservationTaskIDs,
        }
      : undefined
  }
  const selectedReservations = () => selectedScheduling()?.reservationTaskIDs ?? []
  /** Priority, plan and order of the selected task's plan; detail only, never a list decoration. */
  const selectedPlanFacts = () => {
    const taskID = inspected()?.selectedID
    if (!taskID) return undefined
    const planID = selectedExecution()?.planID
    const scheduled =
      schedulingPlans().find((plan) => plan.planID === planID) ??
      schedulingPlans().find((plan) => plan.nodes.some((node) => node.taskID === taskID))
    const topology = inspected()?.topology?.plans.find(
      (plan) => plan.id === (planID ?? scheduled?.planID),
    )
    if (scheduled)
      return {
        title: scheduled.title,
        priority: scheduled.priority,
        planOrder: scheduled.planOrder,
        step: scheduled.nodes.find((node) => node.taskID === taskID)?.ordinal,
        state: planStateLabel(scheduled.lifecycle),
      }
    if (topology)
      return {
        title: topology.title ?? `Plan ${topology.id.slice(0, 8)}`,
        priority: topology.priority ?? 0,
        planOrder: topology.queuePosition,
        step: topology.nodes.find((node) => node.taskID === taskID)?.ordinal,
        state: planStateLabel(topology.state),
      }
    return undefined
  }
  /**
   * A runtime reason as a callout: the state glyph, one user sentence and an inline Details link
   * that reveals the raw runtime text. `children` render under the sentence (reservations).
   */
  const renderReason = (reason: string, className: string, children?: () => JSX.Element) => {
    const view = taskReasonView(reason, selectedInspectorStatus())
    const [open, setOpen] = createSignal(false)
    return (
      <div
        class={`lazers-tasks-callout ${className}`}
        data-tone={selectedPresentation().tone}
        role="status"
      >
        <span class="lazers-tasks-callout-icon" data-tone={selectedPresentation().tone}>
          {renderGlyph(selectedPresentation().icon)}
        </span>
        <div class="lazers-tasks-callout-body">
          <div class="lazers-tasks-callout-text">
            {view.text}
            <Show when={view.raw}>
              <>
                {" "}
                <button
                  type="button"
                  class="lazers-tasks-callout-toggle"
                  aria-expanded={open()}
                  onClick={() => setOpen(!open())}
                >
                  Details
                </button>
              </>
            </Show>
          </div>
          <Show when={view.raw}>
            {(raw) => (
              <pre class="lazers-tasks-callout-raw" hidden={!open()}>
                {raw()}
              </pre>
            )}
          </Show>
          {children?.()}
        </div>
      </div>
    )
  }
  /** "Priority 1 · Plan name · step 2": one line for what were four fact rows. */
  const selectedMeta = () => {
    const facts = selectedPlanFacts()
    if (!facts) return ""
    return [
      facts.priority > 0 ? `Priority ${facts.priority}` : "",
      facts.title,
      facts.step !== undefined ? `step ${facts.step + 1}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
  }
  const reservationRefs = () => (
    <Show when={selectedReservations().length}>
      <div class="lazers-tasks-node-references">
        <span>Reserved by</span>
        <For each={selectedReservations().slice(0, RESERVATION_PREVIEW)}>
          {renderSchedulingReference}
        </For>
      </div>
      <Show when={selectedReservations().length > RESERVATION_PREVIEW}>
        <details class="lazers-tasks-node-references-more">
          <summary>{selectedReservations().length - RESERVATION_PREVIEW} more</summary>
          <div class="lazers-tasks-node-references">
            <For each={selectedReservations().slice(RESERVATION_PREVIEW)}>
              {renderSchedulingReference}
            </For>
          </div>
        </details>
      </Show>
    </Show>
  )
  const selectedSequencing = () => {
    const row = selectedRow()
    return taskSequencing(
      row ?? {
        taskID: inspected()?.selectedID ?? "",
        title: "",
        status: "",
        reason: null,
        waiting: false,
        holdReason: null,
        ordinal: 0,
        contextOnly: false,
        prerequisites: [...selectedRelations().prerequisites, ...selectedRelations().waitingOn],
        successors: [],
      },
    )
  }
  const renderSchedulingReference = (taskID: string) => (
    <button
      type="button"
      class="lazers-tasks-dependency-ref"
      aria-label={`Open scheduling prerequisite ${relationLabel(taskID)}`}
      title={taskID}
      style={{ "font-family": ctx.appearance.font("mono") }}
      onClick={() => selectTask(taskID)}
    >
      {relationLabel(taskID)}
    </button>
  )
  const selectedSourcePlan = () =>
    inspected()?.tasks.find((task) => task.taskID === inspected()?.selectedID)?.sourcePlan ??
    selectedRow()?.sourcePlan
  /** One contextual action leads; the rest stay one menu away. */
  const primaryAction = (): "start" | "architect" | "trajectory" => {
    if (canStart(selectedExecution()?.state ?? selectedTask()?.status ?? "")) return "start"
    if (selectedIsWaiting() && selectedDetail()?.architectSessionID) return "architect"
    return "trajectory"
  }
  const openArchitect = () => {
    const sessionID = selectedDetail()?.architectSessionID
    if (sessionID)
      ctx.tabs.open({ server: props.session.server.id, id: sessionID }, { focus: true })
  }
  const openSelectedRadar = () => {
    const task = selectedTask()
    const value = current()
    if (!task || !value) return
    const workerSessionID = selectedActivity()?.workerSessionID
    props.openRadar(props.session, {
      taskID: task.id,
      projectDirectory: value.project,
      ...(workerSessionID ? { workerSessionID } : {}),
    })
  }
  const secondaryActions = () => {
    const primary = primaryAction()
    const source = selectedSourcePlan()
    const reference = selectedDetail()?.reference
    return [
      ...(primary !== "trajectory"
        ? [
            {
              label: "Open in Trajectory",
              icon: "window-analytics" as const,
              disabled: !reference,
              onSelect: openSelectedTrajectory,
            },
          ]
        : []),
      ...(selectedActivity()?.workerSessionID ||
      ["running", "verifying"].includes(selectedRecordedState() ?? "")
        ? [{ label: "Open in Radar", icon: "eye" as const, onSelect: openSelectedRadar }]
        : []),
      ...(primary !== "architect" && selectedDetail()?.architectSessionID
        ? [{ label: "Open Architect", icon: "speech-bubble" as const, onSelect: openArchitect }]
        : []),
      ...(source
        ? [
            {
              label: "Open source plan",
              icon: "file-document" as const,
              onSelect: () => void openSourcePlan(source),
            },
          ]
        : []),
      {
        label: "Copy task link",
        icon: "link" as const,
        disabled: !reference,
        onSelect: () => void copyTaskLink(),
      },
    ]
  }
  createEffect(() => {
    selectionKey()
    setShowAllCriteria(false)
  })
  const startTask = async (taskID: string, revision: 1) => {
    const value = current()
    if (!value) return
    feedback.reset(selectionKey())
    const ticket = feedback.begin(taskID)
    if (!ticket) return
    try {
      await state.start({ taskID, revision, sessionID: props.session.id })
    } catch (error) {
      feedback.fail(ticket, error)
    } finally {
      feedback.finish(ticket)
    }
  }
  /** Bring a task's row into the viewport; offscreen rows are not mounted, so go by the model. */
  const scrollToTask = (taskID: string) => {
    const index = taskIndex(items(), taskID)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" })
  }
  let focusRequest = 0
  /** Scroll to a tree item, then focus it once the virtualizer has mounted it. */
  const focusItem = (key: string) => {
    const request = ++focusRequest
    const attempt = (remaining: number) => {
      const index = itemIndex(items(), key)
      if (request !== focusRequest || index < 0) return
      virtualizer.scrollToIndex(index, { align: "auto" })
      const element = [...(list?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])].find(
        (candidate) => candidate.dataset.itemKey === key,
      )
      if (element) element.focus({ preventScroll: true })
      else if (remaining > 0) requestAnimationFrame(() => attempt(remaining - 1))
    }
    attempt(FOCUS_ATTEMPTS)
  }
  const focusTaskRow = (taskID: string) => {
    const index = taskIndex(items(), taskID)
    if (index >= 0) focusItem(items()[index]!.key)
  }
  /** Task rows take selection with focus. */
  const goTo = (target: VirtualTaskItem | undefined) => {
    if (!target) return
    selectTask(target.row.taskID)
    focusItem(target.key)
  }
  const rowKey = (
    event: KeyboardEvent & { currentTarget: HTMLDivElement; target: Element },
    item: VirtualTaskItem,
    toggle: () => void,
  ) => {
    // Keys from the row's own controls (the blocker link) stay theirs.
    if (event.target !== event.currentTarget) return
    const taskID = item.row.taskID
    const go = (key: NavigationKey) => goTo(navigationTarget(items(), item.key, key))
    switch (event.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "Home":
      case "End":
        event.preventDefault()
        go(event.key)
        return
      case "ArrowRight":
        event.preventDefault()
        if (!item.expandable) return
        if (!item.expanded) toggle()
        else go("ArrowRight")
        return
      case "ArrowLeft":
        event.preventDefault()
        if (item.expandable && item.expanded) toggle()
        else go("ArrowLeft")
        return
      case "Enter":
      case " ":
        event.preventDefault()
        selectTask(taskID)
    }
  }
  const stateLabel = (state: NonNullable<typeof initial.state>) => {
    if (state === "failed") return "Failed / exhausted"
    if (state === "blocked") return "Blocked / waiting"
    return state[0]!.toUpperCase() + state.slice(1)
  }
  /** "23 open · 4 running": the read's own count for this filter, and running only when every task is loaded. */
  const headerCount = () => {
    const value = visible()
    if (!value?.page) return ""
    const filter = stateFilter()
    const count = String(value.page.count)
    if (filter === "all") return count
    const label = `${count} ${stateLabel(filter).toLowerCase()}`
    // The Running filter's own count from the read; absent or zero is omitted.
    const running = filter === "open" ? (value.stateCounts?.running ?? 0) : 0
    return running ? `${label} · ${running} running` : label
  }
  let focusedSelection = ""
  createEffect(() => {
    const selectedID = visible()?.selectedID
    const key = selectionKey()
    const found = visible()?.detail
    if (
      !selectedID ||
      found?.status !== "found" ||
      found.task.id !== selectedID ||
      key === focusedSelection
    )
      return
    focusedSelection = key
    queueMicrotask(() => {
      if (selectionKey() !== key) return
      focusTaskRow(selectedID)
    })
  })
  const measureTreeOffset = () => {
    if (!list || !tree) return
    setTreeOffset(
      Math.max(
        0,
        Math.round(
          tree.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop,
        ),
      ),
    )
  }
  let listObserver: ResizeObserver | undefined
  // Notes above the tree scroll with it: keep the virtualizer's origin on the tree's top.
  createEffect(() => {
    visible()
    void items().length
    void scope.error
    queueMicrotask(measureTreeOffset)
  })
  /**
   * First item intersecting the viewport top and how far its start (measured from the tree's top,
   * so growth of the header above the tree is not an anchor move) sits below it.
   */
  let anchor: { key: string; offset: number } | undefined
  let anchorView = ""
  let anchorKeys: readonly string[] = []
  const captureAnchor = () => {
    if (!list) return
    const top = list.scrollTop
    // From the layout, not the mounted window: a jump scroll fires before the window follows it.
    anchor = viewportAnchor(top, treeOffset(), virtualizer.getVirtualItemForOffset(top))
  }
  // Rows inserted or removed above the viewport (refresh) must not move what the person reads.
  // Within one view only; a new view restores its own saved scroll.
  createEffect(() => {
    const current = items()
    const view = expectedKey()
    untrack(() => {
      if (!list) return
      if (view !== anchorView) {
        anchorView = view
        anchorKeys = current.map((item) => item.key)
        anchor = undefined
        return
      }
      // Only a change of the key sequence moves rows; refreshed values and prefs writes do not.
      if (
        anchorKeys.length === current.length &&
        anchorKeys.every((key, index) => key === current[index]!.key)
      )
        return
      anchorKeys = current.map((item) => item.key)
      const keys = new Map(current.map((item, index) => [item.key, index]))
      const top = anchoredScrollTop(
        anchor,
        (key) => {
          const index = keys.get(key)
          const start =
            index === undefined ? undefined : virtualizer.measurementsCache[index]?.start
          return start === undefined ? undefined : start - treeOffset()
        },
        list.scrollTop,
      )
      if (top !== undefined) list.scrollTop = top
      captureAnchor()
    })
  })
  // Sliding the window reorders mounted nodes; moving the focused one blurs it. Focus that fell to
  // the document from a still-mounted tree item goes back to it, without scrolling.
  createEffect(() => {
    void virtualRows()
    const key = focusedTreeKey()
    if (!key) return
    queueMicrotask(() => {
      if (!tree || focusedTreeKey() !== key) return
      const active = tree.ownerDocument.activeElement
      if (active && active !== tree.ownerDocument.body) return
      const element = [...tree.querySelectorAll<HTMLElement>("[role=treeitem]")].find(
        (candidate) => candidate.dataset.itemKey === key,
      )
      element?.focus({ preventScroll: true })
    })
  })
  // The next page loads as the end of the list comes into range; each page is requested once.
  // The range is the viewport's, not the mounted rows': a pinned tab stop or focused row far below
  // the viewport must not read as "near the end".
  createEffect(() => {
    const value = visible()
    viewportEnd()
    void virtualRows().length
    const count = items().length
    const end = virtualizer.range?.endIndex
    if (!value || value.loading || !value.page?.nextCursor || end === undefined) return
    if (Math.min(end + VIRTUAL_OVERSCAN, count - 1) < count - 1 - LOAD_MORE_WITHIN) return
    void state.more(expectedKey())
  })
  onMount(() => {
    measureTreeOffset()
    if (typeof ResizeObserver === "undefined" || !root) return
    listObserver = new ResizeObserver(measureTreeOffset)
    if (list) listObserver.observe(list)
    onCleanup(() => listObserver?.disconnect())
  })
  const details = createMemo(() => {
    const view = prefs()
    return storedState({
      open: view.open,
      size: view.size ?? sizeFromLegacySplit(view.splitAdjusted ? view.split : undefined),
    })
  })
  // A failed start is an answer to something the person did; show it even if the pane is closed.
  createEffect(() => {
    if (startFeedback().error && !details().open) save({ open: true })
  })
  const detailsEmpty = () =>
    visible()?.detail?.status === "not_found"
      ? "Task is not available in this view"
      : visible()?.selectedID
        ? "Loading task…"
        : "No task selected"
  /** One line: reference, state glyph and word, then the title. Also the collapsed pane. */
  const detailsHeader = () => {
    const task = selectedTask()
    if (!task) return undefined
    return (
      <>
        <span
          class="lazers-tasks-reference"
          style={{ "font-family": ctx.appearance.font("mono") }}
          aria-label={`Task reference ${selectedDetail()?.reference ?? ""}`.trim()}
        >
          <Ui.Tooltip value={task.id}>{selectedDetail()?.reference ?? "Task"}</Ui.Tooltip>
        </span>
        <span
          class="lazers-tasks-inspector-icon"
          data-tone={selectedPresentation().tone}
          aria-hidden="true"
        >
          {renderGlyph(selectedPresentation().icon)}
        </span>
        <span
          class="lazers-tasks-inspector-state"
          data-state={selectedRecordedState()}
          data-waiting={selectedIsWaiting()}
          data-tone={selectedPresentation().tone}
          aria-label={`${selectedInspectorStatus()}${selectedRecordedState() ? `; recorded lifecycle ${selectedRecordedState()}` : ""}`}
        >
          {selectedInspectorStatus()}
        </span>
        <span class="lazers-tasks-inspector-title">
          {" · "}
          {taskTitle(task.proposal.objective)}
        </span>
      </>
    )
  }
  const detailsActions = () => {
    const task = selectedTask()
    if (!task) return undefined
    return (
      <>
        <Show when={copyStatus()}>
          <span class="lazers-tasks-copy-status" role="status">
            {copyStatus()}
          </span>
        </Show>
        <Switch>
          <Match when={primaryAction() === "start"}>
            <Ui.Button
              size="small"
              variant="ghost-muted"
              class="lazers-tasks-start"
              busy={startFeedback().taskID === task.id}
              disabled={Boolean(startFeedback().taskID)}
              aria-label={`Start ${taskTitle(task.proposal.objective)}`}
              onClick={() => void startTask(task.id, task.revision)}
            >
              Start
            </Ui.Button>
          </Match>
          <Match when={primaryAction() === "architect"}>
            <Ui.Button size="small" variant="ghost-muted" onClick={openArchitect}>
              Open Architect
            </Ui.Button>
          </Match>
          <Match when={primaryAction() === "trajectory"}>
            <Ui.Button
              size="small"
              variant="ghost-muted"
              aria-label={`Open trajectory for ${selectedDetail()?.reference ?? "selected task"}`}
              disabled={!selectedDetail()?.reference}
              onClick={openSelectedTrajectory}
            >
              Open in Trajectory
            </Ui.Button>
          </Match>
        </Switch>
        <Ui.Menu label="More task actions" items={secondaryActions()} />
      </>
    )
  }
  return (
    <div
      class="lazers-tasks"
      ref={(element) => {
        root = element
      }}
    >
      <header class="lazers-tasks-header">
        <h2>Tasks</h2>
        <Show when={headerCount()}>
          {(text) => <span class="lazers-tasks-count">{text()}</span>}
        </Show>
        <div class="lazers-tasks-controls">
          <span class="lazers-tasks-scope">
            <Ui.Menu
              label={prefs().scope === "session" ? "Session" : "Project"}
              trigger="button"
              icon="chevron-down"
              items={[
                {
                  label: "This session",
                  onSelect: () => save({ scope: "session", selectedID: null }),
                },
                {
                  label: "Project tasks",
                  onSelect: () => save({ scope: "project", selectedID: null }),
                },
              ]}
            />
          </span>
          <span class="lazers-tasks-state-filter">
            <Ui.Menu
              label={stateLabel(stateFilter())}
              trigger="button"
              icon="chevron-down"
              items={STATE_MENU.flatMap((group, index) => [
                ...(index ? [{ type: "separator" as const }] : []),
                ...group.map((state) => ({
                  label: stateLabel(state),
                  // Counts come from the read; an older server sends none and the menu omits them.
                  ...(visible()?.stateCounts?.[state] !== undefined
                    ? { keys: [String(visible()!.stateCounts![state])] }
                    : {}),
                  ...(state === stateFilter() ? { icon: "check" as const } : {}),
                  // The selection survives: it stays while the task is listed, and the inspector keeps
                  // its content otherwise.
                  onSelect: () =>
                    save({
                      state,
                      history: state !== "open",
                      listScroll: 0,
                    }),
                })),
              ])}
            />
          </span>
          <Ui.Tooltip value="Search tasks">
            <Ui.IconButton
              icon="magnifying-glass"
              label="Search tasks"
              size="small"
              pressed={searchOpen()}
              onClick={() => {
                if (searchOpen()) save({ search: "" })
                setSearchOpen(!searchOpen())
              }}
            />
          </Ui.Tooltip>
        </div>
        <Show when={searchOpen() || prefs().search}>
          <div
            class="lazers-tasks-search"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                save({ search: "" })
                setSearchOpen(false)
              }
            }}
          >
            <Ui.Icon name="magnifying-glass" size="small" />
            <Ui.TextInput
              type="search"
              label="Find tasks"
              placeholder="Search tasks…"
              value={prefs().search}
              onInput={(search) => save({ search })}
              autofocus
            />
            <Ui.IconButton
              icon="close"
              size="small"
              label="Close search"
              onClick={() => {
                save({ search: "" })
                setSearchOpen(false)
              }}
            />
          </div>
        </Show>
      </header>
      <DetailsPane
        ui={Ui}
        class="lazers-tasks-pane"
        bodyClass="lazers-tasks-detail"
        label="Resize task details"
        open={details().open}
        size={details().size}
        onOpen={(open) => save({ open })}
        onSize={(size) => save({ size })}
        empty={detailsEmpty()}
        header={detailsHeader()}
        actions={detailsActions()}
        bodyRef={setDetail}
        onBodyScroll={(event) => {
          if (detailRestore.restored(selectionKey()))
            save({ detailScroll: event.currentTarget.scrollTop })
        }}
        top={
          <div
            class="lazers-tasks-list"
            id={listID}
            ref={(element) => {
              list = element
            }}
            onScroll={(event) => {
              captureAnchor()
              if (listRestore.restored(expectedKey()))
                save({ listScroll: event.currentTarget.scrollTop })
            }}
          >
            <PanelStatus
              ui={Ui}
              status={status}
              onRetry={() => void state.refresh()}
              skeleton="rows"
            />
            <Show when={status.showContent() && visible()?.topologyError}>
              {(message) => (
                <div class="lazers-tasks-note" role="status">
                  {message()}
                </div>
              )}
            </Show>
            <Show when={status.showContent() && visible()?.activityError}>
              {(message) => (
                <div class="lazers-tasks-note" role="status">
                  {message()}
                </div>
              )}
            </Show>
            <Show when={status.showContent() && visible()?.schedulingError}>
              {(message) => (
                <div class="lazers-tasks-scheduling-warning" role="status">
                  {message()}
                </div>
              )}
            </Show>
            <Show
              when={
                status.showContent() &&
                visible() &&
                !visible()?.topology &&
                !visible()?.topologyError
              }
            >
              <div class="lazers-tasks-note" role="status">
                {visible()?.scheduling && !visible()?.schedulingError
                  ? "Execution topology unavailable. Showing scheduling-backed tasks where covered."
                  : "Execution topology unavailable. Showing tasks without dependency detail."}
              </div>
            </Show>
            <Show
              when={status.showContent() ? visible() : undefined}
              fallback={
                <Show when={!props.session.location}>
                  <div class="lazers-tasks-note">Session location is unavailable.</div>
                </Show>
              }
            >
              {(value) => (
                <>
                  <Show
                    when={listedRows(executionList()).length}
                    fallback={
                      <div class="lazers-tasks-note">
                        {prefs().search
                          ? "No matching tasks."
                          : stateFilter() === "all"
                            ? "No tasks in this view."
                            : `No ${stateLabel(stateFilter()).toLowerCase()} tasks in this ${prefs().scope === "session" ? "session" : "project"}.`}
                      </div>
                    }
                  >
                    <div
                      class="lazers-tasks-tree"
                      role="tree"
                      data-panel-dimmed={status.dimmed()}
                      aria-label={`${stateLabel(stateFilter())} tasks`}
                      style={{ height: `${virtualizer.getTotalSize()}px` }}
                      ref={(element) => {
                        tree = element
                      }}
                      onFocusIn={(event) =>
                        setFocusedTreeKey(
                          (event.target as Element).closest<HTMLElement>("[role=treeitem]")?.dataset
                            .itemKey,
                        )
                      }
                      onFocusOut={(event) => {
                        // A node the window reorders is detached for a moment and blurs; that is
                        // not the person leaving the tree, and the guard below restores focus.
                        if (!(event.target as Element).isConnected) return
                        const next = event.relatedTarget
                        if (!(next instanceof Node) || !event.currentTarget.contains(next))
                          setFocusedTreeKey(undefined)
                      }}
                    >
                      <Keyed each={virtualRows()} by={(virtual) => virtual.key}>
                        {(virtual) => (
                          <VirtualItemView
                            virtual={virtual}
                            measure={virtualizer.measureElement}
                            render={(item) => {
                              const current = () => item()
                              switch (virtual().item.kind) {
                                case "task":
                                  return renderTaskRow(current as Accessor<VirtualTaskItem>)
                                case "loader":
                                  return (
                                    <div class="lazers-tasks-loader" role="status">
                                      <Show
                                        when={value().moreError}
                                        fallback={
                                          <>
                                            <Ui.Loader size="small" />
                                            Loading more tasks…
                                          </>
                                        }
                                      >
                                        Could not load more tasks.
                                        <Ui.Button
                                          variant="ghost"
                                          onClick={() => state.retryMore(expectedKey())}
                                        >
                                          Retry
                                        </Ui.Button>
                                      </Show>
                                    </div>
                                  )
                              }
                            }}
                          />
                        )}
                      </Keyed>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </div>
        }
      >
        <Show
          when={selectedTask()}
          fallback={
            <Show
              when={visible()?.detail?.status !== "not_found" && visible()?.selectedID}
              fallback={
                <div class="lazers-tasks-note">
                  {visible()?.detail?.status === "not_found"
                    ? "Task is not available in this view."
                    : "Select a task to see its details."}
                </div>
              }
            >
              {/* First load only: the previous task's content stays until the next one arrives. */}
              <div class="lazers-tasks-detail-loading" aria-busy="true">
                <PanelSkeleton shape="rows" />
              </div>
            </Show>
          }
        >
          {(task) => (
            <>
              <Show when={startFeedback().error}>
                <p class="lazers-tasks-error" role="alert">
                  {startFeedback().error}
                </p>
              </Show>
              <h3 class="lazers-tasks-title">{taskHeading(task().proposal.objective)}</h3>
              <Show when={selectedMeta()}>
                {(meta) => <p class="lazers-tasks-meta">{meta()}</p>}
              </Show>
              <Show when={selectedSequencing().kind === "sequenced"}>
                <p class="lazers-tasks-meta">{selectedSequencing().detail}</p>
              </Show>
              <Show
                when={
                  selectedRelations().waitingOn.length || selectedRelations().waitingOnPlans.length
                }
              >
                <div class="lazers-tasks-dependencies lazers-tasks-dependencies-visible">
                  <span class="lazers-tasks-dependency-icon" aria-hidden="true">
                    <Ui.Icon name="link" size="small" />
                  </span>
                  <span>Waiting on</span>
                  <For each={selectedRelations().waitingOn}>
                    {(taskID, index) => (
                      <>
                        {index() ? ", " : ""}
                        {renderRelation(taskID)}
                      </>
                    )}
                  </For>
                  <For each={selectedRelations().waitingOnPlans}>
                    {(planID, index) => (
                      <>
                        {index() || selectedRelations().waitingOn.length ? ", " : ""}
                        {renderPlanRelation(planID)}
                      </>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={selectedExecution()?.dispatchPause}>
                {(pause) => renderReason(pause().reason, "lazers-tasks-blocker")}
              </Show>
              <Show when={selectedScheduling()?.reason || selectedReservations().length}>
                <Show
                  when={selectedScheduling()?.reason}
                  fallback={<div class="lazers-tasks-node-reason">{reservationRefs()}</div>}
                >
                  {(reason) =>
                    renderReason(reason(), "lazers-tasks-node-reason", () => reservationRefs())
                  }
                </Show>
              </Show>
              <Show
                when={
                  !selectedScheduling()?.reason &&
                  !selectedExecution()?.dispatchPause &&
                  selectedHoldReasons()[0]
                }
              >
                {renderReason(selectedHoldReasons().join("\n"), "lazers-tasks-blocker")}
              </Show>
              <Show when={objectiveExtendsTitle(task().proposal.objective)}>
                <div class="lazers-tasks-objective">
                  <Ui.Markdown text={task().proposal.objective} />
                </div>
              </Show>
              <h4>Done when</h4>
              <ul class="lazers-tasks-assertions" aria-label="Done when">
                <For
                  each={
                    showAllCriteria()
                      ? task().proposal.acceptance
                      : task().proposal.acceptance.slice(0, CRITERIA_PREVIEW)
                  }
                >
                  {(assertion) => (
                    <li>
                      {/* The read records no per-requirement result, so none is drawn as met. */}
                      <span class="lazers-tasks-check" aria-hidden="true" />
                      <div class="lazers-tasks-assertion-text">
                        <Ui.Markdown text={assertion.assertion} />
                      </div>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={task().proposal.acceptance.length > CRITERIA_PREVIEW}>
                <button
                  type="button"
                  class="lazers-tasks-more"
                  aria-expanded={showAllCriteria()}
                  onClick={() => setShowAllCriteria(!showAllCriteria())}
                >
                  {showAllCriteria()
                    ? "Show fewer"
                    : `Show all ${task().proposal.acceptance.length}`}
                </button>
              </Show>
              <details class="lazers-tasks-section">
                <summary>
                  <Ui.Icon name="chevron-right" size="small" />
                  <span class="lazers-tasks-section-label">Details</span>
                </summary>
                <details class="lazers-tasks-evidence">
                  <summary>Required evidence</summary>
                  <For each={task().proposal.acceptance}>
                    {(assertion) => (
                      <>
                        <h4>{assertion.id}</h4>
                        <For each={assertion.evidence}>
                          {(evidence) => (
                            <Ui.Markdown
                              text={
                                evidence.kind === "verification"
                                  ? `Verification: ${evidence.verificationID}`
                                  : evidence.reference
                              }
                            />
                          )}
                        </For>
                      </>
                    )}
                  </For>
                </details>
                <dl>
                  <dt>Task ID</dt>
                  <dd style={{ "font-family": ctx.appearance.font("mono") }}>{task().id}</dd>
                  <dt>Lifecycle</dt>
                  <dd>
                    Recorded lifecycle {selectedRecordedState() ?? task().status} · specification
                    revision {task().revision}
                    <Show when={selectedExecution()?.state !== selectedRecordedState()}>
                      <p>Plan status {selectedExecution()?.state}</p>
                    </Show>
                    <Show when={selectedExecution()?.reason}>
                      {(reason) => <p>Plan reason: {reason()}</p>}
                    </Show>
                  </dd>
                  <dt>Session association</dt>
                  <dd>
                    <span style={{ "font-family": ctx.appearance.font("mono") }}>
                      {task().provenance.sessionID}
                    </span>
                  </dd>
                  <Show when={selectedExecution()}>
                    {(execution) => (
                      <>
                        <dt>Plan</dt>
                        <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                          {execution().planID}
                        </dd>
                        <Show when={selectedDetail()?.attempts?.length}>
                          <dt>Attempts</dt>
                          <dd>
                            <For each={selectedDetail()?.attempts}>
                              {(attempt) => (
                                <p>
                                  {attempt.number} · {attempt.state} ·{" "}
                                  <span style={{ "font-family": ctx.appearance.font("mono") }}>
                                    {attempt.id.slice(0, 8)}
                                  </span>
                                  <Show when={attempt.artifact}>
                                    {(artifact) => (
                                      <>
                                        {" · "}
                                        <span
                                          style={{ "font-family": ctx.appearance.font("mono") }}
                                        >
                                          {artifact().slice(0, 8)}
                                        </span>
                                      </>
                                    )}
                                  </Show>
                                </p>
                              )}
                            </For>
                          </dd>
                        </Show>
                      </>
                    )}
                  </Show>
                  <dt>Repository</dt>
                  <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                    {task().provenance.projectDirectory}
                  </dd>
                  <dt>Workspace</dt>
                  <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                    {task().provenance.workspaceDirectory}
                  </dd>
                  <dt>Starting revision</dt>
                  <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                    {task().provenance.startingRevision.kind === "git"
                      ? (task().provenance.startingRevision as { kind: "git"; commit: string })
                          .commit
                      : "Unborn repository"}
                  </dd>
                  <For
                    each={
                      [
                        ["Exclusions", task().proposal.exclusions],
                        ["Constraints", task().proposal.constraints],
                        ["Assumptions", task().proposal.assumptions],
                      ] as const
                    }
                  >
                    {([label, values]) => (
                      <Show when={values.length}>
                        <dt>{label}</dt>
                        <dd>
                          <For each={values}>{(text) => <Ui.Markdown text={text} />}</For>
                        </dd>
                      </Show>
                    )}
                  </For>
                  <Show when={task().proposal.guidance}>
                    <dt>Implementation guidance (advisory)</dt>
                    <dd>
                      <Ui.Markdown text={task().proposal.guidance!} />
                    </dd>
                  </Show>
                  <dt>Write scope</dt>
                  <dd>
                    <ul
                      class="lazers-tasks-paths"
                      style={{ "font-family": ctx.appearance.font("mono") }}
                    >
                      <For each={task().proposal.writeScope}>{(path) => <li>{path}</li>}</For>
                    </ul>
                  </dd>
                  <Show when={task().proposal.context.length}>
                    <dt>Context</dt>
                    <dd>
                      <For each={task().proposal.context}>
                        {(item) => (
                          <>
                            <Ui.Markdown text={item.reference} />
                            <Show when={item.revision}>
                              <code style={{ "font-family": ctx.appearance.font("mono") }}>
                                {item.revision}
                              </code>
                            </Show>
                          </>
                        )}
                      </For>
                    </dd>
                  </Show>
                  <dt>Requirements</dt>
                  <dd>
                    <p>Risk: {task().proposal.requirements.risk}</p>
                    <Show when={task().proposal.requirements.policyReference}>
                      {(reference) => <Ui.Markdown text={reference()} />}
                    </Show>
                    <For each={task().proposal.requirements.capabilities}>
                      {(text) => <Ui.Markdown text={text} />}
                    </For>
                    <For each={task().proposal.requirements.skills}>
                      {(text) => <Ui.Markdown text={text} />}
                    </For>
                  </dd>
                  <Show when={task().proposal.verification.length}>
                    <dt>Verification</dt>
                    <dd>
                      <For each={task().proposal.verification}>
                        {(item) => (
                          <div>
                            <p>
                              {item.id} · {verificationTimingSummary(item)}
                            </p>
                            <Ui.Code content={item.command} language="bash" />
                          </div>
                        )}
                      </For>
                    </dd>
                  </Show>
                  <Show
                    when={task().proposal.limits}
                    fallback={
                      <>
                        <dt>Budget</dt>
                        <dd>Not configured</dd>
                      </>
                    }
                  >
                    {(limits) => (
                      <>
                        <dt>Historical proposed limits</dt>
                        <dd>
                          <p>
                            {limits().maxTokens.toLocaleString()} tokens · $
                            {limits().maxEstimatedCostUsd} estimated cost ·{" "}
                            {limits().maxElapsedMs / 60000} minutes
                          </p>
                          <p>
                            {limits().maxToolCalls} tool calls · {limits().maxProviderRetries}{" "}
                            provider retries · {limits().maxRepairAttempts} repairs
                          </p>
                          <p>Historical proposal; no model-based execution budget is configured.</p>
                        </dd>
                      </>
                    )}
                  </Show>
                </dl>
                <details>
                  <summary>Full specification</summary>
                  <div
                    class="lazers-tasks-json"
                    role="region"
                    aria-label="Full task specification JSON"
                    tabIndex={0}
                  >
                    <Ui.Code content={JSON.stringify(task(), null, 2)} language="json" />
                  </div>
                </details>
              </details>
              <details class="lazers-tasks-section lazers-tasks-activity-details">
                <summary>
                  <Ui.Icon name="chevron-right" size="small" />
                  <span class="lazers-tasks-section-label">Activity</span>
                  <Show when={selectedDetail()?.activity?.length}>
                    {(count) => (
                      <span class="lazers-tasks-section-count">
                        {count()} {count() === 1 ? "event" : "events"}
                      </span>
                    )}
                  </Show>
                </summary>
                <For each={selectedHoldReasons()}>
                  {(reason) => (
                    <p class="lazers-tasks-reason" role="status">
                      Waiting: {reason}
                    </p>
                  )}
                </For>
                <Show
                  when={
                    ["running", "verifying"].includes(selectedRecordedState() ?? "") ||
                    selectedIsWaiting() ||
                    selectedActivity()?.foreground === "active" ||
                    selectedActivity()?.waiting
                  }
                >
                  <div
                    class="lazers-tasks-current-activity"
                    aria-label="Recorded lifecycle and observed foreground activity"
                  >
                    <span>Recorded {selectedRecordedState()}</span>
                    <Show when={workerActivityLabel(selectedActivity())}>
                      {(label) => (
                        <span class="lazers-tasks-foreground">
                          <span
                            class="lazers-tasks-activity-indicator"
                            data-state={selectedActivity()?.foreground}
                            aria-hidden="true"
                          />
                          Worker {label()}
                        </span>
                      )}
                    </Show>
                    <Show when={selectedActivity()?.unknownReason}>
                      {(reason) => (
                        <span>
                          Observation{" "}
                          {reason() === "no-current-attempt"
                            ? "has no current attempt"
                            : "unavailable"}
                        </span>
                      )}
                    </Show>
                    <Show when={selectedActivity()?.workerSessionID}>
                      {(workerSessionID) => (
                        <span
                          class="lazers-tasks-worker"
                          aria-label={`Latest worker session ${workerSessionID()}`}
                        >
                          Latest worker{" "}
                          <code style={{ "font-family": ctx.appearance.font("mono") }}>
                            {workerSessionID()}
                          </code>
                        </span>
                      )}
                    </Show>
                    <Show when={selectedActivity()?.outcome}>
                      {(outcome) => <span>Worker outcome {outcome()}</span>}
                    </Show>
                    <Show when={selectedActivity()?.waiting}>
                      <span class="lazers-tasks-waiting">Waiting</span>
                    </Show>
                    <Show when={selectedActivity()?.pendingInput}>
                      <span>Input pending</span>
                    </Show>
                    <Show
                      when={
                        (selectedActivity()?.pendingPermissions ?? 0) > 0 ||
                        (selectedActivity()?.pendingForms ?? 0) > 0
                      }
                    >
                      <span>Approval pending</span>
                    </Show>
                  </div>
                </Show>
                <Show when={selectedRelations().prerequisites.length}>
                  <div class="lazers-tasks-dependencies">
                    <span>Prerequisites </span>
                    <For each={selectedRelations().prerequisites}>
                      {(taskID, index) => (
                        <>
                          {index() ? ", " : ""}
                          {renderRelation(taskID)}
                        </>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={selectedRelations().successors.length}>
                  <div class="lazers-tasks-dependencies">
                    <span>Blocks </span>
                    <For each={selectedRelations().successors}>
                      {(taskID, index) => (
                        <>
                          {index() ? ", " : ""}
                          {renderRelation(taskID)}
                        </>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={selectedRelations().planPrerequisites.length}>
                  <div class="lazers-tasks-dependencies">
                    <span>
                      Plan waits for
                      {selectedRelations().planPrerequisitesComplete
                        ? " "
                        : ` (showing ${selectedRelations().planPrerequisites.length} of ${selectedRelations().planPrerequisitesCount} prerequisite plans) `}
                    </span>
                    <For each={selectedRelations().planPrerequisites}>
                      {(planID, index) => (
                        <>
                          {index() ? ", " : ""}
                          {renderPlanRelation(planID)}
                        </>
                      )}
                    </For>
                  </div>
                </Show>
                <p>
                  Submitted {new Date(task().createdAt).toLocaleString()} ·{" "}
                  <span style={{ "font-family": ctx.appearance.font("mono") }}>
                    {task().provenance.sessionID}
                  </span>
                </p>
                <For each={selectedDetail()?.activity ?? []}>
                  {(event) => (
                    <div class="lazers-tasks-event">
                      <div>
                        <strong>{event.event}</strong>
                        <time dateTime={new Date(event.createdAt).toISOString()}>
                          {new Date(event.createdAt).toLocaleString()}
                        </time>
                      </div>
                      <Ui.Code content={event.payload} language="json" />
                    </div>
                  )}
                </For>
              </details>
            </>
          )}
        </Show>
      </DetailsPane>
    </div>
  )
}

/**
 * `openRadar` selects the worker when a caller can write Radar's view; without one, Tasks opens
 * the Radar panel itself and leaves Radar's own selection untouched.
 */
export function setupTaskPanel(
  ctx: TaskContext,
  openTrajectory: TaskTrajectoryOpener,
  openRadar: TaskRadarOpener = (session) =>
    ctx.layout.open(`${ctx.id}:radar`, session, { tab: "select" }),
) {
  const Ui = ctx.ui
  ctx.add(
    LinkHandler,
    createTaskLinkHandler({
      session(source) {
        return ctx.sessions
          .list()
          .find((session) => session.id === source.id && session.server.id === source.server.id)
      },
      async project(session, signal) {
        const server = ctx.servers.get(session.server.id)
        if (!server?.connected || !session.location) throw new Error("Task link session is offline")
        const location = await server.client.location.get(
          { location: session.location },
          { signal },
        )
        return location.project
      },
      get(session, reference, signal) {
        const server = ctx.servers.get(session.server.id)
        if (!server?.connected || !session.location) throw new Error("Task link session is offline")
        return server.client
          .rpc(Tasks)
          .get({ taskID: reference }, { location: session.location, signal })
      },
      signal: () => AbortSignal.any([ctx.signal, AbortSignal.timeout(5_000)]),
      open(target) {
        const session = ctx.sessions
          .list()
          .find(
            (candidate) =>
              candidate.id === target.session.id &&
              candidate.server.id === target.session.server.id &&
              candidate.location?.directory === target.sessionDirectory,
          )
        if (!session) return
        const store = ctx.stores.taskView(session)
        store.update((draft) => {
          const view = draft.projects[target.projectDirectory] ?? initial
          draft.projects[target.projectDirectory] = {
            ...view,
            scope: "project",
            search: "",
            selectedID: target.taskID,
            detailScroll: 0,
            revealTaskID: target.taskID,
          }
        })
        ctx.layout.open(`${ctx.id}:tasks`, session, { tab: "select" })
      },
    }),
  )
  // One stable tab object, like the host tabs: a session switch never renders its label again.
  // The tab keeps `title` as its accessible name and closable hover button; the label adds the
  // themed native icon so the strip reads like the review, browser, terminal, and file tabs.
  const tab = {
    id: "tasks",
    title: "Tasks",
    closable: "hover" as const,
    label: () => (
      <div class="flex items-center gap-1.5">
        <Ui.Icon name="task" size="small" />
        <span>Tasks</span>
      </div>
    ),
  }
  const open = () => {
    const session = ctx.sessions.current()
    if (session?.location) ctx.layout.open(`${ctx.id}:tasks`, session, { tab: "select" })
  }
  ctx.add(Style, css)
  ctx.add(Panel, {
    id: "tasks",
    region: "side",
    list: (input) => (input.open.includes(tab.id) ? [tab] : []),
    render: bindPlugin((props: PanelProps) => (
      <TaskPanel {...props} ctx={ctx} openTrajectory={openTrajectory} openRadar={openRadar} />
    )),
  })
  ctx.add(Command, {
    id: "tasks.open",
    title: "Open LAZERS tasks",
    section: "session",
    slash: { name: "lz-tasks" },
    run: open,
  })
  // Native `session.panel` items list in ascending `order` (Review 10, Browser 15, Terminal 20,
  // Files 30); Tasks 40 places it last in the extra-panel + menu.
  ctx.add(MenuItem, {
    id: "tasks.open",
    menu: "session.panel",
    title: "Tasks",
    icon: "task",
    order: 40,
    run: open,
  })
}
