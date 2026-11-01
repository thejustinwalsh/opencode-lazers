import type { ObservationScope } from "../observability/contract.ts"
import {
  checkKey,
  detailedChecks,
  parseProjectedSnapshot,
  parseTrajectoryReport,
  taskChoices,
} from "./projection.ts"
import type {
  ProjectedSnapshot,
  TaskChoice,
  TrajectoryEvent,
  TrajectoryReport,
  TrajectoryTransport,
} from "./projection.ts"

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
  snapshot?: ProjectedSnapshot
  tasks: TaskChoice[]
  taskID: string | null
  taskReference: string | null
  report?: TrajectoryReport
  selection: Selection | null
  events: TrajectoryEvent[]
  liveEvents: TrajectoryEvent[]
  capturedEventIDs: string[]
  selectionEventSnapshot?: TrajectoryEvent
  eventCursor: string | null
  totalEvents: number
  historyCapturedAt: number | null
  historyExpiresAt: number | null
  loading: boolean
  loadingActivity: boolean
  stale: boolean
  error: string
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

const blank = (key = ""): PanelData => ({
  key,
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
  loading: true,
  loadingActivity: false,
  stale: false,
  error: "",
})

export function selectedEventFor(data: PanelData | undefined) {
  const selection = data?.selection
  if (!data || selection?.kind !== "event") return undefined
  return (
    data.events.find((event) => event.id === selection.id) ??
    data.liveEvents.find((event) => event.id === selection.id) ??
    (data.selectionEventSnapshot?.id === selection.id ? data.selectionEventSnapshot : undefined)
  )
}

const delay = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, 1_000)
    signal.addEventListener("abort", done, { once: true })
  })

function defaultSelection(report: TrajectoryReport): Selection | null {
  const check = detailedChecks(report)[0]
  if (check) return { kind: "check", id: checkKey(check) }
  const attempt = report.attempts.at(-1)
  if (attempt) return { kind: "attempt", id: attempt.id }
  const event = report.trajectory.events[0]
  return event ? { kind: "event", id: event.id } : null
}

function responseMatchesScope(
  response: { scope: { kind: string; sessionID?: string } },
  scope: ObservationScope,
) {
  return (
    response.scope.kind === scope.kind &&
    (scope.kind === "project" || response.scope.sessionID === scope.sessionID)
  )
}

export class TrajectoryPanelState {
  data = blank()
  private controller = new AbortController()
  private taskController = new AbortController()
  private generation = 0
  private snapshotRequest = 0
  private taskRequest = 0
  private activityRequest = 0
  private statusRequest = 0
  private historyRequest = 0
  private transport?: TrajectoryTransport
  private scope?: ObservationScope
  private projectID = ""
  private projectDirectory = ""
  private target?: TaskTrajectoryTarget
  private targetError = ""
  private timer?: ReturnType<typeof setInterval>
  private refreshing = false
  private pendingRefresh = false

  constructor(
    private readonly changed: (data: PanelData) => void,
    private readonly selected: (preferences: PanelPreferences) => void = () => {},
  ) {}

  private update(change: Partial<PanelData>) {
    this.data = { ...this.data, ...change }
    this.changed(this.data)
  }

  connect(
    key: string,
    projectID: string,
    projectDirectory: string,
    scope: ObservationScope,
    transport: TrajectoryTransport,
    preferences: PanelPreferences,
  ) {
    this.close()
    this.controller = new AbortController()
    this.taskController = new AbortController()
    this.transport = transport
    this.scope = scope
    this.projectID = projectID
    this.projectDirectory = projectDirectory
    this.target = preferences.target ?? undefined
    this.targetError =
      this.target &&
      (this.target.projectID !== projectID ||
        this.target.projectDirectory !== projectDirectory ||
        scope.kind !== "project")
        ? `Task ${this.target.reference} is unavailable in this project or scope.`
        : ""
    this.data = blank(key)
    this.update({
      taskID: this.target?.taskID ?? preferences.taskID,
      taskReference: this.target?.reference ?? null,
      selection: this.target ? null : preferences.selection,
      ...(this.targetError ? { loading: false, error: this.targetError } : {}),
    })
    const generation = this.generation
    void this.watch(generation, transport, this.controller.signal)
    if (!this.targetError) void this.refresh()
    this.timer = setInterval(() => void this.refresh(), 4_000)
  }

