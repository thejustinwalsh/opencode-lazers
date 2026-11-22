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
import { safeText, privacyStats } from "../trajectory/privacy.ts"
import { createStream, type GuiStream, type StreamsTransport } from "../streams/gui.ts"
import type { Columns } from "../streams/frame.ts"
import type { TrajectoryScope } from "../streams/sources/trajectory-ref.ts"
import { taskScheduleRef } from "../streams/sources/tasks-ref.ts"
import {
  trajectoryAttemptsRef,
  trajectoryEffortRef,
  trajectoryEventsRef,
  trajectoryTranscriptRef,
} from "./streams.ts"
import { checkKey, detailedChecks, reportEffortSchema } from "./projection.ts"
import type {
  RecordedAttempt,
  RecordedCheck,
  TaskChoice,
  TrajectoryAttempt,
  TrajectoryEvent,
  TrajectoryReport,
} from "./projection.ts"
import {
  attemptFromRow,
  concernFromSchedule,
  checkFromDetail,
  checkFromRow,
  choiceFromRow,
  emptyEffort,
  holdFromSchedule,
  integratedRow,
  eventFromDetail,
  eventFromRow,
  eventFromTranscript,
  recordedAttempt,
  recordedCheck,
  timelineEventID,
} from "./rows.ts"

export type Selection =
  { kind: "attempt"; id: string } | { kind: "check"; id: string } | { kind: "event"; id: string }

export type PanelPreferences = {
  taskID: string | null
  selection: Selection | null
  target?: TaskTrajectoryTarget | null
}

export type TaskTrajectoryTarget = {
  requestID: string
  taskID: string
  reference: string
  projectID: string
  projectDirectory: string
}

export type PanelData = {
  key: string
  tasks: TaskChoice[]
  taskID: string | null
  taskReference: string | null
  report?: TrajectoryReport
  /** The attempts and checks as the timeline plots them. */
  recorded: { attempts: RecordedAttempt[]; checks: RecordedCheck[] }
  selection: Selection | null
  /** The events of the loaded windows (timeline and the selected attempt's transcript), by time. */
  events: TrajectoryEvent[]
  selectionEventSnapshot?: TrajectoryEvent
  /** Every event of the task, loaded or not (the timeline source's exact count). */
  totalEvents: number
  /** The windows do not hold every event: earlier or later rows are read as the view moves. */
  partial: boolean
  /** The selected attempt's message text has not arrived yet. */
  loadingTranscript: boolean
  loading: boolean
  stale: boolean
  error: string
  /** Epoch ms of the last frame applied. */
  asOf: number | null
}

export function selectedAttemptFor(data: PanelData | undefined) {
  const report = data?.report
  if (!data || !report) return undefined
  const selection = data.selection
  if (!selection) return report.attempts.at(-1)
  const id =
    selection.kind === "attempt"
      ? selection.id
      : selection.kind === "check"
        ? detailedChecks(report).find((check) => checkKey(check) === selection.id)?.attemptID
        : selectedEventFor(data)?.attemptID
  return id ? report.attempts.find((attempt) => attempt.id === id) : undefined
}

export function selectedEventFor(data: PanelData | undefined) {
  const selection = data?.selection
  if (!data || selection?.kind !== "event") return undefined
  return (
    data.events.find((event) => event.id === selection.id) ??
    (data.selectionEventSnapshot?.id === selection.id ? data.selectionEventSnapshot : undefined)
  )
}

/** The timeline window: about 60 rows in view at the default zoom, 30 more each side. */
const VISIBLE_ROWS = 60
const SLOP_ROWS = 30
/** Basis: Panel 2 of `.agents/plans/panel-streams.md`; the plot draws a mark per row. */
const WINDOW_ROWS = VISIBLE_ROWS + 2 * SLOP_ROWS
/** A slide moves the window by its slop on both sides: half of it. */
const SLIDE_ROWS = 2 * SLOP_ROWS
/** Rows of a stored event that carry a detail JSON (`task_events`); steps and calls do not. */
const STORED_REF = /^(tr|ef|pg):/

const rowOf = (row: unknown) => row as Record<string, unknown>

