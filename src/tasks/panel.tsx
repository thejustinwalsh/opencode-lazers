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
import { TaskPanelState } from "./panel-state.ts"
import { taskChanges } from "./events.ts"
import type { PanelData } from "./panel-state.ts"
import {
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  clampSplit,
  contentSplit,
  splitFromPointer,
  splitWasAdjusted,
} from "./panel-layout.ts"
import { taskTitle, sourcePlanLine } from "./presentation.ts"
import { createTaskLinkHandler, taskMarkdownLink } from "./links.ts"
import {
  StartFeedback,
  ScrollRestoration,
  canStart,
  connectionLabel,
  workerActivityLabel,
} from "./panel-view.ts"
import {
  attentionLabel,
  distinctReasons,
  isRingGlyph,
  rowHoldReasons,
  taskRowPresentation,
  taskRowBlocker,
  taskStateTooltip,
} from "./row-presentation.ts"
import { buildExecutionList, selectForkForTask } from "./execution-list.ts"
import type { ExecutionListRow, ExecutionPlanGroup } from "./execution-list.ts"
import type { TaskBlocker, TaskGlyph, TaskRowPresentation } from "./row-presentation.ts"
import { TaskRing } from "./state-glyph.tsx"
import { ExecutionPlanHeading } from "./execution-list-view.tsx"
import {
  LOADER_HEIGHT,
  anchoredScrollTop,
  viewportAnchor,
  estimateItemSize,
  flattenExecutionList,
  itemIndex,
  navigationTarget,
  planHeaded,
  planOfTask,
  taskIndex,
  taskItems,
  taskKey,
  treeItems,
} from "./virtual-rows.ts"
import type {
  NavigationKey,
  TreeItem,
  VirtualItem,
  VirtualPlanItem,
  VirtualTaskItem,
} from "./virtual-rows.ts"
import type { TaskTrajectoryTarget } from "../trajectory-panel/panel-state.ts"
import { preferredTaskStateFilter } from "./state-filter.ts"
import { Keyed } from "./keyed.ts"
import css from "./panel.css?inline"

