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
import { refusalMessage } from "../audit/fallow-refusal.ts"
import { linkSignal, linkedSession } from "../link-host.ts"
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
  createRoot,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  untrack,
} from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { TaskProposal } from "../task.ts"
import { Tasks } from "./contract.ts"
import { Streams } from "../streams/contract.ts"
import { TASK_ROW_HEIGHT } from "./panel-layout.ts"
import { createStream, readWindow, rpcStreamsTransport, type StreamsRpc } from "../streams/gui.ts"
import {
  readActivityPayload,
  readCurrentActivity,
  readTaskDetail,
  type PanelActivity,
  type WindowRead,
} from "./detail-read.ts"
import { taskDetailRef, taskScheduleRef } from "../streams/sources/tasks-ref.ts"
import { TaskSpecSchema } from "../task.ts"
import { TaskPanelState } from "./panel-state.ts"
import { createSelectedFacts, createTaskList, type TaskList } from "./panel-streams.ts"
import { taskChanges } from "./events.ts"
import type { TasksPanelData } from "./panel-state.ts"
import { DetailsPane } from "../details-pane.tsx"
import { sizeFromLegacySplit, storedState } from "../details-pane.ts"
import { createPanelStatus, PanelSkeleton, PanelStatus } from "../panel-status.tsx"
import { taskTitle, taskHeading, sourcePlanLine } from "./presentation.ts"
import { createTaskLinkHandler, taskMarkdownLink } from "./links.ts"
import { StartFeedback, ScrollRestoration, canStart } from "./panel-view.ts"
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
import type { ExecutionListRow } from "./task-row.ts"
import type { TaskBlocker, TaskGlyph, TaskRowPresentation } from "./row-presentation.ts"
import { TaskRing } from "./state-glyph.tsx"
import {
  anchoredScrollTop,
  viewportAnchor,
  estimateItemSize,
  itemIndex,
  navigationTarget,
  taskIndex,
  taskItems,
} from "./virtual-rows.ts"
import type { NavigationKey, VirtualItem, VirtualTaskItem } from "./virtual-rows.ts"
import type { TaskTrajectoryTarget } from "../trajectory-panel/panel-state.ts"
import { preferredTaskStateFilter } from "./state-filter.ts"
import { Keyed } from "./keyed.ts"
import {
  ActivityLane,
  Callout,
  Disclosure,
  Label,
  Identifiers,
  Progress,
  Section,
  StatRow,
} from "../details/index.ts"
import { taskExplanation, taskStateView } from "./task-state.ts"
import { PROGRESS_STEPS, taskProgress } from "./task-progress.ts"
import { attemptLane, taskStats } from "./stats.ts"
import { criterionLine } from "./criterion.ts"
import { eventLabel } from "./history.ts"
import { REFERENCE_EXACT } from "../projects/code.ts"
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
  /** The task of the first row in view; the list reopens around it. */
  anchorTaskID: Schema.optionalKey(Schema.String),
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

/** Done when lists this many one-line criteria; explicit expansion shows every one. */
const CRITERIA_PREVIEW = 6

/** History rows mounted at most; the count above them names the whole. */
const HISTORY_LIMIT = 100

