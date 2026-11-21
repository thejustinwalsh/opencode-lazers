import { sameProject } from "../project-key.ts"
import { panelErrorMessage as errorMessage } from "../panel-error.ts"
import type { TaskDetail, TaskPage } from "../tasks/contract.ts"
import { readTaskEffortBasis } from "./comparison-presentation.ts"
import type { ModelEvidenceOutput } from "./source-schema.ts"
import { ModelMappingWriteOutputSchema } from "./contract.ts"
import type { ModelSettingsOutput } from "./contract.ts"
import type {
  ModelMappingRecord,
  ModelMappingTargetInput,
  ModelMappingUpdate,
} from "./mapping-schema.ts"
import type { ModelPolicy } from "../runner/schema.ts"
import type { ModelMappingSubject as WorkerPersona } from "./agent-ids.ts"
import type { ModelDecisionContext, ModelDecisionFilters } from "./decision-contract.ts"

export type ModelDecisionStatus =
  | "loading"
  | "ready"
  | "partial"
  | "stale"
  | "unknown"
  | "backend-not-ready"
  | "missing-rpc"
  | "error"

type ModelMappingWriteOutput = (typeof ModelMappingWriteOutputSchema)["_output"]

export type ModelAssignmentWrite = {
  status: "saving" | "verifying" | "uncertain" | "conflict" | "confirmed" | "failed"
  persona: WorkerPersona
  target: ModelMappingTargetInput | null
  route: ModelPolicy | null
  expectedRevision: number
  revision: number | null
  message: string
}

/** One task's effort read: the part of the trajectory a comparison uses (`trajectory.effort`). */
export type TrajectoryResponse = {
  projectID: string
  scope: { kind: string }
  report: Record<string, unknown>
}

/**
 * What the state asks of the service beyond its streams: the source refresh (a write), the
 * assignments' authoritative readback (one `models.assignments` window), mapping writes and the
 * selected task's detail. The decision data, catalog and candidates are streams in the
 * controller.
 */
export type ModelComparisonTransport = {
  /** `force` is the refresh button: fetch every source now. Otherwise only stale ones, in the background. */
  refreshSources(signal: AbortSignal, force?: boolean): Promise<ModelEvidenceOutput>
  settings(taskID: string | undefined, signal: AbortSignal): Promise<ModelSettingsOutput>
  configure(update: ModelMappingUpdate, signal: AbortSignal): Promise<ModelMappingWriteOutput>
  queryTasks(signal: AbortSignal): Promise<Pick<TaskPage, "projectDirectory" | "tasks">>
  getTask(taskID: string, signal: AbortSignal): Promise<TaskDetail>
  trajectoryStatus(taskID: string, signal: AbortSignal): Promise<TrajectoryResponse>
  online(): boolean
}

type PendingSelectedTaskLoad = {
  generation: number
  projectID: string
  projectDirectory: string
  transport: ModelComparisonTransport
  taskID: string
  selectionRevision: number
  signal: AbortSignal
  settled: boolean
  promise: Promise<void>
}

type PendingAssignmentWrite = {
  request: number
  generation: number
  selectionRevision: number
  taskID: string | null
  projectDirectory: string
  transport: ModelComparisonTransport
  target: ModelMappingTargetInput
  persona: WorkerPersona
  route: ModelPolicy | null
  expectedRevision: number
  targetRevision: number
  outcome: "updated" | "uncertain" | "conflict"
  signal: AbortSignal
}

export type ModelTask = Extract<TaskDetail, { status: "found" }> | undefined

export type ModelComparisonPanelData = {
  key: string
  projectID: string
  projectDirectory: string
  /** The selected entry of Projected or Benchmark: a candidate or a public-catalog model id. */
  selectedCandidateID: string | null
  tasks: TaskPage["tasks"]
  selectedTaskID: string | null
  decisionFilters: ModelDecisionFilters
  selectedConfigurationID: string | null
  task?: ModelTask
  effortBasis?: ReturnType<typeof readTaskEffortBasis>
  settings?: ModelSettingsOutput
  assignmentWrite?: ModelAssignmentWrite
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
  selectedConfigurationID?: string | null
}