const View = Schema.Struct({
  scope: Schema.Literals(["session", "project"]),
  selectedID: Schema.NullOr(Schema.String),
  search: Schema.String,
  split: Schema.Number,
  /** Set once the person resizes; until then the split follows the list's content. */
  splitAdjusted: Schema.optionalKey(Schema.Boolean),
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
      "failed",
      "cancelled",
      "all",
    ]),
  ),
  history: Schema.optionalKey(Schema.Boolean),
  collapsedForks: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  revealTaskID: Schema.optionalKey(Schema.String),
})
const initial: typeof View.Type = {
  scope: "session",
  selectedID: null,
  search: "",
  split: SPLIT_DEFAULT,
  listScroll: 0,
  detailScroll: 0,
  history: false,
  collapsedForks: {},
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
/** Request the next page once the last rendered item is this close to the end of the list. */
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
  const [dragSplit, setDragSplit] = createSignal<number | null>(null)
  const [paneHeight, setPaneHeight] = createSignal(0)
  const [showAllCriteria, setShowAllCriteria] = createSignal(false)
  const listID = createUniqueId()
  const detailID = createUniqueId()
  const [startFeedback, setStartFeedback] = createSignal({ taskID: "", error: "" })
  const [copyStatus, setCopyStatus] = createSignal("")
  const [revealedTaskIDs, setRevealedTaskIDs] = createSignal<Set<string>>(new Set())
  const [temporarilyExpandedForks, setTemporarilyExpandedForks] = createSignal<Set<string>>(
    new Set(),
  )
  const [temporarilyCollapsedForks, setTemporarilyCollapsedForks] = createSignal<Set<string>>(
    new Set(),
  )
  /** Plans whose heading is collapsed; per view, never persisted. */
  const [collapsedPlans, setCollapsedPlans] = createSignal<Set<string>>(new Set())
  /** Where the tree starts inside the scrolling list, below Now/Attention/Next and notes. */
  const [treeOffset, setTreeOffset] = createSignal(0)
  const feedback = new StartFeedback(setStartFeedback)
  const listRestore = new ScrollRestoration()
  const detailRestore = new ScrollRestoration()
  let root: HTMLDivElement | undefined
  let header: HTMLElement | undefined
  let list: HTMLDivElement | undefined
  let tree: HTMLDivElement | undefined
  let head: HTMLDivElement | undefined
  let separator: HTMLDivElement | undefined
  let detail: HTMLDivElement | undefined
  let endDrag: (() => void) | undefined
  const scope = createLatest(
    () => {
      if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
      return {
        client: props.session.server.client,
        session: props.session.id,
        server: props.session.server.id,
        directory: props.session.directory,
      }
    },
    async (source, signal) => {
      const location = await source.client.location.get(
        { location: { directory: source.directory } },
        { signal },
      )
      return { ...source, project: location.project.canonical }
    },
  )
  const current = () => {
    if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
    const value = scope.latest
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
  const state = new TaskPanelState(setData, (selectedID) =>
    save({
      selectedID,
      detailScroll: selectedID === prefs().selectedID ? prefs().detailScroll : 0,
    }),
  )
  onCleanup(() => {
    state.close()
    feedback.reset("")
    listRestore.restore("", false, undefined, 0)
    detailRestore.restore("", false, undefined, 0)
    endDrag?.()
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
  let revealIdentity = ""
  createEffect(() => {
    const key = expectedKey()
    if (key === revealIdentity) return
    revealIdentity = key
    setRevealedTaskIDs(new Set<string>())
    setTemporarilyExpandedForks(new Set<string>())
    setTemporarilyCollapsedForks(new Set<string>())
    setCollapsedPlans(new Set<string>())
  })
  const visible = () => (data().key === expectedKey() ? data() : undefined)
  const selectionKey = () => JSON.stringify([expectedKey(), visible()?.selectedID])
  const executionList = createMemo(() =>
    buildExecutionList({
      topology: visible()?.topology,
      tasks: visible()?.tasks ?? [],
      scheduling: visible()?.scheduling,
      search: prefs().search,
      revealTaskIDs: revealedTaskIDs(),
    }),
  )
  const schedulingPlans = () => visible()?.scheduling?.plans ?? []
  const schedulingNode = (taskID: string) =>
    schedulingPlans()
      .flatMap((plan) => plan.nodes)
      .find((node) => node.taskID === taskID)
  const schedulingPlan = (planID: string | undefined) =>
    planID ? schedulingPlans().find((plan) => plan.planID === planID) : undefined
  /**
   * Every row in the model, including branches of collapsed forks: Now and Attention membership
   * must not depend on what is expanded. Selecting an entry reveals its fork.
   */
  const signalRows = createMemo(() => {
    const model = executionList()
    const rows: ExecutionListRow[] = []
    const visit = (taskRow: ExecutionListRow) => {
      rows.push(taskRow)
      for (const branch of taskRow.fork?.branches ?? [])
        for (const child of branch.rows) visit(child)
    }
    for (const group of model.plans) for (const taskRow of group.rows) visit(taskRow)
    rows.push(...model.unplanned)
    return rows
  })
  /** A native input/approval request on an open task: it asks the person now. */
  const asksForAttention = (row: ExecutionListRow) =>
    taskRowPresentation(row, visible()?.currentActivity[row.taskID]).tone === "attention"
  /** Foreground work; a worker blocked on the person moves to Attention instead. */
  const nowRows = () =>
    signalRows().filter(
      (row) =>
        visible()?.currentActivity[row.taskID]?.foreground === "active" && !asksForAttention(row),
    )
  /**
   * Native input/approval requests lead Attention (they ask the person now, even while the worker is
   * foreground), then recorded waits. Membership only reads recorded state; it never reorders work.
   */
  const attentionRows = () => {
    const held = (row: ExecutionListRow) =>
      visible()?.currentActivity[row.taskID]?.foreground !== "active" &&
      (row.waiting ||
        visible()?.currentActivity[row.taskID]?.waiting === true ||
        row.scheduling?.decision === "waiting")
    const rows = signalRows()
    return [
      ...rows.filter(asksForAttention),
      ...rows.filter((row) => !asksForAttention(row) && held(row)),
    ]
  }
  const signalTabStopTaskID = () => nowRows()[0]?.taskID ?? attentionRows()[0]?.taskID
  const nextStatus = () => {
    const value = visible()
    if (!value?.scheduling || value.schedulingError || value.stale)
      return { status: "unknown" as const }
    return value.scheduling.next
  }
  const nextCandidate = () => {
    const next = nextStatus()
    return next.status === "known" ? next.candidate : undefined
  }
  const openPrerequisitePlan = (planID: string) => {
    const firstTask = schedulingPlan(planID)?.nodes.toSorted((a, b) => a.ordinal - b.ordinal)[0]
    if (firstTask) selectTask(firstTask.taskID)
  }
  const forkPreferenceKey = (planID: string, forkID: string) => {
    const value = current()
    return JSON.stringify([
      value?.server,
      value?.project,
      value?.session,
      prefs().scope,
      planID,
      forkID,
    ])
  }
  const forkExpanded = (group: ExecutionPlanGroup, row: ExecutionListRow) => {
    if (!row.fork) return false
    const key = forkPreferenceKey(group.planID, row.fork.id)
    const saved = (prefs().collapsedForks ?? {})[key] === false
    const searchReveal = Boolean(
      prefs().search &&
      row.fork.branches.some((branch) => branch.rows.some((child) => !child.contextOnly)),
    )
    if (prefs().search && temporarilyCollapsedForks().has(key)) return false
    return saved || searchReveal || temporarilyExpandedForks().has(key)
  }
  const revealTask = (taskID: string) => {
    setRevealedTaskIDs((current) => new Set([...current, taskID]))
    const group = buildExecutionList({
      topology: visible()?.topology,
      tasks: visible()?.tasks ?? [],
      scheduling: visible()?.scheduling,
      search: prefs().search,
      revealTaskIDs: new Set([taskID]),
    })
    const fork = selectForkForTask(group.plans, taskID)
    if (fork) {
      const key = forkPreferenceKey(fork.planID, fork.forkID)
      if (prefs().search) {
        setTemporarilyExpandedForks((current) => new Set([...current, key]))
        setTemporarilyCollapsedForks((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      } else {
        save({ collapsedForks: { ...(prefs().collapsedForks ?? {}), [key]: false } })
      }
    }
    const planID = planOfTask(executionList(), taskID) ?? planOfTask(group, taskID)
    if (planID && collapsedPlans().has(planID))
      setCollapsedPlans((current) => {
        const next = new Set(current)
        next.delete(planID)
        return next
      })
    queueMicrotask(() => scrollToTask(taskID))
  }
  const togglePlan = (planID: string) =>
    setCollapsedPlans((current) => {
      const next = new Set(current)
      if (!next.delete(planID)) next.add(planID)
      return next
    })
  const selectTask = (taskID: string) => {
    revealTask(taskID)
    void state.select(taskID)
  }
  const toggleFork = (group: ExecutionPlanGroup, row: ExecutionListRow) => {
    if (!row.fork) return
    const key = forkPreferenceKey(group.planID, row.fork.id)
    const expanded = forkExpanded(group, row)
    if (prefs().search) {
      const nextExpanded = !expanded
      setTemporarilyExpandedForks((current) => {
        const next = new Set(current)
        if (nextExpanded) next.add(key)
        else next.delete(key)
        return next
      })
      setTemporarilyCollapsedForks((current) => {
        const next = new Set(current)
        if (nextExpanded) next.delete(key)
        else next.add(key)
        return next
      })
    } else {
      save({ collapsedForks: { ...(prefs().collapsedForks ?? {}), [key]: expanded } })
    }
    setTemporarilyExpandedForks((current) => {
      const next = new Set(current)
      if (!prefs().search) next.delete(key)
      return next
    })
  }
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
      value?.detail?.status === "found",
      detail,
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
    const result = visible()?.detail
    return result?.status === "found" ? result.task : undefined
  }
  const selectedExecution = () => {
    const detail = visible()?.detail
    return detail?.status === "found" ? detail.execution : undefined
  }
  const selectedDetail = () => {
    const result = visible()?.detail
    return result?.status === "found" ? result : undefined
  }
  const selectedActivity = () => {
    const taskID = visible()?.selectedID
    return taskID ? visible()?.currentActivity[taskID] : undefined
  }
  const selectedRecordedState = () => {
    const taskID = visible()?.selectedID
    const execution = selectedExecution()
    const node = visible()
      ?.topology?.plans.find((plan) => plan.id === execution?.planID)
      ?.nodes.find((item) => item.taskID === taskID)
    return (
      selectedDetail()?.recordedState ?? node?.state ?? execution?.state ?? selectedTask()?.status
    )
  }
  const selectedIsWaiting = () => {
    const recordedState = selectedRecordedState()
    if (recordedState && terminalLifecycleStates.has(recordedState)) return false
    const taskID = visible()?.selectedID
    const execution = selectedExecution()
    const plan = visible()?.topology?.plans.find((item) => item.id === execution?.planID)
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
    const taskID = visible()?.selectedID
    const execution = selectedExecution()
    const plan = visible()?.topology?.plans.find((item) => item.id === execution?.planID)
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
        : (selectedRecordedState() ?? "Unknown")
  const selectedRelations = () => {
    const taskID = visible()?.selectedID
    const waitSet = new Set([
      ...(selectedExecution()?.waitingOn ?? []),
      ...(taskID ? (schedulingNode(taskID)?.waitingOn ?? []) : []),
    ])
    const waitingOn = [...waitSet]
    const waitingSet = new Set(waitingOn)
    const prerequisites = new Set<string>()
    const successors = new Set<string>()
    for (const plan of visible()?.topology?.plans ?? [])
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
      planPrerequisites: schedulingPlan(selectedExecution()?.planID)?.afterPlans ?? [],
    }
  }
  const relationLabel = (taskID: string) =>
    visible()?.tasks.find((task) => task.taskID === taskID)?.reference ??
    visible()?.linkedDetails[taskID]?.reference ??
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
  const rowValues = createMemo(() => {
    const model = executionList()
    const rows: ExecutionListRow[] = []
    const visit = (taskRow: ExecutionListRow, group?: ExecutionPlanGroup) => {
      rows.push(taskRow)
      if (!group || !taskRow.fork || !forkExpanded(group, taskRow)) return
      for (const branch of taskRow.fork.branches)
        for (const child of branch.rows) visit(child, group)
    }
    for (const group of model.plans) for (const taskRow of group.rows) visit(taskRow, group)
    rows.push(...model.unplanned)
    return rows
  })
  /** The whole list as one flat sequence; only a window of it is ever mounted. */
  const hasMore = () => Boolean(visible()?.page?.nextCursor)
  const items = createMemo(() =>
    flattenExecutionList({
      model: executionList(),
      collapsedPlans: collapsedPlans(),
      forkExpanded,
      hasMore: hasMore(),
    }),
  )
  const itemByKey = createMemo(() => new Map(items().map((item) => [item.key, item])))
  const focusTaskID = createMemo(() => {
    const rows = taskItems(items())
    const selectedID = visible()?.selectedID
    return rows.some((item) => item.row.taskID === selectedID) ? selectedID : rows[0]?.row.taskID
  })
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
    overscan: VIRTUAL_OVERSCAN,
    // The tabbable row stays mounted so Tab can always enter the tree.
    get rangeExtractor() {
      const current = items()
      const id = focusTaskID()
      const pinned = id ? taskIndex(current, id) : -1
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indexes = defaultRangeExtractor(range)
        return pinned >= 0 && !indexes.includes(pinned)
          ? [...indexes, pinned].toSorted((left, right) => left - right)
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
  /** With no task row listed (every plan collapsed), the first heading keeps the tree's stop. */
  const planTabIndex = (key: string) =>
    !focusTaskID() && treeItems(items())[0]?.key === key ? 0 : -1
  const rowTabIndex = (taskID: string) => {
    return taskID === focusTaskID() ? 0 : -1
  }
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
  /** A listed task's row state (collapsed forks included); tasks outside the list stay neutral. */
  const listedPresentation = (taskID: string): TaskRowPresentation | undefined => {
    const listed = signalRows().find((row) => row.taskID === taskID)
    return listed
      ? taskRowPresentation(listed, visible()?.currentActivity[taskID], relationLabel)
      : undefined
  }
  const renderTaskRow = (item: Accessor<VirtualTaskItem>): JSX.Element => {
    const taskRow = () => item().row
    const expandable = () => item().expandable
    const expanded = () => item().expanded
    const toggle = () => {
      const group = item().group
      if (group) toggleFork(group, taskRow())
    }
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
      const branches = taskRow().fork?.branches.length ?? 0
      return [
        ...(taskRow().reference ? [taskRow().reference] : []),
        taskTitle(taskRow().title),
        `recorded lifecycle ${taskRow().status}`,
        ...(showWorker()
          ? [
              `observed foreground activity ${activity?.foreground ?? "unknown"}`,
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
        ...(expandable() ? [`${branches} parallel branch${branches === 1 ? "" : "es"}`] : []),
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
        data-branch-first={item().branch?.first}
        data-branch-last={item().branch?.last}
        aria-level={item().level}
        aria-setsize={item().setSize}
        aria-posinset={item().posInSet}
        aria-selected={taskRow().taskID === visible()?.selectedID}
        aria-expanded={expandable() ? expanded() : undefined}
        aria-label={accessibleDescription()}
        tabIndex={rowTabIndex(taskRow().taskID)}
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
            <span
              class="lazers-tasks-disclosure"
              aria-hidden="true"
              title={expanded() ? "Collapse parallel work" : "Expand parallel work"}
              onClick={(event) => {
                event.stopPropagation()
                toggle()
              }}
            >
              <Ui.Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
            </span>
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
          <span class="lazers-tasks-row-title">{taskTitle(taskRow().title)}</span>
          <Show when={taskRowBlocker(presentation())}>
            {(blocker) => renderBlockerLink(blocker(), presentation().blockerTotal)}
          </Show>
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
          data-tone={state()?.tone}
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
  const renderSignalRow = (taskRow: ExecutionListRow, label: "Now" | "Attention") => {
    const activity = () => visible()?.currentActivity[taskRow.taskID]
    const presentation = () => taskRowPresentation(taskRow, activity(), relationLabel)
    const reason = () => rowHoldReasons(taskRow, activity()).join("; ")
    const waiting = () =>
      Boolean(taskRow.waiting || activity()?.waiting || taskRow.scheduling?.decision === "waiting")
    const selected = () => taskRow.taskID === visible()?.selectedID
    return (
      <div class="lazers-tasks-schedule-entry" data-selected={selected()}>
        <button
          type="button"
          class="lazers-tasks-schedule-select"
          data-scheduling-task-id={taskRow.taskID}
          data-scheduling-group={label.toLowerCase()}
          aria-pressed={selected()}
          aria-label={`${label}: ${taskTitle(taskRow.title)}, recorded lifecycle ${taskRow.status}${activity() ? `, observed foreground activity ${activity()!.foreground}` : ""}${waiting() ? `, waiting${reason() ? `: ${reason()}` : ""}` : ""}`}
          tabIndex={taskRow.taskID === signalTabStopTaskID() ? 0 : -1}
          onKeyDown={signalKey}
          onClick={() => selectTask(taskRow.taskID)}
        >
          <span
            class="lazers-tasks-state"
            data-state={taskRow.status}
            data-waiting={waiting()}
            data-tone={presentation().tone}
            aria-hidden="true"
            title={taskStateTooltip(presentation())}
          >
            {renderGlyph(presentation().icon)}
          </span>
          <span class="lazers-tasks-schedule-entry-title">{taskTitle(taskRow.title)}</span>
        </button>
        <Show when={label === "Attention" && taskRowBlocker(presentation())}>
          {(blocker) => renderBlockerLink(blocker(), presentation().blockerTotal)}
        </Show>
      </div>
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
    const selectedID = visible()?.selectedID
    return selectedID ? rowValues().find((row) => row.taskID === selectedID) : undefined
  }
  const selectedPresentation = () => {
    const row = selectedRow()
    const activity = selectedActivity()
    if (row) return taskRowPresentation(row, activity, relationLabel)
    return taskRowPresentation(
      {
        taskID: visible()?.selectedID ?? "",
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
    const node = schedulingNode(visible()?.selectedID ?? "")
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
    visible()?.tasks.find((task) => task.taskID === visible()?.selectedID)?.sourcePlan ??
    selectedRow()?.sourcePlan
  /** One contextual action leads; the rest stay one menu away. */
  const primaryAction = (): "start" | "architect" | "radar" | "trajectory" => {
    if (canStart(selectedExecution()?.state ?? selectedTask()?.status ?? "")) return "start"
    if (selectedIsWaiting() && selectedDetail()?.architectSessionID) return "architect"
    if (["running", "verifying"].includes(selectedRecordedState() ?? "")) return "radar"
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
              label: "Open trajectory",
              icon: "window-analytics" as const,
              disabled: !reference,
              onSelect: openSelectedTrajectory,
            },
          ]
        : []),
      ...(primary !== "radar" &&
      (selectedActivity()?.workerSessionID ||
        ["running", "verifying"].includes(selectedRecordedState() ?? ""))
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
  const focusTaskRow = (taskID: string) => focusItem(taskKey(taskID))
  const moveTo = (taskID: string) => {
    selectTask(taskID)
    focusTaskRow(taskID)
  }
  /** Task rows take selection with focus; a plan heading only takes focus. */
  const goTo = (target: TreeItem | undefined) => {
    if (target?.kind === "task") moveTo(target.row.taskID)
    else if (target) focusItem(target.key)
  }
  const planKeyDown = (
    event: KeyboardEvent & { currentTarget: HTMLDivElement; target: Element },
    item: VirtualPlanItem,
  ) => {
    // Keys from the heading's own controls (prerequisite plan links) stay theirs.
    if (event.target !== event.currentTarget) return
    switch (event.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "Home":
      case "End":
        event.preventDefault()
        goTo(navigationTarget(items(), item.key, event.key))
        return
      case "ArrowRight":
        event.preventDefault()
        if (item.collapsed) togglePlan(item.group.planID)
        else goTo(navigationTarget(items(), item.key, "ArrowRight"))
        return
      case "ArrowLeft":
        event.preventDefault()
        if (!item.collapsed) togglePlan(item.group.planID)
        return
      case "Enter":
      case " ":
        event.preventDefault()
        togglePlan(item.group.planID)
    }
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
  /** Now/Attention/Next entries form one short list above the tree; Down from the last enters it. */
  const signalKey: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const entries = [
      ...(list?.querySelectorAll<HTMLButtonElement>("[data-scheduling-task-id]") ?? []),
    ]
    const index = entries.indexOf(event.currentTarget)
    if (event.key === "ArrowDown" && index === entries.length - 1) {
      const first = taskItems(items())[0]
      if (first) moveTo(first.row.taskID)
      return
    }
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? entries.length - 1
          : Math.max(0, Math.min(entries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
    entries[next]?.focus()
    const id = entries[next]?.dataset.schedulingTaskId
    if (id) selectTask(id)
  }
  const stateLabel = (state: NonNullable<typeof initial.state>) => {
    if (state === "failed") return "Failed / exhausted"
    if (state === "blocked") return "Blocked / waiting"
    return state[0]!.toUpperCase() + state.slice(1)
  }
  let focusedSelection = ""
  createEffect(() => {
    const selectedID = visible()?.selectedID
    const key = selectionKey()
    if (!selectedID || visible()?.detail?.status !== "found" || key === focusedSelection) return
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
  // Everything above the tree scrolls with it: keep the virtualizer's origin on the tree's top.
  createEffect(() => {
    visible()
    void nowRows().length
    void attentionRows().length
    nextStatus()
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
  // The next page loads as the end of the list comes into range; each page is requested once.
  createEffect(() => {
    const value = visible()
    const last = virtualRows().at(-1)
    if (!value || value.loading || !value.page?.nextCursor || !last) return
    if (last.index < items().length - 1 - LOAD_MORE_WITHIN) return
    void state.more(expectedKey())
  })
  const measure = () => {
    if (!root) return
    setPaneHeight(
      root.getBoundingClientRect().height -
        (header?.getBoundingClientRect().height ?? 0) -
        (separator?.getBoundingClientRect().height ?? 0),
    )
  }
  onMount(() => {
    measure()
    measureTreeOffset()
    if (typeof ResizeObserver === "undefined" || !root) return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    if (header) observer.observe(header)
    onCleanup(() => observer.disconnect())
    listObserver = new ResizeObserver(measureTreeOffset)
    if (list) listObserver.observe(list)
    if (head) listObserver.observe(head)
    onCleanup(() => listObserver?.disconnect())
  })
  // Hold the last fitted value while a view loads so the divider does not jump to its minimum.
  // Fit the listed content, not the disclosure state: collapsing a plan does not move the divider.
  const autoSplit = createMemo<number>((previous) => {
    const value = visible()
    if (!value || value.loading) return previous
    return contentSplit({
      rows: rowValues().length,
      headings: executionList().plans.filter(planHeaded).length,
      extra: 16 + (value.page?.nextCursor ? LOADER_HEIGHT : 0),
      available: paneHeight(),
    })
  }, SPLIT_DEFAULT)
  const split = () => {
    const dragged = dragSplit()
    if (dragged !== null) return dragged
    const view = prefs()
    return splitWasAdjusted(view) ? clampSplit(view.split) : autoSplit()
  }
  const commitSplit = (next: number) => save({ split: clampSplit(next), splitAdjusted: true })
  const drag: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    endDrag?.()
    const key = expectedKey()
    event.currentTarget.setPointerCapture(event.pointerId)
    const element = event.currentTarget
    const move = (moveEvent: PointerEvent) => {
      const rect = root?.getBoundingClientRect()
      if (rect)
        setDragSplit(
          splitFromPointer(
            split(),
            rect.top,
            rect.height,
            header?.getBoundingClientRect().height ?? 0,
            separator?.getBoundingClientRect().height ?? 0,
            moveEvent.clientY,
          ),
        )
    }
    const end = () => {
      element.removeEventListener("pointermove", move)
      element.removeEventListener("pointerup", end)
      element.removeEventListener("pointercancel", end)
      if (expectedKey() === key) commitSplit(split())
      setDragSplit(null)
      endDrag = undefined
    }
    element.addEventListener("pointermove", move)
    element.addEventListener("pointerup", end, { once: true })
    element.addEventListener("pointercancel", end, { once: true })
    endDrag = end
  }
  return (
    <div
      class="lazers-tasks"
      ref={(element) => {
        root = element
      }}
      style={{
        "--task-list-fr": `${split()}fr`,
        "--task-detail-fr": `${100 - split()}fr`,
      }}
    >
      <header
        class="lazers-tasks-header"
        ref={(element) => {
          header = element
        }}
      >
        <h2>Tasks</h2>
        <span
          class="lazers-tasks-dot"
          data-stale={visible()?.stale || !props.session.server.connected}
          role="img"
          aria-label={connectionLabel(Boolean(visible()?.stale), props.session.server.connected)}
        />
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
              label={`State: ${stateLabel(stateFilter())}`}
              trigger="button"
              icon="chevron-down"
              items={(
                [
                  "open",
                  "queued",
                  "running",
                  "blocked",
                  "paused",
                  "completed",
                  "failed",
                  "cancelled",
                  "all",
                ] as const
              ).map((state) => ({
                label: stateLabel(state),
                onSelect: () =>
                  save({
                    state,
                    history: state !== "open",
                    selectedID: null,
                    listScroll: 0,
                  }),
              }))}
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
        <Show when={scope.error || visible()?.error}>
          <div class="lazers-tasks-note lazers-tasks-error" role="alert">
            {String(scope.error ?? visible()?.error)}
            <Ui.Button variant="ghost" onClick={() => void state.refresh()}>
              Retry
            </Ui.Button>
          </div>
        </Show>
        <Show when={visible()?.stale}>
          <div class="lazers-tasks-note" role="status">
            Updates disconnected. Displayed tasks may be stale.
          </div>
        </Show>
        <Show when={visible()?.topologyError}>
          {(message) => (
            <div class="lazers-tasks-note" role="status">
              {message()}
            </div>
          )}
        </Show>
        <Show when={visible()?.activityError}>
          {(message) => (
            <div class="lazers-tasks-note" role="status">
              {message()}
            </div>
          )}
        </Show>
        <Show when={visible()?.schedulingError}>
          {(message) => (
            <div class="lazers-tasks-scheduling-warning" role="status">
              {message()}
            </div>
          )}
        </Show>
        <Show when={visible() && !visible()?.topology && !visible()?.topologyError}>
          <div class="lazers-tasks-note" role="status">
            {visible()?.scheduling && !visible()?.schedulingError
              ? "Execution topology unavailable. Showing scheduling-backed groups where covered."
              : "Execution topology unavailable. Showing tasks without grouping."}
          </div>
        </Show>
        <Show
          when={visible()}
          fallback={
            <div class="lazers-tasks-note">
              {!props.session.location ? (
                "Session location is unavailable."
              ) : (
                <Ui.Loader size="small" />
              )}
            </div>
          }
        >
          {(value) => (
            <>
              <Show
                when={!value().loading}
                fallback={
                  <div class="lazers-tasks-note">
                    <Ui.Loader size="small" />
                  </div>
                }
              >
                <Show
                  when={rowValues().length || value().scheduling}
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
                    class="lazers-tasks-schedule-groups"
                    ref={(element) => {
                      head = element
                      listObserver?.observe(element)
                    }}
                  >
                    <Show when={nowRows().length}>
                      <section class="lazers-tasks-schedule-group" aria-label="Now">
                        <h3 class="lazers-tasks-schedule-heading">
                          Now
                          <span class="lazers-tasks-schedule-count">{nowRows().length}</span>
                        </h3>
                        <For each={nowRows()}>{(taskRow) => renderSignalRow(taskRow, "Now")}</For>
                      </section>
                    </Show>
                    <Show when={attentionRows().length}>
                      <section class="lazers-tasks-schedule-group" aria-label="Attention">
                        <h3 class="lazers-tasks-schedule-heading">
                          Attention
                          <span class="lazers-tasks-schedule-count">{attentionRows().length}</span>
                        </h3>
                        <For each={attentionRows()}>
                          {(taskRow) => renderSignalRow(taskRow, "Attention")}
                        </For>
                      </section>
                    </Show>
                    <Show when={value().scheduling || value().schedulingError}>
                      <section class="lazers-tasks-schedule-group" aria-label="Next">
                        <h3 class="lazers-tasks-schedule-heading">Next</h3>
                        <Show
                          when={nextCandidate()}
                          fallback={
                            <div class="lazers-tasks-scheduling-warning" role="status">
                              {nextStatus().status === "none"
                                ? "No eligible task is currently selected."
                                : "Next is unknown; scheduling coverage is unavailable or incomplete."}
                            </div>
                          }
                        >
                          {(candidate) => {
                            const presentation = () =>
                              listedPresentation(candidate().taskID) ?? {
                                tone: "ready" as const,
                                icon: "ring-dot" as const,
                                label: "Eligible",
                              }
                            const order = () =>
                              `Priority ${candidate().priority} · plan ${candidate().planOrder + 1}, step ${candidate().ordinal + 1}`
                            return (
                              <div
                                class="lazers-tasks-schedule-entry"
                                data-selected={candidate().taskID === value().selectedID}
                              >
                                <button
                                  type="button"
                                  class="lazers-tasks-schedule-select"
                                  data-scheduling-task-id={candidate().taskID}
                                  data-scheduling-group="next"
                                  aria-label={`Next: ${candidate().reference ?? candidate().taskID.slice(0, 8)} ${taskTitle(candidate().title)}, priority ${candidate().priority}, plan order ${candidate().planOrder + 1}, node order ${candidate().ordinal + 1}`}
                                  aria-pressed={candidate().taskID === value().selectedID}
                                  tabIndex={
                                    rowValues().some((row) => row.taskID === candidate().taskID)
                                      ? -1
                                      : 0
                                  }
                                  onKeyDown={signalKey}
                                  onClick={() => selectTask(candidate().taskID)}
                                >
                                  <span
                                    class="lazers-tasks-state"
                                    data-tone={presentation().tone}
                                    aria-hidden="true"
                                  >
                                    {renderGlyph(presentation().icon)}
                                  </span>
                                  <span class="lazers-tasks-schedule-entry-title">
                                    {taskTitle(candidate().title)}
                                  </span>
                                  <span
                                    class="lazers-tasks-schedule-entry-meta"
                                    title={order()}
                                    style={{ "font-family": ctx.appearance.font("mono") }}
                                  >
                                    P{candidate().priority}
                                  </span>
                                </button>
                              </div>
                            )
                          }}
                        </Show>
                      </section>
                    </Show>
                  </div>
                  <div
                    class="lazers-tasks-tree"
                    role="tree"
                    aria-label={`${stateLabel(stateFilter())} tasks`}
                    data-forks={rowValues().some((row) => Boolean(row.fork))}
                    style={{ height: `${virtualizer.getTotalSize()}px` }}
                    ref={(element) => {
                      tree = element
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
                              case "plan": {
                                const plan = () =>
                                  current() as Extract<VirtualItem, { kind: "plan" }>
                                return (
                                  <ExecutionPlanHeading
                                    group={plan().group}
                                    stateFilter={stateFilter()}
                                    collapsed={plan().collapsed}
                                    setSize={plan().setSize}
                                    posInSet={plan().posInSet}
                                    tabIndex={planTabIndex(plan().key)}
                                    onToggle={() => togglePlan(plan().group.planID)}
                                    onKeyDown={(event) => planKeyDown(event, plan())}
                                    onOpenPlan={openPrerequisitePlan}
                                    planTitle={(planID) => schedulingPlan(planID)?.title}
                                  />
                                )
                              }
                              case "note":
                                return (
                                  <div class="lazers-tasks-branch-note" role="none">
                                    {
                                      (current() as Extract<VirtualItem, { kind: "note" }>)
                                        .hiddenCount
                                    }{" "}
                                    more not in this page or filter
                                  </div>
                                )
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
              </Show>
            </>
          )}
        </Show>
      </div>
      <div
        class="lazers-tasks-separator"
        ref={(element) => {
          separator = element
        }}
        role="separator"
        aria-label="Resize task list"
        aria-orientation="horizontal"
        aria-controls={`${listID} ${detailID}`}
        aria-valuemin={SPLIT_MIN}
        aria-valuemax={SPLIT_MAX}
        aria-valuenow={Math.round(split())}
        aria-valuetext={`Task list ${Math.round(split())}% of the panel`}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          const step: Record<string, number> = {
            ArrowUp: -5,
            ArrowDown: 5,
            PageUp: -10,
            PageDown: 10,
          }
          if (event.key === "Home") commitSplit(SPLIT_MIN)
          else if (event.key === "End") commitSplit(SPLIT_MAX)
          else if (step[event.key] !== undefined) commitSplit(split() + step[event.key]!)
          else return
          event.preventDefault()
        }}
      />
      <div
        class="lazers-tasks-detail"
        id={detailID}
        ref={(element) => {
          detail = element
        }}
        onScroll={(event) => {
          if (detailRestore.restored(selectionKey()))
            save({ detailScroll: event.currentTarget.scrollTop })
        }}
      >
        <Show
          when={selectedTask()}
          fallback={
            <div class="lazers-tasks-note">
              {visible()?.detail?.status === "not_found"
                ? "Task is not available in this view."
                : visible()?.selectedID
                  ? "Loading task…"
                  : "Select a task to see its details."}
            </div>
          }
        >
          {(task) => (
            <>
              <div class="lazers-tasks-inspector-head">
                <span
                  class="lazers-tasks-reference"
                  style={{ "font-family": ctx.appearance.font("mono") }}
                  aria-label={`Task reference ${selectedDetail()?.reference ?? "unknown"}`}
                >
                  <Ui.Tooltip value={task().id}>{selectedDetail()?.reference ?? "Task"}</Ui.Tooltip>
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
                  aria-label={`${selectedInspectorStatus()}${selectedRecordedState() ? `; recorded lifecycle ${selectedRecordedState()}` : ""}`}
                >
                  {selectedInspectorStatus()}
                </span>
                <span class="lazers-tasks-inspector-actions">
                  <Switch>
                    <Match when={primaryAction() === "start"}>
                      <Ui.Button
                        size="small"
                        variant="ghost-muted"
                        class="lazers-tasks-start"
                        busy={startFeedback().taskID === task().id}
                        disabled={Boolean(startFeedback().taskID)}
                        aria-label={`Start ${taskTitle(task().proposal.objective)}`}
                        onClick={() => void startTask(task().id, task().revision)}
                      >
                        Start
                      </Ui.Button>
                    </Match>
                    <Match when={primaryAction() === "architect"}>
                      <Ui.Button size="small" variant="ghost-muted" onClick={openArchitect}>
                        Open Architect
                      </Ui.Button>
                    </Match>
                    <Match when={primaryAction() === "radar"}>
                      <Ui.Button
                        size="small"
                        variant="ghost-muted"
                        aria-label={`Open ${selectedDetail()?.reference ?? "selected task"} in Radar`}
                        onClick={openSelectedRadar}
                      >
                        Open in Radar
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
                        Open trajectory
                      </Ui.Button>
                    </Match>
                  </Switch>
                  <Ui.Menu label="More task actions" items={secondaryActions()} />
                </span>
              </div>
              <Show when={copyStatus()}>
                <p class="lazers-tasks-reason" role="status">
                  {copyStatus()}
                </p>
              </Show>
              <Show when={startFeedback().error}>
                <p class="lazers-tasks-error" role="alert">
                  {startFeedback().error}
                </p>
              </Show>
              <h3 class="lazers-tasks-title" title={task().proposal.objective}>
                {taskTitle(task().proposal.objective)}
              </h3>
              <Show when={selectedExecution()?.dispatchPause}>
                {(pause) => (
                  <p class="lazers-tasks-blocker" data-kind="pause" title={pause().reason}>
                    Paused · {pause().reason}
                  </p>
                )}
              </Show>
              <Show
                when={
                  selectedRelations().waitingOn.length || selectedRelations().waitingOnPlans.length
                }
              >
                <div class="lazers-tasks-dependencies lazers-tasks-dependencies-visible">
                  <span
                    class="lazers-tasks-dependency-icon"
                    data-tone={
                      selectedRelations().waitingOn[0]
                        ? listedPresentation(selectedRelations().waitingOn[0]!)?.tone
                        : undefined
                    }
                    aria-hidden="true"
                  >
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
              <Show when={selectedScheduling()?.reason || selectedReservations().length}>
                <div class="lazers-tasks-node-reason" aria-label="Scheduling reason">
                  <Show when={selectedScheduling()?.reason}>
                    {(reason) => <p class="lazers-tasks-node-reason-text">{reason()}</p>}
                  </Show>
                  <Show when={selectedReservations().length}>
                    <div class="lazers-tasks-node-references">
                      <span>Reserved by</span>
                      <For each={selectedReservations().slice(0, RESERVATION_PREVIEW)}>
                        {renderSchedulingReference}
                      </For>
                    </div>
                    <Show when={selectedReservations().length > RESERVATION_PREVIEW}>
                      <details class="lazers-tasks-node-references-more">
                        <summary>
                          {selectedReservations().length - RESERVATION_PREVIEW} more
                        </summary>
                        <div class="lazers-tasks-node-references">
                          <For each={selectedReservations().slice(RESERVATION_PREVIEW)}>
                            {renderSchedulingReference}
                          </For>
                        </div>
                      </details>
                    </Show>
                  </Show>
                </div>
              </Show>
              <Show
                when={
                  !selectedScheduling()?.reason &&
                  !selectedExecution()?.dispatchPause &&
                  selectedHoldReasons()[0]
                }
              >
                {(reason) => (
                  <p class="lazers-tasks-blocker" title={selectedHoldReasons().join("; ")}>
                    {reason().trim().split(/\r?\n/)[0]}
                  </p>
                )}
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
                      <Ui.Markdown text={assertion.assertion} />
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
              <details class="lazers-tasks-section lazers-tasks-activity-details">
                <summary>
                  <Ui.Icon name="chevron-right" size="small" />
                  Activity and holds
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
                    <span class="lazers-tasks-foreground">
                      <span
                        class="lazers-tasks-activity-indicator"
                        data-state={selectedActivity()?.foreground ?? "unknown"}
                        aria-hidden="true"
                      />
                      Worker {workerActivityLabel(selectedActivity())}
                    </span>
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
                    <span>Plan waits for </span>
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
              </details>
              <details class="lazers-tasks-section">
                <summary>
                  <Ui.Icon name="chevron-right" size="small" />
                  Details
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
                                  : evidence.kind === "artifact"
                                    ? evidence.reference
                                    : evidence.decision
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
              <details class="lazers-tasks-section">
                <summary>
                  <Ui.Icon name="chevron-right" size="small" />
                  Activity
                </summary>
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
      </div>
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