  async refresh() {
    const transport = this.transport
    const scope = this.scope
    if (!transport || !scope || this.controller.signal.aborted || this.targetError) return
    if (this.refreshing) {
      this.pendingRefresh = true
      return
    }
    if (!transport.online()) {
      this.update({ stale: true, loading: false, error: "Trajectory updates are disconnected." })
      return
    }

    this.refreshing = true
    const generation = this.generation
    const request = ++this.snapshotRequest
    const signal = this.controller.signal
    try {
      const response = await transport.snapshot(scope, signal)
      if (generation !== this.generation || request !== this.snapshotRequest || signal.aborted)
        return
      if (response.projectID !== this.projectID)
        throw new Error("Observation belongs to another project")
      const snapshot = parseProjectedSnapshot(response)
      let tasks = taskChoices(snapshot)
      const previousTaskID = this.data.taskID
      const taskID =
        this.target?.taskID ??
        (tasks.some((task) => task.taskID === previousTaskID)
          ? previousTaskID
          : (tasks[0]?.taskID ?? null))
      const taskChanged = taskID !== previousTaskID
      if (taskChanged) this.beginTask(taskID)
      const taskSignal = AbortSignal.any([signal, this.taskController.signal])
      const taskRequest = this.taskRequest
      if (generation !== this.generation || request !== this.snapshotRequest || taskSignal.aborted)
        return

      if (this.target)
        tasks = [
          ...tasks.filter((task) => task.taskID !== this.target?.taskID),
          {
            taskID: this.target.taskID,
            title: this.target.reference,
            status: this.data.report?.task.status ?? "loading",
          },
        ]
      this.update({
        snapshot,
        tasks,
        taskID,
        taskReference: this.target?.reference ?? null,
      })

      if (!taskID) {
        this.update({
          report: undefined,
          selection: null,
          events: [],
          liveEvents: [],
          capturedEventIDs: [],
          eventCursor: null,
          totalEvents: 0,
          historyCapturedAt: null,
          historyExpiresAt: null,
          loading: false,
          loadingActivity: false,
          stale: false,
          error: "",
        })
      } else if (taskChanged || !this.data.report || this.data.historyCapturedAt === null) {
        await this.captureHistory(taskID, taskSignal, !taskChanged)
      } else {
        await this.refreshStatus(taskID, taskSignal, generation, taskRequest)
      }
    } catch (error) {
      if (generation === this.generation && request === this.snapshotRequest && !signal.aborted)
        this.update({
          loading: false,
          stale: true,
          error: this.target
            ? `Trajectory for ${this.target.reference} is unavailable: ${String(error)}`
            : String(error),
        })
    } finally {
      if (generation === this.generation) {
        this.refreshing = false
        if (this.pendingRefresh) {
          this.pendingRefresh = false
          void this.refresh()
        }
      }
    }
  }

  private beginTask(taskID: string | null) {
    this.taskController.abort()
    this.taskController = new AbortController()
    this.taskRequest++
    this.statusRequest++
    this.historyRequest++
    this.activityRequest++
    this.update({
      taskID,
      taskReference: this.target?.reference ?? null,
      report: undefined,
      selection: null,
      selectionEventSnapshot: undefined,
      events: [],
      liveEvents: [],
      capturedEventIDs: [],
      eventCursor: null,
      totalEvents: 0,
      historyCapturedAt: null,
      historyExpiresAt: null,
      loading: taskID !== null,
      loadingActivity: false,
      error: "",
    })
  }

