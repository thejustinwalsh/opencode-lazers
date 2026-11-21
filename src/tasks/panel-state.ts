import { panelErrorMessage } from "../panel-error.ts"
import type {
  StartTaskInput,
  StartTaskReply,
  TaskDetail,
  CurrentActivityOutput,
  CurrentTaskActivity,
} from "./contract.ts"

export type TaskPanelChange = {
  projectDirectory: string
  version: number
  resnapshotRequired?: boolean
  activitySessionID?: string
}

/**
 * What the Tasks panel asks of the server beside its list streams: one task's detail, the current
 * activity of the rows in view, the Start action, and the change feed. The list, its counts and the
 * inspector's relations are stream windows (`panel-streams.ts`).
 */
export interface TaskTransport {
  get(taskID: string, signal: AbortSignal): Promise<TaskDetail>
  currentActivity?(taskIDs: string[], signal: AbortSignal): Promise<CurrentActivityOutput>
  start(input: StartTaskInput, signal: AbortSignal): Promise<StartTaskReply>
  changes(signal: AbortSignal): AsyncIterable<TaskPanelChange>
  online(): boolean
}
export interface TasksPanelData {
  key: string
  currentActivity: Record<string, CurrentTaskActivity>
  activityError: string
  detail?: TaskDetail
  selectedID?: string
  stale: boolean
  error: string
}

const blank = (key = ""): TasksPanelData => ({
  key,
  currentActivity: {},
  activityError: "",
  stale: false,
  error: "",
})

/** Task ids one activity read may name (the contract's own limit). */
const ACTIVITY_TASKS = 40

/** Owns cancellation and response identity independently of the mounted Solid view. */
export class TaskPanelState {
  data = blank()
  private controller = new AbortController()
  private detailController = new AbortController()
  private activityController?: AbortController
  private generation = 0
  private detailRequest = 0
  private activityRequest = 0
  private transport?: TaskTransport
  private project = ""
  private retry?: ReturnType<typeof setTimeout>
  private activityRefreshTimer?: ReturnType<typeof setTimeout>
  private pendingActivityTaskIDs = new Set<string>()
  private pendingActivitySessionIDs = new Set<string>()
  private activitySessions = new Map<string, string>()
  /** The rows in view, whose activity is read. */
  private observed: string[] = []
  private retryDelayMs = 1_000
  private seenVersion = 0
  private starts = new Map<string, Promise<StartTaskReply>>()

  constructor(
    private readonly changed: (data: TasksPanelData) => void,
    private readonly selected: (id: string) => void = () => {},
  ) {}

  private update(change: Partial<TasksPanelData>) {
    this.data = { ...this.data, ...change }
    this.changed(this.data)
  }

