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
}

export type PanelData = {
  key: string
  snapshot?: ProjectedSnapshot
  tasks: TaskChoice[]
  taskID: string | null
  report?: TrajectoryReport
  selection: Selection | null
  events: TrajectoryEvent[]
  eventCursor: string | null
  totalEvents: number
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
        : data.events.find((event) => event.id === selection.id)?.attemptID
  return id ? report.attempts.find((attempt) => attempt.id === id) : undefined
}

const blank = (key = ""): PanelData => ({
  key,
  tasks: [],
  taskID: null,
  selection: null,
  events: [],
  eventCursor: null,
  totalEvents: 0,
  loading: true,
  loadingActivity: false,
  stale: false,
  error: "",
})

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

export class TrajectoryPanelState {
  data = blank()
  private controller = new AbortController()
  private taskController = new AbortController()
  private generation = 0
  private snapshotRequest = 0
  private taskRequest = 0
  private activityRequest = 0
  private transport?: TrajectoryTransport
  private scope?: ObservationScope
  private projectID = ""
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
    this.data = blank(key)
    this.update({ taskID: preferences.taskID, selection: preferences.selection })
    const generation = this.generation
    void this.watch(generation, transport, this.controller.signal)
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), 4_000)
  }

  async refresh() {
    const transport = this.transport
    const scope = this.scope
    if (!transport || !scope || this.controller.signal.aborted) return
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
      const tasks = taskChoices(snapshot)
      const previousTaskID = this.data.taskID
      const taskID = tasks.some((task) => task.taskID === previousTaskID)
        ? previousTaskID
        : (tasks[0]?.taskID ?? null)
      const taskChanged = taskID !== previousTaskID
      this.taskController.abort()
      this.taskController = new AbortController()
      const taskRequest = ++this.taskRequest
      this.activityRequest++
      const taskSignal = AbortSignal.any([signal, this.taskController.signal])
      const reportData = taskID
        ? await this.readTask(taskID, taskSignal)
        : { report: undefined, response: undefined }
      if (
        generation !== this.generation ||
        request !== this.snapshotRequest ||
        taskRequest !== this.taskRequest ||
        taskSignal.aborted
      )
        return

      const previousSelection = this.data.selection
      const previousEvent =
        this.data.selection?.kind === "event"
          ? this.data.events.find((event) => event.id === this.data.selection!.id)
          : undefined
      const events = [...(reportData.report?.trajectory.events ?? [])]
      if (previousEvent && !events.some((event) => event.id === previousEvent.id))
        events.push(previousEvent)
      events.sort((left, right) => {
        const a = typeof left.at === "number" ? left.at : Number.MAX_SAFE_INTEGER
        const b = typeof right.at === "number" ? right.at : Number.MAX_SAFE_INTEGER
        return a - b || left.id.localeCompare(right.id)
      })
      const selection = this.reconcileSelection(
        taskChanged ? null : this.data.selection,
        reportData.report,
        events,
      )
      this.update({
        snapshot,
        tasks,
        taskID,
        report: reportData.report,
        selection,
        events,
        eventCursor: reportData.report?.trajectory.nextCursor ?? null,
        totalEvents: reportData.report?.trajectory.totalEvents ?? 0,
        loading: false,
        loadingActivity: false,
        stale: false,
        error: "",
      })
      if (taskChanged || JSON.stringify(selection) !== JSON.stringify(previousSelection))
        this.selected({ taskID, selection })
    } catch (error) {
      if (generation === this.generation && !signal.aborted)
        this.update({ loading: false, stale: true, error: String(error) })
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

  private async readTask(taskID: string, signal: AbortSignal) {
    const transport = this.transport!
    const scope = this.scope!
    const response = await transport.trajectory(scope, taskID, signal)
    if (signal.aborted) return { report: undefined, response: undefined }
    if (response.projectID !== this.projectID)
      throw new Error("Trajectory belongs to another project")
    const report = parseTrajectoryReport(response)
    if (report.task.id !== taskID) throw new Error("Trajectory belongs to another task")
    return { report, response }
  }

  private reconcileSelection(
    selected: Selection | null,
    report: TrajectoryReport | undefined,
    events: TrajectoryEvent[],
  ): Selection | null {
    if (!report) return null
    if (selected) {
      if (
        selected.kind === "attempt" &&
        report.attempts.some((attempt) => attempt.id === selected.id)
      )
        return selected
      if (selected.kind === "event" && events.some((event) => event.id === selected.id))
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
    this.taskController.abort()
    this.taskController = new AbortController()
    this.taskRequest++
    this.activityRequest++
    this.update({
      taskID,
      report: undefined,
      selection: null,
      events: [],
      eventCursor: null,
      totalEvents: 0,
      loading: true,
      loadingActivity: false,
      error: "",
    })
    this.selected({ taskID, selection: null })
    void this.loadSelectedTask(taskID)
  }

  private async loadSelectedTask(taskID: string) {
    const signal = AbortSignal.any([this.controller.signal, this.taskController.signal])
    const generation = this.generation
    const request = this.taskRequest
    try {
      const { report } = await this.readTask(taskID, signal)
      if (generation !== this.generation || request !== this.taskRequest || signal.aborted) return
      const selection = report ? defaultSelection(report) : null
      this.update({
        report,
        selection,
        events: report?.trajectory.events ?? [],
        eventCursor: report?.trajectory.nextCursor ?? null,
        totalEvents: report?.trajectory.totalEvents ?? 0,
        loading: false,
        stale: false,
        error: "",
      })
      this.selected({ taskID, selection })
    } catch (error) {
      if (generation === this.generation && !signal.aborted)
        this.update({ loading: false, stale: true, error: String(error) })
    }
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
    if (!this.data.events.some((event) => event.id === id)) return
    this.setSelection({ kind: "event", id })
  }

  private setSelection(selection: Selection) {
    this.update({ selection })
    this.selected({ taskID: this.data.taskID, selection })
  }

  async loadMoreActivity() {
    const transport = this.transport
    const scope = this.scope
    const taskID = this.data.taskID
    const cursor = this.data.eventCursor
    if (!transport || !scope || !taskID || !cursor || this.data.loadingActivity) return
    const generation = this.generation
    const request = ++this.activityRequest
    const signal = AbortSignal.any([this.controller.signal, this.taskController.signal])
    const boundary = this.data.snapshot?.boundary
    this.update({ loadingActivity: true })
    try {
      const response = await transport.trajectory(scope, taskID, signal, cursor)
      if (generation !== this.generation || request !== this.activityRequest || signal.aborted)
        return
      const latestBoundary = this.data.snapshot?.boundary
      if (
        boundary?.sourceFingerprint !== latestBoundary?.sourceFingerprint ||
        boundary?.nativeRevision !== latestBoundary?.nativeRevision
      ) {
        this.update({ loadingActivity: false })
        void this.refresh()
        return
      }
      const report = parseTrajectoryReport(response)
      if (response.projectID !== this.projectID || report.task.id !== taskID)
        throw new Error("Activity page belongs to another project or task")
      const known = new Set(this.data.events.map((event) => event.id))
      const events = [
        ...this.data.events,
        ...report.trajectory.events.filter((event) => !known.has(event.id)),
      ]
      events.sort((left, right) => {
        const a = typeof left.at === "number" ? left.at : Number.MAX_SAFE_INTEGER
        const b = typeof right.at === "number" ? right.at : Number.MAX_SAFE_INTEGER
        return a - b || left.id.localeCompare(right.id)
      })
      this.update({
        events,
        eventCursor: report.trajectory.nextCursor,
        totalEvents: report.trajectory.totalEvents,
        loadingActivity: false,
      })
    } catch (error) {
      if (generation === this.generation && !signal.aborted)
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
    this.controller.abort()
    this.taskController.abort()
    if (this.timer) clearInterval(this.timer)
    this.transport = undefined
    this.scope = undefined
    this.refreshing = false
    this.pendingRefresh = false
  }
}
