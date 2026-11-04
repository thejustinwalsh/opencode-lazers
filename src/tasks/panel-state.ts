import type {
  StartTaskInput,
  StartTaskResult,
  TaskDetail,
  TaskPage,
  TaskQuery,
  TaskSummary,
} from "./contract.ts"
import type { SnapshotResponse } from "../observability/contract.ts"

export type TaskPanelChange = {
  projectDirectory: string
  version: number
  resnapshotRequired?: boolean
}

export interface TaskTransport {
  query(input: TaskQuery, signal: AbortSignal): Promise<TaskPage>
  get(taskID: string, signal: AbortSignal): Promise<TaskDetail>
  snapshot?(signal: AbortSignal): Promise<SnapshotResponse>
  start(input: StartTaskInput, signal: AbortSignal): Promise<StartTaskResult>
  changes(signal: AbortSignal): AsyncIterable<TaskPanelChange>
  online(): boolean
}
export interface PanelData {
  key: string
  tasks: TaskSummary[]
  page?: TaskPage
  topology?: SnapshotResponse
  topologyError?: string
  detail?: TaskDetail
  selectedID?: string
  linkedDetails: Record<string, Extract<TaskDetail, { status: "found" }>>
  loading: boolean
  stale: boolean
  error: string
}
const blank = (key = ""): PanelData => ({
  key,
  tasks: [],
  linkedDetails: {},
  loading: true,
  stale: false,
  error: "",
})

/** Owns cancellation and response identity independently of the mounted Solid view. */
export class TaskPanelState {
  data = blank()
  private controller = new AbortController()
  private detailController = new AbortController()
  private generation = 0
  private listRequest = 0
  private detailRequest = 0
  private transport?: TaskTransport
  private query: TaskQuery = {}
  private project = ""
  private retry?: ReturnType<typeof setTimeout>
  private retryDelayMs = 1_000
  private refreshPending = false
  private pendingVersion = 0
  private refreshing = false
  private starts = new Map<string, Promise<StartTaskResult>>()
  private linkedRequests = new Map<
    string,
    Promise<Extract<TaskDetail, { status: "found" }> | undefined>
  >()

  constructor(
    private readonly changed: (data: PanelData) => void,
    private readonly selected: (id: string) => void = () => {},
  ) {}

