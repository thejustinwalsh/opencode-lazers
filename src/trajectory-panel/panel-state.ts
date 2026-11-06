import type { ObservationScope } from "../observability/contract.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
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
  eventSequence?: number | null
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
  historyError: string
  recapturingHistory: boolean
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
  eventSequence: null,
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
  recapturingHistory: false,
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function historyFailureMessage(error: unknown) {
  const value = record(error)
  if (value?.type === "trajectory_history_unavailable") {
    const data = record(value.data)
    if (data?.recovery !== "recapture")
      return "Captured history is unavailable. Recapture history to continue."
    if (data.reason === "expired")
      return "Captured history has expired. Recapture history to continue."
    if (data.reason === "evicted")
      return "Captured history is no longer cached. Recapture history to continue."
    if (data.reason === "invalid-cursor")
      return "This history continuation is invalid or stale. Recapture history to continue."
    return "Captured history is unavailable. Recapture history to continue."
  }
  if (error instanceof Error)
    return safeText(error.message, privacyStats(), 400) || "Captured history could not be loaded."
  return "Captured history could not be loaded. Recapture history to try again."
}

function requestFailureMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return safeText(error.message, privacyStats(), 400) || fallback
  return fallback
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
  private statusCursor?: string
  private historyRequest = 0
  private transport?: TrajectoryTransport
  private scope?: ObservationScope
  private projectID = ""
  private projectDirectory = ""
  private target?: TaskTrajectoryTarget
  private targetError = ""
  private cancelRetry?: () => void
  private retryDelay = 1_000
  private pendingSequence = 0
  private refreshing = false
  private pendingRefresh = false
  private pendingResnapshot = false

  constructor(
    private readonly changed: (data: PanelData) => void,
    private readonly selected: (preferences: PanelPreferences) => void = () => {},
    private readonly schedule: (callback: () => void, delayMs: number) => () => void = (
      callback,
      delayMs,
    ) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
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
  }

  private retryRefresh() {
    if (this.cancelRetry || this.controller.signal.aborted) return
    const generation = this.generation
    this.cancelRetry = this.schedule(() => {
      if (generation !== this.generation) return
      this.cancelRetry = undefined
      void this.refresh()
    }, this.retryDelay)
    this.retryDelay = Math.min(30_000, this.retryDelay * 2)
  }

  async refresh() {
    const transport = this.transport
    const scope = this.scope
    if (!transport || !scope || this.controller.signal.aborted || this.targetError) return
    if (this.refreshing) {
      this.pendingRefresh = true
      return
    }
    this.cancelRetry?.()
    this.cancelRetry = undefined
    if (!transport.online()) {
      this.update({ stale: true, loading: false, error: "Trajectory updates are disconnected." })
      this.retryRefresh()
      return
    }

    this.refreshing = true
    const generation = this.generation
    const request = ++this.snapshotRequest
    const signal = this.controller.signal
    try {
      if (this.target) {
        const target = this.target
        const taskID = target.taskID
        const taskChanged = taskID !== this.data.taskID
        if (taskChanged) this.beginTask(taskID)
        const taskSignal = AbortSignal.any([signal, this.taskController.signal])
        const taskRequest = this.taskRequest
        if (
          generation !== this.generation ||
          request !== this.snapshotRequest ||
          taskSignal.aborted
        )
          return

        const tasks = [
          ...this.data.tasks.filter((task) => task.taskID !== taskID),
          {
            taskID,
            title: target.reference,
            status: this.data.report?.task.status ?? "loading",
          },
        ]
        this.update({ tasks, taskID, taskReference: target.reference, error: "" })

        if (
          this.data.historyError &&
          this.data.taskID === taskID &&
          (!this.data.report || this.data.historyCapturedAt === null)
        ) {
          this.update({ loading: false, stale: true, error: "" })
        } else if (taskChanged || !this.data.report || this.data.historyCapturedAt === null) {
          await this.captureHistory(taskID, taskSignal, !taskChanged)
        } else {
          await this.refreshStatus(taskID, taskSignal, generation, taskRequest)
        }
        return
      }

      const response = await transport.snapshot(scope, signal)
      if (generation !== this.generation || request !== this.snapshotRequest || signal.aborted)
        return
      if (response.projectID !== this.projectID)
        throw new Error("Observation belongs to another project")
      const snapshot = parseProjectedSnapshot(response)
      const tasks = taskChoices(snapshot)
      const previousTaskID = this.data.taskID
      const taskID = tasks.some((task) => task.taskID === previousTaskID)
        ? previousTaskID
        : (tasks[0]?.taskID ?? null)
      const taskChanged = taskID !== previousTaskID
      if (taskChanged) this.beginTask(taskID)
      const taskSignal = AbortSignal.any([signal, this.taskController.signal])
      const taskRequest = this.taskRequest
      if (generation !== this.generation || request !== this.snapshotRequest || taskSignal.aborted)
        return

      this.update({
        snapshot,
        eventSequence: this.observeEventSequence(snapshot.boundary.eventSequence),
        tasks,
        taskID,
        taskReference: null,
        error: "",
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
          historyError: "",
          recapturingHistory: false,
          loading: false,
          loadingActivity: false,
          stale: false,
          error: "",
        })
      } else if (
        this.data.historyError &&
        this.data.taskID === taskID &&
        (!this.data.report || this.data.historyCapturedAt === null)
      ) {
        this.update({ loading: false, stale: true, error: "" })
      } else if (taskChanged || !this.data.report || this.data.historyCapturedAt === null) {
        await this.captureHistory(taskID, taskSignal, !taskChanged)
      } else {
        await this.refreshStatus(taskID, taskSignal, generation, taskRequest)
      }
    } catch (error) {
      if (generation === this.generation && request === this.snapshotRequest && !signal.aborted) {
        const message = requestFailureMessage(error, "Trajectory snapshot could not be refreshed.")
        this.update({
          loading: false,
          stale: true,
          error: this.target
            ? `Trajectory for ${this.target.reference} is unavailable: ${message}`
            : message,
        })
        this.retryRefresh()
      }
    } finally {
      if (generation === this.generation) {
        this.refreshing = false
        if (!this.data.error) this.retryDelay = 1_000
        const pendingSequence = this.pendingSequence
        this.pendingSequence = 0
        if (this.pendingResnapshot) {
          this.pendingResnapshot = false
          this.update({ eventSequence: null })
        }
        if (
          this.pendingRefresh ||
          (pendingSequence > 0 &&
            (typeof this.data.eventSequence !== "number" ||
              pendingSequence > this.data.eventSequence))
        ) {
          this.pendingRefresh = false
          void this.refresh()
        }
      }
    }
  }

  private beginTask(taskID: string | null) {
    this.statusCursor = undefined
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
      historyError: "",
      recapturingHistory: false,
      loading: taskID !== null,
      loadingActivity: false,
      error: "",
    })
  }

  private observeEventSequence(sequence: number) {
    return typeof this.data.eventSequence !== "number"
      ? sequence
      : Math.max(this.data.eventSequence, sequence)
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
      const response = await transport.status(scope, taskID, signal, this.statusCursor)
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
        effort: {
          ...statusReport.effort,
          ...(captured.effort.marketEquivalentCost
            ? {
                marketEquivalentCost: captured.effort.marketEquivalentCost,
                recordedCost: {
                  ...statusReport.effort.recordedCost,
                  apiEquivalentTotalUsd: captured.effort.recordedCost.apiEquivalentTotalUsd,
                  ...(captured.effort.recordedCost.apiEquivalentSubtotalUsd === undefined
                    ? {}
                    : {
                        apiEquivalentSubtotalUsd:
                          captured.effort.recordedCost.apiEquivalentSubtotalUsd,
                      }),
                  ...(captured.effort.recordedCost.apiEquivalentStatus === undefined
                    ? {}
                    : { apiEquivalentStatus: captured.effort.recordedCost.apiEquivalentStatus }),
                },
              }
            : {}),
        },
        coverage: {
          ...statusReport.coverage,
          ...captured.coverage,
          workerProgress: statusReport.coverage.workerProgress,
        },
        trajectory: captured.trajectory,
      }
      const incoming = statusReport.trajectory.events.filter(
        (event) => event.kind === "commentary" || event.kind.startsWith("worker-"),
      )
      let liveEvents = incoming
      if (response.live?.mode === "patch") {
        if (!this.statusCursor || response.live.baseCursor !== this.statusCursor)
          throw new Error("Live Trajectory baseline changed; resynchronizing")
        const events = new Map(this.data.liveEvents.map((event) => [event.id, event]))
        for (const id of response.live.removed) events.delete(id)
        for (const event of statusReport.trajectory.events) events.delete(event.id)
        for (const event of incoming) events.set(event.id, event)
        liveEvents = [...events.values()].sort(
          (a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.id.localeCompare(b.id),
        )
      }
      this.statusCursor = response.live?.cursor ?? undefined
      const tasks = this.data.tasks.map((task) =>
        task.taskID === taskID ? { ...task, status: statusReport.task.status } : task,
      )
      this.update({
        report,
        tasks,
        liveEvents,
        eventSequence: this.observeEventSequence(response.boundary.eventSequence),
        loading: false,
        stale: Boolean(this.data.historyError),
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
      ) {
        this.statusCursor = undefined
        this.update({
          loading: false,
          stale: true,
          error: requestFailureMessage(error, "Live Trajectory status could not be refreshed."),
        })
        this.retryRefresh()
      }
    }
  }

  private async captureHistory(
    taskID: string,
    signal: AbortSignal,
    preserveSelection: boolean,
    explicitRecapture = false,
  ) {
    const transport = this.transport
    const scope = this.scope
    if (!transport || !scope || signal.aborted) return
    const generation = this.generation
    const taskRequest = this.taskRequest
    const request = ++this.historyRequest
    this.activityRequest++
    this.update({
      loading: !this.data.report,
      loadingActivity: false,
      ...(explicitRecapture ? { recapturingHistory: true } : {}),
    })
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
      const continuationCursors = new Set<string>()
      while (preserveSelection && events.length < targetCount && eventCursor) {
        const requestedCursor = eventCursor
        if (continuationCursors.has(requestedCursor))
          throw new Error("Recaptured history cursor did not advance; recapture explicitly")
        continuationCursors.add(requestedCursor)
        const continuation = await transport.history(
          scope,
          taskID,
          signal,
          requestedCursor,
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
        const nextCursor = continuationReport.trajectory.nextCursor
        if (
          pageEvents.length === 0 ||
          expectedIDs.length !== pageEvents.length ||
          expectedIDs.some((id, index) => id !== pageEvents[index]?.id) ||
          nextCursor === requestedCursor ||
          (nextCursor !== null && continuationCursors.has(nextCursor))
        )
          throw new Error(
            "Recaptured history page order changed or cursor did not advance; recapture explicitly",
          )
        events.push(...pageEvents)
        eventCursor = nextCursor
      }
      if (preserveSelection && events.length < targetCount)
        throw new Error("Recaptured history ended before loaded activity could be preserved")
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
      this.statusCursor = undefined
      this.update({
        report,
        tasks,
        eventSequence: this.observeEventSequence(response.boundary.eventSequence),
        selection,
        selectionEventSnapshot,
        events,
        liveEvents: [],
        capturedEventIDs: eventIDs,
        eventCursor,
        totalEvents: report.trajectory.totalEvents,
        historyCapturedAt: response.capturedAt,
        historyExpiresAt: response.expiresAt,
        historyError: "",
        recapturingHistory: false,
        loading: false,
        loadingActivity: false,
        stale: Boolean(this.data.error),
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
          recapturingHistory: false,
          stale: true,
          historyError:
            this.target?.taskID === taskID
              ? `Trajectory for ${this.target.reference} is unavailable: ${historyFailureMessage(error)}`
              : historyFailureMessage(error),
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
    if (
      !taskID ||
      !transport ||
      !this.scope ||
      this.controller.signal.aborted ||
      this.data.recapturingHistory
    )
      return
    if (!transport.online()) {
      this.update({
        stale: true,
        historyError: "Trajectory updates are disconnected. Reconnect and recapture history.",
      })
      return
    }
    const signal = AbortSignal.any([this.controller.signal, this.taskController.signal])
    await this.captureHistory(taskID, signal, true, true)
  }

  async loadMoreActivity() {
    const transport = this.transport
    const scope = this.scope
    const taskID = this.data.taskID
    const cursor = this.data.eventCursor
    if (
      !transport ||
      !scope ||
      !taskID ||
      !cursor ||
      this.data.loadingActivity ||
      this.data.recapturingHistory
    )
      return
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
        historyError: "Captured activity pages are inconsistent. Recapture history to continue.",
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
        this.update({
          loadingActivity: false,
          stale: true,
          historyError: historyFailureMessage(error),
        })
    }
  }

  private async watch(generation: number, transport: TrajectoryTransport, signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        for await (const event of transport.changes(signal)) {
          if (generation !== this.generation || signal.aborted) return
          if (event.projectID !== this.projectID) continue
          // A reconnect may reset the producer sequence below the old snapshot.
          // Buffer in-flight events before comparing them with that old boundary.
          if (this.refreshing) {
            if (event.resnapshotRequired) {
              this.pendingRefresh = true
              this.pendingResnapshot = true
            } else this.pendingSequence = Math.max(this.pendingSequence, event.sequence)
          } else if (event.resnapshotRequired) {
            this.update({ eventSequence: null })
            void this.refresh()
          } else if (
            typeof this.data.eventSequence !== "number" ||
            event.sequence > this.data.eventSequence
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
    this.statusCursor = undefined
    this.generation++
    this.snapshotRequest++
    this.taskRequest++
    this.activityRequest++
    this.statusRequest++
    this.historyRequest++
    this.controller.abort()
    this.taskController.abort()
    this.cancelRetry?.()
    this.cancelRetry = undefined
    this.retryDelay = 1_000
    this.pendingSequence = 0
    this.pendingResnapshot = false
    this.transport = undefined
    this.scope = undefined
    this.projectDirectory = ""
    this.target = undefined
    this.targetError = ""
    this.refreshing = false
    this.pendingRefresh = false
  }
}
