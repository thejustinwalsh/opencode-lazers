import type { TaskDetail, TaskPage } from "../tasks/contract.ts"
import type { TrajectoryResponse } from "../observability/contract.ts"
import { readTaskEffortBasis } from "./comparison-presentation.ts"
import type { ModelEvidenceOutput } from "./source-schema.ts"
import type { ModelComparisonOutput } from "./comparison-schema.ts"
import type { ModelSettingsOutput } from "./contract.ts"

export type ModelComparisonTransport = {
  comparison(cursor: string | undefined, signal: AbortSignal): Promise<ModelComparisonOutput>
  refreshSources(signal: AbortSignal): Promise<ModelEvidenceOutput>
  settings(taskID: string | undefined, signal: AbortSignal): Promise<ModelSettingsOutput>
  queryTasks(signal: AbortSignal): Promise<TaskPage>
  getTask(taskID: string, signal: AbortSignal): Promise<TaskDetail>
  trajectoryStatus(taskID: string, signal: AbortSignal): Promise<TrajectoryResponse>
  online(): boolean
}

export type ModelTask = Extract<TaskDetail, { status: "found" }> | undefined
export type ModelCandidate = ModelComparisonOutput["candidates"][number]

export type ModelComparisonPanelData = {
  key: string
  projectID: string
  projectDirectory: string
  comparison?: ModelComparisonOutput
  candidates: ModelCandidate[]
  selectedCandidateID: string | null
  tasks: TaskPage["tasks"]
  selectedTaskID: string | null
  task?: ModelTask
  effortBasis?: ReturnType<typeof readTaskEffortBasis>
  settings?: ModelSettingsOutput
  comparisonLoading: boolean
  comparisonError: string
  comparisonStale: boolean
  taskLoading: boolean
  taskError: string
  effortLoading: boolean
  effortError: string
  settingsLoading: boolean
  settingsError: string
  tasksLoading: boolean
  tasksError: string
  sourceRefresh: "idle" | "refreshing" | "succeeded" | "failed"
  sourceRefreshError: string
  stale: boolean
}

export type ModelComparisonPreferences = {
  selectedTaskID: string | null
  selectedCandidateID: string | null
}

function blank(
  key = "",
  projectID = "",
  projectDirectory = "",
  preferences: ModelComparisonPreferences = {
    selectedTaskID: null,
    selectedCandidateID: null,
  },
): ModelComparisonPanelData {
  return {
    key,
    projectID,
    projectDirectory,
    candidates: [],
    selectedCandidateID: preferences.selectedCandidateID,
    tasks: [],
    selectedTaskID: preferences.selectedTaskID,
    comparisonLoading: true,
    comparisonError: "",
    comparisonStale: false,
    taskLoading: true,
    taskError: "",
    effortLoading: false,
    effortError: "",
    settingsLoading: true,
    settingsError: "",
    tasksLoading: true,
    tasksError: "",
    sourceRefresh: "idle",
    sourceRefreshError: "",
    stale: false,
  }
}

/** Coordinates bounded comparison reads and the selected task's actual observation. */
export class ModelComparisonPanelState {
  data = blank()
  private controller = new AbortController()
  private taskController = new AbortController()
  private generation = 0
  private comparisonRequest = 0
  private taskRequest = 0
  private settingsRequest = 0
  private transport?: ModelComparisonTransport
  private projectID = ""
  private projectDirectory = ""
  private sourceRefreshPromise?: Promise<void>
  private comparisonPromise?: Promise<void>
  private comparisonNeedsRefresh = false

  constructor(
    private readonly changed: (data: ModelComparisonPanelData) => void,
    private readonly selectionChanged: (selection: ModelComparisonPreferences) => void = () => {},
  ) {}

  private update(change: Partial<ModelComparisonPanelData>) {
    this.data = { ...this.data, ...change }
    this.changed(this.data)
  }

  connect(
    key: string,
    projectID: string,
    projectDirectory: string,
    transport: ModelComparisonTransport,
    preferences: ModelComparisonPreferences,
  ) {
    this.close()
    this.controller = new AbortController()
    this.taskController = new AbortController()
    this.transport = transport
    this.projectID = projectID
    this.projectDirectory = projectDirectory
    this.data = blank(key, projectID, projectDirectory, preferences)
    const generation = this.generation

    // Invoke the cached bounded projection before starting the independent refresh.
    void this.refreshComparison(generation)
    void this.loadTasks(generation, preferences.selectedTaskID ?? undefined)
    void this.loadSettings(generation, preferences.selectedTaskID ?? undefined)
    void this.refreshSources(generation)
  }