/** A check's authored time limits as one phrase; limits left to the project default are omitted. */
function checkTiming(check: TaskProposal["verification"][number]) {
  return [
    check.inactivityTimeoutMs !== undefined
      ? `stops after ${check.inactivityTimeoutMs / 1000}s idle`
      : "",
    check.hardTimeoutMs !== undefined ? `at most ${check.hardTimeoutMs / 1000}s` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** The goal repeats only when it says more than the derived title. */
type ScopeReview = { divergences: string[]; accepted: string[]; reason: string | undefined }

/** The recorded scope divergence and the Architect's decision, read from the task's activity. */
function scopeReview(
  activity: readonly { event: string; payload?: string }[] | undefined,
): ScopeReview {
  const parse = (payload: string): Record<string, unknown> => {
    try {
      return JSON.parse(payload) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const paths = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap((item) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { path?: unknown }).path === "string"
            ? [(item as { path: string }).path]
            : [],
        )
      : []
  const reported = activity?.findLast((event) => event.event === "SCOPE_REPORTED")
  const amended = activity?.findLast((event) => event.event === "SCOPE_AMENDED")
  const report = reported?.payload ? parse(reported.payload) : {}
  const reason = amended?.payload ? parse(amended.payload).reason : undefined
  return {
    divergences: [...paths(report.divergences), ...paths(report.accepted)],
    accepted: paths(report.accepted),
    reason: typeof reason === "string" ? reason : undefined,
  }
}

function objectiveExtendsTitle(objective: string) {
  return taskTitle(objective) !== objective.trim().replace(/\s+/g, " ")
}

/** Rows rendered beyond the viewport on each side. */
const VIRTUAL_OVERSCAN = 8
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

/** Rows the list shows before its viewport is measured. */
const INITIAL_FIT_ROWS = 20
/** Slide the window by this many rows when the view comes this near an end of it. */
const SLIDE_ROWS = 25
const SLIDE_TRIGGER = 8

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
  const [data, setData] = createSignal<TasksPanelData>({
    key: "",
    currentActivity: {},
    activityError: "",
    stale: false,
    error: "",
  })
  /** The streams of the connected view; absent until a view connects. */
  const [taskList, setList] = createSignal<TaskList>()
  /** Reads one History row's payload when it opens; absent until a view connects. */
  const [readPayload, setReadPayload] =
    createSignal<(taskID: string, planID: string, id: number) => Promise<string | undefined>>()
  const [facts, setFacts] = createSignal<ReturnType<typeof createSelectedFacts>>()
  /** Rows that fit in the list's viewport; the stream window follows it. */
  const [fit, setFit] = createSignal(INITIAL_FIT_ROWS)
  /** Epoch ms of the last list frame; the shown tasks were current then. */
  const [asOf, setAsOf] = createSignal<number>()
  /** A task a person asked to see: the list moves to it once its place is known. */
  const [pendingReveal, setPendingReveal] = createSignal<string>()
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [showAllCriteria, setShowAllCriteria] = createSignal(false)
  const listID = createUniqueId()
  const [startFeedback, setStartFeedback] = createSignal({ taskID: "", error: "" })
  const [copyStatus, setCopyStatus] = createSignal("")
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
    return { ...source, project: location.project.canonical }
  })
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
  })
  createKeyed(
    () => {
      const value = current()
      if (!value || !frame.visible() || !ctx.stores.taskView(props.session).ready()) {
        return undefined
      }
      // The connection holds the scope; a search or a state chip only moves the list's own stream.
      const key = JSON.stringify([value.server, value.project, value.session, prefs().scope])
      return { value, key }
    },
    ({ value, key }) => {
      const view = prefs()
      const rpc = () => props.session.server.client.rpc(Tasks)
      const location = { directory: value.directory }
      const streams = new AbortController()
      const transport = rpcStreamsTransport(
        () => props.session.server.client.rpc(Streams) as unknown as StreamsRpc,
        streams.signal,
        { location },
      )
      const taskScope = { kind: view.scope, sessionID: value.session }
      /** One-shot windows for the detail and the activity, cancelled with their read. */
      const streamsRead =
        (signal: AbortSignal): WindowRead =>
        (source, options) =>
          readWindow(
            rpcStreamsTransport(
              () => props.session.server.client.rpc(Streams) as unknown as StreamsRpc,
              signal,
              { location },
            ),
            source,
            options,
          )
      setReadPayload(
        () => (taskID: string, planID: string, id: number) =>
          readActivityPayload(streamsRead(streams.signal), {
            project: value.project,
            scope: taskScope,
            taskID,
            planID,
            id,
          }),
      )
      setList(
        createTaskList({
          transport,
          project: value.project,
          scope: taskScope,
          search: () => prefs().search,
          state: stateFilter,
          fit,
          expanded: expandedKeys,
          startAt: untrack(() => prefs().anchorTaskID),
        }),
      )
      setFacts(
        createSelectedFacts({
          transport,
          project: value.project,
          scope: taskScope,
          taskID: () => data().selectedID,
        }),
      )
      state.connect(
        key,
        value.project,
        {
          get: (taskID, signal) =>
            readTaskDetail(
              streamsRead(signal),
              { project: value.project, scope: taskScope, taskID },
              { payloads: "scope" },
            ),
          currentActivity: (taskIDs, signal) =>
            readCurrentActivity(streamsRead(signal), {
              project: value.project,
              scope: taskScope,
              taskIDs,
            }),
          start: (input, signal) => rpc().start(input, { location, signal }),
          changes: (signal) => taskChanges(value.client.event, value.project, signal),
          online: () => props.session.server.connected,
        },
        view.selectedID ?? undefined,
      )
      onCleanup(() => {
        state.close()
        streams.abort()
        setList(undefined)
        setFacts(undefined)
      })
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )
  const expectedKey = () => {
    const value = current()
    return value ? JSON.stringify([value.server, value.project, value.session, prefs().scope]) : ""
  }
  /** The list a person is looking at: another search, chip or scope is another list. */
  const listKey = () => {
    const key = expectedKey()
    return key ? JSON.stringify([key, prefs().search, stateFilter()]) : ""
  }
  // Disclosure starts over only for another list (scope, filter, search, session, project). A
  // transient gap with no view (a reconnect) keeps it for its return.
  let listIdentity = ""
  createEffect(() => {
    const key = listKey()
    if (!key || key === listIdentity) return
    listIdentity = key
    setExpandedKeys(new Set<string>())
  })
  const visible = () => (data().key === expectedKey() ? data() : undefined)
  const selectionKey = () => JSON.stringify([expectedKey(), visible()?.selectedID])
  // One clock for every elapsed cell, once a minute; only those cells read it.
  const [minute, setMinute] = createSignal(Date.now())
  const minuteTimer = setInterval(() => setMinute(Date.now()), 60_000)
  onCleanup(() => clearInterval(minuteTimer))
  createEffect(() => {
    const current = taskList()
    if (!current?.loaded()) return
    current.schedule.revision()
    setAsOf(Date.now())
  })
  const status = createPanelStatus(() => {
    const value = visible()
    const streamError = taskList()?.error()
    const error = scope.error
      ? String(scope.error)
      : (value?.error ?? "") || (streamError ? streamError.message : "")
    return {
      subject: "tasks",
      hasContent: Boolean(taskList()?.loaded()),
      loading: !scope.error && !taskList()?.loaded() && !error,
      disconnected: Boolean(value?.stale) || !props.session.server.connected,
      ...(error ? { error } : {}),
      ...(asOf() ? { asOf: asOf()! } : {}),
    }
  })
  /** The rows of the list's window, and the selected task's own row when it is outside it. */
  const listRows = createMemo(
    () =>
      taskList()
        ?.rows()
        .map(({ row }) => row) ?? [],
  )
  const selectedRow = (): ExecutionListRow | undefined => {
    const selectedID = visible()?.selectedID
    if (!selectedID) return undefined
    const own = facts()?.row()
    return own?.taskID === selectedID ? own : listRows().find((row) => row.taskID === selectedID)
  }
  const openPrerequisitePlan = async (planID: string) => {
    const first = await firstTaskOfPlan(planID)
    if (first) chooseTask(first)
  }
  /** The first step of a plan: a one-shot read of its tasks in plan order. */
  const firstTaskOfPlan = (planID: string) =>
    new Promise<string | undefined>((resolve) => {
      const value = current()
      if (!value) return resolve(undefined)
      createRoot((dispose) => {
        const stream = createStream(
          rpcStreamsTransport(
            () => props.session.server.client.rpc(Streams) as unknown as StreamsRpc,
            AbortSignal.timeout(10_000),
            { location: { directory: value.directory } },
          ),
          taskScheduleRef,
          () => ({
            filter: {
              project: value.project,
              scope: { kind: prefs().scope, sessionID: value.session },
              planID,
              state: "all" as const,
              includeRetired: true,
            },
            order: "plan",
            window: 1,
          }),
        )
        createEffect(() => {
          if (!stream.loaded() && !stream.error()) return
          const [first] = stream.items()
          resolve(first ? String(first.task_id) : undefined)
          dispose()
        })
      })
    })
  const revealTask = (taskID: string) => {
    setPendingReveal(taskID)
    queueMicrotask(() => scrollToTask(taskID))
  }
  // A task outside the window: the list moves to it once the task's own row says where it sorts.
  createEffect(() => {
    const taskID = pendingReveal()
    if (!taskID) return
    const l = taskList()
    const own = facts()?.row()
    if (!l?.loaded()) return
    if (taskIndex(l.items(), taskID) >= 0) {
      setPendingReveal(undefined)
      scrollToTask(taskID)
      return
    }
    if (own?.taskID === taskID) l.reveal(taskID, own.bucket)
  })
  const selectTask = (taskID: string) => {
    revealTask(taskID)
    void state.select(taskID)
  }
  /** A person chose this task (click, Enter, a link): select it and open the details pane. */
  const chooseTask = (taskID: string) => {
    if (!storedState({ open: prefs().open }).open) save({ open: true })
    selectTask(taskID)
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
    if (!value || !taskList()?.loaded() || handledReveal === taskID) return
    handledReveal = taskID
    save({ revealTaskID: "", open: true })
    if (value.selectedID === taskID) {
      revealTask(taskID)
      focusTaskRow(taskID)
    } else selectTask(taskID)
  })
  // A list starts at its top; a window slides, so a stored offset means nothing in a new one.
  createEffect(() => {
    const value = visible()
    listRestore.restore(listKey(), Boolean(value && taskList()?.loaded()), list, 0)
    detailRestore.restore(
      selectionKey(),
      value?.detail?.status === "found" &&
        value.detail.task.id === value.selectedID &&
        Boolean(detail()),
      detail(),
      prefs().detailScroll,
    )
  })
  // A list reopened around the task that was first in view scrolls back to it, once.
  let anchoredList = ""
  createEffect(() => {
    const key = listKey()
    void items()
    void virtualRows()
    const id = untrack(() => prefs().anchorTaskID)
    if (!key || anchoredList === key || !taskList()?.loaded() || !listRestore.restored(key)) return
    anchoredList = key
    const index = id ? taskIndex(items(), id) : -1
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" })
  })
  /** Remember the task of the first row in view, for the next time this list opens. */
  const rememberFirstRow = () => {
    if (!list || anchoredList !== listKey()) return
    const first = virtualizer.getVirtualItemForOffset(list.scrollTop)
    const item = first ? items()[first.index] : undefined
    if (!item || item.kind !== "task") return
    const taskID = item.key.split(">")[0]!.replace(/^task:/, "")
    if (taskID !== prefs().anchorTaskID) save({ anchorTaskID: taskID })
  }
  createEffect(() => feedback.reset(selectionKey()))
  createEffect(() => {
    const value = current()
    if (!value || !frame.visible() || !ctx.stores.taskView(props.session).ready()) return
    const selectedID = prefs().selectedID ?? undefined
    if (data().key !== expectedKey() || data().selectedID === selectedID || !selectedID) return
    void state.select(selectedID)
  })
  // With nothing selected, the first row is.
  createEffect(() => {
    const [first] = listRows()
    if (!first || !taskList()?.loaded() || visible()?.selectedID || !visible()) return
    void state.select(first.taskID)
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
  const selectedRecordedState = () =>
    selectedDetail()?.recordedState ??
    selectedRow()?.status ??
    selectedExecution()?.state ??
    selectedTask()?.status
  const selectedIsWaiting = () => {
    const recordedState = selectedRecordedState()
    if (recordedState && terminalLifecycleStates.has(recordedState)) return false
    return Boolean(
      selectedActivity()?.waiting ||
      selectedRow()?.waiting ||
      selectedExecution()?.state === "blocked" ||
      selectedRow()?.scheduling?.decision === "waiting",
    )
  }
  const selectedHoldReasons = () => {
    const activity = selectedActivity()
    const row = selectedRow()
    return selectedIsWaiting()
      ? distinctReasons([
          activity?.waiting ? activity.holdReason : null,
          row?.waiting ? row.holdReason : null,
          facts()?.plan()?.reason,
          selectedExecution()?.reason,
          row?.scheduling?.decision === "waiting" ? row.scheduling.reason : null,
        ])
      : []
  }
  const selectedRelations = () => {
    const waitingOn = [
      ...new Set([
        ...(selectedExecution()?.waitingOn ?? []),
        ...(facts()?.blockers() ?? []).map((blocker) => blocker.taskID),
      ]),
    ]
    const waitingSet = new Set(waitingOn)
    const plan = facts()?.plan()
    return {
      prerequisites: (facts()?.prerequisites() ?? [])
        .map((related) => related.taskID)
        .filter((taskID) => !waitingSet.has(taskID)),
      waitingOn,
      waitingOnPlans: (facts()?.waits() ?? []).map((wait) => wait.planID),
      successors: (facts()?.successors() ?? []).map((related) => related.taskID),
      planPrerequisites: (facts()?.afterPlans() ?? []).map((after) => after.planID),
      planPrerequisitesCount: plan?.afterPlansCount ?? plan?.afterPlans.length ?? 0,
      planPrerequisitesComplete: true,
    }
  }
  /** The reference of every task a relation or a listed row names. */
  const references = createMemo(() => {
    const byID = new Map<string, string>()
    const add = (related: { taskID: string; reference?: string }) => {
      if (related.reference) byID.set(related.taskID, related.reference)
    }
    for (const row of listRows()) add(row)
    const own = facts()
    for (const related of [
      ...(own?.blockers() ?? []),
      ...(own?.prerequisites() ?? []),
      ...(own?.successors() ?? []),
    ])
      add(related)
    return byID
  })
  const relationLabel = (taskID: string) => references().get(taskID) ?? taskID.slice(0, 8)
  const planTitle = (planID: string) =>
    facts()
      ?.afterPlans()
      .find((plan) => plan.planID === planID)?.title ||
    facts()
      ?.waits()
      .find((wait) => wait.planID === planID)?.title ||
    undefined
  const renderRelation = (taskID: string) => {
    const reference = createMemo(() => relationLabel(taskID))
    return (
      <Show
        when={REFERENCE_EXACT.test(reference()) && selectedTask()}
        fallback={
          <button
            type="button"
            class="lazers-tasks-dependency-ref"
            aria-label={`Open related task ${reference()}`}
            onClick={() => chooseTask(taskID)}
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
    const title = planTitle(planID) ?? `Plan ${planID.slice(0, 8)}`
    return (
      <button
        type="button"
        class="lazers-tasks-dependency-ref"
        aria-label={`Open prerequisite ${title}`}
        title={planID}
        onClick={() => void openPrerequisitePlan(planID)}
      >
        {title}
      </button>
    )
  }
  /** The whole list as one flat sequence; only a window of it is ever mounted. */
  const items = createMemo(() => taskList()?.items() ?? [])
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
    const listed = listRows().find((row) => row.taskID === taskID)
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
        ...(taskRow().concern ? [`concern: ${taskRow().concern!.line}`] : []),
        ...(taskRow().takeover ? ["takeover"] : []),
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
          chooseTask(taskRow().taskID)
        }}
      >
        <div
          class="lazers-tasks-row"
          data-tone={presentation().tone}
          data-concern={taskRow().concern ? "true" : undefined}
        >
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
            <Show when={taskRow().stale}>
              <span
                class="lazers-tasks-row-stale"
                title="This row could not be refreshed; it shows its last values."
              >
                Stale
              </span>
            </Show>
            <Show when={taskRow().concern}>
              {(concern) => (
                <Label tone="warning" title={`Concern: ${concern().line}`}>
                  Concern
                </Label>
              )}
            </Show>
            <Show when={taskRow().takeover}>
              <Label tone="interactive" title="The Architect is finishing this task itself">
                Takeover
              </Label>
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
                data-tone={
                  taskRow().concern &&
                  ["running", "ready", "scheduled"].includes(presentation().tone)
                    ? "attention"
                    : presentation().tone
                }
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
        ? (planTitle(blocker.id) ?? `Plan ${blocker.id.slice(0, 8)}`)
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
            if (blocker.kind === "plan") void openPrerequisitePlan(blocker.id)
            else chooseTask(blocker.id)
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
  const selectedPresentation = () => {
    const row = selectedRow()
    const activity = selectedActivity()
    if (row) return taskStateView(row, activity, relationLabel)
    return taskStateView(
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
  /** The selected task's scheduling facts, from its stored row. */
  const selectedScheduling = () => selectedRow()?.scheduling
  const selectedReservations = () => selectedScheduling()?.reservationTaskIDs ?? []
  /** Priority, plan and order of the selected task's plan; detail only, never a list decoration. */
  const selectedPlanFacts = () => {
    const plan = facts()?.plan()
    const row = selectedRow()
    if (!visible()?.selectedID || !plan) return undefined
    return {
      title: plan.title || `Plan ${plan.id.slice(0, 8)}`,
      priority: plan.priority,
      step: row?.ordinal,
      state: planStateLabel(plan.state),
    }
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
  const selectedSequencing = () =>
    taskSequencing({
      taskID: visible()?.selectedID ?? "",
      title: "",
      status: "",
      reason: null,
      waiting: false,
      holdReason: null,
      ordinal: 0,
      contextOnly: false,
      ...selectedRow(),
      prerequisites: [...selectedRelations().prerequisites, ...selectedRelations().waitingOn],
      successors: [],
    })
  const renderSchedulingReference = (taskID: string) => (
    <button
      type="button"
      class="lazers-tasks-dependency-ref"
      aria-label={`Open scheduling prerequisite ${relationLabel(taskID)}`}
      title={taskID}
      style={{ "font-family": ctx.appearance.font("mono") }}
      onClick={() => chooseTask(taskID)}
    >
      {relationLabel(taskID)}
    </button>
  )
  const selectedSourcePlan = () => selectedRow()?.sourcePlan
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
      const result = await state.start({ taskID, revision, sessionID: props.session.id })
      if (result.status === "refused") feedback.fail(ticket, new Error(refusalMessage(result)))
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
        chooseTask(taskID)
    }
  }
  const stateLabel = (state: NonNullable<typeof initial.state>) => {
    if (state === "failed") return "Failed / exhausted"
    if (state === "blocked") return "Blocked / waiting"
    return state[0]!.toUpperCase() + state.slice(1)
  }
  /** "23 open · 4 running": the stored counters for this filter; none while a search narrows it. */
  const headerCount = () => {
    const count = taskList()?.chipCount(stateFilter())
    if (count === undefined) return ""
    const filter = stateFilter()
    if (filter === "all") return String(count)
    const label = `${count} ${stateLabel(filter).toLowerCase()}`
    // Running is shown next to Open; zero is omitted.
    const running = filter === "open" ? (taskList()?.chipCount("running") ?? 0) : 0
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
    if (list) setFit(Math.max(INITIAL_FIT_ROWS, Math.ceil(list.clientHeight / TASK_ROW_HEIGHT) + 1))
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
    // At the top with rows still before the window: a slide prepends them, so hold the first task.
    if (!anchor && top <= 0 && taskList()?.before() !== 0) {
      const first = virtualizer.getVirtualItemForOffset(treeOffset() + 1)
      const item = first ? items()[first.index] : undefined
      const next = item?.kind === "loader" ? items()[first!.index + 1] : item
      const measured = next
        ? virtualizer.measurementsCache[items().indexOf(next)]?.start
        : undefined
      if (next && measured !== undefined)
        anchor = { key: next.key, offset: measured - treeOffset() - top }
    }
  }
  // Rows inserted or removed above the viewport (refresh) must not move what the person reads.
  // Within one view only; a new view restores its own saved scroll.
  createEffect(() => {
    const current = items()
    const view = listKey()
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
  // The window follows the view: as the viewport nears either end of the rows held, the window
  // slides a quarter of its height toward it. The range is the viewport's, not the mounted rows':
  // a pinned tab stop or focused row far away must not read as "near the end".
  createEffect(() => {
    const current = taskList()
    viewportEnd()
    void virtualRows().length
    const count = items().length
    const range = virtualizer.range
    if (!current?.loaded() || !range) return
    if (current.after() !== 0 && count - 1 - range.endIndex < SLIDE_TRIGGER)
      current.slide(SLIDE_ROWS)
    else if (current.before() !== 0 && range.startIndex < SLIDE_TRIGGER) current.slide(-SLIDE_ROWS)
  })
  // The rows in view are the ones whose activity is read.
  createEffect(() => {
    taskList()
    state.observe(
      virtualRows().flatMap((virtual) =>
        virtual.item.kind === "task" ? [virtual.item.row.taskID] : [],
      ),
    )
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
          aria-label={selectedPresentation().label}
        >
          {selectedPresentation().label}
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
  const latestAttempt = () => selectedDetail()?.attempts?.at(-1)
  /** Where the callout's reason comes from, most specific first. */
  const explanationSource = () => ({
    hold: distinctReasons([...selectedHoldReasons(), selectedScheduling()?.reason]),
    pause: selectedExecution()?.dispatchPause?.reason,
    failure: selectedExecution()?.reason ?? selectedRow()?.reason,
    activity: selectedActivity(),
  })
  /** The callout sentence for a waiting, paused, failed or needs-you task: the real reason. */
  const explanation = () => taskExplanation(selectedPresentation(), explanationSource())
  /** The scheduler's coverage sentence ("Showing 100 of 101 ..."): a bound on what is listed. */
  const coverageNote = () => selectedScheduling()?.reason?.match(/Showing \d+ of \d+ [^.]*\./)?.[0]
  /** The runtime's own wording behind the callout; shown only under Identifiers. */
  const recordedReason = () => {
    const source = explanationSource()
    return source.hold[0] ?? source.pause ?? source.failure ?? selectedExecution()?.reason
  }
  const progress = createMemo(() =>
    taskProgress({
      state: selectedRecordedState() ?? selectedTask()?.status ?? "submitted",
      planState: facts()?.plan()?.state,
      held: selectedPresentation().explained && selectedPresentation().tone !== "failed",
      attemptState: latestAttempt()?.state,
      reason: selectedExecution()?.reason,
    }),
  )
  const stats = () => {
    const task = selectedTask()
    return task
      ? taskStats({
          createdAt: Date.parse(task.createdAt),
          now: minute(),
          attempt: latestAttempt(),
          working: selectedPresentation().tone === "running",
          ...(selectedRow()?.concern ? { concern: selectedRow()!.concern!.totals } : {}),
        })
      : []
  }
  const lane = () => attemptLane(latestAttempt(), minute())
  /** One done condition: a short derived line and a chevron that reveals the full text. */
  const renderCriterion = (criterion: TaskProposal["acceptance"][number]) => {
    const [open, setOpen] = createSignal(false)
    return (
      <li class="lazers-tasks-criterion" data-open={open()}>
        <span class="lazers-tasks-check" aria-hidden="true" />
        <button
          type="button"
          class="lazers-tasks-criterion-toggle"
          aria-expanded={open()}
          aria-label={`${criterionLine(criterion)}: show full text`}
          onClick={() => setOpen(!open())}
        >
          <span class="lazers-tasks-criterion-line">{criterionLine(criterion)}</span>
          <Ui.Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
        </button>
        <Show when={open()}>
          <div class="lazers-tasks-assertion-text">
            <Ui.Markdown text={criterion.assertion} />
          </div>
        </Show>
      </li>
    )
  }
  const hasGuidance = () => {
    const task = selectedTask()
    if (!task) return false
    const proposal = task.proposal
    return Boolean(
      proposal.guidance ||
      proposal.constraints.length ||
      proposal.assumptions.length ||
      proposal.context.length ||
      objectiveExtendsTitle(proposal.objective),
    )
  }
  const historyEvents = () => (selectedDetail()?.activity ?? []).slice(-HISTORY_LIMIT)
  const historyHidden = () => Math.max(0, (selectedDetail()?.activity?.length ?? 0) - HISTORY_LIMIT)
  const renderHistoryEvent = (event: PanelActivity) => {
    const [open, setOpen] = createSignal(false)
    // The payload is cold: the row reads it the first time it opens.
    const [payload, setPayload] = createSignal(event.payload)
    const openRow = () => {
      setOpen(!open())
      const read = readPayload()
      const planID = selectedExecution()?.planID
      if (payload() !== undefined || !read || !planID || !event.taskID) return
      void read(event.taskID, planID, event.id).then(
        (text) => setPayload(text ?? ""),
        () => setPayload(""),
      )
    }
    return (
      <div class="lazers-tasks-event">
        <button
          type="button"
          class="lazers-tasks-event-toggle"
          aria-expanded={open()}
          onClick={openRow}
        >
          <span>{eventLabel(event.event)}</span>
          <time dateTime={new Date(event.createdAt).toISOString()}>
            {new Date(event.createdAt).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </button>
        <Show when={open()}>
          <p class="lazers-tasks-event-name" style={{ "font-family": ctx.appearance.font("mono") }}>
            {event.event}
          </p>
          <Show when={payload() !== undefined} fallback={<p class="lazers-tasks-meta">Loading…</p>}>
            <Ui.Code content={payload() ?? ""} language="json" />
          </Show>
        </Show>
      </div>
    )
  }
  const identifiers = () => {
    const task = selectedTask()
    if (!task) return []
    const attempt = latestAttempt()
    const start = task.provenance.startingRevision
    return [
      { label: "Task", value: task.id },
      { label: "Plan", value: selectedExecution()?.planID },
      { label: "Attempt", value: attempt?.id },
      { label: "Worker session", value: selectedActivity()?.workerSessionID },
      { label: "Session", value: task.provenance.sessionID },
      { label: "Artifact", value: attempt?.artifact },
      { label: "Repository", value: task.provenance.projectDirectory },
      {
        label: "Workspace",
        value:
          task.provenance.workspaceDirectory === task.provenance.projectDirectory
            ? undefined
            : task.provenance.workspaceDirectory,
      },
      { label: "Starting revision", value: start.kind === "git" ? start.commit : undefined },
      { label: "Created", value: task.createdAt },
      { label: "Recorded reason", value: recordedReason() },
    ]
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
                  onSelect: () =>
                    save({ scope: "session", selectedID: null, anchorTaskID: undefined }),
                },
                {
                  label: "Project tasks",
                  onSelect: () =>
                    save({ scope: "project", selectedID: null, anchorTaskID: undefined }),
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
                  ...(taskList()?.chipCount(state) !== undefined
                    ? { keys: [String(taskList()!.chipCount(state))] }
                    : {}),
                  ...(state === stateFilter() ? { icon: "check" as const } : {}),
                  // The selection survives: it stays while the task is listed, and the inspector keeps
                  // its content otherwise.
                  onSelect: () =>
                    save({
                      state,
                      history: state !== "open",
                      anchorTaskID: undefined,
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
                if (searchOpen()) save({ search: "", anchorTaskID: undefined })
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
                save({ search: "", anchorTaskID: undefined })
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
              onInput={(search) => save({ search, anchorTaskID: undefined })}
              autofocus
            />
            <Ui.IconButton
              icon="close"
              size="small"
              label="Close search"
              onClick={() => {
                save({ search: "", anchorTaskID: undefined })
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
            onScroll={() => {
              captureAnchor()
              rememberFirstRow()
            }}
          >
            <PanelStatus
              ui={Ui}
              status={status}
              onRetry={() => void state.refresh()}
              skeleton="rows"
            />
            <Show when={status.showContent() && visible()?.activityError}>
              {(message) => (
                <div class="lazers-tasks-note" role="status">
                  {message()}
                </div>
              )}
            </Show>
            <Show when={status.showContent() && taskList()?.indexed() === false}>
              <div class="lazers-tasks-note" role="status">
                Tasks are being indexed.
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
              {(_value) => (
                <>
                  <Show
                    when={listRows().length}
                    fallback={
                      <div class="lazers-tasks-note">
                        {taskList()?.indexed() === false
                          ? ""
                          : prefs().search
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
                                        when={taskList()?.error()}
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
                                          onClick={() => taskList()?.retry()}
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
              <Show when={explanation()}>
                {(text) => (
                  <Callout
                    class="lazers-tasks-blocker lazers-tasks-node-reason"
                    iconTone={selectedPresentation().tone}
                    icon={renderGlyph(selectedPresentation().icon)}
                    text={text()}
                  >
                    <Show when={coverageNote()}>
                      {(note) => <p class="lazers-tasks-coverage-note">{note()}</p>}
                    </Show>
                    {reservationRefs()}
                  </Callout>
                )}
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
              <Section label="Progress">
                <Progress
                  steps={PROGRESS_STEPS}
                  current={progress().current}
                  tone={progress().tone}
                />
              </Section>
              <StatRow stats={stats()} />
              <Show when={lane()}>
                {(shown) => (
                  <Section
                    label="Activity"
                    aside={
                      <button
                        type="button"
                        class="lazers-tasks-link"
                        disabled={!selectedDetail()?.reference}
                        onClick={openSelectedTrajectory}
                      >
                        Open in Trajectory
                      </button>
                    }
                  >
                    <ActivityLane
                      label="Tool calls of the latest attempt"
                      ticks={shown().ticks}
                      durationMs={shown().durationMs}
                      originAt={shown().originAt}
                    />
                  </Section>
                )}
              </Show>
              <Section label="Done when">
                <ul class="lazers-tasks-criteria" aria-label="Done when">
                  <For
                    each={
                      showAllCriteria()
                        ? task().proposal.acceptance
                        : task().proposal.acceptance.slice(0, CRITERIA_PREVIEW)
                    }
                  >
                    {(criterion) => renderCriterion(criterion)}
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
              </Section>
              <div class="lazers-tasks-disclosures">
                <Disclosure
                  label="Scope"
                  count={
                    task().proposal.writeScope.length +
                    (task().proposal.createScope?.length ?? 0) +
                    (task().proposal.protectedScope?.length ?? 0)
                  }
                >
                  <ul
                    class="lazers-tasks-paths"
                    style={{ "font-family": ctx.appearance.font("mono") }}
                  >
                    <For each={task().proposal.writeScope}>{(path) => <li>{path}</li>}</For>
                  </ul>
                  <Show when={task().proposal.createScope?.length}>
                    <h4>Creates</h4>
                    <ul
                      class="lazers-tasks-paths"
                      style={{ "font-family": ctx.appearance.font("mono") }}
                    >
                      <For each={task().proposal.createScope}>
                        {(entry) => (
                          <li>
                            {entry.path} — {entry.purpose}
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <Show when={task().proposal.protectedScope?.length}>
                    <h4>Protected</h4>
                    <ul
                      class="lazers-tasks-paths"
                      style={{ "font-family": ctx.appearance.font("mono") }}
                    >
                      <For each={task().proposal.protectedScope}>{(path) => <li>{path}</li>}</For>
                    </ul>
                  </Show>
                  <Show when={scopeReview(selectedDetail()?.activity).divergences.length}>
                    <h4>
                      Divergence{" "}
                      {scopeReview(selectedDetail()?.activity).accepted.length
                        ? `accepted: ${scopeReview(selectedDetail()?.activity).reason ?? "amended"}`
                        : "awaiting decision"}
                    </h4>
                    <ul
                      class="lazers-tasks-paths"
                      style={{ "font-family": ctx.appearance.font("mono") }}
                    >
                      <For each={scopeReview(selectedDetail()?.activity).divergences}>
                        {(path) => <li>{path}</li>}
                      </For>
                    </ul>
                  </Show>
                  <For each={[["Excludes", task().proposal.exclusions]] as const}>
                    {([label, values]) => (
                      <Show when={values.length}>
                        <h4>{label}</h4>
                        <For each={values}>{(text) => <Ui.Markdown text={text} />}</For>
                      </Show>
                    )}
                  </For>
                  <For
                    each={
                      [
                        ["Runs after", selectedRelations().prerequisites],
                        ["Blocks", selectedRelations().successors],
                      ] as const
                    }
                  >
                    {([label, ids]) => (
                      <Show when={ids.length}>
                        <div class="lazers-tasks-dependencies">
                          <span>{label} </span>
                          <For each={ids}>
                            {(taskID, index) => (
                              <>
                                {index() ? ", " : ""}
                                {renderRelation(taskID)}
                              </>
                            )}
                          </For>
                        </div>
                      </Show>
                    )}
                  </For>
                  <Show when={selectedRelations().planPrerequisites.length}>
                    <div class="lazers-tasks-dependencies">
                      <span>
                        Plan runs after
                        {selectedRelations().planPrerequisitesComplete
                          ? " "
                          : ` (${selectedRelations().planPrerequisites.length} of ${selectedRelations().planPrerequisitesCount}) `}
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
                </Disclosure>
                <Disclosure
                  label="Checks"
                  count={task().proposal.verification.length}
                  when={task().proposal.verification.length > 0 || Boolean(task().proposal.limits)}
                >
                  <For each={task().proposal.verification}>
                    {(item) => (
                      <div class="lazers-tasks-check-item">
                        <p>
                          {item.id}
                          <Show when={checkTiming(item)}>{(timing) => ` · ${timing()}`}</Show>
                        </p>
                        <Ui.Code content={item.command} language="bash" />
                      </div>
                    )}
                  </For>
                  <Show when={task().proposal.limits}>
                    {(limits) => (
                      <p>
                        Proposed limits: {limits().maxTokens.toLocaleString()} tokens · $
                        {limits().maxEstimatedCostUsd} · {limits().maxElapsedMs / 60000} min ·{" "}
                        {limits().maxToolCalls} calls
                      </p>
                    )}
                  </Show>
                </Disclosure>
                <Disclosure label="Guidance" when={hasGuidance()}>
                  <Show when={objectiveExtendsTitle(task().proposal.objective)}>
                    <h4>Objective</h4>
                    <Ui.Markdown text={task().proposal.objective} />
                  </Show>
                  <Show when={task().proposal.guidance}>
                    {(guidance) => (
                      <>
                        <h4>Advice</h4>
                        <Ui.Markdown text={guidance()} />
                      </>
                    )}
                  </Show>
                  <For
                    each={
                      [
                        ["Constraints", task().proposal.constraints],
                        ["Assumptions", task().proposal.assumptions],
                      ] as const
                    }
                  >
                    {([label, values]) => (
                      <Show when={values.length}>
                        <h4>{label}</h4>
                        <For each={values}>{(text) => <Ui.Markdown text={text} />}</For>
                      </Show>
                    )}
                  </For>
                  <Show when={task().proposal.context.length}>
                    <h4>Context</h4>
                    <For each={task().proposal.context}>
                      {(item) => <Ui.Markdown text={item.reference} />}
                    </For>
                  </Show>
                  <p>
                    Risk {task().proposal.requirements.risk}
                    <For
                      each={[
                        ...task().proposal.requirements.capabilities,
                        ...task().proposal.requirements.skills,
                      ]}
                    >
                      {(text) => ` · ${text}`}
                    </For>
                  </p>
                </Disclosure>
                <Disclosure label="History" count={selectedDetail()?.activity?.length}>
                  <Show when={historyHidden() > 0}>
                    <p class="lazers-tasks-history-note">
                      Showing the latest {HISTORY_LIMIT} of {selectedDetail()?.activity?.length}
                    </p>
                  </Show>
                  <For each={historyEvents()}>{(event) => renderHistoryEvent(event)}</For>
                </Disclosure>
                <Disclosure label="Identifiers">
                  <Identifiers items={identifiers()} />
                  <Disclosure label="Specification">
                    <div
                      class="lazers-tasks-json"
                      role="region"
                      aria-label="Full task specification JSON"
                      tabIndex={0}
                    >
                      <Ui.Code content={JSON.stringify(task(), null, 2)} language="json" />
                    </div>
                  </Disclosure>
                </Disclosure>
              </div>
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
      async get(session, reference, signal) {
        const server = ctx.servers.get(session.server.id)
        if (!server?.connected || !session.location) throw new Error("Task link session is offline")
        const location = session.location
        // `tasks.detail` at window 1; the service sets the project and checks the session.
        const [row] = await readWindow(
          rpcStreamsTransport(() => server.client.rpc(Streams) as unknown as StreamsRpc, signal, {
            location,
          }),
          taskDetailRef,
          {
            filter: { scope: { kind: "project", sessionID: session.id }, reference },
            order: "task",
            window: 1,
          },
        )
        return row
          ? {
              status: "found" as const,
              reference: String(row.reference),
              task: TaskSpecSchema.parse(row.body),
            }
          : { status: "not_found" as const }
      },
      signal: () => linkSignal(ctx),
      open(target) {
        const session = linkedSession(ctx, target)
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
  // Files 30) and an item without `order` is 0, ahead of them. Every LAZERS item sets one above
  // 30 so they list together after the host's: Tasks 40, Trajectory 50, Radar 60, Models 70.
  ctx.add(MenuItem, {
    id: "tasks.open",
    menu: "session.panel",
    title: "Tasks",
    icon: "task",
    order: 40,
    run: open,
  })
}