  private async refreshStatus(
    taskID: string,
    signal: AbortSignal,
    generation = this.generation,
    taskRequest = this.taskRequest,
  ) {
    const transport = this.transport
    const scope = this.scope
    if (!transport || !scope || signal.aborted) return
    const request = ++this.statusRequest
    try {
      const response = await transport.status(scope, taskID, signal)
      if (
        generation !== this.generation ||
        taskRequest !== this.taskRequest ||
        request !== this.statusRequest ||
        signal.aborted
      )
        return
      if (response.projectID !== this.projectID)
        throw new Error("Trajectory status belongs to another project")
      if (!responseMatchesScope(response, scope))
        throw new Error("Trajectory status belongs to another scope")
      const statusReport = parseTrajectoryReport(response)
      if (statusReport.task.id !== taskID)
        throw new Error("Trajectory status belongs to another task")
      const captured = this.data.report
      if (!captured || this.data.taskID !== taskID) return
      const report: TrajectoryReport = {
        ...statusReport,
        coverage: {
          ...statusReport.coverage,
          ...captured.coverage,
          workerProgress: statusReport.coverage.workerProgress,
        },
        trajectory: captured.trajectory,
      }
      const liveEvents = statusReport.trajectory.events.filter(
        (event) => event.kind === "commentary" || event.kind.startsWith("worker-"),
      )
      const tasks = this.data.tasks.map((task) =>
        task.taskID === taskID ? { ...task, status: statusReport.task.status } : task,
      )
      this.update({
        report,
        tasks,
        liveEvents,
        loading: false,
        stale: false,
        error: "",
      })
      const selection = this.reconcileSelection(
        this.data.selection,
        report,
        [
          ...this.data.events,
          ...liveEvents,
          ...(this.data.selectionEventSnapshot &&
          this.data.selection?.kind === "event" &&
          this.data.selectionEventSnapshot.id === this.data.selection.id
            ? [this.data.selectionEventSnapshot]
            : []),
        ],
        this.data.capturedEventIDs,
      )
      if (JSON.stringify(selection) !== JSON.stringify(this.data.selection)) {
        this.update({
          selection,
          ...(selection?.kind === "event" ? {} : { selectionEventSnapshot: undefined }),
        })
        this.selected({ taskID, selection })
      }
    } catch (error) {
      if (
        generation === this.generation &&
        taskRequest === this.taskRequest &&
        request === this.statusRequest &&
        !signal.aborted
      )
        this.update({ loading: false, stale: true, error: String(error) })
    }
  }