/** A stream that reads every row of its filter: it doubles its window while rows remain. */
function wholeStream<F, C extends Columns>(
  transport: StreamsTransport,
  source: Parameters<typeof createStream<F, C>>[1],
  options: () => { filter: F; order: string },
  initial: number,
): GuiStream<C> {
  const [window, setWindow] = createSignal(initial)
  const stream = createStream(transport, source, () => ({ ...options(), window: window() }))
  createEffect(() => {
    if (stream.loaded() && stream.after() !== 0) setWindow((current) => current * 2)
  })
  return stream
}

/** A value made inside its own reactive root for as long as `key` holds one, then disposed. */
function keyedRoot<K, T>(
  key: Accessor<K | undefined>,
  make: (key: K) => T,
): Accessor<T | undefined> {
  const owner = getOwner()
  const [value, setValue] = createSignal<T>()
  let release: (() => void) | undefined
  createEffect(
    on(key, (next) => {
      release?.()
      release = undefined
      setValue(undefined)
      if (next === undefined) return
      runWithOwner(owner, () =>
        createRoot((dispose) => {
          release = dispose
          setValue(() => make(next))
        }),
      )
    }),
  )
  onCleanup(() => release?.())
  return value
}

const messageOf = (error: Error | undefined) =>
  error ? safeText(error.message, privacyStats(), 400) || "Trajectory could not be read." : ""

export type TrajectoryModelInput = {
  key: string
  transport: StreamsTransport
  /** The canonical project path, the filter of the Tasks sources. */
  project: string
  projectID: string
  projectDirectory: string
  scope: TrajectoryScope
  preferences: PanelPreferences
  selected?: (preferences: PanelPreferences) => void
  /** The time range in view, epoch ms; the windows follow it. Absent until the plot is measured. */
  visibleRange?: Accessor<{ from: number; to: number } | undefined>
}

export type TrajectoryModel = {
  data: Accessor<PanelData>
  selectTask(taskID: string): void
  selectTarget(target: TaskTrajectoryTarget): void
  selectAttempt(id: string): void
  selectCheck(id: string): void
  selectEvent(id: string): void
}

/**
 * The Trajectory panel's data: stream windows over the stored projection and the host, no cursor
 * and no cache beside them. Must be created inside a reactive owner.
 *
 * ```
 * tasks.schedule  (list)     task choices, when no task is pinned     doubles to read all
 * tasks.schedule  (1)        the task header, plan state, concern     window 1
 * trajectory.attempts        every attempt of the task                doubles to read all
 * trajectory.events (check)  every check result of the task           doubles to read all
 * trajectory.events          the timeline: 60 rows + 30 each side     follows the viewport
 * trajectory.effort (1)      the composed effort                      window 1
 * trajectory.transcript      selected attempt's messages: 60 + 30+30  follows the viewport
 * trajectory.events (1)      the selected stored event or check       window 1 on its key
 * ```
 */