  private update(change: Partial<PanelData>) {
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

  connect(
    key: string,
    project: string,
    transport: TaskTransport,
    query: TaskQuery,
    selectedID?: string,
  ) {
    this.close()
    this.controller = new AbortController()
    this.transport = transport
    this.query = query
    this.project = project
    this.data = blank(key)
    this.update({ selectedID })
    const generation = this.generation
    const signal = this.controller.signal
    void this.watch(generation, transport, signal)
    // Restored/native-link detail is independent of optional topology or list failures.
    if (selectedID) void this.select(selectedID)
    void this.refresh()
  }

  async refresh() {
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    if (this.refreshing) {
      this.refreshPending = true
      return
    }
    this.refreshing = true
    const generation = this.generation
    const request = ++this.listRequest
    const signal = this.controller.signal
    try {
      let page: TaskPage | undefined
      let tasks: TaskSummary[] = []
      let topology: SnapshotResponse | undefined
      let topologyError = ""
      for (let attempt = 0; attempt < 3; attempt++) {
        const first = await transport.query({ ...this.query, cursor: undefined }, signal)
        if (generation !== this.generation || request !== this.listRequest) return
        if (first.projectDirectory !== this.project)
          throw new Error("Task response belongs to another project")
        topology = undefined
        topologyError = ""
        if (transport.snapshot) {
          try {
            const observed = await transport.snapshot(signal)
            if (signal.aborted || generation !== this.generation || request !== this.listRequest)
              return
            if (observed.boundary.repositoryVersion !== first.snapshot) {
              if (attempt < 2) continue
              topologyError =
                "Execution topology changed during the task read. Showing ungrouped tasks."
            } else {
              topology = observed
            }
          } catch (error) {
            if (signal.aborted || generation !== this.generation) return
            topologyError = `Execution links unavailable: ${String(error)}`
          }
        }
        const wanted = Math.max(
          first.tasks.length,
          this.data.tasks.length +
            Math.max(0, first.count - (this.data.page?.count ?? first.count)),
        )
        page = first
        tasks = [...first.tasks]
        let changedSnapshot = false
        while (page.nextCursor && tasks.length < wanted) {
          page = await transport.query({ ...this.query, cursor: page.nextCursor }, signal)
          if (generation !== this.generation || request !== this.listRequest) return
          if (page.snapshot !== first.snapshot) {
            changedSnapshot = true
            break
          }
          tasks.push(...page.tasks)
        }
        if (changedSnapshot && attempt < 2) continue
        if (changedSnapshot) throw new Error("Task pages changed during the read; retry")
        if (!topology && transport.snapshot && !topologyError)
          topologyError = "Execution topology is unavailable. Showing ungrouped tasks."
        break
      }
      if (!page) throw new Error("Could not read a stable task snapshot")
      if (signal.aborted || generation !== this.generation || request !== this.listRequest) return
      this.update({
        tasks,
        page,
        topology,
        topologyError,
        loading: false,
        stale: !transport.online(),
        error: "",
      })
      if (!this.data.selectedID && tasks.length) await this.select(tasks[0]!.taskID)
      else if (this.data.selectedID) await this.select(this.data.selectedID, true)
    } catch (error) {
      if (generation === this.generation && !signal.aborted) {
        this.update({ loading: false, stale: true, error: String(error) })
      }
    } finally {
      if (generation === this.generation) {
        this.refreshing = false
        if (
          this.refreshPending ||
          (this.pendingVersion > (this.data.page?.snapshot ?? 0) && !this.data.error)
        ) {
          this.refreshPending = false
          this.pendingVersion = 0
          void this.refresh()
        } else if (this.data.error || this.data.topologyError) {
          this.retryRead(generation)
        } else {
          if (this.retry) clearTimeout(this.retry)
          this.retry = undefined
          this.retryDelayMs = 1_000
        }
      }
    }
  }

  async more() {
    const cursor = this.data.page?.nextCursor
    const transport = this.transport
    if (!cursor || !transport || this.refreshing) return
    this.refreshing = true
    const generation = this.generation
    const request = ++this.listRequest
    try {
      const page = await transport.query({ ...this.query, cursor }, this.controller.signal)
      if (generation !== this.generation || request !== this.listRequest) return
      if (page.projectDirectory !== this.project)
        throw new Error("Task response belongs to another project")
      const seen = new Set(this.data.tasks.map((task) => task.taskID))
      this.update({
        page,
        tasks: [...this.data.tasks, ...page.tasks.filter((task) => !seen.has(task.taskID))],
      })
    } catch (error) {
      if (generation === this.generation && !this.controller.signal.aborted)
        this.update({ stale: true, error: String(error) })
    } finally {
      if (generation === this.generation) {
        this.refreshing = false
        if (this.refreshPending || this.pendingVersion > (this.data.page?.snapshot ?? 0)) {
          this.refreshPending = false
          this.pendingVersion = 0
          void this.refresh()
        } else if (this.data.error) this.retryRead(generation)
      }
    }
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
      this.update({ selectedID: taskID, detail: undefined })
      this.selected(taskID)
    }
    try {
      const detail = await transport.get(taskID, signal)
      if (generation === this.generation && request === this.detailRequest && !signal.aborted) {
        this.update({ detail })
      }
    } catch (error) {
      if (generation === this.generation && request === this.detailRequest && !signal.aborted) {
        this.update({ error: String(error), stale: true })
        this.retryRead(generation)
      }
    }
  }

  async resolveLinked(taskID: string) {
    const cached = this.data.linkedDetails[taskID]
    if (cached) return cached
    const pending = this.linkedRequests.get(taskID)
    if (pending) return pending
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return undefined
    const generation = this.generation
    const signal = this.controller.signal
    const request = transport
      .get(taskID, signal)
      .then((detail) => {
        if (generation !== this.generation || signal.aborted || detail.status !== "found")
          return undefined
        const linkedDetails = { ...this.data.linkedDetails, [taskID]: detail }
        this.update({ linkedDetails })
        return detail
      })
      .catch(() => undefined)
    this.linkedRequests.set(taskID, request)
    void request.finally(() => {
      if (this.linkedRequests.get(taskID) === request) this.linkedRequests.delete(taskID)
    })
    return request
  }

  async start(input: StartTaskInput): Promise<StartTaskResult> {
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
          if (event.resnapshotRequired) {
            void this.refresh()
            continue
          }
          if (event.version <= (this.data.page?.snapshot ?? 0)) continue
          this.pendingVersion = Math.max(this.pendingVersion, event.version)
          if (!this.refreshing) void this.refresh()
        }
        if (!signal.aborted) throw new Error("Task update connection closed")
      } catch (error) {
        if (generation !== this.generation || signal.aborted) return
        this.update({ stale: true, error: String(error) })
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
    this.listRequest++
    this.detailRequest++
    this.controller.abort()
    this.detailController.abort()
    this.starts.clear()
    this.linkedRequests.clear()
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.retryDelayMs = 1_000
    this.refreshPending = false
    this.transport = undefined
    this.refreshing = false
    this.pendingVersion = 0
  }
}