  private async captureHistory(taskID: string, signal: AbortSignal, preserveSelection: boolean) {
    const transport = this.transport
    const scope = this.scope
    if (!transport || !scope || signal.aborted) return
    const generation = this.generation
    const taskRequest = this.taskRequest
    const request = ++this.historyRequest
    this.activityRequest++
    this.update({ loading: !this.data.report, loadingActivity: false })
    try {
      const response = await transport.history(scope, taskID, signal)
      if (
        generation !== this.generation ||
        taskRequest !== this.taskRequest ||
        request !== this.historyRequest ||
        signal.aborted
      )
        return
      if (response.projectID !== this.projectID)
        throw new Error("Captured history belongs to another project")
      if (!responseMatchesScope(response, scope))
        throw new Error("Captured history belongs to another scope")
      let report = parseTrajectoryReport(response)
      if (report.task.id !== taskID) throw new Error("Captured history belongs to another task")
      const previousSelection = preserveSelection ? this.data.selection : null
      const previousEvent =
        this.data.selection?.kind === "event"
          ? (this.data.events.find((event) => event.id === this.data.selection!.id) ??
            (this.data.selectionEventSnapshot?.id === this.data.selection.id
              ? this.data.selectionEventSnapshot
              : undefined))
          : undefined
      const eventIDs = response.eventIDs ?? report.trajectory.events.map((event) => event.id)
      const previousIDs = preserveSelection ? this.data.events.map((event) => event.id) : []
      const selectedID = previousSelection?.kind === "event" ? previousSelection.id : undefined
      const targetCount = Math.max(
        preserveSelection ? this.data.events.length : 0,
        ...[...previousIDs, ...(selectedID ? [selectedID] : [])].flatMap((id) => {
          const index = eventIDs.indexOf(id)
          return index < 0 ? [] : [index + 1]
        }),
      )
      const events = [...report.trajectory.events]
      let eventCursor = report.trajectory.nextCursor
      while (preserveSelection && events.length < targetCount && eventCursor) {
        const continuation = await transport.history(
          scope,
          taskID,
          signal,
          eventCursor,
          report.trajectory.limit ?? 50,
        )
        if (
          generation !== this.generation ||
          taskRequest !== this.taskRequest ||
          request !== this.historyRequest ||
          signal.aborted
        )
          return
        const continuationReport = parseTrajectoryReport(continuation)
        if (
          continuation.projectID !== this.projectID ||
          !responseMatchesScope(continuation, scope) ||
          continuationReport.task.id !== taskID ||
          continuation.capturedAt !== response.capturedAt ||
          continuation.expiresAt !== response.expiresAt
        )
          throw new Error("Recaptured history continuation belongs to another capture")
        const pageEvents = continuationReport.trajectory.events
        const expectedIDs = eventIDs.slice(events.length, events.length + pageEvents.length)
        if (
          expectedIDs.length !== pageEvents.length ||
          expectedIDs.some((id, index) => id !== pageEvents[index]?.id)
        )
          throw new Error("Recaptured history page order changed; recapture explicitly")
        events.push(...pageEvents)
        eventCursor = continuationReport.trajectory.nextCursor
      }
      if (preserveSelection)
        report = {
          ...report,
          trajectory: {
            ...report.trajectory,
            page: Math.max(1, Math.ceil(events.length / (report.trajectory.limit ?? 50))),
            events,
            nextCursor: eventCursor,
            hasMore: eventCursor !== null,
          },
        }
      const selection = this.reconcileSelection(previousSelection, report, events, eventIDs)
      const selectionEventSnapshot =
        selection?.kind === "event"
          ? (events.find((event) => event.id === selection.id) ??
            (eventIDs.includes(selection.id) ? previousEvent : undefined))
          : undefined
      const tasks = this.data.tasks.map((task) =>
        task.taskID === taskID ? { ...task, status: report.task.status } : task,
      )
      this.update({
        report,
        tasks,
        selection,
        selectionEventSnapshot,
        events,
        liveEvents: [],
        capturedEventIDs: eventIDs,
        eventCursor,
        totalEvents: report.trajectory.totalEvents,
        historyCapturedAt: response.capturedAt,
        historyExpiresAt: response.expiresAt,
        loading: false,
        loadingActivity: false,
        stale: false,
        error: "",
      })
      this.selected({ taskID, selection })
    } catch (error) {
      if (
        generation === this.generation &&
        taskRequest === this.taskRequest &&
        request === this.historyRequest &&
        !signal.aborted
      )
        this.update({
          loading: false,
          loadingActivity: false,
          stale: true,
          error:
            this.target?.taskID === taskID
              ? `Trajectory for ${this.target.reference} is unavailable: ${String(error)}`
              : String(error),
        })
    }
  }

  private reconcileSelection(
    selected: Selection | null,
    report: TrajectoryReport | undefined,
    events: TrajectoryEvent[],
    knownEventIDs: string[] = [],
  ): Selection | null {
    if (!report) return null
    if (selected) {
      if (
        selected.kind === "attempt" &&
        report.attempts.some((attempt) => attempt.id === selected.id)
      )
        return selected
      if (
        selected.kind === "event" &&
        (events.some((event) => event.id === selected.id) || knownEventIDs.includes(selected.id))
      )
        return selected
      if (
        selected.kind === "check" &&
        detailedChecks(report).some((check) => checkKey(check) === selected.id)
      )
        return selected
    }
    return defaultSelection(report)
  }