export const emptyModelDecisionFilters: ModelDecisionFilters = {
  persona: null,
  taskKind: null,
  period: { from: null, to: null },
}

/** The decision status the panel shows for a stored view's context. */
export function decisionStatus(
  context: ModelDecisionContext,
  online: boolean,
): ModelDecisionStatus {
  if (context.availability === "backend-not-ready") return "backend-not-ready"
  if (!online || context.freshness === "stale") return "stale"
  if (context.freshness === "unknown") return "unknown"
  if (context.availability === "partial") return "partial"
  return "ready"
}

function routesMatch(left: ModelPolicy | null, right: ModelPolicy | null) {
  return left === null
    ? right === null
    : right !== null &&
        left.providerID === right.providerID &&
        left.id === right.id &&
        (left.variant ?? null) === (right.variant ?? null)
}

function mappingTargetMatches(
  record: ModelMappingRecord,
  target: ModelMappingTargetInput,
  projectDirectory: string,
) {
  switch (target.scope) {
    case "shared":
      return record.target.scope === "shared"
    case "project":
      return (
        record.target.scope === "project" && record.target.projectDirectory === projectDirectory
      )
    case "task":
      return (
        record.target.scope === "task" &&
        record.target.projectDirectory === projectDirectory &&
        record.target.taskID === target.taskID
      )
  }
}

