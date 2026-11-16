import { Store, bindPlugin, createKeyed, createLatest, usePanel } from "@opencode/plugin/gui"
import type { IconName, PanelProps, SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { For, Index, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { Observability } from "../observability/contract.ts"
import { clampSplit, splitFromKey, splitFromPointer, visibleTicks } from "./panel-layout.ts"
import type { PanelData, PanelPreferences, Selection } from "./panel-state.ts"
import { selectedAttemptFor, selectedEventFor, TrajectoryPanelState } from "./panel-state.ts"
import {
  buildTimeline,
  checkTiming,
  checkKey,
  detailedChecks,
  displayTitle,
  durationText,
  elapsedLabel,
  eventTitle,
  eventPayload,
  isActiveAttemptState,
  settledHistory,
  sourceReferences,
} from "./projection.ts"
import type {
  CheckTimeline,
  DetailedCheck,
  TrajectoryAttempt,
  TrajectoryEvent,
  TrajectoryReport,
} from "./projection.ts"
import { createTrajectoryTransport } from "./projection.ts"
import { registerTrajectoryPanel } from "./registration.ts"
import {
  attemptOutcome,
  buildTracks,
  checkOutcome,
  loadedEventHorizon,
  nearestMark,
  neighborMark,
  nextZoom,
  outcomeText,
  trackTimes,
  ZOOM_LEVELS,
} from "./tracks.ts"
import type { FileMark, GapMark, Outcome, ToolMark } from "./tracks.ts"
import css from "./panel.css?inline"

const SelectionKind = Schema.Literals(["", "attempt", "check", "event"])
const TaskTarget = Schema.Struct({
  requestID: Schema.String,
  taskID: Schema.String,
  reference: Schema.String,
  projectID: Schema.String,
  projectDirectory: Schema.String,
})
const View = Schema.Struct({
  scope: Schema.Literals(["session", "project"]),
  selectedTaskID: Schema.NullOr(Schema.String),
  selectedReference: Schema.optionalKey(Schema.NullOr(Schema.String)),
  target: Schema.optionalKey(Schema.NullOr(TaskTarget)),
  selectedKind: SelectionKind,
  selectedRecordID: Schema.String,
  split: Schema.Number,
  zoom: Schema.optionalKey(Schema.Number),
})
const initial: typeof View.Type = {
  scope: "session",
  selectedTaskID: null,
  selectedReference: null,
  target: null,
  selectedKind: "",
  selectedRecordID: "",
  split: 56,
}

export const trajectoryStores = {
  trajectoryView: Store.session(Schema.Struct({ projects: Schema.Record(Schema.String, View) }), {
    projects: {},
  }),
}
type TrajectoryContext = SetupContext<{ stores: typeof trajectoryStores }>

function selectionFrom(view: typeof initial): Selection | null {
  if (!view.selectedKind || !view.selectedRecordID) return null
  return { kind: view.selectedKind, id: view.selectedRecordID }
}

function formatTime(value: number | null, origin: number | null) {
  if (value === null) return "Unknown"
  const absolute = new Date(value).toLocaleTimeString()
  if (origin === null) return absolute
  const elapsed = Math.max(0, Math.round((value - origin) / 1_000))
  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed % 60
  return `${absolute} · +${minutes}:${String(seconds).padStart(2, "0")}`
}

function elapsedText(value: number) {
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(3)} s (${value} ms)`
}

function endpointText(label: string, value: number | null, origin: number | null) {
  return value === null
    ? `${label} · unavailable`
    : `${label} · ${value} Unix ms · ${formatTime(value, origin)}`
}

function timingHint(check: { startedAt: number | null; endedAt: number | null }) {
  const timing = checkTiming(check)
  return timing.status === "known"
    ? `duration ${elapsedText(timing.durationMs)}`
    : `duration unavailable: ${timing.reason}`
}

type ScrollAnchor = { key: string; offset: number; scrollTop: number } | undefined

function captureScrollAnchor(element: HTMLElement | undefined): ScrollAnchor {
  if (!element) return undefined
  const bounds = element.getBoundingClientRect()
  const anchor = [...element.querySelectorAll<HTMLElement>("[data-scroll-anchor]")].find((item) => {
    const rect = item.getBoundingClientRect()
    return rect.bottom > bounds.top && rect.top < bounds.bottom
  })
  return anchor?.dataset.scrollAnchor
    ? {
        key: anchor.dataset.scrollAnchor,
        offset: anchor.getBoundingClientRect().top - bounds.top,
        scrollTop: element.scrollTop,
      }
    : { key: "", offset: 0, scrollTop: element.scrollTop }
}

function restoreScrollAnchor(element: HTMLElement | undefined, anchor: ScrollAnchor) {
  if (!element || !anchor) return
  if (!anchor.key) {
    element.scrollTop = anchor.scrollTop
    return
  }
  const target = [...element.querySelectorAll<HTMLElement>("[data-scroll-anchor]")].find(
    (item) => item.dataset.scrollAnchor === anchor.key,
  )
  if (!target) {
    element.scrollTop = anchor.scrollTop
    return
  }
  element.scrollTop +=
    target.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset
}

function eventTime(event: TrajectoryEvent) {
  return typeof event.at === "number" ? new Date(event.at).toLocaleTimeString() : "Time unknown"
}

function attemptModel(attempt: TrajectoryAttempt | undefined) {
  return attempt?.observedCurrentModel ?? attempt?.admittedModel ?? null
}

function modelLabel(model: ReturnType<typeof attemptModel>) {
  if (!model) return "Model not recorded"
  return `${model.id}${model.variant ? ` · ${model.variant}` : ""}`
}

function attemptCount(report: PanelData["report"]) {
  if (!report) return ""
  const attempts = report.attempts.length
  const calls = report.effort.toolCalls.count.toLocaleString()
  return `${attempts} ${attempts === 1 ? "attempt" : "attempts"} · ${calls} tool calls`
}

/** Recorded attempt duration; an active attempt reports elapsed time as of capture. */
function attemptDuration(attempt: TrajectoryAttempt, asOf: number | null) {
  const start = attempt.intervals.attempt.startedAt ?? attempt.startedAt
  const end = attempt.intervals.attempt.endedAt
  if (end !== null && end >= start) return { ms: end - start, open: false }
  if (end === null && isActiveAttemptState(attempt.state) && asOf !== null && asOf >= start)
    return { ms: asOf - start, open: true }
  return null
}

const toolEndRecorded = (mark: ToolMark) =>
  mark.end !== null && (mark.start === null || mark.end >= mark.start) ? "recorded" : "missing"

const outcomeIcon: Record<Outcome, IconName> = {
  succeeded: "circle-check",
  failed: "circle-x",
  running: "status-active",
  unknown: "dash",
}

type LaneMark =
  | { kind: "tool"; id: string; left: number; width: number; at: number; mark: ToolMark }
  | { kind: "gap"; id: string; left: number; width: number; at: number; mark: GapMark }

function PanelView(props: PanelProps & { ctx: TrajectoryContext }) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
  const [data, setData] = createSignal<PanelData>({
    key: "",
    tasks: [],
    taskID: null,
    taskReference: null,
    selection: null,
    events: [],
    liveEvents: [],
    capturedEventIDs: [],
    eventCursor: null,
    totalEvents: 0,
    historyCapturedAt: null,
    historyExpiresAt: null,
    historyError: "",
    pageRecaptureRequired: false,
    statusReadAt: null,
    recapturingHistory: false,
    loading: true,
    loadingActivity: false,
    stale: false,
    error: "",
  })
  const [split, setSplit] = createSignal(initial.split)
  const [zoom, setZoom] = createSignal(1)
  const [axisWidth, setAxisWidth] = createSignal(0)
  let axisObserver: ResizeObserver | undefined
  let topPane: HTMLDivElement | undefined
  let inspectorPane: HTMLDivElement | undefined
  let timelineScroll: HTMLDivElement | undefined
  const state = new TrajectoryPanelState(
    (next) => {
      const previous = data()
      const preserve = previous.key === next.key && previous.taskID === next.taskID
      const topAnchor = preserve ? captureScrollAnchor(topPane) : undefined
      const inspectorAnchor = preserve ? captureScrollAnchor(inspectorPane) : undefined
      const scrollLeft = preserve ? timelineScroll?.scrollLeft : undefined
      setData(next)
      if (preserve)
        queueMicrotask(() => {
          restoreScrollAnchor(topPane, topAnchor)
          restoreScrollAnchor(inspectorPane, inspectorAnchor)
          if (timelineScroll && scrollLeft !== undefined) timelineScroll.scrollLeft = scrollLeft
        })
    },
    (preferences: PanelPreferences) => {
      save({
        selectedTaskID: preferences.taskID,
        selectedKind: preferences.selection?.kind ?? "",
        selectedRecordID: preferences.selection?.id ?? "",
      })
    },
  )
  let root: HTMLDivElement | undefined
  let separator: HTMLDivElement | undefined
  let endDrag: (() => void) | undefined
  let handledTargetRequestID = ""

  const source = createLatest(
    () => {
      if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
      return {
        client: props.session.server.client,
        server: props.session.server.id,
        session: props.session.id,
        directory: props.session.directory,
      }
    },
    async (value, signal) => {
      const location = await value.client.location.get(
        { location: { directory: value.directory } },
        { signal },
      )
      return {
        ...value,
        project: location.project.canonical,
        projectID: location.project.id,
      }
    },
  )
  const current = () => {
    if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
    const value = source.latest
    return value &&
      value.session === props.session.id &&
      value.server === props.session.server.id &&
      value.directory === props.session.directory &&
      !source.loading
      ? value
      : undefined
  }
  const prefs = () => {
    const value = current()
    return value
      ? (ctx.stores.trajectoryView(props.session).value?.projects[value.project] ?? initial)
      : initial
  }
  function save(change: Partial<typeof initial>) {
    const value = current()
    if (!value) return
    const store = ctx.stores.trajectoryView(props.session)
    store.update((draft) => {
      draft.projects[value.project] = { ...(draft.projects[value.project] ?? initial), ...change }
    })
  }

  const expectedKey = () => {
    const value = current()
    const view = prefs()
    return value
      ? JSON.stringify([value.server, value.project, value.projectID, value.session, view.scope])
      : ""
  }
  const visible = () => (data().key === expectedKey() ? data() : undefined)
  onCleanup(() => {
    state.close()
    endDrag?.()
    axisObserver?.disconnect()
  })

  createKeyed(
    () => {
      const value = current()
      if (!value || !ctx.stores.trajectoryView(props.session).ready()) return undefined
      const view = prefs()
      return {
        value,
        view,
        key: JSON.stringify([
          value.server,
          value.project,
          value.projectID,
          value.session,
          view.scope,
        ]),
      }
    },
    ({ value, view, key }) => {
      setSplit(clampSplit(view.split))
      setZoom(ZOOM_LEVELS.find((level) => level === view.zoom) ?? 1)
      const scope = { kind: view.scope, sessionID: value.session } as const
      const rpc = value.client.rpc(Observability)
      const transport = createTrajectoryTransport(
        rpc,
        value.directory,
        () => props.session.server.connected,
        value.client.event,
        value.projectID,
      )
      handledTargetRequestID = view.target?.requestID ?? ""
      state.connect(key, value.projectID, value.project, scope, transport, {
        target: view.target,
        taskID: view.selectedTaskID,
        selection: selectionFrom(view),
      })
      onCleanup(() => state.close())
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )

  // Connecting the view already reads; only a reconnect forces a status read.
  let wasConnected = props.session.server.connected
  createEffect(() => {
    const connected = props.session.server.connected
    const value = current()
    if (value && connected && !wasConnected) void state.refresh({ force: true })
    wasConnected = connected
  })

  createEffect(() => {
    const value = current()
    const target = prefs().target
    if (!value || !target || target.requestID === handledTargetRequestID) return
    handledTargetRequestID = target.requestID
    state.selectTarget(target)
  })

  const currentData = () => visible()
  const report = () => currentData()?.report
  const selection = () => currentData()?.selection ?? null
  const selectedTask = () =>
    currentData()?.tasks.find((task) => task.taskID === currentData()?.taskID)
  const allTaskChecks = () => (report() ? detailedChecks(report()!) : [])
  const selectedEvent = () => selectedEventFor(currentData())
  const selectedCheck = () => {
    const value = selection()
    return value?.kind === "check"
      ? allTaskChecks().find((check) => checkKey(check) === value.id)
      : undefined
  }
  const selectedAttempt = () => selectedAttemptFor(currentData())
  const checksForInspector = () => {
    const attempt = selectedAttempt()
    return allTaskChecks().filter(
      (check) => !attempt || check.attemptID === attempt.id || check.scope === "plan",
    )
  }
  const loadedEvents = createMemo(() => {
    const value = currentData()
    return value ? [...value.events, ...value.liveEvents] : []
  })
  const capturedAt = () => currentData()?.historyCapturedAt ?? null
  const settled = () => settledHistory(report())
  const timeline = createMemo(() => {
    const value = currentData()
    if (!value?.taskID || (!value.snapshot && !value.report)) return undefined
    return buildTimeline(
      value.snapshot,
      value.taskID,
      value.report,
      capturedAt(),
      trackTimes(loadedEvents()),
    )
  })
  const attemptStates = createMemo(
    () => new Map((report()?.attempts ?? []).map((attempt) => [attempt.id, attempt.state])),
  )
  const tracks = createMemo(() => {
    const line = timeline()
    if (!line) return undefined
    const value = currentData()
    const pendingAfter = value?.eventCursor ? loadedEventHorizon(value.events) : null
    return buildTracks(line, loadedEvents(), attemptStates(), pendingAfter)
  })
  const laneMarks = createMemo((): LaneMark[] => {
    const value = tracks()
    if (!value) return []
    return [
      ...value.tools.map((mark) => ({
        kind: "tool" as const,
        id: mark.id,
        left: mark.left,
        width: mark.width,
        at: mark.at,
        mark,
      })),
      ...value.gaps.map((mark) => ({
        kind: "gap" as const,
        id: mark.id,
        left: mark.left,
        width: 0,
        at: mark.at,
        mark,
      })),
    ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  })
  const checkLane = createMemo(() => {
    const checks = [...(timeline()?.checks ?? [])]
      .filter((check) => check.visible)
      .sort((a, b) => a.left - b.left || a.checkID.localeCompare(b.checkID))
    return checks.map((check) => ({ check, id: check.id }))
  })
  const sameIDs = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((id, index) => id === right[index])
  const attemptIDs = createMemo(
    () => (timeline()?.attempts ?? []).map((lane) => lane.attempt.id),
    [],
    { equals: sameIDs },
  )
  const attemptLanes = createMemo(
    () => new Map((timeline()?.attempts ?? []).map((lane) => [lane.attempt.id, lane])),
  )
  const checkIDs = createMemo(() => checkLane().map((item) => item.id), [], { equals: sameIDs })
  const checkItems = createMemo(() => new Map(checkLane().map((item) => [item.id, item])))
  const ticks = createMemo(() => {
    const line = timeline()
    if (!line || line.origin === null || line.durationMs <= 0) return []
    const width = axisWidth()
    const step = tickStepFor(line.durationMs, width)
    const values = []
    for (let elapsed = 0; elapsed <= line.durationMs + 0.5; elapsed += step)
      values.push({ elapsedMs: elapsed, label: elapsedLabel(elapsed) })
    return values
  })
  const tickStepFor = (durationMs: number, width: number) => {
    const maximum = Math.max(2, Math.floor((width || 240) / 64))
    const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 21_600]
    return (
      candidates.map((seconds) => seconds * 1_000).find((step) => durationMs / step <= maximum) ??
      durationMs
    )
  }
  const selectedTool = createMemo(() => {
    const value = selection()
    if (value?.kind !== "event") return undefined
    return tracks()?.tools.find((tool) => tool.id === value.id || tool.aliases.includes(value.id))
  })
  const selectedGap = () => {
    const value = selection()
    return value?.kind === "event" ? tracks()?.gaps.find((gap) => gap.id === value.id) : undefined
  }
  const eventSelected = (id: string, aliases: readonly string[] = []) => {
    const value = selection()
    return value?.kind === "event" && (value.id === id || aliases.includes(value.id))
  }
  const checkSelected = (check: CheckTimeline) => {
    const detailed = selectionForTimelineCheck(check)
    const value = selection()
    return Boolean(detailed && value?.kind === "check" && value.id === checkKey(detailed))
  }
  const attemptSelected = (id: string) => {
    const value = selection()
    return (
      (value?.kind === "attempt" && value.id === id) ||
      (value?.kind !== "attempt" && selectedAttempt()?.id === id && value !== null)
    )
  }

  const splitTo = (next: number) => setSplit(clampSplit(next))
  const drag: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    endDrag?.()
    const key = expectedKey()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      const rect = root?.getBoundingClientRect()
      if (rect)
        splitTo(
          splitFromPointer(
            split(),
            rect.top,
            rect.height,
            separator?.getBoundingClientRect().height ?? 0,
            moveEvent.clientY,
          ),
        )
    }
    const end = () => {
      element.removeEventListener("pointermove", move)
      element.removeEventListener("pointerup", end)
      element.removeEventListener("pointercancel", end)
      if (expectedKey() === key) save({ split: split() })
      endDrag = undefined
    }
    element.addEventListener("pointermove", move)
    element.addEventListener("pointerup", end, { once: true })
    element.addEventListener("pointercancel", end, { once: true })
    endDrag = end
  }
  const selectionForTimelineCheck = (check: {
    planID?: string | null
    attemptID: string | null
    checkID: string
  }) =>
    allTaskChecks().find(
      (candidate) =>
        candidate.planID === check.planID &&
        candidate.attemptID === check.attemptID &&
        candidate.id === check.checkID,
    )
  const openAttemptSession = (sessionID: string) => {
    ctx.tabs.open({ server: props.session.server.id, id: sessionID }, { focus: true })
  }
  const openSource = (reference: { path: string; line: number }) => {
    const path = props.screen.file.resolve(reference.path)
    if (props.screen.file.absolute(path)) return
    props.screen.file.selection.set(path, { start: reference.line, end: reference.line })
    ctx.links.open({
      href: path,
      exact: true,
      base: props.session.directory,
      session: props.session,
    })
  }
  const origin = () => timeline()?.origin ?? null
  const timeText = (value: number | null) => formatTime(value, origin())
  const selectScope = (scope: "session" | "project") => {
    save({
      scope,
      selectedTaskID: null,
      selectedReference: null,
      target: null,
      selectedKind: "",
      selectedRecordID: "",
    })
  }
  const selectTask = (taskID: string) => {
    save({
      selectedTaskID: taskID,
      selectedReference: null,
      target: null,
      selectedKind: "",
      selectedRecordID: "",
    })
    state.selectTask(taskID)
  }
  const checkOutput = (check: DetailedCheck) =>
    [
      check.stdout ? `stdout\n${check.stdout}` : "",
      check.stderr ? `stderr\n${check.stderr}` : "",
      check.error ? `error\n${check.error}` : "",
    ]
      .filter(Boolean)
      .join("\n\n") || "No output was recorded."
  const checkSources = (check: DetailedCheck) =>
    sourceReferences(`${check.stdout ?? ""}\n${check.stderr ?? ""}\n${check.error ?? ""}`)
  const checkLabel = (check: DetailedCheck) => check.command ?? check.id
  const checkResult = (check: DetailedCheck) =>
    check.exitCode === null ? check.result : `${check.result} · exit ${check.exitCode}`
  const attemptNumber = (id: string | null) =>
    id ? report()?.attempts.find((attempt) => attempt.id === id)?.number : undefined
  const at = (value: number) => `+${elapsedLabel(Math.max(0, value - (origin() ?? value)))}`

  /** Selection follows focus inside a track; focus moves to the newly selected mark. */
  const focusMark = (lane: HTMLElement, id: string) =>
    queueMicrotask(() =>
      [...lane.querySelectorAll<HTMLElement>("[data-mark-id]")]
        .find((element) => element.dataset.markId === id)
        ?.focus({ preventScroll: false }),
    )
  const laneKeyDown =
    <T extends { id: string }>(
      marks: () => readonly T[],
      active: () => string | null,
      choose: (mark: T) => void,
    ) =>
    (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
      const next = neighborMark(marks(), active(), event.key)
      if (!next) return
      event.preventDefault()
      choose(next)
      focusMark(event.currentTarget, next.id)
    }
  const laneClick =
    <T extends { id: string; left: number; width?: number }>(
      marks: () => readonly T[],
      choose: (mark: T) => void,
    ) =>
    (event: MouseEvent & { currentTarget: HTMLElement }) => {
      if (event.target !== event.currentTarget) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (rect.width <= 0) return
      const percent = ((event.clientX - rect.left) / rect.width) * 100
      const mark = nearestMark(marks(), percent, (12 / rect.width) * 100)
      if (!mark) return
      choose(mark)
      focusMark(event.currentTarget, mark.id)
    }
  const activeTool = createMemo(() => {
    const marks = laneMarks()
    const chosen = marks.find((mark) =>
      mark.kind === "tool" ? eventSelected(mark.id, mark.mark.aliases) : eventSelected(mark.id),
    )
    return chosen?.id ?? marks[0]?.id ?? null
  })
  const activeFile = createMemo(() => {
    const marks = tracks()?.files ?? []
    return marks.find((mark) => eventSelected(mark.id))?.id ?? marks[0]?.id ?? null
  })
  const activeCheck = createMemo(() => {
    const items = checkLane()
    return items.find((item) => checkSelected(item.check))?.id ?? items[0]?.id ?? null
  })
  const activeAttempt = createMemo(() => {
    const lanes = timeline()?.attempts ?? []
    return (
      lanes.find((lane) => attemptSelected(lane.attempt.id))?.attempt.id ??
      lanes[0]?.attempt.id ??
      null
    )
  })
  const chooseCheck = (item: { check: CheckTimeline }) => {
    const detailed = selectionForTimelineCheck(item.check)
    if (detailed) state.selectCheck(checkKey(detailed))
  }

  /** Keep the selected mark inside the horizontal viewport without moving vertical scroll. */
  const revealSelection = () => {
    const scroller = timelineScroll
    if (!scroller) return
    const element = scroller.querySelector<HTMLElement>(
      '[data-mark-id][aria-selected="true"]:not(.lazers-trajectory-attempt)',
    )
    if (!element) return
    const label = scroller.querySelector<HTMLElement>(".lazers-trajectory-label-cell")
    const bounds = scroller.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    const leftEdge = bounds.left + (label?.getBoundingClientRect().width ?? 0)
    if (rect.left < leftEdge) scroller.scrollLeft -= leftEdge - rect.left + 24
    else if (rect.right > bounds.right) scroller.scrollLeft += rect.right - bounds.right + 24
  }
  createEffect(
    on(
      () => JSON.stringify(selection()),
      () => queueMicrotask(revealSelection),
      { defer: true },
    ),
  )
  const changeZoom = (next: number) => {
    const scroller = timelineScroll
    const previous = zoom()
    if (next === previous) return
    const label = scroller?.querySelector<HTMLElement>(".lazers-trajectory-label-cell")
    const labelWidth = label?.getBoundingClientRect().width ?? 0
    const plotWidth = scroller ? scroller.scrollWidth - labelWidth : 0
    const center =
      scroller && plotWidth > 0
        ? (scroller.scrollLeft + (scroller.clientWidth - labelWidth) / 2) / plotWidth
        : 0
    setZoom(next)
    save({ zoom: next })
    queueMicrotask(() => {
      if (!scroller) return
      const width = scroller.scrollWidth - labelWidth
      scroller.scrollLeft = Math.max(0, center * width - (scroller.clientWidth - labelWidth) / 2)
    })
  }

  const OutcomeBadge = (badge: { outcome: Outcome; text?: string; result?: string }) => (
    <span
      class="lazers-trajectory-result lazers-trajectory-outcome"
      data-outcome={badge.outcome}
      data-result={badge.result}
    >
      <Ui.Icon name={outcomeIcon[badge.outcome]} size="small" />
      <span>{badge.text ?? outcomeText[badge.outcome]}</span>
    </span>
  )
  const connectionText = () =>
    !props.session.server.connected
      ? "Disconnected"
      : currentData()?.stale
        ? "Stale"
        : currentData()?.loading && report()
          ? "Updating"
          : ""
  const title = () => displayTitle(report()?.task.specification.objective ?? "")
  const titleTruncated = () => title() !== (report()?.task.specification.objective ?? "").trim()
  const headerAttempt = () => selectedAttempt() ?? report()?.attempts.at(-1)
  const headerModel = () => attemptModel(headerAttempt())
  const headerTiming = () => {
    const attempt = headerAttempt()
    if (!attempt) return ""
    const duration = attemptDuration(attempt, capturedAt())
    return duration
      ? `${durationText(duration.ms)}${duration.open ? " so far" : ""}`
      : "duration not recorded"
  }
  const coverageParts = () => {
    const value = tracks()
    const line = report()
    if (!value || !line) return []
    const parts: string[] = []
    const placed = value.tools.length
    const recorded = line.effort.toolCalls.count
    parts.push(
      `${placed.toLocaleString()} ${placed === 1 ? "call" : "calls"} placed` +
        (value.untimedTools ? ` · ${value.untimedTools.toLocaleString()} without time` : "") +
        (recorded !== placed + value.untimedTools
          ? ` · runner counted ${recorded.toLocaleString()}`
          : ""),
    )
    parts.push(
      `${value.files.length.toLocaleString()} file ${value.files.length === 1 ? "target" : "targets"}` +
        (value.omittedFileTargets ? ` · ${value.omittedFileTargets} without paths` : ""),
    )
    const gaps = value.gaps.filter((gap) => gap.kind === "gap").length
    const compactions = value.gaps.length - gaps
    if (gaps) parts.push(`${gaps} recording ${gaps === 1 ? "gap" : "gaps"}`)
    if (compactions || line.coverage.compacted)
      parts.push(
        compactions
          ? `${compactions} ${compactions === 1 ? "compaction" : "compactions"}`
          : "Context compacted",
      )
    if (line.coverage.unavailableSessionContexts)
      parts.push(
        `${line.coverage.unavailableSessionContexts} worker ${line.coverage.unavailableSessionContexts === 1 ? "session" : "sessions"} unreadable`,
      )
    return parts
  }
  const toolEvents = (tool: ToolMark) => {
    const ids = new Set([tool.id, ...tool.aliases])
    return loadedEvents().filter((event) => ids.has(event.id))
  }
  const toolOutput = (tool: ToolMark) => {
    const events = toolEvents(tool)
    const result = events.find((event) => event.result)?.result
    const error = events.find((event) => event.error !== undefined)?.error
    return [
      result ? result : "",
      error === undefined
        ? ""
        : `error\n${typeof error === "string" ? error : JSON.stringify(error, null, 2)}`,
    ]
      .filter(Boolean)
      .join("\n\n")
  }
  const operationText = { read: "Read", edit: "Edited", patch: "Patched" } as const

  return (
    <div
      class="lazers-trajectory"
      ref={(element) => {
        root = element
      }}
      style={{
        "--trajectory-visual-fr": `${split()}fr`,
        "--trajectory-inspector-fr": `${100 - split()}fr`,
        "--trajectory-zoom": String(zoom()),
      }}
    >
      <div
        class="lazers-trajectory-top"
        id="lazers-trajectory-top"
        ref={(element) => {
          topPane = element
        }}
      >
        <header class="lazers-trajectory-header">
          <div class="lazers-trajectory-controls">
            <span class="lazers-trajectory-task-menu">
              <Ui.Menu
                label={
                  selectedTask()?.title
                    ? displayTitle(selectedTask()!.title!)
                    : currentData()?.taskReference
                      ? currentData()!.taskReference!
                      : currentData()?.taskID
                        ? currentData()!.taskID!.slice(0, 8)
                        : "Choose task"
                }
                trigger="button"
                placement="bottom-start"
                disabled={!currentData()?.tasks.length}
                items={(currentData()?.tasks ?? []).map((task) => ({
                  label: `${task.title ? displayTitle(task.title) : task.taskID.slice(0, 8)} · ${task.status}`,
                  onSelect: () => selectTask(task.taskID),
                }))}
              />
            </span>
            <span class="lazers-trajectory-scope">
              <Ui.Menu
                label={prefs().scope === "session" ? "Session" : "Project"}
                trigger="button"
                items={[
                  { label: "This session", onSelect: () => selectScope("session") },
                  { label: "Project tasks", onSelect: () => selectScope("project") },
                ]}
              />
            </span>
            <Show when={connectionText()}>
              <span
                class="lazers-trajectory-connection"
                data-state={connectionText().toLowerCase()}
                title={
                  !props.session.server.connected
                    ? "Trajectory updates are disconnected; showing the last loaded data."
                    : "Showing the last loaded data; updates will resume automatically."
                }
              >
                {connectionText()}
              </span>
            </Show>
          </div>
          <Show when={currentData()?.error}>
            <div class="lazers-trajectory-error" role="alert">
              <span>{currentData()?.error}</span>
              <Ui.Button
                variant="ghost"
                size="small"
                onClick={() => void state.refresh({ force: true })}
              >
                Retry status
              </Ui.Button>
            </div>
          </Show>
          <Show when={!report() && currentData()?.historyError}>
            <div class="lazers-trajectory-error" role="alert">
              <span>{currentData()?.historyError}</span>
              <Ui.Button
                variant="ghost"
                size="small"
                busy={currentData()?.recapturingHistory}
                onClick={() => void state.recaptureActivity()}
              >
                Recapture history
              </Ui.Button>
            </div>
          </Show>
          <Show
            when={report()}
            fallback={
              <div class="lazers-trajectory-note" data-state="empty">
                {!currentData() || currentData()?.loading ? (
                  <span class="lazers-trajectory-loading">
                    <Ui.Loader size="small" />
                    <span>Loading trajectory</span>
                  </span>
                ) : currentData()?.error || currentData()?.historyError ? (
                  ""
                ) : !currentData()?.tasks.length ? (
                  <>
                    <span>
                      {prefs().scope === "session"
                        ? "No LAZERS tasks belong to this session."
                        : "No LAZERS tasks belong to this project."}
                    </span>
                    <Show when={prefs().scope === "session"}>
                      <Ui.Button
                        variant="ghost"
                        size="small"
                        onClick={() => selectScope("project")}
                      >
                        Show project tasks
                      </Ui.Button>
                    </Show>
                  </>
                ) : currentData()?.taskID ? (
                  "No trajectory has been recorded for this task yet."
                ) : (
                  "Choose a task to see its trajectory."
                )}
              </div>
            }
          >
            <h2
              class="lazers-trajectory-heading"
              title={titleTruncated() ? report()?.task.specification.objective : undefined}
            >
              {title()}
            </h2>
            <div class="lazers-trajectory-heading-row">
              <span
                class="lazers-trajectory-id"
                style={{ "font-family": ctx.appearance.font("mono") }}
              >
                {currentData()?.taskReference ? `${currentData()!.taskReference} · ` : ""}
                {report()?.task.id.slice(0, 8)}
                {report()?.task.revision ? ` · r${report()?.task.revision}` : ""}
              </span>
              <button
                type="button"
                class="lazers-trajectory-icon-button lazers-trajectory-copy"
                aria-label="Copy task ID"
                title="Copy task ID"
                onClick={() => {
                  const id = report()?.task.id
                  if (id) void ctx.system.copy(id)
                }}
              >
                <Ui.Icon name="outline-copy" size="small" />
              </button>
            </div>
            <div class="lazers-trajectory-task-meta">
              <Show when={headerAttempt()}>
                {(attempt) => (
                  <span class="lazers-trajectory-model">
                    <span class="lazers-trajectory-model-name">{modelLabel(headerModel())}</span>
                    <span class="lazers-trajectory-model-scope">
                      Attempt {attempt().number} · {headerTiming()}
                    </span>
                  </span>
                )}
              </Show>
            </div>
            <div class="lazers-trajectory-task-meta lazers-trajectory-run-total">
              {attemptCount(report())}
            </div>
            <Show when={titleTruncated()}>
              <details class="lazers-trajectory-objective">
                <summary>Objective</summary>
                <p>{report()?.task.specification.objective}</p>
              </details>
            </Show>
          </Show>
        </header>

        <Show when={report()}>
          <section class="lazers-trajectory-timeline" aria-label="Timeline">
            <div class="lazers-trajectory-timeline-bar">
              <span
                class="lazers-trajectory-axis-caption"
                title={
                  origin() === null
                    ? undefined
                    : `Origin ${new Date(origin()!).toLocaleString(undefined, { timeZoneName: "short" })} · earliest recorded attempt start`
                }
              >
                Elapsed since first attempt
                <Show when={origin() !== null}>
                  {" · "}
                  <span
                    class="lazers-trajectory-mono"
                    style={{ "font-family": ctx.appearance.font("mono") }}
                  >
                    {new Date(origin()!).toLocaleTimeString()}
                  </span>
                </Show>
              </span>
              <span class="lazers-trajectory-zoom" role="group" aria-label="Timeline zoom">
                <button
                  type="button"
                  class="lazers-trajectory-icon-button"
                  aria-label="Zoom out"
                  title="Zoom out"
                  disabled={zoom() <= ZOOM_LEVELS[0]}
                  onClick={() => changeZoom(nextZoom(zoom(), -1))}
                >
                  <Ui.Icon name="outline-magnifier-minus" size="small" />
                </button>
                <button
                  type="button"
                  class="lazers-trajectory-zoom-level"
                  aria-label={zoom() === 1 ? "Timeline fits the panel" : "Fit timeline to panel"}
                  title="Fit to panel"
                  disabled={zoom() === 1}
                  onClick={() => changeZoom(1)}
                >
                  {zoom()}×
                </button>
                <button
                  type="button"
                  class="lazers-trajectory-icon-button"
                  aria-label="Zoom in"
                  title="Zoom in"
                  disabled={zoom() >= ZOOM_LEVELS.at(-1)!}
                  onClick={() => changeZoom(nextZoom(zoom(), 1))}
                >
                  <Ui.Icon name="outline-magnifier-plus" size="small" />
                </button>
              </span>
            </div>
            <Show when={capturedAt() !== null}>
              <div
                class="lazers-trajectory-capture-stamp"
                title={`History captured ${new Date(capturedAt()!).toLocaleString(undefined, { timeZoneName: "short" })}${currentData()?.statusReadAt ? ` · live status read ${new Date(currentData()!.statusReadAt!).toLocaleString(undefined, { timeZoneName: "short" })}` : ""}`}
              >
                <span>
                  {settled()
                    ? `As of capture ${new Date(capturedAt()!).toLocaleTimeString()}`
                    : currentData()?.statusReadAt
                      ? `Live · status ${new Date(currentData()!.statusReadAt!).toLocaleTimeString()} · captured ${new Date(capturedAt()!).toLocaleTimeString()}`
                      : `Live · captured ${new Date(capturedAt()!).toLocaleTimeString()}`}
                </span>
                <Show when={settled()}>
                  <Ui.Button
                    variant="ghost"
                    size="small"
                    busy={currentData()?.loading}
                    onClick={() => void state.refresh({ force: true })}
                  >
                    Refresh
                  </Ui.Button>
                </Show>
              </div>
            </Show>
            <Show
              when={timeline()?.origin !== null && timeline()?.origin !== undefined}
              fallback={<div class="lazers-trajectory-note">No attempts have been recorded.</div>}
            >
              <div
                class="lazers-trajectory-scroll"
                ref={(element) => {
                  timelineScroll = element
                }}
              >
                <div class="lazers-trajectory-plot">
                  <div class="lazers-trajectory-axis" aria-hidden="true">
                    <span class="lazers-trajectory-label-cell" />
                    <div
                      class="lazers-trajectory-axis-track"
                      ref={(element) => {
                        axisObserver?.disconnect()
                        setAxisWidth(element.getBoundingClientRect().width)
                        axisObserver = new ResizeObserver((entries) =>
                          setAxisWidth(entries[0]?.contentRect.width ?? 0),
                        )
                        axisObserver.observe(element)
                      }}
                    >
                      <For each={visibleTicks(ticks(), timeline()?.durationMs ?? 0, axisWidth())}>
                        {(tick) => (
                          <span
                            class="lazers-trajectory-tick"
                            style={{
                              left: `${(tick.elapsedMs / (timeline()?.durationMs || 1)) * 100}%`,
                            }}
                          >
                            {tick.label}
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                  <div class="lazers-trajectory-gridlines" aria-hidden="true">
                    <For each={ticks()}>
                      {(tick) => (
                        <span
                          style={{
                            left: `${(tick.elapsedMs / (timeline()?.durationMs || 1)) * 100}%`,
                          }}
                        />
                      )}
                    </For>
                    <Show
                      when={
                        tracks()?.loadedThrough !== null && tracks()?.loadedThrough !== undefined
                      }
                    >
                      <span
                        class="lazers-trajectory-unloaded"
                        style={{ left: `${tracks()!.loadedThrough}%` }}
                        title="Later captured activity is not loaded"
                      />
                    </Show>
                  </div>

                  <div
                    class="lazers-trajectory-attempts"
                    role="listbox"
                    aria-label="Attempts"
                    aria-orientation="vertical"
                    onKeyDown={laneKeyDown(
                      () => (timeline()?.attempts ?? []).map((lane) => ({ id: lane.attempt.id })),
                      activeAttempt,
                      (mark) => state.selectAttempt(mark.id),
                    )}
                  >
                    <For each={attemptIDs()}>
                      {(attemptID) => {
                        const lane = () => attemptLanes().get(attemptID)!
                        const detail = () =>
                          report()?.attempts.find((attempt) => attempt.id === lane().attempt.id)
                        const outcome = () => attemptOutcome(lane().attempt.state)
                        const selected = () => attemptSelected(lane().attempt.id)
                        const duration = () => {
                          const value = detail()
                          return value ? attemptDuration(value, capturedAt()) : null
                        }
                        return (
                          <div
                            class="lazers-trajectory-attempt"
                            role="option"
                            data-mark-id={lane().attempt.id}
                            data-selected={selected()}
                            aria-selected={selected()}
                            tabIndex={activeAttempt() === lane().attempt.id ? 0 : -1}
                            aria-label={`Attempt ${lane().attempt.number}, ${lane().attempt.state}${duration() ? `, ${durationText(duration()!.ms)}${duration()!.open ? " so far" : ""}` : ""}, ${detail()?.toolCount.value.toLocaleString() ?? "unknown"} calls`}
                            title={lane().attempt.timingBasis}
                            onClick={() => state.selectAttempt(lane().attempt.id)}
                          >
                            <span class="lazers-trajectory-label-cell lazers-trajectory-attempt-label">
                              <span class="lazers-trajectory-attempt-number">
                                {lane().attempt.number}
                              </span>
                              <span class="lazers-trajectory-tool-count">
                                {detail()?.toolCount.value.toLocaleString() ?? "—"}
                              </span>
                            </span>
                            <div class="lazers-trajectory-track">
                              <For each={lane().segments}>
                                {(segment) => (
                                  <span
                                    class="lazers-trajectory-segment lazers-trajectory-rail"
                                    data-outcome={outcome()}
                                    data-start={segment.startRecorded ? "recorded" : "missing"}
                                    data-end={
                                      segment.open
                                        ? "open"
                                        : segment.endRecorded
                                          ? "recorded"
                                          : "missing"
                                    }
                                    data-failed={lane().attempt.state === "failed"}
                                    data-point={segment.pointOnly}
                                    data-open={segment.open}
                                    hidden={!segment.visible}
                                    title={
                                      segment.open
                                        ? `${segment.basis} · open until capture; end not recorded`
                                        : segment.basis
                                    }
                                    style={{
                                      left: `${segment.left}%`,
                                      width: `${segment.pointOnly ? 0 : segment.width}%`,
                                    }}
                                  />
                                )}
                              </For>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>

                  <div class="lazers-trajectory-lane" data-track="tools">
                    <span class="lazers-trajectory-label-cell">
                      <span>Tools</span>
                      <span class="lazers-trajectory-lane-count">
                        {tracks()?.tools.length.toLocaleString() ?? "0"}
                      </span>
                    </span>
                    <div
                      class="lazers-trajectory-track lazers-trajectory-mark-track"
                      role="listbox"
                      aria-label={`Tool calls, ${tracks()?.tools.length ?? 0} placed${tracks()?.gaps.length ? `, ${tracks()!.gaps.length} gaps` : ""}`}
                      aria-orientation="horizontal"
                      onKeyDown={laneKeyDown(laneMarks, activeTool, (mark) =>
                        state.selectEvent(mark.id),
                      )}
                      onClick={laneClick(laneMarks, (mark) => state.selectEvent(mark.id))}
                    >
                      <Show when={laneMarks().length === 0}>
                        <span class="lazers-trajectory-lane-empty">No timed tool calls loaded</span>
                      </Show>
                      <Index each={laneMarks()}>
                        {(item) => {
                          const selected = () =>
                            item().kind === "tool"
                              ? eventSelected(item().id, (item().mark as ToolMark).aliases)
                              : eventSelected(item().id)
                          return (
                            <span
                              class="lazers-trajectory-mark"
                              role="option"
                              data-mark-id={item().id}
                              data-kind={item().kind}
                              data-outcome={
                                item().kind === "tool"
                                  ? (item().mark as ToolMark).outcome
                                  : (item().mark as GapMark).kind
                              }
                              data-span={item().width > 0.4}
                              aria-selected={selected()}
                              tabIndex={activeTool() === item().id ? 0 : -1}
                              aria-label={
                                item().kind === "tool"
                                  ? `${(item().mark as ToolMark).tool}, ${outcomeText[(item().mark as ToolMark).outcome]}, ${at(item().at)}${attemptNumber(item().mark.attemptID) ? `, attempt ${attemptNumber(item().mark.attemptID)}` : ""}`
                                  : `${(item().mark as GapMark).label}, ${at(item().at)}`
                              }
                              title={
                                item().kind === "tool"
                                  ? `${(item().mark as ToolMark).tool} · ${outcomeText[(item().mark as ToolMark).outcome]} · ${at(item().at)}`
                                  : `${(item().mark as GapMark).label} · ${at(item().at)}`
                              }
                              style={{
                                left: `${item().left}%`,
                                width: item().width > 0.4 ? `${item().width}%` : undefined,
                              }}
                              onClick={() => state.selectEvent(item().id)}
                            >
                              <Show when={item().kind === "tool"}>
                                <span
                                  class="lazers-trajectory-rail"
                                  aria-hidden="true"
                                  data-start={
                                    (item().mark as ToolMark).start !== null
                                      ? "recorded"
                                      : "missing"
                                  }
                                  data-end={toolEndRecorded(item().mark as ToolMark)}
                                  data-failed={(item().mark as ToolMark).outcome === "failed"}
                                />
                              </Show>
                            </span>
                          )
                        }}
                      </Index>
                    </div>
                  </div>

                  <div class="lazers-trajectory-lane" data-track="files">
                    <span class="lazers-trajectory-label-cell">
                      <span>Files</span>
                      <span class="lazers-trajectory-lane-count">
                        {tracks()?.files.length.toLocaleString() ?? "0"}
                      </span>
                    </span>
                    <div
                      class="lazers-trajectory-track lazers-trajectory-mark-track"
                      role="listbox"
                      aria-label={`Recorded file activity, ${tracks()?.files.length ?? 0} targets`}
                      aria-orientation="horizontal"
                      onKeyDown={laneKeyDown(
                        () => tracks()?.files ?? [],
                        activeFile,
                        (mark: FileMark) => state.selectEvent(mark.id),
                      )}
                      onClick={laneClick(
                        () => tracks()?.files ?? [],
                        (mark) => state.selectEvent(mark.id),
                      )}
                    >
                      <Show when={(tracks()?.files.length ?? 0) === 0}>
                        <span class="lazers-trajectory-lane-empty">No file targets recorded</span>
                      </Show>
                      <Index each={tracks()?.files ?? []}>
                        {(mark) => (
                          <span
                            class="lazers-trajectory-mark lazers-trajectory-file-mark"
                            role="option"
                            data-mark-id={mark().id}
                            data-kind="file"
                            data-operation={mark().operation}
                            aria-selected={eventSelected(mark().id)}
                            tabIndex={activeFile() === mark().id ? 0 : -1}
                            data-outcome={mark().outcome}
                            aria-label={`${operationText[mark().operation]} ${mark().paths.join(", ")}${mark().coverage === "partial" ? " (partial)" : ""}, ${outcomeText[mark().outcome]}, ${at(mark().at)}`}
                            title={`${operationText[mark().operation]} · ${mark().paths.join(", ")} · ${outcomeText[mark().outcome]}`}
                            style={{ left: `${mark().left}%` }}
                            onClick={() => state.selectEvent(mark().id)}
                          >
                            <span
                              class="lazers-trajectory-rail"
                              aria-hidden="true"
                              data-start="recorded"
                              data-end="missing"
                              data-failed={mark().outcome === "failed"}
                            />
                          </span>
                        )}
                      </Index>
                    </div>
                  </div>

                  <div class="lazers-trajectory-lane lazers-trajectory-checks" data-track="checks">
                    <span class="lazers-trajectory-label-cell">
                      <span>Checks</span>
                      <span class="lazers-trajectory-lane-count">
                        {(timeline()?.checks.length ?? 0).toLocaleString()}
                      </span>
                    </span>
                    <div
                      class="lazers-trajectory-track lazers-trajectory-mark-track"
                      role="listbox"
                      aria-label={`Checks, ${timeline()?.checks.length ?? 0} recorded`}
                      aria-orientation="horizontal"
                      onKeyDown={laneKeyDown(checkLane, activeCheck, chooseCheck)}
                      onClick={laneClick(
                        () => checkLane().map((item) => ({ ...item, left: item.check.left })),
                        chooseCheck,
                      )}
                    >
                      <Show when={checkLane().length === 0}>
                        <span class="lazers-trajectory-lane-empty">
                          {(timeline()?.checks.length ?? 0) > 0
                            ? "Check times not recorded"
                            : "No checks recorded"}
                        </span>
                      </Show>
                      <For each={checkIDs()}>
                        {(checkID) => {
                          const entry = () => checkItems().get(checkID)!
                          const detailed = () => selectionForTimelineCheck(entry().check)
                          const timing = () => checkTiming(entry().check)
                          const outcome = () =>
                            checkOutcome(detailed()?.result ?? "unknown", entry().check.state)
                          const selected = () => checkSelected(entry().check)
                          const name = () =>
                            `${entry().check.scope === "plan" ? "Plan check" : `Attempt ${attemptNumber(entry().check.attemptID) ?? "?"} check`} ${entry().check.checkID}`
                          return (
                            <>
                              <span
                                class="lazers-trajectory-check-interval lazers-trajectory-rail"
                                data-start={
                                  timing().status === "missing-start" ||
                                  timing().status === "missing-endpoints"
                                    ? "missing"
                                    : "recorded"
                                }
                                data-end={
                                  timing().status === "known" || timing().status === "missing-start"
                                    ? "recorded"
                                    : "missing"
                                }
                                data-failed={detailed()?.result === "failed"}
                                data-check-id={entry().check.checkID}
                                data-scope={entry().check.scope}
                                data-result={detailed()?.result ?? "unknown"}
                                data-point={entry().check.pointOnly}
                                data-selected={selected()}
                                data-invalid={timing().status === "invalid-order"}
                                aria-hidden="true"
                                style={{
                                  left: `${entry().check.left}%`,
                                  width: `${entry().check.width}%`,
                                }}
                              />
                              <Show
                                when={
                                  timing().status === "invalid-order" &&
                                  entry().check.endLeft !== null
                                }
                              >
                                <span
                                  class="lazers-trajectory-check-endpoint"
                                  aria-hidden="true"
                                  style={{
                                    left: `${entry().check.endLeft}%`,
                                  }}
                                />
                              </Show>
                              <span
                                class="lazers-trajectory-check-marker"
                                role="option"
                                data-mark-id={entry().id}
                                data-check-id={entry().check.checkID}
                                data-scope={entry().check.scope}
                                data-outcome={outcome()}
                                data-point={entry().check.pointOnly}
                                data-result={detailed()?.result ?? "unknown"}
                                aria-selected={selected()}
                                tabIndex={activeCheck() === entry().id ? 0 : -1}
                                aria-label={`${name()}, ${detailed()?.result ?? entry().check.state}, ${timingHint(entry().check)}`}
                                title={`${name()} · ${outcomeText[outcome()]} · ${entry().check.timingBasis}`}
                                style={{
                                  left: `${entry().check.left}%`,
                                  width: `${entry().check.width}%`,
                                }}
                                onClick={() => chooseCheck(entry())}
                              />
                            </>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </div>
              </div>
              <div class="lazers-trajectory-coverage-line">
                <For each={coverageParts()}>{(part) => <span>{part}</span>}</For>
                <Show when={currentData()?.eventCursor}>
                  <span>
                    {currentData()?.events.length.toLocaleString()} of{" "}
                    {currentData()?.totalEvents.toLocaleString()} captured events loaded
                  </span>
                  <Show when={!currentData()?.pageRecaptureRequired}>
                    <Ui.Button
                      variant="ghost"
                      size="small"
                      busy={currentData()?.loadingActivity || currentData()?.recapturingHistory}
                      onClick={() => void state.loadMoreActivity()}
                    >
                      Load more
                    </Ui.Button>
                  </Show>
                </Show>
                <Show when={currentData()?.historyError}>
                  <div class="lazers-trajectory-error" role="alert">
                    <span>{currentData()?.historyError}</span>
                    <Ui.Button
                      variant="ghost"
                      size="small"
                      busy={currentData()?.recapturingHistory}
                      onClick={() => void state.recaptureActivity()}
                    >
                      Recapture history
                    </Ui.Button>
                  </div>
                </Show>
              </div>
            </Show>
          </section>
        </Show>
      </div>

      <div
        class="lazers-trajectory-separator"
        ref={(element) => {
          separator = element
        }}
        role="separator"
        aria-label="Resize trajectory inspector"
        aria-controls="lazers-trajectory-top lazers-trajectory-inspector"
        aria-orientation="horizontal"
        aria-valuemin={20}
        aria-valuemax={75}
        aria-valuenow={Math.round(split())}
        aria-valuetext={`Timeline ${Math.round(split())}% of panel height`}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key))
            return
          event.preventDefault()
          const key =
            event.key === "PageUp" ? "ArrowUp" : event.key === "PageDown" ? "ArrowDown" : event.key
          splitTo(splitFromKey(split(), key, event.key.startsWith("Page") ? 15 : 5))
          save({ split: split() })
        }}
      />

      <div
        class="lazers-trajectory-inspector"
        id="lazers-trajectory-inspector"
        ref={(element) => {
          inspectorPane = element
        }}
      >
        <Show
          when={currentData()?.selection}
          fallback={
            <div class="lazers-trajectory-note">
              {report() ? "Select an attempt, tool call, file or check on the timeline." : ""}
            </div>
          }
        >
          <>
            <Show when={selectedCheck()}>
              {(check) => (
                <>
                  <div class="lazers-trajectory-inspector-heading">
                    <h3>
                      {check().scope === "attempt" && selectedAttempt()
                        ? `Attempt ${selectedAttempt()!.number} · `
                        : ""}
                      {checkLabel(check())}
                    </h3>
                    <OutcomeBadge
                      outcome={checkOutcome(check().result, check().state)}
                      text={checkResult(check())}
                      result={check().result}
                    />
                  </div>
                  <div class="lazers-trajectory-metadata">
                    <p>
                      {check().scope === "plan" ? "Plan check" : "Attempt check"} · {check().state}
                    </p>
                    <p>{endpointText("Start", check().startedAt, origin())}</p>
                    <p>{endpointText("End", check().endedAt, origin())}</p>
                    <p
                      role={checkTiming(check()).status === "invalid-order" ? "alert" : "status"}
                      aria-live={
                        checkTiming(check()).status === "invalid-order" ? "assertive" : "polite"
                      }
                    >
                      {checkTiming(check()).status === "known"
                        ? `Elapsed duration · ${elapsedText(checkTiming(check()).durationMs!)}`
                        : `Duration unavailable · ${checkTiming(check()).reason}`}
                    </p>
                    <p>Timing source · {check().timingBasis}</p>
                  </div>
                  <div class="lazers-trajectory-source-links">
                    <For each={checkSources(check())}>
                      {(reference) => (
                        <button type="button" onClick={() => openSource(reference)}>
                          {reference.path}:{reference.line}
                          {reference.column ? `:${reference.column}` : ""}
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={check().scope === "attempt" && selectedAttempt()}>
                    {(attempt) => (
                      <button
                        type="button"
                        class="lazers-trajectory-session-link"
                        onClick={() => openAttemptSession(attempt().sessionID)}
                      >
                        Open worker session <Ui.Icon name="square-arrow-top-right" size="small" />
                      </button>
                    )}
                  </Show>
                  <details class="lazers-trajectory-payload">
                    <summary>Check output</summary>
                    <div class="lazers-trajectory-metadata">
                      <Show when={check().timedOut}>
                        <p>Timed out</p>
                      </Show>
                    </div>
                    <pre>{checkOutput(check())}</pre>
                  </details>
                </>
              )}
            </Show>

            <Show when={selection()?.kind === "attempt" && selectedAttempt()}>
              {(attempt) => {
                const duration = () => attemptDuration(attempt(), capturedAt())
                const admitted = () => attempt().admittedModel
                const observed = () => attempt().observedCurrentModel
                return (
                  <>
                    <div class="lazers-trajectory-inspector-heading">
                      <h3>Attempt {attempt().number}</h3>
                      <OutcomeBadge
                        outcome={attemptOutcome(attempt().state)}
                        text={attempt().state}
                      />
                    </div>
                    <div class="lazers-trajectory-metadata">
                      <p>
                        Model ·{" "}
                        {(observed() ?? admitted())
                          ? `${(observed() ?? admitted())!.providerID} / ${modelLabel(observed() ?? admitted())}`
                          : "not recorded"}
                        {observed() &&
                        admitted() &&
                        modelLabel(observed()) !== modelLabel(admitted())
                          ? ` · admitted as ${modelLabel(admitted())}`
                          : ""}
                      </p>
                      <p>
                        Started ·{" "}
                        {timeText(attempt().intervals.attempt.startedAt ?? attempt().startedAt)}
                      </p>
                      <p>
                        {attempt().intervals.attempt.endedAt !== null
                          ? `Ended · ${timeText(attempt().intervals.attempt.endedAt)}`
                          : duration()?.open
                            ? `Running as of capture · ${timeText(capturedAt())}`
                            : "End not recorded"}
                      </p>
                      <p>
                        Duration ·{" "}
                        {duration()
                          ? `${durationText(duration()!.ms)}${duration()!.open ? " so far" : ""}`
                          : "unavailable"}
                      </p>
                      <p>
                        Tool calls · {attempt().toolCount.value.toLocaleString()} (runner count)
                      </p>
                      <p>Timing source · {attempt().intervals.attempt.basis}</p>
                    </div>
                    <button
                      type="button"
                      class="lazers-trajectory-session-link"
                      onClick={() => openAttemptSession(attempt().sessionID)}
                    >
                      Open worker session <Ui.Icon name="square-arrow-top-right" size="small" />
                    </button>
                  </>
                )
              }}
            </Show>

            <Show when={selectedTool()}>
              {(tool) => (
                <>
                  <div class="lazers-trajectory-inspector-heading">
                    <h3
                      class="lazers-trajectory-mono"
                      style={{ "font-family": ctx.appearance.font("mono") }}
                    >
                      {tool().tool}
                    </h3>
                    <OutcomeBadge outcome={tool().outcome} />
                  </div>
                  <div class="lazers-trajectory-metadata">
                    <p>
                      {attemptNumber(tool().attemptID)
                        ? `Attempt ${attemptNumber(tool().attemptID)} · `
                        : ""}
                      Tool call
                    </p>
                    <p>
                      Called · {tool().start === null ? "not recorded" : timeText(tool().start)}
                    </p>
                    <p>Completed · {tool().end === null ? "not recorded" : timeText(tool().end)}</p>
                    <p>
                      Duration ·{" "}
                      {tool().start !== null && tool().end !== null && tool().end! >= tool().start!
                        ? durationText(tool().end! - tool().start!)
                        : "unavailable"}
                    </p>
                    <p>
                      Timing source · {tool().startSource ?? "not recorded"}
                      {tool().endSource ? ` → ${tool().endSource}` : ""}
                    </p>
                  </div>
                  <Show when={tool().files}>
                    {(files) => (
                      <section class="lazers-trajectory-files" aria-label="Recorded file activity">
                        <h4>
                          {files().operation ? operationText[files().operation!] : "File targets"}
                          {files().coverage === "partial" ? " · some paths not recorded" : ""}
                        </h4>
                        <Show
                          when={files().paths.length > 0}
                          fallback={<p>Paths were not recorded for this call.</p>}
                        >
                          <ul>
                            <For each={files().paths}>
                              {(path) => (
                                <li style={{ "font-family": ctx.appearance.font("mono") }}>
                                  {path}
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </section>
                    )}
                  </Show>
                  <Show when={tool().sessionID}>
                    {(sessionID) => (
                      <button
                        type="button"
                        class="lazers-trajectory-session-link"
                        onClick={() => openAttemptSession(sessionID())}
                      >
                        Open worker session <Ui.Icon name="square-arrow-top-right" size="small" />
                      </button>
                    )}
                  </Show>
                  <Show when={toolOutput(tool())}>
                    <details class="lazers-trajectory-payload">
                      <summary>Result</summary>
                      <pre>{toolOutput(tool())}</pre>
                    </details>
                  </Show>
                  <Show when={selectedEvent()}>
                    {(event) => (
                      <details class="lazers-trajectory-payload">
                        <summary>Payload</summary>
                        <pre>{JSON.stringify(eventPayload(event()), null, 2)}</pre>
                      </details>
                    )}
                  </Show>
                </>
              )}
            </Show>

            <Show when={!selectedTool() && selectedEvent()}>
              {(event) => (
                <>
                  <div class="lazers-trajectory-inspector-heading">
                    <h3>{selectedGap()?.label ?? eventTitle(event())}</h3>
                    <span class="lazers-trajectory-result">{eventTime(event())}</span>
                  </div>
                  <div class="lazers-trajectory-metadata">
                    <p>
                      {event().kind} · {timeText(event().at ?? null)}
                    </p>
                    <Show when={event().sessionID}>
                      {(sessionID) => (
                        <button
                          type="button"
                          class="lazers-trajectory-session-link"
                          onClick={() => openAttemptSession(sessionID())}
                        >
                          Open worker session <Ui.Icon name="square-arrow-top-right" size="small" />
                        </button>
                      )}
                    </Show>
                  </div>
                  <details class="lazers-trajectory-payload">
                    <summary>Payload</summary>
                    <pre>{JSON.stringify(eventPayload(event()), null, 2)}</pre>
                  </details>
                </>
              )}
            </Show>

            <Show when={checksForInspector().length > 0}>
              <section class="lazers-trajectory-section">
                <div class="lazers-trajectory-section-heading">
                  <h4>Checks</h4>
                </div>
                <ul class="lazers-trajectory-check-list" aria-label="Recorded checks">
                  <For each={checksForInspector()}>
                    {(check) => (
                      <li>
                        <button
                          type="button"
                          class="lazers-trajectory-check-row"
                          aria-pressed={
                            selection()?.kind === "check" && selection()?.id === checkKey(check)
                          }
                          onClick={() => state.selectCheck(checkKey(check))}
                        >
                          <span
                            class="lazers-trajectory-check-glyph"
                            data-outcome={checkOutcome(check.result, check.state)}
                          >
                            <Ui.Icon
                              name={outcomeIcon[checkOutcome(check.result, check.state)]}
                              size="small"
                            />
                          </span>
                          <span
                            class="lazers-trajectory-check-name"
                            style={{ "font-family": ctx.appearance.font("mono") }}
                          >
                            {checkLabel(check)}
                          </span>
                          <span class="lazers-trajectory-check-status">{checkResult(check)}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            <Show when={report()}>
              {(currentReport) => {
                const usage = () => currentReport().effort.tokenUsage
                const tokenValue = (
                  key: keyof TrajectoryReport["effort"]["tokenUsage"]["measuredSubtotal"],
                ) => {
                  const value = usage().total?.[key] ?? usage().measuredSubtotal[key]
                  return value === null ? "—" : value.toLocaleString()
                }
                const partial = () => usage().total === null
                const apiCost = () => currentReport().effort.recordedCost.apiEquivalentTotalUsd
                const marketCost = () => currentReport().effort.marketEquivalentCost
                const marketEstimate = () => marketCost()?.observedUsageEstimate
                const selectedEstimate = () => {
                  const estimate = marketEstimate()
                  return estimate &&
                    (estimate.valueUSD !== null ||
                      estimate.rangeUSD !== null ||
                      estimate.pricedPortionUSD !== null)
                    ? estimate
                    : null
                }
                const marketStatus = () => marketCost()?.status ?? "unknown"
                const formatMarketUSD = (value: number) =>
                  `$${new Intl.NumberFormat("en-US", {
                    maximumSignificantDigits: 8,
                    useGrouping: false,
                  }).format(value)}`
                const displayedMarketCost = () => {
                  const estimate = selectedEstimate()
                  if (estimate?.valueUSD !== null && estimate?.valueUSD !== undefined)
                    return `${formatMarketUSD(estimate.valueUSD)} estimate`
                  if (estimate?.rangeUSD)
                    return `${formatMarketUSD(estimate.rangeUSD.minimum)}–${formatMarketUSD(estimate.rangeUSD.maximum)} estimate range`
                  if (estimate?.pricedPortionUSD) {
                    const { minimum, maximum } = estimate.pricedPortionUSD
                    const amount =
                      minimum === maximum
                        ? formatMarketUSD(minimum)
                        : `${formatMarketUSD(minimum)}–${formatMarketUSD(maximum)}`
                    return `${amount} priced portion`
                  }
                  const value = apiCost()
                  if (value !== null) return formatMarketUSD(value)
                  const subtotal = marketCost()?.subtotalUSD ?? null
                  return subtotal === null || subtotal <= 0
                    ? "—"
                    : `${formatMarketUSD(subtotal)} subtotal`
                }
                const indexPriceSourceSummary = () => {
                  const index = marketCost()?.currentIndex
                  if (!index) return "Price source unavailable"
                  const sources = index.sources.map(
                    (source) =>
                      `${source.source === "openrouter-models" ? "OpenRouter" : "OpenCode"} · generation ${source.generation}`,
                  )
                  return `${sources.join("; ") || "No selected cached price source"} · ${index.freshness} freshness`
                }
                const priceSourceSummary = () => {
                  const estimate = selectedEstimate()
                  const estimateSources = estimate?.sources ?? []
                  if (estimateSources.length) {
                    const descriptions = estimateSources.map(
                      (source) =>
                        `${source.source === "openrouter-models" ? "OpenRouter" : "OpenCode"} · generation ${source.generation} · ${source.priceBasis}`,
                    )
                    return `${descriptions.join("; ")} · ${estimate?.freshness} freshness`
                  }
                  return indexPriceSourceSummary()
                }
                const categories = [
                  ["Uncached input", "uncachedInput"],
                  ["Cache read", "cacheRead"],
                  ["Cache write", "cacheWrite"],
                  ["Output", "output"],
                  ["Reasoning", "reasoning"],
                ] as const
                return (
                  <>
                    <section class="lazers-trajectory-section" aria-label="Token usage">
                      <div class="lazers-trajectory-section-heading">
                        <h4>Tokens</h4>
                        <span class="lazers-trajectory-token-scope">
                          Worker attempts only · all {currentReport().attempts.length}
                        </span>
                      </div>
                      <Show when={partial()}>
                        <div class="lazers-trajectory-coverage" role="status">
                          Known subtotal · full total unavailable; {usage().knownSessions} of{" "}
                          {usage().totalSessions} unique worker sessions have token snapshots.
                        </div>
                      </Show>
                      <For each={categories}>
                        {([label, key]) => (
                          <div class="lazers-trajectory-token-row">
                            <span>{label}</span>
                            <output>{tokenValue(key)}</output>
                          </div>
                        )}
                      </For>
                      <div
                        class="lazers-trajectory-cost"
                        title="Market-equivalent worker usage is not actual provider charges or full task cost."
                      >
                        <span>
                          {selectedEstimate()
                            ? `${selectedEstimate()!.label}${selectedEstimate()!.status === "partial" ? " · partial" : ""}`
                            : `API equivalent · ${marketStatus()}`}
                        </span>
                        <span>{displayedMarketCost()}</span>
                      </div>
                      <Show when={marketCost()}>
                        <div class="lazers-trajectory-coverage">
                          <span>{priceSourceSummary()}</span>
                        </div>
                        <details class="lazers-trajectory-payload lazers-trajectory-valuation">
                          <summary>Pricing coverage and provenance</summary>
                          <p>{marketCost()!.meaning}</p>
                          <Show when={selectedEstimate() && apiCost() !== null}>
                            <div class="lazers-trajectory-coverage">
                              Strict-index API equivalent · {formatMarketUSD(apiCost()!)} ·{" "}
                              {indexPriceSourceSummary()}
                            </div>
                          </Show>
                          <Show when={marketCost()!.currentIndex}>
                            {(index) => (
                              <div class="lazers-trajectory-coverage">
                                <div>Models index {index().indexID}</div>
                                <div>Read {new Date(index().retrievedAt).toLocaleString()}</div>
                                <For each={index().sources}>
                                  {(source) => (
                                    <div>
                                      {source.source} · snapshot {source.snapshotID} · generation{" "}
                                      {source.generation} · {source.priceBasis} · {source.rateUnit}
                                      {source.asOf ? ` · as of ${source.asOf}` : ""}
                                    </div>
                                  )}
                                </For>
                              </div>
                            )}
                          </Show>
                          <div class="lazers-trajectory-coverage">
                            {marketCost()!.coverage.pricedSessions} /{" "}
                            {marketCost()!.coverage.totalUniqueSessions} sessions fully priced ·{" "}
                            {marketCost()!.coverage.partialSessions} partial ·{" "}
                            {marketCost()!.coverage.unpricedSessionIDs.length} unpriced
                          </div>
                          <For each={marketCost()!.sessions}>
                            {(session) => (
                              <div class="lazers-trajectory-coverage">
                                <span>
                                  Session {session.sessionID} · {session.status} · route{" "}
                                  {session.routeAllocation.status} · price {session.pinStatus}
                                </span>
                                <span>
                                  <For each={Object.entries(session.categories)}>
                                    {([name, category]) => (
                                      <span>
                                        {name}: {category.status}
                                        {category.valueUSD === null
                                          ? ""
                                          : ` · ${formatMarketUSD(category.valueUSD)}`}{" "}
                                      </span>
                                    )}
                                  </For>
                                </span>
                              </div>
                            )}
                          </For>
                        </details>
                      </Show>
                      <Show when={marketEstimate()}>
                        {(estimate) => (
                          <details class="lazers-trajectory-payload lazers-trajectory-valuation">
                            <summary>
                              Estimate assumptions and published-rate basis ·{" "}
                              {estimate().retainedCallCount} retained calls
                            </summary>
                            <div>Estimate basis · {estimate().basis}</div>
                            <p>{estimate().meaning}</p>
                            <div class="lazers-trajectory-coverage">
                              <strong>Published sources and freshness</strong>
                              <For each={estimate().sources}>
                                {(source) => (
                                  <div>
                                    {source.source} · snapshot {source.snapshotID} · generation{" "}
                                    {source.generation}
                                    {source.currentGeneration !== source.generation
                                      ? ` · current generation ${source.currentGeneration}`
                                      : ""}{" "}
                                    · {source.priceBasis} · {source.freshness} · read{" "}
                                    {new Date(source.retrievedAt).toLocaleString()} ·{" "}
                                    <a href={source.sourceURL} target="_blank" rel="noreferrer">
                                      {source.sourceURL}
                                    </a>
                                  </div>
                                )}
                              </For>
                            </div>
                            <div class="lazers-trajectory-coverage">
                              <strong>Selected rates · USD per token</strong>
                              <For each={estimate().rateSets}>
                                {(rateSet) => (
                                  <div>
                                    {rateSet.tierID}
                                    {rateSet.minPromptTokens === null
                                      ? ""
                                      : ` · prompt override above ${rateSet.minPromptTokens.toLocaleString()} tokens`}
                                    {rateSet.contextTierTokens === null
                                      ? ""
                                      : ` · context tier ${rateSet.contextTierTokens.toLocaleString()} tokens`}
                                    {` · prompt ${rateSet.prompt ?? "—"} · completion ${rateSet.completion ?? "—"} · cache read ${rateSet.cacheRead ?? "—"} · cache write ${rateSet.cacheWrite ?? "—"}`}
                                  </div>
                                )}
                              </For>
                              <div>
                                Tier attribution · {estimate().tierAttribution.status} ·{" "}
                                {estimate().tierAttribution.basis}
                                {estimate().tierAttribution.thresholdSemantics
                                  ? ` · ${estimate().tierAttribution.thresholdSemantics}`
                                  : ""}
                              </div>
                            </div>
                            <div class="lazers-trajectory-coverage">
                              <strong>Secondary assumptions and limitations</strong>
                              <For each={estimate().assumptions}>
                                {(assumption) => <div>{assumption}</div>}
                              </For>
                              <div>
                                Recovery gaps · {estimate().recoveryGapCount} · exact historical
                                bill is not guaranteed.
                              </div>
                            </div>
                          </details>
                        )}
                      </Show>
                      <div class="lazers-trajectory-coverage">
                        <span>
                          {usage().knownSessions} / {usage().totalSessions} unique sessions ·{" "}
                          {usage().unknownAttempts.length} worker-session token gaps
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          Context {currentReport().coverage.availableSessionContexts} available ·{" "}
                          {currentReport().coverage.unavailableSessionContexts} unavailable
                        </span>
                        <Show when={currentReport().coverage.compacted}>
                          <span>Compacted context; complete history is not guaranteed.</span>
                        </Show>
                      </div>
                    </section>
                    <details class="lazers-trajectory-activity">
                      <summary>Captured activity · {currentData()?.totalEvents ?? 0}</summary>
                      <div class="lazers-trajectory-activity-list">
                        <div class="lazers-trajectory-capture-note" role="status">
                          <span>
                            {currentData()?.historyCapturedAt
                              ? `Captured ${new Date(currentData()!.historyCapturedAt!).toLocaleString()} · expires ${new Date(currentData()!.historyExpiresAt!).toLocaleTimeString()}`
                              : "History capture time unavailable"}
                          </span>
                          <Ui.Button
                            variant="ghost"
                            size="small"
                            busy={currentData()?.recapturingHistory}
                            onClick={() => void state.recaptureActivity()}
                          >
                            Recapture history
                          </Ui.Button>
                        </div>
                        <Show when={currentData()?.historyError}>
                          <div class="lazers-trajectory-error" role="alert">
                            {currentData()?.historyError}
                          </div>
                        </Show>
                        <For each={currentData()?.events ?? []}>
                          {(event) => (
                            <button
                              type="button"
                              class="lazers-trajectory-event"
                              data-scroll-anchor={`history:${event.id}`}
                              aria-pressed={
                                currentData()?.selection?.kind === "event" &&
                                currentData()?.selection?.id === event.id
                              }
                              onClick={() => state.selectEvent(event.id)}
                            >
                              <span class="lazers-trajectory-event-title">{eventTitle(event)}</span>
                              <time>{eventTime(event)}</time>
                            </button>
                          )}
                        </For>
                        <Show when={currentData()?.eventCursor}>
                          <Show
                            when={currentData()?.pageRecaptureRequired}
                            fallback={
                              <Ui.Button
                                variant="ghost"
                                size="small"
                                busy={
                                  currentData()?.loadingActivity ||
                                  currentData()?.recapturingHistory
                                }
                                onClick={() => void state.loadMoreActivity()}
                              >
                                Load more activity
                              </Ui.Button>
                            }
                          >
                            <Ui.Button
                              variant="ghost"
                              size="small"
                              busy={currentData()?.recapturingHistory}
                              onClick={() => void state.recaptureActivity()}
                            >
                              Recapture history
                            </Ui.Button>
                          </Show>
                        </Show>
                      </div>
                    </details>
                    <Show when={(currentData()?.liveEvents.length ?? 0) > 0}>
                      <details class="lazers-trajectory-live">
                        <summary>Live progress · {currentData()?.liveEvents.length ?? 0}</summary>
                        <p class="lazers-trajectory-live-note">
                          Current progress is shown separately; captured history stays as of its
                          capture until you recapture it.
                        </p>
                        <div class="lazers-trajectory-activity-list">
                          <For each={currentData()?.liveEvents ?? []}>
                            {(event) => (
                              <button
                                type="button"
                                class="lazers-trajectory-event"
                                data-scroll-anchor={`live:${event.id}`}
                                aria-pressed={
                                  currentData()?.selection?.kind === "event" &&
                                  currentData()?.selection?.id === event.id
                                }
                                onClick={() => state.selectEvent(event.id)}
                              >
                                <span class="lazers-trajectory-event-title">
                                  {eventTitle(event)}
                                </span>
                                <time>{eventTime(event)}</time>
                              </button>
                            )}
                          </For>
                        </div>
                      </details>
                    </Show>
                  </>
                )
              }}
            </Show>
          </>
        </Show>
      </div>
    </div>
  )
}

export function setupTrajectoryPanel(ctx: TrajectoryContext) {
  const Ui = ctx.ui
  registerTrajectoryPanel(
    ctx,
    css,
    bindPlugin((props: PanelProps) => <PanelView {...props} ctx={ctx} />),
    () => (
      <div class="flex min-w-0 items-center gap-1.5">
        <Ui.Icon name="branch" size="small" class="shrink-0" />
        <span class="truncate">Trajectory</span>
      </div>
    ),
  )
}