  selectTask(taskID: string) {
    if (!this.data.tasks.some((task) => task.taskID === taskID) || taskID === this.data.taskID)
      return
    this.snapshotRequest++
    this.target = undefined
    this.targetError = ""
    this.beginTask(taskID)
    this.selected({ taskID, selection: null })
    void this.loadSelectedTask(taskID)
  }

  selectTarget(target: TaskTrajectoryTarget) {
    this.target = target
    this.targetError =
      target.projectID !== this.projectID ||
      target.projectDirectory !== this.projectDirectory ||
      this.scope?.kind !== "project"
        ? `Task ${target.reference} is unavailable in this project or scope.`
        : ""
    this.snapshotRequest++
    this.update({
      tasks: [
        ...this.data.tasks.filter((task) => task.taskID !== target.taskID),
        { taskID: target.taskID, title: target.reference, status: "loading" },
      ],
      stale: Boolean(this.targetError),
      error: this.targetError,
    })
    this.beginTask(target.taskID)
    this.update({
      loading: !this.targetError,
      stale: Boolean(this.targetError),
      error: this.targetError,
    })
    this.selected({ taskID: target.taskID, selection: null })
    if (!this.targetError) void this.loadSelectedTask(target.taskID)
  }

  private async loadSelectedTask(taskID: string) {
    const signal = AbortSignal.any([this.controller.signal, this.taskController.signal])
    await this.captureHistory(taskID, signal, false)
  }

  selectAttempt(id: string) {
    if (!this.data.report?.attempts.some((attempt) => attempt.id === id)) return
    this.setSelection({ kind: "attempt", id })
  }

  selectCheck(id: string) {
    if (
      !this.data.report ||
      !detailedChecks(this.data.report).some((check) => checkKey(check) === id)
    )
      return
    this.setSelection({ kind: "check", id })
  }

  selectEvent(id: string) {
    const event =
      this.data.events.find((item) => item.id === id) ??
      this.data.liveEvents.find((item) => item.id === id) ??
      (this.data.selectionEventSnapshot?.id === id ? this.data.selectionEventSnapshot : undefined)
    if (!event) return
    this.update({ selectionEventSnapshot: event })
    this.setSelection({ kind: "event", id })
  }

  private setSelection(selection: Selection) {
    this.update({
      selection,
      ...(selection.kind === "event" ? {} : { selectionEventSnapshot: undefined }),
    })
    this.selected({ taskID: this.data.taskID, selection })
  }

  async recaptureActivity() {
    const taskID = this.data.taskID
    const transport = this.transport
    if (!taskID || !transport || !this.scope || this.controller.signal.aborted) return
    if (!transport.online()) {
      this.update({ stale: true, error: "Trajectory updates are disconnected." })
      return
    }
    const signal = AbortSignal.any([this.controller.signal, this.taskController.signal])
    await this.captureHistory(taskID, signal, true)
  }