function blank(
  key = "",
  projectID = "",
  projectDirectory = "",
  preferences: ModelComparisonPreferences = {
    selectedTaskID: null,
    selectedCandidateID: null,
  },
  decisionFilters: ModelDecisionFilters = emptyModelDecisionFilters,
): ModelComparisonPanelData {
  return {
    key,
    projectID,
    projectDirectory,
    selectedCandidateID: preferences.selectedCandidateID,
    tasks: [],
    selectedTaskID: preferences.selectedTaskID,
    decisionFilters,
    selectedConfigurationID: preferences.selectedConfigurationID ?? null,
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

/**
 * The Models panel's selections, task detail, source refresh and assignment writes. What the panel
 * shows of the comparison (views, catalog, chart, contributors, assignments) is read by streams in
 * the controller; the assignments stream hands its settings here (`applySettings`).
 */
export class ModelComparisonPanelState {
  data = blank()
  private controller = new AbortController()
  private taskController = new AbortController()
  private generation = 0
  private taskRequest = 0
  private selectedTaskLoad?: PendingSelectedTaskLoad
  private settingsRequest = 0
  private selectionRevision = 0
  private assignmentRequest = 0
  private assignmentController = new AbortController()
  private assignmentOperation?: PendingAssignmentWrite
  private transport?: ModelComparisonTransport
  private projectID = ""
  private projectDirectory = ""
  private sourceRefreshPromise?: Promise<void>
  private taskListPromise?: Promise<void>
  private refreshPromise?: Promise<void>

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
    decisionFilters: ModelDecisionFilters = emptyModelDecisionFilters,
  ) {
    this.close()
    this.controller = new AbortController()
    this.taskController = new AbortController()
    this.transport = transport
    this.projectID = projectID
    this.projectDirectory = projectDirectory
    this.data = blank(key, projectID, projectDirectory, preferences, decisionFilters)
    const generation = this.generation
    void this.loadTasks(generation, preferences.selectedTaskID ?? undefined)
    void this.refreshSources(generation)
  }

  async refresh() {
    if (!this.transport || this.controller.signal.aborted) return
    if (this.refreshPromise) return this.refreshPromise

    const generation = this.generation
    const selectedTaskID = this.data.selectedTaskID
    const selectionRevision = this.selectionRevision
    const operation = Promise.all([
      this.loadTasks(generation, selectedTaskID ?? undefined),
      this.refreshSources(generation, true),
      selectedTaskID
        ? this.loadSelectedTask(generation, selectedTaskID, selectionRevision)
        : Promise.resolve(),
      this.loadSettings(generation, selectedTaskID ?? undefined, selectionRevision),
    ]).then(() => undefined)
    this.refreshPromise = operation
    await operation
    if (generation === this.generation && this.refreshPromise === operation)
      this.refreshPromise = undefined
  }

  /**
   * Ask the service to refresh the price and benchmark sources. The stored view follows the new
   * snapshots by itself; this only reports the request's own outcome.
   */
  async refreshSources(generation = this.generation, force = false): Promise<void> {
    if (this.sourceRefreshPromise) return this.sourceRefreshPromise
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    const signal = this.controller.signal
    this.update({ sourceRefresh: "refreshing", sourceRefreshError: "" })
    const operation = (async () => {
      try {
        // The server answers from its stored snapshots at once and refreshes only what is past
        // its TTL in the background; a forced refresh waits for the fetch.
        await transport.refreshSources(signal, force)
        if (generation !== this.generation || signal.aborted) return
        this.update({ sourceRefresh: "succeeded", sourceRefreshError: "" })
      } catch (error) {
        if (generation === this.generation && !signal.aborted)
          this.update({
            sourceRefresh: "failed",
            sourceRefreshError: errorMessage(error),
            stale: true,
          })
      } finally {
        if (generation === this.generation) this.sourceRefreshPromise = undefined
      }
    })()
    this.sourceRefreshPromise = operation
    return operation
  }

  setDecisionFilters(filters: ModelDecisionFilters) {
    if (JSON.stringify(filters) === JSON.stringify(this.data.decisionFilters)) return
    this.update({ decisionFilters: filters })
  }

  selectConfiguration(configurationID: string) {
    if (!configurationID || configurationID === this.data.selectedConfigurationID) return
    this.update({ selectedConfigurationID: configurationID })
    this.selectionChanged({
      selectedTaskID: this.data.selectedTaskID,
      selectedCandidateID: this.data.selectedCandidateID,
      selectedConfigurationID: configurationID,
    })
  }

  /** Select a Projected or Benchmark entry: a candidate or a public-catalog model. */
  selectCandidate(candidateID: string) {
    if (candidateID === this.data.selectedCandidateID) return
    this.update({ selectedCandidateID: candidateID })
    this.selectionChanged({
      selectedTaskID: this.data.selectedTaskID,
      selectedCandidateID: candidateID,
      selectedConfigurationID: this.data.selectedConfigurationID,
    })
  }

  selectTask(taskID: string | null) {
    if (taskID === this.data.selectedTaskID) return
    if (taskID && !this.data.tasks.some((task) => task.taskID === taskID)) return
    const selectionRevision = ++this.selectionRevision
    this.taskController.abort()
    this.taskController = new AbortController()
    this.invalidateAssignmentWrite()
    this.selectedTaskLoad = undefined
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
      assignmentWrite: undefined,
      settingsLoading: true,
      settingsError: "",
    })
    this.selectionChanged({
      selectedTaskID: taskID,
      selectedCandidateID: this.data.selectedCandidateID,
      selectedConfigurationID: this.data.selectedConfigurationID,
    })
    const generation = this.generation
    if (taskID) void this.loadSelectedTask(generation, taskID, selectionRevision)
  }

  private async loadTasks(generation: number, preferredTaskID?: string) {
    if (this.taskListPromise) return this.taskListPromise
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    const signal = this.controller.signal
    const selectionRevision = this.selectionRevision
    this.update({ tasksLoading: true, tasksError: "" })
    const operation = (async () => {
      try {
        const page = await transport.queryTasks(signal)
        if (generation !== this.generation || signal.aborted) return
        if (page.projectDirectory !== this.projectDirectory)
          throw new Error("Task list belongs to another project")
        this.update({ tasks: page.tasks, tasksLoading: false, tasksError: "" })
        const current =
          selectionRevision === this.selectionRevision
            ? (preferredTaskID ?? this.data.selectedTaskID)
            : this.data.selectedTaskID
        const selected = current ?? page.tasks[0]?.taskID ?? null
        if (selected !== this.data.selectedTaskID) this.selectTask(selected)
        else if (selected && !this.data.task && !this.taskController.signal.aborted) {
          await this.loadSelectedTask(generation, selected, this.selectionRevision)
        } else if (!selected && this.data.selectedTaskID !== null) this.selectTask(null)
      } catch (error) {
        if (generation === this.generation && !signal.aborted)
          this.update({
            tasksLoading: false,
            tasksError: errorMessage(error),
            stale: true,
          })
      }
    })()
    this.taskListPromise = operation
    await operation
    if (generation === this.generation && this.taskListPromise === operation)
      this.taskListPromise = undefined
  }

  private loadSelectedTask(
    generation: number,
    taskID: string,
    selectionRevision = this.selectionRevision,
  ): Promise<void> {
    const transport = this.transport
    if (
      !transport ||
      this.controller.signal.aborted ||
      generation !== this.generation ||
      selectionRevision !== this.selectionRevision ||
      this.data.selectedTaskID !== taskID
    )
      return Promise.resolve()

    const pending = this.selectedTaskLoad
    if (
      pending &&
      !pending.settled &&
      !pending.signal.aborted &&
      pending.generation === generation &&
      pending.projectID === this.projectID &&
      pending.projectDirectory === this.projectDirectory &&
      pending.transport === transport &&
      pending.taskID === taskID &&
      pending.selectionRevision === selectionRevision
    )
      return pending.promise

    this.taskController.abort()
    this.taskController = new AbortController()
    const taskRequest = ++this.taskRequest
    const signal = AbortSignal.any([this.controller.signal, this.taskController.signal])
    const load: PendingSelectedTaskLoad = {
      generation,
      projectID: this.projectID,
      projectDirectory: this.projectDirectory,
      transport,
      taskID,
      selectionRevision,
      signal,
      settled: false,
      promise: Promise.resolve(),
    }
    const operation = Promise.resolve()
      .then(() => this.readSelectedTask(generation, taskID, taskRequest, load))
      .finally(() => {
        load.settled = true
        if (this.selectedTaskLoad === load) this.selectedTaskLoad = undefined
      })
    load.promise = operation
    this.selectedTaskLoad = load
    return operation
  }

  private async readSelectedTask(
    generation: number,
    taskID: string,
    taskRequest: number,
    load: PendingSelectedTaskLoad,
  ) {
    const { transport, signal, selectionRevision } = load
    const isCurrent = () =>
      generation === this.generation &&
      taskRequest === this.taskRequest &&
      selectionRevision === this.selectionRevision &&
      !signal.aborted &&
      this.data.selectedTaskID === taskID
    if (!isCurrent()) return
    this.update({ taskLoading: true, taskError: "", effortLoading: true, effortError: "" })
    if (!isCurrent()) return
    const detailRead = Promise.resolve().then(() => transport.getTask(taskID, signal))
    const effortRead = Promise.resolve().then(() => transport.trajectoryStatus(taskID, signal))
    const [detailResult, effortResult] = await Promise.allSettled([detailRead, effortRead])
    load.settled = true
    if (this.selectedTaskLoad === load) this.selectedTaskLoad = undefined
    if (!isCurrent()) return

    if (detailResult.status === "fulfilled") {
      const detail = detailResult.value
      if (detail.status === "found") {
        if (
          detail.task.id !== taskID ||
          !sameProject(detail.task.provenance.projectID, this.projectID)
        )
          this.update({ taskError: "Task detail belongs to another project or task." })
        else this.update({ task: detail, taskError: "" })
      } else {
        this.update({ task: undefined, taskError: "The selected task is no longer available." })
        if (!this.data.tasks.some((task) => task.taskID === taskID)) {
          this.selectTask(this.data.tasks[0]?.taskID ?? null)
          return
        }
      }
    } else {
      this.update({
        taskError: errorMessage(detailResult.reason),
      })
    }
    if (!isCurrent()) return
    this.update({ taskLoading: false })

    if (!isCurrent()) return
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
        effortError: errorMessage(effortResult.reason),
      })
    }
    if (!isCurrent()) return
    this.update({ effortLoading: false })
  }

  private async loadSettings(
    generation: number,
    taskID?: string,
    selectionRevision = this.selectionRevision,
  ): Promise<ModelSettingsOutput | undefined> {
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return undefined
    const request = ++this.settingsRequest
    const signal = this.controller.signal
    this.update({ settingsLoading: true, settingsError: "" })
    try {
      const settings = await transport.settings(taskID, signal)
      if (
        generation !== this.generation ||
        request !== this.settingsRequest ||
        selectionRevision !== this.selectionRevision ||
        taskID !== (this.data.selectedTaskID ?? undefined) ||
        signal.aborted
      )
        return undefined
      if (
        settings.projectDirectory !== this.projectDirectory ||
        settings.taskID !== (taskID ?? null)
      )
        throw new Error("Saved model settings belong to another project or task")
      this.update({ settings, settingsLoading: false, settingsError: "" })
      return settings
    } catch (error) {
      if (
        generation === this.generation &&
        request === this.settingsRequest &&
        selectionRevision === this.selectionRevision &&
        taskID === (this.data.selectedTaskID ?? undefined) &&
        !signal.aborted
      )
        this.update({
          settingsLoading: false,
          settingsError: errorMessage(error),
        })
      return undefined
    }
  }

  /**
   * The assignments stream's settings for the selected task. A read for another task (the stream
   * reopens after a selection) is ignored.
   */
  applySettings(settings: ModelSettingsOutput) {
    if (
      settings.projectDirectory !== this.projectDirectory ||
      settings.taskID !== this.data.selectedTaskID
    )
      return
    this.update({ settings, settingsLoading: false, settingsError: "" })
  }

  /** The assignments stream failed: the error is shown until its next frame. */
  settingsFailed(error: string) {
    this.update({ settingsLoading: false, settingsError: error })
  }

  async refreshSettings() {
    if (this.data.assignmentWrite?.status === "uncertain") {
      await this.recheckAssignmentWrite()
      return this.data.settings
    }
    const settings = await this.loadSettings(
      this.generation,
      this.data.selectedTaskID ?? undefined,
      this.selectionRevision,
    )
    if (
      settings &&
      (this.data.assignmentWrite?.status === "conflict" ||
        this.data.assignmentWrite?.status === "failed")
    ) {
      this.assignmentOperation = undefined
      this.update({ assignmentWrite: undefined })
    }
    return settings
  }

  clearConfirmedAssignmentWrite() {
    if (this.data.assignmentWrite?.status !== "confirmed") return
    this.assignmentOperation = undefined
    this.update({ assignmentWrite: undefined })
  }

  async configureMapping(
    persona: WorkerPersona,
    scope: ModelMappingTargetInput["scope"],
    route: ModelPolicy | null,
  ) {
    const taskID = this.data.selectedTaskID
    const target: ModelMappingTargetInput | null =
      scope === "task" ? (taskID ? { scope, taskID } : null) : { scope }
    if (!target) {
      this.update({
        assignmentWrite: {
          status: "failed",
          persona,
          target: null,
          route,
          expectedRevision: 0,
          revision: null,
          message: "Choose an existing task before editing a task override.",
        },
      })
      return
    }

    const settings = this.data.settings
    const personaSettings = settings?.personas.find((entry) => entry.persona === persona)
    const current = personaSettings?.layers[scope] ?? null
    const expectedRevision = current?.revision ?? 0
    const base = {
      persona,
      target,
      route,
      expectedRevision,
      revision: null,
    }
    const currentWrite = this.data.assignmentWrite
    if (currentWrite?.status === "saving" || currentWrite?.status === "verifying") return
    if (currentWrite?.status === "uncertain") {
      this.update({
        assignmentWrite: {
          ...currentWrite,
          message: "Check the uncertain write before submitting another mapping.",
        },
      })
      return
    }
    if (
      !settings ||
      this.data.settingsLoading ||
      this.data.settingsError ||
      settings.projectDirectory !== this.projectDirectory ||
      settings.taskID !== taskID
    ) {
      this.update({
        assignmentWrite: {
          ...base,
          status: "failed",
          message: "Saved mappings are not ready. Reload current settings before saving.",
        },
      })
      return
    }

    const transport = this.transport
    if (!transport || this.controller.signal.aborted || !transport.online()) {
      this.update({
        assignmentWrite: {
          ...base,
          status: "failed",
          message:
            "No write was sent because the project connection is offline. Reconnect and retry.",
        },
      })
      return
    }

    this.assignmentController.abort()
    this.assignmentController = new AbortController()
    const generation = this.generation
    const selectionRevision = this.selectionRevision
    const request = ++this.assignmentRequest
    const signal = AbortSignal.any([this.controller.signal, this.assignmentController.signal])
    const operation: PendingAssignmentWrite = {
      request,
      generation,
      selectionRevision,
      taskID,
      projectDirectory: this.projectDirectory,
      transport,
      target,
      persona,
      route,
      expectedRevision,
      targetRevision: expectedRevision + 1,
      outcome: "uncertain",
      signal,
    }
    this.assignmentOperation = operation
    this.update({
      assignmentWrite: {
        ...base,
        status: "saving",
        message: "Saving the exact route…",
      },
    })

    try {
      const result = await transport.configure({ target, persona, expectedRevision, route }, signal)
      if (!this.isCurrentAssignment(operation)) return
      if (result.status === "conflict") {
        operation.outcome = "conflict"
        operation.targetRevision = result.currentRevision
        this.update({
          assignmentWrite: {
            ...base,
            status: "conflict",
            revision: result.currentRevision || null,
            message: `This mapping changed in another editor (expected revision ${expectedRevision}, current revision ${result.currentRevision}). No stale write was applied. Reload, review, then save again.`,
          },
        })
        await this.reconcileAssignment(operation)
        return
      }

      operation.outcome = "updated"
      operation.targetRevision = result.mapping.revision
      if (
        result.mapping.persona !== persona ||
        !mappingTargetMatches(result.mapping, target, this.projectDirectory) ||
        !routesMatch(result.mapping.route, route)
      ) {
        operation.outcome = "uncertain"
        operation.targetRevision = expectedRevision + 1
        this.update({
          assignmentWrite: {
            ...base,
            status: "uncertain",
            revision: operation.targetRevision,
            message:
              "The write response did not match this editor. Checking authoritative settings before showing it as saved.",
          },
        })
        await this.reconcileAssignment(operation)
        return
      }

      this.update({
        assignmentWrite: {
          ...base,
          status: "verifying",
          revision: result.mapping.revision,
          message: "Write accepted; confirming the saved route with an authoritative readback…",
        },
      })
      await this.reconcileAssignment(operation)
    } catch (error) {
      if (!this.isCurrentAssignment(operation)) return
      operation.outcome = "uncertain"
      operation.targetRevision = expectedRevision + 1
      this.update({
        assignmentWrite: {
          ...base,
          status: "uncertain",
          revision: operation.targetRevision,
          message: `The write outcome is uncertain (${errorMessage(error)}). Check authoritative settings before trying again.`,
        },
      })
      await this.reconcileAssignment(operation)
    }
  }

  async recheckAssignmentWrite() {
    const operation = this.assignmentOperation
    if (
      !operation ||
      this.data.assignmentWrite?.status !== "uncertain" ||
      !this.isCurrentAssignment(operation)
    )
      return
    this.update({
      assignmentWrite: {
        ...this.data.assignmentWrite,
        status: "verifying",
        message: "Checking the exact target against authoritative settings…",
      },
    })
    await this.reconcileAssignment(operation)
  }

  private isCurrentAssignment(operation: PendingAssignmentWrite) {
    return (
      this.assignmentOperation === operation &&
      operation.request === this.assignmentRequest &&
      operation.generation === this.generation &&
      operation.selectionRevision === this.selectionRevision &&
      operation.taskID === this.data.selectedTaskID &&
      operation.projectDirectory === this.projectDirectory &&
      operation.transport === this.transport &&
      !operation.signal.aborted
    )
  }

  private async reconcileAssignment(operation: PendingAssignmentWrite) {
    if (!this.isCurrentAssignment(operation)) return
    const readback = await this.loadSettings(
      operation.generation,
      operation.taskID ?? undefined,
      operation.selectionRevision,
    )
    if (!this.isCurrentAssignment(operation)) return

    const base = {
      persona: operation.persona,
      target: operation.target,
      route: operation.route,
      expectedRevision: operation.expectedRevision,
    }
    if (!readback) {
      if (operation.outcome === "conflict") {
        this.update({
          assignmentWrite: {
            ...base,
            status: "conflict",
            revision: operation.targetRevision || null,
            message: `The stale write was rejected. Current settings could not be reloaded: ${this.data.settingsError || "readback unavailable"}. Reload before trying again.`,
          },
        })
      } else {
        this.update({
          assignmentWrite: {
            ...base,
            status: "uncertain",
            revision: operation.targetRevision,
            message: `The write is still unconfirmed because authoritative settings could not be read: ${this.data.settingsError || "readback unavailable"}. Recheck before submitting another mapping.`,
          },
        })
      }
      return
    }

    const current =
      readback.personas.find((entry) => entry.persona === operation.persona)?.layers[
        operation.target.scope
      ] ?? null
    if (
      operation.outcome !== "conflict" &&
      current?.revision === operation.targetRevision &&
      mappingTargetMatches(current, operation.target, operation.projectDirectory) &&
      routesMatch(current.route, operation.route)
    ) {
      this.update({
        assignmentWrite: {
          ...base,
          status: "confirmed",
          revision: operation.targetRevision,
          message: `Saved and confirmed by authoritative settings at revision ${operation.targetRevision}.`,
        },
      })
      return
    }

    if (operation.outcome === "conflict") {
      const revision = current?.revision ?? 0
      this.update({
        assignmentWrite: {
          ...base,
          status: "conflict",
          revision: revision || null,
          message: `No stale write was applied. Current authoritative revision is ${revision}; review it before saving again.`,
        },
      })
      return
    }

    if (current && current.revision > operation.targetRevision) {
      this.update({
        assignmentWrite: {
          ...base,
          status: "conflict",
          revision: current.revision,
          message: `A newer authoritative revision ${current.revision} is current. The requested route is not shown as saved; review the current mapping before continuing.`,
        },
      })
      return
    }

    const observed = current ? `revision ${current.revision}` : "no mapping record"
    this.update({
      assignmentWrite: {
        ...base,
        status: "uncertain",
        revision: operation.targetRevision,
        message: `The write remains unconfirmed: authoritative readback shows ${observed}, not the requested route at revision ${operation.targetRevision}. Recheck before submitting another mapping.`,
      },
    })
  }

  private invalidateAssignmentWrite() {
    this.assignmentRequest++
    this.assignmentController.abort()
    this.assignmentController = new AbortController()
    this.assignmentOperation = undefined
  }

  close() {
    this.generation++
    this.taskRequest++
    this.selectedTaskLoad = undefined
    this.settingsRequest++
    this.selectionRevision++
    this.invalidateAssignmentWrite()
    this.controller.abort()
    this.taskController.abort()
    this.transport = undefined
    this.projectID = ""
    this.projectDirectory = ""
    this.sourceRefreshPromise = undefined
    this.taskListPromise = undefined
    this.refreshPromise = undefined
  }
}
