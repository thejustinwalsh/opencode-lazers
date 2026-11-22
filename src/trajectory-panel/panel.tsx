import { Store, bindPlugin, createKeyed, createLatest, usePanel } from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js"
import { Streams } from "../streams/contract.ts"
import { rpcStreamsTransport } from "../streams/gui.ts"
import type { StreamsRpc } from "../streams/gui.ts"
import { endPadding, laneCountText, rulerLabels, slowSeconds } from "./panel-layout.ts"
import { DetailsPane } from "../details-pane.tsx"
import { sizeFromLegacySplit, storedState } from "../details-pane.ts"
import { PanelIcon } from "./icons.tsx"
import { AttemptPane, CallPane, clock, startedText } from "./details-body.tsx"
import type { CallPaneProps } from "./details-body.tsx"
import {
  attemptSummary,
  endReason,
  eventsForAttempt,
  priceIdentifiers,
  recordGapCount,
} from "./attempt-summary.ts"
import { eventIsError, eventLabel, translateRuntimeWords } from "./event-names.ts"
import type { EventFilter } from "./event-names.ts"
import { isSpanWidth, layoutMarks } from "./marks.ts"
import type { MarkGlyph } from "./marks.ts"
import { taskStatePresentation } from "./state-presentation.ts"
import {
  attemptActive,
  attemptDuration,
  attemptName,
  attemptSignals,
  lastWorkerActivity,
  reportTaskView,
  taskReason,
} from "./attempt-state.ts"
import { Label } from "../details/index.ts"
import { TaskRing } from "../tasks/state-glyph.tsx"
import { isRingGlyph } from "../tasks/row-presentation.ts"
import type { TaskGlyph } from "../tasks/row-presentation.ts"
import type { PanelPreferences, Selection, TaskTrajectoryTarget } from "./panel-state.ts"
import { createTrajectoryModel, selectedAttemptFor, selectedEventFor } from "./panel-state.ts"
import type { TrajectoryModel } from "./panel-state.ts"
import {
  buildTimeline,
  checkTiming,
  checkKey,
  detailedChecks,
  displayTitle,
  durationText,
  elapsedDurationLabel,
  eventPayload,
  currentTaskState,
  isActiveAttemptState,
  sourceReferences,
} from "./projection.ts"
import type {
  CheckTimeline,
  DetailedCheck,
  TrajectoryAttempt,
  TrajectoryEvent,
} from "./projection.ts"
import { createPanelStatus, PanelStatus } from "../panel-status.tsx"
import { registerTrajectoryPanel } from "./registration.ts"
import {
  attemptOutcome,
  buildTracks,
  checkOutcome,
  loadedEventHorizon,
  nearestMark,
  neighborMark,
  outcomeText,
  trackTimes,
} from "./tracks.ts"
import type { FileMark, GapMark, Outcome, ToolMark } from "./tracks.ts"
import {
  DRAG_SLOP_PX,
  KEY_PAN_SHARE,
  clampScroll,
  maxZoom,
  panBy,
  shortestFeature,
  stepZoom,
  wheelZoomFactor,
  zoomAbout,
} from "./viewport.ts"
import type { Viewport } from "./viewport.ts"
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
  /** Retired timeline/inspector split; read once to size the details pane. */
  split: Schema.optionalKey(Schema.Number),
  /** Details pane: closed by default; size is the body's fraction of the panel. */
  open: Schema.optionalKey(Schema.Boolean),
  size: Schema.optionalKey(Schema.Number),
  zoom: Schema.optionalKey(Schema.Number),
})
const initial: typeof View.Type = {
  scope: "session",
  selectedTaskID: null,
  selectedReference: null,
  target: null,
  selectedKind: "",
  selectedRecordID: "",
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

const capitalize = (word: string) => (word ? word[0]!.toUpperCase() + word.slice(1) : word)

const checkWord = (check: { result: string; state: string }) =>
  check.result === "passed"
    ? "Passed"
    : check.result === "failed"
      ? "Failed"
      : capitalize(check.state)

/** The source of a timing, without the recorder's notes about what it lacks. */
const basisText = (basis: string) => basis.split(";")[0]!.trim()

const firstLine = (text: string, max = 140) => {
  const line = text.trim().split(/\r?\n/)[0] ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function timingHint(check: { startedAt: number | null; endedAt: number | null }) {
  const timing = checkTiming(check)
  return timing.status === "known" ? `duration ${durationText(timing.durationMs)}` : ""
}

function attemptModel(attempt: TrajectoryAttempt | undefined) {
  return attempt?.observedCurrentModel ?? attempt?.admittedModel ?? null
}

function modelLabel(model: NonNullable<ReturnType<typeof attemptModel>>) {
  return `${model.id}${model.variant ? ` · ${model.variant}` : ""}`
}

/** One glyph per outcome, never shared; an outcome that was not recorded draws none. */
const outcomeGlyph: Record<Outcome, TaskGlyph | null> = {
  succeeded: "disc-check",
  failed: "circle-x",
  running: "ring-progress",
  unknown: null,
}

/** Locations already resolved for a session, so a re-mounted panel does not wait on the read. */
type LocationSource = {
  client: PanelProps["session"]["server"]["client"]
  server: string
  session: string
  directory: string
  project: string
  projectID: string
}
const locationSeeds = new Map<string, LocationSource>()

type LaneMark =
  | { kind: "tool"; id: string; left: number; width: number; at: number; mark: ToolMark }
  | { kind: "gap"; id: string; left: number; width: number; at: number; mark: GapMark }

export type TrajectoryOpeners = {
  openTask(
    session: PanelProps["session"],
    target: { projectDirectory: string; taskID: string },
  ): void
}

function PanelView(
  props: PanelProps & { ctx: TrajectoryContext; openers?: TrajectoryOpeners | undefined },
) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
  const [model, setModel] = createSignal<TrajectoryModel>()
  const [zoom, setZoom] = createSignal(1)
  /** Left edge of the visible time, as a fraction of the zoomed track; survives resize and remount. */
  const [pan, setPan] = createSignal(0)
  /** Width in px of the time track at zoom 1, measured from the scroller. */
  const [fitPx, setFitPx] = createSignal(0)
  const [expanded, setExpanded] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [axisWidth, setAxisWidth] = createSignal(0)
  let axisObserver: ResizeObserver | undefined
  let inspectorPane: HTMLDivElement | undefined
  let timelineScroll: HTMLDivElement | undefined
  let timelineDialog: HTMLDialogElement | undefined
  let expandButton: HTMLButtonElement | undefined
  let scrollObserver: ResizeObserver | undefined
  /** Calls before the model exists (no connection yet) do nothing. */
  const state = {
    selectTask: (taskID: string) => model()?.selectTask(taskID),
    selectTarget: (target: TaskTrajectoryTarget) => model()?.selectTarget(target),
    selectAttempt: (id: string) => model()?.selectAttempt(id),
    selectCheck: (id: string) => model()?.selectCheck(id),
    selectEvent: (id: string) => model()?.selectEvent(id),
  }
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
  const seedKey = () => `${props.session.server.id}\u0000${props.session.id}`
  const matches = (value: LocationSource | undefined): value is LocationSource =>
    Boolean(
      value &&
      value.session === props.session.id &&
      value.server === props.session.server.id &&
      value.directory === props.session.directory,
    )
  createEffect(() => {
    const value = source.latest
    if (value && !source.loading && matches(value)) locationSeeds.set(seedKey(), value)
  })
  /** The resolved location; a location already resolved for this session stands in while it reloads. */
  const current = () => {
    if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
    const value = source.latest
    if (matches(value) && !source.loading) return value
    const seed = locationSeeds.get(seedKey())
    return matches(seed) ? seed : undefined
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

  /** The time in view, epoch ms; the stream windows follow it. */
  const [viewRange, setViewRange] = createSignal<{ from: number; to: number }>()
  const [connection, setConnection] = createSignal<AbortController>()
  /** Bumped by Retry: the connection is made again. */
  const [attempt, setAttempt] = createSignal(0)
  const retry = () => setAttempt((count) => count + 1)
  onCleanup(() => {
    connection()?.abort()
    axisObserver?.disconnect()
    scrollObserver?.disconnect()
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
          attempt(),
        ]),
      }
    },
    ({ value, view, key }) => {
      // A timeline opens fitted to the panel; zoom is a deliberate, momentary choice.
      setZoom(1)
      setPan(0)
      setExpanded(false)
      const scope = { kind: view.scope, sessionID: value.session } as const
      handledTargetRequestID = view.target?.requestID ?? ""
      const streams = new AbortController()
      setConnection(streams)
      const transport = rpcStreamsTransport(
        () => value.client.rpc(Streams) as unknown as StreamsRpc,
        streams.signal,
        { location: { directory: value.directory } },
      )
      setModel(
        createTrajectoryModel({
          key,
          transport,
          project: value.project,
          projectID: value.projectID,
          projectDirectory: value.project,
          scope,
          preferences: {
            target: view.target,
            taskID: view.selectedTaskID,
            selection: selectionFrom(view),
          },
          selected: (preferences: PanelPreferences) => {
            save({
              selectedTaskID: preferences.taskID,
              selectedKind: preferences.selection?.kind ?? "",
              selectedRecordID: preferences.selection?.id ?? "",
            })
          },
          visibleRange: viewRange,
        }),
      )
      onCleanup(() => {
        streams.abort()
        setModel(undefined)
      })
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => setModel(undefined),
    },
  )

  createEffect(() => {
    const value = current()
    const target = prefs().target
    if (!value || !target || target.requestID === handledTargetRequestID) return
    handledTargetRequestID = target.requestID
    state.selectTarget(target)
  })

  const currentData = () => model()?.data()
  // A new selection starts at the top of the pane.
  createEffect(
    on(
      () => `${currentData()?.selection?.kind}:${currentData()?.selection?.id}`,
      () => {
        if (inspectorPane) inspectorPane.scrollTop = 0
      },
      { defer: true },
    ),
  )
  const report = () => currentData()?.report
  const selection = () => currentData()?.selection ?? null
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
    return value?.events ?? []
  })
  /** When the last frame arrived: the end of an attempt that is still open. */
  const capturedAt = () => currentData()?.asOf ?? null
  /** Recorded once the task is no longer working; live while it is. */
  const settled = () => !taskView()?.working
  const timeline = createMemo(() => {
    const value = currentData()
    if (!value?.taskID || !value.report) return undefined
    return buildTimeline(
      {
        ...value.recorded,
        firstAttemptAt: value.report.effort.firstAttemptAt,
      },
      capturedAt(),
      trackTimes(loadedEvents()),
      !value.partial && !value.loadingTranscript,
    )
  })
  // The time in view: the stream windows move to it.
  createEffect(() => {
    const line = timeline()
    if (!line || line.origin === null) return setViewRange(undefined)
    const from = line.origin + pan() * line.durationMs
    setViewRange({ from, to: from + line.durationMs / zoom() })
  })
  const attemptStates = createMemo(
    () => new Map((report()?.attempts ?? []).map((attempt) => [attempt.id, attempt.state])),
  )
  const tracks = createMemo(() => {
    const line = timeline()
    if (!line) return undefined
    const value = currentData()
    const pendingAfter = value?.partial ? loadedEventHorizon(value.events) : null
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
  const tickStepFor = (durationMs: number, width: number) => {
    const maximum = Math.max(2, Math.floor((width || 240) / 64))
    const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 21_600]
    return (
      candidates.map((seconds) => seconds * 1_000).find((step) => durationMs / step <= maximum) ??
      durationMs
    )
  }
  const ticks = createMemo(() => {
    const line = timeline()
    if (!line || line.origin === null || line.durationMs <= 0) return []
    const width = axisWidth()
    const step = tickStepFor(line.durationMs, width)
    const inside = line.breaks ?? []
    const values = []
    for (let elapsed = 0; elapsed <= line.durationMs + 0.5; elapsed += step)
      if (!inside.some((span) => elapsed > span.startMs && elapsed < span.endMs))
        values.push({ elapsedMs: elapsed, label: elapsedDurationLabel(elapsed) })
    return values
  })
  const place = (elapsedMs: number) =>
    timeline()?.axis?.place(elapsedMs) ?? (elapsedMs / (timeline()?.durationMs || 1)) * 100
  /** Ruler text: idle-break labels win their place, tick labels yield to them. */
  const ruler = createMemo(() =>
    rulerLabels(ticks(), timeline()?.breaks ?? [], timeline()?.durationMs ?? 0, axisWidth(), place),
  )
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
      .join("\n\n")
  const checkSources = (check: DetailedCheck) =>
    sourceReferences(`${check.stdout ?? ""}\n${check.stderr ?? ""}\n${check.error ?? ""}`)
  const checkLabel = (check: DetailedCheck) => check.command ?? check.id
  const attemptNumber = (id: string | null) =>
    id ? report()?.attempts.find((attempt) => attempt.id === id)?.number : undefined
  const at = (value: number) => `+${elapsedDurationLabel(Math.max(0, value - (origin() ?? value)))}`

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
    if (detailed) {
      revealDetails()
      state.selectCheck(checkKey(detailed))
    }
  }
  const plotPx = () => axisWidth() || 240
  const toolGlyphs = createMemo(() =>
    layoutMarks(
      (tracks()?.tools ?? []).map((tool) => ({
        id: tool.id,
        left: tool.left,
        width: tool.width,
        failed: tool.outcome === "failed",
      })),
      plotPx(),
    ),
  )
  const fileGlyphs = createMemo(() =>
    layoutMarks(
      (tracks()?.files ?? []).map((file) => ({
        id: file.id,
        left: file.left,
        width: 0,
        failed: file.outcome === "failed",
      })),
      plotPx(),
    ),
  )
  const checkGlyphs = createMemo(() =>
    layoutMarks(
      checkLane().map(({ check, id }) => ({
        id,
        left: check.left,
        width: check.pointOnly || checkTiming(check).status === "invalid-order" ? 0 : check.width,
        failed: selectionForTimelineCheck(check)?.result === "failed",
      })),
      plotPx(),
    ),
  )

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
  // A memo, so saving the zoom preference (which re-notifies `selectedAttempt`) cannot reset it.
  const selectedAttemptID = createMemo(() => selectedAttempt()?.id)
  createEffect(
    on(
      selectedAttemptID,
      () => {
        if (zoom() === 1) return
        setZoom(1)
        setPan(0)
        save({ zoom: 1 })
        queueMicrotask(() => {
          if (timelineScroll) timelineScroll.scrollLeft = 0
        })
      },
      { defer: true },
    ),
  )
  /** Before the first measurement (and without layout) assume a typical narrow panel. */
  const trackFit = () => fitPx() || 240
  /** Zoom ceiling: the shortest event or gap becomes comfortably wide; the floor is fit. */
  const zoomCeiling = createMemo(() => {
    const marks = laneMarks()
    const segments = (timeline()?.attempts ?? []).flatMap((lane) =>
      lane.segments.filter((segment) => segment.visible && !segment.pointOnly),
    )
    const shortest = shortestFeature(
      [...marks.map((mark) => mark.width), ...segments.map((segment) => segment.width)],
      marks.map((mark) => mark.left),
    )
    return maxZoom(shortest, trackFit())
  })
  const labelPx = () =>
    timelineScroll
      ?.querySelector<HTMLElement>(".lazers-trajectory-label-cell")
      ?.getBoundingClientRect().width ?? 0
  const measureFit = () => {
    const scroller = timelineScroll
    if (!scroller) return
    const end = endPadding((timeline()?.ticks ?? []).map((tick) => tick.label))
    setFitPx(Math.max(0, scroller.clientWidth - labelPx() - end))
  }
  const currentView = (): Viewport => ({
    zoom: zoom(),
    scrollLeft: timelineScroll?.scrollLeft ?? 0,
  })
  /** Scroll the DOM to the remembered pan; the signal, not the element, is the source of truth. */
  const applyPan = () => {
    const scroller = timelineScroll
    if (!scroller) return
    scroller.scrollLeft = clampScroll(pan() * trackFit() * zoom(), zoom(), trackFit())
  }
  const commitView = (view: Viewport) => {
    const changed = view.zoom !== zoom()
    setPan(view.scrollLeft / (trackFit() * view.zoom))
    if (changed) {
      setZoom(view.zoom)
      save({ zoom: view.zoom })
    }
    queueMicrotask(applyPan)
  }
  /** Zoom to `next`, keeping the time under `anchorPx` (from the track's left edge) in place. */
  const zoomTo = (next: number, anchorPx = trackFit() / 2) =>
    commitView(zoomAbout(currentView(), next, anchorPx, trackFit(), zoomCeiling()))
  const zoomStep = (direction: 1 | -1) => zoomTo(stepZoom(zoom(), direction, zoomCeiling()))
  const fitTimeline = () => zoomTo(1)
  createEffect(on(fitPx, () => queueMicrotask(applyPan), { defer: true }))
  createEffect(() => {
    if (zoom() > zoomCeiling()) zoomTo(zoomCeiling())
  })

  const timelineWheel = (event: WheelEvent) => {
    const scroller = timelineScroll
    if (!scroller) return
    if (event.ctrlKey || event.metaKey) {
      // A trackpad pinch arrives as a wheel event with ctrlKey set.
      event.preventDefault()
      const anchor = event.clientX - scroller.getBoundingClientRect().left - labelPx()
      zoomTo(zoom() * wheelZoomFactor(event.deltaY, event.deltaMode), anchor)
      return
    }
    if (zoom() <= 1) return
    const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
    const delta =
      (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * lines
    const next = panBy(currentView(), delta, trackFit())
    // At either end the gesture is the page's again.
    if (next.scrollLeft === scroller.scrollLeft) return
    event.preventDefault()
    commitView(next)
  }
  let drag: { id: number; x: number; scrollLeft: number; moved: boolean } | null = null
  let swallowClick = false
  const dragStart = (event: PointerEvent) => {
    // Touch already pans natively; only a primary mouse or pen press starts a drag.
    if (event.button !== 0 || event.pointerType === "touch" || zoom() <= 1) return
    drag = {
      id: event.pointerId,
      x: event.clientX,
      scrollLeft: currentView().scrollLeft,
      moved: false,
    }
  }
  const dragMove = (event: PointerEvent) => {
    const scroller = timelineScroll
    if (!drag || !scroller || event.pointerId !== drag.id) return
    const delta = event.clientX - drag.x
    if (!drag.moved) {
      if (Math.abs(delta) < DRAG_SLOP_PX) return
      drag.moved = true
      scroller.setPointerCapture?.(event.pointerId)
      setDragging(true)
    }
    commitView(panBy({ zoom: zoom(), scrollLeft: drag.scrollLeft }, -delta, trackFit()))
  }
  const dragEnd = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return
    if (drag.moved) {
      // The click that ends a drag is not a selection.
      swallowClick = true
      setTimeout(() => (swallowClick = false), 0)
      timelineScroll?.releasePointerCapture?.(event.pointerId)
    }
    drag = null
    setDragging(false)
  }
  const swallowDragClick = (event: Event) => {
    if (!swallowClick) return
    swallowClick = false
    event.stopPropagation()
    event.preventDefault()
  }
  const timelineKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target as HTMLElement | null
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
    const pan = KEY_PAN_SHARE * trackFit()
    if (event.key === "+" || event.key === "=") zoomStep(1)
    else if (event.key === "-" || event.key === "_") zoomStep(-1)
    else if (event.key === "0") fitTimeline()
    else if (zoom() > 1 && event.key === "ArrowLeft")
      commitView(panBy(currentView(), -pan, trackFit()))
    else if (zoom() > 1 && event.key === "ArrowRight")
      commitView(panBy(currentView(), pan, trackFit()))
    else return
    event.preventDefault()
  }
  /**
   * The timeline is one `<dialog>`. Inline it is open non-modally and laid out in the panel;
   * expanded it is promoted to the top layer with `showModal()`, so the same DOM, signals,
   * zoom, pan and selection fill the window. Escape closes the modal and returns it inline.
   */
  createEffect(
    on(
      expanded,
      (open) => {
        const dialog = timelineDialog
        if (!dialog) return
        if (open) {
          // showModal() throws while the dialog is already open non-modally.
          dialog.removeAttribute("open")
          dialog.showModal()
        } else {
          dialog.close()
          dialog.show()
          queueMicrotask(() => expandButton?.focus())
        }
      },
      { defer: true },
    ),
  )

  /** A host icon where the host has a circled state mark, otherwise a Tasks ring glyph. */
  const StateGlyph = (glyph: { glyph: TaskGlyph }) => (
    <Show
      when={isRingGlyph(glyph.glyph)}
      fallback={<Ui.Icon name={glyph.glyph as never} size="small" />}
    >
      <TaskRing glyph={glyph.glyph as never} />
    </Show>
  )
  const OutcomeBadge = (badge: { outcome: Outcome; text?: string; result?: string }) => (
    <Show when={badge.text ?? outcomeText[badge.outcome]}>
      {(text) => (
        <span
          class="lazers-trajectory-outcome"
          data-outcome={badge.outcome}
          data-result={badge.result}
        >
          <Show when={outcomeGlyph[badge.outcome]}>
            {(glyph) => <StateGlyph glyph={glyph()} />}
          </Show>
          <span>{text()}</span>
        </span>
      )}
    </Show>
  )
  const attemptStart = (id: string | null) => {
    const attempt = report()?.attempts.find((item) => item.id === id)
    return attempt ? (attempt.intervals.attempt.startedAt ?? attempt.startedAt) : null
  }
  /** The recorded exit code of a command call; none when the call recorded no code. */
  const toolExit = (tool: ToolMark) => {
    for (const event of toolEvents(tool)) {
      const code = event.exit ?? event.exitCode
      if (typeof code === "number") return code
    }
    return null
  }
  const toolCommand = (tool: ToolMark) => {
    for (const event of toolEvents(tool)) {
      if (typeof event.command === "string" && event.command) return event.command
      const input = event.input
      if (typeof input === "object" && input !== null && !Array.isArray(input)) {
        const command = (input as Record<string, unknown>).command
        if (typeof command === "string" && command) return command
      }
    }
    return ""
  }
  const objective = () => (report()?.task.specification.objective ?? "").trim()
  const title = () => firstLine(objective(), 400)
  const objectiveLonger = () => objective() !== title()
  const headerAttempt = () => selectedAttempt() ?? report()?.attempts.at(-1)
  const headerModel = () => attemptModel(headerAttempt())
  const headerTiming = () => {
    const attempt = headerAttempt()
    if (!attempt) return null
    // Active: elapsed so far. Finished: time the session worked, never the wall span.
    const duration = isActiveAttemptState(attempt.state) ? spanOf(attempt) : attemptActive(attempt)
    return duration ? { text: durationText(duration.ms), open: duration.open } : null
  }
  const taskStatus = () => (report() ? currentTaskState(report()!) : "")
  /** The task reference from Tasks or Radar; never a raw id. */
  const reference = () =>
    report()?.task.reference ??
    currentData()?.tasks.find((task) => task.taskID === currentData()?.taskID)?.reference ??
    currentData()?.taskReference ??
    prefs().selectedReference ??
    prefs().target?.reference ??
    ""
  const status = createPanelStatus(() => ({
    subject: "this trajectory",
    hasContent: Boolean(report()),
    loading: !currentData() || Boolean(currentData()?.loading),
    disconnected: !props.session.server.connected,
    error: currentData()?.error ?? "",
    ...(currentData()?.asOf ? { asOf: currentData()!.asOf! } : {}),
  }))
  const streaming = () => Boolean(currentData()?.partial)
  const eventsLoaded = () => currentData()?.events.length ?? 0
  const eventsTotal = () => Math.max(currentData()?.totalEvents ?? 0, eventsLoaded())
  const lastEnded = () => {
    const ends = (report()?.attempts ?? []).flatMap((attempt) =>
      attempt.intervals.attempt.endedAt === null ? [] : [attempt.intervals.attempt.endedAt],
    )
    return ends.length ? Math.max(...ends) : null
  }
  const gapCount = () => tracks()?.gaps.filter((gap) => gap.kind === "gap").length ?? 0
  /** Counts that disagree or are missing. Shown once, in one disclosure, only when present. */
  const dataGaps = () => {
    const value = tracks()
    const line = report()
    if (!value || !line) return []
    const notes: string[] = []
    const recorded = line.effort.toolCalls.count
    if (!streaming() && recorded !== value.tools.length + value.untimedTools)
      notes.push(
        `${value.tools.length.toLocaleString()} calls placed on the timeline, runner counted ${recorded.toLocaleString()}`,
      )
    if (!streaming() && value.untimedTools)
      notes.push(`${value.untimedTools.toLocaleString()} calls have no time and are not placed`)
    if (value.omittedFileTargets) notes.push(`${value.omittedFileTargets} file calls have no paths`)
    const usage = line.effort.tokenUsage
    if (usage.knownSessions !== usage.totalSessions)
      notes.push(
        `${usage.knownSessions} of ${usage.totalSessions} worker sessions have token counts`,
      )
    const compactions = value.gaps.filter((gap) => gap.kind === "compaction").length
    if (notes.length > 0 && compactions > 0)
      notes.push(compactions === 1 ? "Context compacted" : `Context compacted ${compactions} times`)
    return notes
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

  /** The one state view every panel shows for this task (held is Waiting, not Running). */
  const taskView = createMemo(() => {
    const line = report()
    return line ? reportTaskView(line) : undefined
  })
  const presentation = () => {
    const view = taskView()
    return view
      ? { glyph: view.icon, tone: view.tone, label: view.label }
      : taskStatePresentation(taskStatus())
  }
  const isLatestAttempt = (attempt: { id: string }) => report()?.attempts.at(-1)?.id === attempt.id
  const lastActivityOf = (attempt: { id: string }) => lastWorkerActivity(loadedEvents(), attempt.id)
  /** Time a recorded-running attempt stops at when its task is not working. */
  const heldFor = (attempt: TrajectoryAttempt) =>
    isLatestAttempt(attempt) && taskView() && !taskView()!.working
      ? { lastActivity: lastActivityOf(attempt) }
      : undefined
  const spanOf = (attempt: TrajectoryAttempt) =>
    attemptDuration(attempt, capturedAt(), heldFor(attempt))
  /** The latest attempt wears its task's state; an older attempt keeps its own outcome. */
  const attemptState = (attempt: TrajectoryAttempt) => {
    const view = taskView()
    if (view && isLatestAttempt(attempt))
      return { glyph: view.icon, tone: view.tone, label: view.label }
    return taskStatePresentation(attempt.state)
  }
  const hasTask = () =>
    Boolean(currentData()?.taskID || prefs().target?.taskID || prefs().selectedTaskID)
  /** A person picked something on the timeline: open the details pane (it keeps its size). */
  const revealDetails = () => {
    if (!storedState({ open: prefs().open }).open) save({ open: true })
  }
  const chooseEvent = (id: string) => {
    revealDetails()
    state.selectEvent(id)
  }
  const chooseAttempt = (id: string) => {
    revealDetails()
    state.selectAttempt(id)
  }
  const details = createMemo(() => {
    const view = prefs()
    return storedState({ open: view.open, size: view.size ?? sizeFromLegacySplit(view.split) })
  })
  const recentTasks = () => (currentData()?.tasks ?? []).slice(0, 6)
  const slowView = createMemo(() => {
    const view = status.view()
    return view.kind === "loading" && view.slow ? view : undefined
  })
  const [keepWaiting, setKeepWaiting] = createSignal(false)
  createEffect(() => {
    if (status.view().kind !== "loading") setKeepWaiting(false)
  })
  const selectedSessionID = () => {
    const value = selection()
    if (!value) return undefined
    if (value.kind === "attempt") return selectedAttempt()?.sessionID
    if (value.kind === "check")
      return selectedCheck()?.scope === "attempt" ? selectedAttempt()?.sessionID : undefined
    return selectedTool()?.sessionID ?? selectedEvent()?.sessionID ?? undefined
  }
  /** The lane holding the selection is raised across its whole row. */
  const laneSelected = (lane: "attempt" | "tools" | "files" | "checks") => {
    const value = selection()
    if (!value) return false
    if (lane === "attempt") return value.kind === "attempt"
    if (lane === "checks") return value.kind === "check"
    if (value.kind !== "event") return false
    if (lane === "tools") return Boolean(selectedTool() || selectedGap())
    return Boolean(tracks()?.files.some((file) => eventSelected(file.id)))
  }
  const menuItems = () => {
    const utility = [
      ...(reference()
        ? [{ label: "Copy reference", onSelect: () => void ctx.system.copy(reference()) }]
        : []),
      ...(selectedSessionID()
        ? [
            {
              label: "Open worker session",
              onSelect: () => openAttemptSession(selectedSessionID()!),
            },
          ]
        : []),
    ]
    const tasks = (currentData()?.tasks ?? []).map((task) => ({
      label: [task.reference, task.title ? displayTitle(task.title) : "Task", task.status]
        .filter(Boolean)
        .join(" · "),
      onSelect: () => selectTask(task.taskID),
    }))
    return [
      ...utility,
      ...(utility.length > 0 && tasks.length > 0 ? [{ type: "separator" as const }] : []),
      ...tasks,
    ]
  }

  /** Tick, span and run glyphs for one lane; the transparent hit targets sit over them. */
  const Glyphs = (lane: { glyphs: readonly MarkGlyph[] }) => {
    const percent = (px: number) => `${(px / plotPx()) * 100}%`
    const place = (start: number, end: number) => ({
      left: percent(start),
      width: percent(end - start),
    })
    return (
      <div class="lazers-trajectory-glyphs" aria-hidden="true">
        <For each={lane.glyphs}>
          {(glyph) => (
            <>
              <span
                class="lazers-trajectory-rail lazers-trajectory-glyph"
                data-shape={glyph.shape}
                data-failed={glyph.failed}
                style={place(glyph.startPx, glyph.endPx)}
              />
              <Show when={glyph.shape === "run"}>
                <For each={glyph.members.filter((member) => member.failed && !glyph.failed)}>
                  {(member) => (
                    <span
                      class="lazers-trajectory-rail lazers-trajectory-glyph"
                      data-shape={member.shape}
                      data-failed="true"
                      style={place(member.startPx, member.endPx)}
                    />
                  )}
                </For>
              </Show>
            </>
          )}
        </For>
      </div>
    )
  }
  /** `windowed`: the lane is drawn from the timeline window, so its count may be partial. */
  const LaneLabel = (label: {
    name: string
    count: number
    windowed?: boolean
    total?: number | null
  }) => (
    <span class="lazers-trajectory-label-cell">
      <span class="lazers-trajectory-lane-name">{label.name}</span>
      <span
        class="lazers-trajectory-lane-count"
        title={
          label.windowed && streaming() ? "Loaded in view; pan or zoom to load the rest" : undefined
        }
      >
        {laneCountText(label.count, Boolean(label.windowed && streaming()), label.total)}
      </span>
    </span>
  )
  const contextAttempt = createMemo(() => {
    const line = report()
    if (!line) return undefined
    const tool = selectedTool()
    return (
      selectedAttempt() ??
      (tool?.attemptID ? line.attempts.find((item) => item.id === tool.attemptID) : undefined) ??
      line.attempts.at(-1)
    )
  })
  const contextStart = () => {
    const attempt = contextAttempt()
    return attempt ? (attempt.intervals.attempt.startedAt ?? attempt.startedAt) : origin()
  }
  type PaneKind = "attempt" | "tool" | "check" | "event"
  /** What the pane shows. With nothing selected it shows the latest attempt. */
  const paneKind = createMemo((): PaneKind | undefined => {
    const value = selection()
    if (selectedCheck()) return "check"
    if (selectedTool()) return "tool"
    if (value?.kind === "event" && selectedEvent()) return "event"
    if ((!value || value.kind === "attempt") && selectedAttempt()) return "attempt"
    return undefined
  })
  const hasDetailsHeader = () => paneKind() !== undefined
  const attemptEvents = createMemo(() => {
    const attempt = contextAttempt()
    const line = report()
    return attempt && line ? eventsForAttempt(loadedEvents(), attempt, line.attempts) : []
  })
  const attemptTools = createMemo(() => {
    const attempt = contextAttempt()
    return (tracks()?.tools ?? []).filter(
      (tool) => !attempt || !tool.attemptID || tool.attemptID === attempt.id,
    )
  })

  type Step = { id: string; select: () => void }
  /** The items previous and next walk through, for the kind of item selected. */
  const sequence = createMemo((): Step[] => {
    const kind = paneKind()
    if (kind === "tool")
      return attemptTools().map((tool) => ({
        id: tool.id,
        select: () => state.selectEvent(tool.id),
      }))
    if (kind === "check")
      return [...checksForInspector()]
        .sort(
          (a, b) =>
            (a.startedAt ?? a.endedAt ?? Infinity) - (b.startedAt ?? b.endedAt ?? Infinity) ||
            checkKey(a).localeCompare(checkKey(b)),
        )
        .map((check) => ({
          id: checkKey(check),
          select: () => state.selectCheck(checkKey(check)),
        }))
    if (kind === "event")
      return attemptEvents().map((event) => ({
        id: event.id,
        select: () => state.selectEvent(event.id),
      }))
    return []
  })
  const position = createMemo(() => {
    const id = paneKind() === "tool" ? selectedTool()?.id : selection()?.id
    const index = sequence().findIndex((item) => item.id === id)
    return index < 0 ? undefined : { index, total: sequence().length }
  })
  const step = (delta: number) => {
    const at = position()
    sequence()[(at?.index ?? 0) + delta]?.select()
  }
  const stepWord = () =>
    paneKind() === "check" ? "check" : paneKind() === "event" ? "event" : "call"

  const identifiers = (items: ReadonlyArray<readonly [string, string | null | undefined]>) =>
    items.flatMap(([label, value]) => (value ? [{ label, value }] : []))
  const eventNote = (event: TrajectoryEvent) => {
    const error = event.error
    const message =
      typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message ?? "")
          : ""
    return firstLine(translateRuntimeWords(event.reason ?? event.text ?? message), 240)
  }
  /** Every call of the attempt as a tick, with the selected one marked. */
  const positionLane = (extra?: { id: string; at: number | null; failed: boolean }) => {
    const attempt = contextAttempt()
    const start = contextStart()
    if (!attempt || start === null) return null
    const ticks = attemptTools().map((tool) => ({
      at: Math.max(0, tool.at - start),
      failed: tool.outcome === "failed",
      id: tool.id,
    }))
    if (extra && extra.at !== null)
      ticks.push({ at: Math.max(0, extra.at - start), failed: extra.failed, id: extra.id })
    if (ticks.length === 0) return null
    const span = spanOf(attempt)
    const durationMs = Math.max(span?.ms ?? 0, ...ticks.map((tick) => tick.at))
    return {
      ticks,
      durationMs,
      selectedId: extra?.id ?? selectedTool()?.id,
      start: clock(start),
      end: clock(start + durationMs),
    }
  }

  const callView = createMemo((): CallPaneProps | undefined => {
    const kind = paneKind()
    const attempt = contextAttempt()
    if (!kind || kind === "attempt") return undefined
    const start = contextStart()
    const base = {
      parent: [reference(), attempt ? attemptName(attempt) : ""].filter(Boolean).join(" · "),
      onParent: () => {
        if (attempt) chooseAttempt(attempt.id)
      },
      command: "",
      note: "",
      sources: [] as CallPaneProps["sources"],
      started: null,
      durationMs: null,
      result: null,
      lane: null,
      output: "",
      outputOpen: false,
      files: [] as string[],
      payload: null,
    }
    const tool = selectedTool()
    if (kind === "tool" && tool) {
      const code = toolExit(tool)
      const event = selectedEvent()
      return {
        ...base,
        name: tool.tool,
        command: toolCommand(tool),
        started: tool.start !== null ? startedText(tool.start, start) : null,
        durationMs:
          tool.start !== null && tool.end !== null && tool.end >= tool.start
            ? tool.end - tool.start
            : null,
        result:
          code !== null
            ? { text: `exit ${code}`, tone: code === 0 ? "success" : "critical" }
            : tool.outcome === "succeeded"
              ? { text: "succeeded", tone: "success" }
              : tool.outcome === "failed"
                ? { text: "failed", tone: "critical" }
                : tool.outcome === "running"
                  ? { text: "running", tone: "interactive" }
                  : null,
        lane: positionLane(),
        output: toolOutput(tool),
        outputOpen: tool.outcome === "failed",
        files: tool.files?.paths ?? [],
        payload: event ? eventPayload(event) : null,
        identifiers: identifiers([
          ["Attempt", tool.attemptID],
          ["Session", tool.sessionID],
          ["Call", tool.callID],
          ["Event", tool.id],
          [
            "Timing source",
            [tool.startSource, tool.endSource].filter(Boolean).join(" → ") || undefined,
          ],
        ]),
      }
    }
    const check = selectedCheck()
    if (kind === "check" && check) {
      const timing = checkTiming(check)
      const origin = check.scope === "attempt" ? attemptStart(check.attemptID) : null
      const at = check.startedAt ?? check.endedAt
      return {
        ...base,
        name: check.scope === "plan" ? "Plan check" : "Check",
        command: checkLabel(check),
        sources: checkSources(check).map((reference) => ({
          label: `${reference.path}:${reference.line}${reference.column ? `:${reference.column}` : ""}`,
          open: () => openSource(reference),
        })),
        started: check.startedAt !== null ? startedText(check.startedAt, origin ?? start) : null,
        ended:
          check.startedAt === null && check.endedAt !== null
            ? startedText(check.endedAt, origin ?? start)
            : null,
        durationMs: timing.durationMs,
        result: check.timedOut
          ? { text: "timed out", tone: "critical" }
          : check.exitCode !== null
            ? {
                text: `exit ${check.exitCode}`,
                tone: check.result === "failed" ? "critical" : "success",
              }
            : check.result === "passed"
              ? { text: "passed", tone: "success" }
              : check.result === "failed"
                ? { text: "failed", tone: "critical" }
                : null,
        lane: positionLane({ id: "selected-check", at, failed: check.result === "failed" }),
        output: checkOutput(check),
        outputOpen: check.result === "failed",
        identifiers: identifiers([
          ["Attempt", check.attemptID],
          ["Check", check.id],
          [
            "Timing source",
            `${basisText(check.timingBasis)}${timing.status === "invalid-order" ? ` · ${timing.reason}` : ""}`,
          ],
        ]),
      }
    }
    const event = selectedEvent()
    if (kind === "event" && event) {
      const at = typeof event.at === "number" ? event.at : null
      return {
        ...base,
        name: selectedGap()?.label ?? eventLabel(event),
        note: eventNote(event),
        started: at !== null ? startedText(at, start) : null,
        lane: positionLane({ id: "selected-event", at, failed: eventIsError(event) }),
        payload: eventPayload(event),
        identifiers: identifiers([
          ["Attempt", event.attemptID],
          ["Session", event.sessionID],
          ["Message", event.messageID],
          ["Call", event.callID],
          ["Event", event.id],
        ]),
      }
    }
    return undefined
  })

  const [eventsOpen, setEventsOpen] = createSignal(false)
  const [eventFilter, setEventFilter] = createSignal<EventFilter>("all")
  const attemptView = createMemo(() => {
    const attempt = selectedAttempt()
    const line = report()
    if (paneKind() !== "attempt" || !attempt || !line) return undefined
    const events = attemptEvents()
    const marks = attemptTools()
    // Tasks and Radar count only files a call edited or patched; reads stay in the Files lane.
    const files = new Set(
      (tracks()?.files ?? [])
        .filter((file) => !file.attemptID || file.attemptID === attempt.id)
        .filter((file) => file.operation !== "read")
        .flatMap((file) => file.paths),
    ).size
    const start = attempt.intervals.attempt.startedAt ?? attempt.startedAt
    const presentation = attemptState(attempt)
    const ended = endReason({ state: attempt.state, events })
    const view = taskView()
    const explained =
      view && isLatestAttempt(attempt) && view.explained
        ? taskReason(view, line, ended?.raw ?? ended?.text)
        : undefined
    return {
      attempt,
      line,
      events,
      files,
      duration: spanOf(attempt),
      summary: attemptSummary({
        events,
        state: attempt.state,
        calls: attempt.toolCount.value,
        files,
        gaps: recordGapCount(events, dataGaps()),
        failedCalls: marks.filter((mark) => mark.outcome === "failed").map((mark) => mark.tool),
        attemptStart: start,
        attemptEnd: attempt.intervals.attempt.endedAt,
      }),
      reason: explained ? { text: explained, tone: presentation.tone } : ended,
      icon: <StateGlyph glyph={presentation.glyph} />,
      identifiers: identifiers([
        ["Session", attempt.sessionID],
        ["Attempt", attempt.id],
        ["Plan", attempt.planID],
        ...priceIdentifiers(line).map(({ label, value }) => [label, value] as const),
        ["Timing source", basisText(attempt.intervals.attempt.basis)],
      ]),
    }
  })

  const OutcomeForCheck = (props: { check: DetailedCheck }) => (
    <OutcomeBadge
      outcome={checkOutcome(props.check.result, props.check.state)}
      text={checkWord(props.check)}
      result={props.check.result}
    />
  )
  /** One line: outcome and name of the selected item. Also the collapsed pane. */
  const detailsHeader = () => (
    <Switch>
      <Match when={paneKind() === "check" && selectedCheck()}>
        {(check) => (
          <>
            <OutcomeForCheck check={check()} />
            <span class="lazers-trajectory-kind">
              {check().scope === "plan" ? "Plan check" : "Check"}
            </span>
          </>
        )}
      </Match>
      <Match when={paneKind() === "attempt" && selectedAttempt()}>
        {(attempt) => {
          const presentation = () => attemptState(attempt())
          return (
            <>
              <Show when={attempt().state !== "unknown"}>
                <span class="lazers-trajectory-state" data-tone={presentation().tone}>
                  <StateGlyph glyph={presentation().glyph} />
                  <span>{presentation().label}</span>
                </span>
              </Show>
              <Show when={attemptSignals(attempt()).concern}>
                {(concern) => (
                  <Label tone="warning" title={`Concern: ${concern().line}`}>
                    Concern
                  </Label>
                )}
              </Show>
              <Show when={attemptSignals(attempt()).takeover}>
                <Label tone="interactive" title="The Architect is finishing this task itself">
                  Takeover
                </Label>
              </Show>
              <span class="lazers-trajectory-kind">
                {attempt().takeover ? "Architect" : "Attempt"} {attempt().number} of{" "}
                {report()?.attempts.length ?? attempt().number}
              </span>
              <Show when={reference()}>
                <span class="lazers-trajectory-kind lazers-kit-mono">{reference()}</span>
              </Show>
            </>
          )
        }}
      </Match>
      <Match when={paneKind() === "tool" && selectedTool()}>
        {(tool) => (
          <>
            <OutcomeBadge outcome={tool().outcome} text={outcomeText[tool().outcome]} />
            <span class="lazers-trajectory-kind lazers-kit-mono">{tool().tool}</span>
          </>
        )}
      </Match>
      <Match when={paneKind() === "event" && selectedEvent()}>
        {(event) => (
          <span class="lazers-trajectory-kind">{selectedGap()?.label ?? eventLabel(event())}</span>
        )}
      </Match>
    </Switch>
  )
  const detailsActions = () => (
    <Switch>
      <Match when={paneKind() === "attempt"}>
        <Show when={props.openers && currentData()?.taskID && current()}>
          <Ui.Button
            variant="ghost"
            size="small"
            onClick={() =>
              props.openers!.openTask(props.session, {
                projectDirectory: current()!.project,
                taskID: currentData()!.taskID!,
              })
            }
          >
            Open task
          </Ui.Button>
        </Show>
      </Match>
      <Match when={position()}>
        {(at) => (
          <>
            <span class="lazers-trajectory-position lazers-kit-mono">
              {at().index + 1} / {at().total}
            </span>
            <button
              type="button"
              class="lazers-trajectory-step"
              aria-label={`Previous ${stepWord()}`}
              disabled={at().index === 0}
              onClick={() => step(-1)}
            >
              <PanelIcon name="chevron-left" size={14} />
            </button>
            <button
              type="button"
              class="lazers-trajectory-step"
              aria-label={`Next ${stepWord()}`}
              disabled={at().index >= at().total - 1}
              onClick={() => step(1)}
            >
              <PanelIcon name="chevron-right" size={14} />
            </button>
          </>
        )}
      </Match>
    </Switch>
  )
  const ScopeMenu = () => (
    <span class="lazers-trajectory-scope">
      <Ui.Menu
        label={prefs().scope === "session" ? "Session" : "Project"}
        trigger="button"
        icon="chevron-down"
        items={[
          { label: "This session", onSelect: () => selectScope("session") },
          { label: "Project tasks", onSelect: () => selectScope("project") },
        ]}
      />
    </span>
  )

  return (
    <div class="lazers-trajectory" style={{ "--trajectory-zoom": String(zoom()) }}>
      <DetailsPane
        ui={Ui}
        class="lazers-trajectory-pane"
        bodyClass="lazers-trajectory-inspector"
        label="Resize trajectory details"
        open={details().open}
        size={details().size}
        onOpen={(open) => save({ open })}
        onSize={(size) => save({ size })}
        empty="No call selected"
        header={hasDetailsHeader() ? detailsHeader() : undefined}
        actions={hasDetailsHeader() ? detailsActions() : undefined}
        bodyRef={(element) => {
          inspectorPane = element
        }}
        dimmed={status.dimmed()}
        top={
          <div class="lazers-trajectory-top" id="lazers-trajectory-top">
            <header class="lazers-trajectory-header">
              <Show
                when={report() || hasTask()}
                fallback={
                  <div class="lazers-trajectory-line1" data-line="title">
                    <h2 class="lazers-trajectory-panel-title">Trajectory</h2>
                    <span class="lazers-trajectory-spacer" />
                    <ScopeMenu />
                  </div>
                }
              >
                <div class="lazers-trajectory-line1">
                  <Show when={reference() || report()}>
                    <span
                      class="lazers-trajectory-task-menu"
                      style={{
                        "font-family": reference() ? ctx.appearance.font("mono") : undefined,
                      }}
                    >
                      <Ui.Menu
                        label={reference() || "Change task"}
                        trigger="button"
                        placement="bottom-start"
                        disabled={menuItems().length === 0}
                        items={menuItems()}
                      />
                    </span>
                  </Show>
                  <Show when={report()}>
                    <span class="lazers-trajectory-state" data-tone={presentation().tone}>
                      <StateGlyph glyph={presentation().glyph} />
                      <span>{presentation().label}</span>
                    </span>
                  </Show>
                  <span class="lazers-trajectory-spacer" />
                  <Show when={props.openers && currentData()?.taskID && current()}>
                    <Ui.Button
                      variant="ghost"
                      size="small"
                      class="lazers-trajectory-open-task"
                      onClick={() =>
                        props.openers!.openTask(props.session, {
                          projectDirectory: current()!.project,
                          taskID: currentData()!.taskID!,
                        })
                      }
                    >
                      Open task
                    </Ui.Button>
                  </Show>
                  <Show when={report()}>
                    <ScopeMenu />
                  </Show>
                </div>
                <Show when={report()}>
                  <h2
                    class="lazers-trajectory-heading"
                    title={objectiveLonger() ? objective() : undefined}
                  >
                    {title()}
                  </h2>
                  <div class="lazers-trajectory-line3">
                    <Show when={(report()?.attempts.length ?? 0) > 0}>
                      <span class="lazers-trajectory-attempt-menu">
                        <Ui.Menu
                          label={`${headerAttempt()?.takeover ? "Architect" : "Attempt"} ${headerAttempt()?.number ?? 1} of ${report()?.attempts.length ?? 1}`}
                          trigger="button"
                          icon="chevron-down"
                          placement="bottom-start"
                          items={(report()?.attempts ?? []).map((attempt) => ({
                            label: `${attemptName(attempt)} · ${attempt.state}`,
                            onSelect: () => state.selectAttempt(attempt.id),
                          }))}
                        />
                      </span>
                    </Show>
                    <Show when={headerModel()}>
                      {(model) => <b class="lazers-trajectory-model-name">{modelLabel(model())}</b>}
                    </Show>
                    <Show when={headerTiming()}>
                      {(timing) => (
                        <span>
                          <b>{timing().text}</b> {timing().open ? "so far" : "active"}
                        </span>
                      )}
                    </Show>
                    <Show when={headerAttempt() && !headerAttempt()?.takeover}>
                      {(_) => (
                        <span>
                          <b>{headerAttempt()!.toolCount.value.toLocaleString()}</b>{" "}
                          {headerAttempt()!.toolCount.value === 1 ? "call" : "calls"}
                        </span>
                      )}
                    </Show>
                    <Show when={checksForInspector().length > 0}>
                      <span>
                        <b>{checksForInspector().length}</b>{" "}
                        {checksForInspector().length === 1 ? "check" : "checks"}
                      </span>
                    </Show>
                  </div>
                </Show>
                <Show when={!report() && slowView() && !keepWaiting()}>
                  <div class="lazers-trajectory-skeleton" aria-hidden="true">
                    <i style={{ width: "86%" }} />
                    <i style={{ width: "52%" }} />
                  </div>
                </Show>
              </Show>
            </header>

            <Show
              when={slowView() && !keepWaiting() && !report()}
              fallback={<PanelStatus ui={Ui} status={status} onRetry={retry} skeleton="timeline" />}
            >
              <div class="lazers-trajectory-empty" role="status" aria-busy="true">
                <b>Still loading this trajectory</b>
                <span>
                  The service has not answered for {slowSeconds(slowView()!.line) ?? 10} s.
                </span>
                <div class="lazers-trajectory-actions">
                  <button type="button" class="lazers-trajectory-button" onClick={retry}>
                    Retry
                  </button>
                  <button
                    type="button"
                    class="lazers-trajectory-button"
                    data-variant="ghost"
                    onClick={() => setKeepWaiting(true)}
                  >
                    Keep waiting
                  </button>
                </div>
              </div>
            </Show>

            <Show when={status.view().kind === "ready" && !report()}>
              <div class="lazers-trajectory-empty" data-state="empty">
                <Show
                  when={(currentData()?.tasks.length ?? 0) > 0}
                  fallback={
                    <>
                      <b>
                        {prefs().scope === "session"
                          ? "No LAZERS tasks belong to this session."
                          : "No LAZERS tasks belong to this project."}
                      </b>
                      <Show when={prefs().scope === "session"}>
                        <div class="lazers-trajectory-actions">
                          <button
                            type="button"
                            class="lazers-trajectory-button"
                            onClick={() => selectScope("project")}
                          >
                            Show project tasks
                          </button>
                        </div>
                      </Show>
                    </>
                  }
                >
                  <Show
                    when={!currentData()?.taskID}
                    fallback={<b>No trajectory has been recorded for this task yet.</b>}
                  >
                    <b>Pick a task</b>
                    <span>
                      Trajectory shows what a worker did on one task: calls, files and checks over
                      time.
                    </span>
                    <div class="lazers-trajectory-actions">
                      <span class="lazers-trajectory-choose">
                        <Ui.Menu
                          label="Choose task"
                          trigger="button"
                          icon="chevron-down"
                          items={menuItems()}
                        />
                      </span>
                    </div>
                  </Show>
                </Show>
              </div>
              <Show when={!currentData()?.taskID && recentTasks().length > 0}>
                <ul class="lazers-trajectory-recent" aria-label="Recent tasks">
                  <For each={recentTasks()}>
                    {(task) => {
                      const glyph = () => taskStatePresentation(task.status)
                      return (
                        <li>
                          <button
                            type="button"
                            class="lazers-trajectory-recent-row"
                            onClick={() => selectTask(task.taskID)}
                          >
                            <span
                              class="lazers-trajectory-recent-ref"
                              style={{ "font-family": ctx.appearance.font("mono") }}
                            >
                              {task.reference ?? ""}
                            </span>
                            <span class="lazers-trajectory-recent-title">
                              {task.title ? displayTitle(task.title) : "Task"}
                            </span>
                            <span
                              class="lazers-trajectory-state"
                              data-tone={glyph().tone}
                              title={glyph().label}
                            >
                              <StateGlyph glyph={glyph().glyph} />
                            </span>
                          </button>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </Show>
            </Show>

            <Show when={status.showContent() && report()}>
              <dialog
                class="lazers-trajectory-timeline"
                open
                role={expanded() ? "dialog" : "region"}
                aria-label="Timeline"
                data-expanded={expanded()}
                data-panel-dimmed={status.dimmed()}
                ref={(element) => {
                  timelineDialog = element
                }}
                onKeyDown={timelineKeyDown}
                onClose={() => {
                  // Escape (or the platform) closed the modal: sync the signal, which re-opens it inline.
                  if (expanded()) setExpanded(false)
                }}
              >
                <div class="lazers-trajectory-timeline-bar">
                  <span
                    class="lazers-trajectory-axis-caption"
                    title={
                      origin() === null
                        ? undefined
                        : new Date(origin()!).toLocaleString(undefined, { timeZoneName: "short" })
                    }
                  >
                    <Show when={settled()} fallback="Live · following">
                      <Show when={origin() !== null}>Started {clock(origin()!)}</Show>
                    </Show>
                  </span>
                  <span class="lazers-trajectory-zoom" role="group" aria-label="Timeline zoom">
                    <button
                      type="button"
                      class="lazers-trajectory-icon-button"
                      aria-label="Zoom out"
                      title="Zoom out (-)"
                      disabled={zoom() <= 1}
                      onClick={() => zoomStep(-1)}
                    >
                      <PanelIcon name="zoom-out" />
                    </button>
                    <button
                      type="button"
                      class="lazers-trajectory-icon-button"
                      aria-label="Zoom in"
                      title="Zoom in (+)"
                      disabled={zoom() >= zoomCeiling()}
                      onClick={() => zoomStep(1)}
                    >
                      <PanelIcon name="zoom-in" />
                    </button>
                    <button
                      type="button"
                      class="lazers-trajectory-icon-button"
                      aria-label={
                        zoom() === 1 ? "Timeline fits the panel" : "Fit timeline to panel"
                      }
                      title="Fit to panel (0)"
                      disabled={zoom() === 1}
                      onClick={fitTimeline}
                    >
                      <PanelIcon name="fit" />
                    </button>
                    <Show when={expanded() && selection()}>
                      {/* The inspector sits outside the modal and is inert while it is open. */}
                      <button
                        type="button"
                        class="lazers-trajectory-close"
                        aria-label="Inspect selection and close"
                        title="Close the expanded timeline and focus the details"
                        onClick={() => {
                          setExpanded(false)
                          setTimeout(() => {
                            if (!inspectorPane) return
                            inspectorPane.tabIndex = -1
                            inspectorPane.focus()
                          })
                        }}
                      >
                        Inspect
                      </button>
                    </Show>
                    <Show
                      when={expanded()}
                      fallback={
                        <button
                          type="button"
                          class="lazers-trajectory-icon-button"
                          aria-label="Expand timeline to window"
                          title="Expand to window"
                          ref={(element) => {
                            expandButton = element
                          }}
                          onClick={() => setExpanded(true)}
                        >
                          <PanelIcon name="expand" />
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="lazers-trajectory-close"
                        aria-label="Close expanded timeline"
                        title="Close (Esc)"
                        onClick={() => setExpanded(false)}
                      >
                        <PanelIcon name="close" />
                        Close
                      </button>
                    </Show>
                  </span>
                </div>
                <Show
                  when={timeline()?.origin !== null && timeline()?.origin !== undefined}
                  fallback={
                    <div class="lazers-trajectory-note">No attempts have been recorded.</div>
                  }
                >
                  <div
                    class="lazers-trajectory-scroll"
                    data-zoomed={zoom() > 1}
                    data-dragging={dragging()}
                    data-zoom-max={zoomCeiling()}
                    tabIndex={0}
                    role="group"
                    aria-label="Timeline plot. Plus and minus zoom, zero fits, arrow keys pan."
                    onScroll={(event) => {
                      setPan(event.currentTarget.scrollLeft / (trackFit() * zoom()))
                    }}
                    onPointerDown={dragStart}
                    onPointerMove={dragMove}
                    onPointerUp={dragEnd}
                    onPointerCancel={dragEnd}
                    ref={(element) => {
                      timelineScroll = element
                      element.addEventListener("wheel", timelineWheel, { passive: false })
                      element.addEventListener("click", swallowDragClick, { capture: true })
                      scrollObserver?.disconnect()
                      scrollObserver = new ResizeObserver(measureFit)
                      scrollObserver.observe(element)
                      queueMicrotask(() => {
                        measureFit()
                        applyPan()
                      })
                    }}
                  >
                    <div
                      class="lazers-trajectory-plot"
                      style={{
                        "--trajectory-end": `${endPadding((timeline()?.ticks ?? []).map((tick) => tick.label))}px`,
                      }}
                    >
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
                          <For each={ruler().ticks}>
                            {(tick) => (
                              <span
                                class="lazers-trajectory-tick"
                                data-edge={
                                  place(tick.elapsedMs) < 4
                                    ? "start"
                                    : place(tick.elapsedMs) > 96
                                      ? "end"
                                      : undefined
                                }
                                style={{ left: `${place(tick.elapsedMs)}%` }}
                              >
                                {tick.label}
                              </span>
                            )}
                          </For>
                          <For each={ruler().breaks}>
                            {(span) => (
                              <span
                                class="lazers-trajectory-idle-label"
                                style={{ left: `${span.left + span.width / 2}%` }}
                              >
                                {span.label}
                              </span>
                            )}
                          </For>
                        </div>
                      </div>
                      <div class="lazers-trajectory-gridlines" aria-hidden="true">
                        <For each={ticks()}>
                          {(tick) => <span style={{ left: `${place(tick.elapsedMs)}%` }} />}
                        </For>
                        <For each={timeline()?.breaks ?? []}>
                          {(span) => (
                            <span
                              class="lazers-trajectory-idle"
                              title={span.label}
                              style={{ left: `${span.left}%`, width: `${span.width}%` }}
                            />
                          )}
                        </For>
                        <For each={(tracks()?.gaps ?? []).filter((gap) => gap.kind === "gap")}>
                          {(gap) => (
                            <span
                              class="lazers-trajectory-gap-band"
                              title={gap.label}
                              style={{ left: `${gap.left}%` }}
                            />
                          )}
                        </For>
                        <Show
                          when={
                            tracks()?.loadedThrough !== null &&
                            tracks()?.loadedThrough !== undefined
                          }
                        >
                          <span
                            class="lazers-trajectory-unloaded"
                            style={{ left: `${tracks()!.loadedThrough}%` }}
                            title="Activity after this point is not loaded; pan or zoom to load it"
                          />
                        </Show>
                      </div>

                      <div
                        class="lazers-trajectory-attempts"
                        role="listbox"
                        aria-label="Attempts"
                        aria-orientation="vertical"
                        onKeyDown={laneKeyDown(
                          () =>
                            (timeline()?.attempts ?? []).map((lane) => ({ id: lane.attempt.id })),
                          activeAttempt,
                          (mark) => chooseAttempt(mark.id),
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
                              return value ? spanOf(value) : null
                            }
                            return (
                              <div
                                class="lazers-trajectory-attempt"
                                role="option"
                                data-mark-id={lane().attempt.id}
                                data-selected={
                                  selection()?.kind === "attempt" &&
                                  selection()?.id === lane().attempt.id
                                }
                                aria-selected={selected()}
                                tabIndex={activeAttempt() === lane().attempt.id ? 0 : -1}
                                aria-label={`${attemptName({ number: lane().attempt.number, takeover: detail()?.takeover })}, ${lane().attempt.state}${duration() ? `, ${durationText(duration()!.ms)}${duration()!.open ? " so far" : ""}` : ""}, ${detail() && !detail()!.takeover ? `${detail()!.toolCount.value.toLocaleString()} calls` : ""}`}
                                title={basisText(lane().attempt.timingBasis)}
                                onClick={() => chooseAttempt(lane().attempt.id)}
                              >
                                <span class="lazers-trajectory-label-cell lazers-trajectory-attempt-label">
                                  <span class="lazers-trajectory-lane-name">
                                    {detail()?.takeover ? "Architect" : "Attempt"}
                                  </span>
                                  <span class="lazers-trajectory-lane-count">
                                    {lane().attempt.number}
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
                                        hidden={!segment.visible}
                                        title={
                                          segment.open
                                            ? `${basisText(segment.basis)} · still running`
                                            : basisText(segment.basis)
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

                      <div
                        class="lazers-trajectory-lane"
                        data-track="tools"
                        data-selected={laneSelected("tools")}
                      >
                        <LaneLabel
                          name="Tools"
                          windowed
                          count={tracks()?.tools.length ?? 0}
                          total={report()?.attempts.reduce(
                            (sum, attempt) => sum + attempt.toolCount.value,
                            0,
                          )}
                        />
                        <div
                          class="lazers-trajectory-track lazers-trajectory-mark-track"
                          role="listbox"
                          aria-label={`Tool calls, ${tracks()?.tools.length ?? 0} placed${tracks()?.gaps.length ? `, ${tracks()!.gaps.length} gaps` : ""}`}
                          aria-orientation="horizontal"
                          onKeyDown={laneKeyDown(laneMarks, activeTool, (mark) =>
                            chooseEvent(mark.id),
                          )}
                          onClick={laneClick(laneMarks, (mark) => chooseEvent(mark.id))}
                        >
                          <Glyphs glyphs={toolGlyphs()} />
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
                                  data-gap={
                                    item().kind === "gap" && (item().mark as GapMark).kind === "gap"
                                      ? ""
                                      : undefined
                                  }
                                  data-span={isSpanWidth(item().width, plotPx())}
                                  aria-selected={selected()}
                                  tabIndex={activeTool() === item().id ? 0 : -1}
                                  aria-label={
                                    item().kind === "tool"
                                      ? [
                                          (item().mark as ToolMark).tool,
                                          outcomeText[(item().mark as ToolMark).outcome],
                                          at(item().at),
                                          attemptNumber(item().mark.attemptID)
                                            ? `attempt ${attemptNumber(item().mark.attemptID)}`
                                            : "",
                                        ]
                                          .filter(Boolean)
                                          .join(", ")
                                      : `${(item().mark as GapMark).label}, ${at(item().at)}`
                                  }
                                  title={
                                    item().kind === "tool"
                                      ? [
                                          (item().mark as ToolMark).tool,
                                          outcomeText[(item().mark as ToolMark).outcome],
                                          at(item().at),
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")
                                      : `${(item().mark as GapMark).label} · ${at(item().at)}`
                                  }
                                  style={{
                                    left: `${item().left}%`,
                                    width: isSpanWidth(item().width, plotPx())
                                      ? `${item().width}%`
                                      : undefined,
                                  }}
                                  onClick={() => chooseEvent(item().id)}
                                />
                              )
                            }}
                          </Index>
                        </div>
                      </div>

                      <div
                        class="lazers-trajectory-lane"
                        data-track="files"
                        data-selected={laneSelected("files")}
                      >
                        <LaneLabel name="Files" windowed count={tracks()?.files.length ?? 0} />
                        <div
                          class="lazers-trajectory-track lazers-trajectory-mark-track"
                          role="listbox"
                          aria-label={`Recorded file activity, ${tracks()?.files.length ?? 0} targets`}
                          aria-orientation="horizontal"
                          onKeyDown={laneKeyDown(
                            () => tracks()?.files ?? [],
                            activeFile,
                            (mark: FileMark) => chooseEvent(mark.id),
                          )}
                          onClick={laneClick(
                            () => tracks()?.files ?? [],
                            (mark) => chooseEvent(mark.id),
                          )}
                        >
                          <Glyphs glyphs={fileGlyphs()} />
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
                                aria-label={[
                                  `${operationText[mark().operation]} ${mark().paths.join(", ")}${mark().coverage === "partial" ? " (partial)" : ""}`,
                                  outcomeText[mark().outcome],
                                  at(mark().at),
                                ]
                                  .filter(Boolean)
                                  .join(", ")}
                                title={[
                                  operationText[mark().operation],
                                  mark().paths.join(", "),
                                  outcomeText[mark().outcome],
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                                style={{ left: `${mark().left}%` }}
                                onClick={() => chooseEvent(mark().id)}
                              />
                            )}
                          </Index>
                        </div>
                      </div>

                      <div
                        class="lazers-trajectory-lane lazers-trajectory-checks"
                        data-track="checks"
                        data-selected={laneSelected("checks")}
                      >
                        <LaneLabel name="Checks" count={timeline()?.checks.length ?? 0} />
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
                          <Glyphs glyphs={checkGlyphs()} />
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
                                    aria-label={[
                                      name(),
                                      detailed() ? checkWord(detailed()!) : entry().check.state,
                                      timingHint(entry().check),
                                    ]
                                      .filter(Boolean)
                                      .join(", ")}
                                    title={[
                                      name(),
                                      outcomeText[outcome()],
                                      basisText(entry().check.timingBasis),
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")}
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
                    <Show
                      when={streaming()}
                      fallback={
                        <>
                          <span>{eventsTotal().toLocaleString()} events</span>
                          <Show when={gapCount() > 0}>
                            <span>
                              {gapCount()} recording {gapCount() === 1 ? "gap" : "gaps"}
                            </span>
                          </Show>
                          <span class="lazers-trajectory-coverage-end">
                            <Show when={settled()} fallback="Live">
                              Recorded
                              <Show when={lastEnded() !== null}>
                                {" "}
                                · ended {clock(lastEnded()!)}
                              </Show>
                            </Show>
                          </span>
                        </>
                      }
                    >
                      <span>
                        {eventsLoaded().toLocaleString()} of {eventsTotal().toLocaleString()} events
                      </span>
                      <span class="lazers-trajectory-coverage-end">
                        pan or zoom to load the rest
                      </span>
                    </Show>
                  </div>
                </Show>
              </dialog>
            </Show>
          </div>
        }
      >
        <Switch>
          <Match when={attemptView()}>
            {(view) => (
              <AttemptPane
                ui={Ui}
                report={view().line}
                duration={view().duration}
                state={view().attempt.state}
                files={view().files}
                calls={view().attempt.toolCount.value}
                summary={view().summary}
                reason={view().reason}
                reasonIcon={view().icon}
                signals={attemptSignals(view().attempt)}
                events={view().events}
                notes={dataGaps()}
                identifiers={view().identifiers}
                loadingTranscript={Boolean(currentData()?.loadingTranscript)}
                onSelectEvent={chooseEvent}
                eventsRequest={{ open: eventsOpen(), filter: eventFilter() }}
                onEventsOpen={setEventsOpen}
                onFilter={setEventFilter}
                onShowErrors={() => {
                  setEventFilter("errors")
                  setEventsOpen(true)
                }}
              />
            )}
          </Match>
          <Match when={callView()}>{(view) => <CallPane view={view()} />}</Match>
        </Switch>
      </DetailsPane>
    </div>
  )
}

export function setupTrajectoryPanel(ctx: TrajectoryContext, openers?: TrajectoryOpeners) {
  const Ui = ctx.ui
  registerTrajectoryPanel(
    ctx,
    css,
    bindPlugin((props: PanelProps) => <PanelView {...props} ctx={ctx} openers={openers} />),
    () => (
      <div class="flex min-w-0 items-center gap-1.5">
        <Ui.Icon name="branch" size="small" class="shrink-0" />
        <span class="truncate">Trajectory</span>
      </div>
    ),
  )
}