  async refreshComparison(generation = this.generation, cursor?: string) {
    if (this.comparisonPromise) {
      if (!cursor) this.comparisonNeedsRefresh = true
      return this.comparisonPromise
    }
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    const request = ++this.comparisonRequest
    const signal = this.controller.signal
    this.update({ comparisonLoading: true })
    const operation = (async () => {
      try {
        const output = await transport.comparison(cursor, signal)
        if (generation !== this.generation || request !== this.comparisonRequest || signal.aborted)
          return
        if (output.candidates.length > 100) throw new Error("Comparison exceeded its bounded page")
        const candidates = cursor
          ? [...this.data.candidates, ...output.candidates]
          : output.candidates
        const previousCandidateID = this.data.selectedCandidateID
        const selectedCandidateID = candidates.some(
          (candidate) => candidate.candidateID === this.data.selectedCandidateID,
        )
          ? this.data.selectedCandidateID
          : (this.data.selectedCandidateID ?? candidates[0]?.candidateID ?? null)
        this.update({
          comparison: output,
          candidates,
          selectedCandidateID,
          comparisonLoading: false,
          comparisonError: "",
          comparisonStale: false,
          stale: !transport.online(),
        })
        if (selectedCandidateID !== previousCandidateID)
          this.selectionChanged({
            selectedTaskID: this.data.selectedTaskID,
            selectedCandidateID,
          })
      } catch (error) {
        if (generation === this.generation && !signal.aborted)
          this.update({
            comparisonLoading: false,
            comparisonError: error instanceof Error ? error.message : String(error),
            comparisonStale: Boolean(this.data.comparison),
            stale: true,
          })
      }
    })()
    this.comparisonPromise = operation
    await operation
    if (generation === this.generation && this.comparisonPromise === operation) {
      this.comparisonPromise = undefined
      if (this.comparisonNeedsRefresh && !this.controller.signal.aborted) {
        this.comparisonNeedsRefresh = false
        await this.refreshComparison(generation)
      }
    }
  }

  async moreCandidates() {
    const cursor = this.data.comparison?.nextCursor
    if (!cursor || this.data.comparisonLoading) return
    const before = this.data.candidates.length
    const output = this.data.comparison
    await this.refreshComparison(this.generation, cursor)
    if (
      output &&
      this.data.comparison &&
      output.sources.some(
        (source, index) =>
          source.selectedSnapshotID !== this.data.comparison?.sources[index]?.selectedSnapshotID,
      )
    ) {
      this.update({
        comparisonError:
          "Source snapshots changed while loading more candidates. Refresh the view.",
        comparisonStale: true,
        comparison: output,
        candidates: this.data.candidates.slice(0, before),
      })
    }
  }

  async refresh() {
    if (!this.transport || this.controller.signal.aborted) return
    await Promise.all([
      this.refreshComparison(),
      this.loadTasks(this.generation, this.data.selectedTaskID ?? undefined),
      this.refreshSources(this.generation),
    ])
  }

  async refreshSources(generation = this.generation): Promise<void> {
    if (this.sourceRefreshPromise) return this.sourceRefreshPromise
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    const signal = this.controller.signal
    this.update({ sourceRefresh: "refreshing", sourceRefreshError: "" })
    const operation = (async () => {
      try {
        await transport.refreshSources(signal)
        if (generation !== this.generation || signal.aborted) return
        this.update({ sourceRefresh: "succeeded", sourceRefreshError: "" })
        await this.refreshComparison(generation)
      } catch (error) {
        if (generation === this.generation && !signal.aborted)
          this.update({
            sourceRefresh: "failed",
            sourceRefreshError: error instanceof Error ? error.message : String(error),
            stale: true,
          })
      } finally {
        if (generation === this.generation) this.sourceRefreshPromise = undefined
      }
    })()
    this.sourceRefreshPromise = operation
    return operation
  }

  selectCandidate(candidateID: string) {
    if (!this.data.candidates.some((candidate) => candidate.candidateID === candidateID)) return
    if (candidateID === this.data.selectedCandidateID) return
    this.update({ selectedCandidateID: candidateID })
    this.selectionChanged({
      selectedTaskID: this.data.selectedTaskID,
      selectedCandidateID: candidateID,
    })
  }

  selectTask(taskID: string | null) {
    if (taskID === this.data.selectedTaskID) return
    if (taskID && !this.data.tasks.some((task) => task.taskID === taskID)) return
    this.taskController.abort()
    this.taskController = new AbortController()
    this.taskRequest++
    this.settingsRequest++
    this.update({
      selectedTaskID: taskID,
      task: undefined,
      effortBasis: undefined,
      taskLoading: Boolean(taskID),
      taskError: "",
      effortLoading: Boolean(taskID),
      effortError: "",
      settings: undefined,
      settingsLoading: true,
      settingsError: "",
    })
    this.selectionChanged({
      selectedTaskID: taskID,
      selectedCandidateID: this.data.selectedCandidateID,
    })
    const generation = this.generation
    void this.loadSettings(generation, taskID ?? undefined)
    if (taskID) void this.loadSelectedTask(generation, taskID)
  }