  private retryRead(generation: number) {
    if (this.retry || generation !== this.generation || this.controller.signal.aborted) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      if (generation === this.generation) void this.refresh()
    }, this.retryDelayMs)
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000)
  }

  connect(key: string, project: string, transport: TaskTransport, selectedID?: string) {
    this.close()
    this.controller = new AbortController()
    this.transport = transport
    this.project = project
    // The same view on a new connection (a reconnect) keeps what it last read; the next read
    // replaces it. Another view starts empty.
    const kept =
      this.data.key === key
        ? { detail: this.data.detail, currentActivity: this.data.currentActivity }
        : {}
    this.data = { ...blank(key), ...kept }
    this.update({ selectedID })
    void this.watch(this.generation, transport, this.controller.signal)
    // Restored/native-link detail is independent of the list.
    if (selectedID) void this.select(selectedID)
  }

  /** The rows in view; their current activity is read, and read again when they change. */
  observe(taskIDs: readonly string[]) {
    const next = [...new Set(taskIDs)].slice(0, ACTIVITY_TASKS)
    const known = new Set(this.observed)
    this.observed = next
    const added = next.filter((taskID) => !known.has(taskID))
    if (added.length) this.queueCurrentActivity(added)
  }

  private activityTaskIDs(selectedID?: string) {
    return [...new Set([...this.observed, ...(selectedID ? [selectedID] : [])])].slice(
      0,
      ACTIVITY_TASKS,
    )
  }

  private cancelCurrentActivity() {
    this.activityRequest++
    this.activityController?.abort()
    this.activityController = undefined
  }

  private clearPendingActivityRefresh() {
    if (this.activityRefreshTimer) clearTimeout(this.activityRefreshTimer)
    this.activityRefreshTimer = undefined
    this.pendingActivityTaskIDs.clear()
    this.pendingActivitySessionIDs.clear()
  }

  private queueCurrentActivity(taskIDs: readonly string[]) {
    for (const taskID of taskIDs) this.pendingActivityTaskIDs.add(taskID)
    if (this.pendingActivityTaskIDs.size === 0 || this.activityRefreshTimer) return
    this.activityRefreshTimer = setTimeout(() => {
      this.activityRefreshTimer = undefined
      this.flushCurrentActivity()
    }, 50)
    this.activityRefreshTimer.unref?.()
  }

  private flushCurrentActivity() {
    const transport = this.transport
    if (this.pendingActivityTaskIDs.size === 0) return
    if (!transport?.currentActivity || this.controller.signal.aborted) {
      this.clearPendingActivityRefresh()
      return
    }
    if (this.activityController) return
    const taskIDs = [...this.pendingActivityTaskIDs].slice(0, ACTIVITY_TASKS)
    for (const taskID of taskIDs) this.pendingActivityTaskIDs.delete(taskID)
    void this.observeCurrentActivity(taskIDs, this.generation, this.data.selectedID)
  }

  private async observeCurrentActivity(
    taskIDs: string[],
    generation: number,
    selectedID: string | undefined,
  ) {
    const transport = this.transport
    if (!transport?.currentActivity || taskIDs.length === 0) return
    this.cancelCurrentActivity()
    const request = ++this.activityRequest
    const controller = new AbortController()
    this.activityController = controller
    const signal = AbortSignal.any([this.controller.signal, controller.signal])
    const selectedAtRequest = selectedID
    const isCurrent = () =>
      generation === this.generation &&
      request === this.activityRequest &&
      selectedAtRequest === this.data.selectedID &&
      !signal.aborted
    const requested = new Set(taskIDs)
    // A refresh is not a loss of observation. Keep the last result visible until this read
    // replaces it; active lists can refresh continuously.
    this.update({ activityError: "" })
    try {
      const response = await transport.currentActivity(taskIDs, signal)
      if (!isCurrent()) return
      const next = { ...this.data.currentActivity }
      for (const taskID of taskIDs) delete next[taskID]
      const activities = response.activities.filter((activity) => requested.has(activity.taskID))
      for (const taskID of taskIDs) this.activitySessions.delete(taskID)
      for (const activity of activities) next[activity.taskID] = activity
      for (const activity of activities) {
        if (activity.workerSessionID) {
          this.activitySessions.delete(activity.taskID)
          this.activitySessions.set(activity.taskID, activity.workerSessionID)
        }
      }
      while (this.activitySessions.size > ACTIVITY_TASKS)
        this.activitySessions.delete(this.activitySessions.keys().next().value!)
      this.flushPendingActivitySessions()
      this.update({
        currentActivity: next,
        activityError:
          activities.length === taskIDs.length ? "" : "Current activity is incomplete.",
      })
    } catch {
      if (isCurrent()) {
        const currentActivity = { ...this.data.currentActivity }
        for (const taskID of taskIDs) delete currentActivity[taskID]
        this.update({ currentActivity, activityError: "Current activity is unavailable." })
      }
    } finally {
      if (this.activityController === controller) this.activityController = undefined
      this.flushCurrentActivity()
    }
  }

  refreshCurrentActivity(sessionID?: string) {
    const transport = this.transport
    if (!transport?.currentActivity || this.controller.signal.aborted) return
    const taskIDs = sessionID
      ? this.activityTaskIDsForSession(sessionID)
      : this.activityTaskIDs(this.data.selectedID)
    if (taskIDs.length) this.queueCurrentActivity(taskIDs)
    else if (sessionID && this.activityController && this.pendingActivitySessionIDs.size < 80)
      this.pendingActivitySessionIDs.add(sessionID)
  }

  private activityTaskIDsForSession(sessionID: string) {
    return [...this.activitySessions]
      .filter(([, workerSessionID]) => workerSessionID === sessionID)
      .map(([taskID]) => taskID)
      .slice(0, ACTIVITY_TASKS)
  }

  private flushPendingActivitySessions() {
    if (this.pendingActivitySessionIDs.size === 0) return
    const taskIDs = new Set<string>()
    for (const sessionID of this.pendingActivitySessionIDs) {
      for (const taskID of this.activityTaskIDsForSession(sessionID)) taskIDs.add(taskID)
    }
    this.pendingActivitySessionIDs.clear()
    if (taskIDs.size) this.queueCurrentActivity([...taskIDs])
  }

  /** Read the selected task and the rows in view again (the panel's Retry, and a change event). */
  async refresh() {
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    this.update({ error: "", stale: !transport.online() })
    this.refreshCurrentActivity()
    const selectedID = this.data.selectedID
    if (selectedID) await this.select(selectedID, true)
  }

  async select(taskID: string, refresh = false) {
    const transport = this.transport
    if (!transport) return
    this.detailController.abort()
    this.detailController = new AbortController()
    const signal = AbortSignal.any([this.detailController.signal, this.controller.signal])
    const generation = this.generation
    const request = ++this.detailRequest
    if (!refresh) {
      // The previous detail stays until this task's read replaces it: the inspector never blanks.
      this.update({ selectedID: taskID })
      this.selected(taskID)
      this.cancelCurrentActivity()
      // Selecting is not a loss of observation: the last result stays until this read replaces
      // it. Clearing it here dropped requests from Attention whenever the next selection
      // superseded the read (keyboard stepping through Attention).
      this.update({ activityError: "" })
      void this.observeCurrentActivity([taskID], generation, taskID)
    }
    try {
      const detail = await transport.get(taskID, signal)
      if (generation === this.generation && request === this.detailRequest && !signal.aborted) {
        this.update({ detail, error: "", stale: !transport.online() })
        this.retryDelayMs = 1_000
      }
    } catch (error) {
      if (generation === this.generation && request === this.detailRequest && !signal.aborted) {
        this.update({ error: panelErrorMessage(error), stale: true })
        this.retryRead(generation)
      }
    }
  }

  async start(input: StartTaskInput): Promise<StartTaskReply> {
    const key = `${input.taskID}:${input.revision}`
    const pending = this.starts.get(key)
    if (pending) return pending
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) throw new Error("Task view is disconnected")
    const generation = this.generation
    const promise = (async () => {
      const result = await transport.start(input, this.controller.signal)
      if (generation === this.generation && !this.controller.signal.aborted) await this.refresh()
      return result
    })()
    this.starts.set(key, promise)
    try {
      return await promise
    } finally {
      if (this.starts.get(key) === promise) this.starts.delete(key)
    }
  }

  private async watch(generation: number, transport: TaskTransport, signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        for await (const event of transport.changes(signal)) {
          if (generation !== this.generation || signal.aborted) return
          if (event.projectDirectory !== this.project) continue
          if (event.activitySessionID && !event.resnapshotRequired) {
            this.refreshCurrentActivity(event.activitySessionID)
            continue
          }
          // The list follows its streams; the detail and the activity of the rows in view follow
          // the change feed.
          if (!event.resnapshotRequired && event.version <= this.seenVersion) continue
          this.seenVersion = Math.max(this.seenVersion, event.version)
          void this.refresh()
        }
        if (!signal.aborted) throw new Error("Task update connection closed")
      } catch (error) {
        if (generation !== this.generation || signal.aborted) return
        this.update({ stale: true, error: panelErrorMessage(error) })
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            signal.removeEventListener("abort", done)
            resolve()
          }
          const timer = setTimeout(done, 1_000)
          signal.addEventListener("abort", done, { once: true })
        })
      }
    }
  }

  close() {
    this.generation++
    this.detailRequest++
    this.controller.abort()
    this.detailController.abort()
    this.cancelCurrentActivity()
    this.clearPendingActivityRefresh()
    this.activitySessions.clear()
    this.starts.clear()
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.retryDelayMs = 1_000
    this.observed = []
    this.seenVersion = 0
    this.transport = undefined
  }
}