  async loadMoreActivity() {
    const transport = this.transport
    const scope = this.scope
    const taskID = this.data.taskID
    const cursor = this.data.eventCursor
    if (!transport || !scope || !taskID || !cursor || this.data.loadingActivity) return
    const generation = this.generation
    const request = ++this.activityRequest
    const taskRequest = this.taskRequest
    const signal = AbortSignal.any([this.controller.signal, this.taskController.signal])
    const capturedAt = this.data.historyCapturedAt
    const expiresAt = this.data.historyExpiresAt
    const limit = this.data.report?.trajectory.limit ?? 50
    const capturedEventIDs = [...this.data.capturedEventIDs]
    const loadedEventIDs = this.data.events.map((event) => event.id)
    if (
      capturedAt === null ||
      expiresAt === null ||
      loadedEventIDs.length > capturedEventIDs.length ||
      loadedEventIDs.some((id, index) => capturedEventIDs[index] !== id)
    ) {
      this.update({
        stale: true,
        error: "Captured activity pages are inconsistent; recapture explicitly.",
      })
      return
    }
    this.update({ loadingActivity: true })
    try {
      const response = await transport.history(scope, taskID, signal, cursor, limit)
      if (
        generation !== this.generation ||
        taskRequest !== this.taskRequest ||
        request !== this.activityRequest ||
        signal.aborted
      )
        return
      const report = parseTrajectoryReport(response)
      if (
        response.projectID !== this.projectID ||
        !responseMatchesScope(response, scope) ||
        report.task.id !== taskID ||
        response.capturedAt !== capturedAt ||
        response.expiresAt !== expiresAt
      )
        throw new Error("Activity page belongs to another project or task")
      const pageEvents = report.trajectory.events
      const pageIDs = pageEvents.map((event) => event.id)
      const offset = this.data.events.length
      const expectedIDs = capturedEventIDs.slice(offset, offset + pageIDs.length)
      const nextOffset = offset + pageIDs.length
      const hasExpectedNextPage = nextOffset < capturedEventIDs.length
      if (
        report.trajectory.limit !== limit ||
        report.trajectory.totalEvents !== capturedEventIDs.length ||
        pageIDs.length === 0 ||
        expectedIDs.length !== pageIDs.length ||
        expectedIDs.some((id, index) => id !== pageIDs[index]) ||
        (report.trajectory.page !== undefined &&
          report.trajectory.page !== Math.floor(offset / limit) + 1) ||
        Boolean(report.trajectory.nextCursor) !== hasExpectedNextPage ||
        report.trajectory.nextCursor === cursor
      )
        throw new Error(
          "Activity page order changed or cursor did not advance; recapture explicitly",
        )
      if (
        response.eventIDs &&
        (response.eventIDs.length !== capturedEventIDs.length ||
          response.eventIDs.some((id, index) => id !== capturedEventIDs[index]))
      )
        throw new Error("Activity page belongs to another captured event sequence")
      const events = [...this.data.events, ...pageEvents]
      this.update({
        events,
        eventCursor: report.trajectory.nextCursor,
        totalEvents: report.trajectory.totalEvents,
        loadingActivity: false,
      })
    } catch (error) {
      if (
        generation === this.generation &&
        taskRequest === this.taskRequest &&
        request === this.activityRequest &&
        !signal.aborted
      )
        this.update({ loadingActivity: false, stale: true, error: String(error) })
    }
  }

  private async watch(generation: number, transport: TrajectoryTransport, signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        for await (const event of transport.changes(signal)) {
          if (generation !== this.generation || signal.aborted) return
          if (event.projectID !== this.projectID) continue
          if (
            event.resnapshotRequired ||
            event.sequence > (this.data.snapshot?.boundary.eventSequence ?? 0)
          )
            void this.refresh()
        }
        if (!signal.aborted) throw new Error("Observation update stream closed")
      } catch {
        if (generation !== this.generation || signal.aborted) return
        this.update({ stale: true })
        await delay(signal)
        if (signal.aborted) return
        if (transport.online()) void this.refresh()
      }
    }
  }

  close() {
    this.generation++
    this.snapshotRequest++
    this.taskRequest++
    this.activityRequest++
    this.statusRequest++
    this.historyRequest++
    this.controller.abort()
    this.taskController.abort()
    if (this.timer) clearInterval(this.timer)
    this.transport = undefined
    this.scope = undefined
    this.projectDirectory = ""
    this.target = undefined
    this.targetError = ""
    this.refreshing = false
    this.pendingRefresh = false
  }
}