  private async loadTasks(generation: number, preferredTaskID?: string) {
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    const signal = this.controller.signal
    try {
      const page = await transport.queryTasks(signal)
      if (generation !== this.generation || signal.aborted) return
      if (page.projectDirectory !== this.projectDirectory)
        throw new Error("Task list belongs to another project")
      this.update({ tasks: page.tasks, tasksLoading: false, tasksError: "" })
      const current = preferredTaskID ?? this.data.selectedTaskID
      const selected = current ?? page.tasks[0]?.taskID ?? null
      if (selected !== this.data.selectedTaskID) this.selectTask(selected)
      else if (selected && !this.data.task && !this.taskController.signal.aborted)
        await this.loadSelectedTask(generation, selected)
      else if (!selected && this.data.selectedTaskID !== null) this.selectTask(null)
    } catch (error) {
      if (generation === this.generation && !signal.aborted)
        this.update({
          tasksLoading: false,
          tasksError: error instanceof Error ? error.message : String(error),
          stale: true,
        })
    }
  }

  private async loadSelectedTask(generation: number, taskID: string) {
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    this.taskController.abort()
    this.taskController = new AbortController()
    const taskRequest = ++this.taskRequest
    const signal = AbortSignal.any([this.controller.signal, this.taskController.signal])
    this.update({ taskLoading: true, taskError: "", effortLoading: true, effortError: "" })
    const detailRead = transport.getTask(taskID, signal)
    const effortRead = transport.trajectoryStatus(taskID, signal)
    const [detailResult, effortResult] = await Promise.allSettled([detailRead, effortRead])
    if (
      generation !== this.generation ||
      taskRequest !== this.taskRequest ||
      signal.aborted ||
      this.data.selectedTaskID !== taskID
    )
      return

    if (detailResult.status === "fulfilled") {
      const detail = detailResult.value
      if (detail.status === "found") {
        if (detail.task.id !== taskID || detail.task.provenance.projectID !== this.projectID)
          this.update({ taskError: "Task detail belongs to another project or task." })
        else this.update({ task: detail, taskError: "" })
      } else {
        this.update({ task: undefined, taskError: "The selected task is no longer available." })
        if (!this.data.tasks.some((task) => task.taskID === taskID))
          this.selectTask(this.data.tasks[0]?.taskID ?? null)
      }
    } else {
      this.update({
        task: undefined,
        taskError:
          detailResult.reason instanceof Error
            ? detailResult.reason.message
            : String(detailResult.reason),
      })
    }
    this.update({ taskLoading: false })

    if (effortResult.status === "fulfilled") {
      const response = effortResult.value
      const report =
        typeof response.report === "object" && response.report !== null
          ? (response.report as Record<string, unknown>)
          : undefined
      const taskReport =
        typeof report?.task === "object" && report.task !== null
          ? (report.task as Record<string, unknown>)
          : undefined
      if (
        response.projectID !== this.projectID ||
        response.scope.kind !== "project" ||
        taskReport?.id !== taskID
      ) {
        this.update({
          effortBasis: undefined,
          effortError: "Task effort belongs to another project or scope.",
        })
      } else {
        const basis = readTaskEffortBasis(response.report)
        this.update({
          effortBasis: basis,
          effortError: basis
            ? ""
            : "Categorized task effort is unavailable in this trajectory response.",
        })
      }
    } else {
      this.update({
        effortBasis: undefined,
        effortError:
          effortResult.reason instanceof Error
            ? effortResult.reason.message
            : String(effortResult.reason),
      })
    }
    this.update({ effortLoading: false })
  }

  private async loadSettings(generation: number, taskID?: string) {
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    const request = ++this.settingsRequest
    const signal = this.controller.signal
    try {
      const settings = await transport.settings(taskID, signal)
      if (generation !== this.generation || request !== this.settingsRequest || signal.aborted)
        return
      if (
        settings.projectDirectory !== this.projectDirectory ||
        settings.taskID !== (taskID ?? null)
      )
        throw new Error("Saved model settings belong to another project or task")
      this.update({ settings, settingsLoading: false, settingsError: "" })
    } catch (error) {
      if (generation === this.generation && request === this.settingsRequest && !signal.aborted)
        this.update({
          settingsLoading: false,
          settingsError: error instanceof Error ? error.message : String(error),
        })
    }
  }

  close() {
    this.generation++
    this.comparisonRequest++
    this.taskRequest++
    this.settingsRequest++
    this.controller.abort()
    this.taskController.abort()
    this.transport = undefined
    this.projectID = ""
    this.projectDirectory = ""
    this.sourceRefreshPromise = undefined
    this.comparisonPromise = undefined
    this.comparisonNeedsRefresh = false
  }
}