export function createTrajectoryModel(input: TrajectoryModelInput): TrajectoryModel {
  const { transport, scope } = input
  const [target, setTarget] = createSignal<TaskTrajectoryTarget | undefined>(
    input.preferences.target ?? undefined,
  )
  const targetError = (value: TaskTrajectoryTarget | undefined) =>
    value &&
    (value.projectID !== input.projectID ||
      value.projectDirectory !== input.projectDirectory ||
      scope.kind !== "project")
      ? `Task ${value.reference} is unavailable in this project or scope.`
      : ""
  const [pinned, setPinned] = createSignal<string | null>(
    input.preferences.target?.taskID ?? input.preferences.taskID,
  )
  const [selection, setSelection] = createSignal<Selection | null>(
    input.preferences.target ? null : input.preferences.selection,
  )
  const [snapshot, setSnapshot] = createSignal<TrajectoryEvent>()
  const failure = createMemo(() => targetError(target()))
  const taskID = createMemo(() => (failure() ? undefined : (pinned() ?? undefined)))

  const choices = wholeStream(
    transport,
    taskScheduleRef,
    () => ({ filter: { project: input.project, scope }, order: "schedule" }),
    50,
  )

  // The windows follow the viewport: a range wholly outside the loaded rows moves them that way.
  const follow = (stream: {
    items: Accessor<readonly unknown[]>
    loaded: Accessor<boolean>
    before: Accessor<number | "more">
    after: Accessor<number | "more">
    slide(delta: number): void
  }) => {
    const visible = input.visibleRange
    if (!visible) return
    createEffect(() => {
      const view = visible()
      const rows = stream.items()
      if (!view || !stream.loaded() || rows.length === 0) return
      const times = rows
        .map((row) => rowOf(row).at)
        .filter((at): at is number => typeof at === "number")
      if (times.length === 0) return
      if (view.to < Math.min(...times) && stream.before() !== 0) stream.slide(-SLIDE_ROWS)
      else if (view.from > Math.max(...times) && stream.after() !== 0) stream.slide(SLIDE_ROWS)
    })
  }

  const base = (id: string) => ({ projectDirectory: input.projectDirectory, scope, taskID: id })
  const bundle = keyedRoot(taskID, (id) => {
    const schedule = createStream(transport, taskScheduleRef, () => ({
      filter: { project: input.project, scope, taskID: id, includeRetired: true },
      order: "schedule",
      window: 1,
    }))
    const attempts = wholeStream(
      transport,
      trajectoryAttemptsRef,
      () => ({ filter: base(id), order: "number" }),
      16,
    )
    const checks = wholeStream(
      transport,
      trajectoryEventsRef,
      () => ({ filter: { ...base(id), kinds: ["check"] }, order: "timeline" }),
      32,
    )
    const timeline = createStream(transport, trajectoryEventsRef, () => ({
      filter: base(id),
      order: "timeline",
      window: WINDOW_ROWS,
      anchor: "tail" as const,
    }))
    const effort = createStream(transport, trajectoryEffortRef, () => ({
      filter: base(id),
      order: "effort",
      window: 1,
    }))
    // The attempt whose messages are read: the selected one, or the one the selection belongs to.
    const sessionOf = createMemo(() => {
      const picked = selection()
      let attemptID: string | undefined
      if (picked?.kind === "attempt") attemptID = picked.id
      else if (picked?.kind === "check")
        attemptID =
          checks
            .items()
            .map((row) => checkFromRow(rowOf(row)))
            .find((check) => checkKey(check) === picked.id)?.attemptID ?? undefined
      else if (picked?.kind === "event") {
        const row = timeline.items().find((item) => timelineEventID(rowOf(item)) === picked.id)
        attemptID = row ? (rowOf(row).attempt_id as string | undefined) : undefined
      }
      const list = attempts.items().map(rowOf)
      const attempt = attemptID ? list.find((item) => item.id === attemptID) : list.at(-1)
      return attempt && !attempt.takeover && attempt.session_id
        ? { attemptID: String(attempt.id), sessionID: String(attempt.session_id) }
        : undefined
    })
    const transcriptSession = createMemo(() => sessionOf()?.sessionID)
    const transcript = keyedRoot(transcriptSession, (sessionID) => {
      const stream = createStream(transport, trajectoryTranscriptRef, () => ({
        filter: { ...base(id), sessionID },
        order: "transcript",
        window: WINDOW_ROWS,
        anchor: "tail" as const,
      }))
      follow(stream)
      return stream
    })
    // The selected stored event or check: one row with its detail JSON, found by its key.
    const detailRef = createMemo(() => {
      const value = selection()
      if (!value || value.kind === "attempt") return undefined
      if (value.kind === "check")
        return checks
          .items()
          .map((row) => checkFromRow(rowOf(row)))
          .find((check) => checkKey(check) === value.id)?.ref
      const row = timeline.items().find((item) => timelineEventID(rowOf(item)) === value.id)
      const ref = row ? String(rowOf(row).ref) : value.id
      return STORED_REF.test(ref) ? ref : undefined
    })
    const detail = keyedRoot(detailRef, (ref) =>
      createStream(transport, trajectoryEventsRef, () => ({
        filter: base(id),
        order: "timeline",
        window: 1,
        anchor: { key: [ref], place: "start" as const },
      })),
    )
    follow(timeline)
    return { schedule, attempts, checks, timeline, effort, transcript, detail, sessionOf }
  })
  type Bundle = NonNullable<ReturnType<typeof bundle>>

  function buildReport(
    attempts: GuiStream<(typeof trajectoryAttemptsRef)["columns"]>,
    checks: GuiStream<(typeof trajectoryEventsRef)["columns"]>,
    schedule: GuiStream<(typeof taskScheduleRef)["columns"]>,
    effort: GuiStream<(typeof trajectoryEffortRef)["columns"]> | undefined,
    detail: GuiStream<(typeof trajectoryEventsRef)["columns"]> | undefined,
  ) {
    const row = schedule.items()[0] ? rowOf(schedule.items()[0]) : undefined
    if (!row) return {}
    const concern = concernFromSchedule(row)
    const attemptRows = attempts.items().map(rowOf)
    const attemptList: TrajectoryAttempt[] = attemptRows.map((item, index) =>
      attemptFromRow(item, index === attemptRows.length - 1 ? concern : undefined),
    )
    const detailed = detail?.items()[0] ? rowOf(detail.items()[0]) : undefined
    const checkList = checks.items().map((item) => {
      const check = checkFromRow(rowOf(item))
      return detailed && detailed.ref === check.ref
        ? { ...check, ...checkFromDetail(detailed.detail) }
        : check
    })
    const planID = String(row.plan_id ?? "")
    const planIDs = new Set<string>([
      ...(planID ? [planID] : []),
      ...attemptList.map((attempt) => attempt.planID),
      ...checkList.map((check) => check.planID).filter(Boolean),
    ])
    const plans = [...planIDs].map((id) => ({
      id,
      ...(id === planID
        ? {
            ...(row.plan_state ? { state: String(row.plan_state) } : {}),
            reason: (row.plan_reason as string | null) ?? null,
            taskReason: (row.node_reason as string | null) ?? null,
          }
        : {}),
      checks: checkList.filter((check) => check.scope === "plan" && check.planID === id),
    }))
    for (const attempt of attemptList)
      attempt.checks = checkList.filter((check) => check.attemptID === attempt.id)
    const parsedEffort = (() => {
      const stored = effort?.items()[0]
      if (!stored) return undefined
      const result = reportEffortSchema.safeParse(rowOf(stored).effort)
      return result.success ? result.data : undefined
    })()
    const report: TrajectoryReport = {
      task: {
        id: String(row.task_id),
        ...(row.reference ? { reference: String(row.reference) } : {}),
        ...(typeof row.revision === "number" && row.revision > 0 ? { revision: row.revision } : {}),
        status: String(row.status ?? ""),
        ...(row.node_state ? { recordedState: String(row.node_state) } : {}),
        ...(integratedRow(row) ? { integrated: true } : {}),
        hold: holdFromSchedule(row),
        specification: { objective: String(row.objective ?? row.title ?? "") },
      },
      plans,
      attempts: attemptList,
      effort:
        parsedEffort ??
        emptyEffort(attemptList.reduce((total, attempt) => total + attempt.toolCount.value, 0)),
    }
    return { report, checkList, attemptList }
  }

  const attemptOf = (items: readonly TrajectoryAttempt[], session: string) =>
    items.find((attempt) => attempt.sessionID === session)

  const data = createMemo((): PanelData => {
    const id = taskID()
    const value: Bundle | undefined = bundle()
    const row = value?.schedule.items()[0]
    const built = value
      ? buildReport(value.attempts, value.checks, value.schedule, value.effort, value.detail())
      : {}
    const report = built.report
    const attemptList = built.attemptList ?? []
    const timelineRows = value?.timeline.items() ?? []
    const transcript = value?.transcript()
    const merged = new Map<string, TrajectoryEvent>()
    const put = (event: TrajectoryEvent) =>
      merged.set(event.id, { ...merged.get(event.id), ...event })
    for (const item of timelineRows) put(eventFromRow(rowOf(item), id ?? ""))
    for (const item of transcript?.items() ?? []) {
      const session = value?.sessionOf()?.sessionID
      put(eventFromTranscript(rowOf(item), session ? attemptOf(attemptList, session) : undefined))
    }
    const selected = selection()
    const detailed = value?.detail()?.items()[0]
    const full = detailed ? eventFromDetail(rowOf(detailed).detail) : undefined
    if (full && selected?.kind === "event") {
      const existing = merged.get(selected.id)
      const key = existing?.id ?? full.id
      merged.set(key, { ...full, ...existing, id: key })
    }
    const ordered = [...merged.values()]
      .map((event, index) => ({ event, index }))
      .sort(
        (a, b) =>
          (a.event.at ?? Number.POSITIVE_INFINITY) - (b.event.at ?? Number.POSITIVE_INFINITY) ||
          a.index - b.index,
      )
      .map(({ event }) => event)
    const count = (side: number | "more") => (typeof side === "number" ? side : 0)
    const errors = [
      choices.error(),
      value?.schedule.error(),
      value?.attempts.error(),
      value?.checks.error(),
      value?.timeline.error(),
      value?.effort.error(),
      transcript?.error(),
      value?.detail()?.error(),
    ].filter((error): error is Error => error !== undefined)
    const error = failure() || messageOf(errors[0])
    const revision = [
      value?.schedule.revision(),
      value?.attempts.revision(),
      value?.timeline.revision(),
      value?.effort.revision(),
      transcript?.revision(),
    ]
    void revision
    const tasks = choices.items().map((item) => choiceFromRow(rowOf(item)))
    const pin = target()
    const withTarget =
      pin && !tasks.some((task) => task.taskID === pin.taskID)
        ? [
            ...tasks,
            {
              taskID: pin.taskID,
              title: pin.reference,
              status: row ? String(rowOf(row).node_state ?? rowOf(row).status ?? "") : "",
            },
          ]
        : tasks
    const snap = snapshot()
    return {
      key: input.key,
      tasks: withTarget,
      taskID: id ?? null,
      taskReference: pin?.reference ?? null,
      ...(report ? { report } : {}),
      recorded: {
        attempts: attemptList.map((attempt) => recordedAttempt(attempt, id ?? "")),
        checks: (built.checkList ?? []).map((check) => recordedCheck(check, id ?? "")),
      },
      selection: selected,
      events: ordered,
      ...(snap && selected?.kind === "event" && snap.id === selected.id
        ? { selectionEventSnapshot: snap }
        : {}),
      totalEvents:
        timelineRows.length +
        count(value?.timeline.before() ?? 0) +
        count(value?.timeline.after() ?? 0),
      partial: value ? value.timeline.before() !== 0 || value.timeline.after() !== 0 : false,
      loadingTranscript: transcript ? !transcript.loaded() : false,
      loading: Boolean(id) && !failure() && !(value?.schedule.loaded() && value.attempts.loaded()),
      stale: Boolean(error) && Boolean(report),
      error,
      asOf: value?.timeline.loaded() ? Date.now() : null,
    }
  })

  // The last resolved selected event survives the window moving off it.
  createEffect(() => {
    const current = data()
    const event = selectedEventFor(current)
    if (event) setSnapshot(event)
  })

  const choose = (next: Selection) => {
    setSelection(next)
    input.selected?.({ taskID: taskID() ?? null, selection: next })
  }
  const begin = (id: string) => {
    setSelection(null)
    setSnapshot(undefined)
    setPinned(id)
    input.selected?.({ taskID: id, selection: null })
  }
  return {
    data,
    selectTask(id) {
      if (id === taskID() || !data().tasks.some((task) => task.taskID === id)) return
      setTarget(undefined)
      begin(id)
    },
    selectTarget(next) {
      setTarget(next)
      begin(next.taskID)
    },
    selectAttempt(id) {
      if (data().report?.attempts.some((attempt) => attempt.id === id))
        choose({ kind: "attempt", id })
    },
    selectCheck(id) {
      const report = data().report
      if (report && detailedChecks(report).some((check) => checkKey(check) === id))
        choose({ kind: "check", id })
    },
    selectEvent(id) {
      const event = data().events.find((item) => item.id === id)
      if (!event) return
      setSnapshot(event)
      choose({ kind: "event", id })
    },
  }
}
